import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { HerdrHerd, agentNameFor, issueOfAgentName } from "../../src/agents/herd.js";

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
  const base = (prompts: any[], fail = false) => ({
    agent: {
      list: async () => ({ agents: [{ name: "butchr-kan-7", pane_id: "w1:p1", agent_status: "idle" }] }),
      start: async () => {},
      prompt: async (p: any) => { if (fail) throw new Error("pane is blocked"); prompts.push(p); },
    },
    workspace: { create: async () => ({ root_pane: "w1:p1" }) },
    pane: { close: async () => {} },
  });
  test("delivers a prompt to the issue's agent and reports true", async () => {
    const prompts: any[] = [];
    const herd = new HerdrHerd(base(prompts) as any, "http://x/mcp");
    expect(await herd.nudge("KAN-7", "[butchr] hi")).toBe(true);
    expect(prompts[0]).toEqual({ target: "butchr-kan-7", text: "[butchr] hi" });
  });
  test("false when no agent runs for the issue", async () => {
    const herd = new HerdrHerd(base([]) as any, "http://x/mcp");
    expect(await herd.nudge("KAN-999", "x")).toBe(false);
  });
  test("false when the pane refuses (blocked)", async () => {
    const herd = new HerdrHerd(base([], true) as any, "http://x/mcp");
    expect(await herd.nudge("KAN-7", "x")).toBe(false);
  });
});
