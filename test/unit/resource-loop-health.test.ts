import { describe, expect, test } from "bun:test";
import { combineHealth, createLoopHealth, createResourceLoopHealth, createTickHealth } from "../../src/daemon/health.js";

describe("resource loop health", () => {
  test("starting, then failing past the threshold, then recovering", () => {
    let t = 0;
    const h = createResourceLoopHealth({ name: "github-issue", enabled: true, thresholdMs: 1_000, now: () => t, checkIntervalMs: 1e9 });
    expect(h.report()).toEqual({ name: "github-issue", ok: false, state: "starting", lastSuccessAt: null, staleForMs: 0, enabled: true, consecutiveFailures: 0, lastError: null });

    t = 500; h.recordError(new Error("GitHub 401"));
    t = 1_500; h.recordError("rate limited");
    expect(h.report()).toMatchObject({ ok: false, state: "stale", staleForMs: 1_500, consecutiveFailures: 2, lastError: { at: new Date(1_500).toISOString(), message: "rate limited" } });

    t = 2_000; h.recordSuccess();
    expect(h.report()).toMatchObject({ ok: true, state: "ok", lastSuccessAt: new Date(2_000).toISOString(), consecutiveFailures: 0, lastError: { message: "rate limited" } });
    h.stop();
  });

  test("a disabled type says why", () => {
    const h = createResourceLoopHealth({ name: "jira-idea", enabled: false, disabledReason: "no enabled jira-idea rules", thresholdMs: 1_000, checkIntervalMs: 1e9 });
    expect(h.report()).toMatchObject({ name: "jira-idea", enabled: false, disabledReason: "no enabled jira-idea rules" });
    h.stop();
  });

  test("/health reports resource loops beside the liveness components without changing ok", () => {
    let t = 0;
    const poll = createLoopHealth({ name: "pollLoop", thresholdMs: 1_000, now: () => t, checkIntervalMs: 1e9 });
    const gh = createResourceLoopHealth({ name: "github-issue", enabled: true, thresholdMs: 1_000, now: () => t, checkIntervalMs: 1e9 });
    t = 5_000; poll.recordSuccess(); gh.recordError(new Error("GitHub 401"));
    const health = combineHealth([poll], undefined, undefined, undefined, undefined, [gh]);
    expect(health.ok).toBe(true);
    expect(health.components.map((c) => c.name)).toEqual(["pollLoop"]);
    expect(health.resourceLoops).toEqual([expect.objectContaining({ name: "github-issue", ok: false, state: "stale", consecutiveFailures: 1 })]);
    expect("resourceLoops" in combineHealth([poll])).toBe(false);
    poll.stop(); gh.stop();
  });

  test("BUTCHR-405: unresolvedRelationships rides beside the liveness components, absent when empty", () => {
    let t = 0;
    const poll = createLoopHealth({ name: "pollLoop", thresholdMs: 1_000, now: () => t, checkIntervalMs: 1e9 });
    t = 5_000; poll.recordSuccess();
    const unresolved = [{ ruleId: "task", field: "childRule" as const, missingTarget: "story" }];

    expect(combineHealth([poll], undefined, undefined, undefined, undefined, undefined, unresolved).unresolvedRelationships).toEqual(unresolved);
    expect("unresolvedRelationships" in combineHealth([poll], undefined, undefined, undefined, undefined, undefined, [])).toBe(false);
    expect("unresolvedRelationships" in combineHealth([poll])).toBe(false);
    poll.stop();
  });

  test("FACTORY-45: managedSessionEscalations rides beside the liveness components, absent when empty, and never flips ok", () => {
    let t = 0;
    const poll = createLoopHealth({ name: "pollLoop", thresholdMs: 1_000, now: () => t, checkIntervalMs: 1e9 });
    t = 5_000; poll.recordSuccess();
    const escalations = [{ agentKey: "filesystem:managed-sessions:%2Ffoo.json", definitionPath: "/foo.json", paneId: "p1", fingerprint: "abc12345", since: new Date(5_000).toISOString() }];

    const withEscalations = combineHealth([poll], undefined, undefined, undefined, undefined, undefined, undefined, escalations);
    expect(withEscalations.managedSessionEscalations).toEqual(escalations);
    expect(withEscalations.ok).toBe(true); // a stalled managed session is a real problem, never a liveness failure
    expect("managedSessionEscalations" in combineHealth([poll], undefined, undefined, undefined, undefined, undefined, undefined, [])).toBe(false);
    expect("managedSessionEscalations" in combineHealth([poll])).toBe(false);
    poll.stop();
  });

  test("FACTORY-752: a completed tick with nothing eligible advances lastSuccessAt — the exact blindness the new field exists to remove", () => {
    let t = 0;
    const h = createTickHealth({ name: "permissionAnswer", thresholdMs: 1_000, now: () => t, checkIntervalMs: 1e9 });
    // PRE-FIX CONTRAST: before any recordSuccess, the component is indistinguishable
    // from "never ticked at all" — this is the exact shape the 10-08 incident's
    // own silence had (an idle tick that updates nothing looks identical to a
    // tick that never ran).
    expect(h.status().components[0]).toMatchObject({ state: "starting", lastSuccessAt: null });

    t = 100;
    h.recordSuccess(); // an idle tick: nothing eligible, but the tick itself completed
    expect(h.status().components[0]).toMatchObject({ ok: true, state: "ok", lastSuccessAt: new Date(100).toISOString(), staleForMs: 0, consecutiveFailures: 0, lastErrorAt: null });

    t = 2_000; // past thresholdMs with no further tick at all — genuinely stale, correctly flips ok false
    expect(h.status().components[0]).toMatchObject({ ok: false, state: "stale" });
    h.stop();
  });

  test("FACTORY-752: a rejected tick is reported distinguishably from a succeeded one, via lastErrorAt/consecutiveFailures, without itself advancing lastSuccessAt", () => {
    let t = 0;
    const h = createTickHealth({ name: "permissionAnswer", thresholdMs: 1_000, now: () => t, checkIntervalMs: 1e9 });

    t = 100; h.recordError(new Error("cannot connect"));
    expect(h.status().components[0]).toMatchObject({ lastSuccessAt: null, lastErrorAt: new Date(100).toISOString(), consecutiveFailures: 1 });

    t = 200; h.recordError(new Error("cannot connect"));
    expect(h.status().components[0]).toMatchObject({ lastErrorAt: new Date(200).toISOString(), consecutiveFailures: 2 });

    t = 300; h.recordSuccess();
    expect(h.status().components[0]).toMatchObject({ ok: true, lastSuccessAt: new Date(300).toISOString(), consecutiveFailures: 0, lastErrorAt: new Date(200).toISOString() });
    h.stop();
  });

  test("FACTORY-752: permissionAnswer rides INSIDE components[] (the liveness AND), not beside it — a stale tick DOES flip ok false, unlike a resourceLoops sibling", () => {
    let t = 0;
    const poll = createLoopHealth({ name: "pollLoop", thresholdMs: 1_000, now: () => t, checkIntervalMs: 1e9 });
    const permissionAnswer = createTickHealth({ name: "permissionAnswer", thresholdMs: 1_000, now: () => t, checkIntervalMs: 1e9 });
    t = 100; poll.recordSuccess(); permissionAnswer.recordSuccess();
    t = 2_000; // only poll ticks again; permissionAnswer goes stale
    poll.recordSuccess();

    const health = combineHealth([poll, permissionAnswer]);
    expect(health.components.map((c) => c.name)).toEqual(["pollLoop", "permissionAnswer"]);
    expect(health.ok).toBe(false); // the stale permissionAnswer component drags the whole AND down
    poll.stop(); permissionAnswer.stop();
  });

  test("FACTORY-647: dashboardApp rides beside the liveness components, absent when not passed, and never flips ok", () => {
    let t = 0;
    const poll = createLoopHealth({ name: "pollLoop", thresholdMs: 1_000, now: () => t, checkIntervalMs: 1e9 });
    t = 5_000; poll.recordSuccess();
    const dashboardApp = { built: false, path: "/some/dist/web/index.html" };

    const withDashboardApp = combineHealth([poll], undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, dashboardApp);
    expect(withDashboardApp.dashboardApp).toEqual(dashboardApp);
    expect(withDashboardApp.ok).toBe(true); // a missing web build is a deploy gap, never a liveness failure
    expect("dashboardApp" in combineHealth([poll])).toBe(false);
    poll.stop();
  });
});
