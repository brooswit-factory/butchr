import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * BUTCHR-222/BUTCHR-224 — the shared machinery behind "a declared blind spot
 * is an executable witness with a paired positive control, or a written
 * reason there cannot be one," applied by THIS ticket to exactly three
 * detectors (`src/headers/header-scan.ts`, `src/labels/label-scan.ts`,
 * `src/workspace/workspace-scan.ts`) and SHAPED, not applied, for a sibling
 * story to reuse against the remaining two (`src/media/family-scan.ts`,
 * `src/media/media-scan.ts`) without a rewrite — see BUTCHR-222 for that
 * boundary. This file owns none of the three detectors' own blind-spot lists
 * (those live beside each detector, e.g. `HEADER_BLIND_SPOTS` in
 * `header-scan.ts`) — it owns only the vocabulary and the runtime link every
 * one of those lists is built from.
 *
 * THE PROBLEM THIS RETIRES: a `WHAT THIS CANNOT SEE` prose bullet is
 * satisfiable by writing a sentence and running nothing (BUTCHR-150's own
 * distinction: "the author states the blind spot" and "the blind spot is
 * true" are independent claims, and a self-stated blind spot in that epic
 * went wrong twice with no mechanism catching either time).
 *
 * TWO DOORS, THE SAME SHAPE `src/labels/registry.ts`/`src/headers/
 * registry.ts`/`src/workspace/registry.ts`/`src/media/registry.ts` ALREADY
 * USE FOR "withdrawnBy"/"detector", APPLIED HERE TO "witness":
 *   1. THE TYPE-LEVEL DOOR (`BlindSpotWitnessField` below). `witness: null`
 *      REQUIRES a written `noWitnessReason` — the omission is impossible to
 *      express, not merely discouraged by a comment, exactly the discipline
 *      `DetectorField` (`src/media/registry.ts`) already proves compiles
 *      both ways (see `test/unit/blind-spot.test.ts`'s own `@ts-expect-error`
 *      lines). This door catches a blind spot entry with NEITHER a witness
 *      NOR a reason. It does NOT catch a `witness: "some-id"` naming a test
 *      nobody ever wrote — that string still compiles whether or not
 *      anything at runtime ever executes under that id. That gap is door 2.
 *   2. THE RUNTIME DOOR (`witnessBlindSpot` + `assertBlindSpotCoverage`
 *      below). `witnessBlindSpot(id, ...)` records `id` as EXECUTED only
 *      after running both halves of the pair; `assertBlindSpotCoverage`
 *      compares every entry's declared `witness` id against the set actually
 *      recorded and fails on any that never ran. This is what makes a
 *      declared-but-unwritten witness a red suite, not a silent gap door 1
 *      cannot see.
 *
 * THE PAIRING IS STRUCTURAL, NOT CONVENTIONAL: `BlindSpotWitnessCheck` below
 * requires BOTH `silence` and `positiveControl` — TypeScript refuses a call
 * to `witnessBlindSpot` missing either, so an unpaired silence assertion (one
 * that would pass trivially if the detector were simply never alive on that
 * input — a malformed fixture, a typo'd function name, an empty corpus) is
 * not something a later author can write by forgetting the other half. A
 * check that could not have failed is not evidence, even when its verdict is
 * true; the positive control is what proves the detector was awake and that
 * the SPECIFIC claimed property, not detector death, produced the silence.
 *
 * THE ORDERING HAZARD, AND WHY THIS FILE DOES NOT SOLVE IT WITH GLOBAL SETUP:
 * `assertBlindSpotCoverage` reads module-level state (`recordedWitnessIds`)
 * that `witnessBlindSpot` calls mutate. If the coverage assertion ran in a
 * DIFFERENT test file from the witnesses it checks, bun's cross-file test
 * ordering (not documented here as guaranteed, and not worth depending on)
 * could run it before those witnesses ever executed, failing or passing for
 * reasons unrelated to the diff. THE SOLUTION THIS TICKET USES, AND EVERY
 * CALLER MUST: put a detector's `assertBlindSpotCoverage` call in the SAME
 * test file as that detector's own `witnessBlindSpot` calls, ordered AFTER
 * them — bun (like every Jest-shaped runner this codebase's other tests
 * already depend on implicitly) runs `test()` bodies within one file
 * sequentially, in declaration order, by default. See
 * `test/unit/header-registry.test.ts`/`test/unit/labels-registry.test.ts`/
 * `test/unit/workspace-registry.test.ts` for the three call sites this
 * ticket adds, each at the end of its own file, never split across files.
 *
 * `withTempFixture` BELOW EXISTS BECAUSE THREE OF THIS TICKET'S OWN BLIND
 * SPOTS ARE ABOUT WHICH DIRECTORY/EXTENSION IS SCANNED, NOT ABOUT WHAT A
 * PARSER CAN READ: "test/ and scripts/ are not scanned," "a second templates
 * directory," "a subdirectory of briefs/," and "non-.ts files" are all
 * claims about the real `list*Files`/`scanDirFor*`/`scanTemplatesFor*`
 * filesystem-walking functions, not about `findHeaderTagLiterals`/
 * `findLabelLiterals`/`findWorkspacePlaceholders`'s pure text parsing — so
 * witnessing them honestly means exercising the real walker against a real,
 * disposable directory tree, not a text fixture. Using the real repo's own
 * `test/`/`scripts/`/`briefs/` directories for this would make the witness
 * fragile to unrelated content changes in those directories and would risk
 * a witness quietly stopping being a witness (e.g. if every existing
 * header-tag-shaped literal were ever removed from `test/`); an isolated
 * temp directory this file creates and destroys per call is immune to both.
 *
 * THE HONEST LIMIT, STATED HERE BECAUSE THIS IS THE MECHANISM'S OWN MODULE —
 * DO NOT DROP THIS QUALIFIER WHEN DESCRIBING WHAT THIS FILE BUYS: promoting a
 * prose bullet list into a value-level list like `HEADER_BLIND_SPOTS` does
 * NOT make the list COMPLETE. Nothing here checks that every prose bullet a
 * detector's own module header once carried became an entry, and nothing
 * here checks that a detector has no blind spot its author never noticed —
 * that residual layer is still self-declaring, and this mechanism cannot
 * remove it (BUTCHR-150's distinction, landed exactly: this closes "is the
 * stated blind spot true," never "is the list of stated blind spots
 * complete"). What this DOES buy is precise and worth having: every
 * DECLARED blind spot stops being a sentence and becomes a measurement, and
 * if someone later closes one of those holes, the suite goes RED and tells
 * them the note is now false.
 *
 * NO RUNTIME BEHAVIOUR LIVES IN THE DAEMON FOR THIS — same discipline every
 * scanner/registry this file sits beside already declares for itself: this
 * module is imported only by test files and by the three detectors' own
 * blind-spot-list declarations, never by any write path.
 */

/**
 * `witness: null` REQUIRES a written reason — the same "you cannot say
 * 'none' without writing why" discipline `DetectorField` (`src/media/
 * registry.ts`) already proves compiles both ways. See
 * `test/unit/blind-spot.test.ts` for the `@ts-expect-error` proof this
 * union really does fail to compile both ways.
 */
export type BlindSpotWitnessField =
  | { readonly witness: string }
  | { readonly witness: null; readonly noWitnessReason: string };

/** One declared blind spot: the claim itself, plus the witness door above. */
export type BlindSpotEntry = BlindSpotWitnessField & {
  /**
   * Prose: the claim this entry makes, in enough detail to stand alone —
   * this IS the source of truth a detector's own "WHAT THIS CANNOT SEE"
   * module header now points at, not a second copy of it. Move the
   * substantive reasoning here when converting a prose bullet into an
   * entry; do not leave the old bullet's prose behind as a shadow copy.
   */
  readonly claim: string;
};

const recordedWitnessIds = new Set<string>();

export interface BlindSpotWitnessCheck {
  /**
   * Asserts the detector stays silent on the input this blind spot claims is
   * invisible. Throw (via `expect(...)`) if the detector unexpectedly DOES
   * see it — under the scope fences this whole story works under, that is a
   * real finding (the claim was false), not a bug in the witness.
   */
  readonly silence: () => void;
  /**
   * Asserts a near-miss variant of the SAME input IS detected — proves the
   * detector was awake on this fixture and that the specific claimed
   * property, not detector death, produced the silence above.
   */
  readonly positiveControl: () => void;
}

/**
 * Run BOTH halves of a blind-spot witness, in order, then record `id` as
 * executed. Call this from inside a `test()` body. If either half throws,
 * the test fails and `id` is never recorded — exactly the failure a
 * mutation-verification (criterion 6) is supposed to produce on a real
 * injected input, and exactly why `assertBlindSpotCoverage` (below) treats
 * "declared but never recorded" as equivalent to "no witness at all."
 */
export function witnessBlindSpot(id: string, check: BlindSpotWitnessCheck): void {
  check.silence();
  check.positiveControl();
  recordedWitnessIds.add(id);
}

/** Every witness id actually EXECUTED (both halves, no throw) so far in this test run. Exposed read-only; the only way to add to it is `witnessBlindSpot`. */
export function executedWitnessIds(): ReadonlySet<string> {
  return recordedWitnessIds;
}

/**
 * THE RUNTIME COVERAGE ASSERTION: every entry declaring a witness id must
 * have that id present in `executedWitnessIds()`. Throws (with every
 * offending key named at once, not just the first) rather than returning a
 * boolean, so a caller cannot accidentally ignore the result the way an
 * unchecked return value could be — mirrors this codebase's own
 * `formatUnregistered*Error`-then-`throw` convention in the three detectors'
 * own test files.
 *
 * See this file's header, "THE ORDERING HAZARD," for the ONE placement rule
 * this function's correctness depends on: call it in the SAME test file as,
 * and ordered AFTER, the `witnessBlindSpot` calls for `entries`.
 */
export function assertBlindSpotCoverage(label: string, entries: Readonly<Record<string, BlindSpotEntry>>): void {
  const missing = Object.entries(entries)
    .filter(([, entry]) => entry.witness !== null && !recordedWitnessIds.has(entry.witness))
    .map(([key, entry]) => `${key} (declared witness id "${entry.witness}")`);
  if (missing.length > 0) {
    throw new Error(
      `${label}: ${missing.length} blind-spot entr${missing.length === 1 ? "y declares" : "ies declare"} a witness id that no test ever executed: ${missing.join(", ")}. ` +
        "Either write a test calling witnessBlindSpot with that exact id (src/media/blind-spot.ts), or change the entry to witness: null with a written noWitnessReason.",
    );
  }
}

/**
 * Create an isolated, empty temp directory, hand it to `fn`, then remove it
 * (recursively, best-effort) whether `fn` throws or not. Exists so the
 * directory/extension-scoping witnesses (see this file's header) exercise
 * the real filesystem-walking functions without depending on, or risking
 * corrupting, this repo's own `test/`/`scripts/`/`briefs/` content.
 */
export function withTempFixture<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "butchr-blind-spot-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
