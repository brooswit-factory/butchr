import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { HerdrHerd, agentNameFor, issueOfAgentName } from "../../src/agents/herd.js";

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
    pane: { close: async () => {}, sendKeys: async (k: any) => { (opts.keys ?? []).push(k); } },
  });
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
