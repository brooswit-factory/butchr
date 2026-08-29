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
      "--permission-mode", "bypassPermissions",
      "--mcp-config", "/w/KAN-783/mcp.json",
      "--dangerously-load-development-channels", "server:butchr",
    ]);
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

  test("a wrong --mcp-config path -> stale", () => {
    const expected = spawnArgs(spec, "/w/KAN-783");
    const observed = spawnArgs(spec, "/w/SOMEWHERE-ELSE");
    const check = checkArgv(expected, observed);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toBe("argv lacks --mcp-config /w/KAN-783/mcp.json");
  });
});
