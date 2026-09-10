import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  findUnexplainedRegistryModules,
  formatUnexpectedRegistryModulesError,
  KNOWN_NON_MEDIUM_REGISTRY_MODULES,
  listRegistryModules,
  MEDIA_SCAN_BLIND_SPOTS,
} from "../../src/media/media-scan.js";
import { MEDIA_REGISTRY } from "../../src/media/registry.js";
import { assertBlindSpotCoverage, withTempFixture, witnessBlindSpot } from "../../src/media/blind-spot.js";

const ROOT = join(import.meta.dir, "..", "..");

describe("listRegistryModules", () => {
  test("finds a registry.ts one level under a directory, ignores everything else", () => {
    // Uses the real repo tree rather than a synthetic fixture directory — the
    // convention this scans for (src/<dir>/registry.ts) is defined by the
    // real repo layout, and label-scan.ts/header-scan.ts's own tests take
    // the same approach for their own "scan the real tree" describe block.
    const modules = listRegistryModules(join(ROOT, "src"), ROOT);
    expect(modules).toContain("src/labels/registry.ts");
    expect(modules).toContain("src/headers/registry.ts");
    expect(modules).toContain("src/workspace/registry.ts");
    expect(modules).toContain("src/media/registry.ts");
    // BUTCHR-223: `modules.every(...)` was VACUOUSLY TRUE on an empty array —
    // it passed under a dead `listRegistryModules`, so it read as a silence
    // assertion that could not fail in the direction that matters. Anchored
    // to a non-empty result first, which is what makes the shape claim real.
    expect(modules.length).toBeGreaterThan(0);
    expect(modules.filter((m) => !m.endsWith("/registry.ts"))).toEqual([]);
  });
});

describe("findUnexplainedRegistryModules", () => {
  const exclusions = [{ path: "src/media/registry.ts", reason: "test fixture exclusion" }];

  test("keeps only modules that are not a known exclusion", () => {
    const modules = ["src/labels/registry.ts", "src/media/registry.ts", "src/rogue/registry.ts"];
    expect(findUnexplainedRegistryModules(modules, exclusions)).toEqual(["src/labels/registry.ts", "src/rogue/registry.ts"]);
  });

  test("empty input or everything excluded yields no findings", () => {
    expect(findUnexplainedRegistryModules([], exclusions)).toEqual([]);
    expect(findUnexplainedRegistryModules(["src/media/registry.ts"], exclusions)).toEqual([]);
  });
});

describe("formatUnexpectedRegistryModulesError", () => {
  const msg = formatUnexpectedRegistryModulesError(["src/rogue/registry.ts"], ["src/labels/registry.ts"]);

  test("names the found and expected sets", () => {
    expect(msg).toContain("src/rogue/registry.ts");
    expect(msg).toContain("src/labels/registry.ts");
  });
  test("points at MEDIA_REGISTRY and the exclusion file", () => {
    expect(msg).toContain("MEDIA_REGISTRY");
    expect(msg).toContain("media-scan.ts");
  });
});

describe("the actual automatic check — this IS the falsifier, run for real against src/ on every `bun test`", () => {
  const modules = listRegistryModules(join(ROOT, "src"), ROOT);
  const explained = findUnexplainedRegistryModules(modules);

  test("matches exactly the three file-backed media registries — labels, headers, workspace. The fourth medium (docTitle, MEDIA_REGISTRY's own key) has no registry.ts of its own — see that entry's detector: null / noDetectorReason — and is declared here by hand, not discovered by this check; that is this check's own named blind spot (src/media/media-scan.ts's header).", () => {
    if (explained.length !== 3) throw new Error(formatUnexpectedRegistryModulesError(explained, ["src/headers/registry.ts", "src/labels/registry.ts", "src/workspace/registry.ts"]));
    expect(explained).toEqual(["src/headers/registry.ts", "src/labels/registry.ts", "src/workspace/registry.ts"]);
  });

  test("src/media/registry.ts itself is excluded, with a written reason, not special-cased away silently", () => {
    expect(KNOWN_NON_MEDIUM_REGISTRY_MODULES.some((e) => e.path === "src/media/registry.ts")).toBe(true);
    expect(KNOWN_NON_MEDIUM_REGISTRY_MODULES.find((e) => e.path === "src/media/registry.ts")!.reason.length).toBeGreaterThan(0);
  });

  test("MEDIA_REGISTRY declares exactly one more medium (docTitle) than there are file-backed registry modules — the gap this check cannot close on its own", () => {
    expect(Object.keys(MEDIA_REGISTRY).length).toBe(explained.length + 1);
  });

  test("INJECTED FALSIFIER (this ticket's own falsifier, restated as an in-memory regression pin — see the PR body for the real, run-and-reverted construction of src/example-injected/registry.ts on disk): a new registry module with no MEDIA_REGISTRY entry is caught", () => {
    const injected = [...modules, "src/example-injected/registry.ts"].sort();
    const unexplained = findUnexplainedRegistryModules(injected);
    expect(unexplained).toContain("src/example-injected/registry.ts");
  });
});

/**
 * BUTCHR-254 — MEDIA_SCAN_BLIND_SPOTS, SPLIT INTO TWO ENTRIES UNDER
 * BUTCHR-223 AFTER REVIEW. One entry is witnessed below; the other is
 * `witness: null` with a written `noWitnessReason` — see each entry's own
 * fields in `src/media/media-scan.ts`, and that file's module header, for
 * why the split was necessary rather than cosmetic.
 *
 * THIS COMMENT USED TO SAY "no `test()` here calls `witnessBlindSpot`" and
 * that `assertBlindSpotCoverage` "passes trivially here since this list
 * declares none". Both were true when written and both are now FALSE. It is
 * left named rather than silently rewritten because it is this epic's own
 * defect — a cached description outliving the thing it described — occurring
 * in this epic's own test file, and because nothing in the mechanism would
 * ever have caught it: `assertBlindSpotCoverage` grades entries, never the
 * prose around them.
 *
 * `assertBlindSpotCoverage` still runs at the bottom of this describe block,
 * because it must, for every list this mechanism is applied to (see
 * src/media/blind-spot.ts, "THE ORDERING HAZARD"). It is no longer vacuous:
 * one entry declares a witness id, so deleting the witness below turns the
 * coverage call red instead of leaving it green.
 */
describe("MEDIA_SCAN_BLIND_SPOTS (BUTCHR-254, split under BUTCHR-223)", () => {
  /**
   * THE WITNESS AN EARLIER `noWitnessReason` SAID COULD NOT BE BUILT.
   *
   * The claim is about the CONVENTION this scanner requires WITHIN a root it
   * is already scanning — not about which root it is pointed at (that is
   * family-scan's `unscannedDirectories`, a different mechanism). So both
   * halves live inside ONE scanned root, and the only difference between
   * them is whether the medium's directory holds a `registry.ts`:
   *
   *   silence         — a structurally-enforced medium (enforcement code in
   *                     the directory, no registry.ts) is NOT found;
   *   positiveControl — a sibling medium in the SAME fixture root that does
   *                     have registry.ts IS found.
   *
   * The positive control is what makes the silence half mean something: it
   * proves the scanner was pointed somewhere it could actually see, so the
   * silence is the convention's blindness rather than a mis-aimed scan.
   * Nothing here asserts anything about the real MEDIA_REGISTRY's
   * completeness — that claim is `docTitleHandDeclarationCurrency`, which
   * keeps `witness: null` deliberately.
   */
  test("nonRegistryConventionMediumInvisible — a structurally-enforced medium with no registry.ts, INSIDE the scanned root, is invisible; a sibling medium in the same root that has one IS found", () => {
    withTempFixture((root) => {
      const src = join(root, "src");
      mkdirSync(src);
      // The docTitle-shaped medium: real enforcement code, no registry.ts.
      mkdirSync(join(src, "structural-medium"));
      writeFileSync(join(src, "structural-medium", "enforce.ts"), 'export function isProvisional(t: string): boolean {\n  return t.startsWith("[unwritten]");\n}\n');
      // The conventional medium, same root, one level down, with registry.ts.
      mkdirSync(join(src, "conventional-medium"));
      writeFileSync(join(src, "conventional-medium", "registry.ts"), "export const REGISTRY = {} as const;\n");

      const modules = listRegistryModules(src, root);
      witnessBlindSpot("media:non-registry-convention-medium", {
        silence: () => {
          expect(modules.some((m) => m.includes("structural-medium"))).toBe(false);
          expect(findUnexplainedRegistryModules(modules, []).some((m) => m.includes("structural-medium"))).toBe(false);
        },
        positiveControl: () => {
          expect(modules).toContain("src/conventional-medium/registry.ts");
          expect(findUnexplainedRegistryModules(modules, [])).toContain("src/conventional-medium/registry.ts");
        },
      });
    });
  });

  test("docTitleHandDeclarationCurrency is witness: null with a non-empty written reason", () => {
    expect(MEDIA_SCAN_BLIND_SPOTS.docTitleHandDeclarationCurrency.witness).toBeNull();
    if (MEDIA_SCAN_BLIND_SPOTS.docTitleHandDeclarationCurrency.witness === null) {
      expect(MEDIA_SCAN_BLIND_SPOTS.docTitleHandDeclarationCurrency.noWitnessReason.trim().length).toBeGreaterThan(0);
    }
  });

  test("the two entries are distinct claims, not one claim split for appearance — the witnessed one is witnessed, the unwitnessed one carries a reason, and their claims differ", () => {
    expect(MEDIA_SCAN_BLIND_SPOTS.nonRegistryConventionMediumInvisible.witness).toBe("media:non-registry-convention-medium");
    expect(MEDIA_SCAN_BLIND_SPOTS.nonRegistryConventionMediumInvisible.claim).not.toBe(MEDIA_SCAN_BLIND_SPOTS.docTitleHandDeclarationCurrency.claim);
  });

  test("exactly two entries — a change here means a claim became witnessable or a new one was added; update this pin deliberately, not by reflex", () => {
    expect(Object.keys(MEDIA_SCAN_BLIND_SPOTS)).toEqual(["nonRegistryConventionMediumInvisible", "docTitleHandDeclarationCurrency"]);
  });

  test("COVERAGE (see src/media/blind-spot.ts, 'THE ORDERING HAZARD'): every MEDIA_SCAN_BLIND_SPOTS entry's declared witness id was actually executed, or it declares a written noWitnessReason instead", () => {
    assertBlindSpotCoverage("MEDIA_SCAN_BLIND_SPOTS", MEDIA_SCAN_BLIND_SPOTS);
  });
});
