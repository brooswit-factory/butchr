import { describe, expect, test } from "bun:test";
import { MEDIA_REGISTRY, type BlindSpotIdsField, type DetectorField, type MediaRegistryEntry } from "../../src/media/registry.js";
import { HEADER_BLIND_SPOT_IDS } from "../../src/headers/header-scan.js";
import { LABEL_BLIND_SPOT_IDS } from "../../src/labels/label-scan.js";
import { WORKSPACE_BLIND_SPOT_IDS } from "../../src/workspace/workspace-scan.js";

describe("MEDIA_REGISTRY shape (every entry declares a real withdrawal story, a detector or a written reason for none, blind spots, and a deployed-truth statement)", () => {
  const nonEmpty = (s: string) => expect(s.trim().length).toBeGreaterThan(0);

  for (const [medium, entry] of Object.entries(MEDIA_REGISTRY) as [string, MediaRegistryEntry][]) {
    test(`${medium}: withdrawal is a non-empty list of {grade, mechanism} entries, each with non-empty prose`, () => {
      expect(entry.withdrawal.length).toBeGreaterThan(0);
      for (const w of entry.withdrawal) {
        expect(["structural", "same-call", "eventual", "time-invariant", "self-declaring"]).toContain(w.grade);
        nonEmpty(w.mechanism);
      }
    });
    test(`${medium}: blindSpots and deployedTruth are non-empty prose`, () => {
      nonEmpty(entry.blindSpots);
      nonEmpty(entry.deployedTruth);
    });
    test(`${medium}: blindSpotIds is either a non-empty array, or null with a non-empty noBlindSpotIdsReason`, () => {
      if (entry.blindSpotIds === null) {
        nonEmpty(entry.noBlindSpotIdsReason);
      } else {
        expect(Array.isArray(entry.blindSpotIds)).toBe(true);
        expect(entry.blindSpotIds.length).toBeGreaterThan(0);
      }
    });
    test(`${medium}: detector is either a non-empty string, or null with a non-empty noDetectorReason`, () => {
      if (entry.detector === null) {
        nonEmpty(entry.noDetectorReason);
      } else {
        expect(typeof entry.detector).toBe("string");
        nonEmpty(entry.detector);
      }
    });
  }
});

describe("MEDIA_REGISTRY contents (verified against the code each medium actually runs, not copied from any ticket)", () => {
  test("exactly four media declared today — labels, headers, workspace, docTitle; a change here means a medium was added or removed, update deliberately, not by reflex", () => {
    expect(Object.keys(MEDIA_REGISTRY).sort()).toEqual(["docTitle", "headers", "labels", "workspace"]);
  });

  test("labels: mixes eventual (agent:*/pr:*) and same-call (butchr:shelved/butchr:orphan) — not one uniform grade", () => {
    const grades = MEDIA_REGISTRY.labels.withdrawal.map((w) => w.grade).sort();
    expect(grades).toEqual(["eventual", "same-call"]);
  });

  test("headers: mixes same-call (orphan) and time-invariant (adopted)", () => {
    const grades = MEDIA_REGISTRY.headers.withdrawal.map((w) => w.grade).sort();
    expect(grades).toEqual(["same-call", "time-invariant"]);
  });

  test("workspace: mixes time-invariant (KEY/TYPE), self-declaring (GROUND_TRUTH), and same-call (SUMMARY) — and its blindSpots names PARENT as a live, ungraded gap, not silently folded into any of the three", () => {
    const grades = MEDIA_REGISTRY.workspace.withdrawal.map((w) => w.grade).sort();
    expect(grades).toEqual(["same-call", "self-declaring", "time-invariant"]);
    expect(MEDIA_REGISTRY.workspace.blindSpots).toContain("PARENT");
  });

  test("docTitle: structural — the positive control — and has no detector, with a written reason why none is needed", () => {
    expect(MEDIA_REGISTRY.docTitle.withdrawal).toEqual([{ grade: "structural", mechanism: expect.any(String) }]);
    expect(MEDIA_REGISTRY.docTitle.detector).toBeNull();
    if (MEDIA_REGISTRY.docTitle.detector === null) {
      expect(MEDIA_REGISTRY.docTitle.noDetectorReason.length).toBeGreaterThan(0);
    }
  });

  test("docTitle: blindSpotIds is null, with a written reason distinct from media-scan.ts's own docTitleNotRegistryConvention noWitnessReason (BUTCHR-254) — a medium having no list of its own gaps is a different claim from a check being blind to that medium's shape", () => {
    expect(MEDIA_REGISTRY.docTitle.blindSpotIds).toBeNull();
    if (MEDIA_REGISTRY.docTitle.blindSpotIds === null) {
      expect(MEDIA_REGISTRY.docTitle.noBlindSpotIdsReason.length).toBeGreaterThan(0);
    }
  });

  /**
   * BUTCHR-254, THE LOOP-CLOSING PART: labels/headers/workspace's
   * blindSpotIds are tied to their own medium's scanner-file blind-spot id
   * list BY DIRECT IMPORT (see src/media/registry.ts's header, "A
   * DELIBERATE, NARROW EXCEPTION") — `.toBe` (reference equality, not
   * `.toEqual`) is deliberate here: it proves this file assigned the SAME
   * array, not a copy that merely happens to match today. A copy would
   * still pass a `.toEqual` check and could still silently drift the next
   * time either list changes; a shared reference cannot drift by
   * construction, which is the whole point of this field.
   */
  test("labels/headers/workspace blindSpotIds are the SAME array object as their scanner file's own *_BLIND_SPOT_IDS export — reference equality, proving no independently-driftable copy exists", () => {
    expect(MEDIA_REGISTRY.labels.blindSpotIds).toBe(LABEL_BLIND_SPOT_IDS);
    expect(MEDIA_REGISTRY.headers.blindSpotIds).toBe(HEADER_BLIND_SPOT_IDS);
    expect(MEDIA_REGISTRY.workspace.blindSpotIds).toBe(WORKSPACE_BLIND_SPOT_IDS);
  });

  test("only eventual-graded entries exist for a medium with a real selection (labels) — structural/same-call/time-invariant/self-declaring entries never claim a selection exists (AC: the grading's whole payoff, per this file's header)", () => {
    for (const [medium, entry] of Object.entries(MEDIA_REGISTRY)) {
      const eventual = entry.withdrawal.filter((w) => w.grade === "eventual");
      if (medium !== "labels") expect(eventual.length).toBe(0);
    }
  });

  test("every entry's deployedTruth says nothing is proven about the running fleet — the honest value for all four today", () => {
    for (const entry of Object.values(MEDIA_REGISTRY)) {
      expect(entry.deployedTruth.toLowerCase()).toContain("nothing");
    }
  });
});

/**
 * THE TYPE-LEVEL DOOR, PROVEN RATHER THAN ASSERTED — same technique as
 * test/unit/labels-registry.test.ts / test/unit/header-registry.test.ts /
 * test/unit/workspace-registry.test.ts: `@ts-expect-error` requires the very
 * next statement to fail to typecheck, or `bun run typecheck` itself fails
 * ("Unused '@ts-expect-error' directive"), so these are real, CI-enforced
 * compile-time tests, not claims trusted on faith.
 */
describe("DetectorField / MediaRegistryEntry — type-level shape (compile-time, verified by `bun run typecheck`)", () => {
  test("a valid detector: null entry, with its required reason, compiles", () => {
    const noDetector: DetectorField = { detector: null, noDetectorReason: "example reason: replace with a real, human-written justification when actually declaring no detector" };
    expect(noDetector.detector).toBeNull();
  });

  test("detector: null WITHOUT noDetectorReason does not compile", () => {
    // @ts-expect-error — the detector: null branch requires a non-empty noDetectorReason.
    const missingReason: DetectorField = { detector: null };
    expect(missingReason).toBeDefined();
  });

  test("omitting detector entirely does not compile", () => {
    // @ts-expect-error — detector is required; every DetectorField branch demands it.
    const missing: DetectorField = {};
    expect(missing).toBeDefined();
  });

  test("extending Medium without a matching MEDIA_REGISTRY entry does not compile — proven structurally, not re-asserted: MEDIA_REGISTRY's own declared type is Record<Medium, MediaRegistryEntry>, so this file's very first import (MEDIA_REGISTRY typechecking against that Record type today) already IS the compile-time proof that every current member has an entry; a future member with none would fail that same assignment, not a new check.", () => {
    expect(Object.keys(MEDIA_REGISTRY).sort()).toEqual(["docTitle", "headers", "labels", "workspace"]);
  });

  test("a valid blindSpotIds: null entry, with its required reason, compiles", () => {
    const noIds: BlindSpotIdsField = { blindSpotIds: null, noBlindSpotIdsReason: "example reason: replace with a real, human-written justification when actually declaring no blind-spot id list" };
    expect(noIds.blindSpotIds).toBeNull();
  });

  test("blindSpotIds: null WITHOUT noBlindSpotIdsReason does not compile", () => {
    // @ts-expect-error — the blindSpotIds: null branch requires a non-empty noBlindSpotIdsReason.
    const missingReason: BlindSpotIdsField = { blindSpotIds: null };
    expect(missingReason).toBeDefined();
  });

  test("omitting blindSpotIds entirely does not compile", () => {
    // @ts-expect-error — blindSpotIds is required; every BlindSpotIdsField branch demands it.
    const missing: BlindSpotIdsField = {};
    expect(missing).toBeDefined();
  });
});
