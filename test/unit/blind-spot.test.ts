import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertBlindSpotCoverage,
  executedWitnessIds,
  withTempFixture,
  witnessBlindSpot,
  type BlindSpotEntry,
} from "../../src/media/blind-spot.js";

describe("witnessBlindSpot — the pairing is structural, not conventional", () => {
  test("records the id only after BOTH halves run without throwing", () => {
    let silenceRan = false;
    let positiveControlRan = false;
    witnessBlindSpot("test:pairing-both-ran", {
      silence: () => {
        silenceRan = true;
      },
      positiveControl: () => {
        positiveControlRan = true;
      },
    });
    expect(silenceRan).toBe(true);
    expect(positiveControlRan).toBe(true);
    expect(executedWitnessIds().has("test:pairing-both-ran")).toBe(true);
  });

  test("a throwing silence half prevents recording — the id never appears in executedWitnessIds()", () => {
    expect(() =>
      witnessBlindSpot("test:pairing-silence-throws", {
        silence: () => {
          throw new Error("the detector unexpectedly saw it");
        },
        positiveControl: () => {
          throw new Error("should never run");
        },
      }),
    ).toThrow("the detector unexpectedly saw it");
    expect(executedWitnessIds().has("test:pairing-silence-throws")).toBe(false);
  });

  test("a throwing positiveControl half (silence passes) also prevents recording — the detector-was-awake half is not optional", () => {
    expect(() =>
      witnessBlindSpot("test:pairing-positive-control-throws", {
        silence: () => {
          /* passes */
        },
        positiveControl: () => {
          throw new Error("near-miss was not actually detected");
        },
      }),
    ).toThrow("near-miss was not actually detected");
    expect(executedWitnessIds().has("test:pairing-positive-control-throws")).toBe(false);
  });
});

describe("assertBlindSpotCoverage — the runtime door door 1 (the type) cannot close on its own", () => {
  test("passes when every witness id declared has actually executed", () => {
    witnessBlindSpot("test:coverage-declared-and-run", { silence: () => {}, positiveControl: () => {} });
    const entries: Record<string, BlindSpotEntry> = {
      example: { claim: "example", witness: "test:coverage-declared-and-run" },
    };
    expect(() => assertBlindSpotCoverage("example registry", entries)).not.toThrow();
  });

  test("a witness id string that compiles fine but was never executed by any test fails coverage — THE GAP THE TYPE ALONE LEAVES", () => {
    const entries: Record<string, BlindSpotEntry> = {
      neverWritten: { claim: "example", witness: "test:coverage-declared-but-never-run-xyz" },
    };
    expect(() => assertBlindSpotCoverage("example registry", entries)).toThrow(/neverWritten/);
  });

  test("a witness: null entry with a reason never needs to appear in executedWitnessIds() — coverage does not demand a witness where none is declared", () => {
    const entries: Record<string, BlindSpotEntry> = {
      unwitnessable: { claim: "example", witness: null, noWitnessReason: "genuinely cannot be witnessed, for a stated reason" },
    };
    expect(() => assertBlindSpotCoverage("example registry", entries)).not.toThrow();
  });

  test("names every offending entry at once, not just the first", () => {
    const entries: Record<string, BlindSpotEntry> = {
      first: { claim: "x", witness: "test:coverage-missing-a" },
      second: { claim: "x", witness: "test:coverage-missing-b" },
    };
    expect(() => assertBlindSpotCoverage("example registry", entries)).toThrow(/first.*second|second.*first/s);
  });
});

describe("withTempFixture — isolated, cleaned up regardless of outcome", () => {
  test("hands fn a real, empty, writable directory", () => {
    withTempFixture((dir) => {
      expect(existsSync(dir)).toBe(true);
      mkdirSync(join(dir, "src"));
      writeFileSync(join(dir, "src", "x.ts"), "export const x = 1;");
      expect(existsSync(join(dir, "src", "x.ts"))).toBe(true);
    });
  });

  test("removes the directory after fn returns normally", () => {
    let capturedDir = "";
    withTempFixture((dir) => {
      capturedDir = dir;
    });
    expect(existsSync(capturedDir)).toBe(false);
  });

  test("removes the directory even when fn throws, and the throw still propagates", () => {
    let capturedDir = "";
    expect(() =>
      withTempFixture((dir) => {
        capturedDir = dir;
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(existsSync(capturedDir)).toBe(false);
  });
});

/**
 * THE TYPE-LEVEL DOOR, PROVEN RATHER THAN ASSERTED — same technique as
 * test/unit/media-registry.test.ts's DetectorField proof: `@ts-expect-error`
 * requires the very next statement to fail to typecheck, or `bun run
 * typecheck` itself fails ("Unused '@ts-expect-error' directive"), so these
 * are real, CI-enforced compile-time tests, not claims trusted on faith.
 */
describe("BlindSpotWitnessField / BlindSpotEntry — type-level shape (compile-time, verified by `bun run typecheck`)", () => {
  test("a valid witness: null entry, with its required reason, compiles", () => {
    const noWitness: BlindSpotEntry = { claim: "x", witness: null, noWitnessReason: "example reason: replace with a real, human-written justification when actually declaring no witness" };
    expect(noWitness.witness).toBeNull();
  });

  test("a valid witness: <id> entry compiles", () => {
    const withWitness: BlindSpotEntry = { claim: "x", witness: "some:id" };
    expect(withWitness.witness).toBe("some:id");
  });

  test("witness: null WITHOUT noWitnessReason does not compile", () => {
    // @ts-expect-error — the witness: null branch requires a non-empty noWitnessReason.
    const missingReason: BlindSpotEntry = { claim: "x", witness: null };
    expect(missingReason).toBeDefined();
  });

  test("omitting witness entirely does not compile", () => {
    // @ts-expect-error — witness is required; every BlindSpotEntry branch demands it.
    const missing: BlindSpotEntry = { claim: "x" };
    expect(missing).toBeDefined();
  });
});
