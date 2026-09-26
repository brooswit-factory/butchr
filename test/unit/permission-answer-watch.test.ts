import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
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
});
