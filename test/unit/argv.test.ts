import { describe, expect, test } from "bun:test";
import { agentLaunchConfig, agentStartParams, spawnArgs, checkArgv, providerOrder } from "../../src/agents/argv.js";
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

  test("BUTCHR-453/BUTCHR-463: spec.strictMcpConfig produces --strict-mcp-config in a Claude launch's argv; absent produces no such flag", () => {
    const withFlag = spawnArgs({ ...spec, strictMcpConfig: true }, "/w/KAN-783");
    expect(withFlag).toEqual([
      "follow your CLAUDE.md",
      "--model", "sonnet",
      "--effort", "high",
      "--permission-mode", "bypassPermissions",
      "--mcp-config", "/w/KAN-783/mcp.json",
      "--strict-mcp-config",
      "--dangerously-load-development-channels=server:butchr",
    ]);
    const without = spawnArgs(spec, "/w/KAN-783");
    expect(without).not.toContain("--strict-mcp-config");
    // Codex has no strict-MCP-config concept — never forwarded (see agentLaunchConfig's claude-only branch).
    const codexArgs = spawnArgs({ ...spec, strictMcpConfig: true }, "/w/KAN-783", { provider: "codex", disabledMcpServers: [] });
    expect(codexArgs).not.toContain("--strict-mcp-config");
  });

  test("PR #394 review fix (round 3): a spec with cwd set gets a kickoff that names its own working directory AND its own brief — both vendors — never the bare \"follow your CLAUDE.md/AGENTS.md\", which would be ambiguous about where the agent should actually work", () => {
    const cwdSpec = { ...spec, cwd: "/repo/some-project", brief: "Keep this repo's docs current." };
    const claudeArgs = spawnArgs(cwdSpec, "/w/KAN-783");
    expect(claudeArgs[0]).toContain("/repo/some-project");
    expect(claudeArgs[0]).toContain("Keep this repo's docs current.");
    expect(claudeArgs[0]).not.toContain("CLAUDE.md");
    const codexArgs = spawnArgs(cwdSpec, "/w/KAN-783", { provider: "codex" });
    expect(codexArgs[0]).toContain("/repo/some-project");
    expect(codexArgs[0]).toContain("Keep this repo's docs current.");
    expect(codexArgs[0]).not.toContain("AGENTS.md");
  });

  test("PR #394 review fix (round 3): a spec with cwd set is STILL launched with its process cwd at the ordinary bookkeeping directory, never at spec.cwd — see SpawnSpec.cwd's own doc comment for why (Drovr's launch.cwd===workspace.cwd invariant, and runningIssues()'s agentIdOfWorkspacePath-based residency)", () => {
    const cwdSpec = { ...spec, cwd: "/repo/some-project", brief: "Keep this repo's docs current." };
    const claude = agentLaunchConfig(cwdSpec, "/w/KAN-783", "pane", "worker", { provider: "claude" });
    expect(claude.cwd).toBe("/w/KAN-783");
    expect(claude.cwd).not.toBe("/repo/some-project");
    const codex = agentLaunchConfig(cwdSpec, "/w/KAN-783", "pane", "worker", { provider: "codex" });
    expect(codex.cwd).toBe("/w/KAN-783");
  });

  test("PR #394 review fix (round 2/3): a spec WITHOUT cwd is byte-for-byte unchanged — kickoff stays \"follow your CLAUDE.md\"/\"follow your AGENTS.md\" even when brief is set", () => {
    const briefedSpec = { ...spec, brief: "Some rule-engine brief text." };
    expect(spawnArgs(briefedSpec, "/w/KAN-783")[0]).toBe("follow your CLAUDE.md");
    expect(spawnArgs(briefedSpec, "/w/KAN-783", { provider: "codex" })[0]).toBe("follow your AGENTS.md");
  });

  test("BUTCHR-408 (McsServerBinding ported from S4): a channel:true bound server adds its own development-channels flag alongside server:butchr; channel:false does not", () => {
    const bound = [
      { name: "mud-bridge", type: "http" as const, url: "https://mud.internal/mcp", channel: true },
      { name: "quiet-tools", type: "http" as const, url: "https://quiet.internal/mcp", channel: false },
    ];
    const args = spawnArgs({ ...spec, mcpServers: bound }, "/w/KAN-783");
    expect(args).toContain("--dangerously-load-development-channels=server:butchr");
    expect(args).toContain("--dangerously-load-development-channels=server:mud-bridge");
    expect(args.some((a) => a.includes("server:quiet-tools"))).toBe(false);
  });

  test("BUTCHR-408: a bound server reaches Codex as an MCP tool with NEVER a header, even when headersEnvVar names a real secret — a Codex process's argv is world-readable via ps/proc", () => {
    const before = process.env.MUD_BRIDGE_HEADERS;
    process.env.MUD_BRIDGE_HEADERS = JSON.stringify({ Authorization: "Bearer super-secret-token" });
    try {
      const bound = [{ name: "mud-bridge", type: "http" as const, url: "https://mud.internal/mcp", headersEnvVar: "MUD_BRIDGE_HEADERS", channel: true }];
      const args = spawnArgs({ ...spec, mcpServers: bound }, "/w/KAN-783", { provider: "codex" });
      expect(args.join(" ")).toContain("mud-bridge");
      expect(args.join(" ")).not.toContain("super-secret-token");
      expect(args.join(" ")).not.toContain("Authorization");
      // Codex has no development-channel concept at all — a bound server reaches it as a tool only, never push.
      expect(args.some((a) => a.includes("--dangerously-load-development-channels"))).toBe(false);
    } finally {
      if (before === undefined) delete process.env.MUD_BRIDGE_HEADERS; else process.env.MUD_BRIDGE_HEADERS = before;
    }
  });

  test("BUTCHR-408: no mcpServers is byte-for-byte unchanged (today's behaviour exactly)", () => {
    expect(spawnArgs(spec, "/w/KAN-783")).toEqual(spawnArgs({ ...spec, mcpServers: [] }, "/w/KAN-783"));
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

  // BUTCHR-413 (CHANGES_REQUESTED review finding 1): unlike headersEnvVar's
  // secret value, a binding's non-secret `accountHeader` reaches Codex argv
  // — this is what lets a Codex agent's own mcp.json tool calls to a bridge
  // like rocketr identify which account is replying at all, after the
  // BUTCHR-411 fix above (still true, still tested immediately above) struck
  // every OTHER header from a Codex launch.
  test("a binding's accountHeader reaches Codex argv when this launch carries an rocketchatAccount — a non-secret account name, not a credential", () => {
    const withAccount = { ...mud, accountHeader: "x-rocketr-account" };
    const args = spawnArgs({ ...spec, mcpServers: [withAccount], rocketchatAccount: "butchr_jira-work-triage-kan-9_deadbeef00" }, "/w/KAN-783", { provider: "codex", disabledMcpServers: [] });
    const mudArg = args.find((a) => a.includes("mcp_servers.mud="));
    expect(mudArg).toBeDefined();
    expect(mudArg).toContain("http_headers");
    expect(mudArg).toContain("x-rocketr-account");
    expect(mudArg).toContain("butchr_jira-work-triage-kan-9_deadbeef00");
  });

  test("accountHeader configured but no rocketchatAccount on this launch (an account:\"none\" rule, or a provisioning refusal) — no headers at all, same as before this field existed", () => {
    const withAccount = { ...mud, accountHeader: "x-rocketr-account" };
    const args = spawnArgs({ ...spec, mcpServers: [withAccount] }, "/w/KAN-783", { provider: "codex", disabledMcpServers: [] });
    const mudArg = args.find((a) => a.includes("mcp_servers.mud="));
    expect(mudArg).toBeDefined();
    expect(mudArg).not.toContain("http_headers");
  });

  test("both headersEnvVar (secret) and accountHeader (non-secret) configured together: Codex argv carries the account name but never the secret", () => {
    process.env.BUTCHR_TEST_MUD_HEADERS_2 = JSON.stringify({ Authorization: "Bearer SEKRET-TOKEN-VALUE-2" });
    try {
      const both = { ...mud, headersEnvVar: "BUTCHR_TEST_MUD_HEADERS_2", accountHeader: "x-rocketr-account" };
      const args = spawnArgs({ ...spec, mcpServers: [both], rocketchatAccount: "butchr_acct" }, "/w/KAN-783", { provider: "codex", disabledMcpServers: [] });
      const mudArg = args.find((a) => a.includes("mcp_servers.mud="));
      expect(mudArg).toBeDefined();
      expect(mudArg).toContain("x-rocketr-account");
      expect(mudArg).toContain("butchr_acct");
      expect(mudArg).not.toContain("SEKRET-TOKEN-VALUE-2");
      expect(mudArg).not.toContain("Authorization");
      for (const a of args) expect(a).not.toContain("SEKRET-TOKEN-VALUE-2");
    } finally { delete process.env.BUTCHR_TEST_MUD_HEADERS_2; }
  });

  test("agy's launch is unaffected by mcpServers — bindings must not break it", () => {
    const launch = agentStartParams({ ...spec, mcpServers: [mud] }, "/w/KAN-783", "pane", "worker", { provider: "agy" });
    expect(launch).toEqual(agentStartParams(spec, "/w/KAN-783", "pane", "worker", { provider: "agy" }));
  });
});

describe("project-manager Claude permissions", () => {
  // No human answers a project manager's prompts; Claude's auto mode is the
  // counterpart of the Codex launch's on-request + auto_review policy.
  test("a jira-project Claude agent launches in auto permission mode", () => {
    const pm = { key: "jira-project:project-managers:GK", issuetype: "Project", summary: "s", parent: null };
    const args = spawnArgs(pm, "/w/GK", { provider: "claude" });
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("auto");
  });
});
