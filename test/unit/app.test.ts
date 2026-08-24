import { afterAll, describe, expect, test } from "bun:test";
import { buildApp, notifyIssue } from "../../src/daemon/app.js";
import { FakeConnection } from "@brooswit/thatch/testing";

const opened: string[] = [];
const view = {
  state: async () => [{ issue: "KAN-9", status: "working", summary: "do a thing" }],
  open: async (issue: string) => { opened.push(issue); return issue === "KAN-BAD" ? { ok: false, error: "nope" } : { ok: true }; },
};
const { app, mcp } = buildApp(view);
app.listen(0);
const base = `http://localhost:${app.server!.port}`;
afterAll(async () => { await mcp.closeAll(); app.stop(); });

describe("butchr daemon app", () => {
  test("/health and /agents live view", async () => {
    expect(await (await fetch(`${base}/health`)).json()).toEqual({ ok: true });
    expect(await (await fetch(`${base}/agents`)).json()).toEqual([]);
  });
  test("an agent must present x-issue to connect (auth gate)", async () => {
    await expect(FakeConnection.connect(base, { headers: {} })).rejects.toThrow();
    const a = await FakeConnection.connect(base, { headers: { "x-issue": "KAN-203" } });
    const agents = await (await fetch(`${base}/agents`)).json();
    expect(agents).toEqual([{ id: a.sessionId, issue: "KAN-203", connectedAt: expect.any(Number) }]);
    await a.disconnect(); await Bun.sleep(30);
  });
  test("notifyIssue pushes only to agents on that issue", async () => {
    const a = await FakeConnection.connect(base, { headers: { "x-issue": "KAN-9" } });
    for (let i = 0; i < 100 && !mcp.connections.get(a.sessionId!)?.["id"]; i++) await Bun.sleep(5);
    // wait for the channel stream
    let r; for (let i = 0; i < 100; i++) { r = await notifyIssue(mcp, "KAN-9", "hello"); if (r.sent.length) break; await Bun.sleep(10); }
    expect(r!.sent.length).toBe(1);
    expect(await a.nextFrame()).toMatchObject({ content: "hello", meta: { issue: "KAN-9" } });
    expect((await notifyIssue(mcp, "KAN-000", "x")).sent).toEqual([]);
    await a.disconnect(); await Bun.sleep(30);
  });
});

describe("butchr webapp + open action", () => {
  test("GET / serves the html page", async () => {
    const html = await (await fetch(`${base}/`)).text();
    expect(html).toContain("butchr — active agents");
    expect(html).toContain("/agents/");
  });
  test("GET /state returns the active agents", async () => {
    expect(await (await fetch(`${base}/state`)).json()).toEqual([{ issue: "KAN-9", status: "working", summary: "do a thing" }]);
  });
  test("POST /agents/:issue/open invokes open and reports ok / 409", async () => {
    const ok = await fetch(`${base}/agents/KAN-9/open`, { method: "POST" });
    expect(ok.status).toBe(200); expect(await ok.json()).toEqual({ ok: true });
    expect(opened).toContain("KAN-9");
    const bad = await fetch(`${base}/agents/KAN-BAD/open`, { method: "POST" });
    expect(bad.status).toBe(409); expect(((await bad.json()) as { ok: boolean }).ok).toBe(false);
  });
  test("open decodes the issue key from the path", async () => {
    await fetch(`${base}/agents/${encodeURIComponent("KAN-9")}/open`, { method: "POST" });
    expect(opened).toContain("KAN-9");
  });
});
