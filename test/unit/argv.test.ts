import { describe, expect, test } from "bun:test";
import { spawnArgs, checkArgv } from "../../src/agents/argv.js";

const spec = { key: "KAN-783", issuetype: "Task", summary: "s", parent: null };

describe("spawnArgs", () => {
  test("builds the full flag set, kickoff positional first", () => {
    const args = spawnArgs(spec, "/w/KAN-783");
    expect(args[0]).toBe("follow your CLAUDE.md");
    expect(args).toEqual([
      "follow your CLAUDE.md",
      "--model", "sonnet",
      "--effort", "high",
      "--permission-mode", "bypassPermissions",
      "--mcp-config", "/w/KAN-783/mcp.json",
      "--dangerously-load-development-channels", "server:butchr",
    ]);
  });

  test("--effort sits adjacent to --model, before the variadic flags", () => {
    const args = spawnArgs(spec, "/w/KAN-783");
    const modelIdx = args.indexOf("--model");
    expect(args[modelIdx + 2]).toBe("--effort");
    expect(args[modelIdx + 3]).toBe("high");
    expect(args.indexOf("--mcp-config")).toBeGreaterThan(modelIdx + 3);
    expect(args.indexOf("--dangerously-load-development-channels")).toBeGreaterThan(modelIdx + 3);
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
