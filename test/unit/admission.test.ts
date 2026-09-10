import { describe, expect, test } from "bun:test";
import { admitWithinBudget, createAdmissionController, ImplausibleZeroGuard, MAX_IMPLAUSIBLE_POLLS } from "../../src/agents/admission.js";
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
    expect(ctrl.snapshot()).toEqual({ cap: 5, residency: 2 });
  });

  test("budget exactly consumed by residency admits nothing new", async () => {
    const ctrl = createAdmissionController({ cap: 2, residency: async () => ["R1", "R2"] });
    expect(await ctrl.admit(["A", "B"], [])).toEqual([]);
  });

  test("over the cap: withholds the excess, admits the front of the deterministic order, and logs a ratio naming the cap/residency/withheld ids", async () => {
    const lines: string[] = [];
    const ctrl = createAdmissionController({ cap: 2, residency: async () => ["R1"], log: (l) => lines.push(l) });
    expect(await ctrl.admit(["A", "B", "C"], [])).toEqual(["A"]);
    const line = lines.find((l) => l.startsWith("[admission]"));
    expect(line).toBeDefined();
    expect(line).toContain("cap=2");
    expect(line).toContain("residency=1");
    expect(line).toContain("withheld 2/3");
    expect(line).toContain("B, C");
  });

  test("empty candidates: nothing to admit, no [admission] withheld line even when residency is at/above cap", async () => {
    const lines: string[] = [];
    const ctrl = createAdmissionController({ cap: 1, residency: async () => ["R1", "R2"], log: (l) => lines.push(l) });
    expect(await ctrl.admit([], [])).toEqual([]);
    expect(lines.some((l) => l.startsWith("[admission]"))).toBe(false);
  });

  describe("Trap 2 — untrusted census", () => {
    test("(1) residency() throws: withholds every candidate, fail-safe, and logs — never touches the trusted snapshot", async () => {
      const lines: string[] = [];
      const ctrl = createAdmissionController({ cap: 5, residency: async () => { throw new Error("herdr down"); }, log: (l) => lines.push(l) });
      expect(await ctrl.admit(["A", "B"], [])).toEqual([]);
      expect(ctrl.snapshot()).toEqual({ cap: 5, residency: null }); // still no trusted observation
      expect(lines.some((l) => l.includes("WARNING") && l.includes("threw"))).toBe(true);
    });

    test("a throw with zero candidates logs nothing (nothing was withheld)", async () => {
      const lines: string[] = [];
      const ctrl = createAdmissionController({ cap: 5, residency: async () => { throw new Error("boom"); }, log: (l) => lines.push(l) });
      expect(await ctrl.admit([], [])).toEqual([]);
      expect(lines.length).toBe(0);
    });

    test("cold start: no prior trusted observation, residency reads 0 — trusted immediately, NOT withheld (this is the legitimate boot case, not the BUTCHR-282 shape)", async () => {
      const ctrl = createAdmissionController({ cap: 3, residency: async () => [] });
      expect(await ctrl.admit(["A", "B"], [])).toEqual(["A", "B"]);
      expect(ctrl.snapshot()).toEqual({ cap: 3, residency: 0 });
    });

    test("(2) readable-but-implausible zero: previously trusted at R>0, this poll's own plan stops fewer than R, census now reads 0 — withheld, trusted snapshot unchanged", async () => {
      let reads = ["A1", "A2", "A3"]; // first call establishes trust at 3
      const lines: string[] = [];
      const ctrl = createAdmissionController({ cap: 5, residency: async () => reads, log: (l) => lines.push(l) });
      expect(await ctrl.admit([], [])).toEqual([]); // establishes lastTrusted = 3
      expect(ctrl.snapshot().residency).toBe(3);

      reads = []; // next census implausibly reports empty
      expect(await ctrl.admit(["NEW"], [])).toEqual([]); // withheld — stopping.length (0) < lastTrusted (3)
      expect(ctrl.snapshot().residency).toBe(3); // unchanged — the implausible read was never trusted
      expect(lines.some((l) => l.includes("untrustworthy read"))).toBe(true);
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
      expect(ctrl.snapshot()).toEqual({ cap: 5, residency: 0 });
      expect(lines.some((l) => l.includes("bound exceeded"))).toBe(true);
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
