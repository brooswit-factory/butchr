import { describe, expect, test } from "bun:test";
import { abandonedCandidates, createAbandonedDetector, MARKER } from "../../src/agents/abandoned.js";
import { parkedCandidates } from "../../src/agents/parked.js";
import type { JiraIssue, IssueLink } from "../../src/atlassian/types.js";
import type { RelatedIssue } from "../../src/daemon/loop.js";

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

  // BUTCHR-240: this predicate needed no widening to cover a To Do worker —
  // see abandonedCandidates's own "FORMER KNOWN LIMITATION" doc comment.
  // The only status it ever excludes is "Done" (skip), so a "To Do" worker
  // was always eligible; this test is the falsifier the ticket asked for,
  // kept permanently as the regression that proves it.
  test("BUTCHR-240: the state fires for a TO DO worker whose inward Implements boss is Done (the archetype case — the worker never started at all)", () => {
    const worker = iss("WORK-1", "To Do", { issuelinks: [bossLink("BOSS-1", "Done")] });
    expect(abandonedCandidates([worker])).toEqual([{ worker, boss: "BOSS-1" }]);
  });

  // Mirrors the existing "does NOT fire: open worker under a LIVE boss" test
  // one status down: a To Do worker under a LIVE boss is parked.ts's case,
  // not this module's — see the cross-detector proof below for the same
  // claim verified against BOTH predicates on one shared fixture.
  test("BUTCHR-240: does NOT fire: a TO DO worker under a LIVE (In Progress) boss — that is parked.ts's case, not this one", () => {
    const worker = iss("WORK-1", "To Do", { issuelinks: [bossLink("BOSS-1", "In Progress")] });
    expect(abandonedCandidates([worker])).toEqual([]);
  });

  // BUTCHR-240 hard requirement 3: fetching To Do workers makes the
  // no-shelved-exemption decision load-bearing for the first time —
  // `shelve_worker` moves a worker to To Do by contract, so this is the
  // exact shape a real shelved-and-stranded worker takes once fetched.
  test("BUTCHR-240: does NOT exempt butchr:shelved on a TO DO worker either — a shelved worker under a Done boss can never be reactivated by anyone and is MORE abandoned, not less (see abandoned.ts's own doc comment)", () => {
    const worker = iss("WORK-1", "To Do", { labels: ["butchr:shelved"], issuelinks: [bossLink("BOSS-1", "Done")] });
    expect(abandonedCandidates([worker])).toEqual([{ worker, boss: "BOSS-1" }]);
  });
});

/**
 * BUTCHR-240: proves — rather than merely asserting — that `parkedCandidates`
 * and `abandonedCandidates` stay mutually exclusive on boss status after this
 * ticket's change, on ONE SHARED fixture pattern rather than two independent
 * ones that could each pass while the real invariant silently broke. The
 * fixture is a To Do child/worker exactly as `abandonedCandidates` now
 * receives one (via `todoWorkers`) and exactly as `parkedCandidates` already
 * receives one (via `related`) — the two detectors' own candidate shapes,
 * not a third one invented for this test.
 */
describe("BUTCHR-240: parkedCandidates and abandonedCandidates are mutually exclusive on boss status", () => {
  const rel = (child: JiraIssue, watchers: string[]): RelatedIssue => ({ issue: child, watchers });

  test("boss LIVE (In Progress): parked fires, abandoned does not", () => {
    const child = iss("WORK-1", "To Do", { issuelinks: [bossLink("BOSS-1", "In Progress")] });
    const activeIssues = [iss("BOSS-1", "In Progress")]; // parked's own active-set resolution
    expect(parkedCandidates(activeIssues, [rel(child, ["BOSS-1"])])).toEqual([{ child, boss: "BOSS-1" }]);
    expect(abandonedCandidates([child])).toEqual([]);
  });

  test("boss DONE: abandoned fires, parked does not (a Done boss is never in ISSUE_JQL's active set, so bossStatus.get(boss) is undefined, not \"In Progress\")", () => {
    const child = iss("WORK-1", "To Do", { issuelinks: [bossLink("BOSS-1", "Done")] });
    const activeIssues: JiraIssue[] = []; // a Done boss is never in the active `issues` set
    expect(parkedCandidates(activeIssues, [rel(child, ["BOSS-1"])])).toEqual([]);
    expect(abandonedCandidates([child])).toEqual([{ worker: child, boss: "BOSS-1" }]);
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

  /** Exact value of a comment's `boss: <key>` line — never a bare `.includes()`, which a prefix-related key (BOSS-1 inside BOSS-19) would false-positive on (review finding #3). */
  const bossLineOf = (text: string): string | undefined => text.split("\n").find((l) => l.startsWith("boss: "))?.slice("boss: ".length);
  /** Exact value of a comment's `fingerprint: <key>` line, same reasoning. */
  const fingerprintLineOf = (text: string): string | undefined => text.split("\n").find((l) => l.startsWith("fingerprint: "))?.slice("fingerprint: ".length);

  // REGRESSION (review finding #1, then #3): a worker with TWO Done inward
  // Implements stubs must escalate BOTH pairs independently — before finding
  // #1's fix, stage 1/2's dedupe identity (`fingerprint: ${worker}`, `stage:
  // N`) omitted the boss entirely, so the second pair adopted the first
  // pair's comment. Before finding #3's fix, `need`'s `boss: ${boss}` entry
  // was un-delimited and `findMarked` matches by bare substring, so a boss
  // key that is a strict PREFIX of another (the norm in this project's own
  // key shape — BUTCHR-1/BUTCHR-19/BUTCHR-192) still collapsed the two
  // identities: `"boss: BOSS-19\n".includes("boss: BOSS-1")` is true. Uses
  // prefix-related keys deliberately, so this test would actually fail
  // without BOTH fixes.
  test("a worker with TWO Done bosses, one a key-prefix of the other, escalates to BOTH independently — the dedupe identity must include the boss AND be delimited", async () => {
    let now = 0;
    const jira = fakeJira();
    const det = createAbandonedDetector({ now: () => now, minutes: 30, addComment: jira.addComment, comments: jira.comments, links: jira.links });
    // Order matters for this regression to actually reproduce the bug: the
    // LONGER key (BOSS-19) must be processed FIRST so its comment already
    // exists when the SHORTER key (BOSS-1) is searched for — only then does
    // `"...boss: BOSS-19\n...".includes("boss: BOSS-1")` false-positive.
    const worker = iss("WORK-1", "In Progress", { issuelinks: [bossLink("BOSS-19", "Done"), bossLink("BOSS-1", "Done")] });

    now = 0; await det.check([worker]);
    now = 30 * MIN; await det.check([worker]); // stage 1 for BOTH (worker, boss) pairs

    expect(jira.posted.length).toBe(2);
    expect(jira.posted.every((p) => p.target === "WORK-1")).toBe(true);
    const bossesNamed = jira.posted.map((p) => bossLineOf(p.text)).sort();
    expect(bossesNamed).toEqual(["BOSS-1", "BOSS-19"]); // both bosses named exactly — before either fix this collapsed to one post
  });

  // REGRESSION (review finding #3, stage-3 half): the SAME prefix collision
  // is reachable on the bare `fingerprint:` line too, at stage 3, when TWO
  // DIFFERENT WORKERS whose keys are prefix-related are both abandoned under
  // bosses that resolve to the same stage-3 target. This half is inherited
  // from parked.ts's own `findMarked` usage (reported upward, not this
  // module's to fix), but the SAME one-line `need` delimiter closes it here.
  test("two workers with prefix-related keys, both abandoned under the SAME terminal boss, both reach stage 3 independently", async () => {
    let now = 0;
    const jira = fakeJira(); // linksByKey empty for BOSS-1 -> no grandboss -> terminal case targets BOSS-1 itself for both
    const det = createAbandonedDetector({ now: () => now, minutes: 1, addComment: jira.addComment, comments: jira.comments, links: jira.links });
    const w1 = iss("WORK-1", "In Progress", { issuelinks: [bossLink("BOSS-1", "Done")] });
    const w19 = iss("WORK-19", "In Progress", { issuelinks: [bossLink("BOSS-1", "Done")] });

    // Same ordering requirement as the boss-prefix test above: WORK-19
    // (longer key) must reach BOSS-1 first so its stage-3 comment already
    // exists when WORK-1 (shorter key) is searched for.
    now = 0 * MIN; await det.check([w19, w1]);
    now = 1 * MIN; await det.check([w19, w1]); // stage 1 (own tickets, distinct targets — no collision possible here)
    now = 2 * MIN; await det.check([w19, w1]); // stage 2 (own tickets)
    now = 3 * MIN; await det.check([w19, w1]); // stage 3, terminal: BOTH target BOSS-1

    const stage3OnBoss = jira.posted.filter((p) => p.target === "BOSS-1" && p.text.includes("stage: 3"));
    expect(stage3OnBoss.length).toBe(2);
    const workersNamed = stage3OnBoss.map((p) => fingerprintLineOf(p.text)).sort();
    expect(workersNamed).toEqual(["WORK-1", "WORK-19"]); // both workers named exactly — before the fix WORK-1's stage 3 was silently adopted by WORK-19's (or vice versa)
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

/**
 * BUTCHR-240: the `todoWorkers` fetch seam — tested at the seam the real
 * caller (`createAbandonedDetector`'s own `check`) actually uses, not just
 * at the pure predicate, since the whole point of this ticket is getting a
 * To Do worker INTO the array the predicate receives. Every test omitting
 * `todoWorkers` above already proves the seam is optional/backward
 * compatible (none of them wire it and all still pass).
 */
describe("createAbandonedDetector: the todoWorkers fetch seam (BUTCHR-240)", () => {
  test("a To Do worker returned ONLY by todoWorkers (never in the poll's own `issues`) still escalates on its own ticket", async () => {
    let now = 0;
    const jira = fakeJira();
    const todoWorker = iss("WORK-1", "To Do", { issuelinks: [bossLink("BOSS-1", "Done")] });
    const det = createAbandonedDetector({
      now: () => now,
      minutes: 30,
      addComment: jira.addComment,
      comments: jira.comments,
      links: jira.links,
      todoWorkers: async () => [todoWorker],
    });

    now = 0; await det.check([]); // the real poll's `issues` never contains a To Do worker
    now = 30 * MIN; await det.check([]);
    expect(jira.posted.length).toBe(1);
    expect(jira.posted[0]!.target).toBe("WORK-1");
    expect(jira.posted[0]!.text).toContain("boss: BOSS-1");
    expect(jira.posted[0]!.text).toContain("stage: 1");
  });

  test("todoWorkers results are concatenated with `issues`, not a replacement: a live In Progress worker (from `issues`) and a To Do worker (from todoWorkers) both escalate independently", async () => {
    let now = 0;
    const jira = fakeJira();
    const liveWorker = iss("WORK-LIVE", "In Progress", { issuelinks: [bossLink("BOSS-A", "Done")] });
    const todoWorker = iss("WORK-TODO", "To Do", { issuelinks: [bossLink("BOSS-B", "Done")] });
    const det = createAbandonedDetector({
      now: () => now,
      minutes: 30,
      addComment: jira.addComment,
      comments: jira.comments,
      links: jira.links,
      todoWorkers: async () => [todoWorker],
    });

    now = 0; await det.check([liveWorker]);
    now = 30 * MIN; await det.check([liveWorker]);
    const targets = jira.posted.map((p) => p.target).sort();
    expect(targets).toEqual(["WORK-LIVE", "WORK-TODO"]);
  });

  // Fail OPEN on the query itself (this test) is the deliberate OPPOSITE
  // direction from the detector's existing fail-CLOSED rule for an unknown
  // link-stub status (see the "Unknown-status fails closed" predicate test
  // above) — different subjects (an unreachable query vs. an unconfirmed
  // status), both intentional. See abandoned.ts's own comment on `check`
  // for why this is caught inside `check` itself, not left to the module's
  // outer try/catch.
  test("todoWorkers() throwing fails OPEN: the existing In Progress/In Review coverage over `issues` still runs and posts, and a WARNING is logged", async () => {
    let now = 0;
    const jira = fakeJira();
    const logs: string[] = [];
    const liveWorker = iss("WORK-LIVE", "In Progress", { issuelinks: [bossLink("BOSS-A", "Done")] });
    const det = createAbandonedDetector({
      now: () => now,
      minutes: 30,
      addComment: jira.addComment,
      comments: jira.comments,
      links: jira.links,
      todoWorkers: async () => { throw new Error("Jira 503"); },
      log: (l) => logs.push(l),
    });

    now = 0; await det.check([liveWorker]);
    now = 30 * MIN; await det.check([liveWorker]);
    expect(jira.posted.length).toBe(1);
    expect(jira.posted[0]!.target).toBe("WORK-LIVE"); // existing coverage unaffected by the failing extra query
    expect(logs.some((l) => l.startsWith("WARNING: [abandoned]") && l.includes("todoWorkers fetch failed"))).toBe(true);
  });

  test("a To Do worker that stops appearing in todoWorkers' results has its tracking forgotten, same as any other candidate leaving the set", async () => {
    let now = 0;
    const jira = fakeJira();
    let returnWorker = true;
    const todoWorker = iss("WORK-1", "To Do", { issuelinks: [bossLink("BOSS-1", "Done")] });
    const det = createAbandonedDetector({
      now: () => now,
      minutes: 30,
      addComment: jira.addComment,
      comments: jira.comments,
      links: jira.links,
      todoWorkers: async () => (returnWorker ? [todoWorker] : []),
    });

    now = 0; await det.check([]); // floor starts at 0
    now = 20 * MIN; await det.check([]); // still short of 30min

    returnWorker = false;
    now = 25 * MIN; await det.check([]); // worker disappears (e.g. re-homed/closed) -> tracking forgotten
    expect(jira.posted).toEqual([]);

    returnWorker = true;
    now = 25 * MIN; await det.check([]); // reappears -> a FRESH floor starts at 25min
    now = 54 * MIN; await det.check([]); // 29min after the fresh floor — still short
    expect(jira.posted).toEqual([]);
    now = 55 * MIN; await det.check([]); // 30min after the fresh floor
    expect(jira.posted.length).toBe(1);
  });
});
