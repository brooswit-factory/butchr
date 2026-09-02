import { afterAll, describe, expect, test } from "bun:test";
import { buildApp, notifyIssue } from "../../src/daemon/app.js";
import { startLoop } from "../../src/daemon/loop.js";
import { combineHealth, createLoopHealth, type HealthStatus } from "../../src/daemon/health.js";
import { buildIdentity, toBuildReport } from "../../src/agents/build-identity.js";
import { FakeConnection } from "@brooswit/thatch/testing";
import type { Herd } from "../../src/agents/herd.js";
import type { JiraIssue } from "../../src/atlassian/types.js";

const opened: string[] = [];
// BUTCHR-57: /health now reports TWO components — pollLoop (the fetch
// stage) and notify (the notify stage, this ticket) — so this fixture,
// which previously hardcoded a one-element array, must reflect the real
// current shape rather than being loosened to hide the change.
const healthy = {
  ok: true,
  components: [
    { name: "pollLoop", ok: true, state: "ok" as const, lastSuccessAt: "2026-08-30T00:00:00.000Z", staleForMs: 0 },
    { name: "notify", ok: true, state: "ok" as const, lastSuccessAt: "2026-08-30T00:00:00.000Z", staleForMs: 0 },
  ],
};
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

// BUTCHR-57: the notify stage (loop.ts's onChange — diffing, suppression,
// deps.notify sends) had NO heartbeat of its own; a poll cycle whose fetch
// succeeded but whose notify stage failed (or silently died) still reported
// {"ok":true}. Driven through the same real startLoop/buildApp seam as the
// poll-loop test above, per the ticket's DoD: this must NOT invent a second
// test pattern.
describe("/health reflects real notify-stage liveness (BUTCHR-57)", () => {
  test("stays green on a quiet fleet with nothing to notify, goes red+503 when the notify stage stops completing, and recovers", async () => {
    let nowMs = 1_000_000;
    const logs: string[] = [];
    const pollHealth = createLoopHealth({ name: "pollLoop", thresholdMs: 200, now: () => nowMs, checkIntervalMs: 5, log: (l) => logs.push(l) });
    const notifyHealth = createLoopHealth({ name: "notify", thresholdMs: 200, now: () => nowMs, checkIntervalMs: 5, log: (l) => logs.push(l) });
    const { app, mcp } = buildApp({
      state: async () => [],
      open: async () => ({ ok: true }),
      health: () => combineHealth([pollHealth, notifyHealth]),
    });
    app.listen(0);
    const base = `http://localhost:${app.server!.port}`;
    try {
      const herd: Herd = {
        async runningIssues() { return []; },
        async staleIssues() { return []; },
        async spawn() {},
        async stop() {},
        async paneFor() { return null; },
        async nudge() { return { delivered: true }; },
      };
      // "To Do" (not an ACTIVE_STATUSES member — src/reconcile/plan.ts) so
      // reconcileNow's desired set stays empty and this test only exercises
      // the notify stage, not spawn/stop.
      const base_issue: JiraIssue = { key: "KAN-1", summary: "s", status: "To Do", issuetype: "Task", assignee: null, parent: null, updated: "2026-01-01T00:00:00.000Z", labels: [] };
      let mode: "quiet" | "changing" = "quiet";
      let tick = 0;
      let allowNotify = true;
      const stop = startLoop({
        // "quiet": the exact same issue every poll (a real quiet fleet —
        // nothing changed in Jira). "changing": `updated` moves every single
        // call, guaranteeing changedKeys is non-empty on EVERY poll (not
        // just the ones a racing timer happens to catch), so deps.notify is
        // actually invoked — and can actually be made to fail — every tick.
        search: async () => [mode === "quiet" ? base_issue : { ...base_issue, updated: new Date(2026, 0, 1, 0, 0, 0, ++tick).toISOString() }],
        herd,
        notify: async () => { if (!allowNotify) throw new Error("notify blocked for test"); },
        intervalMs: 10,
        onPollSuccess: () => pollHealth.recordSuccess(),
        onNotifySuccess: () => notifyHealth.recordSuccess(),
        log: (l) => logs.push(l),
      });
      try {
        // Quiet fleet: nothing ever changes. The notify stage must still go
        // (and stay) green — mechanic B. Before the `hash` override in
        // loop.ts, onChange would never run at all here, and this component
        // would sit "starting" then "stale" forever despite nothing being
        // wrong.
        await Bun.sleep(50);
        const quiet = await fetch(`${base}/health`);
        expect(quiet.status).toBe(200);
        const quietBody = (await quiet.json()) as HealthStatus;
        expect(quietBody.ok).toBe(true);
        expect(quietBody.components.find((c) => c.name === "notify")).toMatchObject({ ok: true, state: "ok" });
        expect(quietBody.components.find((c) => c.name === "pollLoop")).toMatchObject({ ok: true, state: "ok" });

        // Now give the notify stage real work every poll, and make it fail
        // at that work every time (mechanic A: this must become a LOGGED
        // failure, not a silent unhandled rejection). Let a few real polls
        // actually happen and throw before jumping the mocked clock, so the
        // WARNING log line is genuinely produced by a real failure.
        mode = "changing";
        allowNotify = false;
        await Bun.sleep(30);
        nowMs += 10_000;
        await Bun.sleep(20); // let the transition-watcher timer log the STALE line
        const stale = await fetch(`${base}/health`);
        expect(stale.status).toBe(503);
        const staleBody = (await stale.json()) as HealthStatus;
        expect(staleBody.ok).toBe(false);
        expect(staleBody.components.find((c) => c.name === "notify")).toMatchObject({ ok: false, state: "stale" });
        // The fetch stage is unaffected — only the notify stage is down.
        expect(staleBody.components.find((c) => c.name === "pollLoop")).toMatchObject({ ok: true, state: "ok" });
        expect(logs.some((l) => l.includes("[notify] stage threw") && l.includes("notify blocked for test"))).toBe(true);
        expect(logs.some((l) => l.includes("notify") && l.includes("STALE"))).toBe(true);

        // Recovers to ok on the next successful notify pass — no latching.
        allowNotify = true;
        await Bun.sleep(30);
        const recovered = await fetch(`${base}/health`);
        expect(recovered.status).toBe(200);
        const recoveredBody = (await recovered.json()) as HealthStatus;
        expect(recoveredBody.ok).toBe(true);
        expect(recoveredBody.components.find((c) => c.name === "notify")).toMatchObject({ ok: true, state: "ok" });
        expect(logs.some((l) => l.includes("notify") && l.includes("recovered"))).toBe(true);
      } finally {
        stop();
        allowNotify = true;
      }
    } finally {
      pollHealth.stop();
      notifyHealth.stop();
      await mcp.closeAll();
      app.stop();
    }
  });
});

// BUTCHR-54: /health carries this daemon's own build identity as a SIBLING
// field, never an entry in components[] — build identity is not a liveness
// signal, so it must never be able to flip `ok`. Driven through the real
// production composition (combineHealth + buildApp + this process's own
// `buildIdentity` singleton, not a hand-rolled fixture) and a real listening
// server, per the ticket's own "assert on the actual endpoint response"
// requirement.
describe("/health carries build identity as a sibling of components, never inside it (BUTCHR-54)", () => {
  test("combineHealth's optional build param round-trips through the real /health endpoint", async () => {
    const health = createLoopHealth({ name: "pollLoop", thresholdMs: 60_000 });
    const build = toBuildReport(buildIdentity);
    const { app, mcp } = buildApp({
      state: async () => [],
      open: async () => ({ ok: true }),
      health: () => combineHealth([health], build),
    });
    app.listen(0);
    try {
      const res = await fetch(`http://localhost:${app.server!.port}/health`);
      const body = (await res.json()) as HealthStatus;
      expect(body.build).toEqual(build);
      // Never folded into components[] — components stays exactly the liveness list.
      expect(body.components).toEqual([expect.objectContaining({ name: "pollLoop" })]);
      expect(body.components.some((c) => "sha" in c || "version" in c)).toBe(false);
      // A daemon that doesn't know its own sha is not thereby unhealthy: `ok`
      // here reflects pollLoop's own state (starting, since recordSuccess was
      // never called), completely independent of whether build.sha is known.
      expect(body.ok).toBe(false);
      expect(body.build!.pid).toBe(process.pid);
    } finally {
      health.stop();
      await mcp.closeAll();
      app.stop();
    }
  });

  test("omitting build (existing callers, e.g. every fixture above) leaves it absent from the response — fully backward compatible", async () => {
    const health = createLoopHealth({ name: "pollLoop", thresholdMs: 60_000 });
    health.recordSuccess();
    const { app, mcp } = buildApp({
      state: async () => [],
      open: async () => ({ ok: true }),
      health: () => combineHealth([health]),
    });
    app.listen(0);
    try {
      const body = (await (await fetch(`http://localhost:${app.server!.port}/health`)).json()) as HealthStatus;
      expect(body.build).toBeUndefined();
      expect(body.ok).toBe(true);
    } finally {
      health.stop();
      await mcp.closeAll();
      app.stop();
    }
  });
});
