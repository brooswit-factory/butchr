import { describe, expect, test } from "bun:test";
import { createResidencyGuard } from "../../src/agents/residency-guard.js";
import type { ResidencyVerdict } from "../../src/agents/residency-census.js";

function fakeCensus(verdicts: Record<string, ResidencyVerdict>) {
  const calls: string[][] = [];
  return {
    calls,
    census: async (candidates: readonly string[]) => {
      calls.push([...candidates]);
      const out = new Map<string, ResidencyVerdict>();
      for (const id of candidates) out.set(id, verdicts[id] ?? "unknown");
      return out;
    },
  };
}

describe("createResidencyGuard.filter (BUTCHR-287)", () => {
  test("empty spawning list is a no-op — census is never called", async () => {
    const f = fakeCensus({});
    const guard = createResidencyGuard({ census: f.census });
    expect(await guard.filter([], [])).toEqual([]);
    expect(f.calls).toEqual([]);
  });

  test("a resident candidate is withheld; a vacant one spawns — consulted for exactly the spawning candidates", async () => {
    const f = fakeCensus({ "RESIDENT-1": "resident", "VACANT-1": "vacant" });
    const logs: string[] = [];
    const guard = createResidencyGuard({ census: f.census, log: (l) => logs.push(l) });
    const out = await guard.filter(["RESIDENT-1", "VACANT-1"], ["RESIDENT-1", "VACANT-1"]);
    expect(out).toEqual(["VACANT-1"]);
    expect(f.calls).toEqual([["RESIDENT-1", "VACANT-1"]]);
    expect(logs.some((l) => l.includes("RESIDENT-1") && l.includes("withholding"))).toBe(true);
  });

  test("unknown while NOT fleet-wide (more than one desired, but plan.spawn is a strict subset) spawns anyway — preserves liveness for an isolated ambiguous read", async () => {
    const f = fakeCensus({ "A": "unknown" });
    const guard = createResidencyGuard({ census: f.census });
    // desired has 2 members, but spawning is only 1 of them — not the whole-set shape.
    const out = await guard.filter(["A"], ["A", "B"]);
    expect(out).toEqual(["A"]);
  });

  test("unknown while fleet-wide (whole multi-member desired set is in plan.spawn) is withheld, with the streak bound eventually decaying to a normal spawn", async () => {
    const f = fakeCensus({ "A": "unknown", "B": "unknown" });
    const logs: string[] = [];
    const guard = createResidencyGuard({ census: f.census, log: (l) => logs.push(l) });
    const desired = ["A", "B"];
    // Polls 1-3: withheld (streak 1/3, 2/3, 3/3 — UNKNOWN_WITHHOLD_MAX_POLLS is 3).
    for (let i = 0; i < 3; i++) {
      const out = await guard.filter(["A", "B"], desired);
      expect(out).toEqual([]);
    }
    // Poll 4: streak exceeds the bound — decays, spawns anyway.
    const out4 = await guard.filter(["A", "B"], desired);
    expect([...out4].sort()).toEqual(["A", "B"]);
    expect(logs.some((l) => l.includes("decaying to normal behaviour"))).toBe(true);
  });

  test("a single-member desired set can never be 'fleet-wide' — unknown spawns immediately even when it's the only candidate", async () => {
    const f = fakeCensus({ "SOLO-1": "unknown" });
    const guard = createResidencyGuard({ census: f.census });
    const out = await guard.filter(["SOLO-1"], ["SOLO-1"]);
    expect(out).toEqual(["SOLO-1"]);
  });

  test("a census rejection fails OPEN — every candidate spawns, exactly as if the hook were omitted", async () => {
    const logs: string[] = [];
    const guard = createResidencyGuard({
      census: async () => { throw new Error("herdr down"); },
      log: (l) => logs.push(l),
    });
    const out = await guard.filter(["A", "B"], ["A", "B"]);
    expect([...out].sort()).toEqual(["A", "B"]);
    expect(logs.some((l) => l.includes("WARNING") && l.includes("census failed"))).toBe(true);
  });

  test("a candidate's unknown streak resets once it reads vacant/resident/not-fleet-wide again — a later fleet-wide unknown episode starts over, not from where the last one left off", async () => {
    const verdicts: Record<string, ResidencyVerdict> = { "A": "unknown", "B": "unknown" };
    const census = async (candidates: readonly string[]) => {
      const out = new Map<string, ResidencyVerdict>();
      for (const id of candidates) out.set(id, verdicts[id] ?? "unknown");
      return out;
    };
    const guard = createResidencyGuard({ census });
    const desired = ["A", "B"];
    await guard.filter(["A", "B"], desired); // streak 1/3 for both
    await guard.filter(["A", "B"], desired); // streak 2/3 for both
    verdicts["A"] = "vacant"; // A resolves; B stays ambiguous
    const out = await guard.filter(["A", "B"], desired);
    expect(out).toEqual(["A"]); // A spawns (vacant); B still withheld (streak 3/3)
    verdicts["A"] = "unknown";
    // A's streak restarts at 1/3 rather than resuming near the bound.
    const out2 = await guard.filter(["A", "B"], desired);
    expect(out2).toEqual(["B"]); // B now exceeds the bound (streak 4) and decays; A freshly at 1/3, still withheld
  });

  test("REVIEW FINDING, PR #310: a candidate that LEAVES the spawn list mid-streak is pruned, so a later return starts from zero rather than resuming a stale count and decaying early", async () => {
    // GONE-1 accrues a withhold streak, then vanishes from `spawning` (its
    // ticket finished, or it was spawned) — and later comes back. Without the
    // prune its stale count survives and the second episode decays early.
    // NEGATIVE CONTROL is the assertion at the end: a candidate that never
    // leaves keeps accruing, so this test fails if the prune is over-eager and
    // resets everything every poll.
    const f = fakeCensus({ "GONE-1": "unknown", "STAYS-1": "unknown" });
    const guard = createResidencyGuard({ census: f.census });
    const both = ["GONE-1", "STAYS-1"];
    // two fleet-wide-unknown polls: both withheld, both at streak 2
    expect(await guard.filter(both, both)).toEqual([]);
    expect(await guard.filter(both, both)).toEqual([]);
    // GONE-1 is absent for a poll — its run has genuinely ended
    expect(await guard.filter(["STAYS-1"], ["STAYS-1", "OTHER"])).toEqual(["STAYS-1"]);
    // GONE-1 returns. A stale streak of 2 would put it one poll from decay;
    // pruned, it starts over and is withheld for the full bound again.
    expect(await guard.filter(both, both)).toEqual([]);
    expect(await guard.filter(both, both)).toEqual([]);
    expect(await guard.filter(both, both)).toEqual([]);
    // fourth consecutive poll of the NEW episode: GONE-1 decays and spawns.
    // STAYS-1 never left, so it decayed earlier and is spawning too — that is
    // the control proving the prune is scoped to absent ids, not blanket.
    const out = await guard.filter(both, both);
    expect(out).toContain("GONE-1");
  });

  test("never shrinks the desired set — filter only ever returns a subset of `spawning`, and callers are responsible for `desired` staying untouched (this guard has no way to touch it at all)", async () => {
    const f = fakeCensus({ "A": "resident" });
    const guard = createResidencyGuard({ census: f.census });
    const desiredInput = ["A", "B"];
    const out = await guard.filter(["A"], desiredInput);
    expect(out).toEqual([]);
    expect(desiredInput).toEqual(["A", "B"]); // untouched
  });
});
