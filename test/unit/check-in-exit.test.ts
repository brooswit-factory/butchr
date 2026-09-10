import { describe, expect, test } from "bun:test";
import { createCheckInExitRegistry } from "../../src/agents/check-in-exit.js";
import { createFrozenAsleepDetector } from "../../src/agents/frozen-asleep.js";
import { reconcileNow } from "../../src/daemon/loop.js";
import type { Herd, SpawnSpec } from "../../src/agents/herd.js";

// BUTCHR-275 (implementing BUTCHR-271): the registry itself, unit-level —
// declare/consume semantics, no reconcileNow involved. Failure conditions
// stated first, per test, same discipline as check_in's own block in
// test/unit/tools.test.ts.
describe("createCheckInExitRegistry (BUTCHR-275)", () => {
  test("an id that never declared is never reported — check() must not invent a positive signal", async () => {
    const reg = createCheckInExitRegistry();
    const out = await reg.check(["BUTCHR"]);
    expect(out.size).toBe(0);
  });

  test("a declared id, present in restingRunning, is reported exactly once — declare() is one-shot, not a standing flag", async () => {
    const reg = createCheckInExitRegistry();
    reg.declare("BUTCHR");
    const first = await reg.check(["BUTCHR"]);
    expect([...first]).toEqual(["BUTCHR"]);
    // Consumed — a second poll with no fresh declare() must find nothing,
    // otherwise a single check_in would silently authorize every future
    // sleep episode of this id forever.
    const second = await reg.check(["BUTCHR"]);
    expect(second.size).toBe(0);
  });

  test("declare() is idempotent — calling it twice before consumption still reports the id exactly once", async () => {
    const reg = createCheckInExitRegistry();
    reg.declare("BUTCHR");
    reg.declare("BUTCHR");
    const out = await reg.check(["BUTCHR"]);
    expect([...out]).toEqual(["BUTCHR"]);
  });

  test("a declared id NOT in this poll's restingRunning is left alone (not consumed, not reported) — it waits for a poll that actually observes it resting", async () => {
    const reg = createCheckInExitRegistry();
    reg.declare("BUTCHR");
    const out = await reg.check(["OTHER"]); // BUTCHR not currently resting-and-running
    expect(out.size).toBe(0);
    // Still declared — a later poll that DOES observe it resting finds it.
    const later = await reg.check(["BUTCHR"]);
    expect([...later]).toEqual(["BUTCHR"]);
  });

  test("only the declared id among several candidates is reported — no cross-id leakage", async () => {
    const reg = createCheckInExitRegistry();
    reg.declare("A");
    const out = await reg.check(["A", "B", "C"]);
    expect([...out]).toEqual(["A"]);
  });
});

// BUTCHR-275 (review round 2): invalidateActive, added because code review
// found the registry's original "a never-consumed declaration just waits,
// harmlessly" assumption false — see check-in-exit.ts's own "PER-EPISODE
// INVALIDATION" section for the full hazard.
describe("createCheckInExitRegistry.invalidateActive (BUTCHR-275, review round 2)", () => {
  test("a declared id observed in `desired` (active) is dropped — a later poll that finds it resting must not report it", async () => {
    const reg = createCheckInExitRegistry();
    reg.declare("BUTCHR");
    reg.invalidateActive(["BUTCHR"]); // observed active before ever being consumed
    const out = await reg.check(["BUTCHR"]); // later poll: resting again, but the declaration is gone
    expect(out.size).toBe(0);
  });

  test("invalidateActive is a no-op for an id that was never declared — it must not throw or affect anything else", async () => {
    const reg = createCheckInExitRegistry();
    reg.invalidateActive(["NEVER_DECLARED"]);
    reg.declare("OTHER");
    const out = await reg.check(["OTHER"]);
    expect([...out]).toEqual(["OTHER"]);
  });

  test("invalidateActive only touches the ids it is given — a different declared id survives", async () => {
    const reg = createCheckInExitRegistry();
    reg.declare("A");
    reg.declare("B");
    reg.invalidateActive(["A"]); // only A went active again
    const out = await reg.check(["A", "B"]);
    expect([...out]).toEqual(["B"]); // A was pruned, B survives untouched
  });

  test("a re-declared id after invalidation is reported again — invalidation only clears one episode's declaration, not the id permanently", async () => {
    const reg = createCheckInExitRegistry();
    reg.declare("BUTCHR");
    reg.invalidateActive(["BUTCHR"]);
    reg.declare("BUTCHR"); // a fresh episode's own check_in
    const out = await reg.check(["BUTCHR"]);
    expect([...out]).toEqual(["BUTCHR"]);
  });
});

function fakeHerd(initial: string[] = []): Herd & { stopped: string[]; running: Set<string> } {
  const running = new Set(initial);
  const stopped: string[] = [];
  return {
    running, stopped,
    async runningIssues() { return [...running]; },
    async staleIssues() { return []; },
    async spawn(sp: SpawnSpec) { running.add(sp.key); },
    async stop(i: string) { stopped.push(i); running.delete(i); },
    async paneFor(i: string) { return running.has(i) ? `pane-${i}` : null; },
    async nudge() { return { delivered: true }; },
  };
}

// End-to-end through reconcileNow, same shape as frozen-asleep.test.ts's own
// "bounds atRest in time end to end" block — the sibling proof for the
// DECLARED-DONE half instead of the FROZEN half.
describe("reconcileNow: checkDeclaredDone releases atRest immediately on its own signal (BUTCHR-275)", () => {
  test("a declared, asleep-and-running project is stopped THIS poll — no bound, no wait, unlike checkFrozenAsleep", async () => {
    const reg = createCheckInExitRegistry();
    const herd = fakeHerd(["BUTCHR", "OTHER"]);
    const desired = new Map([["OTHER", { key: "OTHER", issuetype: "project", summary: "s", parent: null }]]);

    reg.declare("BUTCHR"); // the agent's own check_in, just landed
    await reconcileNow(herd, desired, { atRest: ["BUTCHR"], checkDeclaredDone: reg.check });

    expect(herd.stopped).toEqual(["BUTCHR"]); // stopped on the very first poll after declaring
    expect(herd.running.has("BUTCHR")).toBe(false);
    expect(herd.running.has("OTHER")).toBe(true); // untouched — OTHER was never atRest
  });

  test("an undeclared, asleep-and-running project is left alone — atRest protects it exactly as before this ticket", async () => {
    const reg = createCheckInExitRegistry();
    const herd = fakeHerd(["BUTCHR"]);
    await reconcileNow(herd, new Map(), { atRest: ["BUTCHR"], checkDeclaredDone: reg.check });
    expect(herd.stopped).toEqual([]);
    expect(herd.running.has("BUTCHR")).toBe(true);
  });

  test("a repeat poll with nothing freshly declared does not re-stop or misfire — declare() must be consumed, not re-checked", async () => {
    const reg = createCheckInExitRegistry();
    const herd = fakeHerd(["BUTCHR"]);
    reg.declare("BUTCHR");
    await reconcileNow(herd, new Map(), { atRest: ["BUTCHR"], checkDeclaredDone: reg.check });
    expect(herd.stopped).toEqual(["BUTCHR"]);
    // BUTCHR is gone from `running` now, so a second poll's restingRunning
    // (atRest ∩ running) is empty regardless — asserting the stop list
    // doesn't grow is still the right observable: nothing double-fires.
    await reconcileNow(herd, new Map(), { atRest: ["BUTCHR"], checkDeclaredDone: reg.check });
    expect(herd.stopped).toEqual(["BUTCHR"]);
  });

  test("checkFrozenAsleep and checkDeclaredDone compose: one id past its freeze bound, a DIFFERENT id freshly asleep-and-declared, both released the same poll — the freshly-declared one is never old enough to trip the frozen bound itself, so only the genuinely frozen id gets a complaint", async () => {
    let now = 0;
    const posted: string[] = [];
    const det = createFrozenAsleepDetector({
      now: () => now,
      minutes: 10,
      addComment: async (id) => { posted.push(id); },
      comments: async () => [],
    });
    const reg = createCheckInExitRegistry();
    const herd = fakeHerd(["FROZEN", "DECLARED"]);

    // First poll: FROZEN is already resting — seeds its floor. DECLARED is
    // still genuinely ACTIVE this poll (`desired`), so it is neither in
    // `atRest` nor eligible to be stopped — deliberately excluded from
    // `atRest` here, so `restingRunning` (atRest ∩ running) never puts it in
    // front of the frozen detector before it is actually asleep, exactly as
    // `atRestFrom` would compute it live.
    const declaredSpec = { key: "DECLARED", issuetype: "project", summary: "s", parent: null };
    now = 0;
    await reconcileNow(herd, new Map([["DECLARED", declaredSpec]]), { atRest: ["FROZEN"], checkFrozenAsleep: det.check, checkDeclaredDone: reg.check });
    expect(herd.stopped).toEqual([]); // FROZEN's floor just started; DECLARED is desired, untouched

    // Second poll: DECLARED has JUST gone asleep (no longer desired, its
    // first-ever appearance in `atRest`) and, in the same breath, its
    // agent's own check_in already declared it done — the exact "watermark
    // write, then declare" ordering this ticket makes structural. FROZEN,
    // unrelated, is now past its bound.
    reg.declare("DECLARED");
    now = 10 * 60_000;
    await reconcileNow(herd, new Map(), { atRest: ["FROZEN", "DECLARED"], checkFrozenAsleep: det.check, checkDeclaredDone: reg.check });

    expect(posted).toEqual(["FROZEN"]); // only the genuinely frozen one got a complaint — DECLARED never sat resting long enough to trip it
    expect(new Set(herd.stopped)).toEqual(new Set(["FROZEN", "DECLARED"])); // both released, same poll, via two different mechanisms
  });

  test("ORDERING: the declared id never reaches checkFrozenAsleep's own candidate set at all — asserted on what the detector was HANDED, not on the absence of a complaint (an absent-complaint assertion cannot distinguish 'never offered' from 'offered, correctly declined')", async () => {
    let now = 0;
    const posted: string[] = [];
    const det = createFrozenAsleepDetector({
      now: () => now,
      minutes: 10,
      addComment: async (id) => { posted.push(id); },
      comments: async () => [],
    });
    // Spy wrapper: records every candidate set checkFrozenAsleep is actually
    // called with, so the assertion below is on the detector's real INPUT —
    // a positive observation — rather than inferred from its output.
    const seenCandidates: string[][] = [];
    const spiedFrozenCheck = async (restingRunning: readonly string[]) => {
      seenCandidates.push([...restingRunning]);
      return det.check(restingRunning);
    };
    const reg = createCheckInExitRegistry();
    const herd = fakeHerd(["BUTCHR"]);

    // First poll: BUTCHR goes resting — seeds the frozen detector's floor.
    // Not yet declared, so it stays running past this poll.
    now = 0;
    await reconcileNow(herd, new Map(), { atRest: ["BUTCHR"], checkFrozenAsleep: spiedFrozenCheck, checkDeclaredDone: reg.check });
    expect(herd.stopped).toEqual([]);
    expect(seenCandidates).toEqual([["BUTCHR"]]); // legitimately offered this poll — not yet declared

    // Second poll: enough time has passed that BUTCHR is ALSO past the
    // frozen bound — but its own check_in landed and declared it done
    // before this same poll runs. A candidate set computed from the SAME
    // restingRunning for both hooks would still hand BUTCHR to
    // checkFrozenAsleep; narrowing first must not.
    reg.declare("BUTCHR");
    now = 10 * 60_000;
    await reconcileNow(herd, new Map(), { atRest: ["BUTCHR"], checkFrozenAsleep: spiedFrozenCheck, checkDeclaredDone: reg.check });

    // The load-bearing assertion: checkFrozenAsleep was not even CALLED a
    // second time (restingRunning was empty once BUTCHR was subtracted), so
    // BUTCHR never appears among anything it was handed on this poll. This
    // is the positive claim BUTCHR-271 requires — not "no complaint was
    // posted", which a suppressed-but-still-offered candidate would also
    // satisfy.
    expect(seenCandidates).toEqual([["BUTCHR"]]); // unchanged from poll 1 — no second call, so BUTCHR was never offered again
    expect(posted).toEqual([]); // corroborating, not load-bearing: nothing froze from the agent's own point of view
    expect(herd.stopped).toEqual(["BUTCHR"]); // still released, via the declared-done route
  });

  test("omitting checkDeclaredDone entirely preserves the original behaviour: atRest protects indefinitely, same as omitting checkFrozenAsleep", async () => {
    const herd = fakeHerd(["BUTCHR"]);
    await reconcileNow(herd, new Map(), { atRest: ["BUTCHR"] }); // neither hook
    expect(herd.stopped).toEqual([]);
    expect(herd.running.has("BUTCHR")).toBe(true);
  });
});

// BUTCHR-275 (review round 2): the exact hazard code review found —
// reproduced end to end through reconcileNow, with `invalidateDeclaredDone`
// wired in to close it. See check-in-exit.ts's "PER-EPISODE INVALIDATION"
// for the narrative; this is that narrative as a test.
describe("reconcileNow: invalidateDeclaredDone closes the stale-declaration-across-episodes hazard (BUTCHR-275, review round 2)", () => {
  const spec = (key: string) => ({ key, issuetype: "project" as const, summary: "s", parent: null });

  test("THE ATTACK PATH: declare, then the project goes ACTIVE again before consumption, then it returns to asleep with NO fresh check_in — the stale declaration must NOT stop the new episode's agent", async () => {
    const reg = createCheckInExitRegistry();
    const herd = fakeHerd(["BUTCHR"]);

    // Episode 1's own check_in has just landed and declared — but the very
    // next poll already observes new activity before anything consumes it
    // (a comment, a version bump, an epic entering review): BUTCHR is
    // genuinely ACTIVE this poll, i.e. in `desired`, NOT in `atRest`.
    // Without invalidateDeclaredDone wired, the stale declaration would
    // simply keep waiting here for some later poll to find it resting.
    reg.declare("BUTCHR");
    await reconcileNow(herd, new Map([["BUTCHR", spec("BUTCHR")]]), { atRest: [], checkDeclaredDone: reg.check, invalidateDeclaredDone: reg.invalidateActive });
    expect(herd.stopped).toEqual([]); // desired — never a stop candidate regardless of any hook

    // Next poll: the first episode's agent is gone (crashed / respawned
    // stale / session-limited — irrelevant which) and a fresh agent is now
    // running for BUTCHR. The epic that made it active a moment ago has now
    // left review, so the verdict returns to "asleep" with NO check_in from
    // this new episode at all — exactly the no-watermark-write transition
    // src/resources/project.ts's projectVerdict permits.
    await reconcileNow(herd, new Map(), { atRest: ["BUTCHR"], checkDeclaredDone: reg.check, invalidateDeclaredDone: reg.invalidateActive });

    // The load-bearing assertion: NOT stopped via the declared-done route,
    // because the earlier poll already invalidated the stale declaration.
    // Ordinary atRest protection applies to this new episode exactly as if
    // it had never declared anything — which is correct, since it hasn't.
    expect(herd.stopped).toEqual([]);
    expect(herd.running.has("BUTCHR")).toBe(true);
  });

  test("CONTROL — same shape, but this episode's OWN check_in lands before consumption: it is still stopped promptly, proving invalidateDeclaredDone doesn't over-suppress", async () => {
    const reg = createCheckInExitRegistry();
    const herd = fakeHerd(["BUTCHR"]);

    // Active, then genuinely caught up via a REAL check_in this episode —
    // not a leftover from a previous one.
    await reconcileNow(herd, new Map([["BUTCHR", spec("BUTCHR")]]), { atRest: [], invalidateDeclaredDone: reg.invalidateActive });
    reg.declare("BUTCHR"); // this episode's own check_in
    await reconcileNow(herd, new Map(), { atRest: ["BUTCHR"], checkDeclaredDone: reg.check, invalidateDeclaredDone: reg.invalidateActive });

    expect(herd.stopped).toEqual(["BUTCHR"]); // released promptly — a genuine, current declaration is still honoured
  });

  test("invalidateDeclaredDone runs even when atRest is completely empty this poll — the id it must catch is, by definition, not resting", async () => {
    const reg = createCheckInExitRegistry();
    const herd = fakeHerd(["BUTCHR"]);
    reg.declare("BUTCHR");

    // atRest is empty (nothing anywhere is resting this poll) but BUTCHR is
    // desired (active) — if invalidateDeclaredDone were gated the same way
    // as checkDeclaredDone (behind atRest.size), it would never run here and
    // the stale declaration would survive.
    await reconcileNow(herd, new Map([["BUTCHR", spec("BUTCHR")]]), { atRest: [], checkDeclaredDone: reg.check, invalidateDeclaredDone: reg.invalidateActive });

    const out = await reg.check(["BUTCHR"]); // simulate a later poll observing it resting
    expect(out.size).toBe(0); // already invalidated — not a fresh declaration
  });

  test("omitting invalidateDeclaredDone entirely preserves the pre-fix behaviour: a stale declaration is still consumed by a later poll (this is the hazard — proves the option is genuinely additive, not load-bearing by default)", async () => {
    const reg = createCheckInExitRegistry();
    const herd = fakeHerd(["BUTCHR"]);
    reg.declare("BUTCHR");
    await reconcileNow(herd, new Map([["BUTCHR", spec("BUTCHR")]]), { atRest: [], checkDeclaredDone: reg.check }); // no invalidateDeclaredDone wired
    await reconcileNow(herd, new Map(), { atRest: ["BUTCHR"], checkDeclaredDone: reg.check }); // still no invalidateDeclaredDone
    expect(herd.stopped).toEqual(["BUTCHR"]); // the stale declaration WAS consumed — confirms this option is what closes the gap, not some other change
  });
});
