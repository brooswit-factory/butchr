import { describe, expect, test } from "bun:test";
import type { JiraIssue, JiraRemoteLink } from "../../src/atlassian/types.js";
import { parseRules, type Rule } from "../../src/rules/rules.js";
import type { NotifyReason } from "../../src/resources/types.js";
import { createLinkedEventingState, jiraKindLinkedItems, type LinkedEventingDeps, type LinkedEventingMatch } from "../../src/jira-watch/linked-eventing.js";

const rule = (over: Partial<Record<string, unknown>> = {}): Rule =>
  parseRules({ rules: [{ id: "task", resourceProvider: "jira-work", query: "q", brief: "do it", linkedEventing: true, ...over }] })[0]!;

const issue = (key: string, over: Partial<JiraIssue> = {}): JiraIssue => ({
  key, status: "To Do", summary: `summary of ${key}`, issuetype: "Task", assignee: null, parent: null,
  updated: "2026-09-16T00:00:00.000+0000", labels: [], ...over,
});

const match = (agentKey: string, r: Rule, i: JiraIssue): LinkedEventingMatch => ({ agentKey, rule: r, issue: i });

/** A controllable fake of everything `runTick` depends on. */
function fakeDeps(world: Record<string, JiraIssue>, opts: {
  remoteLinksByKey?: Record<string, JiraRemoteLink[]>;
  suppress?: LinkedEventingDeps["suppress"];
  now?: { value: number };
} = {}) {
  const notified: Array<{ agent: string; about: string; reason: NotifyReason }> = [];
  const searchCalls: string[] = [];
  const remoteLinkCalls: string[] = [];
  const logs: string[] = [];
  const deps: LinkedEventingDeps = {
    search: async (jql) => {
      searchCalls.push(jql);
      const m = /^key in \((.*)\)$/.exec(jql);
      const keys = m ? m[1]!.split(",") : [];
      return keys.map((k) => world[k]).filter((i): i is JiraIssue => Boolean(i));
    },
    remoteLinks: async (key) => {
      remoteLinkCalls.push(key);
      return opts.remoteLinksByKey?.[key] ?? [];
    },
    ...(opts.suppress ? { suppress: opts.suppress } : {}),
    notify: async (agent, about, reason) => { notified.push({ agent, about, reason }); },
    log: (l) => logs.push(l),
    ...(opts.now ? { now: () => opts.now!.value } : {}),
  };
  return { deps, notified, searchCalls, remoteLinkCalls, logs };
}

describe("BUTCHR-436: linked-change eventing", () => {
  test("a real change to a linked Jira ticket produces exactly ONE notify to the owning agent", async () => {
    const owner = issue("BUTCHR-1", { issuelinks: [{ type: "Blocks", otherEnd: "outward", key: "BUTCHR-2" }] as never });
    const world: Record<string, JiraIssue> = { "BUTCHR-2": issue("BUTCHR-2", { status: "To Do", updated: "t1" }) };
    const state = createLinkedEventingState();
    const { deps, notified } = fakeDeps(world);

    // Poll 1: first sighting — seeds the baseline silently.
    await state.runTick([match("jira-work:task:BUTCHR-1", rule(), owner)], deps);
    expect(notified).toHaveLength(0);

    // Poll 2: a genuine change.
    world["BUTCHR-2"] = issue("BUTCHR-2", { status: "In Progress", updated: "t2" });
    await state.runTick([match("jira-work:task:BUTCHR-1", rule(), owner)], deps);
    expect(notified).toHaveLength(1);
    expect(notified[0]!.agent).toBe("jira-work:task:BUTCHR-1");
    const reason = notified[0]!.reason as { linked: { events: readonly { target: string; kind: string; detail: string }[] } };
    expect(reason.linked.events).toEqual([{ target: "BUTCHR-2", kind: "issuelink", detail: 'status changed from "To Do" to "In Progress" (as of t2)' }]);
  });

  test("a burst of N simultaneous linked changes in one tick produces exactly ONE coalesced message", async () => {
    const owner = issue("BUTCHR-1", {
      issuelinks: [
        { type: "Blocks", otherEnd: "outward", key: "BUTCHR-2" },
        { type: "Blocks", otherEnd: "outward", key: "BUTCHR-3" },
        { type: "Blocks", otherEnd: "outward", key: "BUTCHR-4" },
      ] as never,
    });
    const world: Record<string, JiraIssue> = {
      "BUTCHR-2": issue("BUTCHR-2"), "BUTCHR-3": issue("BUTCHR-3"), "BUTCHR-4": issue("BUTCHR-4"),
    };
    const state = createLinkedEventingState();
    const { deps, notified } = fakeDeps(world);
    await state.runTick([match("jira-work:task:BUTCHR-1", rule(), owner)], deps); // seed
    expect(notified).toHaveLength(0);

    world["BUTCHR-2"] = issue("BUTCHR-2", { status: "In Progress" });
    world["BUTCHR-3"] = issue("BUTCHR-3", { status: "In Review" });
    world["BUTCHR-4"] = issue("BUTCHR-4", { summary: "renamed" });
    await state.runTick([match("jira-work:task:BUTCHR-1", rule(), owner)], deps);
    expect(notified).toHaveLength(1);
    const reason = notified[0]!.reason as { linked: { events: readonly { target: string }[] } };
    expect(reason.linked.events.map((e) => e.target).sort()).toEqual(["BUTCHR-2", "BUTCHR-3", "BUTCHR-4"]);
  });

  // FACTORY-252: this test ONCE proved the hourly turn-rate cap suppressed a
  // delivery beyond its own max and caught it up once the window froze —
  // that cap (and the `[notify-suppressed] arm=rate-capped` line it logged)
  // is REMOVED entirely. Replaced with the DoD's own acceptance shape: more
  // deliveries than the former limit ever allowed, in the same hour, every
  // one delivered immediately with no suppression line at all.
  test("FACTORY-252: no turn-rate cap — three real changes to the same linked target in one hour all deliver immediately, with no [notify-suppressed] rate-capped line", async () => {
    const owner = issue("BUTCHR-1", { issuelinks: [{ type: "Blocks", otherEnd: "outward", key: "BUTCHR-2" }] as never });
    const world: Record<string, JiraIssue> = { "BUTCHR-2": issue("BUTCHR-2", { status: "To Do" }) };
    const state = createLinkedEventingState();
    const now = { value: 0 };
    const { deps, notified, logs } = fakeDeps(world, { now });
    const m = match("jira-work:task:BUTCHR-1", rule(), owner); // no maxLinkedTurnsPerHour knob exists any more

    await state.runTick([m], deps); // seed
    expect(notified).toHaveLength(0);

    for (const status of ["In Progress", "In Review", "Done"]) {
      world["BUTCHR-2"] = issue("BUTCHR-2", { status });
      now.value += 1_000; // all well within the same hour
      await state.runTick([m], deps);
    }
    expect(notified).toHaveLength(3); // every single one delivered, none withheld
    expect(logs.some((l) => l.includes("rate-capped"))).toBe(false);
  });

  // FACTORY-252: reproduction sketch from the historical BUTCHR-430/439/421
  // verification report, re-run against current code to confirm the
  // specific scenario it described — two real deliveries, then a further
  // real change, then NO further changes, then an hour passes — no longer
  // involves any cap/window/catch-up at all: the further change simply
  // delivers on the very next tick, immediately.
  test("FACTORY-252: the historical repro's own further change (after two earlier real deliveries) now delivers on the very next tick, no window wait needed", async () => {
    const owner = issue("BUTCHR-1", {
      issuelinks: [
        { type: "Blocks", otherEnd: "outward", key: "BUTCHR-2" },
        { type: "Blocks", otherEnd: "outward", key: "BUTCHR-3" },
      ] as never,
    });
    const world: Record<string, JiraIssue> = {
      "BUTCHR-2": issue("BUTCHR-2", { status: "To Do" }),
      "BUTCHR-3": issue("BUTCHR-3", { status: "To Do" }),
    };
    const state = createLinkedEventingState();
    const now = { value: 0 };
    const { deps, notified, logs } = fakeDeps(world, { now });
    const m = match("jira-work:task:BUTCHR-1", rule(), owner); // no maxLinkedTurnsPerHour knob exists any more

    await state.runTick([m], deps); // seed both baselines
    expect(notified).toHaveLength(0);

    // The two changes that, under the former cap, would have used both slots.
    world["BUTCHR-2"] = issue("BUTCHR-2", { status: "In Progress" });
    now.value += 11_000;
    await state.runTick([m], deps);
    world["BUTCHR-3"] = issue("BUTCHR-3", { status: "In Progress" });
    now.value += 11_000;
    await state.runTick([m], deps);
    expect(notified).toHaveLength(2);

    // The further change that, under the former cap, would have been held.
    world["BUTCHR-2"] = issue("BUTCHR-2", { status: "Done" });
    now.value += 20_000;
    await state.runTick([m], deps); // delivered immediately — no cap to hold it
    expect(notified).toHaveLength(3);
    const reason = notified[2]!.reason as { linked: { events: readonly { target: string; kind: string; detail: string }[] } };
    expect(reason.linked.events).toEqual([
      { target: "BUTCHR-2", kind: "issuelink", detail: 'status changed from "In Progress" to "Done" (as of 2026-09-16T00:00:00.000+0000)' },
    ]);
    expect(logs.some((l) => l.includes("rate-capped"))).toBe(false);
  });

  test("an agent's own edit to a linked ticket does not notify itself (own-write echo)", async () => {
    const owner = issue("BUTCHR-1", { issuelinks: [{ type: "Blocks", otherEnd: "outward", key: "BUTCHR-2" }] as never });
    const world: Record<string, JiraIssue> = { "BUTCHR-2": issue("BUTCHR-2", { status: "To Do", updated: "t1" }) };
    const state = createLinkedEventingState();
    const suppressed = new Set(["t2"]);
    const { deps, notified } = fakeDeps(world, { suppress: (key, updated, watcher) => key === "BUTCHR-2" && watcher === "jira-work:task:BUTCHR-1" && suppressed.has(updated) });
    const m = match("jira-work:task:BUTCHR-1", rule(), owner);

    await state.runTick([m], deps); // seed
    world["BUTCHR-2"] = issue("BUTCHR-2", { status: "In Progress", updated: "t2" }); // this agent's own write
    await state.runTick([m], deps);
    expect(notified).toHaveLength(0); // echo — suppressed

    // A later GENUINE third-party change is still detected against the post-echo state, not re-flagged as the echo itself.
    world["BUTCHR-2"] = issue("BUTCHR-2", { status: "Done", updated: "t3" });
    await state.runTick([m], deps);
    expect(notified).toHaveLength(1);
    const reason = notified[0]!.reason as { linked: { events: readonly { target: string; kind: string; detail: string }[] } };
    expect(reason.linked.events).toEqual([{ target: "BUTCHR-2", kind: "issuelink", detail: 'status changed from "In Progress" to "Done" (as of t3)' }]);
  });

  test("a daemon-label-only change on a linked ticket does not notify", async () => {
    const owner = issue("BUTCHR-1", { issuelinks: [{ type: "Blocks", otherEnd: "outward", key: "BUTCHR-2" }] as never });
    const world: Record<string, JiraIssue> = { "BUTCHR-2": issue("BUTCHR-2", { labels: ["agent:working"], updated: "t1" }) };
    const state = createLinkedEventingState();
    const { deps, notified } = fakeDeps(world);
    const m = match("jira-work:task:BUTCHR-1", rule(), owner);

    await state.runTick([m], deps); // seed
    // A real Jira label write always bumps `updated` too — status/summary stay put, only a daemon-owned label (and `updated`) moved.
    world["BUTCHR-2"] = issue("BUTCHR-2", { labels: ["agent:blocked"], updated: "t2" });
    await state.runTick([m], deps);
    expect(notified).toHaveLength(0);

    // A later change that ALSO touches a real field (not just daemon labels) still notifies normally — proves this isn't suppressing everything.
    world["BUTCHR-2"] = issue("BUTCHR-2", { status: "In Progress", labels: ["agent:blocked"], updated: "t3" });
    await state.runTick([m], deps);
    expect(notified).toHaveLength(1);
  });

  test("remote-link fetch happens only when both linkedRemoteLinks and linkedEventing are true; a non-opted-in resource makes zero remote-link calls", async () => {
    const optedIn = issue("BUTCHR-1");
    const notOptedIn = issue("BUTCHR-5");
    const world: Record<string, JiraIssue> = {};
    const state = createLinkedEventingState();
    const { deps, remoteLinkCalls } = fakeDeps(world, { remoteLinksByKey: { "BUTCHR-1": [{ id: "1", globalId: null, relationship: null, url: "https://wroosbit.atlassian.net/browse/BUTCHR-9", title: "t", applicationType: null }] } });

    const matches = [
      match("jira-work:task:BUTCHR-1", rule({ linkedRemoteLinks: true }), optedIn),
      match("jira-work:other:BUTCHR-5", rule({ id: "other" }), notOptedIn), // linkedEventing true, linkedRemoteLinks absent
    ];
    await state.runTick(matches, deps);
    expect(remoteLinkCalls).toEqual(["BUTCHR-1"]); // only the opted-in resource
  });

  test("an unreadable linked item is its own explicit line in the delivered message", async () => {
    const owner = issue("BUTCHR-1", { issuelinks: [{ type: "Blocks", otherEnd: "outward", key: "BUTCHR-404" }] as never });
    const world: Record<string, JiraIssue> = {}; // BUTCHR-404 never comes back from the batched fetch
    const state = createLinkedEventingState();
    const { deps, notified } = fakeDeps(world);
    await state.runTick([match("jira-work:task:BUTCHR-1", rule(), owner)], deps);
    expect(notified).toHaveLength(1);
    const reason = notified[0]!.reason as { linked: { events: readonly { target: string; kind: string; detail: string }[] } };
    expect(reason.linked.events).toEqual([{ target: "BUTCHR-404", kind: "issuelink", detail: "unreadable" }]);
  });

  test("a removed link is reported once as 'no longer linked' and never again while it stays absent", async () => {
    let withLink = true;
    const owner = () => issue("BUTCHR-1", { issuelinks: (withLink ? [{ type: "Blocks", otherEnd: "outward", key: "BUTCHR-2" }] : []) as never });
    const world: Record<string, JiraIssue> = { "BUTCHR-2": issue("BUTCHR-2") };
    const state = createLinkedEventingState();
    const { deps, notified } = fakeDeps(world);
    const r = rule();

    await state.runTick([match("jira-work:task:BUTCHR-1", r, owner())], deps); // seed, link present
    expect(notified).toHaveLength(0);
    await state.runTick([match("jira-work:task:BUTCHR-1", r, owner())], deps); // still present, unchanged
    expect(notified).toHaveLength(0);

    withLink = false;
    await state.runTick([match("jira-work:task:BUTCHR-1", r, owner())], deps); // removed
    expect(notified).toHaveLength(1);
    expect(notified[0]!.reason).toEqual({ linked: { events: [{ target: "BUTCHR-2", kind: "issuelink", detail: "no longer linked" }] } });

    await state.runTick([match("jira-work:task:BUTCHR-1", r, owner())], deps); // still absent — must not re-report
    expect(notified).toHaveLength(1);
  });

  test("FACTORY-833 (ask #2): a removed issuelink names its own provider link id, not just the target key — distinct links to distinct targets carry distinct ids", async () => {
    let withLinks = true;
    const owner = () => issue("BUTCHR-1", {
      issuelinks: (withLinks ? [
        { type: "Implements", otherEnd: "inward", key: "BUTCHR-2", id: "11502" },
        { type: "Implements", otherEnd: "inward", key: "BUTCHR-3", id: "12027" },
      ] : []) as never,
    });
    const world: Record<string, JiraIssue> = { "BUTCHR-2": issue("BUTCHR-2"), "BUTCHR-3": issue("BUTCHR-3") };
    const state = createLinkedEventingState();
    const { deps, notified } = fakeDeps(world);
    const r = rule();

    await state.runTick([match("jira-work:task:BUTCHR-1", r, owner())], deps); // seed
    expect(notified).toHaveLength(0);

    withLinks = false;
    await state.runTick([match("jira-work:task:BUTCHR-1", r, owner())], deps); // both removed in the same tick
    expect(notified).toHaveLength(1);
    const reason = notified[0]!.reason as { linked: { events: readonly { target: string; kind: string; detail: string; linkId?: string }[] } };
    expect([...reason.linked.events].sort((a, b) => a.target.localeCompare(b.target))).toEqual([
      { target: "BUTCHR-2", kind: "issuelink", detail: "no longer linked", linkId: "11502" },
      { target: "BUTCHR-3", kind: "issuelink", detail: "no longer linked", linkId: "12027" },
    ]);
  });

  test("FACTORY-833 (ask #2): an issuelink with no id (a test-fixture/legacy shape) never fabricates one — linkId absent, never invented", async () => {
    const owner = issue("BUTCHR-1", { issuelinks: [{ type: "Blocks", otherEnd: "outward", key: "BUTCHR-2" }] as never }); // no `id`
    const world: Record<string, JiraIssue> = { "BUTCHR-2": issue("BUTCHR-2", { status: "To Do" }) };
    const state = createLinkedEventingState();
    const { deps, notified } = fakeDeps(world);
    const m = match("jira-work:task:BUTCHR-1", rule(), owner);

    await state.runTick([m], deps); // seed
    world["BUTCHR-2"] = issue("BUTCHR-2", { status: "Done" });
    await state.runTick([m], deps);
    expect(notified).toHaveLength(1);
    const reason = notified[0]!.reason as { linked: { events: readonly { target: string; kind: string; detail: string; linkId?: string }[] } };
    expect(reason.linked.events[0]!.linkId).toBeUndefined();
    expect(Object.keys(reason.linked.events[0]!)).not.toContain("linkId");
  });

  test("FACTORY-833 (ask #3): a status change's detail names WHEN the issue's own `updated` field actually moved to, so a transition detected late never reads as freshly-happened", async () => {
    const owner = issue("BUTCHR-1", { issuelinks: [{ type: "Blocks", otherEnd: "outward", key: "BUTCHR-2" }] as never });
    const world: Record<string, JiraIssue> = { "BUTCHR-2": issue("BUTCHR-2", { status: "Backlog", updated: "t1" }) };
    const state = createLinkedEventingState();
    const { deps, notified } = fakeDeps(world);
    const m = match("jira-work:task:BUTCHR-1", rule(), owner);

    await state.runTick([m], deps); // seed
    // The real transition happened at "t2" (its own `updated`), but this
    // owner's tick doesn't run until much later — the detail must still
    // name "t2", not imply the transition is as fresh as this tick's own
    // wall-clock time.
    world["BUTCHR-2"] = issue("BUTCHR-2", { status: "Done", updated: "t2" });
    await state.runTick([m], deps);
    expect(notified).toHaveLength(1);
    const reason = notified[0]!.reason as { linked: { events: readonly { target: string; kind: string; detail: string }[] } };
    expect(reason.linked.events).toEqual([{ target: "BUTCHR-2", kind: "issuelink", detail: 'status changed from "Backlog" to "Done" (as of t2)' }]);
  });

  // FACTORY-252: these two tests ONCE held delivery with the hourly
  // turn-rate cap (now removed). The underlying mechanism they pin —
  // `observedAt`'s per-field frozen timestamps surviving a tick whose
  // delivery is held for some OTHER reason — is still load-bearing (see
  // this module's own "ADVANCE STATE ONLY ONCE GENUINELY CONSUMED" top
  // comment), so they now hold delivery via a failing batched search
  // instead (the one other mechanism that still defers a tick's advance).
  test("FACTORY-833: a target that keeps changing status while its tick's search fails reports the FINAL transition's own timestamp on delivery, not the first missed one", async () => {
    const owner = issue("BUTCHR-1", { issuelinks: [{ type: "Blocks", otherEnd: "outward", key: "BUTCHR-2" }] as never });
    const world: Record<string, JiraIssue> = { "BUTCHR-2": issue("BUTCHR-2", { status: "To Do", updated: "t1" }) };
    const state = createLinkedEventingState();
    let failSearch = false;
    const logs: string[] = [];
    const notified: Array<{ agent: string; about: string; reason: NotifyReason }> = [];
    const deps: LinkedEventingDeps = {
      search: async (jql) => {
        if (failSearch) throw new Error("transient");
        const m = /^key in \((.*)\)$/.exec(jql);
        const keys = m ? m[1]!.split(",") : [];
        return keys.map((k) => world[k]).filter((i): i is JiraIssue => Boolean(i));
      },
      notify: async (agent, about, reason) => { notified.push({ agent, about, reason }); },
      log: (l) => logs.push(l),
    };
    const m = match("jira-work:task:BUTCHR-1", rule(), owner);

    await state.runTick([m], deps); // seed
    world["BUTCHR-2"] = issue("BUTCHR-2", { status: "In Progress", updated: "t2" });
    await state.runTick([m], deps); // delivered immediately
    expect(notified).toHaveLength(1);

    // Two further real transitions land WHILE this tick's search is failing
    // — delayed, not lost; the diff this module coalesces is against the
    // LAST delivered baseline, so the eventual delivery reports the NET
    // transition (before -> final), with the FINAL transition's own
    // timestamp, never the intermediate "t3" or a fabricated "right now".
    failSearch = true;
    world["BUTCHR-2"] = issue("BUTCHR-2", { status: "In Review", updated: "t3" });
    await state.runTick([m], deps); // search fails — whole tick skipped
    world["BUTCHR-2"] = issue("BUTCHR-2", { status: "Done", updated: "t4" });
    await state.runTick([m], deps); // still failing
    expect(notified).toHaveLength(1);
    expect(logs.some((l) => l.includes("WARNING") && l.includes("batched linked-item fetch failed"))).toBe(true);

    failSearch = false;
    await state.runTick([m], deps); // delivered now
    expect(notified).toHaveLength(2);
    const reason = notified[1]!.reason as { linked: { events: readonly { target: string; kind: string; detail: string }[] } };
    expect(reason.linked.events).toEqual([{ target: "BUTCHR-2", kind: "issuelink", detail: 'status changed from "In Progress" to "Done" (as of t4)' }]);
  });

  // FACTORY-252: the ORIGINAL version of this test (PR #800 review round 2)
  // relied on the hourly rate cap updating `observedAt` every tick while
  // STILL withholding delivery across several ticks, so a status
  // transition's own frozen timestamp could be shown to survive a LATER
  // unrelated edit landing before eventual delivery. With the cap removed,
  // the only remaining mechanism that defers a tick's advance (a failing
  // batched search) ALSO skips observing anything that tick at all (see
  // "SEARCH FAILURE SKIPS THE WHOLE TICK" in this module's own top
  // comment) — so there is no longer any reachable path where a genuine
  // Jira-kind field change is observed on one tick, held, and then
  // overtaken by a DIFFERENT field's later edit before delivery. That
  // specific nuance test is therefore removed rather than approximated;
  // `changeDetail`'s own status-over-summary priority is still covered by
  // the FACTORY-833 (ask #3) test above and by the single-jump case in the
  // test immediately above this comment.

  test("FACTORY-833: two DISTINCT issuelinks (different relationship types) to the SAME target collapse to one watched item (existing dedup-by-target contract) and carry the FIRST link's own id, never a fabricated or merged one", async () => {
    const owner = issue("BUTCHR-1", {
      issuelinks: [
        { type: "Blocks", otherEnd: "outward", key: "BUTCHR-2", id: "100" },
        { type: "Relates", otherEnd: "outward", key: "BUTCHR-2", id: "200" },
      ] as never,
    });
    const world: Record<string, JiraIssue> = { "BUTCHR-2": issue("BUTCHR-2", { status: "To Do" }) };
    const state = createLinkedEventingState();
    const { deps, notified } = fakeDeps(world);
    const m = match("jira-work:task:BUTCHR-1", rule(), owner);

    await state.runTick([m], deps); // seed — one watcher, not two
    world["BUTCHR-2"] = issue("BUTCHR-2", { status: "Done" });
    await state.runTick([m], deps);
    expect(notified).toHaveLength(1); // ONE event line, not two, for the one target
    const reason = notified[0]!.reason as { linked: { events: readonly { target: string; kind: string; detail: string; linkId?: string }[] } };
    expect(reason.linked.events).toHaveLength(1);
    expect(reason.linked.events[0]!.linkId).toBe("100"); // first occurrence (Blocks) wins, same convention `discoverLinkedItems` already uses for kind
  });

  test("FACTORY-833 (review round 2, PR #800): removing ONE of two distinct links to the same target reports THAT specific link's removal, even though the target remains linked via the sibling", async () => {
    let bothLinks = true;
    const owner = () => issue("BUTCHR-1", {
      issuelinks: (bothLinks ? [
        { type: "Blocks", otherEnd: "outward", key: "BUTCHR-2", id: "100" },
        { type: "Relates", otherEnd: "outward", key: "BUTCHR-2", id: "200" },
      ] : [
        { type: "Relates", otherEnd: "outward", key: "BUTCHR-2", id: "200" },
      ]) as never,
    });
    const world: Record<string, JiraIssue> = { "BUTCHR-2": issue("BUTCHR-2", { status: "To Do" }) };
    const state = createLinkedEventingState();
    const { deps, notified } = fakeDeps(world);

    await state.runTick([match("jira-work:task:BUTCHR-1", rule(), owner())], deps); // seed: both 100 and 200 tracked
    expect(notified).toHaveLength(0);

    bothLinks = false; // remove link 100; BUTCHR-2 stays linked via 200
    await state.runTick([match("jira-work:task:BUTCHR-1", rule(), owner())], deps);
    expect(notified).toHaveLength(1);
    expect(notified[0]!.reason).toEqual({ linked: { events: [{ target: "BUTCHR-2", kind: "issuelink", detail: "no longer linked", linkId: "100" }] } });

    // Stays absent — must not re-report, and the target itself (still
    // linked via 200, unchanged) must not separately fire "no longer linked".
    await state.runTick([match("jira-work:task:BUTCHR-1", rule(), owner())], deps);
    expect(notified).toHaveLength(1);
  });

  test("FACTORY-833 (review round 2, PR #800): removing BOTH distinct links to the same target at once reports BOTH removals, not just one", async () => {
    let links: "both" | "none" = "both";
    const owner = () => issue("BUTCHR-1", {
      issuelinks: (links === "both" ? [
        { type: "Blocks", otherEnd: "outward", key: "BUTCHR-2", id: "100" },
        { type: "Relates", otherEnd: "outward", key: "BUTCHR-2", id: "200" },
      ] : []) as never,
    });
    const world: Record<string, JiraIssue> = { "BUTCHR-2": issue("BUTCHR-2", { status: "To Do" }) };
    const state = createLinkedEventingState();
    const { deps, notified } = fakeDeps(world);

    await state.runTick([match("jira-work:task:BUTCHR-1", rule(), owner())], deps); // seed
    expect(notified).toHaveLength(0);

    links = "none"; // both links gone; the target itself is now fully unlinked too
    await state.runTick([match("jira-work:task:BUTCHR-1", rule(), owner())], deps);
    expect(notified).toHaveLength(1);
    const reason = notified[0]!.reason as { linked: { events: readonly { target: string; kind: string; detail: string; linkId?: string }[] } };
    expect([...reason.linked.events].sort((a, b) => a.linkId!.localeCompare(b.linkId!))).toEqual([
      { target: "BUTCHR-2", kind: "issuelink", detail: "no longer linked", linkId: "100" },
      { target: "BUTCHR-2", kind: "issuelink", detail: "no longer linked", linkId: "200" },
    ]); // not just one — and not a third, generic target-level line alongside them

    await state.runTick([match("jira-work:task:BUTCHR-1", rule(), owner())], deps); // stays absent — must not re-report
    expect(notified).toHaveLength(1);
  });

  test("FACTORY-833 (review round 2, PR #800): adding a SECOND distinct link to an already-tracked target is silently seeded, never a spurious removal or duplicate event", async () => {
    let links: "one" | "two" = "one";
    const owner = () => issue("BUTCHR-1", {
      issuelinks: (links === "two" ? [
        { type: "Blocks", otherEnd: "outward", key: "BUTCHR-2", id: "100" },
        { type: "Relates", otherEnd: "outward", key: "BUTCHR-2", id: "200" },
      ] : [
        { type: "Blocks", otherEnd: "outward", key: "BUTCHR-2", id: "100" },
      ]) as never,
    });
    const world: Record<string, JiraIssue> = { "BUTCHR-2": issue("BUTCHR-2", { status: "To Do" }) };
    const state = createLinkedEventingState();
    const { deps, notified } = fakeDeps(world);

    await state.runTick([match("jira-work:task:BUTCHR-1", rule(), owner())], deps); // seed: just link 100
    expect(notified).toHaveLength(0);

    links = "two"; // a second, distinct link (200) is added to the same target
    await state.runTick([match("jira-work:task:BUTCHR-1", rule(), owner())], deps);
    expect(notified).toHaveLength(0); // silently seeded — no event for the new link, and no false removal of 100

    // Now removing ONLY 200 (the just-added one) must report ITS removal,
    // confirming it was genuinely tracked once added, not silently ignored.
    links = "one";
    await state.runTick([match("jira-work:task:BUTCHR-1", rule(), owner())], deps);
    expect(notified).toHaveLength(1);
    expect(notified[0]!.reason).toEqual({ linked: { events: [{ target: "BUTCHR-2", kind: "issuelink", detail: "no longer linked", linkId: "200" }] } });
  });

  test("maxLinkedItems is respected: a resource never polls more linked items than its cap, remote links included", async () => {
    const owner = issue("BUTCHR-1", {
      issuelinks: [
        { type: "Blocks", otherEnd: "outward", key: "BUTCHR-2" },
        { type: "Blocks", otherEnd: "outward", key: "BUTCHR-3" },
      ] as never,
    });
    const world: Record<string, JiraIssue> = { "BUTCHR-2": issue("BUTCHR-2"), "BUTCHR-3": issue("BUTCHR-3") };
    const state = createLinkedEventingState();
    const { deps, searchCalls } = fakeDeps(world);
    await state.runTick([match("jira-work:task:BUTCHR-1", rule({ maxLinkedItems: 1 }), owner)], deps);
    expect(searchCalls).toHaveLength(1);
    const requested = /^key in \((.*)\)$/.exec(searchCalls[0]!)![1]!.split(",");
    expect(requested).toEqual(["BUTCHR-2"]); // issuelinks kept in order; BUTCHR-3 capped out
  });

  test("a failed remote-links fetch for one owner fails open (logs a WARNING, that owner's remote links are simply skipped this tick) without blocking any other owner", async () => {
    const withBadRemote = issue("BUTCHR-1");
    const other = issue("BUTCHR-5", { issuelinks: [{ type: "Blocks", otherEnd: "outward", key: "BUTCHR-2" }] as never });
    const world: Record<string, JiraIssue> = { "BUTCHR-2": issue("BUTCHR-2") };
    const state = createLinkedEventingState();
    const { deps, notified, logs } = fakeDeps(world);
    deps.remoteLinks = async () => { throw new Error("403"); };
    const matches = [
      match("jira-work:task:BUTCHR-1", rule({ linkedRemoteLinks: true }), withBadRemote),
      match("jira-work:other:BUTCHR-5", rule({ id: "other" }), other),
    ];
    await state.runTick(matches, deps); // must not throw
    expect(logs.some((l) => l.includes("WARNING: [linked-eventing] remote-links fetch failed"))).toBe(true);
    expect(notified).toHaveLength(0); // nothing to report yet for either owner (seed poll)
  });

  test("FACTORY-833: a failed remote-links fetch, on a LATER tick, must not report an already-tracked remote-linked target as 'no longer linked'", async () => {
    const owner = issue("BUTCHR-1");
    const world: Record<string, JiraIssue> = { "BUTCHR-9": issue("BUTCHR-9") };
    const state = createLinkedEventingState();
    const remoteLink: JiraRemoteLink = { id: "1", globalId: null, relationship: null, url: "https://wroosbit.atlassian.net/browse/BUTCHR-9", title: "t", applicationType: null };
    const { deps, notified, logs } = fakeDeps(world, { remoteLinksByKey: { "BUTCHR-1": [remoteLink] } });
    const r = rule({ linkedRemoteLinks: true });

    await state.runTick([match("jira-work:task:BUTCHR-1", r, owner)], deps); // seed: BUTCHR-9 discovered via remote link, no prior baseline
    expect(notified).toHaveLength(0);
    await state.runTick([match("jira-work:task:BUTCHR-1", r, owner)], deps); // unchanged
    expect(notified).toHaveLength(0);

    // The remote-links fetch now fails transiently. Without BUTCHR-9's own
    // real link having been touched, this must NOT synthesize a "no longer
    // linked" for it — the target simply failed to re-fetch this tick, that
    // is not positive evidence of removal.
    deps.remoteLinks = async () => { throw new Error("timeout"); };
    await state.runTick([match("jira-work:task:BUTCHR-1", r, owner)], deps);
    expect(logs.some((l) => l.includes("WARNING: [linked-eventing] remote-links fetch failed"))).toBe(true);
    expect(notified).toHaveLength(0); // the false positive this ticket reports

    // Once the fetch recovers, BUTCHR-9 is still linked and unchanged — no
    // spurious "re-added" or "changed" event from the baseline having been
    // preserved through the failed tick.
    deps.remoteLinks = async (key) => [remoteLink].filter(() => key === "BUTCHR-1");
    await state.runTick([match("jira-work:task:BUTCHR-1", r, owner)], deps);
    expect(notified).toHaveLength(0);
  });

  test("FACTORY-833 (review round 1): a genuine removal that happens DURING a failed-fetch tick is still caught, exactly once, on the next successful tick — never lost, never repeated", async () => {
    const owner = issue("BUTCHR-1");
    const world: Record<string, JiraIssue> = { "BUTCHR-9": issue("BUTCHR-9") };
    const state = createLinkedEventingState();
    const remoteLink: JiraRemoteLink = { id: "1", globalId: null, relationship: null, url: "https://wroosbit.atlassian.net/browse/BUTCHR-9", title: "t", applicationType: null };
    let currentRemoteLinks: JiraRemoteLink[] = [remoteLink];
    const { deps, notified, logs } = fakeDeps(world, { remoteLinksByKey: { "BUTCHR-1": currentRemoteLinks } });
    const r = rule({ linkedRemoteLinks: true });

    await state.runTick([match("jira-work:task:BUTCHR-1", r, owner)], deps); // seed
    expect(notified).toHaveLength(0);

    // The fetch fails THIS tick. BUTCHR-9 is genuinely removed in the real
    // world during this same window, but that must not surface yet — the
    // tick has no trustworthy data to confirm it either way.
    deps.remoteLinks = async () => { throw new Error("timeout"); };
    currentRemoteLinks = [];
    await state.runTick([match("jira-work:task:BUTCHR-1", r, owner)], deps);
    expect(logs.some((l) => l.includes("WARNING: [linked-eventing] remote-links fetch failed"))).toBe(true);
    expect(notified).toHaveLength(0);

    // The fetch recovers and now genuinely reports BUTCHR-9 gone — the
    // watch set was left untouched during the failed tick, so this
    // comparison is against the last GENUINELY observed membership and
    // correctly reports the removal, exactly once.
    deps.remoteLinks = async () => currentRemoteLinks;
    await state.runTick([match("jira-work:task:BUTCHR-1", r, owner)], deps);
    expect(notified).toHaveLength(1);
    expect(notified[0]!.reason).toEqual({ linked: { events: [{ target: "BUTCHR-9", kind: "remote-link", detail: "no longer linked", linkId: "1" }] } });

    await state.runTick([match("jira-work:task:BUTCHR-1", r, owner)], deps); // still absent — must not re-report
    expect(notified).toHaveLength(1);
  });

  test("a failed batched linked-item search fails open (logs a WARNING and skips the tick — no notify, no false 'unreadable' report for a healthy link)", async () => {
    const owner = issue("BUTCHR-1", { issuelinks: [{ type: "Blocks", otherEnd: "outward", key: "BUTCHR-2" }] as never });
    const world: Record<string, JiraIssue> = { "BUTCHR-2": issue("BUTCHR-2") };
    const state = createLinkedEventingState();
    const { deps, notified, logs } = fakeDeps(world);
    deps.search = async () => { throw new Error("timeout"); };
    await state.runTick([match("jira-work:task:BUTCHR-1", rule(), owner)], deps); // must not throw
    expect(logs.some((l) => l.includes("WARNING: [linked-eventing] batched linked-item fetch failed"))).toBe(true);
    expect(notified).toHaveLength(0); // a search failure is not evidence the link is unreadable — skip, don't falsely report

    // Once the search recovers, the still-unseeded link is seeded silently (first sighting), same as any other first poll.
    deps.search = async (jql) => {
      const m = /^key in \((.*)\)$/.exec(jql);
      const keys = m ? m[1]!.split(",") : [];
      return keys.map((k) => world[k]).filter((i): i is JiraIssue => Boolean(i));
    };
    await state.runTick([match("jira-work:task:BUTCHR-1", rule(), owner)], deps);
    expect(notified).toHaveLength(0);
  });

  test("an unreadable link stays unreadable across several ticks but only notifies ONCE, on the transition — not every tick", async () => {
    const owner = issue("BUTCHR-1", { issuelinks: [{ type: "Blocks", otherEnd: "outward", key: "BUTCHR-404" }] as never });
    const world: Record<string, JiraIssue> = {}; // BUTCHR-404 never comes back from the batched fetch
    const state = createLinkedEventingState();
    const { deps, notified } = fakeDeps(world);
    const m = match("jira-work:task:BUTCHR-1", rule(), owner);

    await state.runTick([m], deps); // first sighting IS the transition into unreadable — triggers
    expect(notified).toHaveLength(1);
    expect(notified[0]!.reason).toEqual({ linked: { events: [{ target: "BUTCHR-404", kind: "issuelink", detail: "unreadable" }] } });

    await state.runTick([m], deps); // still unreadable, no transition — must not notify again
    await state.runTick([m], deps);
    await state.runTick([m], deps);
    expect(notified).toHaveLength(1); // unchanged across N further ticks

    // Once it becomes readable again, a later transition BACK to unreadable notifies again.
    world["BUTCHR-404"] = issue("BUTCHR-404");
    await state.runTick([m], deps); // becomes readable — seeds baseline silently, no notify
    expect(notified).toHaveLength(1);
    delete world["BUTCHR-404"];
    await state.runTick([m], deps); // unreadable again — a fresh transition
    expect(notified).toHaveLength(2);
  });

  test("a still-unreadable link rides along as context on a message a real change triggers, without itself causing a second notify", async () => {
    const owner = issue("BUTCHR-1", {
      issuelinks: [
        { type: "Blocks", otherEnd: "outward", key: "BUTCHR-404" },
        { type: "Blocks", otherEnd: "outward", key: "BUTCHR-2" },
      ] as never,
    });
    const world: Record<string, JiraIssue> = { "BUTCHR-2": issue("BUTCHR-2", { status: "To Do" }) }; // BUTCHR-404 stays unreadable throughout
    const state = createLinkedEventingState();
    const { deps, notified } = fakeDeps(world);
    const m = match("jira-work:task:BUTCHR-1", rule(), owner);

    await state.runTick([m], deps); // seed BUTCHR-2; BUTCHR-404's first sighting transitions into unreadable
    expect(notified).toHaveLength(1);
    expect(notified[0]!.reason).toEqual({ linked: { events: [{ target: "BUTCHR-404", kind: "issuelink", detail: "unreadable" }] } });

    world["BUTCHR-2"] = issue("BUTCHR-2", { status: "In Progress" });
    await state.runTick([m], deps); // BUTCHR-2's real change triggers; BUTCHR-404 (still unreadable, no transition) rides along as context
    expect(notified).toHaveLength(2);
    const reason = notified[1]!.reason as { linked: { events: readonly { target: string; kind: string; detail: string }[] } };
    expect(reason.linked.events).toEqual([
      { target: "BUTCHR-2", kind: "issuelink", detail: 'status changed from "To Do" to "In Progress" (as of 2026-09-16T00:00:00.000+0000)' },
      { target: "BUTCHR-404", kind: "issuelink", detail: "unreadable" },
    ]);
  });

  test("with no rule opted into linkedEventing, runTick makes zero calls of any kind", async () => {
    const owner = issue("BUTCHR-1", { issuelinks: [{ type: "Blocks", otherEnd: "outward", key: "BUTCHR-2" }] as never });
    const world: Record<string, JiraIssue> = { "BUTCHR-2": issue("BUTCHR-2") };
    const state = createLinkedEventingState();
    const { deps, searchCalls, remoteLinkCalls, notified } = fakeDeps(world);
    await state.runTick([match("jira-work:task:BUTCHR-1", rule({ linkedEventing: false }), owner)], deps);
    expect(searchCalls).toHaveLength(0);
    expect(remoteLinkCalls).toHaveLength(0);
    expect(notified).toHaveLength(0);
  });
});

describe("BUTCHR-472: de-dup Implements/outward pairs already covered by related:", () => {
  test("FALSIFIER/jiraKindLinkedItems: an Implements/outward target (already routed via related:) is excluded; other issuelink types and the inward Implements direction are unaffected", () => {
    const owner = issue("BUTCHR-1", {
      issuelinks: [
        { type: "Implements", otherEnd: "outward", key: "BUTCHR-2" }, // routed via related: — must be de-duplicated out of the linked path
        { type: "Implements", otherEnd: "inward", key: "BUTCHR-3" }, // reverse direction (this issue hearing its own boss) — deliberately unchanged
        { type: "Blocks", otherEnd: "outward", key: "BUTCHR-4" }, // non-Implements type — unaffected
      ] as never,
    });
    const items = jiraKindLinkedItems({ agentKey: "a", rule: rule(), issue: owner }, undefined);
    expect(items.map((i) => i.target).sort()).toEqual(["BUTCHR-3", "BUTCHR-4"]);
  });

  test("FALSIFIER/runTick: a boss with an Implements/outward worker gets no linked turn for that worker even on a real change, because related: already covers it", async () => {
    const boss = issue("BUTCHR-1", { issuelinks: [{ type: "Implements", otherEnd: "outward", key: "BUTCHR-2" }] as never });
    const world: Record<string, JiraIssue> = { "BUTCHR-2": issue("BUTCHR-2", { status: "To Do", updated: "t1" }) };
    const state = createLinkedEventingState();
    const { deps, notified } = fakeDeps(world);
    const m = match("jira-work:task:BUTCHR-1", rule(), boss);

    await state.runTick([m], deps); // seed (nothing to seed for BUTCHR-2 — excluded from the linked path entirely)
    expect(notified).toHaveLength(0);

    world["BUTCHR-2"] = issue("BUTCHR-2", { status: "In Progress", updated: "t2" });
    await state.runTick([m], deps);
    expect(notified).toHaveLength(0); // still nothing: this pair is de-duplicated, not just rate-capped
  });

  test("a boss's OTHER (non-Implements-outward) links still produce linked turns exactly as before, alongside a de-duplicated Implements/outward pair", async () => {
    const boss = issue("BUTCHR-1", {
      issuelinks: [
        { type: "Implements", otherEnd: "outward", key: "BUTCHR-2" }, // de-duplicated — related: already covers it
        { type: "Blocks", otherEnd: "outward", key: "BUTCHR-3" }, // unaffected
      ] as never,
    });
    const world: Record<string, JiraIssue> = {
      "BUTCHR-2": issue("BUTCHR-2", { status: "To Do", updated: "t1" }),
      "BUTCHR-3": issue("BUTCHR-3", { status: "To Do", updated: "t1" }),
    };
    const state = createLinkedEventingState();
    const { deps, notified } = fakeDeps(world);
    const m = match("jira-work:task:BUTCHR-1", rule(), boss);

    await state.runTick([m], deps); // seed
    expect(notified).toHaveLength(0);

    world["BUTCHR-2"] = issue("BUTCHR-2", { status: "In Progress", updated: "t2" });
    world["BUTCHR-3"] = issue("BUTCHR-3", { status: "In Progress", updated: "t2" });
    await state.runTick([m], deps);
    expect(notified).toHaveLength(1);
    const reason = notified[0]!.reason as { linked: { events: readonly { target: string }[] } };
    expect(reason.linked.events.map((e) => e.target)).toEqual(["BUTCHR-3"]); // BUTCHR-2 never appears — de-duplicated
  });

  test("a leaf task/bug agent (a plain Implements/inward link to its own boss, nothing outward) is unaffected: its linked changes still notify exactly as before", async () => {
    const leaf = issue("BUTCHR-1", {
      issuelinks: [
        { type: "Implements", otherEnd: "inward", key: "BUTCHR-BOSS" }, // this leaf's own boss — reverse direction, never in watchedKeys()
        { type: "Blocks", otherEnd: "outward", key: "BUTCHR-2" },
      ] as never,
    });
    const world: Record<string, JiraIssue> = {
      "BUTCHR-BOSS": issue("BUTCHR-BOSS", { status: "To Do", updated: "t1" }),
      "BUTCHR-2": issue("BUTCHR-2", { status: "To Do", updated: "t1" }),
    };
    const state = createLinkedEventingState();
    const { deps, notified } = fakeDeps(world);
    const m = match("jira-work:task:BUTCHR-1", rule(), leaf);

    await state.runTick([m], deps); // seed — both targets readable, nothing to report yet
    expect(notified).toHaveLength(0);

    world["BUTCHR-2"] = issue("BUTCHR-2", { status: "In Progress", updated: "t2" });
    await state.runTick([m], deps);
    expect(notified).toHaveLength(1); // leaf agents: zero overlap with related:, unaffected by this ticket

    world["BUTCHR-BOSS"] = issue("BUTCHR-BOSS", { status: "In Progress", updated: "t2" });
    await state.runTick([m], deps);
    expect(notified).toHaveLength(2); // its own boss's change still reaches it too — the reverse direction stays untouched
  });
});

describe("jiraKindLinkedItems", () => {
  test("issuelink/parent/description-jira-key are Jira-kind; confluence/github/webpage description links are excluded", () => {
    const owner: JiraIssue = issue("BUTCHR-1", {
      issuelinks: [{ type: "Blocks", otherEnd: "outward", key: "BUTCHR-2" }] as never,
      parent: "BUTCHR-421",
      description: "See BUTCHR-9 and https://example.com/docs and https://wroosbit.atlassian.net/wiki/spaces/X/pages/1",
    });
    const items = jiraKindLinkedItems({ agentKey: "a", rule: rule(), issue: owner }, undefined);
    expect(items.map((i) => i.kind).sort()).toEqual(["issuelink", "jira-key", "parent"]);
  });

  test("a remote link resolving to a Jira browse URL becomes a jira-kind item; a non-Jira remote link is excluded", () => {
    const owner: JiraIssue = issue("BUTCHR-1");
    const remoteLinks: JiraRemoteLink[] = [
      { id: "1", globalId: null, relationship: null, url: "https://wroosbit.atlassian.net/browse/BUTCHR-9", title: "t", applicationType: null },
      { id: "2", globalId: null, relationship: null, url: "https://github.com/brooswit-factory/butchr/pull/1", title: "t2", applicationType: null },
    ];
    const items = jiraKindLinkedItems({ agentKey: "a", rule: rule(), issue: owner }, remoteLinks);
    expect(items).toEqual([{ kind: "remote-link", target: "BUTCHR-9", linkId: "1" }]);
  });
});
