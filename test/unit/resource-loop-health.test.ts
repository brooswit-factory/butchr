import { describe, expect, test } from "bun:test";
import { combineHealth, createLoopHealth, createResourceLoopHealth } from "../../src/daemon/health.js";

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
});
