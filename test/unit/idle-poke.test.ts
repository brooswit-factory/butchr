import { describe, expect, test } from "bun:test";
import { createIdlePokeEngine, renderIdlePokeNudge, idlePokeComment, MARKER } from "../../src/agents/idle-poke.js";

const MIN = 60_000;

function makeDeps(overrides: Partial<Parameters<typeof createIdlePokeEngine>[0]> = {}) {
  const log: string[] = [];
  const addComments: Array<{ issue: string; text: string }> = [];
  const delivered: Array<{ issue: string; text: string }> = [];
  let deliverVia: "channel" | "prompt" = "channel";
  const base = {
    now: () => 0,
    dryRun: true,
    globalMinutes: 10,
    defaultMessage: "default message",
    // Negative by default: with a FROZEN mock clock, the engine's own
    // construction and a test's first `check()` call see the identical
    // instant (diff 0), and the guard-4 window below is an INCLUSIVE `<=`
    // (by design — see idle-poke.ts's own ACCEPTANCE-7 slow-cadence case,
    // which depends on that inclusivity at an exact boundary). 0 would
    // still match `0 <= 0`, so every test not exercising guard 4 would be
    // spuriously suppressed as "just restarted". A negative window can
    // never contain a non-negative diff, which is the only value this
    // ever computes. The "guard 4 and the 90-second trap" tests override
    // this explicitly.
    suppressMinutes: -1,
    maxPokesPerPoll: 10,
    comments: async () => [] as readonly { id: string; body: string; created: string }[],
    addComment: async (issue: string, text: string) => { addComments.push({ issue, text }); },
    deliver: async (issue: string, text: string) => { delivered.push({ issue, text }); return { via: deliverVia }; },
    log: (line: string) => { log.push(line); },
    ...overrides,
  };
  return { deps: base, log, addComments, delivered, setDeliverVia: (v: "channel" | "prompt") => { deliverVia = v; } };
}

describe("createIdlePokeEngine: the timer", () => {
  test("under threshold: not a candidate, no poke", async () => {
    const { deps, addComments } = makeDeps({ dryRun: false, now: () => 5 * MIN });
    const engine = createIdlePokeEngine(deps);
    const out = await engine.check("KAN-1", { streakStart: 0, status: "In Progress" });
    expect(out.kind).toBe("not-a-candidate");
    expect(addComments.length).toBe(0);
  });

  test("at/over threshold: pokes", async () => {
    const { deps, addComments, delivered } = makeDeps({ dryRun: false, now: () => 10 * MIN });
    const engine = createIdlePokeEngine(deps);
    const out = await engine.check("KAN-1", { streakStart: 0, status: "In Progress" });
    expect(out.kind).toBe("poked");
    expect(addComments.length).toBe(1);
    expect(delivered.length).toBe(1);
  });
});

describe("createIdlePokeEngine: per-rule override beats the global, in both directions", () => {
  test("a rule with a SHORTER interval pokes before the global would", async () => {
    const { deps } = makeDeps({ dryRun: false, now: () => 5 * MIN, globalMinutes: 10 });
    const engine = createIdlePokeEngine(deps);
    const out = await engine.check("KAN-1", { streakStart: 0, status: "In Progress", ruleConfig: { idlePokeEnabled: true, idlePokeMinutes: 5 } });
    expect(out.kind).toBe("poked");
  });

  test("a rule with a LONGER interval does not poke merely because the global would have", async () => {
    const { deps } = makeDeps({ dryRun: false, now: () => 10 * MIN, globalMinutes: 10 });
    const engine = createIdlePokeEngine(deps);
    const out = await engine.check("KAN-1", { streakStart: 0, status: "In Progress", ruleConfig: { idlePokeEnabled: true, idlePokeMinutes: 30 } });
    expect(out.kind).toBe("not-a-candidate");
  });

  test("an UNSET per-rule interval means the global default, NEVER a hardcoded 30", async () => {
    const { deps } = makeDeps({ dryRun: false, now: () => 15 * MIN, globalMinutes: 10 });
    const engine = createIdlePokeEngine(deps);
    // ruleConfig present (enabled, from some rule) but idlePokeMinutes absent.
    const out = await engine.check("KAN-1", { streakStart: 0, status: "In Progress", ruleConfig: { idlePokeEnabled: true } });
    expect(out.kind).toBe("poked"); // 15m >= global 10m, NOT waiting for 30
  });
});

describe("createIdlePokeEngine: guard 5 — enabled:false pokes nothing", () => {
  test("disabled rule never pokes even far past threshold", async () => {
    const { deps, addComments } = makeDeps({ dryRun: false, now: () => 60 * MIN });
    const engine = createIdlePokeEngine(deps);
    const out = await engine.check("KAN-1", { streakStart: 0, status: "In Progress", ruleConfig: { idlePokeEnabled: false } });
    expect(out.kind).toBe("skipped");
    expect(addComments.length).toBe(0);
  });
});

describe("createIdlePokeEngine: guard 1 — once per idle episode", () => {
  test("two polls inside the SAME episode: one poke", async () => {
    let now = 10 * MIN;
    const { deps, addComments } = makeDeps({ dryRun: false, now: () => now });
    const engine = createIdlePokeEngine(deps);
    const first = await engine.check("KAN-1", { streakStart: 0, status: "In Progress" });
    expect(first.kind).toBe("poked");
    now = 11 * MIN;
    const second = await engine.check("KAN-1", { streakStart: 0, status: "In Progress" });
    expect(second.kind).toBe("suppressed");
    expect(addComments.length).toBe(1);
  });

  test("a NEW episode (different streakStart) pokes again", async () => {
    let now = 10 * MIN;
    const { deps, addComments } = makeDeps({ dryRun: false, now: () => now });
    const engine = createIdlePokeEngine(deps);
    await engine.check("KAN-1", { streakStart: 0, status: "In Progress" });
    // agent took a turn (streak broke), then went idle again, long after
    // the daemon-start/reconnect suppression window that opened at t=0.
    now = 40 * MIN;
    const out = await engine.check("KAN-1", { streakStart: 30 * MIN, status: "In Progress" });
    expect(out.kind).toBe("poked");
    expect(addComments.length).toBe(2);
  });
});

describe("createIdlePokeEngine: guard 3 — In Review waiting on a human", () => {
  test("In Review is skipped even past threshold", async () => {
    const { deps, addComments } = makeDeps({ dryRun: false, now: () => 20 * MIN });
    const engine = createIdlePokeEngine(deps);
    const out = await engine.check("KAN-1", { streakStart: 0, status: "In Review" });
    expect(out.kind).toBe("skipped");
    expect(addComments.length).toBe(0);
  });
});

describe("createIdlePokeEngine: guard 6 — the own-identity negative gate (FACTORY-836's own fixture, generalised)", () => {
  // Measured fixture: a boss posted a complete status comment, then the
  // live stall detector poked it 11 minutes later purely because it had
  // been idle since that very comment. The negative gate below is built
  // to suppress exactly that shape.
  test("an own-identity comment postdating the episode start suppresses the poke", async () => {
    const { deps, addComments } = makeDeps({
      dryRun: false,
      now: () => 11 * MIN,
      comments: async () => [{ id: "c1", body: "[KAN-1] status: done, links, left, next owner", created: new Date(0).toISOString() }],
    });
    const engine = createIdlePokeEngine(deps);
    const out = await engine.check("KAN-1", { streakStart: 0, status: "In Progress" });
    expect(out.kind).toBe("skipped");
    expect((out as { reason: string }).reason).toContain("own-identity");
    expect(addComments.length).toBe(0);
  });

  test("an own-identity comment BEFORE the episode start does not suppress", async () => {
    const { deps, addComments } = makeDeps({
      dryRun: false,
      now: () => 10 * MIN,
      comments: async () => [{ id: "c1", body: "[KAN-1] an old report", created: new Date(-5 * MIN).toISOString() }],
    });
    const engine = createIdlePokeEngine(deps);
    const out = await engine.check("KAN-1", { streakStart: 0, status: "In Progress" });
    expect(out.kind).toBe("poked");
    expect(addComments.length).toBe(1);
  });

  test("a boss's tell_worker / daemon chatter comment does NOT count as own-identity", async () => {
    const { deps } = makeDeps({
      dryRun: false,
      now: () => 10 * MIN,
      comments: async () => [{ id: "c1", body: "[OTHER-9] sideways note", created: new Date(5 * MIN).toISOString() }, { id: "c2", body: "[butchr:stall] daemon chatter", created: new Date(5 * MIN).toISOString() }],
    });
    const engine = createIdlePokeEngine(deps);
    const out = await engine.check("KAN-1", { streakStart: 0, status: "In Progress" });
    expect(out.kind).toBe("poked");
  });

  // [review] CHANGES_REQUESTED on this story's PR: without memoizing the
  // verdict, a parked ticket (already accounted for) costs one
  // `comments()` fetch EVERY poll for as long as it stays idle. Comments
  // only ever accumulate within an episode, so the verdict can never flip
  // back once found.
  test("comments() is fetched once per episode, not once per poll, once accounted-for", async () => {
    let calls = 0;
    let now = 11 * MIN;
    const { deps } = makeDeps({
      dryRun: false,
      now: () => now,
      comments: async () => {
        calls++;
        return [{ id: "c1", body: "[KAN-1] status: done, links, left, next owner", created: new Date(0).toISOString() }];
      },
    });
    const engine = createIdlePokeEngine(deps);
    const first = await engine.check("KAN-1", { streakStart: 0, status: "In Progress" });
    expect(first.kind).toBe("skipped");
    expect(calls).toBe(1);
    now = 12 * MIN;
    const second = await engine.check("KAN-1", { streakStart: 0, status: "In Progress" });
    expect(second.kind).toBe("skipped");
    expect((second as { reason: string }).reason).toContain("cached");
    expect(calls).toBe(1);
  });
});

describe("createIdlePokeEngine: guard 4 and the 90-second trap", () => {
  test("evaluated EVERY poll (fast cadence): an ordinary new episode still pokes, never suppressed as a false restart", async () => {
    let now = 0;
    // globalMinutes small enough that the episode becomes a candidate
    // exactly at the final check (20m - 15m streakStart = 5m elapsed), not
    // sooner — the loop below must reach that moment without itself
    // poking first.
    const { deps } = makeDeps({ dryRun: false, now: () => now, suppressMinutes: 5, globalMinutes: 5 });
    const engine = createIdlePokeEngine(deps);
    // Simulate a continuous ~15s poll cadence the WHOLE way (not yet idle,
    // then idle from t=15m) — no gap ever exceeds suppressMinutes, so
    // guard 4's own discontinuity measurement never resets. Jumping
    // straight from an early "not yet idle" poll to the final check (as a
    // prior version of this test did) would itself look like a second
    // restart and re-arm the suppression it's trying to disprove.
    for (let t = 0; t < 20 * MIN; t += 15_000) {
      now = t;
      await engine.check("KAN-1", { streakStart: t < 15 * MIN ? null : 15 * MIN, status: "In Progress" });
    }
    now = 20 * MIN;
    const out = await engine.check("KAN-1", { streakStart: 15 * MIN, status: "In Progress" });
    expect(out.kind).toBe("poked");
  });

  test("ACCEPTANCE 7 — evaluated on a SLOW cadence: every poll looks like a fresh discontinuity and suppresses every poke", async () => {
    let now = 0;
    const { deps } = makeDeps({ dryRun: false, now: () => now, suppressMinutes: 5 });
    const engine = createIdlePokeEngine(deps);
    // A 30-minute gap between invocations, far slower than the suppression
    // window — this is the exact hazard FACTORY-845's ticket calls "the
    // 90-second trap", generalised to this module's own 5-minute window.
    now = 0;
    await engine.check("KAN-1", { streakStart: null, status: "In Progress" });
    now = 30 * MIN;
    await engine.check("KAN-1", { streakStart: 0, status: "In Progress" }); // this call itself re-measures the gap and marks a fresh discontinuity
    now = 60 * MIN;
    const out = await engine.check("KAN-1", { streakStart: 0, status: "In Progress" });
    expect(out.kind).toBe("suppressed");
    expect((out as { reason: string }).reason).toContain("daemon start/herdr-reconnect");
  });

  test("a genuine restart suppresses a poke within the window, and a later poll past the window still pokes", async () => {
    let now = 0;
    // globalMinutes small enough that the episode is already a candidate
    // by the "early" check — it's guard 4, not the timer, being exercised.
    const { deps } = makeDeps({ dryRun: false, now: () => now, suppressMinutes: 5, globalMinutes: 1 });
    const engine = createIdlePokeEngine(deps);
    now = 0;
    await engine.check("KAN-1", { streakStart: null, status: "In Progress" }); // daemon start
    now = 2 * MIN;
    const early = await engine.check("KAN-1", { streakStart: 0, status: "In Progress" }); // within suppressMinutes of start
    expect(early.kind).toBe("suppressed");
    // Keep polling at a realistic ~15s cadence right up to the window's
    // edge — guard 4 only reads a gap between CONSECUTIVE invocations
    // correctly when check() is called every poll (see this module's own
    // doc comment); jumping straight from here to past the window would
    // itself look like a second restart and re-arm the suppression.
    for (let t = 2 * MIN + 15_000; t <= 5 * MIN; t += 15_000) {
      now = t;
      await engine.check("KAN-1", { streakStart: 0, status: "In Progress" });
    }
    now = 5 * MIN + 15_000; // just past the window
    const later = await engine.check("KAN-1", { streakStart: 0, status: "In Progress" }); // past the window now
    expect(later.kind).toBe("poked");
  });
});

describe("createIdlePokeEngine: the first-enable burst — a fleet-wide per-poll cap", () => {
  test("ACCEPTANCE 6 — a cold start with many idle agents past threshold does NOT poke all of them in one poll", async () => {
    const { deps, addComments } = makeDeps({ dryRun: false, now: () => 60 * MIN, maxPokesPerPoll: 3 });
    const engine = createIdlePokeEngine(deps);
    engine.beginPoll();
    const outcomes = [];
    for (const key of ["A-1", "A-2", "A-3", "A-4", "A-5"]) {
      outcomes.push(await engine.check(key, { streakStart: 0, status: "In Progress" }));
    }
    const poked = outcomes.filter((o) => o.kind === "poked");
    expect(poked.length).toBe(3);
    expect(addComments.length).toBe(3);
    const capped = outcomes.filter((o) => o.kind === "suppressed");
    expect(capped.length).toBe(2);
  });

  test("beginPoll resets the cap for the NEXT poll", async () => {
    let now = 60 * MIN;
    const { deps } = makeDeps({ dryRun: false, now: () => now, maxPokesPerPoll: 1 });
    const engine = createIdlePokeEngine(deps);
    engine.beginPoll();
    const first = await engine.check("A-1", { streakStart: 0, status: "In Progress" });
    expect(first.kind).toBe("poked");
    const second = await engine.check("A-2", { streakStart: 10 * MIN, status: "In Progress" });
    expect(second.kind).toBe("suppressed");
    now = 90 * MIN;
    engine.beginPoll();
    const third = await engine.check("A-2", { streakStart: 10 * MIN, status: "In Progress" });
    expect(third.kind).toBe("poked");
  });
});

describe("createIdlePokeEngine: dry-run", () => {
  test("ACCEPTANCE 4 — sends nothing (no comment, no deliver) but logs a decision on every outcome, and does not disable the suppressed/skipped logging either", async () => {
    const { deps, addComments, delivered, log } = makeDeps({ dryRun: true, now: () => 10 * MIN });
    const engine = createIdlePokeEngine(deps);
    const out = await engine.check("KAN-1", { streakStart: 0, status: "In Progress" });
    expect(out.kind).toBe("suppressed");
    expect((out as { reason: string }).reason).toBe("dry-run");
    expect(addComments.length).toBe(0);
    expect(delivered.length).toBe(0);
    expect(log.some((l) => l.includes("[idle-poke] would poke KAN-1"))).toBe(true);
  });

  test("dry-run still reports guard outcomes (In Review) distinctly from a would-poke decision", async () => {
    const { deps, log } = makeDeps({ dryRun: true, now: () => 10 * MIN });
    const engine = createIdlePokeEngine(deps);
    const out = await engine.check("KAN-1", { streakStart: 0, status: "In Review" });
    expect(out.kind).toBe("skipped");
    expect(log.some((l) => l.includes("would poke"))).toBe(false);
  });

  // [review] CHANGES_REQUESTED on this story's PR: dry-run never latches,
  // so a candidate re-logs "would poke" every poll for as long as it
  // stays idle in dry-run mode (the default). The decision is per
  // EPISODE, not per poll.
  test("'would poke' is logged once per episode, not once per poll", async () => {
    let now = 10 * MIN;
    const { deps, log } = makeDeps({ dryRun: true, now: () => now });
    const engine = createIdlePokeEngine(deps);
    const first = await engine.check("KAN-1", { streakStart: 0, status: "In Progress" });
    expect(first.kind).toBe("suppressed");
    now = 11 * MIN;
    const second = await engine.check("KAN-1", { streakStart: 0, status: "In Progress" });
    expect(second.kind).toBe("suppressed");
    expect(log.filter((l) => l.includes("[idle-poke] would poke KAN-1")).length).toBe(1);
  });
});

describe("createIdlePokeEngine: acceptance 9 — never drops a poke on an unavailable/unknown channel result", () => {
  test("a prompt-fallback delivery result is still reported as poked, via prompt", async () => {
    const { deps, setDeliverVia } = makeDeps({ dryRun: false, now: () => 10 * MIN });
    setDeliverVia("prompt");
    const engine = createIdlePokeEngine(deps);
    const out = await engine.check("KAN-1", { streakStart: 0, status: "In Progress" });
    expect(out.kind).toBe("poked");
    expect((out as { via: string }).via).toBe("prompt");
  });

  test("a throwing deliver() still results in a poked outcome (comment still posted) rather than a silently dropped poke", async () => {
    const { deps, addComments } = makeDeps({
      dryRun: false,
      now: () => 10 * MIN,
      deliver: async () => { throw new Error("mcp handle unavailable"); },
    });
    const engine = createIdlePokeEngine(deps);
    const out = await engine.check("KAN-1", { streakStart: 0, status: "In Progress" });
    expect(out.kind).toBe("poked");
    expect((out as { via: string }).via).toBe("prompt");
    expect(addComments.length).toBe(1);
  });
});

describe("createIdlePokeEngine: guard 2 is satisfied by construction (streakStart is null while blocked)", () => {
  test("a null streakStart (e.g. the caller's own stalled-tracker streak reset by a blocked/permission-dialog observation) is never a candidate", async () => {
    const { deps, addComments } = makeDeps({ dryRun: false, now: () => 60 * MIN });
    const engine = createIdlePokeEngine(deps);
    const out = await engine.check("KAN-1", { streakStart: null, status: "In Progress" });
    expect(out.kind).toBe("not-a-candidate");
    expect(addComments.length).toBe(0);
  });
});

describe("renderIdlePokeNudge / idlePokeComment: the named render functions acceptance 5 requires", () => {
  test("renderIdlePokeNudge returns the configured text verbatim (asserted RENDERED string)", () => {
    expect(renderIdlePokeNudge("You've been idle 30 min: post your ticket comment, then continue or stand down")).toBe(
      "You've been idle 30 min: post your ticket comment, then continue or stand down",
    );
  });

  test("idlePokeComment starts with the daemon-chatter MARKER and carries a delimited fingerprint", () => {
    const body = idlePokeComment("KAN-1", "some text", 12);
    expect(body.startsWith(MARKER)).toBe(true);
    expect(body).toContain("fingerprint: KAN-1\n");
    expect(body).toContain("some text");
    expect(body).toContain("12 minute(s)");
  });
});
