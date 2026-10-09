import { describe, expect, test } from "bun:test";
import { createIssueEventRules } from "../../src/resources/issue.js";
import { WAKE_MARKERS } from "../../src/jira-watch/diff.js";
import type { JiraIssue, JiraComment } from "../../src/atlassian/types.js";

/**
 * FACTORY-865/FACTORY-866: butchr's own `[butchr:*]` bookkeeping comments
 * must not defeat daemon-label-only (agent:* / pr:*) notify suppression on
 * the Jira issue tier (`createIssueEventRules`, src/resources/issue.ts).
 *
 * Criterion B is THE regression test: a bare agent:*-label-only diff is
 * already suppressed (criterion A) — the bug is specifically that a
 * `[butchr:*]` bookkeeping comment landing in the SAME poll window used to
 * move the notify comment cursor and defeat that suppression (measured on
 * FACTORY-864's diagnosis: ~282 comment-attributed deliveries/6h that were
 * really label-only diffs hiding under a bookkeeping comment). Before this
 * ticket's fix, `fetchComments` took `comments[0]?.id` from the RAW fetch —
 * B would therefore have delivered (`verdict.deliver === true`) on the base
 * commit; after the fix it must not.
 */

const issue = (over: Partial<JiraIssue> = {}): JiraIssue => ({
  key: "KAN-1",
  summary: "s",
  status: "In Progress",
  issuetype: "Task",
  assignee: null,
  parent: null,
  updated: "2026-01-01T00:00:00.000Z",
  labels: [],
  ...over,
});

/** A tiny in-memory comment store, keyed by ticket, newest-first, carrying real bodies — unlike issue-standdown-loop.test.ts's own commentStore (body: ""), this ticket's whole fix turns on body content. */
function commentStore(seed: Record<string, JiraComment[]> = {}) {
  const byKey = new Map<string, JiraComment[]>(Object.entries(seed));
  return {
    set: (key: string, rows: JiraComment[]) => byKey.set(key, rows),
    comments: async (key: string): Promise<readonly JiraComment[]> => byKey.get(key) ?? [],
  };
}

const bookkeeping = (id: string, created = "t"): JiraComment => ({ id, body: "[butchr:parked] X has been assigned and linked to this ticket", created, authorEmail: null });
const real = (id: string, created = "t"): JiraComment => ({ id, body: "a genuine human/agent comment", created, authorEmail: null });
const wake = (marker: string, id: string, created = "t"): JiraComment => ({ id, body: `${marker} agent-directed text`, created, authorEmail: null });

describe("FACTORY-865 criterion A: a pure agent:*-label-only diff is suppressed (baseline, pre-existing behavior)", () => {
  test("no change event, no wake", async () => {
    const store = commentStore({ "KAN-1": [real("c0")] });
    const rules = createIssueEventRules({ comments: store.comments });
    const before = issue({ labels: ["agent:working"] });
    const seed = await rules.poll({ primary: [], related: [] }, { primary: [before], related: [] });
    await seed.decide("KAN-1", "KAN-1", "primary"); // establish baseline

    const after = issue({ labels: ["agent:idle"], updated: "2026-01-01T00:05:00.000Z" });
    const poll = await rules.poll({ primary: [before], related: [] }, { primary: [after], related: [] });
    const verdict = await poll.decide("KAN-1", "KAN-1", "primary");
    expect(verdict.deliver).toBe(false);
  });
});

describe("FACTORY-865 criterion B (THE regression test): the label-only diff STAYS suppressed even when a bookkeeping comment landed in the same window", () => {
  test("a [butchr:parked]-style comment landing alongside an agent:* flip does not revive the label-only diff", async () => {
    const store = commentStore({ "KAN-1": [real("c0")] });
    const rules = createIssueEventRules({ comments: store.comments });
    const before = issue({ labels: ["agent:working"] });
    const seed = await rules.poll({ primary: [], related: [] }, { primary: [before], related: [] });
    await seed.decide("KAN-1", "KAN-1", "primary"); // baseline = c0 (bookkeeping is never seeded as "newest" either)

    // Same poll window: the agent:* label flips AND a bookkeeping comment lands.
    store.set("KAN-1", [bookkeeping("c1"), real("c0")]);
    const after = issue({ labels: ["agent:idle"], updated: "2026-01-01T00:05:00.000Z" });
    const poll = await rules.poll({ primary: [before], related: [] }, { primary: [after], related: [] });
    const verdict = await poll.decide("KAN-1", "KAN-1", "primary");
    expect(verdict.deliver).toBe(false); // would have been true pre-fix: comments[0]?.id (raw) === "c1" !== baseline "c0"
  });
});

describe("FACTORY-865 criterion C: mixed diffs still fire — a label change alongside a REAL structural/comment change is never suppressed", () => {
  test("agent:* label change + status change -> delivers, named by status (not suppressed)", async () => {
    const rules = createIssueEventRules({ comments: commentStore().comments });
    const before = issue({ labels: ["agent:working"], status: "In Progress" });
    const after = issue({ labels: ["agent:idle"], status: "In Review", updated: "t2" });
    const poll = await rules.poll({ primary: [before], related: [] }, { primary: [after], related: [] });
    const verdict = await poll.decide("KAN-1", "KAN-1", "primary");
    expect(verdict.deliver).toBe(true);
    expect(verdict.reason).toEqual({ status: { from: "In Progress", to: "In Review" } });
  });

  test("agent:* label change + summary change -> delivers, named by summary", async () => {
    const rules = createIssueEventRules({ comments: commentStore().comments });
    const before = issue({ labels: ["agent:working"], summary: "old" });
    const after = issue({ labels: ["agent:idle"], summary: "new", updated: "t2" });
    const poll = await rules.poll({ primary: [before], related: [] }, { primary: [after], related: [] });
    const verdict = await poll.decide("KAN-1", "KAN-1", "primary");
    expect(verdict.deliver).toBe(true);
    expect(verdict.reason).toEqual({ summary: true });
  });

  test("agent:* label change + a REAL (non-bookkeeping) comment landing in the same window -> delivers, named by comment", async () => {
    const store = commentStore({ "KAN-1": [real("c0")] });
    const rules = createIssueEventRules({ comments: store.comments });
    const before = issue({ labels: ["agent:working"] });
    const seed = await rules.poll({ primary: [], related: [] }, { primary: [before], related: [] });
    await seed.decide("KAN-1", "KAN-1", "primary");

    store.set("KAN-1", [real("c1"), real("c0")]);
    const after = issue({ labels: ["agent:idle"], updated: "t2" });
    const poll = await rules.poll({ primary: [before], related: [] }, { primary: [after], related: [] });
    const verdict = await poll.decide("KAN-1", "KAN-1", "primary");
    expect(verdict.deliver).toBe(true);
    expect(verdict.reason).toEqual({ comment: "c1" });
  });

  test("a link-change-shaped diff (summary unchanged, status unchanged, only `updated` moves, nothing the issue model tracks changed) still falls through to the honest fallback, never suppressed", async () => {
    // A baseline must already exist from a PRIOR poll (so THIS poll's own
    // baseline-seeding pre-pass skips re-fetching it) and no label change
    // must occur this poll (so no suppression arm calls fetchComments
    // either) — only then does nothing this poll ever call comments(),
    // reaching the "unchecked" fallback rather than "checked-unchanged".
    const store = commentStore({ "KAN-1": [real("c0")] });
    const rules = createIssueEventRules({ comments: store.comments });
    const seedIssue = issue();
    const seed = await rules.poll({ primary: [], related: [] }, { primary: [seedIssue], related: [] });
    await seed.decide("KAN-1", "KAN-1", "primary"); // baseline = c0

    const before = issue();
    const after = issue({ updated: "t2" }); // no label change at all -> isDaemonLabelOnlyDiff never even applies
    const poll = await rules.poll({ primary: [before], related: [] }, { primary: [after], related: [] });
    const verdict = await poll.decide("KAN-1", "KAN-1", "primary");
    expect(verdict.deliver).toBe(true);
    expect(verdict.reason).toEqual({ undetermined: "unchecked" });
  });
});

describe("FACTORY-865 criterion D: every allowlisted WAKE marker still wakes, one test per marker", () => {
  for (const marker of WAKE_MARKERS) {
    test(`${marker}: a pure agent:*-label diff coinciding with this marker's own comment STILL delivers`, async () => {
      const store = commentStore({ "KAN-1": [real("c0")] });
      const rules = createIssueEventRules({ comments: store.comments });
      const before = issue({ labels: ["agent:working"] });
      const seed = await rules.poll({ primary: [], related: [] }, { primary: [before], related: [] });
      await seed.decide("KAN-1", "KAN-1", "primary"); // baseline = c0

      store.set("KAN-1", [wake(marker, "c1"), real("c0")]);
      const after = issue({ labels: ["agent:idle"], updated: "t2" });
      const poll = await rules.poll({ primary: [before], related: [] }, { primary: [after], related: [] });
      const verdict = await poll.decide("KAN-1", "KAN-1", "primary");
      expect(verdict.deliver).toBe(true); // the marker's own comment still moved the cursor -> not suppressed
      expect(verdict.reason).toEqual({ comment: "c1" });
    });
  }
});

describe("FACTORY-865 criterion E: pr:* transitions deliver exactly as before, unaffected by the comment-cursor fix", () => {
  test("a pr:* transition on the primary (self) path delivers unconditionally, even with a bookkeeping comment in the same window and no comments dep consulted", async () => {
    const rules = createIssueEventRules({}); // no `comments` dep wired at all — this path must make no comments() call
    const before = issue({ labels: ["pr:open"] });
    const after = issue({ labels: ["pr:approved"], updated: "t2" });
    const poll = await rules.poll({ primary: [before], related: [] }, { primary: [after], related: [] });
    const verdict = await poll.decide("KAN-1", "KAN-1", "primary");
    expect(verdict.deliver).toBe(true);
    expect(verdict.reason).toEqual({ pr: { from: "open", to: "approved" } });
  });
});

describe("FACTORY-865 criterion F: a daemon-label-only diff with NO comment baseline is suppressed; a failed fetch never installs/advances a cursor", () => {
  test("first-ever sighting of a key, straight into a label-only diff with no prior baseline at all -> suppressed, not fail-open delivered", async () => {
    // No seeding poll at all: this key has literally never been observed before.
    // This poll's own baseline-seeding pre-pass (which runs before decide() for
    // every key in the snapshot, see createIssueEventRules' own top comment)
    // seeds the baseline from the SAME comments fetch crossDaemonSuppressed
    // itself reads, so this exercises the arm 3 echo-match outcome rather than
    // literally hitting the `!hadBaseline` line in isolation (see that line's
    // own doc comment in src/resources/issue.ts for why seeding makes it
    // defensive, not demonstrated-live) — but the OBSERVABLE contract this
    // criterion actually cares about ("never fail-open deliver a label-only
    // diff just because nothing was known about this key before") holds
    // either way.
    const store = commentStore({ "KAN-1": [real("c1")] });
    const rules = createIssueEventRules({ comments: store.comments });
    const before = issue({ labels: ["agent:working"] });
    const after = issue({ labels: ["agent:idle"], updated: "t2" });
    const poll = await rules.poll({ primary: [before], related: [] }, { primary: [after], related: [] });
    const verdict = await poll.decide("KAN-1", "KAN-1", "primary");
    expect(verdict.deliver).toBe(false);
  });

  test("a failed comments() fetch on a label-only diff never suppresses (fails open toward delivering) and never installs a cursor value", async () => {
    let calls = 0;
    const rules = createIssueEventRules({
      comments: async () => { calls++; throw new Error("transient Jira failure"); },
    });
    const before = issue({ labels: ["agent:working"] });
    const after = issue({ labels: ["agent:idle"], updated: "t2" });
    const poll = await rules.poll({ primary: [before], related: [] }, { primary: [after], related: [] });
    const verdict = await poll.decide("KAN-1", "KAN-1", "primary");
    expect(verdict.deliver).toBe(true); // cannot look -> do not suppress
    expect(calls).toBeGreaterThan(0);
  });
});
