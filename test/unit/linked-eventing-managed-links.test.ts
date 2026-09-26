import { describe, expect, test } from "bun:test";
import type { IssueLink, JiraComment, JiraIssue } from "../../src/atlassian/types.js";
import { parseRules, type Rule } from "../../src/rules/rules.js";
import type { NotifyReason } from "../../src/resources/types.js";
import { createLinkedEventingState, type LinkedEventingDeps, type LinkedEventingMatch } from "../../src/jira-watch/linked-eventing.js";
import { createRuleResourceType, type RuleMatch } from "../../src/rules/resource-type.js";
import { addLink, removeLink, type LinkStore } from "../../src/resources/link-store.js";
import { parseResourceRef, type ResourceRef } from "../../src/resources/resource-ref.js";

/**
 * FACTORY-9 (implements FACTORY-6, epic FACTORY-3, story 3/3): wires
 * FACTORY-4's link model (ResourceRef / mergeEffectiveLinks / LinkStore)
 * into the EXISTING BUTCHR-436/437 linked-eventing notify path — this file
 * covers what THIS story adds: managed links reconciled into watchers,
 * cache/snapshot teardown on removal, Jira comment detection, and the
 * FACTORY-1 regression class re-proven for this new path. Everything else
 * (coalescing, the rate cap, Jira status/summary diffing, the three
 * BUTCHR-437 pollers) is already covered by test/unit/linked-eventing.test.ts
 * and test/unit/linked-eventing-external.test.ts and is reused UNCHANGED
 * here, never re-tested.
 */

const ref = (s: string): ResourceRef => parseResourceRef(s);

function fakeLinkStore(initial: Record<string, string[]> = {}): LinkStore {
  const data: Record<string, string[]> = structuredClone(initial);
  return {
    async list(ownerKey) { return data[ownerKey] ?? []; },
    async add(ownerKey, targetKey) {
      const existing = data[ownerKey] ?? [];
      if (existing.includes(targetKey)) return false;
      data[ownerKey] = [...existing, targetKey];
      return true;
    },
    async remove(ownerKey, targetKey) {
      const existing = data[ownerKey] ?? [];
      if (!existing.includes(targetKey)) return false;
      data[ownerKey] = existing.filter((t) => t !== targetKey);
      return true;
    },
  };
}

const rule = (over: Partial<Record<string, unknown>> = {}): Rule =>
  parseRules({ rules: [{ id: "task", resourceProvider: "jira-work", query: "q", brief: "do it", linkedEventing: true, ...over }] })[0]!;

const issue = (key: string, over: Partial<JiraIssue> = {}): JiraIssue => ({
  key, status: "To Do", summary: `summary of ${key}`, issuetype: "Task", assignee: null, parent: null,
  updated: "2026-09-16T00:00:00.000+0000", labels: [], ...over,
});

const match = (agentKey: string, r: Rule, i: JiraIssue): LinkedEventingMatch => ({ agentKey, rule: r, issue: i });
const linkedEvents = (n: NotifyReason) => (n as { linked: { events: readonly { target: string; kind: string; detail: string }[] } }).linked.events;

function fakeDeps(world: Record<string, JiraIssue>, opts: {
  linkStore?: LinkStore;
  commentsByKey?: Record<string, JiraComment[]>;
  now?: { value: number };
} = {}) {
  const notified: Array<{ agent: string; about: string; reason: NotifyReason }> = [];
  const logs: string[] = [];
  const commentCalls: string[] = [];
  const deps: LinkedEventingDeps = {
    search: async (jql) => {
      const m = /^key in \((.*)\)$/.exec(jql);
      const keys = m ? m[1]!.split(",") : [];
      return keys.map((k) => world[k]).filter((i): i is JiraIssue => Boolean(i));
    },
    notify: async (agent, about, reason) => { notified.push({ agent, about, reason }); },
    log: (l) => logs.push(l),
    ...(opts.linkStore ? { linkStore: opts.linkStore } : {}),
    ...(opts.commentsByKey ? { comments: async (key: string) => { commentCalls.push(key); return opts.commentsByKey![key] ?? []; } } : {}),
    ...(opts.now ? { now: () => opts.now!.value } : {}),
  };
  return { deps, notified, logs, commentCalls };
}

describe("FACTORY-9: managed links reconciled into watchers via the existing linked-eventing path", () => {
  test("adding a managed link (no native overlap) creates a watcher: first tick seeds silently, a later real change delivers exactly one event", async () => {
    const owner = issue("BUTCHR-1");
    const store = fakeLinkStore();
    await addLink(store, ref("jira-work-item:BUTCHR-1"), ref("jira-work-item:BUTCHR-2"));
    const world: Record<string, JiraIssue> = { "BUTCHR-2": issue("BUTCHR-2", { status: "To Do" }) };
    const state = createLinkedEventingState();
    const { deps, notified } = fakeDeps(world, { linkStore: store });
    const m = match("jira-work:task:BUTCHR-1", rule(), owner);

    await state.runTick([m], deps); // seed
    expect(notified).toHaveLength(0);

    world["BUTCHR-2"] = issue("BUTCHR-2", { status: "In Progress" });
    await state.runTick([m], deps);
    expect(notified).toHaveLength(1);
    expect(linkedEvents(notified[0]!.reason)).toEqual([{ target: "BUTCHR-2", kind: "jira-key", detail: 'status changed from "To Do" to "In Progress"' }]);
  });

  test("no linkStore wired: managed links are never reconciled (the existing 'omitted dep' shape) — zero behavior change for callers/tests that don't set it", async () => {
    const owner = issue("BUTCHR-1");
    const store = fakeLinkStore();
    await addLink(store, ref("jira-work-item:BUTCHR-1"), ref("jira-work-item:BUTCHR-2"));
    const world: Record<string, JiraIssue> = { "BUTCHR-2": issue("BUTCHR-2") };
    const state = createLinkedEventingState();
    const { deps, notified } = fakeDeps(world); // linkStore omitted
    await state.runTick([match("jira-work:task:BUTCHR-1", rule(), owner)], deps);
    world["BUTCHR-2"] = issue("BUTCHR-2", { status: "In Progress" });
    await state.runTick([match("jira-work:task:BUTCHR-1", rule(), owner)], deps);
    expect(notified).toHaveLength(0); // BUTCHR-2 was never watched at all
  });

  test("a managed link duplicating an existing native issuelink is not double-watched — one event, kind 'issuelink' (native wins), not 'jira-key'", async () => {
    const owner = issue("BUTCHR-1", { issuelinks: [{ type: "Blocks", otherEnd: "outward", key: "BUTCHR-2" } as IssueLink] });
    const store = fakeLinkStore();
    await addLink(store, ref("jira-work-item:BUTCHR-1"), ref("jira-work-item:BUTCHR-2")); // same target, already native
    const world: Record<string, JiraIssue> = { "BUTCHR-2": issue("BUTCHR-2", { status: "To Do" }) };
    const state = createLinkedEventingState();
    const { deps, notified } = fakeDeps(world, { linkStore: store });
    const m = match("jira-work:task:BUTCHR-1", rule(), owner);

    await state.runTick([m], deps);
    world["BUTCHR-2"] = issue("BUTCHR-2", { status: "In Progress" });
    await state.runTick([m], deps);
    expect(notified).toHaveLength(1); // not two — the managed duplicate produced no second watcher
    expect(linkedEvents(notified[0]!.reason)).toEqual([{ target: "BUTCHR-2", kind: "issuelink", detail: 'status changed from "To Do" to "In Progress"' }]);
  });

  test("no-change tick and the SAME outstanding change across two ticks both produce no duplicate notify", async () => {
    const owner = issue("BUTCHR-1");
    const store = fakeLinkStore();
    await addLink(store, ref("jira-work-item:BUTCHR-1"), ref("jira-work-item:BUTCHR-2"));
    const world: Record<string, JiraIssue> = { "BUTCHR-2": issue("BUTCHR-2", { status: "To Do" }) };
    const state = createLinkedEventingState();
    const { deps, notified } = fakeDeps(world, { linkStore: store });
    const m = match("jira-work:task:BUTCHR-1", rule(), owner);

    await state.runTick([m], deps); // seed
    await state.runTick([m], deps); // no change
    expect(notified).toHaveLength(0);

    world["BUTCHR-2"] = issue("BUTCHR-2", { status: "In Progress" });
    await state.runTick([m], deps); // the change
    await state.runTick([m], deps); // same state again — already advanced, no repeat
    expect(notified).toHaveLength(1);
  });

  test("two owners linking the same target each hear it independently (per-(owner,target) baseline)", async () => {
    const ownerA = issue("BUTCHR-1");
    const ownerB = issue("BUTCHR-5");
    const store = fakeLinkStore();
    await addLink(store, ref("jira-work-item:BUTCHR-1"), ref("jira-work-item:BUTCHR-9"));
    await addLink(store, ref("jira-work-item:BUTCHR-5"), ref("jira-work-item:BUTCHR-9"));
    const world: Record<string, JiraIssue> = { "BUTCHR-9": issue("BUTCHR-9", { status: "To Do" }) };
    const state = createLinkedEventingState();
    const { deps, notified } = fakeDeps(world, { linkStore: store });
    const matches = [match("jira-work:task:BUTCHR-1", rule(), ownerA), match("jira-work:task:BUTCHR-5", rule({ id: "other" }), ownerB)];

    await state.runTick(matches, deps); // both seed
    expect(notified).toHaveLength(0);
    world["BUTCHR-9"] = issue("BUTCHR-9", { status: "In Progress" });
    await state.runTick(matches, deps);
    expect(notified.map((n) => n.agent).sort()).toEqual(["jira-work:task:BUTCHR-1", "jira-work:task:BUTCHR-5"]);
  });

  test("removing a managed link tears down its watcher — 'no longer linked' fires once; re-adding later reseeds silently instead of firing a spurious change from a stale baseline", async () => {
    const owner = issue("BUTCHR-1");
    const store = fakeLinkStore();
    const ownerRef = ref("jira-work-item:BUTCHR-1");
    const targetRef = ref("jira-work-item:BUTCHR-2");
    await addLink(store, ownerRef, targetRef);
    const world: Record<string, JiraIssue> = { "BUTCHR-2": issue("BUTCHR-2", { status: "To Do" }) };
    const state = createLinkedEventingState();
    const { deps, notified } = fakeDeps(world, { linkStore: store });
    const m = match("jira-work:task:BUTCHR-1", rule(), owner);

    await state.runTick([m], deps); // seed
    expect(notified).toHaveLength(0);

    await removeLink(store, ownerRef, targetRef);
    await state.runTick([m], deps); // removal detected
    expect(notified).toHaveLength(1);
    expect(linkedEvents(notified[0]!.reason)).toEqual([{ target: "BUTCHR-2", kind: "jira-key", detail: "no longer linked" }]);

    await state.runTick([m], deps); // stays absent — must not re-report
    expect(notified).toHaveLength(1);

    // The target changes several times WHILE the link is absent — nothing to
    // notify (not watched), and critically nothing that would show up as a
    // "change" the instant it's re-added.
    world["BUTCHR-2"] = issue("BUTCHR-2", { status: "In Review" });

    await addLink(store, ownerRef, targetRef);
    await state.runTick([m], deps); // re-added: must reseed silently, NOT fire a spurious "changed from To Do to In Review"
    expect(notified).toHaveLength(1); // unchanged — no spurious event

    world["BUTCHR-2"] = issue("BUTCHR-2", { status: "Done" });
    await state.runTick([m], deps); // a genuine change against the FRESH baseline
    expect(notified).toHaveLength(2);
    expect(linkedEvents(notified[1]!.reason)).toEqual([{ target: "BUTCHR-2", kind: "jira-key", detail: 'status changed from "In Review" to "Done"' }]);
  });

  test("a managed link to a confluence-page target (bare id) is watched via the existing Confluence poller", async () => {
    const owner = issue("BUTCHR-1");
    const store = fakeLinkStore();
    await addLink(store, ref("jira-work-item:BUTCHR-1"), ref("confluence-page:999"));
    const world: Record<string, JiraIssue> = {};
    const state = createLinkedEventingState();
    const { deps, notified } = fakeDeps(world, { linkStore: store });
    const version = { value: 3 };
    deps.confluenceVersion = async (pageId) => (pageId === "999" ? { ok: true as const, version: version.value } : { ok: false as const, transient: false as const, httpStatus: 404 });
    const m = match("jira-work:task:BUTCHR-1", rule(), owner);

    await state.runTick([m], deps); // seed
    expect(notified).toHaveLength(0);
    version.value = 4;
    await state.runTick([m], deps);
    expect(notified).toHaveLength(1);
    expect(linkedEvents(notified[0]!.reason)).toEqual([{ target: "999", kind: "confluence", detail: "version changed from 3 to 4" }]);
  });

  test("a managed link to a filesystem target is watched via the new filesystem poller (mtime+size fingerprint)", async () => {
    const owner = issue("BUTCHR-1");
    const store = fakeLinkStore();
    await addLink(store, ref("jira-work-item:BUTCHR-1"), ref("filesystem:/srv/factory/notes.md"));
    const world: Record<string, JiraIssue> = {};
    const state = createLinkedEventingState();
    const { deps, notified } = fakeDeps(world, { linkStore: store });
    const st = { mtimeMs: 1000, size: 10 };
    deps.filesystem = { stat: async (p) => (p === "/srv/factory/notes.md" ? { mtimeMs: st.mtimeMs, size: st.size, isDirectory: () => false } : (() => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); })()) };
    const m = match("jira-work:task:BUTCHR-1", rule(), owner);

    await state.runTick([m], deps); // seed
    expect(notified).toHaveLength(0);
    st.mtimeMs = 2000;
    await state.runTick([m], deps);
    expect(notified).toHaveLength(1);
    expect(linkedEvents(notified[0]!.reason)).toEqual([{ target: "/srv/factory/notes.md", kind: "filesystem", detail: "changed" }]);
  });

  test("a managed link to a jira-project target is silently skipped: never watched, never crashes, logged once", async () => {
    const owner = issue("BUTCHR-1");
    const store = fakeLinkStore();
    await addLink(store, ref("jira-work-item:BUTCHR-1"), ref("jira-project:BUTCHR"));
    const world: Record<string, JiraIssue> = {};
    const state = createLinkedEventingState();
    const { deps, notified, logs } = fakeDeps(world, { linkStore: store });
    await state.runTick([match("jira-work:task:BUTCHR-1", rule(), owner)], deps); // must not throw
    expect(notified).toHaveLength(0);
    expect(logs.some((l) => l.includes("jira-project:BUTCHR") && l.includes("unsupported"))).toBe(true);
  });

  test("a broken link store fails open for its own owner without blocking any other owner's tick", async () => {
    const bad = issue("BUTCHR-1");
    const good = issue("BUTCHR-5");
    const store: LinkStore = {
      list: async (ownerKey) => { if (ownerKey === "jira-work-item:BUTCHR-1") throw new Error("disk error"); return []; },
      add: async () => true,
      remove: async () => true,
    };
    const world: Record<string, JiraIssue> = {};
    const state = createLinkedEventingState();
    const { deps, notified, logs } = fakeDeps(world, { linkStore: store });
    const matches = [match("jira-work:task:BUTCHR-1", rule(), bad), match("jira-work:other:BUTCHR-5", rule({ id: "other" }), good)];
    await state.runTick(matches, deps); // must not throw
    expect(logs.some((l) => l.includes("WARNING: [linked-eventing] managed-link fetch failed") && l.includes("BUTCHR-1"))).toBe(true);
    expect(notified).toHaveLength(0); // nothing to report either way (seed poll)
  });
});

describe("FACTORY-9: Jira comment detection on the existing Jira-kind snapshot", () => {
  test("a new comment on a linked target (no other field change) is reported as 'got a new comment', not a bare 'updated'", async () => {
    const owner = issue("BUTCHR-1", { issuelinks: [{ type: "Blocks", otherEnd: "outward", key: "BUTCHR-2" } as IssueLink] });
    // Jira bumps `updated` when a comment lands, even though status/summary don't move.
    const world: Record<string, JiraIssue> = { "BUTCHR-2": issue("BUTCHR-2", { updated: "t1" }) };
    const state = createLinkedEventingState();
    const commentsByKey = { "BUTCHR-2": [{ id: "c1", body: "first", created: "t1", authorEmail: null }] };
    const { deps, notified, commentCalls } = fakeDeps(world, { commentsByKey });
    const m = match("jira-work:task:BUTCHR-1", rule(), owner);

    await state.runTick([m], deps); // seed — records commentCursor "c1" silently
    expect(notified).toHaveLength(0);
    expect(commentCalls).toEqual(["BUTCHR-2"]);

    world["BUTCHR-2"] = issue("BUTCHR-2", { updated: "t2" });
    commentsByKey["BUTCHR-2"] = [{ id: "c2", body: "second", created: "t2", authorEmail: null }, { id: "c1", body: "first", created: "t1", authorEmail: null }];
    await state.runTick([m], deps);
    expect(notified).toHaveLength(1);
    expect(linkedEvents(notified[0]!.reason)).toEqual([{ target: "BUTCHR-2", kind: "issuelink", detail: "got a new comment" }]);
  });

  test("without deps.comments wired, a comment-driven bump still shows (via `updated`) but only as generic 'updated' — unchanged pre-FACTORY-9 behavior", async () => {
    const owner = issue("BUTCHR-1", { issuelinks: [{ type: "Blocks", otherEnd: "outward", key: "BUTCHR-2" } as IssueLink] });
    const world: Record<string, JiraIssue> = { "BUTCHR-2": issue("BUTCHR-2", { updated: "t1" }) };
    const state = createLinkedEventingState();
    const { deps, notified } = fakeDeps(world); // comments omitted
    const m = match("jira-work:task:BUTCHR-1", rule(), owner);

    await state.runTick([m], deps);
    world["BUTCHR-2"] = issue("BUTCHR-2", { updated: "t2" }); // simulates a comment bump with no comments() dep to confirm it
    await state.runTick([m], deps);
    expect(notified).toHaveLength(1);
    expect(linkedEvents(notified[0]!.reason)).toEqual([{ target: "BUTCHR-2", kind: "issuelink", detail: "updated" }]);
  });

  test("a comment deletion (newest comment id disappears/changes to none) is reported as 'had a comment removed'", async () => {
    const owner = issue("BUTCHR-1", { issuelinks: [{ type: "Blocks", otherEnd: "outward", key: "BUTCHR-2" } as IssueLink] });
    const world: Record<string, JiraIssue> = { "BUTCHR-2": issue("BUTCHR-2", { updated: "t1" }) };
    const state = createLinkedEventingState();
    const commentsByKey: Record<string, JiraComment[]> = { "BUTCHR-2": [{ id: "c1", body: "first", created: "t1", authorEmail: null }] };
    const { deps, notified } = fakeDeps(world, { commentsByKey });
    const m = match("jira-work:task:BUTCHR-1", rule(), owner);

    await state.runTick([m], deps); // seed with commentCursor "c1"
    world["BUTCHR-2"] = issue("BUTCHR-2", { updated: "t2" });
    commentsByKey["BUTCHR-2"] = [];
    await state.runTick([m], deps);
    expect(linkedEvents(notified[0]!.reason)).toEqual([{ target: "BUTCHR-2", kind: "issuelink", detail: "had a comment removed" }]);
  });

  test("a failed comment fetch for one target fails open (logs, leaves commentCursor unchecked) without blocking the tick", async () => {
    const owner = issue("BUTCHR-1", { issuelinks: [{ type: "Blocks", otherEnd: "outward", key: "BUTCHR-2" } as IssueLink] });
    const world: Record<string, JiraIssue> = { "BUTCHR-2": issue("BUTCHR-2") };
    const state = createLinkedEventingState();
    const { deps, notified, logs } = fakeDeps(world);
    deps.comments = async () => { throw new Error("500"); };
    await state.runTick([match("jira-work:task:BUTCHR-1", rule(), owner)], deps); // must not throw
    expect(logs.some((l) => l.includes("WARNING: [linked-eventing] comment fetch failed"))).toBe(true);
    expect(notified).toHaveLength(0);
  });

  test("a new comment landing in the SAME tick as an unrelated daemon-label move is NOT swallowed as 'daemon-label-only' — isDaemonLabelOnlyDiff knows nothing about comments", async () => {
    const owner = issue("BUTCHR-1", { issuelinks: [{ type: "Blocks", otherEnd: "outward", key: "BUTCHR-2" } as IssueLink] });
    const world: Record<string, JiraIssue> = { "BUTCHR-2": issue("BUTCHR-2", { labels: ["agent:working"], updated: "t1" }) };
    const state = createLinkedEventingState();
    const commentsByKey: Record<string, JiraComment[]> = { "BUTCHR-2": [{ id: "c1", body: "first", created: "t1", authorEmail: null }] };
    const { deps, notified } = fakeDeps(world, { commentsByKey });
    const m = match("jira-work:task:BUTCHR-1", rule(), owner);

    await state.runTick([m], deps); // seed
    // Status/summary unchanged, only a daemon-owned label moved AND a new comment landed in the same tick.
    world["BUTCHR-2"] = issue("BUTCHR-2", { labels: ["agent:blocked"], updated: "t2" });
    commentsByKey["BUTCHR-2"] = [{ id: "c2", body: "second", created: "t2", authorEmail: null }, { id: "c1", body: "first", created: "t1", authorEmail: null }];
    await state.runTick([m], deps);
    expect(notified).toHaveLength(1); // NOT suppressed — a real comment is never "just label noise"
    expect(linkedEvents(notified[0]!.reason)).toEqual([{ target: "BUTCHR-2", kind: "issuelink", detail: "got a new comment" }]);
  });
});

// FACTORY-9 scope item 6 / FACTORY-1 regression class, re-proven for THIS
// story's new managed-link-driven path specifically (FACTORY-1 already
// covers the pre-existing native/description-driven `linked:` path and the
// always-independent `related:` boss-wake path — see that ticket and its PR
// #408). "high-priority/boss-handoff-equivalent event" here means the SAME
// cross-daemon Implements-chain `related:` notify FACTORY-1 used, proven
// delivered even while THIS owner's OWN linkedEventing budget is exhausted
// entirely by MANAGED-link churn (not native/description churn).
describe("FACTORY-9 / FACTORY-1 regression class: the managed-link path never lets the notify cap drop a boss-handoff-equivalent event", () => {
  test("a rate-capped managed-link change is retried (delayed, not lost) on the next allowed tick, never silently dropped", async () => {
    const owner = issue("BUTCHR-1");
    const store = fakeLinkStore();
    await addLink(store, ref("jira-work-item:BUTCHR-1"), ref("jira-work-item:BUTCHR-2"));
    const world: Record<string, JiraIssue> = { "BUTCHR-2": issue("BUTCHR-2", { status: "To Do" }) };
    const state = createLinkedEventingState();
    const now = { value: 0 };
    const { deps, notified, logs } = fakeDeps(world, { linkStore: store, now });
    const r = rule({ maxLinkedTurnsPerHour: 1 });
    const m = match("jira-work:task:BUTCHR-1", r, owner);

    await state.runTick([m], deps); // seed
    world["BUTCHR-2"] = issue("BUTCHR-2", { status: "In Progress" });
    await state.runTick([m], deps); // uses the one allowed turn
    expect(notified).toHaveLength(1);

    world["BUTCHR-2"] = issue("BUTCHR-2", { status: "Done" });
    await state.runTick([m], deps); // capped — dropped this tick, not lost
    expect(notified).toHaveLength(1);
    expect(logs.some((l) => l.startsWith("[notify-suppressed]") && l.includes("arm=rate-capped"))).toBe(true);

    now.value += 61 * 60_000;
    await state.runTick([m], deps); // the same outstanding change is re-detected and delivered
    expect(notified).toHaveLength(2);
    expect(linkedEvents(notified[1]!.reason)).toEqual([{ target: "BUTCHR-2", kind: "jira-key", detail: 'status changed from "In Progress" to "Done"' }]);
  });

  test("cross-daemon epic hears its story's move to In Review via related:, even with its OWN managed-link budget exhausted by unrelated managed-link churn", async () => {
    const bossKey = "DROVR-37";
    const workerKey = "DROVR-38"; // fetched only via the foreign-implementer path — this daemon's own rules never match it (BUTCHR-388's own documented live-fleet shape)
    const siblingKeys = ["DROVR-30", "DROVR-31"]; // NOT Implements targets — pure managed-link churn used to exhaust the budget

    let storyStatus = "In Progress";
    let siblingRound = 0;
    const store = fakeLinkStore();
    for (const sk of siblingKeys) await addLink(store, ref(`jira-work-item:${bossKey}`), ref(`jira-work-item:${sk}`));

    const boss = () => issue(bossKey, { issuetype: "Epic", issuelinks: [{ type: "Implements", otherEnd: "outward", key: workerKey } as IssueLink] });
    const worker = () => issue(workerKey, { issuetype: "Story", status: storyStatus, issuelinks: [{ type: "Implements", otherEnd: "inward", key: bossKey } as IssueLink] });
    const sibling = (key: string, round: number) => issue(key, { status: round % 2 === 0 ? "In Progress" : "In Review" });

    const logs: string[] = [];
    const ruleSet = parseRules({ rules: [{ id: "epics", resourceProvider: "jira-work", query: "issuetype = Epic", brief: "do it", linkedEventing: true, maxLinkedTurnsPerHour: 2 }] });
    const search = async (jql: string): Promise<JiraIssue[]> => {
      if (jql === "issuetype = Epic") return [boss()];
      if (jql.startsWith("key in (")) {
        const out: JiraIssue[] = [];
        if (jql.includes(bossKey)) out.push(boss());
        if (jql.includes(workerKey)) out.push(worker());
        if (jql.includes(siblingKeys[0]!)) out.push(sibling(siblingKeys[0]!, siblingRound));
        if (jql.includes(siblingKeys[1]!)) out.push(sibling(siblingKeys[1]!, siblingRound));
        return out;
      }
      return [];
    };
    const type = createRuleResourceType({ rules: ruleSet, search, notify: async () => {}, log: (l) => logs.push(l), linkStore: store });
    const active = ["jira-work:epics:" + bossKey];

    await type.discovery.search();
    let related = await type.discovery.related!(active);
    for (let i = 0; i < 2; i++) { siblingRound++; await type.discovery.search(); related = await type.discovery.related!(active); }
    logs.length = 0;

    storyStatus = "In Review";
    await type.discovery.search();
    const relatedAfter = await type.discovery.related!(active);

    expect(logs.some((l) => l.includes("[notify-suppressed]") && l.includes("arm=rate-capped") && l.includes(bossKey))).toBe(true);

    const evPoll = await type.eventRules.poll({ primary: [], related }, { primary: [], related: relatedAfter });
    const watchersOf = (k: string) =>
      relatedAfter.find((r) => type.discovery.idOf(r.issue) === k)?.watchers
      ?? related.find((r) => type.discovery.idOf(r.issue) === k)?.watchers
      ?? [];
    const delivered: string[] = [];
    for (const key of evPoll.changedRelated) {
      for (const w of watchersOf(key)) {
        if ((await evPoll.decide(key, w, "related")).deliver) delivered.push(w);
      }
    }
    expect(delivered).toEqual(["jira-work:epics:" + bossKey]);
  });
});
