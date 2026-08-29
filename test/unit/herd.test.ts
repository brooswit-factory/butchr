import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HerdrHerd, agentNameFor, issueOfAgentName } from "../../src/agents/herd.js";
import { reconcileNow, RespawnGuard } from "../../src/daemon/loop.js";
import { workspaceRoot } from "../../src/agents/workspace.js";

/** One foreground process, as herdr's `pane.process_info` reports it. */
interface FakeProcess { pid: number; argv?: string[] | null; name?: string }

function fakeHerdr(agents: Array<{ name?: string; pane_id: string }>) {
  const started: any[] = []; const closed: string[] = [];
  const client = {
    agent: { list: async () => ({ agents }), start: async (p: any) => { started.push(p); } },
    pane: { close: async (id: string) => { closed.push(id); }, read: async () => ({ read: { text: "" } }) },
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

const instant = () => Promise.resolve();

describe("HerdrHerd", () => {
  test("runningIssues lists only butchr-managed agents, mapped to their issue", async () => {
    const { client } = fakeHerdr([{ name: "butchr-kan-1", pane_id: "w1:p1" }, { name: "someone-else", pane_id: "w1:p2" }, { pane_id: "w1:p3" }]);
    const herd = new HerdrHerd(client, "http://localhost:7717/mcp");
    expect(await herd.runningIssues()).toEqual(["KAN-1"]);
  });
  test("spawn starts a claude agent with the channel flag + per-issue mcp config + kickoff prompt; is idempotent", async () => {
    const f = fakeHerdr([]);
    const herd = new HerdrHerd(f.client, "http://localhost:7717/mcp", instant);
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
    await new HerdrHerd(f2.client, "u", instant).spawn({ key: "KAN-7", issuetype: "Task", summary: "s", parent: null });
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

describe("spawn: kickoff verification (KAN-804/807)", () => {
  // After agent.start, the fake herdr's agent.list() must report the new
  // agent so statusOf()/byIssue() can see it — real herdr does this
  // immediately once the pane exists, unlike the plain fakeHerdr() above
  // (whose `agents` array is fixed at construction, before start() runs).
  function fakeHerdrWithLiveAgent(opts: { statusAfterStart: string; paneText?: string; fail?: boolean }) {
    const started: any[] = []; const closed: string[] = []; const prompts: any[] = []; const keys: any[] = [];
    let agents: Array<{ name?: string; pane_id: string; agent_status?: string }> = [];
    const client = {
      agent: {
        list: async () => ({ agents }),
        start: async (p: any) => { started.push(p); agents = [{ name: p.name, pane_id: p.pane_id, agent_status: opts.statusAfterStart }]; },
        prompt: async (p: any) => { if (opts.fail) throw new Error("blocked"); prompts.push(p); },
      },
      pane: {
        close: async (id: string) => { closed.push(id); },
        read: async () => ({ read: { text: opts.paneText ?? "" } }),
        sendKeys: async (k: any) => { keys.push(k); },
      },
      workspace: { create: async () => ({ root_pane: { pane_id: "w9:p1" } }) },
    };
    return { client: client as any, started, closed, prompts, keys };
  }

  test("a turn started (agent went working) → no recovery action", async () => {
    const f = fakeHerdrWithLiveAgent({ statusAfterStart: "working" });
    const herd = new HerdrHerd(f.client, "u", instant);
    await herd.spawn({ key: "KAN-7", issuetype: "Task", summary: "s", parent: null });
    expect(f.prompts.length).toBe(0);
    expect(f.closed.length).toBe(0);
  });

  test("kickoff swallowed (still idle) and NOT a session-limit refusal → recovers via nudge() (re-sends the kickoff, then Enter if still idle)", async () => {
    const f = fakeHerdrWithLiveAgent({ statusAfterStart: "idle", paneText: "some ordinary idle pane, no refusal here" });
    const herd = new HerdrHerd(f.client, "u", instant);
    await herd.spawn({ key: "KAN-7", issuetype: "Task", summary: "s", parent: null });
    expect(f.prompts).toEqual([{ target: "butchr-kan-7", text: "follow your CLAUDE.md" }]);
    expect(f.keys[0]).toEqual({ pane_id: "w9:p1", keys: ["enter"] }); // still idle after the nudge's own wait too
  });

  test("kickoff swallowed by a session-limit refusal → NOT re-sent (a limited session can't be nudged back to life)", async () => {
    const f = fakeHerdrWithLiveAgent({ statusAfterStart: "idle", paneText: "You've hit your session limit · resets 9:50pm" });
    const herd = new HerdrHerd(f.client, "u", instant);
    await herd.spawn({ key: "KAN-7", issuetype: "Task", summary: "s", parent: null });
    expect(f.prompts.length).toBe(0);
    expect(f.closed.length).toBe(0); // spawn() itself never closes — that's session-limit-watch.ts's job
  });

  test("done (sitting at its prompt) is treated the same as idle for verification", async () => {
    const f = fakeHerdrWithLiveAgent({ statusAfterStart: "done", paneText: "no refusal" });
    const herd = new HerdrHerd(f.client, "u", instant);
    await herd.spawn({ key: "KAN-7", issuetype: "Task", summary: "s", parent: null });
    expect(f.prompts.length).toBe(1);
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
    pane: {
      close: async () => {},
      sendKeys: async (k: any) => { (opts.keys ?? []).push(k); },
      read: async () => ({ read: { text: "no refusal here" } }),
    },
  });
  test("delivers a prompt; still idle after the wait → submits the stranded composer", async () => {
    const prompts: any[] = []; const keys: any[] = [];
    const herd = new HerdrHerd(base(prompts, { keys }) as any, "http://x/mcp", instant);
    expect(await herd.nudge("KAN-7", "[butchr] hi")).toEqual({ delivered: true });
    expect(prompts[0]).toEqual({ target: "butchr-kan-7", text: "[butchr] hi" });
    expect(keys[0]).toEqual({ pane_id: "w1:p1", keys: ["enter"] });   // delivered ≠ turn started
  });
  test("agent went working → no enter is sent", async () => {
    const keys: any[] = [];
    const herd = new HerdrHerd(base([], { statusAfter: "working", keys }) as any, "http://x/mcp", instant);
    expect(await herd.nudge("KAN-7", "x")).toEqual({ delivered: true });
    expect(keys.length).toBe(0);
  });
  test("agent blocked after prompt → never send enter (it would pick a dialog option)", async () => {
    const keys: any[] = [];
    const herd = new HerdrHerd(base([], { statusAfter: "blocked", keys }) as any, "http://x/mcp", instant);
    expect(await herd.nudge("KAN-7", "x")).toEqual({ delivered: true });
    expect(keys.length).toBe(0);
  });
  test("false when no agent runs for the issue", async () => {
    const herd = new HerdrHerd(base([]) as any, "http://x/mcp", instant);
    expect(await herd.nudge("KAN-999", "x")).toEqual({ delivered: false });
  });
  test("false when the pane refuses (blocked at prompt time)", async () => {
    const herd = new HerdrHerd(base([], { fail: true }) as any, "http://x/mcp", instant);
    expect(await herd.nudge("KAN-7", "x")).toEqual({ delivered: false });
  });
  // KAN-829: the nudge landed (agent.prompt did not throw), the agent is
  // still idle after the verify wait — but it is idle because the session
  // refused the prompt, not because of a stranded composer. Enter must NOT
  // be sent (nothing to submit), and the caller must be able to tell this
  // apart from an ordinary "delivered".
  test("prompt lands on a session-limit refusal → delivered but reports the refusal, never sends enter", async () => {
    const prompts: any[] = []; const keys: any[] = [];
    const client = base(prompts, { keys });
    client.pane.read = async () => ({ read: { text: "You've hit your session limit · resets 9:50pm" } });
    const herd = new HerdrHerd(client as any, "http://x/mcp", instant);
    const outcome = await herd.nudge("KAN-7", "x");
    expect(outcome.delivered).toBe(true);
    expect(outcome.refusal?.raw).toContain("You've hit your session limit"); // resetsAt resolution is session-limit.test.ts's concern
    expect(keys.length).toBe(0);
  });
  // KAN-831 review (PR #82): before the refusal check existed, nudge() could
  // no longer throw once agent.prompt succeeded (the only remaining call,
  // sendKeys, was already .catch(() => {})). A transient pane.read failure
  // here must not propagate: it would make daemon/index.ts's caller log
  // "refused/absent" for a prompt that WAS delivered — inverting the honesty
  // fix — and skip the stranded-composer enter, reopening KAN-691's 2.5h
  // stall via an unrelated herdr hiccup.
  test("a transient pane.read failure while checking for a refusal does not fail the nudge — falls through to submitting the stranded composer", async () => {
    const prompts: any[] = []; const keys: any[] = [];
    const client = base(prompts, { keys });
    client.pane.read = async () => { throw new Error("herdr hiccup"); };
    const herd = new HerdrHerd(client as any, "http://x/mcp", instant);
    const outcome = await herd.nudge("KAN-7", "x");
    expect(outcome).toEqual({ delivered: true });
    expect(keys[0]).toEqual({ pane_id: "w1:p1", keys: ["enter"] });
  });
});

describe("staleIssues", () => {
  /** `processInfo` responds per-pane; default to "no such pane" for any pane not given a canned response. */
  function fakeHerdrWithCwd(
    agents: Array<{ name?: string; pane_id: string; cwd?: string | null }>,
    responses: Record<string, () => Promise<{ process_info?: { pane_id: string; foreground_processes?: FakeProcess[] } }>>,
  ) {
    const calls: string[] = [];
    const client = {
      agent: { list: async () => ({ agents }) },
      pane: {
        processInfo: async (p: { pane_id: string }) => {
          calls.push(p.pane_id);
          const r = responses[p.pane_id];
          if (!r) throw new Error(`no fake response for pane ${p.pane_id}`);
          return r();
        },
      },
    };
    return { client: client as any, calls };
  }
  const instant = () => Promise.resolve();
  const ok = (foreground_processes: FakeProcess[]) => async () => ({ process_info: { pane_id: "x", foreground_processes } });

  test("a claude process at the reported pane with a bare `claude --resume` argv -> stale, naming the missing flags", async () => {
    const cwd = "/w/KAN-783";
    const argv = ["claude", "--resume", "8e5164dc"];
    const { client } = fakeHerdrWithCwd([{ name: "butchr-kan-783", pane_id: "w1:p1", cwd }], { "w1:p1": ok([{ pid: 1, argv, name: "claude" }]) });
    const herd = new HerdrHerd(client, "http://x/mcp", instant);
    const stale = await herd.staleIssues();
    expect(stale.length).toBe(1);
    expect(stale[0]!.issue).toBe("KAN-783");
    expect(stale[0]!.reason).toContain("--permission-mode bypassPermissions");
    expect(stale[0]!.reason).toContain(`--mcp-config ${cwd}/mcp.json`);
    expect(stale[0]!.reason).toContain("--dangerously-load-development-channels server:butchr");
    expect(stale[0]!.observedArgv).toEqual(argv);
  });

  test("a claude process carrying the full flag set -> not stale", async () => {
    const cwd = "/w/KAN-783";
    const goodArgv = ["claude", "follow your CLAUDE.md", "--model", "sonnet", "--permission-mode", "bypassPermissions", "--mcp-config", `${cwd}/mcp.json`, "--dangerously-load-development-channels", "server:butchr"];
    const { client } = fakeHerdrWithCwd([{ name: "butchr-kan-783", pane_id: "w1:p1", cwd }], { "w1:p1": ok([{ pid: 1, argv: goodArgv, name: "claude" }]) });
    const herd = new HerdrHerd(client, "http://x/mcp", instant);
    expect(await herd.staleIssues()).toEqual([]);
  });

  test("no cwd reported for the agent -> unknown, not stale (never even calls pane.process_info)", async () => {
    const { client, calls } = fakeHerdrWithCwd([{ name: "butchr-kan-783", pane_id: "w1:p1", cwd: null }], { "w1:p1": ok([{ pid: 1, argv: ["claude", "--resume", "x"], name: "claude" }]) });
    const herd = new HerdrHerd(client, "http://x/mcp", instant);
    expect(await herd.staleIssues()).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("pane.process_info rejects -> unknown, not stale, and does not abort the sweep for other issues", async () => {
    const cwd = "/w/KAN-783";
    const goodArgv = ["claude", "follow your CLAUDE.md", "--model", "sonnet", "--permission-mode", "bypassPermissions", "--mcp-config", "/w/KAN-9/mcp.json", "--dangerously-load-development-channels", "server:butchr"];
    const { client } = fakeHerdrWithCwd(
      [{ name: "butchr-kan-783", pane_id: "w1:p1", cwd }, { name: "butchr-kan-9", pane_id: "w1:p2", cwd: "/w/KAN-9" }],
      { "w1:p1": async () => { throw new Error("herdr socket hiccup"); }, "w1:p2": ok([{ pid: 2, argv: goodArgv, name: "claude" }]) },
    );
    const herd = new HerdrHerd(client, "http://x/mcp", instant);
    expect(await herd.staleIssues()).toEqual([]); // KAN-783's failure didn't stop KAN-9 from being (correctly) cleared
  });

  test("no process_info in the result -> unknown, not stale", async () => {
    const cwd = "/w/KAN-783";
    const { client } = fakeHerdrWithCwd([{ name: "butchr-kan-783", pane_id: "w1:p1", cwd }], { "w1:p1": async () => ({}) });
    const herd = new HerdrHerd(client, "http://x/mcp", instant);
    expect(await herd.staleIssues()).toEqual([]);
  });

  test("foreground_processes absent from process_info -> unknown, not stale", async () => {
    const cwd = "/w/KAN-783";
    const { client } = fakeHerdrWithCwd([{ name: "butchr-kan-783", pane_id: "w1:p1", cwd }], { "w1:p1": async () => ({ process_info: { pane_id: "w1:p1" } }) });
    const herd = new HerdrHerd(client, "http://x/mcp", instant);
    expect(await herd.staleIssues()).toEqual([]);
  });

  test("foreground_processes is empty -> unknown, not stale", async () => {
    const cwd = "/w/KAN-783";
    const { client } = fakeHerdrWithCwd([{ name: "butchr-kan-783", pane_id: "w1:p1", cwd }], { "w1:p1": ok([]) });
    const herd = new HerdrHerd(client, "http://x/mcp", instant);
    expect(await herd.staleIssues()).toEqual([]);
  });

  test("no foreground process is a claude -> unknown, not stale", async () => {
    const cwd = "/w/KAN-783";
    const { client } = fakeHerdrWithCwd([{ name: "butchr-kan-783", pane_id: "w1:p1", cwd }], { "w1:p1": ok([{ pid: 1, argv: ["zsh"], name: "zsh" }]) });
    const herd = new HerdrHerd(client, "http://x/mcp", instant);
    expect(await herd.staleIssues()).toEqual([]);
  });

  test("the matched claude process reports no argv -> unknown, not stale", async () => {
    const cwd = "/w/KAN-783";
    const { client } = fakeHerdrWithCwd([{ name: "butchr-kan-783", pane_id: "w1:p1", cwd }], { "w1:p1": ok([{ pid: 1, argv: null, name: "claude" }]) });
    const herd = new HerdrHerd(client, "http://x/mcp", instant);
    expect(await herd.staleIssues()).toEqual([]);
  });

  test("KAN-816 measured storm: a stray bare `claude --resume` at the SAME cwd, outside this pane's own foreground list, never taints the verdict", async () => {
    // The exact shape measured live 2026-08-29 00:14 PDT on KAN-811: a stray
    // unnamed pane's bare `claude --resume` process shared a cwd with the
    // healthy named pane. The old /proc-by-cwd scan would find both and, with
    // both processes' parents non-claude, pick the lower pid — the stray —
    // and call the healthy pane stale. Nothing here ever looks at cwd-shared
    // processes outside the pane's OWN foreground list, so the stray is
    // structurally invisible to the verdict.
    const cwd = "/w/KAN-811";
    const goodArgv = ["claude", "follow your CLAUDE.md", "--model", "sonnet", "--permission-mode", "bypassPermissions", "--mcp-config", `${cwd}/mcp.json`, "--dangerously-load-development-channels", "server:butchr"];
    const { client } = fakeHerdrWithCwd(
      [{ name: "butchr-kan-811", pane_id: "w1:p1", cwd }],
      // Only w1:p1 (the named, healthy pane) is ever queried — a stray pane
      // (e.g. w2K:p1) at the same cwd is not even a butchr-managed agent, so
      // byIssue() never surfaces it and staleIssues() never asks about it.
      { "w1:p1": ok([{ pid: 999999, argv: goodArgv, name: "claude" }]) },
    );
    const herd = new HerdrHerd(client, "http://x/mcp", instant);
    expect(await herd.staleIssues()).toEqual([]);
  });
});

describe("HerdrHerd + reconcileNow: the argv-staleness headline case", () => {
  // The real workspace directory buildWorkspace() would use for KAN-783 —
  // the same one a herdr-reported agent cwd must match for the expected argv.
  const dir = join(workspaceRoot(), "KAN-783");
  const desired = new Map([["KAN-783", { key: "KAN-783", issuetype: "Task", summary: "s", parent: null }]]);

  function fakeHerdrStale(processInfo: (paneId: string) => Promise<{ process_info?: { pane_id: string; foreground_processes?: FakeProcess[] } }>) {
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
      pane: {
        close: async (id: string) => { closed.push(id); agents = agents.filter((a) => a.pane_id !== id); },
        processInfo: (p: { pane_id: string }) => processInfo(p.pane_id),
      },
      workspace: { create: async () => ({ root_pane: { pane_id: "w9:p1" } }) },
    };
    return { client: client as any, started, closed };
  }
  const ok = (foreground_processes: FakeProcess[]) => async () => ({ process_info: { pane_id: "x", foreground_processes } });

  test("a) a stale pane (bare `claude --resume`) is closed and a fresh agent started with the full spawn argv; the [butchr:respawn] notice fires exactly once", async () => {
    const argv = ["claude", "--resume", "8e5164dc-c5d6-41b7-aa41-4a6143b818a5"];
    const f = fakeHerdrStale(ok([{ pid: 1, argv, name: "claude" }]));
    const herd = new HerdrHerd(f.client, "http://x/mcp", () => Promise.resolve());
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
    expect(notices[0]!.observedArgv).toEqual(argv);
  });

  test("b) a second pass, now with process-info showing the full argv, closes/starts nothing", async () => {
    const goodArgv = ["claude", "follow your CLAUDE.md", "--model", "sonnet", "--permission-mode", "bypassPermissions", "--mcp-config", `${dir}/mcp.json`, "--dangerously-load-development-channels", "server:butchr"];
    const f = fakeHerdrStale(ok([{ pid: 1, argv: goodArgv, name: "claude" }]));
    const herd = new HerdrHerd(f.client, "http://x/mcp", () => Promise.resolve());
    const notices: unknown[] = [];
    await reconcileNow(herd, desired, { onRespawn: (...a) => { notices.push(a); } });
    expect(f.closed).toEqual([]);
    expect(f.started).toEqual([]);
    expect(notices).toEqual([]);
  });

  test("c) no claude in the pane's foreground closes/starts nothing (unknown, not stale)", async () => {
    const f = fakeHerdrStale(ok([]));
    const herd = new HerdrHerd(f.client, "http://x/mcp", () => Promise.resolve());
    const notices: unknown[] = [];
    await reconcileNow(herd, desired, { onRespawn: (...a) => { notices.push(a); } });
    expect(f.closed).toEqual([]);
    expect(f.started).toEqual([]);
    expect(notices).toEqual([]);
  });

  test("KAN-816 measured storm, end to end: a stray bare `claude --resume` sharing this issue's cwd but OUTSIDE its pane's own foreground list never causes a respawn — zero pane.close, zero agent.start, zero onRespawn", async () => {
    // The measured incident (2026-08-29 00:14 PDT, KAN-811): a stray unnamed
    // pane's bare `claude --resume` shared a cwd with the healthy named pane.
    // The retired /proc-by-cwd scan found both processes there and, with
    // neither's parent itself claude, picked the lower pid — the stray — and
    // called the healthy pane STALE, closing and respawning it every poll.
    // pane.process_info is scoped to ONE pane, so the stray (which lives on
    // some other, non-butchr-managed pane) is never even asked about here —
    // there is no cwd-based lookup left for it to pollute.
    const goodArgv = ["claude", "follow your CLAUDE.md", "--model", "sonnet", "--permission-mode", "bypassPermissions", "--mcp-config", `${dir}/mcp.json`, "--dangerously-load-development-channels", "server:butchr"];
    const f = fakeHerdrStale(ok([{ pid: 999999, argv: goodArgv, name: "claude" }]));
    const herd = new HerdrHerd(f.client, "http://x/mcp", () => Promise.resolve());
    const notices: unknown[] = [];
    await reconcileNow(herd, desired, { onRespawn: (...a) => { notices.push(a); } });
    expect(f.closed).toEqual([]);
    expect(f.started).toEqual([]);
    expect(notices).toEqual([]);
  });
});
