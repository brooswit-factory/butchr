import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HerdrHerd, agentNameFor, issueOfAgentName } from "../../src/agents/herd.js";
import { reconcileNow } from "../../src/daemon/loop.js";
import { workspaceRoot } from "../../src/agents/workspace.js";
import type { ProcessEntry } from "../../src/agents/proctable.js";

function fakeHerdr(agents: Array<{ name?: string; pane_id: string }>) {
  const started: any[] = []; const closed: string[] = [];
  const client = {
    agent: { list: async () => ({ agents }), start: async (p: any) => { started.push(p); } },
    pane: { close: async (id: string) => { closed.push(id); } },
    workspace: { create: async (_p: any) => ({ root_pane: { pane_id: "w9:p1" } }) },
  };
  return { client: client as any, started, closed };
}

describe("agent name convention", () => {
  test("round-trips issue ↔ butchr:<issue>; foreign names are not ours", () => {
    expect(agentNameFor("KAN-1")).toBe("butchr-kan-1");
    expect(issueOfAgentName("butchr-kan-1")).toBe("KAN-1");
    expect(issueOfAgentName("some-other-agent")).toBeNull();
    expect(issueOfAgentName(null)).toBeNull();
  });
});

describe("HerdrHerd", () => {
  test("runningIssues lists only butchr-managed agents, mapped to their issue", async () => {
    const { client } = fakeHerdr([{ name: "butchr-kan-1", pane_id: "w1:p1" }, { name: "someone-else", pane_id: "w1:p2" }, { pane_id: "w1:p3" }]);
    const herd = new HerdrHerd(client, "http://localhost:7717/mcp");
    expect(await herd.runningIssues()).toEqual(["KAN-1"]);
  });
  test("spawn starts a claude agent with the channel flag + per-issue mcp config + kickoff prompt; is idempotent", async () => {
    const f = fakeHerdr([]);
    const herd = new HerdrHerd(f.client, "http://localhost:7717/mcp");
    await herd.spawn({ key: "KAN-7", issuetype: "Task", summary: "s", parent: "KAN-1" });
    expect(f.started.length).toBe(1);
    expect(f.started[0].name).toBe("butchr-kan-7");
    expect(f.started[0].pane_id).toBe("w9:p1");   // started in the new workspace's root pane
    expect(f.started[0].kind).toBe("claude");
    expect(f.started[0].args).toContain("--permission-mode");
    expect(f.started[0].args).toContain("bypassPermissions");
    expect(f.started[0].args).toContain("--dangerously-load-development-channels");
    expect(f.started[0].args).toContain("server:butchr");
    // the kickoff prompt is the FIRST argument: the variadic channel/mcp flags
    // swallow a trailing positional as one of their own entries
    expect(f.started[0].args[0]).toBe("follow your CLAUDE.md");
    expect(f.started[0].args[f.started[0].args.length - 1]).toBe("server:butchr");
    const cfgPath = f.started[0].args[f.started[0].args.indexOf("--mcp-config") + 1];
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
    expect(cfg.mcpServers.butchr.url).toBe("http://localhost:7717/mcp");
    expect(cfg.mcpServers.butchr.headers["x-issue"]).toBe("KAN-7");
    // idempotent: already-running issue is not started again
    const f2 = fakeHerdr([{ name: "butchr-kan-7", pane_id: "w1:p1" }]);
    await new HerdrHerd(f2.client, "u").spawn({ key: "KAN-7", issuetype: "Task", summary: "s", parent: null });
    expect(f2.started.length).toBe(0);
  });
  test("paneFor resolves the current pane, or null when not running", async () => {
    const f = fakeHerdr([{ name: "butchr-kan-5", pane_id: "w1:p5" }]);
    const herd = new HerdrHerd(f.client, "u");
    expect(await herd.paneFor("KAN-5")).toBe("w1:p5");
    expect(await herd.paneFor("KAN-404")).toBeNull();
  });
  test("stop closes the issue's pane; a no-op when nothing is running for it", async () => {
    const f = fakeHerdr([{ name: "butchr-kan-9", pane_id: "w1:p9" }]);
    const herd = new HerdrHerd(f.client, "u");
    await herd.stop("KAN-9");
    expect(f.closed).toEqual(["w1:p9"]);
    await herd.stop("KAN-404");   // not running
    expect(f.closed).toEqual(["w1:p9"]);
  });
});

describe("spawn failure", () => {
  test("closes the just-created workspace pane when agent.start fails", async () => {
    const closed: string[] = [];
    const f = {
      started: [] as any[],
      agent: { list: async () => ({ agents: [] }), start: async () => { throw new Error("boom"); } },
      workspace: { create: async () => ({ root_pane: "wX:p1" }) },
      pane: { close: async (p: string) => { closed.push(p); } },
    };
    const herd = new HerdrHerd(f as any, "http://x/mcp");
    await expect(herd.spawn({ key: "KAN-9", issuetype: "Task", summary: "s", parent: null })).rejects.toThrow("boom");
    expect(closed).toEqual(["wX:p1"]);
  });
});

describe("nudge", () => {
  const base = (prompts: any[], opts: { fail?: boolean; statusAfter?: string; keys?: any[] } = {}) => ({
    agent: {
      list: async () => ({ agents: [{ name: "butchr-kan-7", pane_id: "w1:p1", agent_status: opts.statusAfter ?? "idle" }] }),
      start: async () => {},
      prompt: async (p: any) => { if (opts.fail) throw new Error("pane is blocked"); prompts.push(p); },
    },
    workspace: { create: async () => ({ root_pane: "w1:p1" }) },
    pane: { close: async () => {}, sendKeys: async (k: any) => { (opts.keys ?? []).push(k); } },
  });
  const instant = () => Promise.resolve();
  test("delivers a prompt; still idle after the wait → submits the stranded composer", async () => {
    const prompts: any[] = []; const keys: any[] = [];
    const herd = new HerdrHerd(base(prompts, { keys }) as any, "http://x/mcp", instant);
    expect(await herd.nudge("KAN-7", "[butchr] hi")).toBe(true);
    expect(prompts[0]).toEqual({ target: "butchr-kan-7", text: "[butchr] hi" });
    expect(keys[0]).toEqual({ pane_id: "w1:p1", keys: ["enter"] });   // delivered ≠ turn started
  });
  test("agent went working → no enter is sent", async () => {
    const keys: any[] = [];
    const herd = new HerdrHerd(base([], { statusAfter: "working", keys }) as any, "http://x/mcp", instant);
    expect(await herd.nudge("KAN-7", "x")).toBe(true);
    expect(keys.length).toBe(0);
  });
  test("agent blocked after prompt → never send enter (it would pick a dialog option)", async () => {
    const keys: any[] = [];
    const herd = new HerdrHerd(base([], { statusAfter: "blocked", keys }) as any, "http://x/mcp", instant);
    expect(await herd.nudge("KAN-7", "x")).toBe(true);
    expect(keys.length).toBe(0);
  });
  test("false when no agent runs for the issue", async () => {
    const herd = new HerdrHerd(base([]) as any, "http://x/mcp", instant);
    expect(await herd.nudge("KAN-999", "x")).toBe(false);
  });
  test("false when the pane refuses (blocked at prompt time)", async () => {
    const herd = new HerdrHerd(base([], { fail: true }) as any, "http://x/mcp", instant);
    expect(await herd.nudge("KAN-7", "x")).toBe(false);
  });
});

describe("staleIssues", () => {
  function fakeHerdrWithCwd(agents: Array<{ name?: string; pane_id: string; cwd?: string | null }>) {
    return { agent: { list: async () => ({ agents }) } } as any;
  }
  const instant = () => Promise.resolve();

  test("a claude process at the reported cwd with a bare `claude --resume` argv -> stale, naming the missing flags", async () => {
    const cwd = "/w/KAN-783";
    const client = fakeHerdrWithCwd([{ name: "butchr-kan-783", pane_id: "w1:p1", cwd }]);
    const table: ProcessEntry[] = [{ pid: 1, ppid: 0, cwd, argv: ["claude", "--resume", "8e5164dc"] }];
    const herd = new HerdrHerd(client, "http://x/mcp", instant, async () => table);
    const stale = await herd.staleIssues();
    expect(stale.length).toBe(1);
    expect(stale[0]!.issue).toBe("KAN-783");
    expect(stale[0]!.reason).toContain("--permission-mode bypassPermissions");
    expect(stale[0]!.reason).toContain(`--mcp-config ${cwd}/mcp.json`);
    expect(stale[0]!.reason).toContain("--dangerously-load-development-channels server:butchr");
    expect(stale[0]!.observedArgv).toEqual(table[0]!.argv);
  });

  test("a claude process carrying the full flag set -> not stale", async () => {
    const cwd = "/w/KAN-783";
    const client = fakeHerdrWithCwd([{ name: "butchr-kan-783", pane_id: "w1:p1", cwd }]);
    const table: ProcessEntry[] = [{ pid: 1, ppid: 0, cwd, argv: ["claude", "follow your CLAUDE.md", "--model", "sonnet", "--permission-mode", "bypassPermissions", "--mcp-config", `${cwd}/mcp.json`, "--dangerously-load-development-channels", "server:butchr"] }];
    const herd = new HerdrHerd(client, "http://x/mcp", instant, async () => table);
    expect(await herd.staleIssues()).toEqual([]);
  });

  test("no cwd reported for the agent -> unknown, not stale (never even consults the process table)", async () => {
    const client = fakeHerdrWithCwd([{ name: "butchr-kan-783", pane_id: "w1:p1", cwd: null }]);
    const herd = new HerdrHerd(client, "http://x/mcp", instant, async () => [{ pid: 1, ppid: 0, cwd: "/w/KAN-783", argv: ["claude", "--resume", "x"] }]);
    expect(await herd.staleIssues()).toEqual([]);
  });

  test("no claude process found for the cwd -> unknown, not stale", async () => {
    const cwd = "/w/KAN-783";
    const client = fakeHerdrWithCwd([{ name: "butchr-kan-783", pane_id: "w1:p1", cwd }]);
    const herd = new HerdrHerd(client, "http://x/mcp", instant, async () => []);
    expect(await herd.staleIssues()).toEqual([]);
  });
});

describe("HerdrHerd + reconcileNow: the argv-staleness headline case", () => {
  // The real workspace directory buildWorkspace() would use for KAN-783 —
  // the same one a herdr-reported agent cwd must match for selectClaudeProcess
  // to find its process.
  const dir = join(workspaceRoot(), "KAN-783");
  const desired = new Map([["KAN-783", { key: "KAN-783", issuetype: "Task", summary: "s", parent: null }]]);

  function fakeHerdrStale() {
    let agents: Array<{ name: string; pane_id: string; cwd: string }> = [{ name: "butchr-kan-783", pane_id: "w1:p1", cwd: dir }];
    const started: any[] = []; const closed: string[] = [];
    const client = {
      agent: {
        list: async () => ({ agents }),
        start: async (p: any) => { started.push(p); agents = [...agents, { name: "butchr-kan-783", pane_id: "w9:p1", cwd: dir }]; },
      },
      // Closing a pane retires its agent — herdr's list no longer carries it,
      // exactly what makes spawn() (which no-ops when the name already
      // exists) actually start a fresh one on the stop-then-spawn respawn path.
      pane: { close: async (id: string) => { closed.push(id); agents = agents.filter((a) => a.pane_id !== id); } },
      workspace: { create: async () => ({ root_pane: { pane_id: "w9:p1" } }) },
    };
    return { client: client as any, started, closed };
  }

  test("a stale pane (bare `claude --resume`) is closed and a fresh agent started with the full spawn argv; the [butchr:respawn] notice fires exactly once", async () => {
    const f = fakeHerdrStale();
    const table: ProcessEntry[] = [{ pid: 1, ppid: 0, cwd: dir, argv: ["claude", "--resume", "8e5164dc-c5d6-41b7-aa41-4a6143b818a5"] }];
    const herd = new HerdrHerd(f.client, "http://x/mcp", () => Promise.resolve(), async () => table);
    const notices: Array<{ issue: string; reason: string; observedArgv: string[] }> = [];
    await reconcileNow(herd, desired, { onRespawn: (issue, reason, observedArgv) => { notices.push({ issue, reason, observedArgv }); } });

    // a) pane closed AND a new agent started whose args equal the full spawn argv
    expect(f.closed).toEqual(["w1:p1"]);
    expect(f.started.length).toBe(1);
    expect(f.started[0].args[0]).toBe("follow your CLAUDE.md");
    expect(f.started[0].args).toContain("--permission-mode");
    expect(f.started[0].args).toContain("bypassPermissions");
    expect(f.started[0].args[f.started[0].args.indexOf("--mcp-config") + 1]).toBe(dir + "/mcp.json");

    // b) the notice was posted exactly once and starts with [butchr:respawn]'s reason shape
    expect(notices.length).toBe(1);
    expect(notices[0]!.issue).toBe("KAN-783");
    expect(notices[0]!.reason.startsWith("argv lacks")).toBe(true);
    expect(notices[0]!.observedArgv).toEqual(table[0]!.argv);
  });

  test("c) a second pass, now with the process table showing the full argv, closes/starts nothing", async () => {
    const f = fakeHerdrStale();
    const goodArgv = ["claude", "follow your CLAUDE.md", "--model", "sonnet", "--permission-mode", "bypassPermissions", "--mcp-config", `${dir}/mcp.json`, "--dangerously-load-development-channels", "server:butchr"];
    const table: ProcessEntry[] = [{ pid: 1, ppid: 0, cwd: dir, argv: goodArgv }];
    const herd = new HerdrHerd(f.client, "http://x/mcp", () => Promise.resolve(), async () => table);
    const notices: unknown[] = [];
    await reconcileNow(herd, desired, { onRespawn: (...a) => { notices.push(a); } });
    expect(f.closed).toEqual([]);
    expect(f.started).toEqual([]);
    expect(notices).toEqual([]);
  });

  test("d) a process table with NO claude process for that cwd closes/starts nothing (unknown, not stale)", async () => {
    const f = fakeHerdrStale();
    const herd = new HerdrHerd(f.client, "http://x/mcp", () => Promise.resolve(), async () => []);
    const notices: unknown[] = [];
    await reconcileNow(herd, desired, { onRespawn: (...a) => { notices.push(a); } });
    expect(f.closed).toEqual([]);
    expect(f.started).toEqual([]);
    expect(notices).toEqual([]);
  });
});
