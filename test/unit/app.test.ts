import { afterAll, describe, expect, test } from "bun:test";
import { buildApp, notifyIssue } from "../../src/daemon/app.js";
import { startLoop } from "../../src/daemon/loop.js";
import { combineHealth, createLoopHealth, type HealthStatus } from "../../src/daemon/health.js";
import { createCoverageTracker } from "../../src/daemon/coverage.js";
import { createAdmissionController } from "../../src/agents/admission.js";
import { buildIdentity, toBuildReport } from "../../src/agents/build-identity.js";
import { FakeConnection } from "@brooswit/thatch/testing";
import type { Herd } from "../../src/agents/herd.js";
import type { JiraIssue } from "../../src/atlassian/types.js";
import type { DashboardResponse } from "../../src/agents/dashboard.js";

// BUTCHR-269: a trivial, always-checked-empty fixture for every existing
// ViewDeps literal below that predates /dashboard and isn't exercising it —
// the real row-shape/could-not-check contract gets its own dedicated
// describe block (and its own dedicated fixtures) further down this file.
const noDashboard = async (): Promise<DashboardResponse> => ({ checked: true, confirmedAt: new Date(0).toISOString(), rows: [] });

const opened: string[] = [];
const openedPanes: string[] = [];
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
// BUTCHR-267: `openPane` fixture exercises the four outcomes the pane-keyed
// attach route (criterion 8, amended) must be able to reach — "w1:p3" (a
// colon-bearing pane, per criterion 1) succeeds; "KAN-NO-TERM:p1" simulates
// no terminal emulator configured; "KAN-NO-DISPLAY:p1" simulates the daemon
// having no display to reach (per the ticket's [correction]: on at least one
// real daemon this is the ONLY branch that ever runs, not a rare edge case,
// so it gets its own end-to-end test rather than only unit coverage on
// `resolveAttach`); anything else is an unknown/not-live pane.
const openPane = async (pane: string) => {
  openedPanes.push(pane);
  if (pane === "KAN-NO-TERM:p1") return { ok: false, error: "no terminal emulator found on this host (set BUTCHR_TERMINAL, e.g. \"alacritty -e\")" };
  if (pane === "KAN-NO-DISPLAY:p1") return { ok: false, error: "this daemon's own process has neither DISPLAY nor WAYLAND_DISPLAY set, so it cannot launch a terminal window itself — if this host does have a display, set DISPLAY (or WAYLAND_DISPLAY) in the daemon's own environment (e.g. its systemd unit) and restart it" };
  if (pane !== "w1:p3") return { ok: false, error: `no such live pane: ${pane} (not one of this daemon's own running agents)` };
  return { ok: true };
};
const view = {
  state: async () => [{ issue: "KAN-9", status: "working", summary: "do a thing" }],
  open: async (issue: string) => { opened.push(issue); return issue === "KAN-BAD" ? { ok: false, error: "nope" } : { ok: true }; },
  openPane,
  health: () => healthy,
  dashboard: noDashboard,
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

// BUTCHR-269: /dashboard is a POLL-FED SNAPSHOT — the route does no I/O of
// its own, it just returns whatever `dashboard()` currently resolves to.
// Every test below simulates the real production shape (src/daemon/
// index.ts's `agentStatuses` tee): a mutable `snapshot` variable that only a
// simulated POLL (never a request) ever reassigns, with `dashboard: async
// () => snapshot` as the ONLY thing the route touches — so "does confirmedAt
// advance" is a direct, faithful test of the request-vs-poll distinction,
// not an artifact of a fixture that fakes freshness some other way.
describe("GET /dashboard (BUTCHR-269): poll-fed snapshot, no I/O on the request path", () => {
  test("smoke: the shared fixture app's /dashboard reflects its dashboard() fixture verbatim", async () => {
    expect(await (await fetch(`${base}/dashboard`)).json()).toEqual({ checked: true, confirmedAt: new Date(0).toISOString(), rows: [] });
  });

  test("a bare re-request does NOT advance confirmedAt (row-level or response-level) — only a new poll does", async () => {
    let snapshot: DashboardResponse = {
      checked: true,
      confirmedAt: new Date(1000).toISOString(),
      rows: [{ kind: "agent", resourceKey: "BUTCHR-1", tier: { kind: "issue", issuetype: { checked: true, value: "Task" } }, agentStatus: "working", pane: "p1", timeInStatus: { sinceMs: 0, since: new Date(0).toISOString(), humanDuration: "0s", exact: true }, confirmedAt: new Date(1000).toISOString() }],
    };
    const { app } = buildApp({ state: async () => [], open: async () => ({ ok: true }), openPane: async () => ({ ok: true }), health: () => healthy, dashboard: async () => snapshot });
    app.listen(0);
    try {
      const b = `http://localhost:${app.server!.port}`;
      const first = (await (await fetch(`${b}/dashboard`)).json()) as DashboardResponse;
      const second = (await (await fetch(`${b}/dashboard`)).json()) as DashboardResponse; // repeated request, no poll in between
      expect(first).toEqual(second);
      if (!first.checked || !second.checked) throw new Error("expected checked:true");
      expect(second.rows[0]!.confirmedAt).toBe(first.rows[0]!.confirmedAt);
      expect(second.confirmedAt).toBe(first.confirmedAt);

      // Now simulate a poll: the daemon's own tee reassigns `snapshot`, never the route.
      snapshot = { checked: true, confirmedAt: new Date(2000).toISOString(), rows: [{ ...snapshot.rows[0]!, confirmedAt: new Date(2000).toISOString() }] };
      const third = (await (await fetch(`${b}/dashboard`)).json()) as DashboardResponse;
      if (!third.checked) throw new Error("expected checked:true");
      expect(third.rows[0]!.confirmedAt).not.toBe(first.rows[0]!.confirmedAt);
      expect(third.rows[0]!.confirmedAt).toBe(new Date(2000).toISOString());
      expect(third.confirmedAt).not.toBe(first.confirmedAt);
      expect(third.confirmedAt).toBe(new Date(2000).toISOString());
    } finally {
      app.stop();
    }
  });

  test("could-not-check (case 1: the agent.list() read itself fails) is distinguishable from a genuinely empty fleet — never {checked:true, rows:[]}", async () => {
    // A genuine finding: the poll succeeded and there really are no agents.
    const genuinelyEmpty: DashboardResponse = { checked: true, confirmedAt: new Date(4000).toISOString(), rows: [] };
    // A declined poll: the whole-response shape carries checked:false and a
    // declinedAt, distinct at the type level from the empty-but-checked case
    // above — this is the assertion that fails if the two were ever
    // collapsed (e.g. both serializing to `{rows: []}` with `checked`
    // dropped, or a declined poll silently reusing `checked:true`).
    const declined: DashboardResponse = { checked: false, declinedAt: new Date(5000).toISOString(), rows: [] };

    let snapshot: DashboardResponse = genuinelyEmpty;
    const { app } = buildApp({ state: async () => [], open: async () => ({ ok: true }), openPane: async () => ({ ok: true }), health: () => healthy, dashboard: async () => snapshot });
    app.listen(0);
    try {
      const b = `http://localhost:${app.server!.port}`;
      const emptyBody = (await (await fetch(`${b}/dashboard`)).json()) as DashboardResponse;
      expect(emptyBody.checked).toBe(true);
      expect("declinedAt" in emptyBody).toBe(false);

      snapshot = declined;
      const declinedBody = (await (await fetch(`${b}/dashboard`)).json()) as DashboardResponse;
      expect(declinedBody.checked).toBe(false);
      if (declinedBody.checked) throw new Error("expected checked:false");
      expect(declinedBody.declinedAt).toBe(new Date(5000).toISOString());

      // THE DISTINCTION ITSELF: the two bodies must not be equal, and a
      // caller doing `x.checked === true` must see them differently.
      expect(emptyBody).not.toEqual(declinedBody);
    } finally {
      app.stop();
    }
  });

  test("a declined poll preserves the PRIOR successful snapshot's rows (stale, honestly labeled) rather than discarding them or re-serving them as fresh", async () => {
    const staleRow = { kind: "agent" as const, resourceKey: "BUTCHR-2", tier: { kind: "project" as const }, agentStatus: "idle", pane: "p2", timeInStatus: { sinceMs: 0, since: new Date(0).toISOString(), humanDuration: "0s", exact: false }, confirmedAt: new Date(1000).toISOString() };
    let snapshot: DashboardResponse = { checked: true, confirmedAt: new Date(1000).toISOString(), rows: [staleRow] };
    const { app } = buildApp({ state: async () => [], open: async () => ({ ok: true }), openPane: async () => ({ ok: true }), health: () => healthy, dashboard: async () => snapshot });
    app.listen(0);
    try {
      const b = `http://localhost:${app.server!.port}`;
      // Simulate the poll-side decline: the caller (src/daemon/index.ts's
      // own tee) carries `rows` forward unchanged, only flipping the
      // top-level checked/declinedAt — this test pins that CHOICE, not just
      // that a value exists.
      snapshot = { checked: false, declinedAt: new Date(9000).toISOString(), rows: snapshot.rows };
      const body = (await (await fetch(`${b}/dashboard`)).json()) as DashboardResponse;
      expect(body.checked).toBe(false);
      expect(body.rows).toEqual([staleRow]);
      expect(body.rows[0]!.confirmedAt).toBe(new Date(1000).toISOString()); // NOT laundered to look fresh
    } finally {
      app.stop();
    }
  });
});

// BUTCHR-267: the dashboard row's pane-keyed terminal-attach link — an
// ordinary GET a person can click (unlike the issue-keyed POST above, which
// is `fetch()`-driven and never reachable via `<a href>`). Criterion 8 wants
// the happy path, an unknown pane and no-emulator-configured, each asserted
// on the specific human-readable text (criterion 5) rather than just the
// status code.
describe("GET /agents/pane/:pane/attach — the dashboard link target (BUTCHR-267)", () => {
  test("a live pane launches and reports what actually happened, in plain text", async () => {
    const r = await fetch(`${base}/agents/pane/${encodeURIComponent("w1:p3")}/attach`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/plain");
    const body = await r.text();
    // Criterion 6: never claims a window appeared — only that launching it
    // was attempted, since the spawn is fire-and-forget.
    expect(body).toContain("w1:p3");
    expect(body).not.toMatch(/window (appeared|opened)/);
    expect(openedPanes).toContain("w1:p3");
  });
  test("a colon-bearing pane id survives the route unmangled — criterion 1", async () => {
    // Exercised again here, raw (unencoded) in the URL, since colon is a
    // legal pchar and a dashboard link need not necessarily percent-encode it.
    const r = await fetch(`${base}/agents/pane/w1:p3/attach`);
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("w1:p3");
  });
  test("an unknown pane is refused with the specific reason, not a generic failure", async () => {
    const r = await fetch(`${base}/agents/pane/${encodeURIComponent("nope:p9")}/attach`);
    expect(r.status).toBe(409);
    expect(r.headers.get("content-type")).toContain("text/plain");
    const body = await r.text();
    expect(body).toContain("no such live pane");
    expect(body).toContain("nope:p9");
  });
  test("no terminal emulator configured is refused with ITS OWN specific reason, distinct from unknown-pane", async () => {
    const r = await fetch(`${base}/agents/pane/${encodeURIComponent("KAN-NO-TERM:p1")}/attach`);
    expect(r.status).toBe(409);
    const body = await r.text();
    expect(body).toContain("no terminal emulator found");
    expect(body).toContain("BUTCHR_TERMINAL");
    expect(body).not.toContain("no such live pane");
  });
  // BUTCHR-267 [correction]: on at least one real daemon this is the ONLY
  // branch that ever runs (no DISPLAY/WAYLAND_DISPLAY in the daemon's own
  // process, while a terminal emulator IS on PATH) — not an exotic edge case,
  // so it needs the same end-to-end coverage as the other two refusals, and
  // its wording must be scoped to what was measured (this process's env) and
  // actionable, not a flat unscoped claim about the host.
  test("no display to reach is refused with ITS OWN specific, scoped, actionable reason", async () => {
    const r = await fetch(`${base}/agents/pane/${encodeURIComponent("KAN-NO-DISPLAY:p1")}/attach`);
    expect(r.status).toBe(409);
    const body = await r.text();
    expect(body).toContain("DISPLAY");
    expect(body).toContain("WAYLAND_DISPLAY");
    expect(body).toContain("own process");
    expect(body.toLowerCase()).toContain("systemd unit");
    expect(body).not.toContain("no such live pane");
    expect(body).not.toContain("no terminal emulator found");
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
      openPane: async () => ({ ok: true }),
      health: () => health.status(),
      dashboard: noDashboard,
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
      openPane: async () => ({ ok: true }),
      health: () => combineHealth([pollHealth, notifyHealth]),
      dashboard: noDashboard,
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
      openPane: async () => ({ ok: true }),
      health: () => combineHealth([health], build),
      dashboard: noDashboard,
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
      openPane: async () => ({ ok: true }),
      health: () => combineHealth([health]),
      dashboard: noDashboard,
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

// BUTCHR-179: /health carries per-detector "could not check" coverage as a
// SECOND sibling, alongside build (BUTCHR-54) — never inside components[],
// and never able to flip `ok`, for the same reason build can't: a detector
// declining to verify one ticket (a transient Atlassian fetch failure) does
// not mean the DAEMON itself is unhealthy. Driven through the real
// production composition (combineHealth + buildApp + a real listening
// server), same as the build-identity tests above.
describe("/health carries detector coverage as a sibling of components, and never flips ok (BUTCHR-179)", () => {
  test("combineHealth's optional coverage param round-trips through the real /health endpoint", async () => {
    const health = createLoopHealth({ name: "pollLoop", thresholdMs: 60_000 });
    health.recordSuccess();
    const coverage = createCoverageTracker(() => 1_700_000_000_000);
    coverage.recordChecked("stalled");
    coverage.recordChecked("stalled");
    coverage.recordDeclined("escalation:unresponsive");
    const { app, mcp } = buildApp({
      state: async () => [],
      open: async () => ({ ok: true }),
      openPane: async () => ({ ok: true }),
      health: () => combineHealth([health], undefined, coverage.snapshot()),
      dashboard: noDashboard,
    });
    app.listen(0);
    try {
      const res = await fetch(`http://localhost:${app.server!.port}/health`);
      const body = (await res.json()) as HealthStatus;
      expect(body.coverage).toEqual([
        { name: "stalled", checkedCount: 2, declinedCount: 0, lastDeclinedAt: null },
        { name: "escalation:unresponsive", checkedCount: 0, declinedCount: 1, lastDeclinedAt: new Date(1_700_000_000_000).toISOString() },
      ]);
      // Never folded into components[] — components stays exactly the liveness list.
      expect(body.components).toEqual([expect.objectContaining({ name: "pollLoop" })]);
      expect(body.components.some((c) => "checkedCount" in c || "declinedCount" in c)).toBe(false);
      // A detector declining for one ticket is not thereby a daemon liveness
      // failure: `ok` here reflects pollLoop's own state (fresh — recordSuccess
      // was called), completely independent of the coverage snapshot's
      // decline count.
      expect(body.ok).toBe(true);
    } finally {
      health.stop();
      await mcp.closeAll();
      app.stop();
    }
  });

  test("a coverage snapshot full of declines still leaves ok true when every component is healthy — declining never fails closed the OTHER way", async () => {
    const health = createLoopHealth({ name: "pollLoop", thresholdMs: 60_000 });
    health.recordSuccess();
    const coverage = createCoverageTracker();
    for (let i = 0; i < 5; i++) coverage.recordDeclined("stalled");
    const { app, mcp } = buildApp({
      state: async () => [],
      open: async () => ({ ok: true }),
      openPane: async () => ({ ok: true }),
      health: () => combineHealth([health], undefined, coverage.snapshot()),
      dashboard: noDashboard,
    });
    app.listen(0);
    try {
      const body = (await (await fetch(`http://localhost:${app.server!.port}/health`)).json()) as HealthStatus;
      expect(body.coverage).toEqual([{ name: "stalled", checkedCount: 0, declinedCount: 5, lastDeclinedAt: expect.any(String) }]);
      expect(body.ok).toBe(true);
    } finally {
      health.stop();
      await mcp.closeAll();
      app.stop();
    }
  });

  test("omitting coverage (existing callers, e.g. every fixture above) leaves it absent from the response — fully backward compatible", async () => {
    const health = createLoopHealth({ name: "pollLoop", thresholdMs: 60_000 });
    health.recordSuccess();
    const { app, mcp } = buildApp({
      state: async () => [],
      open: async () => ({ ok: true }),
      openPane: async () => ({ ok: true }),
      health: () => combineHealth([health]),
      dashboard: noDashboard,
    });
    app.listen(0);
    try {
      const body = (await (await fetch(`http://localhost:${app.server!.port}/health`)).json()) as HealthStatus;
      expect(body.coverage).toBeUndefined();
      expect(body.ok).toBe(true);
    } finally {
      health.stop();
      await mcp.closeAll();
      app.stop();
    }
  });
});

// BUTCHR-284: /health carries the admission cap and current residency as a
// THIRD sibling — never inside components[], and never able to flip `ok`:
// sitting AT the cap is a normal, healthy state. Driven through the real
// production composition (combineHealth + buildApp + a real listening
// server), same as the build-identity/coverage tests above.
describe("/health carries the admission cap + residency as a sibling of components, and never flips ok (BUTCHR-284)", () => {
  test("combineHealth's optional admission param round-trips through the real /health endpoint", async () => {
    const health = createLoopHealth({ name: "pollLoop", thresholdMs: 60_000 });
    health.recordSuccess();
    const admission = createAdmissionController({ cap: 8, residency: async () => ["A", "B", "C"] });
    await admission.admit([], []); // establishes a trusted residency reading
    const { app, mcp } = buildApp({
      state: async () => [],
      open: async () => ({ ok: true }),
      // BUTCHR-265: `openPane` is required on ViewDeps since BUTCHR-267; these
      // BUTCHR-284 fixtures arrived on main after that change and never exercise it.
      openPane: async () => ({ ok: true }),
      dashboard: noDashboard,
      health: () => combineHealth([health], undefined, undefined, admission.snapshot()),
    });
    app.listen(0);
    try {
      const res = await fetch(`http://localhost:${app.server!.port}/health`);
      const body = (await res.json()) as HealthStatus;
      expect(body.admission).toEqual({ cap: 8, residency: 3 });
      // Never folded into components[] — components stays exactly the liveness list.
      expect(body.components).toEqual([expect.objectContaining({ name: "pollLoop" })]);
      expect(body.components.some((c) => "cap" in c || "residency" in c)).toBe(false);
      // Being at the cap is healthy: `ok` reflects pollLoop's own state only.
      expect(body.ok).toBe(true);
    } finally {
      health.stop();
      await mcp.closeAll();
      app.stop();
    }
  });

  test("residency is null before any trusted census has ever run", async () => {
    const health = createLoopHealth({ name: "pollLoop", thresholdMs: 60_000 });
    health.recordSuccess();
    const admission = createAdmissionController({ cap: 8, residency: async () => { throw new Error("never called yet"); } });
    const { app, mcp } = buildApp({
      state: async () => [],
      open: async () => ({ ok: true }),
      // BUTCHR-265: `openPane` is required on ViewDeps since BUTCHR-267; these
      // BUTCHR-284 fixtures arrived on main after that change and never exercise it.
      openPane: async () => ({ ok: true }),
      dashboard: noDashboard,
      health: () => combineHealth([health], undefined, undefined, admission.snapshot()),
    });
    app.listen(0);
    try {
      const body = (await (await fetch(`http://localhost:${app.server!.port}/health`)).json()) as HealthStatus;
      expect(body.admission).toEqual({ cap: 8, residency: null });
    } finally {
      health.stop();
      await mcp.closeAll();
      app.stop();
    }
  });

  test("omitting admission (existing callers, e.g. every fixture above) leaves it absent from the response — fully backward compatible", async () => {
    const health = createLoopHealth({ name: "pollLoop", thresholdMs: 60_000 });
    health.recordSuccess();
    const { app, mcp } = buildApp({
      state: async () => [],
      open: async () => ({ ok: true }),
      // BUTCHR-265: `openPane` is required on ViewDeps since BUTCHR-267; these
      // BUTCHR-284 fixtures arrived on main after that change and never exercise it.
      openPane: async () => ({ ok: true }),
      dashboard: noDashboard,
      health: () => combineHealth([health]),
    });
    app.listen(0);
    try {
      const body = (await (await fetch(`http://localhost:${app.server!.port}/health`)).json()) as HealthStatus;
      expect(body.admission).toBeUndefined();
      expect(body.ok).toBe(true);
    } finally {
      health.stop();
      await mcp.closeAll();
      app.stop();
    }
  });
});
