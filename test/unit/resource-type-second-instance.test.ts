import { describe, expect, test } from "bun:test";
import { runResourceLoop } from "../../src/daemon/loop.js";
import type { Herd } from "../../src/agents/herd.js";
import type { EventPoll, EventVerdict, ResourceType } from "../../src/resources/types.js";

/**
 * POSITIVE proof of BUTCHR-69 criterion 2 ("adding a second resource type
 * must not require editing the loop"), per the epic's ruling on this ticket:
 * a no-behaviour-change test suite can pass in full while the abstraction is
 * still secretly issue-specific underneath — that failure is invisible BY
 * CONSTRUCTION to a suite that only checks "nothing broke". This file is the
 * epic's requested POSITIVE check instead: a second, deliberately UNLIKE
 * resource type, exercised through `runResourceLoop` WITH THE LOOP
 * UNMODIFIED.
 *
 * This is NOT the project resource type (BUTCHR-67, still out of scope and
 * still not built here) — it is a throwaway fixture that exists only to
 * prove the seam admits a second implementer. It is deliberately unlike the
 * issue tier in the way that matters: a `JiraIssue` has `status`/`summary`/
 * `updated` fields the loop could (but does not) diff itself; a `Widget`
 * here has NONE of that — no status string, no `updated` timestamp, nothing
 * field-diffable. Its notion of "changed" is not carried by the object's own
 * fields at all — it comes from an external schedule the test controls
 * directly, standing in for something like a separately-polled Confluence
 * page-version endpoint (the real project type's actual shape, per the
 * epic's own example) that has nothing to do with the item's own value.
 *
 * The two tests below are the actual proof, not the fixture: (1) two polls
 * whose Widget arrays are BYTE-IDENTICAL still produce a notify, because the
 * type's own verdict says so — a loop secretly diffing `T` structurally could
 * never detect this. (2) two polls whose Widget arrays DIFFER produce NO
 * notify, because the type's own verdict says nothing changed — a loop
 * second-guessing the type with its own diff would wrongly notify anyway.
 * Both would fail if `runResourceLoop` ever started inspecting `T` itself
 * instead of trusting `eventRules.poll`'s verdict outright.
 */

/** A resource with nothing issue-shaped about it: no status, no summary, no updated, no labels — just an id and an arbitrary payload the type never looks at for change detection. */
interface Widget {
  id: string;
  payload: string;
}

function fakeHerd(): Herd & { spawned: string[]; stopped: string[]; notified: never[] } {
  const running = new Set<string>();
  const spawned: string[] = [];
  const stopped: string[] = [];
  return {
    spawned,
    stopped,
    notified: [],
    async runningIssues() {
      return [...running];
    },
    async staleIssues() {
      return [];
    },
    async spawn(sp) {
      spawned.push(sp.key);
      running.add(sp.key);
    },
    async stop(i) {
      stopped.push(i);
      running.delete(i);
    },
    async paneFor(i) {
      return running.has(i) ? `pane-${i}` : null;
    },
    async nudge() {
      return { delivered: true };
    },
  };
}

/**
 * Builds a `ResourceType<Widget>` whose `eventRules.poll` answers "what
 * changed" from a test-supplied schedule (`changedPerPoll`), completely
 * independent of whether the Widget arrays it's handed actually differ.
 * `activation.verdictFor` is likewise NOT a status-string check — it's an
 * arbitrary unconditional verdict, proving activation doesn't need
 * issue-shaped input either.
 *
 * BUTCHR-66/83 mechanical note: `Activation<T>`'s member was widened from a
 * boolean `isActive(resource)` to a three-state `verdictFor(resource):
 * ActivationVerdict` (sleep as a third answer to the same question, not a
 * fifth `ResourceType` member). This fixture never returns `"asleep"` — it
 * has no notion of rest — so `() => "active"` here is the exact same
 * unconditional verdict `() => true` was; nothing about what this test
 * proves changed.
 */
function widgetResourceType(polls: readonly Widget[][], changedPerPoll: readonly string[][]): ResourceType<Widget> {
  let searchCall = -1;
  let pollCall = 0;
  return {
    discovery: {
      idOf: (w) => w.id,
      search: async () => {
        searchCall++;
        return [...polls[Math.min(searchCall, polls.length - 1)]!];
      },
    },
    // Deliberately not a "status" string comparison — activation here is an
    // unconditional "every discovered widget is active", a different SHAPE
    // of predicate than the issue tier's `isActive(status)`.
    activation: { verdictFor: () => "active" },
    eventRules: {
      async poll(): Promise<EventPoll> {
        // The test's own schedule, NOT a diff of `prev`/`next` — this is the
        // point: the type is free to decide "changed" however it wants,
        // including from a source that has nothing to do with equality of
        // the T values the loop is holding.
        const changed = changedPerPoll[Math.min(pollCall, changedPerPoll.length - 1)] ?? [];
        pollCall++;
        return {
          changedPrimary: changed,
          changedRelated: [],
          async decide(): Promise<EventVerdict> {
            return { deliver: true };
          },
        };
      },
    },
    spawnConfig: {
      // An issuetype ("widget") the shared workspace.ts brief/model/effort
      // maps have never heard of — proves spawn config for a new type needs
      // no change to that shared machinery; it just falls through to its
      // existing DEFAULT case, unmodified.
      specFor: (w) => ({ key: w.id, issuetype: "widget", summary: w.payload, parent: null }),
    },
  };
}

describe("a second, deliberately non-issue-shaped resource type — runResourceLoop UNMODIFIED (BUTCHR-69 criterion 2, positive proof)", () => {
  test("byte-identical polls still notify when the type's OWN verdict says changed — a loop that diffed T itself could never see this", async () => {
    const herd = fakeHerd();
    const notified: string[] = [];
    // Poll 1 -> poll 2: W1 is BYTE-IDENTICAL. A second, ticking widget rides
    // along too, but says nothing about W1 either — since BUTCHR-57's `hash`
    // override on `runResourceLoop`'s own `watch()` call forces `onChange` to
    // run on EVERY poll tick regardless of whether the fetched snapshot's
    // content actually differs, TICK is no longer load-bearing for onChange
    // to re-run; it stays only as a second, deliberately-ignored resource,
    // reinforcing that the type's OWN verdict — not the loop's own diffing —
    // is what decides "changed".
    const polls: Widget[][] = [
      [{ id: "W1", payload: "same" }, { id: "TICK", payload: "0" }],
      [{ id: "W1", payload: "same" }, { id: "TICK", payload: "1" }],
    ];
    // `changedPerPoll` has one entry, clamped by `Math.min(pollCall, ...)` in
    // `widgetResourceType` above, so every onChange call — however many the
    // hash override drives across this test's ~60ms window — answers with
    // the same verdict: W1 changed, TICK didn't.
    const resourceType = widgetResourceType(polls, [["W1"]]);
    const stop = runResourceLoop(resourceType, {
      herd,
      notify: (issue) => {
        notified.push(issue);
      },
      intervalMs: 10,
    });
    await new Promise((r) => setTimeout(r, 60));
    stop();
    expect(notified).toContain("W1");
    expect(notified).not.toContain("TICK"); // the type never named TICK as changed
  });

  test("differing polls produce NO notify when the type's OWN verdict says unchanged — a loop that second-guessed the type would wrongly notify", async () => {
    const herd = fakeHerd();
    const notified: string[] = [];
    // W2's payload DOES change between polls, but the type's schedule below
    // never lists it as changed — if the loop computed its own diff and
    // notified on that instead of trusting the verdict, this would fail.
    const polls: Widget[][] = [
      [{ id: "W2", payload: "v1" }],
      [{ id: "W2", payload: "v2" }],
    ];
    const resourceType = widgetResourceType(polls, [[]]);
    const stop = runResourceLoop(resourceType, {
      herd,
      notify: (issue) => {
        notified.push(issue);
      },
      intervalMs: 10,
    });
    await new Promise((r) => setTimeout(r, 60));
    stop();
    expect(notified).toEqual([]);
  });

  test("activation (not a status string) still drives spawn/stop through the unmodified reconciler", async () => {
    const herd = fakeHerd();
    let active = true;
    const resourceType: ResourceType<Widget> = {
      discovery: { idOf: (w) => w.id, search: async () => (active ? [{ id: "W3", payload: "x" }] : []) },
      activation: { verdictFor: () => "active" },
      eventRules: { async poll() { return { changedPrimary: [], changedRelated: [], async decide() { return { deliver: false }; } }; } },
      spawnConfig: { specFor: (w) => ({ key: w.id, issuetype: "widget", summary: w.payload, parent: null }) },
    };
    const stop = runResourceLoop(resourceType, { herd, notify: () => {}, intervalMs: 10 });
    await new Promise((r) => setTimeout(r, 30));
    expect(herd.spawned).toContain("W3");
    active = false;
    await new Promise((r) => setTimeout(r, 30));
    stop();
    expect(herd.stopped).toContain("W3");
  });
});
