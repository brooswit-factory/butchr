import { describe, expect, test } from "bun:test";
import { createStallRemediator, MARKER } from "../../src/agents/stall-remediation.js";

const MIN = 60_000;

/** A fake Jira comment store: addComment writes land here, newest-first, exactly like AtlassianClient.comments(). */
function fakeJira() {
  const byTicket = new Map<string, { id: string; body: string; created: string }[]>();
  const posted: { target: string; text: string }[] = [];
  let seq = 0;
  return {
    posted,
    addComment: async (issue: string, text: string) => {
      seq++;
      const now = new Date().toISOString();
      const rows = byTicket.get(issue) ?? [];
      rows.unshift({ id: `c${seq}`, body: text, created: now });
      byTicket.set(issue, rows);
      posted.push({ target: issue, text });
    },
    comments: async (issue: string) => byTicket.get(issue) ?? [],
    seed: (issue: string, id: string, body: string, created: string) => {
      const rows = byTicket.get(issue) ?? [];
      rows.unshift({ id, body, created });
      byTicket.set(issue, rows);
    },
  };
}

describe("createStallRemediator", () => {
  // Acceptance criterion 1: fires when the stall condition holds — driven
  // through the real code path (labelApplied=true), asserting an actual
  // addComment call, not a mock of the module's own function.
  test("acts (posts a wake comment) once agent:stalled is the APPLIED label", async () => {
    let now = 0;
    const jira = fakeJira();
    const rem = createStallRemediator({ now: () => now, addComment: jira.addComment, comments: jira.comments });
    const outcome = await rem.check("KAN-1", true, true);
    expect(outcome.kind).toBe("acted");
    expect(jira.posted.length).toBe(1);
    expect(jira.posted[0]!.target).toBe("KAN-1");
    expect(jira.posted[0]!.text.startsWith(MARKER)).toBe(true);
    expect(jira.posted[0]!.text).toContain("fingerprint: KAN-1");
    expect(jira.posted[0]!.text).toContain("agent:stalled");
  });

  test("never acts while agent:stalled is not yet the applied label, even if the raw signal is true this poll", async () => {
    const jira = fakeJira();
    const rem = createStallRemediator({ now: () => 0, addComment: jira.addComment, comments: jira.comments });
    const outcome = await rem.check("KAN-1", false, true);
    expect(outcome).toEqual({ kind: "suppressed", issue: "KAN-1", reason: "stabilizer has not confirmed yet" });
    expect(jira.posted).toEqual([]);
  });

  test("not-a-candidate when nothing is going on at all (labelApplied false, raw signal false)", async () => {
    const jira = fakeJira();
    const rem = createStallRemediator({ now: () => 0, addComment: jira.addComment, comments: jira.comments });
    const outcome = await rem.check("KAN-1", false, false);
    expect(outcome).toEqual({ kind: "not-a-candidate", issue: "KAN-1" });
    expect(jira.posted).toEqual([]);
  });

  // Hard constraint (AC6), PRECISELY: a null poll never GATES the
  // act/suppress decision, is never collapsed into "not stalled" or
  // "confirmed stalled", and never causes a post ON ITS OWN — the APPLIED
  // label does. A prior version of this suite (and the PR/doc prose) said
  // the narrower, ambiguous "a null poll never posts" — true only when
  // `labelApplied` is false, and caught in review as untested for the
  // `labelApplied: true` combination, where the module actually DOES act.
  // See StallOutcome's own doc comment in stall-remediation.ts for why that
  // is deliberate, not a gap.
  describe("the could-not-verify (null) poll never gates the decision, and is never collapsed", () => {
    test("null is its own distinct suppressed reason when the label is NOT applied — never conflated with not-a-candidate or stabilizing", async () => {
      const jira = fakeJira();
      const rem = createStallRemediator({ now: () => 0, addComment: jira.addComment, comments: jira.comments });
      const nullOutcome = await rem.check("KAN-1", false, null);
      const falseOutcome = await rem.check("KAN-2", false, false);
      const trueOutcome = await rem.check("KAN-3", false, true);
      expect(nullOutcome.kind).toBe("suppressed");
      expect(falseOutcome.kind).toBe("not-a-candidate");
      expect(trueOutcome.kind).toBe("suppressed");
      // All three are textually distinguishable from one another.
      const reasons = [nullOutcome, trueOutcome].map((o) => (o as { reason: string }).reason);
      expect(reasons[0]).not.toBe(reasons[1]);
      expect(jira.posted).toEqual([]);
    });

    test("while NOT applied, a null poll never posts and never corrupts state for a later real poll", async () => {
      let now = 0;
      const jira = fakeJira();
      const rem = createStallRemediator({ now: () => now, addComment: jira.addComment, comments: jira.comments });
      await rem.check("KAN-1", false, null); // could not verify, label not applied
      expect(jira.posted).toEqual([]);
      now = 5 * MIN;
      const outcome = await rem.check("KAN-1", true, true); // a later poll: label now genuinely applied
      expect(outcome.kind).toBe("acted");
      expect(jira.posted.length).toBe(1);
    });

    // PINS THE REVIEW FINDING: once the label is already APPLIED, a null
    // stalledPollResult this poll does NOT block remediation — the module
    // proceeds exactly as it would for `true`. DELIBERATE (see
    // StallOutcome's own doc comment): gating the wake on a fresh non-null
    // verification EVERY poll would let a persistently failing comments()
    // endpoint silently disable the deadlock-breaker during exactly the
    // degraded conditions where a becalming is most likely.
    test("once the label IS applied, a null stalledPollResult this poll still acts — the applied label gates, not the raw per-poll fetch", async () => {
      const jira = fakeJira();
      const rem = createStallRemediator({ now: () => 0, addComment: jira.addComment, comments: jira.comments });
      const outcome = await rem.check("KAN-1", true, null);
      expect(outcome.kind).toBe("acted");
      expect(jira.posted.length).toBe(1);
    });

    test("once the label IS applied, a null stalledPollResult still respects debounce (adoption/rate-cap), same as any other value", async () => {
      const jira = fakeJira();
      const rem = createStallRemediator({ now: () => 0, addComment: jira.addComment, comments: jira.comments });
      await rem.check("KAN-1", true, null); // acts once
      const again = await rem.check("KAN-1", true, null); // steady state
      expect(again.kind).toBe("suppressed");
      expect(jira.posted.length).toBe(1);
    });
  });

  // Acceptance criterion 2: debounce. The ticket's own measured shape —
  // 457 detections over ~2 hours (roughly one every 15s) — reproduced here
  // as 457 consecutive polls, asserting the comment COUNT, not merely that
  // "dedupe exists".
  test("debounces: 457 consecutive polls of a continuously-applied stall produce exactly ONE comment", async () => {
    let now = 0;
    const jira = fakeJira();
    const rem = createStallRemediator({ now: () => now, addComment: jira.addComment, comments: jira.comments });
    for (let i = 0; i < 457; i++) {
      now += 15_000;
      await rem.check("KAN-1", true, true);
    }
    expect(jira.posted.length).toBe(1);
  });

  // Acceptance criterion 8 (BUTCHR-210's late-arriving finding): the shared
  // dedupe mechanism (findMarked, escalation-helper.ts) matches an identity
  // string with a bare `body.includes(...)`, and Jira keys are not
  // prefix-free — an undelimited `fingerprint: WORK-1` is a substring of
  // `fingerprint: WORK-19`. Proven BOTH ways, per the boss's explicit
  // instruction, with the LONGER key's comment posted FIRST (a WORK-A/
  // WORK-B fixture would pass with or without the fix and prove nothing):
  //   1. WORK-1 (the shorter, prefix-related key) is never falsely adopted
  //      by a comment that actually belongs to WORK-19.
  //   2. WORK-19's own genuine self-adoption (the flood-avoidance half)
  //      still works — the fix that solves (1) must not break the
  //      requirement AC2 exists for.
  // This module's own fix (a trailing line after the fingerprint, plus a
  // `\n`-delimited needle — see wakeComment's own doc comment) is scoped to
  // THIS call site only, per instruction: escalation-helper.ts and every
  // other detector (parked.ts included) are untouched.
  test("AC8 regression: a prefix-related key is never falsely adopted, and genuine self-adoption still works, with the longer key posting first", async () => {
    const longKey = "WORK-19";
    const shortKey = "WORK-1"; // a strict prefix of longKey
    const jiraLong = fakeJira();
    const remLong = createStallRemediator({ now: () => 0, addComment: jiraLong.addComment, comments: jiraLong.comments });

    // 1. The LONGER key posts its wake comment FIRST.
    const longOutcome = await remLong.check(longKey, true, true);
    expect(longOutcome.kind).toBe("acted");
    expect(jiraLong.posted.length).toBe(1);

    // 2. The shorter, prefix-related key's OWN dedupe check is handed
    //    WORK-19's already-posted comment — standing in for any scenario
    //    (a shared target, a caller wiring mistake) where the same comment
    //    set is ever consulted for a prefix-related key. A fresh instance,
    //    because this must hold even with no memory of either key at all.
    const posted: string[] = [];
    const remShort = createStallRemediator({
      now: () => 0,
      addComment: async (_issue, text) => { posted.push(text); },
      comments: async () => jiraLong.posted.map((p, i) => ({ id: `shared${i}`, body: p.text, created: "2026-01-01T00:00:00.000Z" })),
    });
    const shortOutcome = await remShort.check(shortKey, true, true);
    expect(shortOutcome.kind).toBe("acted"); // NOT falsely adopted — a genuine new post happens
    expect(posted.length).toBe(1);
    expect(posted[0]).toContain(`fingerprint: ${shortKey}\n`);
    expect(posted[0]).not.toContain(`fingerprint: ${longKey}`);

    // 3. Genuine self-adoption still works: a FRESH instance for the LONGER
    //    key, against its own real comment history, adopts rather than
    //    re-posting — the fix did not trade the silent-no-post bug for the
    //    457-comment flood bug.
    const remLongRestarted = createStallRemediator({ now: () => 5 * MIN, addComment: jiraLong.addComment, comments: jiraLong.comments });
    const reCheck = await remLongRestarted.check(longKey, true, true);
    expect(reCheck.kind).toBe("suppressed");
    expect((reCheck as { reason: string }).reason).toContain("adopted existing comment");
    expect(jiraLong.posted.length).toBe(1); // still just the one — no duplicate
  });

  // Acceptance criterion 4: restart behaviour is explicit and tested. A
  // FRESH instance (empty in-memory map) against a channel that already
  // carries a prior wake comment must adopt it, not re-post.
  test("restart durability: a fresh instance adopts an existing wake comment instead of re-posting it", async () => {
    const jira = fakeJira();
    jira.seed("KAN-1", "c-prior", [MARKER, "", "fingerprint: KAN-1", "", "some prior wake text"].join("\n"), "2026-01-01T00:00:00.000Z");
    const logs: string[] = [];
    // A brand-new createStallRemediator call — no memory of KAN-1 at all —
    // simulating exactly what a daemon restart produces.
    const rem = createStallRemediator({ now: () => 10 * MIN, addComment: jira.addComment, comments: jira.comments, log: (l) => logs.push(l) });
    const outcome = await rem.check("KAN-1", true, true);
    expect(outcome).toEqual({ kind: "suppressed", issue: "KAN-1", reason: "adopted existing comment c-prior from 2026-01-01T00:00:00.000Z" });
    expect(jira.posted).toEqual([]); // no duplicate posted
    expect(logs.some((l) => l.includes("[stall] adopted existing wake comment") && l.includes("c-prior"))).toBe(true);

    // And it stays debounced afterward, exactly as a freshly-posted one would.
    const again = await rem.check("KAN-1", true, true);
    expect(again.kind).toBe("suppressed");
    expect(jira.posted).toEqual([]);
  });

  // Acceptance criterion 5: a write failure surfaces as a failure, tested,
  // and does not falsely latch success.
  test("a failed addComment surfaces as 'failed' with the error, logs a WARNING, and does not latch — a later successful poll still posts", async () => {
    let fail = true;
    const jira = fakeJira();
    const logs: string[] = [];
    const rem = createStallRemediator({
      now: () => 0,
      addComment: async (issue, text) => { if (fail) throw new Error("Jira 503"); return jira.addComment(issue, text); },
      comments: jira.comments,
      log: (l) => logs.push(l),
    });
    const outcome = await rem.check("KAN-1", true, true);
    expect(outcome).toEqual({ kind: "failed", issue: "KAN-1", error: "Jira 503" });
    expect(jira.posted).toEqual([]);
    expect(logs.some((l) => l.startsWith("WARNING: [stall]") && l.includes("Jira 503"))).toBe(true);

    fail = false;
    const retried = await rem.check("KAN-1", true, true); // not latched as spoken — retries normally
    expect(retried.kind).toBe("acted");
    expect(jira.posted.length).toBe(1);
  });

  test("a permanently failing write logs the WARNING once, not once per poll; a change in error logs again", async () => {
    let message = "Jira 503";
    const logs: string[] = [];
    const rem = createStallRemediator({
      now: () => 0,
      addComment: async () => { throw new Error(message); },
      comments: async () => [],
      log: (l) => logs.push(l),
    });
    await rem.check("KAN-1", true, true);
    await rem.check("KAN-1", true, true);
    await rem.check("KAN-1", true, true);
    expect(logs.filter((l) => l.includes("wake comment write failed")).length).toBe(1);
    message = "Jira 500";
    await rem.check("KAN-1", true, true);
    expect(logs.filter((l) => l.includes("wake comment write failed")).length).toBe(2);
  });

  test("a comments() fetch failure fails CLOSED: no post, no throw, retried on a later successful poll", async () => {
    let failFetch = true;
    const jira = fakeJira();
    const logs: string[] = [];
    const rem = createStallRemediator({
      now: () => 0,
      addComment: jira.addComment,
      comments: async (issue) => { if (failFetch) throw new Error("timeout"); return jira.comments(issue); },
      log: (l) => logs.push(l),
    });
    const outcome = await rem.check("KAN-1", true, true);
    expect(outcome.kind).toBe("suppressed");
    expect(jira.posted).toEqual([]);
    expect(logs.some((l) => l.startsWith("WARNING: [stall]") && l.includes("comments fetch failed"))).toBe(true);

    failFetch = false;
    const retried = await rem.check("KAN-1", true, true);
    expect(retried.kind).toBe("acted");
    expect(jira.posted.length).toBe(1);
  });

  test("an internal throw is caught: check() never rejects", async () => {
    const rem = createStallRemediator({
      now: () => { throw new Error("clock boom"); },
      addComment: async () => {},
      comments: async () => [],
    });
    await expect(rem.check("KAN-1", true, true)).resolves.toMatchObject({ kind: "failed", issue: "KAN-1" });
  });

  // Acceptance criterion 3: every stall-path poll outcome is distinguishable
  // in the logs, and a suppressed remediation ALWAYS states why (tested via
  // the log lines/outcome reasons above and below), while the steady-state
  // "already remediated" case stays CHEAP — no per-poll log line, matching
  // the flood policy this module states in its own top-of-file comment.
  test("log-flood policy: the steady-state 'already remediated' case logs nothing per poll, across many polls", async () => {
    let now = 0;
    const jira = fakeJira();
    const logs: string[] = [];
    const rem = createStallRemediator({ now: () => now, addComment: jira.addComment, comments: jira.comments, log: (l) => logs.push(l) });
    await rem.check("KAN-1", true, true); // acted — exactly one log line
    const logsAfterAct = logs.length;
    expect(logsAfterAct).toBeGreaterThan(0);
    for (let i = 0; i < 200; i++) {
      now += 15_000;
      const outcome = await rem.check("KAN-1", true, true);
      expect(outcome.kind).toBe("suppressed");
    }
    expect(logs.length).toBe(logsAfterAct); // zero NEW log lines across 200 steady-state polls
  });

  test("not-a-candidate logs nothing (mirrors frozen-asleep.ts's 'say NOTHING' convention for its own non-candidate case)", async () => {
    const logs: string[] = [];
    const rem = createStallRemediator({ now: () => 0, addComment: async () => {}, comments: async () => [], log: (l) => logs.push(l) });
    await rem.check("KAN-1", false, false);
    expect(logs).toEqual([]);
  });

  // The rate cap is a backstop against a BROKEN or lagging adoption read
  // (e.g. Jira read-after-write lag on the comments endpoint), not against
  // legitimate repeat episodes — those are already caught by adoption
  // itself (see the two tests below). Exercised here with a `comments()`
  // that never sees the module's own prior posts, forcing every forgotten-
  // and-retried episode to attempt a genuine new post.
  test("the rate cap backstops a comments() reader that never sees this module's own prior posts: at most 3 wake comments per hour", async () => {
    let now = 0;
    const posted: string[] = [];
    const logs: string[] = [];
    const rem = createStallRemediator({
      now: () => now,
      addComment: async (_issue, text) => { posted.push(text); },
      comments: async () => [], // simulates a lagging/broken adoption read — never finds its own prior post
      log: (l) => logs.push(l),
    });

    for (let episode = 0; episode < 4; episode++) {
      now = episode * MIN;
      rem.forget("KAN-1"); // simulate a fresh episode each time
      await rem.check("KAN-1", true, true);
    }
    expect(posted.length).toBe(3); // the 4th attempt is capped
    expect(logs.some((l) => l.startsWith("WARNING: [stall]") && l.includes("rate cap reached"))).toBe(true);
  });

  // DELIBERATE (see StallRemediationTracker.forget's own doc comment):
  // dedupe is by Jira EVIDENCE (the fingerprint on the ticket's own comment
  // history), not by in-memory episode bookkeeping — `forget` resets this
  // module's own floor/latch, but a real `comments()` reader still finds
  // the prior wake comment and adopts it. At most one wake comment per
  // issue for the ticket's lifetime, matching frozen-asleep.ts's identical
  // single-fingerprint-per-id convention.
  test("a later re-stall after `forget` adopts the SAME prior wake comment rather than posting a new one", async () => {
    let now = 0;
    const jira = fakeJira();
    const rem = createStallRemediator({ now: () => now, addComment: jira.addComment, comments: jira.comments });
    await rem.check("KAN-1", true, true);
    expect(jira.posted.length).toBe(1);
    rem.forget("KAN-1"); // recovered — floor/latch reset, but the Jira comment persists
    now = 5 * MIN;
    const outcome = await rem.check("KAN-1", true, true); // re-stalled later
    expect(outcome.kind).toBe("suppressed");
    expect(jira.posted.length).toBe(1); // adopted, not duplicated
  });

  test("a poll where the label is no longer applied (recovered) resets in-memory tracking, but a later re-stall still adopts the prior comment via Jira evidence", async () => {
    let now = 0;
    const jira = fakeJira();
    const rem = createStallRemediator({ now: () => now, addComment: jira.addComment, comments: jira.comments });
    await rem.check("KAN-1", true, true);
    expect(jira.posted.length).toBe(1);
    now = 1 * MIN;
    await rem.check("KAN-1", false, false); // recovered: label no longer applied
    now = 5 * MIN;
    const outcome = await rem.check("KAN-1", true, true); // re-stalled
    expect(outcome.kind).toBe("suppressed");
    expect(jira.posted.length).toBe(1); // still just the one, adopted
  });

  test("elapsed minutes reported are this module's OWN observation window, not fabricated", async () => {
    let now = 0;
    const jira = fakeJira();
    const rem = createStallRemediator({ now: () => now, addComment: jira.addComment, comments: jira.comments });
    await rem.check("KAN-1", true, true); // floor starts at 0 — not yet applied before this
    now = 7 * MIN;
    // still not spoken (spokenAt was set on the FIRST call above); simulate a
    // separate ticket to check elapsed-minutes text directly instead
    const jira2 = fakeJira();
    const rem2 = createStallRemediator({ now: () => now, addComment: jira2.addComment, comments: jira2.comments });
    await rem2.check("KAN-2", true, true); // floor starts at 7min for KAN-2, posts immediately (0 elapsed)
    expect(jira2.posted[0]!.text).toContain("0 minute(s)");
  });

  // Acceptance criterion 10 (BUTCHR-221, added after PR #253 merged): do not
  // fire the wake comment while the target's session quota is exhausted — a
  // quota-parked pane cannot read it, and posting burns the quota whose
  // return ends the outage.
  describe("criterion 10: quotaBlocked suppresses the wake without touching Jira", () => {
    test("a quota-blocked issue produces suppressed/quota-blocked and posts NOTHING", async () => {
      const jira = fakeJira();
      const rem = createStallRemediator({
        now: () => 0,
        addComment: jira.addComment,
        comments: jira.comments,
        quotaBlocked: () => true,
      });
      const outcome = await rem.check("KAN-1", true, true);
      expect(outcome).toEqual({ kind: "suppressed", issue: "KAN-1", reason: "quota-blocked" });
      expect(jira.posted).toEqual([]);
    });

    // "Order it so it is cheap: this check should short-circuit before the
    // comments() fetch" — proven directly, not inferred: comments() throws
    // if it is ever called, so the test fails loudly if the ordering
    // regresses instead of merely passing by coincidence.
    test("short-circuits BEFORE the comments() fetch — a quota-blocked poll never calls comments()", async () => {
      const posted: string[] = [];
      const rem = createStallRemediator({
        now: () => 0,
        addComment: async (_issue, text) => { posted.push(text); },
        comments: async () => { throw new Error("comments() must not be called while quota-blocked"); },
        quotaBlocked: () => true,
      });
      const outcome = await rem.check("KAN-1", true, true);
      expect(outcome).toEqual({ kind: "suppressed", issue: "KAN-1", reason: "quota-blocked" });
      expect(posted).toEqual([]);
    });

    // "the omitted-predicate case is unchanged from today's behaviour" —
    // proven directly against a fresh instance with no quotaBlocked dep at
    // all, not merely "still acts somewhere else in this file".
    test("the omitted-predicate case is unchanged: no quotaBlocked dep still acts exactly as before", async () => {
      const jira = fakeJira();
      const rem = createStallRemediator({ now: () => 0, addComment: jira.addComment, comments: jira.comments });
      const outcome = await rem.check("KAN-1", true, true);
      expect(outcome.kind).toBe("acted");
      expect(jira.posted.length).toBe(1);
    });

    // A predicate that returns false for this issue is likewise a no-op —
    // proves the gate is keyed by issue and not merely "supplied vs. not".
    test("a quotaBlocked predicate that returns false for this issue does not suppress", async () => {
      const jira = fakeJira();
      const rem = createStallRemediator({
        now: () => 0,
        addComment: jira.addComment,
        comments: jira.comments,
        quotaBlocked: (issue) => issue === "OTHER-1",
      });
      const outcome = await rem.check("KAN-1", true, true);
      expect(outcome.kind).toBe("acted");
      expect(jira.posted.length).toBe(1);
    });

    // The steady-state quota-blocked case must not flood the log — tested
    // the same way as the "already remediated" steady state above: many
    // polls, exactly one log line (the entering transition), zero more.
    test("log-flood policy: staying quota-blocked across many polls logs the transition once, not per poll", async () => {
      let now = 0;
      const logs: string[] = [];
      const rem = createStallRemediator({
        now: () => now,
        addComment: async () => {},
        comments: async () => [],
        quotaBlocked: () => true,
        log: (l) => logs.push(l),
      });
      await rem.check("KAN-1", true, true);
      const afterFirst = logs.length;
      expect(afterFirst).toBeGreaterThan(0);
      expect(logs.some((l) => l.includes("quota-blocked"))).toBe(true);
      for (let i = 0; i < 200; i++) {
        now += 15_000;
        const outcome = await rem.check("KAN-1", true, true);
        expect(outcome).toEqual({ kind: "suppressed", issue: "KAN-1", reason: "quota-blocked" });
      }
      expect(logs.length).toBe(afterFirst); // zero NEW log lines across 200 steady-state polls
    });

    // Recovery: once the predicate flips back to false, the module acts on
    // the very next poll (no memory of having been blocked persists as a
    // latch), and the recovery is itself logged exactly once — not a post
    // that silently resumes with no trace it had been suppressed.
    test("recovers on the next poll once quota clears, and logs the recovery transition exactly once", async () => {
      let blocked = true;
      const jira = fakeJira();
      const logs: string[] = [];
      const rem = createStallRemediator({
        now: () => 0,
        addComment: jira.addComment,
        comments: jira.comments,
        quotaBlocked: () => blocked,
        log: (l) => logs.push(l),
      });
      const first = await rem.check("KAN-1", true, true);
      expect(first).toEqual({ kind: "suppressed", issue: "KAN-1", reason: "quota-blocked" });
      expect(jira.posted).toEqual([]);

      blocked = false;
      const recovered = await rem.check("KAN-1", true, true);
      expect(recovered.kind).toBe("acted");
      expect(jira.posted.length).toBe(1);
      expect(logs.filter((l) => l.includes("no longer quota-blocked")).length).toBe(1);

      // And normal debounce applies afterward, exactly as any other acted
      // episode's would — quota-blocking is not a second dedupe mechanism.
      const again = await rem.check("KAN-1", true, true);
      expect(again.kind).toBe("suppressed");
      expect(jira.posted.length).toBe(1);
    });

    // Once already remediated (spokenAt latched), quota status is moot —
    // the steady-state "already remediated" branch returns before ever
    // consulting quotaBlocked, so a quota-blocked poll after a successful
    // post still reads as "already remediated", not "quota-blocked".
    test("after a wake comment already posted, a later quota-blocked poll reads as 'already remediated', not 'quota-blocked'", async () => {
      let now = 0;
      const jira = fakeJira();
      let blocked = false;
      const rem = createStallRemediator({
        now: () => now,
        addComment: jira.addComment,
        comments: jira.comments,
        quotaBlocked: () => blocked,
      });
      const acted = await rem.check("KAN-1", true, true);
      expect(acted.kind).toBe("acted");
      blocked = true;
      now = MIN;
      const outcome = await rem.check("KAN-1", true, true);
      expect(outcome.kind).toBe("suppressed");
      expect((outcome as { reason: string }).reason).toContain("already remediated");
      expect(jira.posted.length).toBe(1);
    });
  });

  // BUTCHR-353: the wake gains a "correctly waiting" branch (a worker
  // withheld at the admission cap, or In Review awaiting this ticket's own
  // review) and names any unanswered [ask] from the stalled ticket's own
  // workers — instead of the two harmful default branches (close/transition,
  // or "act now") that a correctly-waiting boss would otherwise be told.
  describe("BUTCHR-353: correctly-waiting / In Review / unanswered-ask branches", () => {
    /** A fake per-issue labels store, call-counted so tests can pin the cost bound (at most once per non-Done worker, only on the posting poll). */
    function fakeLabels(initial: Record<string, readonly string[]> = {}) {
      const store = new Map(Object.entries(initial));
      const calls: string[] = [];
      return {
        calls,
        set: (key: string, labels: readonly string[]) => store.set(key, labels),
        labels: async (key: string) => {
          calls.push(key);
          return store.get(key) ?? [];
        },
      };
    }

    // Falsifier 4 (must NOT change with none of the new signals) is already
    // pinned by every pre-existing test above (all call `check` with no
    // `workers` argument at all); this test additionally pins it with an
    // explicit EMPTY `workers` array, and asserts the exact byte-for-byte
    // DEFAULT_TAIL text survives — a body-shape regression, not merely
    // "still acted", would otherwise slip through unnoticed.
    test("no workers (or none non-Done): today's wake text, byte-for-byte unchanged", async () => {
      const jira = fakeJira();
      const rem = createStallRemediator({ now: () => 0, addComment: jira.addComment, comments: jira.comments });
      const outcome = await rem.check("KAN-1", true, true, null, []);
      expect(outcome.kind).toBe("acted");
      expect(jira.posted[0]!.text).toContain(
        "This comment exists to wake this ticket's agent. If it is genuinely done, close or transition this ticket so agent:stalled clears. If it is stuck, act on this ticket now.",
      );
      expect(jira.posted[0]!.text).not.toContain("[butchr:stall:waiting]");
    });

    test("a Done worker is excluded entirely: no labels/comments call for it, and it produces no signal even with stale [ask]/withheld data present", async () => {
      const jira = fakeJira();
      const lbl = fakeLabels({ "WORK-1": ["agent:none", "admission:withheld"] });
      jira.seed("WORK-1", "c1", "[WORK-1] [ask] still waiting?", "2026-01-01T00:00:00.000Z");
      const rem = createStallRemediator({ now: () => 0, addComment: jira.addComment, comments: jira.comments, labels: lbl.labels });
      const outcome = await rem.check("KAN-1", true, true, null, [{ key: "WORK-1", status: "Done" }]);
      expect(outcome.kind).toBe("acted");
      expect(jira.posted[0]!.text).not.toContain("WORK-1");
      expect(jira.posted[0]!.text).not.toContain("[butchr:stall:waiting]");
      expect(lbl.calls).toEqual([]);
    });

    // (B) — the core "correctly waiting" case BUTCHR-207 measured on
    // BUTCHR-238: agent:none + admission:withheld reads as withheld via
    // BUTCHR-352's own reused label-path rule, and the wake must NOT advise
    // transitioning/closing or acting now (falsifier 2).
    test("(B) a non-Done, non-In-Review worker with agent:none + admission:withheld: named as withheld, harmful advice absent", async () => {
      const jira = fakeJira();
      const lbl = fakeLabels({ "WORK-1": ["agent:none", "admission:withheld"] });
      const rem = createStallRemediator({ now: () => 0, addComment: jira.addComment, comments: jira.comments, labels: lbl.labels });
      const outcome = await rem.check("KAN-1", true, true, null, [{ key: "WORK-1", status: "In Progress" }]);
      expect(outcome.kind).toBe("acted");
      const text = jira.posted[0]!.text;
      expect(text).toContain("[butchr:stall:waiting]");
      expect(text).toContain("WORK-1");
      expect(text).toContain("admission:withheld");
      expect(text).not.toContain("close or transition this ticket so agent:stalled clears");
      expect(text).not.toContain("act on this ticket now");
    });

    // Falsifier 5, control A: a STALE marker (worker's real agent:* label is
    // NOT none — it is genuinely running) must NOT convert to "withheld" —
    // BUTCHR-352's own rule (admission only ever withholds a candidate with
    // no running agent) makes this state unreachable by construction, not by
    // a special case here. Falls all the way through to the unchanged
    // default text since no other signal applies.
    test("falsifier 5 (a): agent:working + admission:withheld is a STALE marker — never reported as withheld", async () => {
      const jira = fakeJira();
      const lbl = fakeLabels({ "WORK-1": ["agent:working", "admission:withheld"] });
      const rem = createStallRemediator({ now: () => 0, addComment: jira.addComment, comments: jira.comments, labels: lbl.labels });
      const outcome = await rem.check("KAN-1", true, true, null, [{ key: "WORK-1", status: "In Progress" }]);
      expect(outcome.kind).toBe("acted");
      const text = jira.posted[0]!.text;
      expect(text).not.toContain("[butchr:stall:waiting]");
      expect(text).not.toContain("WORK-1");
      expect(text).toContain("close or transition this ticket so agent:stalled clears");
    });

    // Falsifier 5, control B: the STRANDING case (BUTCHR-352 review round
    // 1's own finding) — a marker with NO agent:* label at all is
    // could-not-look, not withheld, regardless of the marker.
    test("falsifier 5 (b): admission:withheld with NO agent:* label at all (stranded) — never reported as withheld", async () => {
      const jira = fakeJira();
      const lbl = fakeLabels({ "WORK-1": ["admission:withheld"] });
      const rem = createStallRemediator({ now: () => 0, addComment: jira.addComment, comments: jira.comments, labels: lbl.labels });
      const outcome = await rem.check("KAN-1", true, true, null, [{ key: "WORK-1", status: "In Progress" }]);
      expect(outcome.kind).toBe("acted");
      expect(jira.posted[0]!.text).not.toContain("[butchr:stall:waiting]");
    });

    // (B2) — new scope: a worker In Review awaiting THIS boss's own review
    // counts as correctly waiting too (falsifier 3), and — because status
    // alone (a live read) already answers it — the labels dep is never even
    // consulted for that worker (cost bound: labels paid only for the
    // non-In-Review subset).
    test("(B2) a non-Done worker In Review: named, no harmful advice, and labels() is never called for it", async () => {
      const jira = fakeJira();
      const lbl = fakeLabels();
      const rem = createStallRemediator({ now: () => 0, addComment: jira.addComment, comments: jira.comments, labels: lbl.labels });
      const outcome = await rem.check("KAN-1", true, true, null, [{ key: "WORK-1", status: "In Review" }]);
      expect(outcome.kind).toBe("acted");
      const text = jira.posted[0]!.text;
      expect(text).toContain("[butchr:stall:waiting]");
      expect(text).toContain("WORK-1");
      expect(text).toContain("In Review");
      expect(text).not.toContain("close or transition this ticket so agent:stalled clears");
      expect(text).not.toContain("act on this ticket now");
      expect(lbl.calls).toEqual([]);
    });

    // (C) — BUTCHR-316/BUTCHR-341's own measured deadlock: a worker's own
    // [ask], with no reply from THIS boss yet, must be named (falsifier 1).
    test("(C) a non-Done worker with an unanswered [ask]: named, harmful advice absent", async () => {
      const jira = fakeJira();
      jira.seed("WORK-1", "c1", "[WORK-1] [ask] can I proceed without a reviewer?", "2026-01-01T00:00:00.000Z");
      const rem = createStallRemediator({ now: () => 0, addComment: jira.addComment, comments: jira.comments });
      const outcome = await rem.check("KAN-1", true, true, null, [{ key: "WORK-1", status: "In Progress" }]);
      expect(outcome.kind).toBe("acted");
      const text = jira.posted[0]!.text;
      expect(text).toContain("[butchr:stall:waiting]");
      expect(text).toContain("WORK-1");
      expect(text).toContain("[ask]");
      expect(text).not.toContain("close or transition this ticket so agent:stalled clears");
    });

    // (C), the other direction (falsifier 1's own "without one, it does
    // not" half): a reply from THIS boss, posted AFTER the ask (i.e. newer,
    // earlier in the newest-first list), makes it answered — not named.
    test("(C) an [ask] answered by THIS boss (a later tell_worker reply) is NOT named", async () => {
      const jira = fakeJira();
      jira.seed("WORK-1", "c1", "[WORK-1] [ask] can I proceed without a reviewer?", "2026-01-01T00:00:00.000Z");
      jira.seed("WORK-1", "c2", "[KAN-1] yes, go ahead", "2026-01-01T00:05:00.000Z"); // seeded AFTER c1 -> newer, unshifted to the front
      const rem = createStallRemediator({ now: () => 0, addComment: jira.addComment, comments: jira.comments });
      const outcome = await rem.check("KAN-1", true, true, null, [{ key: "WORK-1", status: "In Progress" }]);
      expect(outcome.kind).toBe("acted");
      const text = jira.posted[0]!.text;
      expect(text).not.toContain("[butchr:stall:waiting]");
      expect(text).toContain("This comment exists to wake this ticket's agent");
    });

    // (C) control: a reply from a DIFFERENT ticket's identity tag (not this
    // boss) must not count as an answer — proves the check is keyed on
    // "reply from THIS caller", not "any later comment at all".
    test("(C) a later comment from someone OTHER than this boss does not count as an answer", async () => {
      const jira = fakeJira();
      jira.seed("WORK-1", "c1", "[WORK-1] [ask] can I proceed without a reviewer?", "2026-01-01T00:00:00.000Z");
      jira.seed("WORK-1", "c2", "[OTHER-9] unrelated chatter", "2026-01-01T00:05:00.000Z");
      const rem = createStallRemediator({ now: () => 0, addComment: jira.addComment, comments: jira.comments });
      const outcome = await rem.check("KAN-1", true, true, null, [{ key: "WORK-1", status: "In Progress" }]);
      const text = jira.posted[0]!.text;
      expect(text).toContain("[butchr:stall:waiting]");
      expect(text).toContain("WORK-1");
    });

    // Multiple simultaneous signals across different workers are all named
    // in one wake, rather than the module picking only one.
    test("multiple workers with different signals are all named in one wake", async () => {
      const jira = fakeJira();
      const lbl = fakeLabels({ "WORK-1": ["agent:none", "admission:withheld"] });
      jira.seed("WORK-2", "c1", "[WORK-2] [ask] need a decision", "2026-01-01T00:00:00.000Z");
      const rem = createStallRemediator({ now: () => 0, addComment: jira.addComment, comments: jira.comments, labels: lbl.labels });
      const outcome = await rem.check("KAN-1", true, true, null, [
        { key: "WORK-1", status: "In Progress" },
        { key: "WORK-2", status: "In Progress" },
        { key: "WORK-3", status: "In Review" },
      ]);
      expect(outcome.kind).toBe("acted");
      const text = jira.posted[0]!.text;
      expect(text).toContain("WORK-1");
      expect(text).toContain("admission:withheld");
      expect(text).toContain("WORK-2");
      expect(text).toContain("[ask]");
      expect(text).toContain("WORK-3");
      expect(text).toContain("In Review");
    });

    // Unknown never becomes a confident claim: a labels() rejection for a
    // worker is caught, logged, and that worker is simply dropped from the
    // withheld signal — never defaulted into "withheld".
    test("a labels() fetch failure for a worker is not claimed as withheld, and is logged without the failure crashing the poll", async () => {
      const jira = fakeJira();
      const logs: string[] = [];
      const rem = createStallRemediator({
        now: () => 0,
        addComment: jira.addComment,
        comments: jira.comments,
        labels: async () => { throw new Error("Jira 500"); },
        log: (l) => logs.push(l),
      });
      const outcome = await rem.check("KAN-1", true, true, null, [{ key: "WORK-1", status: "In Progress" }]);
      expect(outcome.kind).toBe("acted");
      expect(jira.posted[0]!.text).not.toContain("[butchr:stall:waiting]");
      expect(logs.some((l) => l.startsWith("WARNING: [stall]") && l.includes("WORK-1") && l.includes("labels fetch failed"))).toBe(true);
    });

    // Same discipline for the ask check's own comments() read of a WORKER's
    // ticket (distinct from the stalled ticket's own comments() read used
    // for adoption/dedupe, which must still succeed for this poll to reach
    // the posting path at all).
    test("a comments() fetch failure for a worker's own ticket is not claimed as an unanswered ask, and is logged", async () => {
      const jira = fakeJira();
      const logs: string[] = [];
      const rem = createStallRemediator({
        now: () => 0,
        addComment: jira.addComment,
        comments: async (issue) => { if (issue === "WORK-1") throw new Error("timeout"); return jira.comments(issue); },
        log: (l) => logs.push(l),
      });
      const outcome = await rem.check("KAN-1", true, true, null, [{ key: "WORK-1", status: "In Progress" }]);
      expect(outcome.kind).toBe("acted");
      expect(jira.posted[0]!.text).not.toContain("[butchr:stall:waiting]");
      expect(logs.some((l) => l.startsWith("WARNING: [stall]") && l.includes("WORK-1") && l.includes("comments fetch failed"))).toBe(true);
    });

    // `labels` omitted entirely: the ask/In-Review branches still work
    // (they don't need it), and the withheld branch is simply unavailable
    // — never a throw.
    test("labels dep omitted: ask/In-Review branches still work; withheld branch is silently unavailable", async () => {
      const jira = fakeJira();
      jira.seed("WORK-1", "c1", "[WORK-1] [ask] anyone there?", "2026-01-01T00:00:00.000Z");
      const rem = createStallRemediator({ now: () => 0, addComment: jira.addComment, comments: jira.comments });
      const outcome = await rem.check("KAN-1", true, true, null, [{ key: "WORK-1", status: "In Progress" }]);
      expect(outcome.kind).toBe("acted");
      expect(jira.posted[0]!.text).toContain("[butchr:stall:waiting]");
    });

    // COST BOUND: worker reads happen at most once per stalled EPISODE — on
    // the poll that actually posts — never on a steady-state
    // "already remediated" poll, matching the log-flood discipline the rest
    // of this module already enforces.
    test("cost bound: labels()/comments(worker) are called only on the poll that actually posts, never again in steady state", async () => {
      let now = 0;
      const jira = fakeJira();
      const lbl = fakeLabels({ "WORK-1": ["agent:none", "admission:withheld"] });
      const rem = createStallRemediator({ now: () => now, addComment: jira.addComment, comments: jira.comments, labels: lbl.labels });
      await rem.check("KAN-1", true, true, null, [{ key: "WORK-1", status: "In Progress" }]);
      expect(lbl.calls).toEqual(["WORK-1"]);
      for (let i = 0; i < 50; i++) {
        now += 15_000;
        const outcome = await rem.check("KAN-1", true, true, null, [{ key: "WORK-1", status: "In Progress" }]);
        expect(outcome.kind).toBe("suppressed");
      }
      expect(lbl.calls).toEqual(["WORK-1"]); // still just the one call, from the posting poll
    });

    // COST BOUND, the other short-circuits: quota-blocked and rate-capped
    // polls must not touch labels()/comments(worker) either — they return
    // before gatherWorkerSignals is ever reached.
    test("cost bound: a quota-blocked poll never calls labels() for a worker", async () => {
      const jira = fakeJira();
      const lbl = fakeLabels({ "WORK-1": ["agent:none", "admission:withheld"] });
      const rem = createStallRemediator({
        now: () => 0,
        addComment: jira.addComment,
        comments: jira.comments,
        labels: lbl.labels,
        quotaBlocked: () => true,
      });
      const outcome = await rem.check("KAN-1", true, true, null, [{ key: "WORK-1", status: "In Progress" }]);
      expect(outcome).toEqual({ kind: "suppressed", issue: "KAN-1", reason: "quota-blocked" });
      expect(lbl.calls).toEqual([]);
    });
  });
});
