import { afterAll, describe, expect, test } from "bun:test";
import { buildApp, notifyIssue } from "../../src/daemon/app.js";
import { startLoop } from "../../src/daemon/loop.js";
import { createLoopHealth, type HealthStatus } from "../../src/daemon/health.js";
import { FakeConnection } from "@brooswit/thatch/testing";
import type { Herd } from "../../src/agents/herd.js";

const opened: string[] = [];
const healthy = { ok: true, components: [{ name: "pollLoop", ok: true, state: "ok" as const, lastSuccessAt: "2026-08-30T00:00:00.000Z", staleForMs: 0 }] };
const view = {
  state: async () => [{ issue: "KAN-9", status: "working", summary: "do a thing" }],
  open: async (issue: string) => { opened.push(issue); return issue === "KAN-BAD" ? { ok: false, error: "nope" } : { ok: true }; },
  health: () => healthy,
};
const { app, mcp } = buildApp(view);
app.listen(0);
const base = `http://localhost:${app.server!.port}`;
afterAll(async () => { await mcp.closeAll(); app.stop(); });

describe("butchr daemon app", () => {
  test("/health reports the injected liveness snapshot with a 200 when ok", async () => {
    const r = await fetch(`${base}/health`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual(healthy);
  });
  test("/agents live view", async () => {
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

// KAN/BUTCHR-18 (BUTCHR-6): /health must go red when the poll loop stops
// completing cycles, and recover once it resumes — driven through the REAL
// startLoop/buildApp composition and a real listening app, not a fake-clock
// assertion in isolation.
describe("/health reflects real poll-loop liveness (BUTCHR-18)", () => {
  test("returns 503+not-ok before the first successful poll, 200+ok once fresh, 503 again once stale, and 200 again on recovery — no latching", async () => {
    let nowMs = 1_000_000;
    const logs: string[] = [];
    const health = createLoopHealth({ name: "pollLoop", thresholdMs: 200, now: () => nowMs, checkIntervalMs: 5, log: (l) => logs.push(l) });
    const { app, mcp } = buildApp({
      state: async () => [],
      open: async () => ({ ok: true }),
      health: () => health.status(),
    });
    app.listen(0);
    const base = `http://localhost:${app.server!.port}`;
    try {
      // Before startLoop has ever ticked: not ok, and a non-200 status —
      // the "starting" grace period must not silently read healthy.
      const starting = await fetch(`${base}/health`);
      expect(starting.status).toBe(503);
      const startingBody = (await starting.json()) as HealthStatus;
      expect(startingBody.ok).toBe(false);
      expect(startingBody.components[0]).toMatchObject({ name: "pollLoop", ok: false, state: "starting", lastSuccessAt: null });

      const herd: Herd = {
        async runningIssues() { return []; },
        async staleIssues() { return []; },
        async spawn() {},
        async stop() {},
        async paneFor() { return null; },
        async nudge() { return { delivered: true }; },
      };
      let allowPoll = true;
      const stop = startLoop({
        search: async () => { if (!allowPoll) throw new Error("poll blocked for test"); return []; },
        herd,
        notify: () => {},
        intervalMs: 10,
        onPollSuccess: () => health.recordSuccess(),
      });
      try {
        // Let a real poll actually succeed.
        await Bun.sleep(50);
        const fresh = await fetch(`${base}/health`);
        expect(fresh.status).toBe(200);
        const freshBody = (await fresh.json()) as HealthStatus;
        expect(freshBody.ok).toBe(true);
        expect(freshBody.components[0]).toMatchObject({ name: "pollLoop", ok: true, state: "ok" });

        // Block further polls from completing (the loop itself keeps
        // ticking every intervalMs, exactly as a stuck/suspended-host loop
        // would — onError isn't wired here on purpose: the whole point of
        // this ticket is that a silent death never calls it), then advance
        // the health module's own clock past the threshold to simulate the
        // wall clock jumping forward (e.g. resume from suspend).
        allowPoll = false;
        nowMs += 10_000;
        await Bun.sleep(20); // no poll succeeds in here — let the transition-watcher timer log the STALE line
        const stale = await fetch(`${base}/health`);
        expect(stale.status).toBe(503);
        const staleBody = (await stale.json()) as HealthStatus;
        expect(staleBody.ok).toBe(false);
        expect(staleBody.components[0]).toMatchObject({ name: "pollLoop", ok: false, state: "stale" });
        expect(staleBody.components[0]!.staleForMs).toBeGreaterThan(0);
        expect(logs.some((l) => l.includes("pollLoop") && l.includes("STALE"))).toBe(true);

        // Recovers to ok on the next successful poll — no latching.
        allowPoll = true;
        await Bun.sleep(30);
        const recovered = await fetch(`${base}/health`);
        expect(recovered.status).toBe(200);
        expect(((await recovered.json()) as HealthStatus).ok).toBe(true);
        expect(logs.some((l) => l.includes("pollLoop") && l.includes("recovered"))).toBe(true);
      } finally {
        stop();
        allowPoll = false;
      }
    } finally {
      health.stop();
      await mcp.closeAll();
      app.stop();
    }
  });
});
