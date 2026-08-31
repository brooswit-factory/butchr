import { describe, expect, test } from "bun:test";
import { parkedCandidates, createParkedDetector, MARKER, EXEMPT_LABEL } from "../../src/agents/parked.js";
import type { JiraIssue, IssueLink } from "../../src/atlassian/types.js";
import type { RelatedIssue } from "../../src/daemon/loop.js";

const MIN = 60_000;

const iss = (key: string, status: string, opts: Partial<JiraIssue> = {}): JiraIssue =>
  ({ key, summary: "s", status, issuetype: "Task", assignee: "someone", parent: null, updated: "t", labels: [], ...opts });

const rel = (child: JiraIssue, watchers: string[]): RelatedIssue => ({ issue: child, watchers });

describe("parkedCandidates (pure predicate)", () => {
  test("all five conditions hold: a candidate", () => {
    const issues = [iss("BOSS", "In Progress")];
    const related = [rel(iss("CH", "To Do"), ["BOSS"])];
    const out = parkedCandidates(issues, related);
    expect(out).toEqual([{ child: related[0]!.issue, boss: "BOSS" }]);
  });

  test("excluded: no assignee", () => {
    const issues = [iss("BOSS", "In Progress")];
    const related = [rel(iss("CH", "To Do", { assignee: null }), ["BOSS"])];
    expect(parkedCandidates(issues, related)).toEqual([]);
  });

  test("excluded: no Implements link (simply never appears in `related` at all)", () => {
    const issues = [iss("BOSS", "In Progress")];
    expect(parkedCandidates(issues, [])).toEqual([]);
  });

  test("excluded: boss In Progress but child not To Do", () => {
    const issues = [iss("BOSS", "In Progress")];
    for (const status of ["In Progress", "In Review", "Done"]) {
      const related = [rel(iss("CH", status), ["BOSS"])];
      expect(parkedCandidates(issues, related)).toEqual([]);
    }
  });

  test("excluded: boss not In Progress (Done)", () => {
    const issues = [iss("BOSS", "Done")];
    const related = [rel(iss("CH", "To Do"), ["BOSS"])];
    expect(parkedCandidates(issues, related)).toEqual([]);
  });

  test("excluded: boss not In Progress (In Review)", () => {
    const issues = [iss("BOSS", "In Review")];
    const related = [rel(iss("CH", "To Do"), ["BOSS"])];
    expect(parkedCandidates(issues, related)).toEqual([]);
  });

  test("excluded: boss absent from `issues` entirely", () => {
    const related = [rel(iss("CH", "To Do"), ["BOSS"])];
    expect(parkedCandidates([], related)).toEqual([]);
  });

  test("excluded: child carries butchr:parked-ok", () => {
    const issues = [iss("BOSS", "In Progress")];
    const related = [rel(iss("CH", "To Do", { labels: [EXEMPT_LABEL] }), ["BOSS"])];
    expect(parkedCandidates(issues, related)).toEqual([]);
  });

  test("a child watched by two bosses: only the In Progress one is a candidate", () => {
    const issues = [iss("BOSS1", "In Progress"), iss("BOSS2", "In Review")];
    const related = [rel(iss("CH", "To Do"), ["BOSS1", "BOSS2"])];
    expect(parkedCandidates(issues, related)).toEqual([{ child: related[0]!.issue, boss: "BOSS1" }]);
  });

  test("a child watched by TWO In Progress bosses: both are candidates, as separate (child, boss) pairs", () => {
    const issues = [iss("BOSS1", "In Progress"), iss("BOSS2", "In Progress")];
    const related = [rel(iss("CH", "To Do"), ["BOSS1", "BOSS2"])];
    const out = parkedCandidates(issues, related);
    expect(out.map((c) => c.boss).sort()).toEqual(["BOSS1", "BOSS2"]);
  });
});

/** A fake Jira comment store: addComment writes land here, newest-first, exactly like AtlassianClient.comments(). */
function fakeJira() {
  const byTicket = new Map<string, { id: string; body: string; created: string }[]>();
  const linksByKey = new Map<string, IssueLink[]>();
  const posted: { target: string; text: string }[] = [];
  let seq = 0;
  return {
    posted,
    linksByKey,
    addComment: async (issue: string, text: string) => {
      seq++;
      const now = new Date().toISOString();
      const rows = byTicket.get(issue) ?? [];
      rows.unshift({ id: `c${seq}`, body: text, created: now });
      byTicket.set(issue, rows);
      posted.push({ target: issue, text });
    },
    // created is overridden per-call below via a settable clock so timestamps are deterministic.
    setCreated: (issue: string, id: string, created: string) => {
      const rows = byTicket.get(issue);
      const row = rows?.find((r) => r.id === id);
      if (row) row.created = created;
    },
    comments: async (issue: string) => byTicket.get(issue) ?? [],
    links: async (issue: string) => linksByKey.get(issue) ?? [],
    commentsOf: (issue: string) => byTicket.get(issue) ?? [],
  };
}

describe("createParkedDetector: escalation path (through addComment, per the ticket's DoD)", () => {
  test("a parked child escalates to its boss's ticket after the threshold, not before", async () => {
    let now = 0;
    const jira = fakeJira();
    const det = createParkedDetector({ now: () => now, minutes: 10, addComment: jira.addComment, comments: jira.comments, links: jira.links });
    const issues = [iss("BOSS", "In Progress")];
    const child = iss("CH", "To Do");
    const related = [rel(child, ["BOSS"])];

    now = 0;
    await det.check(issues, related);
    expect(jira.posted).toEqual([]);

    now = 9 * MIN;
    await det.check(issues, related);
    expect(jira.posted).toEqual([]); // still short of the 10-minute threshold

    now = 10 * MIN;
    await det.check(issues, related);
    expect(jira.posted.length).toBe(1);
    expect(jira.posted[0]!.target).toBe("BOSS");
    expect(jira.posted[0]!.text.startsWith(MARKER)).toBe(true);
    expect(jira.posted[0]!.text).toContain("CH");
    expect(jira.posted[0]!.text).toContain("fingerprint: CH");
    expect(jira.posted[0]!.text).toContain("stage: 1");
    expect(jira.posted[0]!.text).toContain(EXEMPT_LABEL); // the exemption is documented in the comment itself
  });

  test("it does NOT escalate again on the next poll (dedupe): re-running check() at the same or later time posts nothing further for stage 1", async () => {
    let now = 0;
    const jira = fakeJira();
    const det = createParkedDetector({ now: () => now, minutes: 10, addComment: jira.addComment, comments: jira.comments, links: jira.links });
    const issues = [iss("BOSS", "In Progress")];
    const related = [rel(iss("CH", "To Do"), ["BOSS"])];

    await det.check(issues, related); // floor starts at 0

    now = 10 * MIN;
    await det.check(issues, related);
    expect(jira.posted.length).toBe(1);

    now = 15 * MIN; // still short of stage 2's own threshold (stage1At + 10min)
    await det.check(issues, related);
    expect(jira.posted.length).toBe(1); // no duplicate, no premature stage 2
  });

  test("dedupe survives a simulated daemon restart: a FRESH detector (fresh in-memory tracker) with the prior comment already on the ticket adopts it instead of re-posting", async () => {
    const jira = fakeJira();
    let now = 0;
    const before = createParkedDetector({ now: () => now, minutes: 10, addComment: jira.addComment, comments: jira.comments, links: jira.links });
    const issues = [iss("BOSS", "In Progress")];
    const related = [rel(iss("CH", "To Do"), ["BOSS"])];
    await before.check(issues, related); // floor starts at 0
    now = 10 * MIN;
    await before.check(issues, related);
    expect(jira.posted.length).toBe(1);

    // Simulate the restart: a brand new detector, fresh tracker (no memory
    // of CH at all), but the SAME underlying Jira ticket comments — the
    // stage-1 comment `before` posted is still there.
    now = 25 * MIN; // arbitrary later time — the new tracker's floor starts HERE
    const after = createParkedDetector({ now: () => now, minutes: 10, addComment: jira.addComment, comments: jira.comments, links: jira.links });
    await after.check(issues, related); // floor just started (25min) — not yet eligible for stage 1 from ITS OWN perspective
    expect(jira.posted.length).toBe(1);

    now = 35 * MIN; // 10 minutes after the fresh floor: `after` becomes eligible to (re-)attempt stage 1
    await after.check(issues, related);
    expect(jira.posted.length).toBe(1); // adopted the EXISTING comment — no duplicate was posted
  });

  test("the follow-up (stage 2) fires once at stage 2, and only once", async () => {
    let now = 0;
    const jira = fakeJira();
    const det = createParkedDetector({ now: () => now, minutes: 10, addComment: jira.addComment, comments: jira.comments, links: jira.links });
    const issues = [iss("BOSS", "In Progress")];
    const related = [rel(iss("CH", "To Do"), ["BOSS"])];

    await det.check(issues, related); // floor starts at 0
    now = 10 * MIN; await det.check(issues, related); // stage 1
    expect(jira.posted.length).toBe(1);

    now = 15 * MIN; await det.check(issues, related); // still short of stage 2
    expect(jira.posted.length).toBe(1);

    now = 20 * MIN; await det.check(issues, related); // stage 2 threshold reached
    expect(jira.posted.length).toBe(2);
    expect(jira.posted[1]!.target).toBe("BOSS");
    expect(jira.posted[1]!.text).toContain("stage: 2");

    now = 21 * MIN; await det.check(issues, related); // holds still — stage 2 fires only once
    now = 25 * MIN; await det.check(issues, related);
    expect(jira.posted.length).toBe(2); // no stage-2 duplicate (stage 3 not due yet at 25min: needs 30min)
  });

  test("stage 3 posts on the boss's boss, resolved through the inward Implements link", async () => {
    let now = 0;
    const jira = fakeJira();
    jira.linksByKey.set("BOSS", [{ type: "Implements", otherEnd: "inward", key: "GRANDBOSS" }]);
    const det = createParkedDetector({ now: () => now, minutes: 10, addComment: jira.addComment, comments: jira.comments, links: jira.links });
    const issues = [iss("BOSS", "In Progress")];
    const related = [rel(iss("CH", "To Do"), ["BOSS"])];

    await det.check(issues, related); // floor starts at 0
    now = 10 * MIN; await det.check(issues, related); // stage 1 -> BOSS
    now = 20 * MIN; await det.check(issues, related); // stage 2 -> BOSS
    now = 30 * MIN; await det.check(issues, related); // stage 3 -> GRANDBOSS
    expect(jira.posted.length).toBe(3);
    expect(jira.posted[2]!.target).toBe("GRANDBOSS");
    expect(jira.posted[2]!.text.startsWith(MARKER)).toBe(true);
    expect(jira.posted[2]!.text).toContain("stage: 3");
    expect(jira.posted[2]!.text).toContain("BOSS"); // names the boss that ignored two notices

    now = 40 * MIN; await det.check(issues, related); // nothing further after stage 3
    expect(jira.posted.length).toBe(3);
  });

  test("stage 3 with no boss's boss re-posts on the boss and emits the WARNING: [parked] log line", async () => {
    let now = 0;
    const jira = fakeJira(); // linksByKey has nothing for BOSS -> no inward Implements link
    const logs: string[] = [];
    const det = createParkedDetector({ now: () => now, minutes: 10, addComment: jira.addComment, comments: jira.comments, links: jira.links, log: (l) => logs.push(l) });
    const issues = [iss("BOSS", "In Progress")];
    const related = [rel(iss("CH", "To Do"), ["BOSS"])];

    await det.check(issues, related); // floor starts at 0
    now = 10 * MIN; await det.check(issues, related);
    now = 20 * MIN; await det.check(issues, related);
    now = 30 * MIN; await det.check(issues, related);
    expect(jira.posted.length).toBe(3);
    expect(jira.posted[2]!.target).toBe("BOSS"); // re-posted on the boss itself, not a nonexistent grandboss
    expect(jira.posted[2]!.text).toContain("stage: 3");
    expect(logs.some((l) => l.startsWith("WARNING: [parked]"))).toBe(true);
  });

  test("the rate cap holds: no more than 3 posts per boss per hour, even across two children whose combined stages would otherwise total six", async () => {
    let now = 0;
    const jira = fakeJira();
    const logs: string[] = [];
    const det = createParkedDetector({ now: () => now, minutes: 1, addComment: jira.addComment, comments: jira.comments, links: async () => [], log: (l) => logs.push(l) });
    const issues = [iss("BOSS", "In Progress")];
    const related = [rel(iss("CH1", "To Do"), ["BOSS"]), rel(iss("CH2", "To Do"), ["BOSS"])];

    now = 0; await det.check(issues, related); // both floors start here

    now = 1 * MIN; await det.check(issues, related); // CH1 stage1, CH2 stage1 — 2 posts, both under the cap
    expect(jira.posted.length).toBe(2);

    now = 2 * MIN; await det.check(issues, related); // CH1 stage2 (3rd post, hits the cap exactly) — CH2 stage2 is BLOCKED
    expect(jira.posted.length).toBe(3);

    now = 3 * MIN; await det.check(issues, related); // CH1 stage3 and CH2's still-pending stage2 are both blocked — cap already spent
    expect(jira.posted.length).toBe(3);

    now = 5 * MIN; await det.check(issues, related); // still within the hour window — still capped
    expect(jira.posted.length).toBe(3);
    const rateCapLogs = logs.filter((l) => l.startsWith("WARNING: [parked]") && l.includes("rate cap"));
    expect(rateCapLogs.length).toBeGreaterThan(0);
    // Non-blocking review comment #1: the capped branch is re-entered on
    // EVERY poll (CH2's stage 2 attempt at 2min, 3min, and 5min; CH1's
    // stage 3 attempt at 3min and 5min — five capped attempts total, all
    // targeting "BOSS") but must log only ONCE per target, not once per
    // attempt — mirrors escalation-loop.ts's `cappedPanes` one-notice
    // behaviour, so an operator's `journalctl | grep WARNING` isn't flooded.
    expect(rateCapLogs.length).toBe(1);
  });

  test("REGRESSION (review finding): a child watched by TWO In Progress bosses escalates to BOTH, not neither — the tracker must key on (child, boss), not child alone", async () => {
    let now = 0;
    const jira = fakeJira();
    const det = createParkedDetector({ now: () => now, minutes: 10, addComment: jira.addComment, comments: jira.comments, links: jira.links });
    const issues = [iss("BOSS1", "In Progress"), iss("BOSS2", "In Progress")];
    const related = [rel(iss("CH", "To Do"), ["BOSS1", "BOSS2"])];

    await det.check(issues, related); // both (CH,BOSS1) and (CH,BOSS2) floors start at 0
    now = 5 * MIN; await det.check(issues, related); // still short of the threshold for either pair
    expect(jira.posted).toEqual([]);

    now = 10 * MIN; await det.check(issues, related); // both pairs cross the threshold on the SAME poll
    expect(jira.posted.length).toBe(2);
    const targets = jira.posted.map((p) => p.target).sort();
    expect(targets).toEqual(["BOSS1", "BOSS2"]);
    for (const p of jira.posted) {
      expect(p.text.startsWith(MARKER)).toBe(true);
      expect(p.text).toContain("fingerprint: CH");
      expect(p.text).toContain("stage: 1");
    }

    // Keeps advancing independently per pair, not thrashing back to a fresh
    // floor every poll (the livelock the bug produced: with the old
    // child-only keying this never reaches a second post at all).
    now = 20 * MIN; await det.check(issues, related); // stage 2 for both
    expect(jira.posted.length).toBe(4);
    expect(jira.posted.slice(2).map((p) => p.target).sort()).toEqual(["BOSS1", "BOSS2"]);
  });

  test("exclusion: under threshold never posts", async () => {
    let now = 0;
    const jira = fakeJira();
    const det = createParkedDetector({ now: () => now, minutes: 10, addComment: jira.addComment, comments: jira.comments, links: jira.links });
    const issues = [iss("BOSS", "In Progress")];
    const related = [rel(iss("CH", "To Do"), ["BOSS"])];
    now = 9 * MIN;
    await det.check(issues, related);
    expect(jira.posted).toEqual([]);
  });

  test("exclusion: no assignee never posts, even well past the threshold", async () => {
    let now = 100 * MIN;
    const jira = fakeJira();
    const det = createParkedDetector({ now: () => now, minutes: 10, addComment: jira.addComment, comments: jira.comments, links: jira.links });
    const issues = [iss("BOSS", "In Progress")];
    const related = [rel(iss("CH", "To Do", { assignee: null }), ["BOSS"])];
    await det.check(issues, related);
    expect(jira.posted).toEqual([]);
  });

  test("exclusion: butchr:parked-ok never posts, even well past the threshold", async () => {
    let now = 100 * MIN;
    const jira = fakeJira();
    const det = createParkedDetector({ now: () => now, minutes: 10, addComment: jira.addComment, comments: jira.comments, links: jira.links });
    const issues = [iss("BOSS", "In Progress")];
    const related = [rel(iss("CH", "To Do", { labels: [EXEMPT_LABEL] }), ["BOSS"])];
    await det.check(issues, related);
    expect(jira.posted).toEqual([]);
  });

  test("exclusion: boss not In Progress (Done / In Review) never posts", async () => {
    let now = 100 * MIN;
    const jira = fakeJira();
    const det = createParkedDetector({ now: () => now, minutes: 10, addComment: jira.addComment, comments: jira.comments, links: jira.links });
    for (const status of ["Done", "In Review"]) {
      const issues = [iss("BOSS", status)];
      const related = [rel(iss("CH", "To Do"), ["BOSS"])];
      await det.check(issues, related);
    }
    expect(jira.posted).toEqual([]);
  });

  test("the clock resets when the child leaves To Do and comes back: a brief park does not carry a stale floor into a later one", async () => {
    let now = 0;
    const jira = fakeJira();
    const det = createParkedDetector({ now: () => now, minutes: 10, addComment: jira.addComment, comments: jira.comments, links: jira.links });
    const issues = [iss("BOSS", "In Progress")];
    const parked = [rel(iss("CH", "To Do"), ["BOSS"])];
    const activated = [rel(iss("CH", "In Progress"), ["BOSS"])]; // child leaves To Do

    now = 0; await det.check(issues, parked); // floor starts at 0
    now = 5 * MIN; await det.check(issues, activated); // leaves To Do before the threshold — floor must reset
    now = 8 * MIN; await det.check(issues, parked); // parked again — a NEW floor starts here (8min), not the old one (0min)
    expect(jira.posted).toEqual([]); // 8min + would-be old floor (0) = 8min elapsed if the floor wrongly carried over -> still under 10, so this alone doesn't distinguish

    now = 17 * MIN; // 9 minutes since the SECOND floor (8min) — still short of a fresh 10-minute threshold
    await det.check(issues, parked);
    expect(jira.posted).toEqual([]); // proves the floor reset to 8min, not the original 0min (which would have fired by now)

    now = 18 * MIN; // 10 minutes since the second floor (8min)
    await det.check(issues, parked);
    expect(jira.posted.length).toBe(1);
  });

  test("a comments() fetch failure fails closed for that poll (no post, no throw) and a later successful poll still posts", async () => {
    let now = 0;
    const jira = fakeJira();
    let fail = true;
    const logs: string[] = [];
    const det = createParkedDetector({
      now: () => now,
      minutes: 10,
      addComment: jira.addComment,
      comments: async (issue) => { if (fail) throw new Error("503"); return jira.comments(issue); },
      links: jira.links,
      log: (l) => logs.push(l),
    });
    const issues = [iss("BOSS", "In Progress")];
    const related = [rel(iss("CH", "To Do"), ["BOSS"])];

    await det.check(issues, related); // floor starts at 0
    now = 10 * MIN;
    await det.check(issues, related); // comments() throws -> fails closed, no post
    expect(jira.posted).toEqual([]);
    expect(logs.some((l) => l.includes("WARNING: [parked]"))).toBe(true);

    fail = false;
    now = 11 * MIN;
    await det.check(issues, related); // comments() now succeeds -> posts
    expect(jira.posted.length).toBe(1);
  });

  test("a detector-internal throw is caught: check() never rejects", async () => {
    let now = 0;
    const det = createParkedDetector({
      now: () => now,
      minutes: 10,
      addComment: async () => { throw new Error("boom"); },
      comments: async () => [],
      links: async () => [],
    });
    const issues = [iss("BOSS", "In Progress")];
    const related = [rel(iss("CH", "To Do"), ["BOSS"])];
    await det.check(issues, related); // floor starts at 0
    now = 10 * MIN;
    await expect(det.check(issues, related)).resolves.toBeUndefined(); // addComment throws while posting stage 1 — swallowed
  });

  test("a links() fetch failure at stage 3 fails closed and logs, without throwing; a later successful poll still resolves it", async () => {
    let now = 0;
    const jira = fakeJira();
    const logs: string[] = [];
    let failLinks = true;
    const det = createParkedDetector({
      now: () => now,
      minutes: 10,
      addComment: jira.addComment,
      comments: jira.comments,
      links: async (issue) => { if (failLinks) throw new Error("503"); return jira.links(issue); },
      log: (l) => logs.push(l),
    });
    const issues = [iss("BOSS", "In Progress")];
    const related = [rel(iss("CH", "To Do"), ["BOSS"])];

    await det.check(issues, related); // floor starts at 0
    now = 10 * MIN; await det.check(issues, related); // stage 1
    now = 20 * MIN; await det.check(issues, related); // stage 2
    now = 30 * MIN; await det.check(issues, related); // stage 3 attempt — links() throws
    expect(jira.posted.length).toBe(2); // stage 1 + stage 2 only — stage 3 never posted this poll
    expect(logs.some((l) => l.startsWith("WARNING: [parked]") && l.includes("links fetch failed"))).toBe(true);

    failLinks = false;
    now = 31 * MIN; await det.check(issues, related); // links() now succeeds (no grandboss) -> terminal case resolves it
    expect(jira.posted.length).toBe(3);
    expect(jira.posted[2]!.target).toBe("BOSS");
  });
});
