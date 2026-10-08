import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startPermissionAnswerWatch, type PermissionAnswerPushFrame, type PermissionAnswerSubscription } from "../../src/agents/permission-answer-watch.js";
import type { PermissionAnswerClient, PermissionAnswerPane } from "../../src/agents/permission-answer-loop.js";

// Same measured screen as permission-answer-loop.test.ts (see that file for
// provenance) — a dialog `autoAnswerPermissions` presses option 1 "Yes" on.
const DIALOG_SCREEN = `─────────────────────────────────────────
 Bash command

   rm -rf /

 Do you want to proceed?
 ❯ 1. Yes
   2. No

 Esc to cancel · Tab to amend`;

const AGENT_BASE = { agent: "claude" as const, focused: true, revision: 1, tab_id: "t1", terminal_id: "term1", workspace_id: "w1" };

/** Mutable fake herdr client, same shape as the loop test's own `fakeClient` — a pane's screen can be changed mid-test to simulate a dialog appearing. */
function fakeClient(screensByPaneInit: Record<string, string>) {
  const screensByPane = { ...screensByPaneInit };
  const sendKeysCalls: unknown[] = [];
  let listCalls = 0;
  const client: PermissionAnswerClient = {
    agent: {
      list: async () => {
        listCalls++;
        return { type: "agent_list" as const, agents: Object.keys(screensByPane).map((pane_id) => ({ ...AGENT_BASE, pane_id, agent_status: "blocked" as const })) };
      },
      get: (async () => { throw new Error("not used"); }) as PermissionAnswerClient["agent"]["get"],
      read: (async (p: { target: string }) => ({
        type: "pane_read" as const,
        read: { format: "text" as const, pane_id: p.target, revision: 1, source: "detection" as const, tab_id: "t1", text: screensByPane[p.target] ?? "", truncated: false, workspace_id: "w1" },
      })) as PermissionAnswerClient["agent"]["read"],
      sendKeys: (async (p: { target: string }) => { sendKeysCalls.push(p); screensByPane[p.target] = "cleared"; return { type: "ok" as const }; }) as PermissionAnswerClient["agent"]["sendKeys"],
    },
  };
  return { client, sendKeysCalls, setScreen: (pane: string, text: string) => { screensByPane[pane] = text; }, listCallCount: () => listCalls };
}

/** A controllable fake push subscription: `push()` delivers a frame to whatever is currently iterating it; `close()` ends the iteration. */
class FakeSubscription implements PermissionAnswerSubscription {
  private pending: PermissionAnswerPushFrame[] = [];
  private waiting: ((r: IteratorResult<PermissionAnswerPushFrame>) => void)[] = [];
  private closed = false;
  closeCalls = 0;

  push(frame: PermissionAnswerPushFrame): void {
    const waiter = this.waiting.shift();
    if (waiter) waiter({ value: frame, done: false });
    else this.pending.push(frame);
  }

  close(): void {
    this.closed = true;
    this.closeCalls++;
    while (this.waiting.length) this.waiting.shift()?.({ value: undefined as never, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<PermissionAnswerPushFrame> {
    return {
      next: () => {
        const next = this.pending.shift();
        if (next) return Promise.resolve({ value: next, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve) => this.waiting.push(resolve));
      },
    };
  }
}

const onlyP1 = (agents: readonly PermissionAnswerPane[]): ReadonlyMap<string, string> =>
  new Map(agents.filter((a) => a.pane_id === "p1").map((a) => [a.pane_id, "lizard.json"]));

// A real macrotask tick, not just microtasks: the code under test's own
// promise chains cross real `setTimeout`-based waits (drovr's verify-poll
// loop), which bare `await Promise.resolve()` never lets elapse.
async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 30));
}

/**
 * Polls `predicate` instead of sleeping a fixed guess — a fixed sleep tuned
 * tight enough to keep these tests fast is exactly the kind of thing that
 * flakes under CI load (a slow scheduler tick, a loaded box); polling for
 * the actual condition is both faster in the common case and never flaky
 * because it was too short.
 */
async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor: condition never became true within ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("startPermissionAnswerWatch", () => {
  test("fast path: a pane blocked between sweeps is answered via the push event, not the next sweep tick", async () => {
    const dir = mkdtempSync(join(tmpdir(), "perm-watch-"));
    const auditPath = join(dir, "audit.jsonl");
    const { client, sendKeysCalls, setScreen } = fakeClient({ p1: "ordinary idle screen, no dialog" });
    const subs: FakeSubscription[] = [];
    const subscribedWith: string[][] = [];

    const handle = startPermissionAnswerWatch(
      {
        client,
        eligiblePanes: onlyP1,
        auditPath,
        subscribe: async (paneIds) => {
          subscribedWith.push([...paneIds]);
          const sub = new FakeSubscription();
          subs.push(sub);
          return sub;
        },
      },
      // A deliberately huge interval: if the assertion below passes, it did
      // so via the push event, never via a sweep tick (the test finishes
      // long before this would ever fire again).
      1_000_000,
    );

    await waitFor(() => subscribedWith.length > 0);
    expect(subscribedWith).toEqual([["p1"]]); // subscribed to exactly the eligible pane, right away
    expect(sendKeysCalls).toEqual([]); // nothing pending yet

    // The dialog appears, and herdr reports the transition.
    setScreen("p1", DIALOG_SCREEN);
    subs[0]!.push({ event: "pane.agent_status_changed", data: { pane_id: "p1", agent_status: "blocked" } });
    await waitFor(() => sendKeysCalls.length > 0);

    expect(sendKeysCalls).toEqual([{ target: "p1", keys: ["enter"] }]);
    handle.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  test("ineligible panes are never included in the subscription filter, and an event for one is not answered", async () => {
    const dir = mkdtempSync(join(tmpdir(), "perm-watch-"));
    const auditPath = join(dir, "audit.jsonl");
    const { client, sendKeysCalls, listCallCount } = fakeClient({ p1: "idle", p2: DIALOG_SCREEN });
    const subs: FakeSubscription[] = [];
    const subscribedWith: string[][] = [];

    const handle = startPermissionAnswerWatch(
      {
        client,
        eligiblePanes: onlyP1, // p2 never opts in
        auditPath,
        subscribe: async (paneIds) => {
          subscribedWith.push([...paneIds]);
          const sub = new FakeSubscription();
          subs.push(sub);
          return sub;
        },
      },
      1_000_000,
    );

    await waitFor(() => subscribedWith.length > 0);
    expect(subscribedWith).toEqual([["p1"]]); // p2 was never even offered to subscribe()

    // Even if a stray event named p2 arrived, the shared eligiblePanes gate
    // (the same one runPermissionAnswerTick already enforces) keeps it
    // untouched. Wait for the tick this event triggers to actually run
    // (observed via its own agent.list() call) before checking nothing was
    // pressed — proves the event was processed, not merely that we didn't
    // wait long enough to see a bug.
    const listsBeforeEvent = listCallCount();
    subs[0]!.push({ event: "pane.agent_status_changed", data: { pane_id: "p2", agent_status: "blocked" } });
    await waitFor(() => listCallCount() > listsBeforeEvent);

    expect(sendKeysCalls).toEqual([]);
    handle.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  test("no overlapping runs: a burst of push events while a tick is in flight collapses into one tick, never double-answering", async () => {
    const dir = mkdtempSync(join(tmpdir(), "perm-watch-"));
    const auditPath = join(dir, "audit.jsonl");
    const { client, sendKeysCalls, setScreen } = fakeClient({ p1: "idle" });
    const subs: FakeSubscription[] = [];

    const handle = startPermissionAnswerWatch(
      {
        client,
        eligiblePanes: onlyP1,
        auditPath,
        subscribe: async () => {
          const sub = new FakeSubscription();
          subs.push(sub);
          return sub;
        },
      },
      1_000_000,
    );

    await waitFor(() => subs.length > 0);
    setScreen("p1", DIALOG_SCREEN);
    // Fire a burst of transitions for the same pane before the first has a
    // chance to resolve — same shape as a tool-heavy agent's own rapid
    // blocked/working churn.
    for (let i = 0; i < 5; i++) subs[0]!.push({ event: "pane.agent_status_changed", data: { pane_id: "p1", agent_status: "blocked" } });
    await waitFor(() => sendKeysCalls.length > 0);
    await flush(); // grace period: prove no SECOND press follows the first

    // Pressed exactly once: the dialog cleared after the first press (the
    // fake client's own sendKeys sets the screen to "cleared"), so every
    // later collapsed-or-not tick finds nothing pending.
    expect(sendKeysCalls).toEqual([{ target: "p1", keys: ["enter"] }]);
    handle.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  test("a blocked event arriving while a tick is in flight is coalesced into one trailing re-run, not dropped", async () => {
    const dir = mkdtempSync(join(tmpdir(), "perm-watch-"));
    const auditPath = join(dir, "audit.jsonl");
    const screensByPane: Record<string, string> = { p1: "idle", p2: "idle" };
    const sendKeysCalls: unknown[] = [];
    // Resolved once, later — every read of p1 after that resolves instantly,
    // so this only stalls the FIRST tick's read of p1, not a second one.
    let releaseFirstRead!: () => void;
    const firstReadGate = new Promise<void>((resolve) => { releaseFirstRead = resolve; });
    let p1ReadStarted = false;
    const client: PermissionAnswerClient = {
      agent: {
        list: async () => ({ type: "agent_list" as const, agents: Object.keys(screensByPane).map((pane_id) => ({ ...AGENT_BASE, pane_id, agent_status: "blocked" as const })) }),
        get: (async () => { throw new Error("not used"); }) as PermissionAnswerClient["agent"]["get"],
        read: (async (p: { target: string }) => {
          if (p.target === "p1") { p1ReadStarted = true; await firstReadGate; }
          return { type: "pane_read" as const, read: { format: "text" as const, pane_id: p.target, revision: 1, source: "detection" as const, tab_id: "t1", text: screensByPane[p.target] ?? "", truncated: false, workspace_id: "w1" } };
        }) as PermissionAnswerClient["agent"]["read"],
        sendKeys: (async (p: { target: string }) => { sendKeysCalls.push(p); screensByPane[p.target] = "cleared"; return { type: "ok" as const }; }) as PermissionAnswerClient["agent"]["sendKeys"],
      },
    };
    const bothEligible = (agents: readonly PermissionAnswerPane[]): ReadonlyMap<string, string> =>
      new Map(agents.map((a) => [a.pane_id, a.pane_id]));
    const subs: FakeSubscription[] = [];

    const handle = startPermissionAnswerWatch(
      {
        client,
        eligiblePanes: bothEligible,
        auditPath,
        subscribe: async () => {
          const sub = new FakeSubscription();
          subs.push(sub);
          return sub;
        },
      },
      // Huge sweep interval: if p2 gets answered promptly below, it was the
      // coalesced trailing tick that did it, never the sweep.
      1_000_000,
    );

    await waitFor(() => subs.length > 0);
    // Kick off tick 1: p1 goes blocked, its own read stalls on the gate —
    // the tick is now genuinely in flight (inFlight is set synchronously
    // before any await), same as a real approve/verify pass taking seconds.
    subs[0]!.push({ event: "pane.agent_status_changed", data: { pane_id: "p1", agent_status: "blocked" } });
    await waitFor(() => p1ReadStarted);

    // While tick 1 is stalled, p2's dialog appears and herdr reports it.
    // The OLD (pre-review) behavior dropped this outright, leaving p2 to the
    // 20s sweep alone — exactly the miss the review caught.
    screensByPane.p2 = DIALOG_SCREEN;
    subs[0]!.push({ event: "pane.agent_status_changed", data: { pane_id: "p2", agent_status: "blocked" } });
    await flush(); // let the event handler run and set the pending flag

    releaseFirstRead(); // tick 1 finishes (p1 had nothing pending, so nothing pressed for it)
    // The coalesced trailing tick should answer p2 promptly, without ever
    // reaching the (deliberately huge) sweep interval.
    await waitFor(() => sendKeysCalls.length > 0);

    expect(sendKeysCalls).toEqual([{ target: "p2", keys: ["enter"] }]);
    handle.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  test("fallback sweep still works when the push subscription never delivers anything (e.g. events unavailable)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "perm-watch-"));
    const auditPath = join(dir, "audit.jsonl");
    const { client, sendKeysCalls, setScreen } = fakeClient({ p1: "idle" });

    const handle = startPermissionAnswerWatch(
      {
        client,
        eligiblePanes: onlyP1,
        auditPath,
        subscribe: async () => new FakeSubscription(), // opens fine, just never pushes a frame
      },
      5, // fast sweep so the test doesn't wait long
    );

    await flush();
    setScreen("p1", DIALOG_SCREEN);
    // No push event at all — only the sweep should catch this.
    await waitFor(() => sendKeysCalls.length > 0);

    expect(sendKeysCalls).toEqual([{ target: "p1", keys: ["enter"] }]);
    handle.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  test("resubscribes when the eligible pane set changes, closing the previous subscription", async () => {
    const dir = mkdtempSync(join(tmpdir(), "perm-watch-"));
    const auditPath = join(dir, "audit.jsonl");
    const { client } = fakeClient({ p1: "idle" });
    const subs: FakeSubscription[] = [];
    const subscribedWith: string[][] = [];
    let eligible: ReadonlySet<string> = new Set(["p1"]);

    const handle = startPermissionAnswerWatch(
      {
        client,
        eligiblePanes: (agents) => new Map(agents.filter((a) => eligible.has(a.pane_id)).map((a) => [a.pane_id, a.pane_id])),
        auditPath,
        subscribe: async (paneIds) => {
          subscribedWith.push([...paneIds]);
          const sub = new FakeSubscription();
          subs.push(sub);
          return sub;
        },
      },
      10,
    );

    await waitFor(() => subscribedWith.length > 0);
    expect(subscribedWith).toEqual([["p1"]]);
    expect(subs[0]!.closeCalls).toBe(0);

    eligible = new Set(); // p1 stops being eligible
    await waitFor(() => subs[0]!.closeCalls > 0);

    expect(subs[0]!.closeCalls).toBe(1); // the stale subscription was torn down
    expect(subscribedWith).toEqual([["p1"]]); // and no new one opened for an empty set

    handle.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  test("stop() closes the open subscription and stops the sweep — nothing fires afterward", async () => {
    const dir = mkdtempSync(join(tmpdir(), "perm-watch-"));
    const auditPath = join(dir, "audit.jsonl");
    const { client, sendKeysCalls, setScreen, listCallCount } = fakeClient({ p1: "idle" });
    const subs: FakeSubscription[] = [];

    const handle = startPermissionAnswerWatch(
      {
        client,
        eligiblePanes: onlyP1,
        auditPath,
        subscribe: async () => {
          const sub = new FakeSubscription();
          subs.push(sub);
          return sub;
        },
      },
      5,
    );

    await flush();
    handle.stop();
    expect(subs[0]!.closeCalls).toBe(1);

    const listsAtStop = listCallCount();
    setScreen("p1", DIALOG_SCREEN);
    subs[0]!.push({ event: "pane.agent_status_changed", data: { pane_id: "p1", agent_status: "blocked" } });
    await new Promise((r) => setTimeout(r, 40));

    expect(listCallCount()).toBe(listsAtStop); // the sweep timer is gone
    expect(sendKeysCalls).toEqual([]); // and the closed subscription's late event is ignored

    rmSync(dir, { recursive: true, force: true });
  });

  test("a subscribe() failure is logged and retried after resubscribeDelayMs, never left dead", async () => {
    const dir = mkdtempSync(join(tmpdir(), "perm-watch-"));
    const auditPath = join(dir, "audit.jsonl");
    const { client } = fakeClient({ p1: "idle" });
    const lines: string[] = [];
    const subs: FakeSubscription[] = [];
    let attempt = 0;

    const handle = startPermissionAnswerWatch(
      {
        client,
        eligiblePanes: onlyP1,
        auditPath,
        log: (l) => lines.push(l),
        resubscribeDelayMs: 10,
        subscribe: async () => {
          attempt++;
          if (attempt === 1) throw new Error("herdr socket refused");
          const sub = new FakeSubscription();
          subs.push(sub);
          return sub;
        },
      },
      1_000_000,
    );

    await waitFor(() => lines.length > 0);
    expect(lines.some((l) => l.includes("watch subscribe failed") && l.includes("herdr socket refused"))).toBe(true);
    expect(subs).toHaveLength(0); // first attempt never produced a subscription

    await waitFor(() => subs.length > 0);
    expect(subs).toHaveLength(1); // retried on its own after the backoff

    handle.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  test("a subscription that ends on its own (herdr closed it) is reopened after resubscribeDelayMs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "perm-watch-"));
    const auditPath = join(dir, "audit.jsonl");
    const { client, setScreen, sendKeysCalls } = fakeClient({ p1: "idle" });
    const subs: FakeSubscription[] = [];
    const subscribedWith: string[][] = [];

    const handle = startPermissionAnswerWatch(
      {
        client,
        eligiblePanes: onlyP1,
        auditPath,
        resubscribeDelayMs: 10,
        subscribe: async (paneIds) => {
          subscribedWith.push([...paneIds]);
          const sub = new FakeSubscription();
          subs.push(sub);
          return sub;
        },
      },
      1_000_000,
    );

    await waitFor(() => subs.length > 0);
    expect(subs).toHaveLength(1);
    subs[0]!.close(); // herdr drops the connection, unrelated to stop()
    await waitFor(() => subs.length > 1);

    expect(subs).toHaveLength(2); // reopened on its own
    expect(subscribedWith).toEqual([["p1"], ["p1"]]);

    // The reopened subscription still answers — proof it's not just present but live.
    setScreen("p1", DIALOG_SCREEN);
    subs[1]!.push({ event: "pane.agent_status_changed", data: { pane_id: "p1", agent_status: "blocked" } });
    await waitFor(() => sendKeysCalls.length > 0);
    expect(sendKeysCalls).toEqual([{ target: "p1", keys: ["enter"] }]);

    handle.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  // FACTORY-145: the trigger instant this module records on frame receipt is
  // what runPermissionAnswerTick turns into `latencyMs` — an injected clock
  // proves the two sides share one instant, end to end through the real
  // fastPathTriggers map (not a fake stand-in for it).
  test("FACTORY-145: a fast-path answer's audit record carries an exact latencyMs measured from frame receipt, using the shared injected clock", async () => {
    const dir = mkdtempSync(join(tmpdir(), "perm-watch-"));
    const auditPath = join(dir, "audit.jsonl");
    const { client, setScreen } = fakeClient({ p1: "ordinary idle screen, no dialog" });
    const subs: FakeSubscription[] = [];
    // A queue rather than a wall-clock variable: this module's own `now()`
    // calls are exactly one per pane per frame-receipt/tick, in a known
    // order, so a queue pins each call's return value without racing test
    // code against microtask scheduling the way a shared mutable clock would.
    const clockQueue = [10_180, 10_431]; // frame receipt, then the tick's own latency read — 251ms apart
    const now = () => clockQueue.shift() ?? 999_999;

    const handle = startPermissionAnswerWatch(
      {
        client,
        eligiblePanes: onlyP1,
        auditPath,
        now,
        subscribe: async () => {
          const sub = new FakeSubscription();
          subs.push(sub);
          return sub;
        },
      },
      1_000_000,
    );

    await waitFor(() => subs.length > 0);
    setScreen("p1", DIALOG_SCREEN);
    subs[0]!.push({ event: "pane.agent_status_changed", data: { pane_id: "p1", agent_status: "blocked" } });
    await waitFor(() => {
      try { return readFileSync(auditPath, "utf8").includes("latencyMs"); } catch { return false; }
    });

    const audit = readFileSync(auditPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(audit.at(-1)).toMatchObject({ paneId: "p1", trigger: "fast", latencyMs: 251 });

    handle.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  // FACTORY-722: reproduces the wedge finding directly — a herdr call
  // (`agent.list()`) that never settles, same as the incident's own
  // "one never-settling herdr await stalls everything that serializes on
  // it" root cause, BEFORE this ticket's `Config.herdrCallTimeoutMs` fix
  // existed to bound it. `inFlight` would otherwise never clear (its own
  // `.finally` never runs), leaving every later push event coalesced into a
  // `pending` flag a dead tick can never consume. The watchdog is the
  // defense-in-depth backstop for exactly this: independent of the tick
  // (fix-scope item (c)/(d) on the ticket's own two manager-factory
  // comments), not merely a second path that could wedge the same way.
  test("watchdog: a tick stuck forever on an unresolving herdr call is force-restarted, not left dead", async () => {
    const dir = mkdtempSync(join(tmpdir(), "perm-watch-"));
    const auditPath = join(dir, "audit.jsonl");
    let listCalls = 0;
    const client: PermissionAnswerClient = {
      agent: {
        // The FIRST call resolves normally — exactly like the real
        // incident: the daemon boots healthy, learns p1 is eligible, and
        // opens a subscription for it. Every call AFTER that never settles
        // — no socket error, no timeout, nothing to catch — reproducing
        // "a herdr socket error" leaving a LATER call wedged mid-flight,
        // not merely a daemon that could never list anything in the first
        // place. The ONLY way `inFlight` ever clears again from here is the
        // watchdog forcing it.
        list: (async () => {
          listCalls++;
          if (listCalls === 1) return { type: "agent_list" as const, agents: [{ ...AGENT_BASE, pane_id: "p1", agent_status: "idle" as const }] };
          return new Promise<never>(() => {});
        }) as PermissionAnswerClient["agent"]["list"],
        get: (async () => { throw new Error("not used"); }) as PermissionAnswerClient["agent"]["get"],
        read: (async () => { throw new Error("not used"); }) as PermissionAnswerClient["agent"]["read"],
        sendKeys: (async () => { throw new Error("not used"); }) as PermissionAnswerClient["agent"]["sendKeys"],
      },
    };
    const subs: FakeSubscription[] = [];
    const lines: string[] = [];
    const tripped: (readonly string[])[] = [];

    const handle = startPermissionAnswerWatch(
      {
        client,
        eligiblePanes: onlyP1,
        auditPath,
        log: (l) => lines.push(l),
        watchdogThresholdMs: 30,
        watchdogCheckIntervalMs: 10,
        onWatchdogTripped: (stuck) => tripped.push(stuck),
        subscribe: async () => {
          const sub = new FakeSubscription();
          subs.push(sub);
          return sub;
        },
      },
      // Huge sweep interval: the only tick attempts observed below are the
      // initial `fire()` and the watchdog's own forced one, never a sweep tick.
      1_000_000,
    );

    // Tick 1 (the initial fire()) resolves fine: it learns p1 is eligible
    // and opens the subscription for it.
    await waitFor(() => subs.length > 0);
    expect(listCalls).toBe(1);

    // A pane goes blocked. This fires a SECOND tick (tick 1 already
    // finished, so `inFlight` was clear) — THAT call to `agent.list()` is
    // the one that never settles, wedging `inFlight` true forever and
    // leaving this push's own `fastPathTriggers` entry permanently unconsumed.
    subs[0]!.push({ event: "pane.agent_status_changed", data: { pane_id: "p1", agent_status: "blocked" } });
    await waitFor(() => listCalls > 1);
    const listsBeforeTrigger = listCalls;

    await waitFor(() => tripped.length > 0);
    expect(tripped[0]).toEqual(["p1"]);
    expect(lines.some((l) => l.includes("[watchdog] restarted permission-answer") && l.includes("p1"))).toBe(true);

    // Recovery actually happened: the old subscription was torn down and a
    // new one opened, AND a fresh tick was kicked off (inFlight forced
    // clear) rather than leaving `fire()` permanently coalescing into `pending`.
    expect(subs[0]!.closeCalls).toBe(1);
    await waitFor(() => subs.length > 1);
    await waitFor(() => listCalls > listsBeforeTrigger);

    handle.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  test("watchdog disabled (watchdogThresholdMs: 0) never trips, even with a permanently unconsumed trigger", async () => {
    const dir = mkdtempSync(join(tmpdir(), "perm-watch-"));
    const auditPath = join(dir, "audit.jsonl");
    let listCalls = 0;
    const client: PermissionAnswerClient = {
      agent: {
        // Same two-phase shape as the sibling test above: the first call
        // resolves (so a subscription opens for p1), every call after that
        // never settles (so the trigger set by the push below is never
        // consumed by any tick).
        list: (async () => {
          listCalls++;
          if (listCalls === 1) return { type: "agent_list" as const, agents: [{ ...AGENT_BASE, pane_id: "p1", agent_status: "idle" as const }] };
          return new Promise<never>(() => {});
        }) as PermissionAnswerClient["agent"]["list"],
        get: (async () => { throw new Error("not used"); }) as PermissionAnswerClient["agent"]["get"],
        read: (async () => { throw new Error("not used"); }) as PermissionAnswerClient["agent"]["read"],
        sendKeys: (async () => { throw new Error("not used"); }) as PermissionAnswerClient["agent"]["sendKeys"],
      },
    };
    const subs: FakeSubscription[] = [];
    const tripped: (readonly string[])[] = [];

    const handle = startPermissionAnswerWatch(
      {
        client,
        eligiblePanes: onlyP1,
        auditPath,
        watchdogThresholdMs: 0,
        onWatchdogTripped: (stuck) => tripped.push(stuck),
        subscribe: async () => {
          const sub = new FakeSubscription();
          subs.push(sub);
          return sub;
        },
      },
      1_000_000,
    );

    await waitFor(() => subs.length > 0);
    expect(listCalls).toBe(1);
    subs[0]!.push({ event: "pane.agent_status_changed", data: { pane_id: "p1", agent_status: "blocked" } });
    await waitFor(() => listCalls > 1); // the second tick is now permanently wedged
    await new Promise((r) => setTimeout(r, 60)); // comfortably past the threshold the OTHER test trips at

    expect(tripped).toEqual([]);
    expect(subs[0]!.closeCalls).toBe(0); // never torn down — the watchdog never ran at all

    handle.stop();
    rmSync(dir, { recursive: true, force: true });
  });
});
