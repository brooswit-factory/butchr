import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { HerdrHerd, agentNameFor, issueOfAgentName } from "../../src/agents/herd.js";

function fakeHerdr(agents: Array<{ name?: string; pane_id: string }>) {
  const started: any[] = []; const closed: string[] = [];
  const client = {
    agent: { list: async () => ({ agents }), start: async (p: any) => { started.push(p); } },
    pane: { close: async (id: string) => { closed.push(id); } },
  };
  return { client: client as any, started, closed };
}

describe("agent name convention", () => {
  test("round-trips issue ↔ butchr:<issue>; foreign names are not ours", () => {
    expect(agentNameFor("KAN-1")).toBe("butchr:KAN-1");
    expect(issueOfAgentName("butchr:KAN-1")).toBe("KAN-1");
    expect(issueOfAgentName("some-other-agent")).toBeNull();
    expect(issueOfAgentName(null)).toBeNull();
  });
});

describe("HerdrHerd", () => {
  test("runningIssues lists only butchr-managed agents, mapped to their issue", async () => {
    const { client } = fakeHerdr([{ name: "butchr:KAN-1", pane_id: "w1:p1" }, { name: "someone-else", pane_id: "w1:p2" }, { pane_id: "w1:p3" }]);
    const herd = new HerdrHerd(client, "http://localhost:7717/mcp");
    expect(await herd.runningIssues()).toEqual(["KAN-1"]);
  });
  test("spawn starts a claude agent with the channel flag + per-issue mcp config; is idempotent", async () => {
    const f = fakeHerdr([]);
    const herd = new HerdrHerd(f.client, "http://localhost:7717/mcp");
    await herd.spawn("KAN-7");
    expect(f.started.length).toBe(1);
    expect(f.started[0].name).toBe("butchr:KAN-7");
    expect(f.started[0].kind).toBe("claude");
    expect(f.started[0].args).toContain("--channels");
    expect(f.started[0].args).toContain("server:butchr");
    const cfgPath = f.started[0].args[f.started[0].args.indexOf("--mcp-config") + 1];
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
    expect(cfg.mcpServers.butchr.url).toBe("http://localhost:7717/mcp");
    expect(cfg.mcpServers.butchr.headers["x-issue"]).toBe("KAN-7");
    // idempotent: already-running issue is not started again
    const f2 = fakeHerdr([{ name: "butchr:KAN-7", pane_id: "w1:p1" }]);
    await new HerdrHerd(f2.client, "u").spawn("KAN-7");
    expect(f2.started.length).toBe(0);
  });
  test("stop closes the issue's pane; a no-op when nothing is running for it", async () => {
    const f = fakeHerdr([{ name: "butchr:KAN-9", pane_id: "w1:p9" }]);
    const herd = new HerdrHerd(f.client, "u");
    await herd.stop("KAN-9");
    expect(f.closed).toEqual(["w1:p9"]);
    await herd.stop("KAN-404");   // not running
    expect(f.closed).toEqual(["w1:p9"]);
  });
});
