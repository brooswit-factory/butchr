import { describe, expect, test } from "bun:test";
import { agentStartParams, spawnArgs, checkArgv, providerOrder } from "../../src/agents/argv.js";
import { buildAgentStartParams } from "@brooswit/drovr";

const spec = { key: "KAN-783", issuetype: "Task", summary: "s", parent: null };

describe("spawnArgs", () => {
  test("AGY uses Drovr's interactive launch with explicit AGENTS.md kickoff", () => {
    const launch = agentStartParams(spec, "/w/KAN-783", "pane", "worker", { provider: "agy", model: "test-model" });
    expect(launch).toEqual(buildAgentStartParams({
      provider: "agy", cwd: "/w/KAN-783", paneId: "pane", name: "worker",
      prompt: "follow your AGENTS.md", model: "test-model", skipPermissions: true,
    }));
    expect(launch.args).toEqual(["--prompt-interactive", "follow your AGENTS.md", "--model", "test-model", "--dangerously-skip-permissions"]);
    expect(spawnArgs(spec, "/w/KAN-783", { provider: "agy" })).toEqual(["--prompt-interactive", "follow your AGENTS.md", "--dangerously-skip-permissions"]);
    expect(providerOrder({ provider: "agy", providers: ["claude", "agy"], roleProviders: { task: ["agy", "codex"] } }, "Task")).toEqual(["agy", "codex"]);
  });
  test("builds the full flag set, kickoff positional first", () => {
    const args = spawnArgs(spec, "/w/KAN-783");
    expect(args[0]).toBe("follow your CLAUDE.md");
    expect(args).toEqual([
      "follow your CLAUDE.md",
      "--model", "sonnet",
      "--effort", "high",
      "--permission-mode", "bypassPermissions",
      "--mcp-config", "/w/KAN-783/mcp.json",
      // drovr >= 0.10 joins each channel onto its flag with "=": a separate
      // "server:x" value could be swallowed as a user turn.
      "--dangerously-load-development-channels=server:butchr",
    ]);
  });

  test("--effort sits adjacent to --model, before the variadic flags", () => {
    const args = spawnArgs(spec, "/w/KAN-783");
    const modelIdx = args.indexOf("--model");
    expect(args[modelIdx + 2]).toBe("--effort");
    expect(args[modelIdx + 3]).toBe("high");
    expect(args.indexOf("--mcp-config")).toBeGreaterThan(modelIdx + 3);
    expect(args.indexOf("--dangerously-load-development-channels=server:butchr")).toBeGreaterThan(modelIdx + 3);
  });
});

describe("checkArgv", () => {
  test("the full expected argv, observed verbatim -> ok", () => {
    const expected = spawnArgs(spec, "/w/KAN-783");
    expect(checkArgv(expected, expected)).toEqual({ ok: true });
  });

  test("a bare `claude --resume <id>` -> stale, reason names all three required flags", () => {
    const expected = spawnArgs(spec, "/w/KAN-783");
    const observed = ["claude", "--resume", "8e5164dc-c5d6-41b7-aa41-4a6143b818a5"];
    const check = checkArgv(expected, observed);
    expect(check.ok).toBe(false);
    if (!check.ok) {
      expect(check.reason).toContain("--permission-mode bypassPermissions");
      expect(check.reason).toContain("--mcp-config /w/KAN-783/mcp.json");
      expect(check.reason).toContain("--dangerously-load-development-channels server:butchr");
    }
  });

  test("argv differing only in --model (and the kickoff positional) -> ok", () => {
    const expected = spawnArgs(spec, "/w/KAN-783");
    const observed = spawnArgs({ ...spec, issuetype: "Epic" }, "/w/KAN-783");
    observed[0] = "some other kickoff text";
    expect(checkArgv(expected, observed)).toEqual({ ok: true });
  });

  test("a changed effort default does not read a running agent's argv as stale", () => {
    const expected = spawnArgs(spec, "/w/KAN-783");
    const observed = spawnArgs(spec, "/w/KAN-783");
    const effortIdx = observed.indexOf("--effort");
    observed[effortIdx + 1] = "medium"; // simulates effortFor()'s default changing after this agent was spawned
    expect(checkArgv(expected, observed)).toEqual({ ok: true });
  });

  // The fleet as it exists on deploy day: every agent currently running was
  // spawned before --effort existed, so its argv carries the flag not at all
  // (not merely a different value). That must not read as stale either, or
  // the first deploy of this feature respawns every running agent at once.
  test("an agent spawned before --effort existed does not read as stale", () => {
    const expected = spawnArgs(spec, "/w/KAN-783");
    const withEffort = spawnArgs(spec, "/w/KAN-783");
    const i = withEffort.indexOf("--effort");
    const observed = [...withEffort.slice(0, i), ...withEffort.slice(i + 2)]; // the pre-feature argv
    expect(observed).not.toContain("--effort");
    expect(checkArgv(expected, observed)).toEqual({ ok: true });
  });

  test("a wrong --mcp-config path -> stale", () => {
    const expected = spawnArgs(spec, "/w/KAN-783");
    const observed = spawnArgs(spec, "/w/SOMEWHERE-ELSE");
    const check = checkArgv(expected, observed);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toBe("argv lacks --mcp-config /w/KAN-783/mcp.json");
  });
});

// BUTCHR-411: a rule binds any MCP channel server; `server:butchr` remains
// bound exactly as today, and a bound server's own `channel` flag decides
// whether it also joins the (variadic) channel flag.
describe("spawnArgs — MCP server bindings (BUTCHR-411)", () => {
  const mud = { name: "mud", type: "http" as const, url: "https://mud.example/mcp", channel: true };

  test("a rule with no mcpServers produces byte-identical argv to before — the deploy-day no-op case", () => {
    expect(spawnArgs(spec, "/w/KAN-783")).toEqual(spawnArgs({ ...spec, mcpServers: [] }, "/w/KAN-783"));
  });

  test("a bound channel server appends its own --dangerously-load-development-channels flag, kickoff still first", () => {
    const args = spawnArgs({ ...spec, mcpServers: [mud] }, "/w/KAN-783");
    expect(args[0]).toBe("follow your CLAUDE.md");
    expect(args).toContain("--dangerously-load-development-channels=server:butchr");
    expect(args).toContain("--dangerously-load-development-channels=server:mud");
    // server:butchr's own flag precedes the bound one — order follows spec.mcpServers, butchr always first.
    expect(args.indexOf("--dangerously-load-development-channels=server:butchr")).toBeLessThan(args.indexOf("--dangerously-load-development-channels=server:mud"));
  });

  test("two channel servers both appear", () => {
    const second = { name: "second", type: "http" as const, url: "https://second.example/mcp", channel: true };
    const args = spawnArgs({ ...spec, mcpServers: [mud, second] }, "/w/KAN-783");
    for (const flag of ["--dangerously-load-development-channels=server:butchr", "--dangerously-load-development-channels=server:mud", "--dangerously-load-development-channels=server:second"]) expect(args).toContain(flag);
  });

  test("channel: false reaches mcp.json (see workspace.test.ts) but never the channel flag", () => {
    const args = spawnArgs({ ...spec, mcpServers: [{ ...mud, channel: false }] }, "/w/KAN-783");
    expect(args).toContain("--dangerously-load-development-channels=server:butchr");
    expect(args).not.toContain("--dangerously-load-development-channels=server:mud");
    expect(args.filter((a) => a.startsWith("--dangerously-load-development-channels"))).toHaveLength(1);
  });

  test("a Claude rule bound to a second channel server produces argv the pre-BUTCHR-411 checkArgv still accepts as itself, and a running agent launched WITHOUT the binding reads as stale against it", () => {
    const withBinding = spawnArgs({ ...spec, mcpServers: [mud] }, "/w/KAN-783");
    const withoutBinding = spawnArgs(spec, "/w/KAN-783");
    expect(checkArgv(withBinding, withBinding)).toEqual({ ok: true });
    const check = checkArgv(withBinding, withoutBinding);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toContain("--dangerously-load-development-channels server:mud");
  });

  test("codex gets every bound server as an MCP tool server, butchr first — never a channel flag (BUTCHR-359 is out of scope here)", () => {
    const withHeaders = { ...mud, headersEnvVar: "MUD_MCP_HEADERS" };
    const args = spawnArgs({ ...spec, mcpServers: [withHeaders] }, "/w/KAN-783", { provider: "codex", disabledMcpServers: [] });
    expect(args.filter((a) => a.startsWith("--dangerously-load-development-channels"))).toHaveLength(0);
    const butchrIdx = args.findIndex((a) => a.includes("mcp_servers.butchr="));
    const mudIdx = args.findIndex((a) => a.includes("mcp_servers.mud="));
    expect(butchrIdx).toBeGreaterThanOrEqual(0);
    expect(mudIdx).toBeGreaterThan(butchrIdx);
    expect(args[mudIdx]).toContain('url = "https://mud.example/mcp"');
    expect(args[mudIdx]).not.toContain("http_headers");
  });

  // Review finding, PR #387 (BLOCKING): a bound server's resolved header
  // VALUE (often a bearer token) must never reach Codex argv — a real
  // process command line other local users can read via ps/procfs — and
  // must therefore never reach anything downstream that echoes argv
  // verbatim (staleIssues()'s observedArgv, the respawn journal line).
  test("a bound server's headersEnvVar is NEVER resolved for Codex, even when the env var holds a real secret — argv contains no trace of it", () => {
    process.env.BUTCHR_TEST_MUD_HEADERS = JSON.stringify({ Authorization: "Bearer SEKRET-TOKEN-VALUE" });
    try {
      const args = spawnArgs({ ...spec, mcpServers: [{ ...mud, headersEnvVar: "BUTCHR_TEST_MUD_HEADERS" }] }, "/w/KAN-783", { provider: "codex", disabledMcpServers: [] });
      const mudArg = args.find((a) => a.includes("mcp_servers.mud="));
      expect(mudArg).toBeDefined();
      expect(mudArg).not.toContain("SEKRET-TOKEN-VALUE");
      expect(mudArg).not.toContain("http_headers");
      expect(mudArg).not.toContain("Authorization");
      for (const a of args) expect(a).not.toContain("SEKRET-TOKEN-VALUE");
    } finally { delete process.env.BUTCHR_TEST_MUD_HEADERS; }
  });

  test("agy's launch is unaffected by mcpServers — bindings must not break it", () => {
    const launch = agentStartParams({ ...spec, mcpServers: [mud] }, "/w/KAN-783", "pane", "worker", { provider: "agy" });
    expect(launch).toEqual(agentStartParams(spec, "/w/KAN-783", "pane", "worker", { provider: "agy" }));
  });
});
