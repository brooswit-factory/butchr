import { describe, expect, test } from "bun:test";
import { selectClaudeProcess, realProcessTable, type ProcessEntry } from "../../src/agents/proctable.js";

const cwd = "/home/wroosbit/butchr-workspaces/KAN-783";

describe("selectClaudeProcess", () => {
  test("picks the claude process at the agent's cwd", () => {
    const table: ProcessEntry[] = [
      { pid: 1, ppid: 0, cwd, argv: ["claude", "--resume", "abc"] },
    ];
    expect(selectClaudeProcess(cwd, table)).toEqual(table[0]!);
  });

  test("a child process sharing the cwd (the Bash tool, an MCP server) is ignored — never picked over/instead of claude", () => {
    const claude: ProcessEntry = { pid: 1, ppid: 0, cwd, argv: ["claude", "follow your CLAUDE.md"] };
    const bashChild: ProcessEntry = { pid: 2, ppid: 1, cwd, argv: ["bash", "-c", "git status"] };
    const mcpChild: ProcessEntry = { pid: 3, ppid: 1, cwd, argv: ["node", "mcp-server.js"] };
    expect(selectClaudeProcess(cwd, [bashChild, mcpChild, claude])).toEqual(claude);
  });

  test("a bun/node wrapper in front of the real binary is tolerated via basename(argv[0])", () => {
    const wrapped: ProcessEntry = { pid: 1, ppid: 0, cwd, argv: ["/usr/local/bin/claude", "--resume", "abc"] };
    expect(selectClaudeProcess(cwd, [wrapped])).toEqual(wrapped);
  });

  test("two claude processes sharing the cwd: the one whose parent is NOT itself claude wins", () => {
    const outer: ProcessEntry = { pid: 1, ppid: 0, cwd, argv: ["claude", "--resume", "abc"] };
    const inner: ProcessEntry = { pid: 2, ppid: 1, cwd, argv: ["claude", "--some-subprocess"] };
    expect(selectClaudeProcess(cwd, [inner, outer])).toEqual(outer);
  });

  test("nothing at that cwd -> null (unknown, not stale)", () => {
    expect(selectClaudeProcess(cwd, [{ pid: 1, ppid: 0, cwd: "/somewhere/else", argv: ["claude"] }])).toBeNull();
    expect(selectClaudeProcess(cwd, [])).toBeNull();
  });

  test("a matching cwd with no claude process among it -> null, not the nearest non-claude match", () => {
    expect(selectClaudeProcess(cwd, [{ pid: 1, ppid: 0, cwd, argv: ["bash"] }])).toBeNull();
  });
});

describe("realProcessTable", () => {
  test("finds this test process itself (walks live /proc, tolerates unreadable/foreign entries)", async () => {
    const table = await realProcessTable();
    expect(table.length).toBeGreaterThan(0);
    const me = table.find((p) => p.pid === process.pid);
    expect(me).toBeDefined();
    expect(me!.cwd.length).toBeGreaterThan(0);
    expect(Array.isArray(me!.argv)).toBe(true);
    expect(me!.argv.length).toBeGreaterThan(0);
  });
});
