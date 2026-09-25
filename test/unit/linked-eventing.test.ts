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
    expect(reason.linked.events).toEqual([{ target: "BUTCHR-2", kind: "issuelink", detail: 'status changed from "To Do" to "In Progress"' }]);
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

  test("the rate cap suppresses beyond the max and logs [notify-suppressed] rate-capped; a suppressed change is still detected and delivered on the next allowed tick", async () => {
    const owner = issue("BUTCHR-1", { issuelinks: [{ type: "Blocks", otherEnd: "outward", key: "BUTCHR-2" }] as never });
    const world: Record<string, JiraIssue> = { "BUTCHR-2": issue("BUTCHR-2", { status: "To Do" }) };
    const state = createLinkedEventingState();
    const now = { value: 0 };
    const { deps, notified, logs } = fakeDeps(world, { now });
    const r = rule({ maxLinkedTurnsPerHour: 1 });
    const m = match("jira-work:task:BUTCHR-1", r, owner);

    await state.runTick([m], deps); // seed
    expect(notified).toHaveLength(0);

    world["BUTCHR-2"] = issue("BUTCHR-2", { status: "In Progress" });
    await state.runTick([m], deps); // uses the one allowed turn this hour
    expect(notified).toHaveLength(1);

    world["BUTCHR-2"] = issue("BUTCHR-2", { status: "Done" });
    await state.runTick([m], deps); // capped — dropped, not delivered
    expect(notified).toHaveLength(1); // still just the one from before
    expect(logs.some((l) => l.startsWith("[notify-suppressed]") && l.includes("arm=rate-capped") && l.includes("watcher=jira-work:task:BUTCHR-1"))).toBe(true);

    now.value += 61 * 60_000; // roll the sliding window over
    await state.runTick([m], deps); // the same outstanding change (Done, never delivered) is re-detected and delivered
    expect(notified).toHaveLength(2);
    const reason = notified[1]!.reason as { linked: { events: readonly { target: string; kind: string; detail: string }[] } };
    expect(reason.linked.events).toEqual([{ target: "BUTCHR-2", kind: "issuelink", detail: 'status changed from "In Progress" to "Done"' }]);
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
    expect(reason.linked.events).toEqual([{ target: "BUTCHR-2", kind: "issuelink", detail: 'status changed from "In Progress" to "Done"' }]);
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

  test("a failed batched linked-item search fails open (logs a WARNING; every requested target reads as unreadable this tick, same as one Jira silently omitted)", async () => {
    const owner = issue("BUTCHR-1", { issuelinks: [{ type: "Blocks", otherEnd: "outward", key: "BUTCHR-2" }] as never });
    const world: Record<string, JiraIssue> = { "BUTCHR-2": issue("BUTCHR-2") };
    const state = createLinkedEventingState();
    const { deps, notified, logs } = fakeDeps(world);
    deps.search = async () => { throw new Error("timeout"); };
    await state.runTick([match("jira-work:task:BUTCHR-1", rule(), owner)], deps); // must not throw
    expect(logs.some((l) => l.includes("WARNING: [linked-eventing] batched linked-item fetch failed"))).toBe(true);
    expect(notified).toHaveLength(1);
    expect(notified[0]!.reason).toEqual({ linked: { events: [{ target: "BUTCHR-2", kind: "issuelink", detail: "unreadable" }] } });
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
    expect(items).toEqual([{ kind: "remote-link", target: "BUTCHR-9" }]);
  });
});
