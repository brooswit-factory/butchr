import { describe, expect, test } from "bun:test";
import { admitWithinBudget, admissionLine, admissionFailSafeLine, ADMISSION2_TAG, createAdmissionController, DEFAULT_ADMISSION_SOURCE, ImplausibleZeroGuard, LEDGER_UNSEEN_EVICTION_CALLS, MAX_IMPLAUSIBLE_POLLS, orderByWait } from "../../src/agents/admission.js";
import { reconcileNow } from "../../src/daemon/loop.js";
import type { Herd } from "../../src/agents/herd.js";

function fakeHerd(initial: string[] = []): Herd & { spawned: string[]; stopped: string[]; running: Set<string> } {
  const running = new Set(initial);
  const spawned: string[] = [], stopped: string[] = [];
  return {
    running, spawned, stopped,
    async runningIssues() { return [...running]; },
    async staleIssues() { return []; },
    async spawn(sp) { spawned.push(sp.key); running.add(sp.key); },
    async stop(i) { stopped.push(i); running.delete(i); },
    async paneFor(i) { return running.has(i) ? `pane-${i}` : null; },
    async nudge() { return { delivered: true }; },
  };
}
const spec = (k: string) => ({ key: k, issuetype: "Task", summary: "s", parent: null });

describe("admitWithinBudget (pure)", () => {
  test("below the cap: every candidate admitted, nothing withheld", () => {
    expect(admitWithinBudget(["A", "B"], 5)).toEqual({ admitted: ["A", "B"], withheld: [] });
  });
  test("exactly at the cap: every candidate admitted", () => {
    expect(admitWithinBudget(["A", "B"], 2)).toEqual({ admitted: ["A", "B"], withheld: [] });
  });
  test("above the cap: admits from the front (existing deterministic sort order), withholds the rest", () => {
    expect(admitWithinBudget(["A", "B", "C"], 1)).toEqual({ admitted: ["A"], withheld: ["B", "C"] });
  });
  test("zero budget: nothing admitted", () => {
    expect(admitWithinBudget(["A", "B"], 0)).toEqual({ admitted: [], withheld: ["A", "B"] });
  });
  test("a negative budget is clamped to zero, never sliced negative from the end", () => {
    expect(admitWithinBudget(["A", "B"], -3)).toEqual({ admitted: [], withheld: ["A", "B"] });
  });
});

describe("orderByWait (pure, BUTCHR-297)", () => {
  test("equal waits (an empty ledger) reproduce today's exact lexicographic order byte-for-byte", () => {
    expect(orderByWait(["C", "A", "B"], new Map())).toEqual(["A", "B", "C"]);
  });
  test("a higher wait beats a lexicographically-earlier key", () => {
    const waits = new Map([["Z", 3]]);
    expect(orderByWait(["A", "Z"], waits)).toEqual(["Z", "A"]);
  });
  test("ties among equal NONZERO waits break lexicographically, same rule as the zero case", () => {
    const waits = new Map([["B", 2], ["A", 2], ["C", 2]]);
    expect(orderByWait(["C", "A", "B"], waits)).toEqual(["A", "B", "C"]);
  });
  test("a candidate absent from the wait map is treated as wait 0, same as one never withheld", () => {
    const waits = new Map([["A", 1]]);
    expect(orderByWait(["A", "B"], waits)).toEqual(["A", "B"]);
  });
  test("does not mutate its input array", () => {
    const input = ["B", "A"];
    orderByWait(input, new Map());
    expect(input).toEqual(["B", "A"]);
  });
});

describe("ImplausibleZeroGuard", () => {
  test("stays untrusted (true) for maxPolls consecutive records, then flips to accept (false) and resets", () => {
    const g = new ImplausibleZeroGuard(3);
    expect(g.record()).toBe(true);
    expect(g.record()).toBe(true);
    expect(g.record()).toBe(true);
    expect(g.record()).toBe(false); // 4th record exceeds the bound of 3
    // resets after exceeding — a fresh episode gets its own full window
    expect(g.record()).toBe(true);
  });
  test("clear() resets an in-progress streak so a later episode starts fresh", () => {
    const g = new ImplausibleZeroGuard(2);
    expect(g.record()).toBe(true);
    g.clear();
    expect(g.record()).toBe(true);
    expect(g.record()).toBe(true);
    expect(g.record()).toBe(false);
  });
  test("defaults to MAX_IMPLAUSIBLE_POLLS when no bound is given", () => {
    const g = new ImplausibleZeroGuard();
    for (let i = 0; i < MAX_IMPLAUSIBLE_POLLS; i++) expect(g.record()).toBe(true);
    expect(g.record()).toBe(false);
  });
});

describe("createAdmissionController", () => {
  test("budget below the cap admits everything", async () => {
    const ctrl = createAdmissionController({ cap: 5, residency: async () => ["R1", "R2"] });
    expect(await ctrl.admit(["A", "B"], [])).toEqual(["A", "B"]);
    expect(ctrl.snapshot()).toEqual({ cap: 5, residency: 2, longestWait: null });
  });

  test("budget exactly consumed by residency admits nothing new", async () => {
    const ctrl = createAdmissionController({ cap: 2, residency: async () => ["R1", "R2"] });
    expect(await ctrl.admit(["A", "B"], [])).toEqual([]);
  });

  test("over the cap: withholds the excess, admits the front of the deterministic order, and logs a ratio naming the cap/residency/admitted/withheld ids (BUTCHR-320 B/D: now under ADMISSION2_TAG, unconditionally)", async () => {
    const lines: string[] = [];
    const ctrl = createAdmissionController({ cap: 2, residency: async () => ["R1"], log: (l) => lines.push(l) });
    expect(await ctrl.admit(["A", "B", "C"], [])).toEqual(["A"]);
    const line = lines.find((l) => l.startsWith(ADMISSION2_TAG));
    expect(line).toBeDefined();
    expect(line).toContain("cap=2");
    expect(line).toContain("residency=1");
    expect(line).toContain("admitted=1");
    expect(line).toContain("withheld 2/3");
    // BUTCHR-297 §E, carried into the new line: the withheld id list still
    // carries each one's current wait count (`id(count)`).
    expect(line).toContain("B(1), C(1)");
    // Never under the OLD tag — this replaces it outright (not backward compat).
    expect(lines.some((l) => l.startsWith("[admission] "))).toBe(false);
  });

  // BUTCHR-320 (B): the whole point of the change — a poll that admits
  // everything (withheld = 0) used to log NOTHING under the old `[admission]`
  // line (guarded on `withheld.length > 0`, confirmed at BUTCHR-297's own
  // commit); any admissions total summed from it was therefore a floor, not
  // a count. It now fires every time there's at least one candidate.
  test("BUTCHR-320 (B): withheld=0 still logs — carries the admitted count, no trailing wanted: clause", async () => {
    const lines: string[] = [];
    const ctrl = createAdmissionController({ cap: 5, residency: async () => ["R1"], log: (l) => lines.push(l) });
    expect(await ctrl.admit(["A", "B"], [])).toEqual(["A", "B"]);
    const line = lines.find((l) => l.startsWith(ADMISSION2_TAG));
    expect(line).toBeDefined();
    expect(line).toBe(`${ADMISSION2_TAG} cap=5 residency=1 admitted=2 withheld 0/2`);
  });

  test("empty candidates: still nothing to admit, no admission line at all — the zero-candidate short-circuit's side effect (BUTCHR-297's finding 2) is preserved even after (B)", async () => {
    const lines: string[] = [];
    const ctrl = createAdmissionController({ cap: 1, residency: async () => ["R1", "R2"], log: (l) => lines.push(l) });
    expect(await ctrl.admit([], [])).toEqual([]);
    expect(lines.some((l) => l.startsWith(ADMISSION2_TAG))).toBe(false);
    expect(lines.some((l) => l.startsWith("[admission]"))).toBe(false);
  });

  // BUTCHR-320 (D) — mechanical, six-direction discontinuity: a reader of
  // mixed journal history must be able to tell which instrument produced any
  // given admission line WITHOUT knowing the deploy date. Verbatim samples of
  // both prior formats, re-derived from the ticket's own text (format 1: the
  // build in production as of this writing, 0fa49429; format 2: this file's
  // own emit at BUTCHR-297's commit, before this ticket) against the new
  // line this file now actually emits.
  describe("BUTCHR-320 (D): the new admission line is mechanically distinguishable from BOTH prior [admission] formats", () => {
    const FORMAT1_SAMPLE = "[admission] cap=13 residency=13 withheld 2/2 wanted: BUTCHR-307, BUTCHR-308";
    const FORMAT2_SAMPLE = "[admission] cap=13 residency=13 withheld 2/2 wanted: BUTCHR-307(4), BUTCHR-308(2)";
    const FORMAT1_PATTERN = /^\[admission\] cap=\d+ residency=\d+ withheld \d+\/\d+ wanted: [A-Z]+-\d+(?:, [A-Z]+-\d+)*$/;
    const FORMAT2_PATTERN = /^\[admission\] cap=\d+ residency=\d+ withheld \d+\/\d+ wanted: [A-Z]+-\d+\(\d+\)(?:, [A-Z]+-\d+\(\d+\))*$/;
    const FORMAT3_PATTERN = /^\[admission2\] cap=\d+ residency=\d+ admitted=\d+ withheld \d+\/\d+(?: wanted: .+)?$/;
    const FORMAT3_SAMPLE = admissionLine(13, 13, 0, 2, ["BUTCHR-307", "BUTCHR-308"], new Map([["BUTCHR-307", 4], ["BUTCHR-308", 2]]));
    // BUTCHR-334 (finding 1): the fail-safe sub-format — same tag, no
    // `residency=` field, a `fail-safe=` marker instead. Must be
    // mechanically distinguishable from all three formats above too.
    const FORMAT4_PATTERN = /^\[admission2\] cap=\d+ admitted=0 withheld \d+\/\d+ fail-safe=[a-z-]+ wanted: .+$/;
    const FORMAT4_SAMPLE = admissionFailSafeLine(13, "census-threw", ["BUTCHR-307", "BUTCHR-308"]);

    test("sanity: each sample matches its OWN pattern", () => {
      expect(FORMAT1_SAMPLE).toMatch(FORMAT1_PATTERN);
      expect(FORMAT2_SAMPLE).toMatch(FORMAT2_PATTERN);
      expect(FORMAT3_SAMPLE).toMatch(FORMAT3_PATTERN);
      expect(FORMAT4_SAMPLE).toMatch(FORMAT4_PATTERN);
    });

    // 4 formats × 2 directions each = twelve ordered pairs; every one must miss.
    const samples = { 1: FORMAT1_SAMPLE, 2: FORMAT2_SAMPLE, 3: FORMAT3_SAMPLE, 4: FORMAT4_SAMPLE };
    const patterns = { 1: FORMAT1_PATTERN, 2: FORMAT2_PATTERN, 3: FORMAT3_PATTERN, 4: FORMAT4_PATTERN };
    for (const from of [1, 2, 3, 4] as const) {
      for (const to of [1, 2, 3, 4] as const) {
        if (from === to) continue;
        test(`format ${from}'s sample does NOT match format ${to}'s pattern`, () => {
          expect(samples[from]).not.toMatch(patterns[to]);
        });
      }
    }

    test("the controller's ACTUAL live emit (not a hand-built sample) also clears both old patterns", async () => {
      const lines: string[] = [];
      const ctrl = createAdmissionController({ cap: 2, residency: async () => ["R1"], log: (l) => lines.push(l) });
      await ctrl.admit(["A", "B", "C"], []);
      const line = lines.find((l) => l.startsWith(ADMISSION2_TAG))!;
      expect(line).not.toMatch(FORMAT1_PATTERN);
      expect(line).not.toMatch(FORMAT2_PATTERN);
      expect(line).toMatch(FORMAT3_PATTERN);
    });
  });

  describe("Trap 2 — untrusted census", () => {
    // BUTCHR-334 finding 1 — the required test: drive a census rejection
    // WITH at least one candidate and assert what the journal shows. Before
    // this ticket, this path withheld everything but returned before
    // `admissionLine` was ever reached, so it produced NO [admission2] line
    // at all — "no line means zero candidates" was false right here. Both
    // the WARNING (already pinned above) and a same-tag [admission2] line
    // are now required.
    test("(1) residency() throws: withholds every candidate, fail-safe, and logs — never touches the trusted snapshot — AND now also logs an [admission2] line naming the fail-safe (BUTCHR-334 finding 1)", async () => {
      const lines: string[] = [];
      const ctrl = createAdmissionController({ cap: 5, residency: async () => { throw new Error("herdr down"); }, log: (l) => lines.push(l) });
      expect(await ctrl.admit(["A", "B"], [])).toEqual([]);
      expect(ctrl.snapshot()).toEqual({ cap: 5, residency: null, longestWait: null }); // still no trusted observation
      expect(lines.some((l) => l.includes("WARNING") && l.includes("threw"))).toBe(true);
      const admLine = lines.find((l) => l.startsWith(ADMISSION2_TAG));
      expect(admLine).toBe(admissionFailSafeLine(5, "census-threw", ["A", "B"]));
      expect(admLine).toBe(`${ADMISSION2_TAG} cap=5 admitted=0 withheld 2/2 fail-safe=census-threw wanted: A, B`);
    });

    test("a throw with zero candidates logs nothing (nothing was withheld) — no WARNING and no [admission2] line either, symmetric with the ordinary empty-candidates short-circuit", async () => {
      const lines: string[] = [];
      const ctrl = createAdmissionController({ cap: 5, residency: async () => { throw new Error("boom"); }, log: (l) => lines.push(l) });
      expect(await ctrl.admit([], [])).toEqual([]);
      expect(lines.length).toBe(0);
    });

    test("cold start: no prior trusted observation, residency reads 0 — trusted immediately, NOT withheld (this is the legitimate boot case, not the BUTCHR-282 shape)", async () => {
      const ctrl = createAdmissionController({ cap: 3, residency: async () => [] });
      expect(await ctrl.admit(["A", "B"], [])).toEqual(["A", "B"]);
      expect(ctrl.snapshot()).toEqual({ cap: 3, residency: 0, longestWait: null });
    });

    // BUTCHR-334 finding 1 — the required test's second half: same drill for
    // the implausible-zero path.
    test("(2) readable-but-implausible zero: previously trusted at R>0, this poll's own plan stops fewer than R, census now reads 0 — withheld, trusted snapshot unchanged — AND now also logs an [admission2] line naming the fail-safe (BUTCHR-334 finding 1)", async () => {
      let reads = ["A1", "A2", "A3"]; // first call establishes trust at 3
      const lines: string[] = [];
      const ctrl = createAdmissionController({ cap: 5, residency: async () => reads, log: (l) => lines.push(l) });
      expect(await ctrl.admit([], [])).toEqual([]); // establishes lastTrusted = 3
      expect(ctrl.snapshot().residency).toBe(3);

      reads = []; // next census implausibly reports empty
      expect(await ctrl.admit(["NEW"], [])).toEqual([]); // withheld — stopping.length (0) < lastTrusted (3)
      expect(ctrl.snapshot().residency).toBe(3); // unchanged — the implausible read was never trusted
      expect(lines.some((l) => l.includes("untrustworthy read"))).toBe(true);
      const admLine = lines.find((l) => l.startsWith(ADMISSION2_TAG));
      expect(admLine).toBe(admissionFailSafeLine(5, "implausible-zero", ["NEW"]));
      expect(admLine).toBe(`${ADMISSION2_TAG} cap=5 admitted=0 withheld 1/1 fail-safe=implausible-zero wanted: NEW`);
    });

    test("a legitimate full drain is trusted directly: this poll's own plan.stop covers every previously-trusted resident, so the drop to 0 is explained, not implausible", async () => {
      let reads = ["A1", "A2"];
      const ctrl = createAdmissionController({ cap: 5, residency: async () => reads });
      await ctrl.admit([], []); // lastTrusted = 2
      reads = [];
      // stopping names 2 ids — at least as many as were trusted running
      expect(await ctrl.admit(["NEW"], ["A1", "A2"])).toEqual(["NEW"]);
      expect(ctrl.snapshot().residency).toBe(0);
    });

    test("(d) the bound is exceeded after MAX_IMPLAUSIBLE_POLLS consecutive implausible reads: the zero is then accepted and a full-cap burst is admitted", async () => {
      let reads = ["A1", "A2", "A3"];
      const lines: string[] = [];
      const ctrl = createAdmissionController({ cap: 5, residency: async () => reads, maxImplausiblePolls: 2, log: (l) => lines.push(l) });
      await ctrl.admit([], []); // lastTrusted = 3
      reads = [];
      expect(await ctrl.admit(["X"], [])).toEqual([]); // implausible streak 1/2 — withheld
      expect(await ctrl.admit(["X"], [])).toEqual([]); // implausible streak 2/2 — withheld
      // third consecutive implausible read exceeds the bound of 2 — accepted
      expect(await ctrl.admit(["A", "B", "C"], [])).toEqual(["A", "B", "C"]);
      expect(ctrl.snapshot()).toEqual({ cap: 5, residency: 0, longestWait: null });
      expect(lines.some((l) => l.includes("bound exceeded"))).toBe(true);
      // BUTCHR-334: this path is NOT one of the two fail-safe early returns —
      // it falls through to the ORDINARY admission line (with a real,
      // trusted `residency=0`), never `admissionFailSafeLine`'s shape. Pins
      // the three-way distinction: fail-safe lines only ever come from the
      // two paths that `return []` before this point.
      const admLines = lines.filter((l) => l.startsWith(ADMISSION2_TAG));
      const admLine = admLines[admLines.length - 1]!; // the FINAL admit() call — the one that actually accepted the zero
      expect(admLine).toContain("residency=0");
      expect(admLine).not.toContain("fail-safe=");
    });

    test("an implausible episode that resolves (a later plausible read) clears the streak — a LATER, unrelated implausible episode gets its own full window", async () => {
      let reads = ["A1", "A2", "A3"];
      const ctrl = createAdmissionController({ cap: 5, residency: async () => reads, maxImplausiblePolls: 2 });
      await ctrl.admit([], []); // lastTrusted = 3
      reads = [];
      await ctrl.admit([], []); // implausible 1/2
      reads = ["B1"]; // a plausible read arrives (not zero) — trusted, streak clears
      await ctrl.admit([], []);
      expect(ctrl.snapshot().residency).toBe(1);
      reads = [];
      // a fresh implausible episode: should take the FULL bound again, not continue the old streak
      await ctrl.admit([], []); // 1/2
      expect(ctrl.snapshot().residency).toBe(1); // still not accepted
      await ctrl.admit([], []); // 2/2
      expect(ctrl.snapshot().residency).toBe(1); // still not accepted — bound not yet exceeded
    });
  });
});

describe("whole-project starvation (BUTCHR-297 regression — fails on today's bare lexicographic `.sort()`)", () => {
  test("a later-sorting project's candidate is withheld across many polls behind a saturated cap, then wins the freed slot itself — never the lexicographically-first fresh arrival", async () => {
    let residents = ["BUTCHR-1", "BUTCHR-2"]; // fills the cap for the whole starvation window
    const ctrl = createAdmissionController({ cap: 2, residency: async () => residents });

    // 10 polls: the cap stays fully saturated by two long-resident BUTCHR
    // tickets that never leave — CATA-1 and a second cross-project
    // candidate sit withheld every single poll, exactly like the ticket's
    // own measured tail (ten tickets across six projects, all excluded
    // because every one of them sorts after "BUTCHR").
    for (let i = 0; i < 10; i++) {
      expect(await ctrl.admit(["CATA-1", "DROVR-1"], [])).toEqual([]);
    }
    // Tied waits break lexicographically ("CATA-1" < "DROVR-1"), same rule
    // as the wait-0 case.
    expect(ctrl.snapshot()).toEqual({ cap: 2, residency: 2, longestWait: { id: "CATA-1", polls: 10 } });

    // A slot frees (BUTCHR-1 finishes) at the exact poll a FRESH,
    // lexicographically-first BUTCHR candidate reappears wanting it — the
    // project that dominated the cap the whole time refilling itself,
    // exactly like the ticket's own measured tail. Bare lexicographic order
    // would hand BUTCHR-3 the slot yet again; aging must hand it to
    // CATA-1 instead.
    residents = ["BUTCHR-2"];
    expect(await ctrl.admit(["BUTCHR-3", "CATA-1", "DROVR-1"], [])).toEqual(["CATA-1"]);
  });
});

describe("B1 — one shared ledger, two tiers with disjoint candidate sets", () => {
  test("many calls naming only a DISJOINT candidate never disturb another candidate's own accumulated wait", async () => {
    // cap 0: budget is always 0, so every candidate is withheld on every
    // call — isolates pure ledger bookkeeping from residency/budget noise.
    // `cap` is read live off this object each call, so mutating it below
    // (to observe an ordering outcome) doesn't require a second instance.
    const depsObj = { cap: 0, residency: async () => [] as readonly string[] };
    const ctrl = createAdmissionController(depsObj);
    await ctrl.admit(["ISSUE-1"], []); // ISSUE-1's wait -> 1

    // The project tier's own disjoint candidate set, interleaved ~20 calls
    // for every one of the issue tier's — matching the two tiers' real
    // cadence ratio (15s vs. PROJECT_POLL_INTERVAL_MS's 5min,
    // src/resources/project.ts). None of these 20 calls ever name
    // "ISSUE-1" — a "clear what's absent this call" ledger (the B1 bug)
    // would zero it out roughly this many times per real project poll.
    for (let i = 0; i < 20; i++) await ctrl.admit(["PROJECT-1"], []);

    // If ISSUE-1's wait had been wiped back to 0 by the interleaving, it
    // would now tie with a lexicographically-EARLIER, never-before-seen
    // candidate and LOSE the tie-break. It must win instead, proving its
    // wait of 1 survived 20 unrelated calls untouched.
    depsObj.cap = 1; // open exactly one slot to observe the outcome
    const admitted = await ctrl.admit(["AAA-NEW", "ISSUE-1"], []);
    expect(admitted).toEqual(["ISSUE-1"]);
  });
});

describe("B3 — the two fail-safe paths never touch the wait ledger either", () => {
  test("a residency() throw leaves accumulated waits and the /health longestWait untouched", async () => {
    let broken = false;
    const depsObj = { cap: 1, residency: async (): Promise<readonly string[]> => { if (broken) throw new Error("herdr down"); return []; } };
    const ctrl = createAdmissionController(depsObj);
    // budget is always 1 (cap 1, nothing ever actually "runs" in this
    // synthetic residency source) — every call admits exactly the front of
    // the order.
    expect(await ctrl.admit(["A", "B"], [])).toEqual(["A"]); // tie at wait 0 — lex-first wins, B withheld -> wait 1
    expect(ctrl.snapshot().longestWait).toEqual({ id: "B", polls: 1 });

    broken = true;
    expect(await ctrl.admit(["A", "B"], [])).toEqual([]); // fail-safe: withholds everything
    expect(ctrl.snapshot().longestWait).toEqual({ id: "B", polls: 1 }); // unchanged — not incremented, not cleared

    broken = false;
    // B's wait of 1 (unaffected by the broken call) now beats A's wait of 0.
    expect(await ctrl.admit(["A", "B"], [])).toEqual(["B"]);
  });

  test("an untrusted implausible-zero read leaves accumulated waits and the /health longestWait untouched", async () => {
    let reads = ["R1", "R2"];
    const depsObj = { cap: 2, residency: async () => reads };
    const ctrl = createAdmissionController(depsObj);
    await ctrl.admit([], []); // establishes lastTrusted = 2
    expect(await ctrl.admit(["A", "B", "C"], [])).toEqual([]); // budget 0 — all withheld, tied at wait 1
    expect(ctrl.snapshot().longestWait).toEqual({ id: "A", polls: 1 }); // tie, lex-first

    reads = []; // implausible: drop from trusted 2 to 0, nothing in `stopping` explains it
    expect(await ctrl.admit(["A", "B", "C"], [])).toEqual([]); // withheld fail-safe, ledger untouched
    expect(ctrl.snapshot().longestWait).toEqual({ id: "A", polls: 1 }); // still 1, not 2
  });
});

describe("/health's longestWait must not go stale (review round 1 finding)", () => {
  test("a withheld candidate that leaves `desired` WITHOUT ever being admitted (ticket closed mid-withholding) is no longer reported as waiting once the candidate list goes empty", async () => {
    const ctrl = createAdmissionController({ cap: 1, residency: async () => ["R1"] }); // saturated — nothing is ever actually admitted from an empty residency drop
    await ctrl.admit(["A"], []); // A withheld -> wait 1
    await ctrl.admit(["A"], []); // A withheld again -> wait 2
    expect(ctrl.snapshot().longestWait).toEqual({ id: "A", polls: 2 });

    // A's ticket closes (or leaves the active statuses) before it was ever
    // admitted — it simply stops appearing in ANY candidate list at all.
    await ctrl.admit([], []);
    // An empty candidate list means nothing is withheld, full stop — the
    // wait ledger itself is untouched (A's entry still exists, same as any
    // other unseen-but-not-yet-evicted key — see B2), but `/health` must
    // not go on reporting a candidate nobody is even asking about anymore.
    expect(ctrl.snapshot().longestWait).toBeNull();
  });
});

describe("B2 — the ledger is bounded, but not so tightly it can expire an entry between spawn retries (BUTCHR-297)", () => {
  test("unseen for fewer calls than the bound: the accumulated wait survives intact", async () => {
    const depsObj = { cap: 0, residency: async () => [] as readonly string[] };
    const ctrl = createAdmissionController(depsObj);
    await ctrl.admit(["A"], []); // A's wait -> 1

    // A goes unseen for a while — some OTHER candidate is the only one
    // appearing — but comfortably within the bound.
    for (let i = 0; i < LEDGER_UNSEEN_EVICTION_CALLS - 1; i++) await ctrl.admit(["OTHER"], []);

    depsObj.cap = 1;
    // A's wait of 1 still beats a lexicographically-earlier fresh arrival.
    expect(await ctrl.admit(["1-FRESH", "A"], [])).toEqual(["A"]);
  });

  test("unseen for longer than the bound: the entry is reclaimed — a later reappearance starts fresh, not resuming its old count", async () => {
    const depsObj = { cap: 0, residency: async () => [] as readonly string[] };
    const ctrl = createAdmissionController(depsObj);
    await ctrl.admit(["A"], []); // A's wait -> 1

    // A goes unseen for longer than the bound this time.
    for (let i = 0; i < LEDGER_UNSEEN_EVICTION_CALLS + 1; i++) await ctrl.admit(["OTHER"], []);

    depsObj.cap = 1;
    // A's old wait is gone — a lexicographically-EARLIER fresh arrival now
    // wins the tie at wait 0, proving A did NOT retain its wait of 1
    // (which would have beaten it outright regardless of lex order).
    expect(await ctrl.admit(["1-FRESH", "A"], [])).toEqual(["1-FRESH"]);
  });
});

describe("reconcileNow + admission (BUTCHR-284 integration)", () => {
  test("criterion 3 (liveness): an over-cap candidate is withheld — absent from spawn AND absent from stop — and is spawned on a later poll once residency drops", async () => {
    const herd = fakeHerd([]);
    const desired = new Map([["A", spec("A")], ["B", spec("B")], ["C", spec("C")]]);
    const admission = createAdmissionController({ cap: 2, residency: () => herd.runningIssues() });
    await reconcileNow(herd, desired, { admission: admission.admit });
    expect(herd.spawned.sort()).toEqual(["A", "B"]); // sorted deterministic order, cap=2
    expect(herd.stopped).toEqual([]); // C withheld, never appears in stop
    expect([...herd.running].sort()).toEqual(["A", "B"]);

    // A later poll: nothing has freed up (still 2 running, cap 2) — C stays withheld.
    await reconcileNow(herd, desired, { admission: admission.admit });
    expect(herd.spawned.sort()).toEqual(["A", "B"]);
    expect(herd.stopped).toEqual([]);

    // A slot frees (A finishes and drops out of desired) — C is picked up next poll.
    herd.running.delete("A");
    const desiredAfterA = new Map([["B", spec("B")], ["C", spec("C")]]);
    await reconcileNow(herd, desiredAfterA, { admission: admission.admit });
    expect(herd.spawned.sort()).toEqual(["A", "B", "C"]);
    expect(herd.stopped).toEqual([]);
    expect([...herd.running].sort()).toEqual(["B", "C"]);
  });

  test("criterion 4: a respawn is admitted even while the cap is fully consumed — a stale agent is not left stranded by admission control", async () => {
    const running = new Set(["A", "B"]);
    const spawned: string[] = [], stopped: string[] = [];
    const herd: Herd = {
      async runningIssues() { return [...running]; },
      async staleIssues() { return [{ issue: "A", reason: "stale argv", observedArgv: ["claude"] }]; },
      async spawn(sp) { spawned.push(sp.key); running.add(sp.key); },
      async stop(i) { stopped.push(i); running.delete(i); },
      async paneFor(i) { return running.has(i) ? `pane-${i}` : null; },
      async nudge() { return { delivered: true }; },
    };
    const desired = new Map([["A", spec("A")], ["B", spec("B")]]);
    // cap fully consumed by A+B already — no spawn budget left at all.
    const admission = createAdmissionController({ cap: 2, residency: async () => [...running] });
    await reconcileNow(herd, desired, { admission: admission.admit });
    expect(stopped).toEqual(["A"]);
    expect(spawned).toEqual(["A"]); // respawned, never gated by admission
    expect([...running].sort()).toEqual(["A", "B"]);
  });

  test("checkCrashLoop receives only the ADMITTED spawns (real attempts), never the withheld candidates", async () => {
    const herd = fakeHerd([]);
    const desired = new Map([["A", spec("A")], ["B", spec("B")]]);
    const admission = createAdmissionController({ cap: 1, residency: () => herd.runningIssues() });
    const seen: string[][] = [];
    await reconcileNow(herd, desired, {
      admission: admission.admit,
      checkCrashLoop: async (spawning) => { seen.push([...spawning]); },
    });
    expect(seen).toEqual([["A"]]); // B was withheld — never reaches the crash-loop tracker as an "attempt"
    expect(herd.spawned).toEqual(["A"]);
  });

  test("omitting opts.admission entirely preserves today's exact behaviour — every candidate spawns, unaffected", async () => {
    const herd = fakeHerd([]);
    const desired = new Map([["A", spec("A")], ["B", spec("B")], ["C", spec("C")]]);
    await reconcileNow(herd, desired);
    expect(herd.spawned.sort()).toEqual(["A", "B", "C"]);
  });

  test("a census failure (fail-safe) withholds every candidate this poll but leaves desired/stop untouched — a later healthy poll recovers", async () => {
    const herd = fakeHerd([]);
    const desired = new Map([["A", spec("A")], ["B", spec("B")]]);
    let broken = true;
    const admission = createAdmissionController({ cap: 5, residency: async () => { if (broken) throw new Error("herdr unreachable"); return herd.runningIssues(); } });
    await reconcileNow(herd, desired, { admission: admission.admit });
    expect(herd.spawned).toEqual([]);
    expect(herd.stopped).toEqual([]);

    broken = false;
    await reconcileNow(herd, desired, { admission: admission.admit });
    expect(herd.spawned.sort()).toEqual(["A", "B"]);
  });
});

describe("B4 — wait clears only on a SUCCEEDED spawn, never on admission (BUTCHR-297)", () => {
  test("a candidate's accumulated wait survives a failed spawn, and clears only once a later attempt actually succeeds", async () => {
    const running = new Set<string>();
    const spawned: string[] = [];
    let shouldFail = true;
    const herd: Herd = {
      async runningIssues() { return [...running]; },
      async staleIssues() { return []; },
      async spawn(sp) {
        spawned.push(sp.key);
        if (shouldFail) throw new Error("agent_pane_busy");
        running.add(sp.key);
      },
      async stop(i) { running.delete(i); },
      async paneFor(i) { return running.has(i) ? `pane-${i}` : null; },
      async nudge() { return { delivered: true }; },
    };
    // A residency source fully decoupled from `herd` (a pure occupant-count
    // stand-in, never claimed to be in `desired`/`running`/`stopping`) so
    // this test can move the cap up and down without tripping the
    // ImplausibleZeroGuard's own drop-to-zero check — that guard's own
    // behaviour is covered separately above and is not this test's concern.
    let residents = ["O1", "O2"];
    const admission = createAdmissionController({ cap: 2, residency: async () => residents });
    const desired = new Map([["A", spec("A")]]);
    const opts = { admission: admission.admit, onAdmitted: admission.recordSpawned };

    // 3 polls: the cap is fully consumed by two unrelated occupants — A is
    // withheld every time, accumulating wait.
    for (let i = 0; i < 3; i++) await reconcileNow(herd, desired, opts);
    expect(spawned).toEqual([]);
    expect(admission.snapshot().longestWait).toEqual({ id: "A", polls: 3 });

    // A slot opens — A is admitted, but its spawn FAILS.
    residents = ["O1"];
    await reconcileNow(herd, desired, opts);
    expect(spawned).toEqual(["A"]);
    expect([...running]).toEqual([]); // spawn failed, never actually running

    // §B4's own point, reproduced here rather than only asserted: A's
    // accumulated wait of 3 SURVIVES this failed admission — a naive
    // "clear on admission" design (this ticket's own original A4, corrected
    // before it shipped) would have reset it to 0 right here, exactly as it
    // did on this ticket's own first two spawn attempts. Confirm by
    // withholding A once more and checking it resumes at 3+1, never 0+1.
    residents = ["O1", "O2"];
    await reconcileNow(herd, desired, opts);
    expect(admission.snapshot().longestWait).toEqual({ id: "A", polls: 4 });

    // Now A's spawn actually succeeds.
    shouldFail = false;
    residents = ["O1"];
    await reconcileNow(herd, desired, opts);
    expect([...running]).toEqual(["A"]);
    expect(admission.snapshot().longestWait).toBeNull(); // cleared on success — nothing left waiting
  });
});

describe("the boss/worker inversion (BUTCHR-294's own motivating case)", () => {
  test("idle-but-resident bosses occupy the cap while their own worker is withheld; aging admits the worker ahead of a fresher, lexicographically-earlier arrival once a slot frees", async () => {
    const herd = fakeHerd(["BOSS-1", "BOSS-2"]); // already running, holding the entire cap
    const admission = createAdmissionController({ cap: 2, residency: () => herd.runningIssues() });
    let desired = new Map([["BOSS-1", spec("BOSS-1")], ["BOSS-2", spec("BOSS-2")], ["WORKER-9", spec("WORKER-9")]]);

    // 5 polls: the bosses sit resident and idle, never freeing a slot —
    // WORKER-9 is withheld every single time.
    for (let i = 0; i < 5; i++) await reconcileNow(herd, desired, { admission: admission.admit });
    expect(herd.spawned).toEqual([]); // WORKER-9 never got in
    expect(admission.snapshot().longestWait).toEqual({ id: "WORKER-9", polls: 5 });

    // A slot frees (BOSS-1 finishes) at the exact poll a fresh,
    // lexicographically-EARLIER candidate ("AAA-1") also shows up. Bare
    // lexicographic order would hand AAA-1 the slot; aging must hand the
    // long-withheld worker its overdue turn instead.
    herd.running.delete("BOSS-1");
    desired = new Map([["BOSS-2", spec("BOSS-2")], ["WORKER-9", spec("WORKER-9")], ["AAA-1", spec("AAA-1")]]);
    await reconcileNow(herd, desired, { admission: admission.admit });
    expect(herd.spawned).toEqual(["WORKER-9"]); // the withheld worker eventually starts, not the fresher arrival
  });
});

// BUTCHR-332: the per-source residency census — `census()` — additive
// alongside `snapshot()` (untouched by every test above). Every test below
// drives the real `createAdmissionController`, never hand-assembles an
// `AdmissionCensus`.
describe("createAdmissionController.census() — per-source residency census (BUTCHR-332)", () => {
  test("every declared source has a bucket from CONSTRUCTION, checked:false reason:never-reported, before any admit() call at all (mutation 11: no vacuous 'checked, nothing withheld')", () => {
    const ctrl = createAdmissionController({ cap: 5, residency: async () => [], sources: ["issue", "project"], now: () => 1000 });
    expect(ctrl.census()).toEqual({
      cap: 5,
      residency: null,
      buckets: [
        { source: "issue", checked: false, declinedAt: new Date(1000).toISOString(), reason: "never-reported" },
        { source: "project", checked: false, declinedAt: new Date(1000).toISOString(), reason: "never-reported" },
      ],
    });
  });

  test("a source that has reported does not vouch for a sibling source that never has (mutation 12)", async () => {
    const ctrl = createAdmissionController({ cap: 5, residency: async () => [], sources: ["issue", "project"], now: () => 0 });
    await ctrl.admit(["A"], [], "issue");
    const buckets = ctrl.census().buckets;
    const issue = buckets.find((b) => b.source === "issue")!;
    const project = buckets.find((b) => b.source === "project")!;
    expect(issue.checked).toBe(true);
    expect(project.checked).toBe(false);
    if (project.checked) throw new Error("expected checked:false");
    expect(project.reason).toBe("never-reported");
  });

  test("an undeclared source (no `sources` dep at all) still records its own bucket once admit() is called with it", async () => {
    const ctrl = createAdmissionController({ cap: 5, residency: async () => [] });
    expect(ctrl.census().buckets).toEqual([]); // nothing declared, nothing pre-seeded
    await ctrl.admit(["A"], [], "adhoc");
    expect(ctrl.census().buckets).toEqual([{ source: "adhoc", checked: true, confirmedAt: expect.any(String), withheld: [] }]);
  });

  test("admit() called with no source name at all records under DEFAULT_ADMISSION_SOURCE — every existing 2-arg caller still compiles and still records", async () => {
    const ctrl = createAdmissionController({ cap: 5, residency: async () => [] });
    await ctrl.admit(["A"], []); // 2-arg call, exactly like every pre-BUTCHR-332 caller/test
    expect(ctrl.census().buckets).toEqual([{ source: DEFAULT_ADMISSION_SOURCE, checked: true, confirmedAt: expect.any(String), withheld: [] }]);
  });

  test("C1, structurally: many admit() calls naming only ONE source never touch a DIFFERENT declared source's bucket", async () => {
    const ctrl = createAdmissionController({ cap: 0, residency: async () => [], sources: ["issue", "project"] });
    for (let i = 0; i < 20; i++) await ctrl.admit(["ISSUE-1"], [], "issue"); // 20 calls, "project" never named
    const project = ctrl.census().buckets.find((b) => b.source === "project")!;
    expect(project).toEqual({ source: "project", checked: false, declinedAt: expect.any(String), reason: "never-reported" }); // untouched — still exactly its construction-time bucket
  });

  test("the empty-candidates early return records a TRUSTED bucket with withheld:[] and a real confirmedAt — a real observation, not a decline", async () => {
    const ctrl = createAdmissionController({ cap: 5, residency: async () => ["R1"], sources: ["issue"], now: () => 4242 });
    await ctrl.admit([], [], "issue");
    expect(ctrl.census().buckets).toEqual([{ source: "issue", checked: true, confirmedAt: new Date(4242).toISOString(), withheld: [] }]);
  });

  test("residency() throws records checked:false reason:census-threw for the CALLING source only (mutations 2/3/4)", async () => {
    let now = 0;
    let broken = false;
    const ctrl = createAdmissionController({
      cap: 5,
      residency: async () => { if (broken) throw new Error("herdr down"); return []; },
      sources: ["issue", "project"],
      now: () => now,
    });
    await ctrl.admit(["I1"], [], "issue");
    await ctrl.admit(["P1"], [], "project");
    const trustedProjectBucket = ctrl.census().buckets.find((b) => b.source === "project")!;

    broken = true;
    now = 9000;
    expect(await ctrl.admit(["I1"], [], "issue")).toEqual([]); // fail-safe: withholds everything for this call
    const buckets = ctrl.census().buckets;
    const issue = buckets.find((b) => b.source === "issue")!;
    const project = buckets.find((b) => b.source === "project")!;
    expect(issue).toEqual({ source: "issue", checked: false, declinedAt: new Date(9000).toISOString(), reason: "census-threw" });
    // Mutation 4's own target: the OTHER source's bucket is untouched, byte-identical, not even re-stamped.
    expect(project).toEqual(trustedProjectBucket);
  });

  test("an untrusted implausible-zero read records checked:false reason:census-untrusted for the calling source only, without touching a sibling source", async () => {
    let now = 0;
    let reads = ["A1", "A2"];
    const ctrl = createAdmissionController({ cap: 5, residency: async () => reads, sources: ["issue", "project"], now: () => now });
    await ctrl.admit([], [], "issue"); // lastTrusted = 2
    await ctrl.admit(["P1"], [], "project");
    const trustedProjectBucket = ctrl.census().buckets.find((b) => b.source === "project")!;

    reads = []; // implausible: drop from trusted 2 to 0, nothing in `stopping` explains it
    now = 5000;
    expect(await ctrl.admit(["I1"], [], "issue")).toEqual([]);
    const buckets = ctrl.census().buckets;
    const issue = buckets.find((b) => b.source === "issue")!;
    const project = buckets.find((b) => b.source === "project")!;
    expect(issue).toEqual({ source: "issue", checked: false, declinedAt: new Date(5000).toISOString(), reason: "census-untrusted" });
    expect(project).toEqual(trustedProjectBucket); // untouched
  });

  test("a trusted, over-cap admit() records the withheld list and a confirmedAt taken from the injected clock — never re-stamped by a later census() read alone", async () => {
    let now = 1000;
    const ctrl = createAdmissionController({ cap: 1, residency: async () => [], sources: ["issue"], now: () => now });
    await ctrl.admit(["A", "B"], [], "issue"); // A admitted, B withheld
    const first = ctrl.census().buckets[0]!;
    expect(first).toEqual({ source: "issue", checked: true, confirmedAt: new Date(1000).toISOString(), withheld: ["B"] });

    now = 9000; // the clock moves — a bare re-read must not pick this up
    expect(ctrl.census().buckets[0]).toEqual(first);

    // Only a fresh admit() call for this source may advance its confirmedAt.
    await ctrl.admit(["A", "B"], [], "issue");
    const third = ctrl.census().buckets[0]!;
    if (!third.checked) throw new Error("expected checked:true");
    expect(third.confirmedAt).toBe(new Date(9000).toISOString());
  });

  test("neither fail-safe path touches the wait ledger, lastTrusted, or lastWithheld (§B3) — the census bucket write sits BESIDE that promise, not instead of it", async () => {
    let broken = false;
    const ctrl = createAdmissionController({ cap: 1, residency: async () => { if (broken) throw new Error("down"); return []; }, sources: ["issue"] });
    expect(await ctrl.admit(["A", "B"], [], "issue")).toEqual(["A"]); // B withheld -> wait 1
    expect(ctrl.snapshot().longestWait).toEqual({ id: "B", polls: 1 });

    broken = true;
    expect(await ctrl.admit(["A", "B"], [], "issue")).toEqual([]);
    expect(ctrl.snapshot().longestWait).toEqual({ id: "B", polls: 1 }); // unchanged — §B3 still holds with the census write added beside it
    expect(ctrl.census().buckets.find((b) => b.source === "issue")!.checked).toBe(false);
  });
});
