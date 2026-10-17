import { describe, expect, test } from "bun:test";
import type { JiraIssue } from "../../src/atlassian/types.js";
import { parseRules, type Rule } from "../../src/rules/rules.js";
import type { NotifyReason } from "../../src/resources/types.js";
import { createLinkedEventingState, type LinkedEventingDeps, type LinkedEventingMatch, type ProjectLinkedEventingMatch } from "../../src/jira-watch/linked-eventing.js";

const rule = (over: Partial<Record<string, unknown>> = {}): Rule =>
  parseRules({ rules: [{ id: "task", resourceProvider: "jira-work", query: "q", brief: "do it", linkedEventing: true, ...over }] })[0]!;

const issue = (key: string, over: Partial<JiraIssue> = {}): JiraIssue => ({
  key, status: "To Do", summary: `summary of ${key}`, issuetype: "Task", assignee: null, parent: null,
  updated: "2026-09-16T00:00:00.000+0000", labels: [], ...over,
});

const match = (agentKey: string, r: Rule, i: JiraIssue): LinkedEventingMatch => ({ agentKey, rule: r, issue: i });

/** A fully controllable fake of `LinkedEventingDeps.push` — the daemon's push controller's read-only query surface. */
function fakePush(opts: { providers?: Array<"jira" | "github">; covering?: boolean; ttlMs?: number; debounceMs?: number } = {}) {
  const state = {
    providers: new Set(opts.providers ?? ["jira", "github"]),
    covering: opts.covering ?? true,
    ttlMs: opts.ttlMs ?? 600_000,
    debounceMs: opts.debounceMs ?? 0,
  };
  const push: LinkedEventingDeps["push"] = {
    isProviderEnabled: (p) => state.providers.has(p),
    isCoveringNow: () => state.covering,
    ttlMsFor: () => state.ttlMs,
    debounceMs: () => state.debounceMs,
  };
  return { push, state };
}

/** A fake timer pair so runDirtyPass's debounce is deterministic — fires immediately since every test below uses debounceMs: 0 unless testing the debounce itself. */
function fakeTimers() {
  const scheduled: Array<{ fn: () => void }> = [];
  return {
    setTimeout: (fn: () => void, _ms: number): number => { scheduled.push({ fn }); return scheduled.length; },
    clearTimeout: (_handle: unknown): void => {},
    fireAll(): void { const pending = [...scheduled]; scheduled.length = 0; for (const s of pending) s.fn(); },
  };
}

function fakeDeps(world: Record<string, JiraIssue>, opts: { now?: { value: number }; push?: LinkedEventingDeps["push"]; timers?: ReturnType<typeof fakeTimers> } = {}) {
  const notified: Array<{ agent: string; about: string; reason: NotifyReason }> = [];
  const searchCalls: string[] = [];
  const logs: string[] = [];
  const deps: LinkedEventingDeps = {
    search: async (jql) => {
      searchCalls.push(jql);
      const m = /^key in \((.*)\)$/.exec(jql);
      const keys = m ? m[1]!.split(",") : [];
      return keys.map((k) => world[k]).filter((i): i is JiraIssue => Boolean(i));
    },
    notify: async (agent, about, reason) => { notified.push({ agent, about, reason }); },
    log: (l) => logs.push(l),
    ...(opts.now ? { now: () => opts.now!.value } : {}),
    ...(opts.push ? { push: opts.push } : {}),
    ...(opts.timers ? { setTimeout: (fn, ms) => opts.timers!.setTimeout(fn, ms), clearTimeout: (h) => opts.timers!.clearTimeout(h) } : {}),
  };
  return { deps, notified, searchCalls, logs };
}

describe("FACTORY-137 D2: coverage skip — a clean covered target is not fetched at all", () => {
  test("mapped + provider enabled + covering -> a clean target is skipped on the next regular tick (T1: no diff, no unreadable, no baseline change)", async () => {
    const owner = issue("BUTCHR-1", { issuelinks: [{ type: "Blocks", otherEnd: "outward", key: "BUTCHR-2" }] as never });
    const world: Record<string, JiraIssue> = { "BUTCHR-2": issue("BUTCHR-2") };
    const state = createLinkedEventingState();
    const { push } = fakePush();
    const { deps, notified, searchCalls } = fakeDeps(world, { push });
    const m = match("jira-work:task:BUTCHR-1", rule(), owner);

    await state.runTick([m], deps); // seed the baseline
    expect(searchCalls).toEqual(["key in (BUTCHR-2)"]);

    await state.runTick([m], deps); // still clean -> should be SKIPPED, not re-fetched
    expect(searchCalls).toHaveLength(1); // no second search call
    expect(notified).toHaveLength(0);
  });

  test("a real change is still detected once it becomes dirty, and delivers the SAME event shape polling would produce", async () => {
    const owner = issue("BUTCHR-1", { issuelinks: [{ type: "Blocks", otherEnd: "outward", key: "BUTCHR-2" }] as never });
    const world: Record<string, JiraIssue> = { "BUTCHR-2": issue("BUTCHR-2", { status: "To Do" }) };
    const state = createLinkedEventingState();
    const { push } = fakePush();
    const { deps, notified } = fakeDeps(world, { push });
    const m = match("jira-work:task:BUTCHR-1", rule(), owner);

    await state.runTick([m], deps); // seed
    state.markDirty("jira:BUTCHR-2");
    world["BUTCHR-2"] = issue("BUTCHR-2", { status: "In Progress" });
    await state.runTick([m], deps);
    expect(notified).toHaveLength(1);
    const reason = notified[0]!.reason as { linked: { events: readonly { target: string; kind: string; detail: string }[] } };
    // FACTORY-833 (review round 1, PR #800, replayed onto main): changeDetail
    // now appends "(as of <observedAt.statusAt>)" to a status transition's
    // detail text — see that function's own doc comment for why (a rate-capped
    // transition must not inherit a later, unrelated edit's own `updated`
    // time). The timestamp here is the fixed `updated` this suite's `issue()`
    // helper defaults to, since `world["BUTCHR-2"]`'s only edit in this test
    // is the status change itself.
    expect(reason.linked.events).toEqual([{ target: "BUTCHR-2", kind: "issuelink", detail: 'status changed from "To Do" to "In Progress" (as of 2026-09-16T00:00:00.000+0000)' }]);
  });

  test("provider disabled -> uncovered, unchanged polling every tick", async () => {
    const owner = issue("BUTCHR-1", { issuelinks: [{ type: "Blocks", otherEnd: "outward", key: "BUTCHR-2" }] as never });
    const world: Record<string, JiraIssue> = { "BUTCHR-2": issue("BUTCHR-2") };
    const state = createLinkedEventingState();
    const { push } = fakePush({ providers: ["github"] }); // jira NOT enabled
    const { deps, searchCalls } = fakeDeps(world, { push });
    const m = match("jira-work:task:BUTCHR-1", rule(), owner);

    await state.runTick([m], deps);
    await state.runTick([m], deps);
    expect(searchCalls).toHaveLength(2); // every tick, unchanged from pre-FACTORY-137 behaviour
  });

  test("not covering (client disconnected) -> uncovered, unchanged polling", async () => {
    const owner = issue("BUTCHR-1", { issuelinks: [{ type: "Blocks", otherEnd: "outward", key: "BUTCHR-2" }] as never });
    const world: Record<string, JiraIssue> = { "BUTCHR-2": issue("BUTCHR-2") };
    const state = createLinkedEventingState();
    const { push, state: pushState } = fakePush();
    pushState.covering = false;
    const { deps, searchCalls } = fakeDeps(world, { push });
    const m = match("jira-work:task:BUTCHR-1", rule(), owner);

    await state.runTick([m], deps);
    await state.runTick([m], deps);
    expect(searchCalls).toHaveLength(2);
  });

  test("first sighting (no baseline yet) is always fetched even when covered", async () => {
    const owner = issue("BUTCHR-1", { issuelinks: [{ type: "Blocks", otherEnd: "outward", key: "BUTCHR-2" }] as never });
    const world: Record<string, JiraIssue> = { "BUTCHR-2": issue("BUTCHR-2") };
    const state = createLinkedEventingState();
    const { push } = fakePush();
    const { deps, searchCalls } = fakeDeps(world, { push });
    const m = match("jira-work:task:BUTCHR-1", rule(), owner);
    await state.runTick([m], deps);
    expect(searchCalls).toEqual(["key in (BUTCHR-2)"]);
  });

  test("T1: a covered, clean, skipped target does not become 'unreadable' even though it is absent from this pass's fetch", async () => {
    const owner = issue("BUTCHR-1", { issuelinks: [{ type: "Blocks", otherEnd: "outward", key: "BUTCHR-2" }] as never });
    const world: Record<string, JiraIssue> = { "BUTCHR-2": issue("BUTCHR-2") };
    const state = createLinkedEventingState();
    const { push } = fakePush();
    const { deps, notified } = fakeDeps(world, { push });
    const m = match("jira-work:task:BUTCHR-1", rule(), owner);
    await state.runTick([m], deps); // seed
    await state.runTick([m], deps); // skipped
    await state.runTick([m], deps); // skipped again
    expect(notified).toHaveLength(0); // never an "unreadable" notification
  });

  test("AC1/C2 (review fix round 1): IDENTICAL before/after input through polling-only runTick and through push mode yields deep-equal notify payloads, and a clean covered target is confirmed not fetched by fetch count", async () => {
    // Two fully independent instances/worlds — the only thing shared is the
    // exact same owner shape and the exact same before -> after status
    // change, driven through each path separately.
    const buildOwnerAndWorld = (): { owner: JiraIssue; world: Record<string, JiraIssue> } => ({
      owner: issue("BUTCHR-1", { issuelinks: [{ type: "Blocks", otherEnd: "outward", key: "BUTCHR-2" }] as never }),
      world: { "BUTCHR-2": issue("BUTCHR-2", { status: "To Do" }) },
    });

    // (i) TODAY'S POLLING-ONLY PATH: no `push` dep at all (pre-FACTORY-137 — every existing caller/test's own shape).
    const pollState = createLinkedEventingState();
    const { owner: pollOwner, world: pollWorld } = buildOwnerAndWorld();
    const pollFixture = fakeDeps(pollWorld);
    const pollMatch = match("jira-work:task:BUTCHR-1", rule(), pollOwner);
    await pollState.runTick([pollMatch], pollFixture.deps); // seed
    pollWorld["BUTCHR-2"] = issue("BUTCHR-2", { status: "In Progress" });
    await pollState.runTick([pollMatch], pollFixture.deps); // polling always re-fetches and diffs

    // (ii) PUSH MODE: mapped + provider enabled + client live -> the SAME before/after state, delivered via markDirty instead of a blind re-fetch.
    const pushState = createLinkedEventingState();
    const { owner: pushOwner, world: pushWorld } = buildOwnerAndWorld();
    const { push } = fakePush();
    const pushFixture = fakeDeps(pushWorld, { push });
    const pushMatch = match("jira-work:task:BUTCHR-1", rule(), pushOwner);
    await pushState.runTick([pushMatch], pushFixture.deps); // seed
    pushState.markDirty("jira:BUTCHR-2");
    pushWorld["BUTCHR-2"] = issue("BUTCHR-2", { status: "In Progress" });
    await pushState.runTick([pushMatch], pushFixture.deps);

    expect(pollFixture.notified).toHaveLength(1);
    expect(pushFixture.notified).toHaveLength(1);
    // The ticket's own goal statement: "a consumer of a change event cannot
    // tell which mechanism produced it" — proven here by deep equality of
    // the ACTUAL `deps.notify` payload, not a hand-copied literal.
    expect(pushFixture.notified[0]!.reason).toEqual(pollFixture.notified[0]!.reason);
    expect(pushFixture.notified[0]!.agent).toEqual(pollFixture.notified[0]!.agent);
    expect(pushFixture.notified[0]!.about).toEqual(pollFixture.notified[0]!.about);

    // AC1's own fetch-count requirement: with the push-mode target now clean
    // again, the NEXT regular tick must perform NO additional fetch.
    const searchCallsBeforeCleanTick = pushFixture.searchCalls.length;
    await pushState.runTick([pushMatch], pushFixture.deps);
    expect(pushFixture.searchCalls).toHaveLength(searchCallsBeforeCleanTick);
  });
});

describe("FACTORY-137 D4: TTL authoritative refresh", () => {
  test("a covered target is not fetched between refreshes; at TTL expiry it is fetched, diffed, and the TTL resets to exactly one TTL later", async () => {
    const owner = issue("BUTCHR-1", { issuelinks: [{ type: "Blocks", otherEnd: "outward", key: "BUTCHR-2" }] as never });
    const world: Record<string, JiraIssue> = { "BUTCHR-2": issue("BUTCHR-2", { status: "To Do" }) };
    const state = createLinkedEventingState();
    const now = { value: 0 };
    const { push } = fakePush({ ttlMs: 1000 });
    const { deps, searchCalls, notified } = fakeDeps(world, { now, push });
    const m = match("jira-work:task:BUTCHR-1", rule(), owner);

    await state.runTick([m], deps); // seed, TTL clock starts at t=0
    now.value = 500;
    await state.runTick([m], deps); // within TTL -> skipped
    expect(searchCalls).toHaveLength(1);

    now.value = 999;
    await state.runTick([m], deps); // still within TTL
    expect(searchCalls).toHaveLength(1);

    now.value = 1000; // TTL expired
    world["BUTCHR-2"] = issue("BUTCHR-2", { status: "In Progress" }); // the stream "missed" this
    await state.runTick([m], deps);
    expect(searchCalls).toHaveLength(2);
    expect(notified).toHaveLength(1);
    expect(state.stats().ttlRefreshes).toBe(1);
    expect(state.stats().streamMissed).toBe(1);

    now.value = 1999;
    await state.runTick([m], deps); // TTL reset to now (1000) + 1000 = 2000, not yet due
    expect(searchCalls).toHaveLength(2);

    now.value = 2000;
    await state.runTick([m], deps); // exactly one TTL later
    expect(searchCalls).toHaveLength(3);
  });

  test("per-provider TTL override is honoured", async () => {
    const owner = issue("BUTCHR-1", { issuelinks: [{ type: "Blocks", otherEnd: "outward", key: "BUTCHR-2" }] as never });
    const world: Record<string, JiraIssue> = { "BUTCHR-2": issue("BUTCHR-2") };
    const state = createLinkedEventingState();
    const now = { value: 0 };
    const push: LinkedEventingDeps["push"] = {
      isProviderEnabled: () => true,
      isCoveringNow: () => true,
      ttlMsFor: (p) => (p === "jira" ? 100 : 999_999),
      debounceMs: () => 0,
    };
    const { deps, searchCalls } = fakeDeps(world, { now, push });
    const m = match("jira-work:task:BUTCHR-1", rule(), owner);
    await state.runTick([m], deps);
    now.value = 99;
    await state.runTick([m], deps);
    expect(searchCalls).toHaveLength(1);
    now.value = 100;
    await state.runTick([m], deps);
    expect(searchCalls).toHaveLength(2);
  });
});

describe("FACTORY-137 D5: resync-pending is sticky", () => {
  test("requestResync forces a fetch of every covered target on the next pass, then returns to skipping", async () => {
    const owner = issue("BUTCHR-1", { issuelinks: [{ type: "Blocks", otherEnd: "outward", key: "BUTCHR-2" }] as never });
    const world: Record<string, JiraIssue> = { "BUTCHR-2": issue("BUTCHR-2", { status: "To Do" }) };
    const state = createLinkedEventingState();
    const { push } = fakePush();
    const { deps, searchCalls } = fakeDeps(world, { push });
    const m = match("jira-work:task:BUTCHR-1", rule(), owner);
    await state.runTick([m], deps); // seed
    expect(searchCalls).toHaveLength(1);

    state.requestResync();
    await state.runTick([m], deps); // forced
    expect(searchCalls).toHaveLength(2);

    await state.runTick([m], deps); // resync consumed -> back to skipping
    expect(searchCalls).toHaveLength(2);
  });

  test("resyncPending is NOT consumed by a pass that runs while nothing is covered", async () => {
    const owner = issue("BUTCHR-1", { issuelinks: [{ type: "Blocks", otherEnd: "outward", key: "BUTCHR-2" }] as never });
    const world: Record<string, JiraIssue> = { "BUTCHR-2": issue("BUTCHR-2") };
    const state = createLinkedEventingState();
    const { push, state: pushState } = fakePush();
    const { deps, searchCalls } = fakeDeps(world, { push });
    const m = match("jira-work:task:BUTCHR-1", rule(), owner);
    await state.runTick([m], deps); // seed

    state.requestResync();
    pushState.covering = false; // connection drops before the forced pass runs
    await state.runTick([m], deps); // uncovered now -> always fetched anyway (T1/D2's "uncovered" branch), but resyncPending must stay sticky
    expect(searchCalls).toHaveLength(2); // fetched because uncovered, not because of resync

    pushState.covering = true;
    await state.runTick([m], deps); // resync still pending -> forced again
    expect(searchCalls).toHaveLength(3);
    await state.runTick([m], deps); // now consumed
    expect(searchCalls).toHaveLength(3);
  });
});

describe("FACTORY-137 D3/D6: on-demand pass via runDirtyPass", () => {
  test("markDirty + runDirtyPass delivers within one debounced pass, without waiting for the next regular tick", async () => {
    const owner = issue("BUTCHR-1", { issuelinks: [{ type: "Blocks", otherEnd: "outward", key: "BUTCHR-2" }] as never });
    const world: Record<string, JiraIssue> = { "BUTCHR-2": issue("BUTCHR-2", { status: "To Do" }) };
    const state = createLinkedEventingState();
    const { push } = fakePush({ debounceMs: 2000 });
    const timers = fakeTimers();
    const { deps, notified, searchCalls } = fakeDeps(world, { push, timers });
    const m = match("jira-work:task:BUTCHR-1", rule(), owner);
    await state.runTick([m], deps); // seed, and remember this tick's own inputs for the on-demand pass

    world["BUTCHR-2"] = issue("BUTCHR-2", { status: "In Progress" });
    state.markDirty("jira:BUTCHR-2");
    const pending = state.runDirtyPass();
    timers.fireAll(); // simulate the debounce window elapsing
    await pending;

    expect(searchCalls).toHaveLength(2); // seed + the on-demand pass's own forced fetch
    expect(notified).toHaveLength(1);
    expect(state.stats().onDemandPasses).toBe(1);
    expect(state.stats().dirtyMarks).toBe(1);
  });

  test("D6: repeated markDirty/runDirtyPass calls within the debounce window collapse into ONE pass", async () => {
    const owner = issue("BUTCHR-1", { issuelinks: [{ type: "Blocks", otherEnd: "outward", key: "BUTCHR-2" }] as never });
    const world: Record<string, JiraIssue> = { "BUTCHR-2": issue("BUTCHR-2") };
    const state = createLinkedEventingState();
    const { push } = fakePush({ debounceMs: 2000 });
    const timers = fakeTimers();
    const { deps, searchCalls } = fakeDeps(world, { push, timers });
    const m = match("jira-work:task:BUTCHR-1", rule(), owner);
    await state.runTick([m], deps);

    state.markDirty("jira:BUTCHR-2");
    const p1 = state.runDirtyPass();
    state.markDirty("jira:BUTCHR-2");
    const p2 = state.runDirtyPass(); // same debounce window -> same promise
    expect(p1).toBe(p2);
    timers.fireAll();
    await p1;
    expect(searchCalls).toHaveLength(2); // seed + exactly ONE on-demand pass
    expect(state.stats().onDemandPasses).toBe(1);
  });

  test("runDirtyPass before any runTick, or with nothing dirty, is a safe no-op", async () => {
    const state = createLinkedEventingState();
    await state.runDirtyPass(); // never ran a runTick — must not throw
    expect(state.stats().onDemandPasses).toBe(0);
  });

  test("D3: an on-demand pass does not re-run discovery — no remote-links call (local/ui: managed links are gone)", async () => {
    const owner = issue("BUTCHR-1", { issuelinks: [{ type: "Blocks", otherEnd: "outward", key: "BUTCHR-2" }] as never });
    const world: Record<string, JiraIssue> = { "BUTCHR-2": issue("BUTCHR-2", { status: "To Do" }) };
    const state = createLinkedEventingState();
    const { push } = fakePush({ debounceMs: 0 });
    let remoteLinksCalls = 0;
    const { deps, notified } = fakeDeps(world, { push });
    const m = match("jira-work:task:BUTCHR-1", rule({ linkedRemoteLinks: true }), owner);
    const depsWithRemote: LinkedEventingDeps = {
      ...deps,
      remoteLinks: async () => { remoteLinksCalls += 1; return []; },
    };
    await state.runTick([m], depsWithRemote);
    expect(remoteLinksCalls).toBe(1);

    world["BUTCHR-2"] = issue("BUTCHR-2", { status: "In Progress" });
    state.markDirty("jira:BUTCHR-2");
    await state.runDirtyPass();
    expect(notified).toHaveLength(1); // the change WAS delivered
    expect(remoteLinksCalls).toBe(1); // but no fresh discovery call was made
  });
});

describe("FACTORY-137 T3/T4: dirty generation and rate-cap interaction", () => {
  test("T3: a dirty mark that arrives again mid-fetch is not cleared by that fetch's own settle", async () => {
    const owner = issue("BUTCHR-1", { issuelinks: [{ type: "Blocks", otherEnd: "outward", key: "BUTCHR-2" }] as never });
    const world: Record<string, JiraIssue> = { "BUTCHR-2": issue("BUTCHR-2", { status: "To Do" }) };
    const state = createLinkedEventingState();
    const { push } = fakePush();
    let gate: Promise<void> | undefined;
    let releaseGate: (() => void) | undefined;
    const slowDeps: LinkedEventingDeps = {
      search: async (jql) => {
        if (gate) await gate;
        const m2 = /^key in \((.*)\)$/.exec(jql);
        const keys = m2 ? m2[1]!.split(",") : [];
        return keys.map((k) => world[k]).filter((i): i is JiraIssue => Boolean(i));
      },
      notify: async () => {},
    };
    const m = match("jira-work:task:BUTCHR-1", rule(), owner);
    // Seed with ordinary (non-gated) deps so the FIRST search isn't blocked.
    await state.runTick([m], { ...slowDeps, push });

    world["BUTCHR-2"] = issue("BUTCHR-2", { status: "In Progress" });
    state.markDirty("jira:BUTCHR-2");
    gate = new Promise<void>((resolve) => { releaseGate = resolve; });
    const passPromise = state.runDirtyPass();
    await Promise.resolve();
    await Promise.resolve(); // let the pass reach the now-gated search call
    state.markDirty("jira:BUTCHR-2"); // a NEW notification arrives while this fetch is in flight
    gate = undefined;
    releaseGate?.();
    await passPromise;

    // Still dirty (T3): the very next on-demand pass, with the gate open, must
    // still fetch — the earlier pass must not have cleared this mark.
    world["BUTCHR-2"] = issue("BUTCHR-2", { status: "Done" });
    const notifiedAfter: NotifyReason[] = [];
    const trackedDeps: LinkedEventingDeps = { ...slowDeps, push, notify: async (_a, _b, reason) => { notifiedAfter.push(reason); } };
    await state.runTick([m], trackedDeps); // regular tick's own deps become the new lastPassContext
    // The dirty mark from mid-fetch is still pending, so a follow-up on-demand
    // pass (using the just-updated context) must still deliver the latest change.
    await state.runDirtyPass();
    const delivered = notifiedAfter.some((r) => "linked" in r && r.linked.events.some((e) => e.detail.includes("Done")));
    expect(delivered).toBe(true);
  });

  test("T4: a rate-capped owner leaves its target dirty; the next allowed pass re-delivers", async () => {
    const owner = issue("BUTCHR-1", { issuelinks: [{ type: "Blocks", otherEnd: "outward", key: "BUTCHR-2" }] as never });
    const world: Record<string, JiraIssue> = { "BUTCHR-2": issue("BUTCHR-2", { status: "To Do" }) };
    const state = createLinkedEventingState();
    const now = { value: 0 };
    const { push } = fakePush();
    const { deps, notified } = fakeDeps(world, { now, push });
    const r = rule({ maxLinkedTurnsPerHour: 1 });
    const m = match("jira-work:task:BUTCHR-1", r, owner);
    await state.runTick([m], deps); // seed

    // Use up the one allowed turn this hour with an ordinary polled change.
    now.value = 1;
    state.markDirty("jira:BUTCHR-2");
    world["BUTCHR-2"] = issue("BUTCHR-2", { status: "In Progress" });
    await state.runDirtyPass();
    expect(notified).toHaveLength(1);

    // A second dirty change this same hour is rate-capped, not delivered.
    now.value = 2;
    state.markDirty("jira:BUTCHR-2");
    world["BUTCHR-2"] = issue("BUTCHR-2", { status: "Done" });
    await state.runDirtyPass();
    expect(notified).toHaveLength(1); // still capped

    now.value = 61 * 60_000; // roll the sliding window over
    await state.runTick([m], deps); // the still-dirty target is re-detected on the very next regular tick too
    expect(notified).toHaveLength(2);
  });

  test("T9: a dirty mark for a target nobody watches is ignored and does not grow the dirty set unboundedly", async () => {
    const state = createLinkedEventingState();
    const world: Record<string, JiraIssue> = {};
    const { push } = fakePush();
    const { deps } = fakeDeps(world, { push });
    await state.runTick([], deps); // establishes lastPassContext with nothing watched
    state.markDirty("jira:NOBODY-1");
    await state.runDirtyPass();
    expect(state.stats().dirtyMarks).toBe(1);
    // No assertion possible on internal Set size directly, but a second
    // identical mark/pass cycle must not throw or accumulate observable state.
    state.markDirty("jira:NOBODY-1");
    await state.runDirtyPass();
  });

  test("T10 (review fix round 1): a regular tick and an on-demand pass held concurrently, racing over the SAME real change, produce exactly one notification", async () => {
    const owner = issue("BUTCHR-1", { issuelinks: [{ type: "Blocks", otherEnd: "outward", key: "BUTCHR-2" }] as never });
    const world: Record<string, JiraIssue> = { "BUTCHR-2": issue("BUTCHR-2", { status: "To Do" }) };
    const state = createLinkedEventingState();
    const { push } = fakePush();
    const m = match("jira-work:task:BUTCHR-1", rule(), owner);

    // Seed with ordinary (non-gated) deps.
    const seed = fakeDeps(world, { push });
    await state.runTick([m], seed.deps);

    // A controllable gate on the search call, so a regular `runTick` can be
    // held mid-fetch while `runDirtyPass()` is invoked "concurrently" —
    // `serialize()` (this module's own promise-chain mutex) must make the
    // on-demand pass wait for the in-flight tick rather than run alongside it.
    let gate: Promise<void> | undefined;
    let releaseGate: (() => void) | undefined;
    const notified: NotifyReason[] = [];
    const searchCalls: string[] = [];
    const racingDeps: LinkedEventingDeps = {
      search: async (jql) => {
        searchCalls.push(jql);
        if (gate) await gate;
        const mm = /^key in \((.*)\)$/.exec(jql);
        const keys = mm ? mm[1]!.split(",") : [];
        return keys.map((k) => world[k]).filter((i): i is JiraIssue => Boolean(i));
      },
      notify: async (_a, _b, reason) => { notified.push(reason); },
      push,
    };

    world["BUTCHR-2"] = issue("BUTCHR-2", { status: "In Progress" }); // the ONE real change
    state.markDirty("jira:BUTCHR-2");

    gate = new Promise<void>((resolve) => { releaseGate = resolve; });
    const tickPromise = state.runTick([m], racingDeps); // regular tick starts, blocks mid-fetch (dirty -> it's in the restrict set already)
    await Promise.resolve();
    await Promise.resolve(); // let it reach the gated search call

    const dirtyPassPromise = state.runDirtyPass(); // attempted WHILE the tick is still in flight
    releaseGate?.();
    gate = undefined;
    await tickPromise;
    await dirtyPassPromise;

    expect(notified).toHaveLength(1); // exactly one notify for the one real change, despite the overlap attempt
    expect(searchCalls).toHaveLength(1); // the on-demand pass found nothing dirty left once serialized behind the tick -> no second fetch
  });
});

describe("FACTORY-137 review round 2 (P2): an on-demand pass over a project MEMBER target must not reuse a stale member snapshot", () => {
  const KEY_IN_RE = /^key in \((.*)\)$/;
  const PROJECT_JQL_RE = /^project = (\S+) AND updated >= "-(\d+)m" ORDER BY updated ASC$/;

  test("a dirty project member is re-fetched fresh by runDirtyPass, not diffed against the regular tick's own cached member object", async () => {
    const projRule: Rule = parseRules({ rules: [{ id: "mgrs", resourceProvider: "jira-project", query: '{"keys":["BUTCHR"]}', brief: "manage it", linkedEventing: true }] })[0]!;
    const world: Record<string, JiraIssue> = { "BUTCHR-1": issue("BUTCHR-1", { status: "To Do", updated: "2026-10-01T00:00:00.000+0000" }) };
    const membersByProject: Record<string, string[]> = { BUTCHR: [] };
    const state = createLinkedEventingState();
    const { push } = fakePush();
    const searchCalls: string[] = [];
    const notified: Array<{ reason: NotifyReason }> = [];
    const deps: LinkedEventingDeps = {
      search: async (jql) => {
        searchCalls.push(jql);
        const keyIn = KEY_IN_RE.exec(jql);
        if (keyIn) return keyIn[1]!.split(",").map((k) => world[k]).filter((i): i is JiraIssue => Boolean(i));
        const proj = PROJECT_JQL_RE.exec(jql);
        if (proj) return (membersByProject[proj[1]!] ?? []).map((k) => world[k]).filter((i): i is JiraIssue => Boolean(i));
        throw new Error(`fakeDeps: unexpected JQL ${JSON.stringify(jql)}`);
      },
      notify: async (_a, _b, reason) => { notified.push({ reason }); },
      push,
    };
    const pm: ProjectLinkedEventingMatch = { agentKey: "jira-project:mgrs:BUTCHR", rule: projRule, projectKey: "BUTCHR" };

    await state.runTick([], deps, [pm]); // tick 1: seeds the project watermark, searches nothing yet (real Jira window semantics)
    membersByProject.BUTCHR = ["BUTCHR-1"]; // falls inside the next window
    await state.runTick([], deps, [pm]); // tick 2: member discovered fresh via the project search, reported once, baseline seeded — and cached in THIS tick's own `memberFetchedByKey`
    expect(notified).toHaveLength(1);

    // The member falls back out of the window (nothing for polling to find
    // next tick either way), but a REAL authoritative status change lands,
    // signaled via a push notification instead of waiting for the next
    // regular project tick.
    membersByProject.BUTCHR = [];
    world["BUTCHR-1"] = issue("BUTCHR-1", { status: "In Progress", updated: "2026-10-01T00:05:00.000+0000" });
    state.markDirty("jira:BUTCHR-1");
    notified.length = 0;
    const searchCallsBeforeDirtyPass = searchCalls.length;
    await state.runDirtyPass(); // reuses tick 2's own PassContext (lastPassContext), WITHOUT rerunning project member discovery (D3)

    // Must have performed a FRESH `key in (...)` fetch for BUTCHR-1 — not
    // silently treated as "already fetched" using tick 2's now-stale cached
    // member object — and delivered exactly one notification for the real
    // change, with no further regular tick required.
    const newKeyInCalls = searchCalls.slice(searchCallsBeforeDirtyPass).filter((c) => KEY_IN_RE.test(c) && c.includes("BUTCHR-1"));
    expect(newKeyInCalls).toHaveLength(1);
    expect(notified).toHaveLength(1);
    const events = (notified[0]!.reason as { linked: { events: readonly { target: string; kind: string; detail: string }[] } }).linked.events;
    expect(events.some((e) => e.target === "BUTCHR-1" && e.detail.includes("In Progress"))).toBe(true);
  });

  test("review round 3 (P2, continued): a dirty project member that Jira's search now OMITS (deleted/unreadable) still reports exactly one unreadable transition, not a silently-stale 'unchanged'", async () => {
    const projRule: Rule = parseRules({ rules: [{ id: "mgrs", resourceProvider: "jira-project", query: '{"keys":["BUTCHR"]}', brief: "manage it", linkedEventing: true }] })[0]!;
    const world: Record<string, JiraIssue> = { "BUTCHR-1": issue("BUTCHR-1", { status: "To Do", updated: "2026-10-01T00:00:00.000+0000" }) };
    const membersByProject: Record<string, string[]> = { BUTCHR: [] };
    const state = createLinkedEventingState();
    const { push } = fakePush();
    const searchCalls: string[] = [];
    const notified: Array<{ reason: NotifyReason }> = [];
    const deps: LinkedEventingDeps = {
      search: async (jql) => {
        searchCalls.push(jql);
        const keyIn = KEY_IN_RE.exec(jql);
        if (keyIn) return keyIn[1]!.split(",").map((k) => world[k]).filter((i): i is JiraIssue => Boolean(i));
        const proj = PROJECT_JQL_RE.exec(jql);
        if (proj) return (membersByProject[proj[1]!] ?? []).map((k) => world[k]).filter((i): i is JiraIssue => Boolean(i));
        throw new Error(`fakeDeps: unexpected JQL ${JSON.stringify(jql)}`);
      },
      notify: async (_a, _b, reason) => { notified.push({ reason }); },
      push,
    };
    const pm: ProjectLinkedEventingMatch = { agentKey: "jira-project:mgrs:BUTCHR", rule: projRule, projectKey: "BUTCHR" };

    await state.runTick([], deps, [pm]); // seeds watermark
    membersByProject.BUTCHR = ["BUTCHR-1"];
    await state.runTick([], deps, [pm]); // member discovered fresh, reported once, cached in THIS tick's memberFetchedByKey
    expect(notified).toHaveLength(1);

    // The member is deleted (or becomes unreadable) with NO further regular
    // tick — Jira's batched `key in (...)` silently omits it rather than
    // erroring. A push notification still marks it dirty.
    membersByProject.BUTCHR = [];
    delete world["BUTCHR-1"];
    state.markDirty("jira:BUTCHR-1");
    notified.length = 0;
    await state.runDirtyPass();

    expect(notified).toHaveLength(1); // exactly one unreadable transition
    const events = (notified[0]!.reason as { linked: { events: readonly { target: string; kind: string; detail: string }[] } }).linked.events;
    expect(events).toEqual([{ target: "BUTCHR-1", kind: "jira-key", detail: "unreadable" }]);

    // Still unreadable, nothing newly dirty -> no repeat of the transition.
    state.markDirty("jira:BUTCHR-1");
    notified.length = 0;
    await state.runDirtyPass();
    expect(notified).toHaveLength(0);
  });
});
