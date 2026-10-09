import { describe, expect, test } from "bun:test";
import {
  confluencePageIdOf,
  createConfluencePageEventRules,
  createConfluencePageResourceType,
  diffConfluencePage,
  type ConfluencePageSnapshot,
} from "../../src/resources/confluence-page.js";
import { runResourceLoop } from "../../src/daemon/loop.js";
import type { Herd } from "../../src/agents/herd.js";
import type { NotifyReason } from "../../src/resources/types.js";

function page(over: Partial<ConfluencePageSnapshot> & { id: string }): ConfluencePageSnapshot {
  return { version: 1, commentIds: [], ...over };
}

describe("diffConfluencePage — the pure version/comment-set diff", () => {
  test("version bump => edit change", () => {
    const before = page({ id: "P1", version: 1 });
    const after = page({ id: "P1", version: 2 });
    expect(diffConfluencePage(before, after)).toEqual({ kind: "edit", from: 1, to: 2 });
  });

  test("new footer comment => comment change, carrying only the NEW ids", () => {
    const before = page({ id: "P1", version: 1, commentIds: ["c1"] });
    const after = page({ id: "P1", version: 1, commentIds: ["c1", "c2"] });
    expect(diffConfluencePage(before, after)).toEqual({ kind: "comment", newCommentIds: ["c2"] });
  });

  test("no change => null", () => {
    const before = page({ id: "P1", version: 3, commentIds: ["c1", "c2"] });
    const after = page({ id: "P1", version: 3, commentIds: ["c1", "c2"] });
    expect(diffConfluencePage(before, after)).toBeNull();
  });

  test("first observation (no prior baseline) establishes a baseline and does NOT wake — mirrors jira-work baseline semantics", () => {
    const after = page({ id: "P1", version: 5, commentIds: ["c1", "c2", "c3"] });
    expect(diffConfluencePage(undefined, after)).toBeNull();
  });

  test("comment ids are compared by SET MEMBERSHIP, never order or 'newest id' — a reordered-but-unchanged set is not a change", () => {
    const before = page({ id: "P1", commentIds: ["c3", "c1", "c2"] });
    const after = page({ id: "P1", commentIds: ["c1", "c2", "c3"] });
    expect(diffConfluencePage(before, after)).toBeNull();
  });

  test("a comment set that shrinks (a deletion) is not classified as a change — only growth is", () => {
    const before = page({ id: "P1", commentIds: ["c1", "c2"] });
    const after = page({ id: "P1", commentIds: ["c1"] });
    expect(diffConfluencePage(before, after)).toBeNull();
  });

  test("version check takes precedence over a simultaneous new comment", () => {
    const before = page({ id: "P1", version: 1, commentIds: ["c1"] });
    const after = page({ id: "P1", version: 2, commentIds: ["c1", "c2"] });
    expect(diffConfluencePage(before, after)).toEqual({ kind: "edit", from: 1, to: 2 });
  });
});

describe("createConfluencePageEventRules().poll — wiring the pure diff into EventPoll/decide", () => {
  test("an edit produces changedPrimary + a deliver:true verdict carrying confluencePageEdit", async () => {
    const rules = createConfluencePageEventRules();
    const prev = { primary: [page({ id: "P1", version: 1 })], related: [] };
    const next = { primary: [page({ id: "P1", version: 2 })], related: [] };
    const result = await rules.poll(prev, next);
    expect(result.changedPrimary).toEqual(["P1"]);
    expect(result.changedRelated).toEqual([]);
    const verdict = await result.decide("P1", "P1", "primary");
    expect(verdict).toEqual({ deliver: true, reason: { confluencePageEdit: { from: 1, to: 2 } } });
  });

  test("a new footer comment produces changedPrimary + a deliver:true verdict carrying confluencePageComment", async () => {
    const rules = createConfluencePageEventRules();
    const prev = { primary: [page({ id: "P1", commentIds: ["c1"] })], related: [] };
    const next = { primary: [page({ id: "P1", commentIds: ["c1", "c2"] })], related: [] };
    const result = await rules.poll(prev, next);
    expect(result.changedPrimary).toEqual(["P1"]);
    const verdict = await result.decide("P1", "P1", "primary");
    expect(verdict).toEqual({ deliver: true, reason: { confluencePageComment: { ids: ["c2"] } } });
  });

  test("no change => empty changedPrimary, and decide (if ever called) refuses to deliver", async () => {
    const rules = createConfluencePageEventRules();
    const snap = page({ id: "P1", version: 1, commentIds: ["c1"] });
    const result = await rules.poll({ primary: [snap], related: [] }, { primary: [snap], related: [] });
    expect(result.changedPrimary).toEqual([]);
    expect(await result.decide("P1", "P1", "primary")).toEqual({ deliver: false });
  });

  test("first observation: id present in next but absent from prev => no entry in changedPrimary, no wake", async () => {
    const rules = createConfluencePageEventRules();
    const next = { primary: [page({ id: "P1", version: 1, commentIds: ["c1"] })], related: [] };
    const result = await rules.poll({ primary: [], related: [] }, next);
    expect(result.changedPrimary).toEqual([]);
  });

  test("page deleted/inaccessible (present in prev, absent from next) does not crash and does not storm a notify", async () => {
    const rules = createConfluencePageEventRules();
    const prev = { primary: [page({ id: "P1", version: 1 })], related: [] };
    const next = { primary: [], related: [] };
    const result = await rules.poll(prev, next);
    expect(result.changedPrimary).toEqual([]);
    expect(result.changedRelated).toEqual([]);
  });

  test("related space never delivers — a standalone page has no related-resource concept", async () => {
    const rules = createConfluencePageEventRules();
    const prev = { primary: [page({ id: "P1", version: 1 })], related: [] };
    const next = { primary: [page({ id: "P1", version: 2 })], related: [] };
    const result = await rules.poll(prev, next);
    expect(await result.decide("P1", "P1", "related")).toEqual({ deliver: false });
  });
});

describe("confluencePageIdOf", () => {
  test("returns the page id", () => {
    expect(confluencePageIdOf(page({ id: "99887766" }))).toBe("99887766");
  });
});

/**
 * Integration-style test (DoD #2): a FAKE AtlassianOps-shaped deps object,
 * a REAL `createConfluencePageResourceType`, run through the REAL,
 * unmodified `runResourceLoop` (`src/daemon/loop.ts`) — the same proof
 * technique `test/unit/resource-type-second-instance.test.ts` already
 * established for a second resource type. Proves a standalone page (no
 * Jira ticket link anywhere in this test) produces a wake through the real
 * loop/dispatch path, not just through the pure `diffConfluencePage`/
 * `poll` functions exercised above.
 */
describe("createConfluencePageResourceType — end-to-end through the real runResourceLoop (DoD #2)", () => {
  function fakeHerd(): Herd {
    const running = new Set<string>();
    return {
      async runningIssues() {
        return [...running];
      },
      async staleIssues() {
        return [];
      },
      async spawn(sp) {
        running.add(sp.key);
      },
      async stop(i) {
        running.delete(i);
      },
      async paneFor(i) {
        return running.has(i) ? `pane-${i}` : null;
      },
      async nudge() {
        return { delivered: true };
      },
      async resumeInPlace() {
        return "unresumable" as const;
      },
    };
  }

  test("a standalone page's version bump wakes its own agent, end to end", async () => {
    // Fake AtlassianOps surface — only the two ops this resource type's
    // discovery actually calls, per `ConfluencePageDiscoveryDeps`.
    let version = 1;
    const resourceType = createConfluencePageResourceType({
      trackedPageIds: async () => ["55667788"],
      getPageVersions: async (ids) => Object.fromEntries(ids.map((id) => [id, version])),
      getPageComments: async () => ({ results: [] }),
    });
    const notified: Array<{ issue: string; about: string; reason: NotifyReason | undefined }> = [];
    const stop = runResourceLoop(resourceType, {
      herd: fakeHerd(),
      ownsId: () => true,
      notify: (issue, about, reason) => {
        notified.push({ issue, about, reason });
      },
      intervalMs: 10,
    });
    // Let one poll establish the baseline (no wake expected yet).
    await new Promise((r) => setTimeout(r, 25));
    expect(notified).toEqual([]);
    // Now the page's version moves — the next poll must notify.
    version = 2;
    await new Promise((r) => setTimeout(r, 40));
    stop();
    expect(notified.some((n) => n.about === "55667788" && n.reason && "confluencePageEdit" in n.reason)).toBe(true);
  });

  test("a standalone page's new footer comment wakes its own agent, end to end", async () => {
    let commentIds = ["c1"];
    const resourceType = createConfluencePageResourceType({
      trackedPageIds: async () => ["55667788"],
      getPageVersions: async (ids) => Object.fromEntries(ids.map((id) => [id, 7])),
      getPageComments: async () => ({ results: commentIds.map((id) => ({ id })) }),
    });
    const notified: Array<{ issue: string; about: string; reason: NotifyReason | undefined }> = [];
    const stop = runResourceLoop(resourceType, {
      herd: fakeHerd(),
      ownsId: () => true,
      notify: (issue, about, reason) => {
        notified.push({ issue, about, reason });
      },
      intervalMs: 10,
    });
    await new Promise((r) => setTimeout(r, 25));
    expect(notified).toEqual([]);
    commentIds = ["c1", "c2"];
    await new Promise((r) => setTimeout(r, 40));
    stop();
    expect(notified.some((n) => n.about === "55667788" && n.reason && "confluencePageComment" in n.reason)).toBe(true);
  });

  test("a page that becomes unreadable (dropped by getPageVersions) is never notified about and never crashes the loop", async () => {
    let readable = true;
    const resourceType = createConfluencePageResourceType({
      trackedPageIds: async () => ["99998888"],
      getPageVersions: async (ids) => (readable ? Object.fromEntries(ids.map((id) => [id, 1])) : {}),
      getPageComments: async () => ({ results: [] }),
    });
    const notified: string[] = [];
    const stop = runResourceLoop(resourceType, {
      herd: fakeHerd(),
      ownsId: () => true,
      notify: (_issue, about) => {
        notified.push(about);
      },
      intervalMs: 10,
    });
    await new Promise((r) => setTimeout(r, 25));
    readable = false;
    await new Promise((r) => setTimeout(r, 40));
    stop();
    expect(notified).toEqual([]);
  });
});
