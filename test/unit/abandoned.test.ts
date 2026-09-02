import { describe, expect, test } from "bun:test";
import { abandonedCandidates, createAbandonedDetector, MARKER } from "../../src/agents/abandoned.js";
import type { JiraIssue, IssueLink } from "../../src/atlassian/types.js";

const MIN = 60_000;

const iss = (key: string, status: string, opts: Partial<JiraIssue> = {}): JiraIssue =>
  ({ key, summary: "s", status, issuetype: "Task", assignee: "someone", parent: null, updated: "t", labels: [], ...opts });

/**
 * Builds an inward `Implements` stub the way the REAL `parseIssueLinks`
 * (src/atlassian/client.ts) actually produces one — `status` present only
 * when the payload carried it, matching FIXTURE DISCIPLINE (this ticket was
 * bitten twice before on fixtures no real caller could produce).
 */
const bossLink = (bossKey: string, status?: string): IssueLink =>
  ({ type: "Implements", otherEnd: "inward", key: bossKey, ...(status !== undefined ? { status } : {}) });

describe("abandonedCandidates (pure predicate)", () => {
  test("the state fires: an open worker under a Done boss is a candidate", () => {
    const worker = iss("WORK-1", "In Progress", { issuelinks: [bossLink("BOSS-1", "Done")] });
    expect(abandonedCandidates([worker])).toEqual([{ worker, boss: "BOSS-1" }]);
  });

  test("also fires for an In Review worker (both statuses ISSUE_JQL covers)", () => {
    const worker = iss("WORK-1", "In Review", { issuelinks: [bossLink("BOSS-1", "Done")] });
    expect(abandonedCandidates([worker])).toEqual([{ worker, boss: "BOSS-1" }]);
  });

  test("does NOT fire: open worker under a LIVE boss", () => {
    const worker = iss("WORK-1", "In Progress", { issuelinks: [bossLink("BOSS-1", "In Progress")] });
    expect(abandonedCandidates([worker])).toEqual([]);
  });

  test("does NOT fire: Done worker under a Done boss", () => {
    const worker = iss("WORK-1", "Done", { issuelinks: [bossLink("BOSS-1", "Done")] });
    expect(abandonedCandidates([worker])).toEqual([]);
  });

  test("does NOT fire: a worker with NO boss at all (that is an orphan — someone else's detector)", () => {
    const worker = iss("WORK-1", "In Progress", { issuelinks: [] });
    expect(abandonedCandidates([worker])).toEqual([]);
  });

  test("does NOT fire: a worker whose issuelinks is UNDEFINED entirely (never fabricated as an orphan OR as a candidate)", () => {
    const worker = iss("WORK-1", "In Progress");
    expect("issuelinks" in worker).toBe(false);
    expect(abandonedCandidates([worker])).toEqual([]);
  });

  test("does NOT fire: a Relates link to a Done issue is not an Implements boss", () => {
    const worker = iss("WORK-1", "In Progress", { issuelinks: [{ type: "Relates", otherEnd: "inward", key: "OTHER-1", status: "Done" }] });
    expect(abandonedCandidates([worker])).toEqual([]);
  });

  test("does NOT fire: an outward Implements link (this worker's OWN sub-worker, not its boss) is never read as a boss", () => {
    const worker = iss("WORK-1", "In Progress", { issuelinks: [{ type: "Implements", otherEnd: "outward", key: "SUB-1", status: "Done" }] });
    expect(abandonedCandidates([worker])).toEqual([]);
  });

  test("Unknown-status fails closed: a boss whose status is not present on the stub produces NO candidate (never inferred as Done, never as not-Done)", () => {
    const worker = iss("WORK-1", "In Progress", { issuelinks: [bossLink("BOSS-1")] });
    expect("status" in worker.issuelinks![0]!).toBe(false);
    expect(abandonedCandidates([worker])).toEqual([]);
  });

  // §3d: the OPPOSITE of parked.ts's decision — see abandoned.ts's own doc
  // comment on why `butchr:shelved` must NOT exempt here.
  test("does NOT exempt butchr:shelved, unlike parked.ts: a worker carrying the label is still a candidate when its boss is Done", () => {
    const worker = iss("WORK-1", "In Progress", { labels: ["butchr:shelved"], issuelinks: [bossLink("BOSS-1", "Done")] });
    expect(abandonedCandidates([worker])).toEqual([{ worker, boss: "BOSS-1" }]);
  });

  // Reachable in practice per parked.ts's own `pairKey` doc comment:
  // `jira_link_issues` adds a link rather than moving one, so a worker can
  // carry two inward Implements stubs (a stale one and a current one).
  test("a worker with TWO inward Implements stubs: only the Done one is a candidate, as its own (worker, boss) pair", () => {
    const worker = iss("WORK-1", "In Progress", { issuelinks: [bossLink("OLD-BOSS", "Done"), bossLink("NEW-BOSS", "In Progress")] });
    expect(abandonedCandidates([worker])).toEqual([{ worker, boss: "OLD-BOSS" }]);
  });

  test("a worker with TWO Done inward Implements stubs produces TWO candidates, one per boss", () => {
    const worker = iss("WORK-1", "In Progress", { issuelinks: [bossLink("BOSS-A", "Done"), bossLink("BOSS-B", "Done")] });
    const out = abandonedCandidates([worker]);
    expect(out.map((c) => c.boss).sort()).toEqual(["BOSS-A", "BOSS-B"]);
  });

  test("multiple workers: each evaluated independently", () => {
    const w1 = iss("WORK-1", "In Progress", { issuelinks: [bossLink("BOSS-1", "Done")] });
    const w2 = iss("WORK-2", "In Review", { issuelinks: [bossLink("BOSS-2", "In Progress")] });
    expect(abandonedCandidates([w1, w2])).toEqual([{ worker: w1, boss: "BOSS-1" }]);
  });
});

/** A fake Jira comment store: addComment writes land here, newest-first, exactly like AtlassianClient.comments(). Mirrors parked.test.ts's own fakeJira(). */
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
    comments: async (issue: string) => byTicket.get(issue) ?? [],
    links: async (issue: string) => linksByKey.get(issue) ?? [],
  };
}

describe("createAbandonedDetector: escalation path (through addComment, per the ticket's DoD)", () => {
  test("fires on WORK's own ticket after the threshold, not before — unlike parked.ts, which targets the (live) boss", async () => {
    let now = 0;
    const jira = fakeJira();
    const det = createAbandonedDetector({ now: () => now, minutes: 30, addComment: jira.addComment, comments: jira.comments, links: jira.links });
    const worker = iss("WORK-1", "In Progress", { issuelinks: [bossLink("BOSS-1", "Done")] });

    now = 0;
    await det.check([worker]);
    expect(jira.posted).toEqual([]);

    now = 29 * MIN;
    await det.check([worker]);
    expect(jira.posted).toEqual([]); // still short of the 30-minute default threshold

    now = 30 * MIN;
    await det.check([worker]);
    expect(jira.posted.length).toBe(1);
    expect(jira.posted[0]!.target).toBe("WORK-1"); // targets the worker's OWN ticket, not the (dead) boss
    expect(jira.posted[0]!.text.startsWith(MARKER)).toBe(true);
    expect(jira.posted[0]!.text).toContain("BOSS-1");
    expect(jira.posted[0]!.text).toContain("fingerprint: WORK-1");
    expect(jira.posted[0]!.text).toContain("boss: BOSS-1");
    expect(jira.posted[0]!.text).toContain("stage: 1");
    expect(jira.posted[0]!.text).toContain("30 minutes");
    // Observational, not accusatory.
    expect(jira.posted[0]!.text.toLowerCase()).not.toContain("mistake");
    // REGRESSION (review finding #2): elapsedMinutes is this daemon's own
    // observation age, not the real Jira transition time — stage 1 must say
    // "observed Done", matching stages 2/3, never assert "reached Done" as
    // if the transition moment itself were measured.
    expect(jira.posted[0]!.text).toContain("observed Done");
    expect(jira.posted[0]!.text).not.toContain("reached Done");
  });

  // REGRESSION (review finding #1): a worker with TWO Done inward Implements
  // stubs must escalate BOTH pairs independently — before the fix, stage
  // 1/2's dedupe identity (`fingerprint: ${worker}`, `stage: N`) omitted the
  // boss, so the second pair's postStage call found the first pair's
  // comment (same worker, same stage, same target) and silently "adopted"
  // it instead of posting its own — BOSS-B was never named anywhere.
  test("a worker with TWO Done bosses escalates to BOTH, independently — the dedupe identity must include the boss, not just the worker", async () => {
    let now = 0;
    const jira = fakeJira();
    const det = createAbandonedDetector({ now: () => now, minutes: 30, addComment: jira.addComment, comments: jira.comments, links: jira.links });
    const worker = iss("WORK-1", "In Progress", { issuelinks: [bossLink("BOSS-A", "Done"), bossLink("BOSS-B", "Done")] });

    now = 0; await det.check([worker]);
    now = 30 * MIN; await det.check([worker]); // stage 1 for BOTH (worker, boss) pairs

    expect(jira.posted.length).toBe(2);
    expect(jira.posted.every((p) => p.target === "WORK-1")).toBe(true);
    const bossesNamed = jira.posted.map((p) => (p.text.includes("boss: BOSS-A") ? "BOSS-A" : p.text.includes("boss: BOSS-B") ? "BOSS-B" : null)).sort();
    expect(bossesNamed).toEqual(["BOSS-A", "BOSS-B"]); // both bosses named — before the fix, this was ["BOSS-A", null] (BOSS-B silently adopted BOSS-A's comment)
  });

  test("it does NOT escalate again on the next poll (dedupe): re-running check() at the same or later time posts nothing further for stage 1", async () => {
    let now = 0;
    const jira = fakeJira();
    const det = createAbandonedDetector({ now: () => now, minutes: 30, addComment: jira.addComment, comments: jira.comments, links: jira.links });
    const worker = iss("WORK-1", "In Progress", { issuelinks: [bossLink("BOSS-1", "Done")] });

    await det.check([worker]); // floor starts at 0
    now = 30 * MIN;
    await det.check([worker]);
    expect(jira.posted.length).toBe(1);

    now = 45 * MIN; // short of stage 2's own threshold (stage1At + 30min)
    await det.check([worker]);
    expect(jira.posted.length).toBe(1);
  });

  test("dedupe survives a simulated daemon restart: a FRESH detector (fresh in-memory tracker) with the prior comment already on the ticket adopts it instead of re-posting", async () => {
    const jira = fakeJira();
    let now = 0;
    const before = createAbandonedDetector({ now: () => now, minutes: 30, addComment: jira.addComment, comments: jira.comments, links: jira.links });
    const worker = iss("WORK-1", "In Progress", { issuelinks: [bossLink("BOSS-1", "Done")] });
    await before.check([worker]); // floor starts at 0
    now = 30 * MIN;
    await before.check([worker]);
    expect(jira.posted.length).toBe(1);

    now = 60 * MIN; // arbitrary later time — the new tracker's floor starts HERE
    const after = createAbandonedDetector({ now: () => now, minutes: 30, addComment: jira.addComment, comments: jira.comments, links: jira.links });
    await after.check([worker]); // floor just started (60min) — not yet eligible from ITS OWN perspective
    expect(jira.posted.length).toBe(1);

    now = 90 * MIN; // 30 minutes after the fresh floor: `after` becomes eligible to (re-)attempt stage 1
    await after.check([worker]);
    expect(jira.posted.length).toBe(1); // adopted the EXISTING comment — no duplicate was posted
  });

  test("the follow-up (stage 2) fires once at stage 2, and only once, still on the worker's own ticket", async () => {
    let now = 0;
    const jira = fakeJira();
    const det = createAbandonedDetector({ now: () => now, minutes: 30, addComment: jira.addComment, comments: jira.comments, links: jira.links });
    const worker = iss("WORK-1", "In Progress", { issuelinks: [bossLink("BOSS-1", "Done")] });

    await det.check([worker]); // floor starts at 0
    now = 30 * MIN; await det.check([worker]); // stage 1
    expect(jira.posted.length).toBe(1);

    now = 45 * MIN; await det.check([worker]); // still short of stage 2
    expect(jira.posted.length).toBe(1);

    now = 60 * MIN; await det.check([worker]); // stage 2 threshold reached
    expect(jira.posted.length).toBe(2);
    expect(jira.posted[1]!.target).toBe("WORK-1");
    expect(jira.posted[1]!.text).toContain("stage: 2");
    expect(jira.posted[1]!.text).toContain("60 minutes"); // elapsed since firstObservedAt (0)

    now = 61 * MIN; await det.check([worker]);
    now = 75 * MIN; await det.check([worker]);
    expect(jira.posted.length).toBe(2); // no stage-2 duplicate (stage 3 not due yet at 75min: needs 90min)
  });

  test("stage 3 posts on the boss's OWN boss (the grandboss), resolved through the boss's inward Implements link", async () => {
    let now = 0;
    const jira = fakeJira();
    jira.linksByKey.set("BOSS-1", [{ type: "Implements", otherEnd: "inward", key: "GRANDBOSS-1" }]);
    const det = createAbandonedDetector({ now: () => now, minutes: 30, addComment: jira.addComment, comments: jira.comments, links: jira.links });
    const worker = iss("WORK-1", "In Progress", { issuelinks: [bossLink("BOSS-1", "Done")] });

    await det.check([worker]); // floor starts at 0
    now = 30 * MIN; await det.check([worker]); // stage 1 -> WORK-1
    now = 60 * MIN; await det.check([worker]); // stage 2 -> WORK-1
    now = 90 * MIN; await det.check([worker]); // stage 3 -> GRANDBOSS-1
    expect(jira.posted.length).toBe(3);
    expect(jira.posted[2]!.target).toBe("GRANDBOSS-1");
    expect(jira.posted[2]!.text.startsWith(MARKER)).toBe(true);
    expect(jira.posted[2]!.text).toContain("stage: 3");
    expect(jira.posted[2]!.text).toContain("WORK-1");
    expect(jira.posted[2]!.text).toContain("BOSS-1"); // names the boss that never discharged it

    now = 120 * MIN; await det.check([worker]); // nothing further after stage 3
    expect(jira.posted.length).toBe(3);
  });

  test("stage 3 with no grandboss re-posts on the (Done) boss itself and emits the WARNING: [abandoned] log line", async () => {
    let now = 0;
    const jira = fakeJira(); // linksByKey has nothing for BOSS-1 -> no inward Implements link
    const logs: string[] = [];
    const det = createAbandonedDetector({ now: () => now, minutes: 30, addComment: jira.addComment, comments: jira.comments, links: jira.links, log: (l) => logs.push(l) });
    const worker = iss("WORK-1", "In Progress", { issuelinks: [bossLink("BOSS-1", "Done")] });

    await det.check([worker]); // floor starts at 0
    now = 30 * MIN; await det.check([worker]);
    now = 60 * MIN; await det.check([worker]);
    now = 90 * MIN; await det.check([worker]);
    expect(jira.posted.length).toBe(3);
    expect(jira.posted[2]!.target).toBe("BOSS-1"); // re-posted on the (Done) boss itself, not a nonexistent grandboss
    expect(jira.posted[2]!.text).toContain("stage: 3");
    expect(logs.some((l) => l.startsWith("WARNING: [abandoned]"))).toBe(true);
  });

  test("the rate cap holds: no more than 3 posts per target per hour, even across two workers whose combined stages would otherwise total six", async () => {
    let now = 0;
    const jira = fakeJira();
    const logs: string[] = [];
    const det = createAbandonedDetector({ now: () => now, minutes: 1, addComment: jira.addComment, comments: jira.comments, links: async () => [], log: (l) => logs.push(l) });
    const w1 = iss("WORK-1", "In Progress", { issuelinks: [bossLink("BOSS-1", "Done")] });
    const w2 = iss("WORK-2", "In Progress", { issuelinks: [bossLink("BOSS-2", "Done")] });

    now = 0; await det.check([w1, w2]); // both floors start here

    now = 1 * MIN; await det.check([w1, w2]); // WORK-1 stage1, WORK-2 stage1 — 2 posts, each on its own target, both under the (per-target) cap
    expect(jira.posted.length).toBe(2);

    now = 2 * MIN; await det.check([w1, w2]); // WORK-1 stage2, WORK-2 stage2 — 4 posts total, still under each target's own 3/hour cap
    expect(jira.posted.length).toBe(4);

    now = 3 * MIN; await det.check([w1, w2]); // both reach stage3 with no grandboss -> re-post on their own (Done) boss, BOSS-1 / BOSS-2 respectively — each boss's OWN cap (post #3 on each) is exactly at the limit, so both still land
    expect(jira.posted.length).toBe(6);
    expect(jira.posted.filter((p) => p.target === "BOSS-1").length).toBe(1);
    expect(jira.posted.filter((p) => p.target === "BOSS-2").length).toBe(1);
    expect(logs.some((l) => l.startsWith("WARNING: [abandoned]") && l.includes("no boss of its own"))).toBe(true);
  });

  test("the rate cap holds PER TARGET: a single worker driven through all three stages on the SAME boss (terminal case reposts there) is capped at 3, and a fourth stage attempt logs the cap rather than posting", async () => {
    let now = 0;
    const jira = fakeJira();
    const logs: string[] = [];
    // minutes: 1 with a single worker only ever produces 3 posts total
    // (stage 1, 2, 3) — to exercise the cap itself, drive TWO workers under
    // the SAME boss through all three stages: 6 attempted posts on a mix of
    // WORK-1/WORK-2 (stage 1/2) and BOSS-1 (stage 3 terminal for both), so
    // BOSS-1's own budget (shared with nothing else here) sees exactly 2
    // stage-3 attempts — under the cap — while a THIRD worker's stage-3
    // attempt on BOSS-1 is the one that gets capped.
    const det = createAbandonedDetector({ now: () => now, minutes: 1, addComment: jira.addComment, comments: jira.comments, links: async () => [], log: (l) => logs.push(l) });
    const workers = ["WORK-1", "WORK-2", "WORK-3"].map((k) => iss(k, "In Progress", { issuelinks: [bossLink("BOSS-1", "Done")] }));

    now = 0; await det.check(workers);
    now = 1 * MIN; await det.check(workers); // 3x stage1 on WORK-1/2/3
    now = 2 * MIN; await det.check(workers); // 3x stage2 on WORK-1/2/3
    expect(jira.posted.length).toBe(6);

    now = 3 * MIN; await det.check(workers); // 3x stage3 attempts, all targeting BOSS-1 (terminal, no grandboss)
    // BOSS-1 had zero prior posts (stage 1/2 targeted the workers, not BOSS-1), so its own 3/hour budget admits all three stage-3 posts.
    expect(jira.posted.filter((p) => p.target === "BOSS-1").length).toBe(3);

    // A fourth worker under the same boss, entering fresh, still gets its OWN stage-1/2 posts (targeted at itself, a fresh budget) but its stage 3 attempt on BOSS-1 is now capped.
    const w4 = iss("WORK-4", "In Progress", { issuelinks: [bossLink("BOSS-1", "Done")] });
    now = 4 * MIN; await det.check([...workers, w4]); // w4's floor starts here — first appearance never advances its own elapsed time (same semantics as every entry above)
    now = 5 * MIN; await det.check([...workers, w4]); // w4 stage1
    now = 6 * MIN; await det.check([...workers, w4]); // w4 stage2
    now = 7 * MIN; await det.check([...workers, w4]); // w4 stage3 attempt on BOSS-1 -> capped
    expect(jira.posted.filter((p) => p.target === "BOSS-1").length).toBe(3); // no 4th post landed on BOSS-1
    expect(logs.some((l) => l.startsWith("WARNING: [abandoned]") && l.includes("rate cap"))).toBe(true);
  });

  test("a comments() fetch failure fails closed for that poll (no post, no throw) and a later successful poll still posts", async () => {
    let now = 0;
    const jira = fakeJira();
    let fail = true;
    const logs: string[] = [];
    const det = createAbandonedDetector({
      now: () => now,
      minutes: 30,
      addComment: jira.addComment,
      comments: async (issue) => { if (fail) throw new Error("503"); return jira.comments(issue); },
      links: jira.links,
      log: (l) => logs.push(l),
    });
    const worker = iss("WORK-1", "In Progress", { issuelinks: [bossLink("BOSS-1", "Done")] });

    await det.check([worker]); // floor starts at 0
    now = 30 * MIN;
    await det.check([worker]); // comments() throws -> fails closed, no post
    expect(jira.posted).toEqual([]);
    expect(logs.some((l) => l.includes("WARNING: [abandoned]"))).toBe(true);

    fail = false;
    now = 31 * MIN;
    await det.check([worker]); // comments() now succeeds -> posts
    expect(jira.posted.length).toBe(1);
  });

  test("a detector-internal throw is caught: check() never rejects", async () => {
    let now = 0;
    const det = createAbandonedDetector({
      now: () => now,
      minutes: 30,
      addComment: async () => { throw new Error("boom"); },
      comments: async () => [],
      links: async () => [],
    });
    const worker = iss("WORK-1", "In Progress", { issuelinks: [bossLink("BOSS-1", "Done")] });
    await det.check([worker]); // floor starts at 0
    now = 30 * MIN;
    await expect(det.check([worker])).resolves.toBeUndefined(); // addComment throws while posting stage 1 — swallowed
  });

  test("a links() fetch failure at stage 3 fails closed and logs, without throwing; a later successful poll still resolves it", async () => {
    let now = 0;
    const jira = fakeJira();
    const logs: string[] = [];
    let failLinks = true;
    const det = createAbandonedDetector({
      now: () => now,
      minutes: 30,
      addComment: jira.addComment,
      comments: jira.comments,
      links: async (issue) => { if (failLinks) throw new Error("503"); return jira.links(issue); },
      log: (l) => logs.push(l),
    });
    const worker = iss("WORK-1", "In Progress", { issuelinks: [bossLink("BOSS-1", "Done")] });

    await det.check([worker]); // floor starts at 0
    now = 30 * MIN; await det.check([worker]); // stage 1
    now = 60 * MIN; await det.check([worker]); // stage 2
    now = 90 * MIN; await det.check([worker]); // stage 3 attempt — links() throws
    expect(jira.posted.length).toBe(2); // stage 1 + stage 2 only — stage 3 never posted this poll
    expect(logs.some((l) => l.startsWith("WARNING: [abandoned]") && l.includes("links fetch failed"))).toBe(true);

    failLinks = false;
    now = 91 * MIN; await det.check([worker]); // links() now succeeds (no grandboss) -> terminal case resolves it
    expect(jira.posted.length).toBe(3);
    expect(jira.posted[2]!.target).toBe("BOSS-1");
  });

  test("the clock resets when the worker leaves the abandoned state and comes back: a brief abandonment does not carry a stale floor into a later one", async () => {
    let now = 0;
    const jira = fakeJira();
    const det = createAbandonedDetector({ now: () => now, minutes: 30, addComment: jira.addComment, comments: jira.comments, links: jira.links });
    const worker = iss("WORK-1", "In Progress", { issuelinks: [bossLink("BOSS-1", "Done")] });

    now = 0; await det.check([worker]); // floor starts at 0
    now = 20 * MIN; await det.check([worker]); // still short of 30min — no post yet

    // The worker's boss link resolves as unknown/live for one poll (e.g. a
    // transient re-observation) — forgetMissing drops the (worker, boss) pair.
    now = 25 * MIN; await det.check([]); // no candidates this poll
    expect(jira.posted).toEqual([]);

    // Reappears — a FRESH floor starts at 25min, not the original 0.
    now = 25 * MIN; await det.check([worker]);
    now = 54 * MIN; await det.check([worker]); // 29min after the fresh floor — still short
    expect(jira.posted).toEqual([]);
    now = 55 * MIN; await det.check([worker]); // 30min after the fresh floor
    expect(jira.posted.length).toBe(1);
  });
});
