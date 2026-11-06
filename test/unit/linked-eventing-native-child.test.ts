import { describe, expect, test } from "bun:test";
import type { JiraComment, JiraIssue } from "../../src/atlassian/types.js";
import { parseRules, type Rule } from "../../src/rules/rules.js";
import type { NotifyReason } from "../../src/resources/types.js";
import { createLinkedEventingState, type LinkedEventingDeps, type LinkedEventingMatch } from "../../src/jira-watch/linked-eventing.js";

/**
 * FACTORY-1039 (epic FACTORY-770, implementing story FACTORY-251): native
 * Jira CHILD discovery for an Epic/Task owner — an Epic's attached Story/Task
 * (or a Task's own native subtask), reachable ONLY via the CHILD's own
 * `parent` field, never an `issuelink`. `test/unit/linked-eventing.test.ts`
 * already covers the UPWARD `parent`/`issuelink` paths this ticket does not
 * touch; this file covers what is NEW: the DOWNWARD `nativeChildren` dep
 * (`LinkedEventingDeps.nativeChildren`) and its own scope/dedup/cap/failure
 * contract.
 */

const rule = (over: Partial<Record<string, unknown>> = {}): Rule =>
  parseRules({ rules: [{ id: "task", resourceProvider: "jira-work", query: "q", brief: "do it", linkedEventing: true, ...over }] })[0]!;

const issue = (key: string, over: Partial<JiraIssue> = {}): JiraIssue => ({
  key, status: "To Do", summary: `summary of ${key}`, issuetype: "Task", assignee: null, parent: null,
  updated: "2026-09-16T00:00:00.000+0000", labels: [], ...over,
});

const match = (agentKey: string, r: Rule, i: JiraIssue): LinkedEventingMatch => ({ agentKey, rule: r, issue: i });
const linkedEvents = (n: NotifyReason) => (n as { linked: { events: readonly { target: string; kind: string; detail: string; linkId?: string }[] } }).linked.events;

const KEY_IN_RE = /^key in \((.*)\)$/;

/**
 * A controllable fake of `LinkedEventingDeps`, modelled on
 * `linked-eventing.test.ts`'s own `fakeDeps` and `linked-eventing-project.test.ts`'s
 * `fakeProjectDeps` — `childrenByParent` is a LIVE map (mutated directly by a
 * test between ticks, never re-passed), read fresh on every `nativeChildren`
 * call so a test can simulate a reparent/removal mid-run. `comments` is a
 * live map for the same reason.
 */
function fakeDeps(world: Record<string, JiraIssue>, opts: {
  childrenByParent?: Record<string, string[]>;
  comments?: Record<string, JiraComment[]>;
  failNativeChildrenFor?: Set<string>;
} = {}) {
  const notified: Array<{ agent: string; about: string; reason: NotifyReason }> = [];
  const searchCalls: string[] = [];
  const nativeChildCalls: string[] = [];
  const logs: string[] = [];
  const childrenByParent = opts.childrenByParent ?? {};
  const comments = opts.comments;
  const deps: LinkedEventingDeps = {
    search: async (jql) => {
      searchCalls.push(jql);
      const m = KEY_IN_RE.exec(jql);
      const keys = m ? m[1]!.split(",") : [];
      return keys.map((k) => world[k]).filter((i): i is JiraIssue => Boolean(i));
    },
    nativeChildren: async (key) => {
      nativeChildCalls.push(key);
      if (opts.failNativeChildrenFor?.has(key)) throw new Error(`native-child search offline for ${key}`);
      return (childrenByParent[key] ?? []).map((k) => world[k]).filter((i): i is JiraIssue => Boolean(i));
    },
    notify: async (agent, about, reason) => { notified.push({ agent, about, reason }); },
    log: (l) => logs.push(l),
    ...(comments ? { comments: async (key: string) => comments[key] ?? [] } : {}),
  };
  return { deps, notified, searchCalls, nativeChildCalls, logs };
}

describe("FACTORY-1039: native Jira child discovery for Epic/Task owners", () => {
  test("an Epic discovers a Story/Task child reachable ONLY via native parent (no issuelink) and wakes on its status change", async () => {
    const epic = issue("FACTORY-770", { issuetype: "Epic" });
    const world: Record<string, JiraIssue> = {
      "FACTORY-1039": issue("FACTORY-1039", { parent: "FACTORY-770", status: "To Do", updated: "t1" }),
    };
    const state = createLinkedEventingState();
    const { deps, notified, nativeChildCalls, searchCalls } = fakeDeps(world, { childrenByParent: { "FACTORY-770": ["FACTORY-1039"] } });

    // Poll 1: first sighting — seeded silently, same convention every other kind already has.
    await state.runTick([match("jira-work:epic:FACTORY-770", rule(), epic)], deps);
    expect(notified).toHaveLength(0);
    expect(nativeChildCalls).toEqual(["FACTORY-770"]);
    // The native-child discovery call never pollutes the shared batched `search` seam.
    expect(searchCalls.every((c) => KEY_IN_RE.test(c))).toBe(true);

    // Poll 2: a genuine change on the child.
    world["FACTORY-1039"] = issue("FACTORY-1039", { parent: "FACTORY-770", status: "In Progress", updated: "t2" });
    await state.runTick([match("jira-work:epic:FACTORY-770", rule(), epic)], deps);
    expect(notified).toHaveLength(1);
    expect(notified[0]!.agent).toBe("jira-work:epic:FACTORY-770");
    expect(linkedEvents(notified[0]!.reason)).toEqual([
      { target: "FACTORY-1039", kind: "native-child", detail: 'status changed from "To Do" to "In Progress" (as of t2)' },
    ]);
  });

  test("a Task discovers its own native subtask and wakes when a new comment lands on it", async () => {
    const task = issue("FACTORY-1039", { issuetype: "Task" });
    const world: Record<string, JiraIssue> = { "FACTORY-1041": issue("FACTORY-1041", { issuetype: "Subtask", parent: "FACTORY-1039" }) };
    const comments: Record<string, JiraComment[]> = { "FACTORY-1041": [] };
    const state = createLinkedEventingState();
    const { deps, notified, nativeChildCalls } = fakeDeps(world, { childrenByParent: { "FACTORY-1039": ["FACTORY-1041"] }, comments });

    await state.runTick([match("jira-work:task:FACTORY-1039", rule(), task)], deps); // seed
    expect(notified).toHaveLength(0);
    expect(nativeChildCalls).toEqual(["FACTORY-1039"]);

    comments["FACTORY-1041"] = [{ id: "c1", body: "status?", created: "2026-09-16T00:01:00.000+0000", authorEmail: null }];
    await state.runTick([match("jira-work:task:FACTORY-1039", rule(), task)], deps);
    expect(notified).toHaveLength(1);
    expect(linkedEvents(notified[0]!.reason)).toEqual([{ target: "FACTORY-1041", kind: "native-child", detail: "got a new comment (as of 2026-09-16T00:00:00.000+0000)" }]);
  });

  test("a Story owner never triggers native-child discovery at all (scoped to Epic/Task only)", async () => {
    const story = issue("FACTORY-900", { issuetype: "Story" });
    const world: Record<string, JiraIssue> = {};
    const state = createLinkedEventingState();
    const { deps, notified, nativeChildCalls } = fakeDeps(world, { childrenByParent: { "FACTORY-900": ["FACTORY-901"] } });

    await state.runTick([match("jira-work:story:FACTORY-900", rule(), story)], deps);
    expect(notified).toHaveLength(0);
    expect(nativeChildCalls).toEqual([]); // never called for a Story owner, not even to find nothing
  });

  test("linkedEventing disabled: an Epic with no linkedEventing opt-in never triggers native-child discovery", async () => {
    const epic = issue("FACTORY-770", { issuetype: "Epic" });
    const world: Record<string, JiraIssue> = { "FACTORY-1039": issue("FACTORY-1039", { parent: "FACTORY-770" }) };
    const state = createLinkedEventingState();
    const { deps, notified, nativeChildCalls } = fakeDeps(world, { childrenByParent: { "FACTORY-770": ["FACTORY-1039"] } });

    await state.runTick([match("jira-work:epic:FACTORY-770", rule({ linkedEventing: false }), epic)], deps);
    expect(notified).toHaveLength(0);
    expect(nativeChildCalls).toEqual([]);
  });

  test("explicit issuelink beats native-parent discovery of the same target: counted once, kind stays 'issuelink', never double-notified", async () => {
    const epic = issue("FACTORY-770", {
      issuetype: "Epic",
      issuelinks: [{ type: "Implements", otherEnd: "outward", key: "FACTORY-1039" }] as never,
    });
    const world: Record<string, JiraIssue> = { "FACTORY-1039": issue("FACTORY-1039", { parent: "FACTORY-770", status: "To Do" }) };
    const state = createLinkedEventingState();
    const { deps, notified } = fakeDeps(world, { childrenByParent: { "FACTORY-770": ["FACTORY-1039"] } });

    // FACTORY-1039 is BOTH an outward "Implements" link (already routed via
    // the pre-existing `related:` path, so excluded here) AND reachable via
    // the new native-child search — it must never surface as a SECOND,
    // native-child-kind item.
    await state.runTick([match("jira-work:epic:FACTORY-770", rule(), epic)], deps); // seed
    expect(notified).toHaveLength(0);

    world["FACTORY-1039"] = issue("FACTORY-1039", { parent: "FACTORY-770", status: "In Progress" });
    await state.runTick([match("jira-work:epic:FACTORY-770", rule(), epic)], deps);
    // "Implements"/outward is routed via `related:`, never `linked:` — so
    // THIS tick's own linked-eventing path reports nothing at all for it,
    // confirming it was never also tracked as a second, native-child item.
    expect(notified).toHaveLength(0);
  });

  test("explicit issuelink (not an Implements/outward boss link) beats native-parent discovery of the same target: one item, 'issuelink' kind, not 'native-child'", async () => {
    const epic = issue("FACTORY-770", {
      issuetype: "Epic",
      issuelinks: [{ type: "Relates", otherEnd: "outward", key: "FACTORY-1039" }] as never,
    });
    const world: Record<string, JiraIssue> = { "FACTORY-1039": issue("FACTORY-1039", { parent: "FACTORY-770", status: "To Do" }) };
    const state = createLinkedEventingState();
    const { deps, notified } = fakeDeps(world, { childrenByParent: { "FACTORY-770": ["FACTORY-1039"] } });

    await state.runTick([match("jira-work:epic:FACTORY-770", rule(), epic)], deps); // seed
    expect(notified).toHaveLength(0);

    world["FACTORY-1039"] = issue("FACTORY-1039", { parent: "FACTORY-770", status: "In Progress" });
    await state.runTick([match("jira-work:epic:FACTORY-770", rule(), epic)], deps);
    expect(notified).toHaveLength(1);
    // Exactly ONE event for FACTORY-1039 — the structured `issuelink` kind,
    // never a second `native-child` entry for the same target.
    expect(linkedEvents(notified[0]!.reason)).toEqual([
      { target: "FACTORY-1039", kind: "issuelink", detail: 'status changed from "To Do" to "In Progress" (as of 2026-09-16T00:00:00.000+0000)' },
    ]);
  });

  test("more native children than maxLinkedItems: the cap is enforced, the overflow is logged, never silently claimed as complete coverage", async () => {
    const epic = issue("FACTORY-770", { issuetype: "Epic" });
    const world: Record<string, JiraIssue> = {
      "FACTORY-1": issue("FACTORY-1", { parent: "FACTORY-770" }),
      "FACTORY-2": issue("FACTORY-2", { parent: "FACTORY-770" }),
      "FACTORY-3": issue("FACTORY-3", { parent: "FACTORY-770" }),
    };
    const state = createLinkedEventingState();
    const { deps, logs } = fakeDeps(world, { childrenByParent: { "FACTORY-770": ["FACTORY-1", "FACTORY-2", "FACTORY-3"] } });

    await state.runTick([match("jira-work:epic:FACTORY-770", rule({ maxLinkedItems: 2 }), epic)], deps);
    expect(logs.some((l) => l.includes("item cap") && l.includes("FACTORY-770") && l.includes("1 skipped"))).toBe(true);
  });

  test("a failed native-child search fails open: logs a WARNING, that owner's native children are simply skipped this tick, without blocking any other owner", async () => {
    const brokenEpic = issue("FACTORY-770", { issuetype: "Epic" });
    const okEpic = issue("FACTORY-999", { issuetype: "Epic" });
    const world: Record<string, JiraIssue> = {
      "FACTORY-1039": issue("FACTORY-1039", { parent: "FACTORY-770" }),
      "FACTORY-1040": issue("FACTORY-1040", { parent: "FACTORY-999" }),
    };
    const state = createLinkedEventingState();
    const { deps, notified, logs } = fakeDeps(world, {
      childrenByParent: { "FACTORY-770": ["FACTORY-1039"], "FACTORY-999": ["FACTORY-1040"] },
      failNativeChildrenFor: new Set(["FACTORY-770"]),
    });

    await state.runTick([
      match("jira-work:epic:FACTORY-770", rule(), brokenEpic),
      match("jira-work:epic:FACTORY-999", rule(), okEpic),
    ], deps);
    expect(notified).toHaveLength(0); // both still just seeding
    expect(logs.some((l) => l.includes("WARNING") && l.includes("native-child fetch failed") && l.includes("FACTORY-770"))).toBe(true);

    // The OK epic's child genuinely changes next tick and is reported normally.
    world["FACTORY-1040"] = issue("FACTORY-1040", { parent: "FACTORY-999", status: "In Progress" });
    await state.runTick([
      match("jira-work:epic:FACTORY-770", rule(), brokenEpic),
      match("jira-work:epic:FACTORY-999", rule(), okEpic),
    ], deps);
    expect(notified).toHaveLength(1);
    expect(notified[0]!.agent).toBe("jira-work:epic:FACTORY-999");
  });

  test("a failed native-child search never produces a false 'no longer linked' for a child seen on an earlier, successful tick", async () => {
    const epic = issue("FACTORY-770", { issuetype: "Epic" });
    const world: Record<string, JiraIssue> = { "FACTORY-1039": issue("FACTORY-1039", { parent: "FACTORY-770" }) };
    const state = createLinkedEventingState();
    const childrenByParent: Record<string, string[]> = { "FACTORY-770": ["FACTORY-1039"] };
    const failing = new Set<string>();
    const { deps, notified } = fakeDeps(world, { childrenByParent, failNativeChildrenFor: failing });
    const m = match("jira-work:epic:FACTORY-770", rule(), epic);

    await state.runTick([m], deps); // seed: FACTORY-1039 tracked
    expect(notified).toHaveLength(0);

    // The search now fails — FACTORY-1039 would otherwise vanish from `kept`
    // and read as a genuine removal, which it is not.
    failing.add("FACTORY-770");
    await state.runTick([m], deps);
    expect(notified).toHaveLength(0); // no false "no longer linked"

    // Recovery: the search succeeds again with the SAME child, unchanged —
    // still nothing to report (never a spurious re-add event either).
    failing.delete("FACTORY-770");
    await state.runTick([m], deps);
    expect(notified).toHaveLength(0);
  });

  test("reparent: a child whose parent moves away from this Epic is reported 'no longer linked' under the old owner, and silently seeded under the new one", async () => {
    const oldEpic = issue("FACTORY-770", { issuetype: "Epic" });
    const newEpic = issue("FACTORY-999", { issuetype: "Epic" });
    const world: Record<string, JiraIssue> = { "FACTORY-1039": issue("FACTORY-1039", { parent: "FACTORY-770" }) };
    const childrenByParent: Record<string, string[]> = { "FACTORY-770": ["FACTORY-1039"], "FACTORY-999": [] };
    const state = createLinkedEventingState();
    const { deps, notified } = fakeDeps(world, { childrenByParent });
    const matches = [match("jira-work:epic:FACTORY-770", rule(), oldEpic), match("jira-work:epic:FACTORY-999", rule(), newEpic)];

    await state.runTick(matches, deps); // seed: FACTORY-1039 tracked under the OLD epic only
    expect(notified).toHaveLength(0);

    // Reparent: FACTORY-1039 moves from FACTORY-770 to FACTORY-999.
    world["FACTORY-1039"] = issue("FACTORY-1039", { parent: "FACTORY-999" });
    childrenByParent["FACTORY-770"] = [];
    childrenByParent["FACTORY-999"] = ["FACTORY-1039"];
    await state.runTick(matches, deps);
    expect(notified).toHaveLength(1); // the OLD owner alone hears about the removal
    expect(notified[0]!.agent).toBe("jira-work:epic:FACTORY-770");
    expect(linkedEvents(notified[0]!.reason)).toEqual([{ target: "FACTORY-1039", kind: "native-child", detail: "no longer linked" }]);

    // The NEW owner's first sighting of it (already seeded in the SAME tick
    // the reparent above was observed) produced no event of its own — that
    // is already proven by the `toHaveLength(1)` check right above (the
    // removal under the OLD owner is the only thing it reported). A LATER,
    // genuine change under the NEW owner is still reported normally,
    // confirming that first sighting really did seed a live baseline rather
    // than leaving it unwatched.
    world["FACTORY-1039"] = issue("FACTORY-1039", { parent: "FACTORY-999", status: "In Progress" });
    await state.runTick(matches, deps);
    expect(notified).toHaveLength(2);
    expect(notified[1]!.agent).toBe("jira-work:epic:FACTORY-999");
    expect(linkedEvents(notified[1]!.reason)).toEqual([
      { target: "FACTORY-1039", kind: "native-child", detail: 'status changed from "To Do" to "In Progress" (as of 2026-09-16T00:00:00.000+0000)' },
    ]);
  });

  test("no second-hop wake: the native-child search is run ONLY against each owner's OWN key, never a child's own further children (ONE HOP ONLY)", async () => {
    // FACTORY-770 (Epic) -> FACTORY-1039 (Task, native child) -> FACTORY-1041 (Subtask, FACTORY-1039's own native child).
    // FACTORY-1039 is ALSO itself opted into linkedEventing as its own Task-owner match in the SAME tick.
    const epic = issue("FACTORY-770", { issuetype: "Epic" });
    const task = issue("FACTORY-1039", { issuetype: "Task", parent: "FACTORY-770" });
    const world: Record<string, JiraIssue> = {
      // FACTORY-770 must be in `world` too: the Task's own UPWARD `parent`
      // pointer (pre-existing discovery, unrelated to this ticket) makes it
      // one of the Task owner's own watched targets, fetched through the
      // SAME batched `key in (...)` search — omitting it here would read as
      // an immediately-unreadable target, not the silent first sighting
      // this test is actually about.
      "FACTORY-770": epic,
      "FACTORY-1039": task,
      "FACTORY-1041": issue("FACTORY-1041", { issuetype: "Subtask", parent: "FACTORY-1039" }),
    };
    const state = createLinkedEventingState();
    const { deps, notified, nativeChildCalls } = fakeDeps(world, {
      childrenByParent: { "FACTORY-770": ["FACTORY-1039"], "FACTORY-1039": ["FACTORY-1041"] },
    });

    await state.runTick([
      match("jira-work:epic:FACTORY-770", rule(), epic),
      match("jira-work:task:FACTORY-1039", rule(), task),
    ], deps); // seed
    expect(notified).toHaveLength(0);
    // Each owner's own key only — the Epic's search is never run again for
    // its child's key, and the grandchild (FACTORY-1041) is never
    // discovered by the Epic at all.
    expect(nativeChildCalls.sort()).toEqual(["FACTORY-1039", "FACTORY-770"]);

    // A change to the GRANDCHILD wakes the Task (its direct owner) only —
    // never the Epic, two hops away.
    world["FACTORY-1041"] = issue("FACTORY-1041", { issuetype: "Subtask", parent: "FACTORY-1039", status: "In Progress" });
    await state.runTick([
      match("jira-work:epic:FACTORY-770", rule(), epic),
      match("jira-work:task:FACTORY-1039", rule(), task),
    ], deps);
    expect(notified).toHaveLength(1);
    expect(notified[0]!.agent).toBe("jira-work:task:FACTORY-1039");
  });
});
