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

describe("project-manager Claude permissions", () => {
  // No human answers a project manager's prompts; Claude's auto mode is the
  // counterpart of the Codex launch's on-request + auto_review policy.
  test("a jira-project Claude agent launches in auto permission mode", () => {
    const pm = { key: "jira-project:project-managers:GK", issuetype: "Project", summary: "s", parent: null };
    const args = spawnArgs(pm, "/w/GK", { provider: "claude" });
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("auto");
  });
});
