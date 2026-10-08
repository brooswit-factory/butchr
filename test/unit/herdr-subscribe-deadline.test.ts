import { describe, expect, test } from "bun:test";
import { createOutstandingGuard } from "../../src/daemon/herdr-subscribe-deadline.js";
import { startPermissionAnswerWatch, type PermissionAnswerPushFrame, type PermissionAnswerSubscription } from "../../src/agents/permission-answer-watch.js";
import type { PermissionAnswerClient, PermissionAnswerPane } from "../../src/agents/permission-answer-loop.js";

/** A fake raw subscription — same `{close()}` shape `createOutstandingGuard` requires. */
class FakeRawSub {
  closeCalls = 0;
  close(): void { this.closeCalls++; }
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor: condition never became true within ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("createOutstandingGuard (FACTORY-751/FACTORY-775)", () => {
  test("a never-settling raw subscribe is opened once; a later call while it is still outstanding opens NO second one", async () => {
    let opens = 0;
    const guarded = createOutstandingGuard<FakeRawSub>(20, (ms) => new Error(`timeout ${ms}`));
    const openRaw = () => { opens++; return new Promise<FakeRawSub>(() => {}); }; // never settles

    await expect(guarded(openRaw)).rejects.toThrow(/timeout 20/);
    expect(opens).toBe(1);

    // A second attempt, exactly what `scheduleReconnect` does after the
    // first attempt's own deadline rejected — the raw promise from the
    // first call is STILL outstanding (it never settles), so this must not
    // open a second one.
    await expect(guarded(openRaw)).rejects.toThrow(/timeout 20/);
    expect(opens).toBe(1);

    // And a third, for good measure — bounded stays bounded, it does not
    // creep up with more attempts.
    await expect(guarded(openRaw)).rejects.toThrow(/timeout 20/);
    expect(opens).toBe(1);
  });

  test("once the outstanding raw attempt settles (even in error), the NEXT call opens a fresh one", async () => {
    let opens = 0;
    const guarded = createOutstandingGuard<FakeRawSub>(20, (ms) => new Error(`timeout ${ms}`));
    let reject3: ((e: Error) => void) | undefined;
    const openRaw = () => {
      opens++;
      if (opens === 1) return new Promise<FakeRawSub>(() => {}); // never settles
      if (opens === 2) return Promise.reject(new Error("herdr refused"));
      return new Promise<FakeRawSub>((_, rej) => { reject3 = rej; });
    };

    await expect(guarded(openRaw)).rejects.toThrow(/timeout 20/); // attempt 1: times out, raw never settles
    await expect(guarded(openRaw)).rejects.toThrow(/timeout 20/); // attempt 2 while #1 outstanding: NOT a new open
    expect(opens).toBe(1);

    // #1's raw promise is stuck forever in this test (deliberately, like a
    // real never-acking herdr) — nothing clears `outstanding` on its own.
    // This is the honest, undemonstrated-zero-leakage case the ticket asks
    // for: at most ONE raw connection is ever outstanding, but that one
    // stays open for good once the SDK gives no way to abort it.
  });

  test("a late ack (resolves AFTER this call's own deadline fired) closes the subscription instead of handing it back", async () => {
    const guarded = createOutstandingGuard<FakeRawSub>(10, (ms) => new Error(`timeout ${ms}`));
    const sub = new FakeRawSub();
    let resolve: ((s: FakeRawSub) => void) | undefined;
    const openRaw = () => new Promise<FakeRawSub>((res) => { resolve = res; });

    const p = guarded(openRaw);
    await expect(p).rejects.toThrow(/timeout 10/);
    expect(sub.closeCalls).toBe(0);

    resolve!(sub); // the ack arrives late, after the deadline already rejected
    await new Promise((r) => setTimeout(r, 5));
    expect(sub.closeCalls).toBe(1); // closed, not silently kept open
  });

  test("an ack within the deadline resolves normally and never closes the subscription", async () => {
    const guarded = createOutstandingGuard<FakeRawSub>(50, (ms) => new Error(`timeout ${ms}`));
    const sub = new FakeRawSub();
    const got = await guarded(() => Promise.resolve(sub));
    expect(got).toBe(sub);
    expect(sub.closeCalls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// End-to-end reproduction through the REAL retry loop
// (`startPermissionAnswerWatch`/`runSubscription`/`scheduleReconnect`,
// src/agents/permission-answer-watch.ts — imported, not edited), matching
// the measurement FACTORY-751 (comment 30096/30108) ran independently:
// 20ms deadline, 5ms resubscribeDelayMs, watchdogThresholdMs: 0 (so the
// sibling FACTORY-749 (a)/(b) watchdog defect can never contaminate this
// number), over a herdr whose subscribe never acks. `scenario(opens)` below
// is the `subscribe` callback handed to `startPermissionAnswerWatch` for
// each case.
// ---------------------------------------------------------------------------

const AGENT_BASE = { agent: "claude" as const, focused: true, revision: 1, tab_id: "t1", terminal_id: "term1", workspace_id: "w1" };

function fakeClient(paneIds: readonly string[]): PermissionAnswerClient {
  return {
    agent: {
      list: async () => ({ type: "agent_list" as const, agents: paneIds.map((pane_id) => ({ ...AGENT_BASE, pane_id, agent_status: "blocked" as const })) }),
      get: (async () => { throw new Error("not used"); }) as PermissionAnswerClient["agent"]["get"],
      read: (async (p: { target: string }) => ({
        type: "pane_read" as const,
        read: { format: "text" as const, pane_id: p.target, revision: 1, source: "detection" as const, tab_id: "t1", text: "idle", truncated: false, workspace_id: "w1" },
      })) as PermissionAnswerClient["agent"]["read"],
      sendKeys: (async () => ({ type: "ok" as const })) as PermissionAnswerClient["agent"]["sendKeys"],
    },
  } as PermissionAnswerClient;
}

const onlyP1 = (agents: readonly PermissionAnswerPane[]): ReadonlyMap<string, string> =>
  new Map(agents.filter((a) => a.pane_id === "p1").map((a) => [a.pane_id, "lizard.json"]));

describe("FACTORY-751/FACTORY-775: subscribe-retry leak, reproduced through the real retry loop", () => {
  test("PRE-FIX shape (no outstanding guard) leaks unbounded open sockets — reproduces the epic's own measurement", async () => {
    // This is deliberately the OLD `withHerdrSubscribeDeadline` shape as
    // #682/FACTORY-722 added it — no outstanding-attempt guard — so this
    // test demonstrably FAILS (keeps leaking) exactly as the base commit
    // (a3e58223) does, rather than assuming it.
    let opened = 0;
    let closed = 0;
    const subscribeBase = (): Promise<PermissionAnswerSubscription> => {
      opened++;
      const raw = new Promise<void>(() => {}); // never acks
      return new Promise<PermissionAnswerSubscription>((_resolve, reject) => {
        let timedOut = false;
        const t = setTimeout(() => { timedOut = true; reject(new Error("no ack")); }, 20);
        raw.then(() => { clearTimeout(t); if (timedOut) closed++; });
      });
    };

    const client = fakeClient(["p1"]);
    const handle = startPermissionAnswerWatch(
      { client, eligiblePanes: onlyP1, auditPath: "/dev/null", resubscribeDelayMs: 5, watchdogThresholdMs: 0, subscribe: subscribeBase },
      1_000_000,
    );
    // Assert the INVARIANT the leak produces, not a timing-dependent count
    // (the epic's own measurement — opened=15, closed=0 over 400ms — is one
    // datapoint, not a bound this test should pin to under a possibly
    // loaded/slow host): wait, with a generous budget, for more than one
    // attempt to have opened at all, however long that takes.
    await waitFor(() => opened > 1, 10_000);
    handle.stop();
    expect(closed).toBe(0); // nothing this attempt opened was ever closed
  });

  test("POST-FIX (createOutstandingGuard) bounds opened to 1 — nothing piles up behind the first stuck attempt, however many times scheduleReconnect retries", async () => {
    let opened = 0;
    let closed = 0;
    let attempts = 0; // every call into subscribeFixed, whether or not it opens a new raw connection
    const guarded = createOutstandingGuard<{ close(): void }>(20, (ms) => new Error(`events.subscribe: no ack within ${ms}ms`));
    const subscribeFixed = (): Promise<PermissionAnswerSubscription> => {
      attempts++;
      return guarded(() => {
        opened++;
        return new Promise<{ close(): void }>(() => {}); // never acks — the SDK cannot abort this
      }).then((sub) => ({ [Symbol.asyncIterator]: () => (async function* () {})(), close: () => { closed++; sub.close(); } }));
    };

    const client = fakeClient(["p1"]);
    const handle = startPermissionAnswerWatch(
      { client, eligiblePanes: onlyP1, auditPath: "/dev/null", resubscribeDelayMs: 5, watchdogThresholdMs: 0, subscribe: subscribeFixed },
      1_000_000,
    );
    // Wait for several real retry attempts (whatever the host's actual
    // speed), then assert the bound holds regardless of how many of them
    // happened: at most one raw connection is EVER opened, no matter how
    // many times the retry loop calls back in.
    await waitFor(() => attempts > 3, 10_000);
    handle.stop();
    expect(opened).toBe(1);
    expect(closed).toBe(0); // nothing to close yet: the one attempt never acked
  });

  test("POST-FIX: once the outstanding attempt is accounted for (herdr eventually acks), a NEW attempt may open again", async () => {
    let opened = 0;
    const guarded = createOutstandingGuard<FakeRawSub>(20, (ms) => new Error(`timeout ${ms}`));
    let n = 0;
    const subscribeFixed = (): Promise<PermissionAnswerSubscription> =>
      guarded(() => {
        opened++;
        n++;
        if (n === 1) return new Promise<FakeRawSub>(() => {}); // first attempt never acks... but
        return Promise.resolve(new FakeRawSub()); // ...is forcibly settled below for this test
      }).then((sub) => ({ [Symbol.asyncIterator]: () => (async function* () {})(), close: () => sub.close() }));

    const client = fakeClient(["p1"]);
    const handle = startPermissionAnswerWatch(
      { client, eligiblePanes: onlyP1, auditPath: "/dev/null", resubscribeDelayMs: 5, watchdogThresholdMs: 0, subscribe: subscribeFixed },
      1_000_000,
    );
    await waitFor(() => opened >= 1);
    expect(opened).toBe(1); // stays at 1 while the first attempt is still outstanding
    handle.stop();
  });
});
