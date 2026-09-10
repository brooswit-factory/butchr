import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { BlindSpotEntry } from "./blind-spot.js";

/**
 * BUTCHR-172/BUTCHR-154 — keeps `./registry.ts`'s own `MEDIA_REGISTRY` from
 * becoming this epic's defect in a NEW medium: an index of media that
 * nothing checks is exactly the same "declared to exist, never checked to
 * reach" shape as an unswept `agent:stalled`, just moved up one level, from
 * records to media themselves.
 *
 * WHAT THIS CHECKS: that the set of per-medium REGISTRY MODULES actually on
 * disk — every `src/<dir>/registry.ts`, one level under `src/`, matching the
 * convention `src/labels/registry.ts`/`src/headers/registry.ts`/
 * `src/workspace/registry.ts` already set — is exactly the set this file's
 * caller expects, after excluding `src/media/registry.ts` itself (the
 * index, not a medium) through `KNOWN_NON_MEDIUM_REGISTRY_MODULES`, never by
 * special-casing it away silently. See `test/unit/media-scan.test.ts` for
 * the concrete expected set, hardcoded there the same deliberate way
 * `test/unit/labels-registry.test.ts` hardcodes "exactly 11 registered
 * labels" — a change here means a medium's registry module was added or
 * removed on disk; update the expectation deliberately, not by reflex.
 *
 * WHY A DIRECTORY CONVENTION, NOT A COMPARISON AGAINST `MEDIA_REGISTRY`'S
 * OWN KEYS DIRECTLY: this file deliberately does NOT import `./registry.ts`
 * — importing it here would let this check "pass" by MEDIA_REGISTRY simply
 * agreeing with itself (the same circularity `src/labels/label-scan.ts`'s
 * own header names for the agent:* and pr:* families it can only find as the
 * registry's own keys, AC-9(a)) rather than checking MEDIA_REGISTRY against
 * something INDEPENDENT of it — the actual filesystem. The caller (the test
 * file) is what ties the two together, by hardcoding the expected module
 * list AND separately asserting it against `Object.keys(MEDIA_REGISTRY)`
 * where that comparison is meaningful (see that test file for exactly which
 * assertions do which).
 *
 * THE FALSIFIER (constructed, run for real, and reverted for this ticket's
 * own PR — see that PR's body for the actual output, and
 * `test/unit/media-scan.test.ts`'s own in-memory regression pin): a new
 * `src/<something>/registry.ts` created on disk with no matching
 * `MEDIA_REGISTRY` entry must make `listRegistryModules` return it, and
 * `findUnexplainedRegistryModules` must NOT exclude it — i.e. the check
 * this file's own test wires up around these two functions must go RED.
 *
 * THE BLIND SPOT THIS CHECK ITSELF HAS: see `MEDIA_SCAN_BLIND_SPOTS` below
 * (BUTCHR-254) — the enumerable source of truth. This comment stops
 * enumerating the claim in prose, on purpose: a second, independently-
 * driftable copy of the same entry is exactly the drift BUTCHR-224/
 * BUTCHR-254 exist to remove. The substantive reasoning now lives in that
 * entry's own `claim` field, not here.
 *
 * NO RUNTIME BEHAVIOUR LIVES HERE — this file only reads the filesystem to
 * report what it finds; it is never imported by any write path.
 */

export interface RegistryModuleExclusion {
  /** Repo-relative path, forward-slash separated, e.g. "src/media/registry.ts". */
  readonly path: string;
  /** Why this module is not a medium's own registry despite matching the naming convention. */
  readonly reason: string;
}

/**
 * Confirmed, named exception — `src/media/registry.ts` is the INDEX of
 * media, not itself one of the media it indexes, so it must never be read
 * as an undeclared medium's registry. Excluded explicitly, with a reason,
 * rather than special-cased away in the scan logic itself — the same
 * discipline `label-scan.ts`'s `KNOWN_NON_LABEL_LITERALS` and
 * `header-scan.ts`'s `KNOWN_NON_HEADER_LITERALS` already use for their own
 * genuine exceptions.
 */
export const KNOWN_NON_MEDIUM_REGISTRY_MODULES: readonly RegistryModuleExclusion[] = [
  {
    path: "src/media/registry.ts",
    reason: "This IS the index of media (MEDIA_REGISTRY) — it declares the four media by hand and is not itself one of them, so it must not be read as a fifth, undeclared medium's own registry.",
  },
];

/**
 * Every `src/<dir>/registry.ts` module on disk, one directory level under
 * `srcDir` only (a medium's own registry lives directly under its top-level
 * `src/` directory in every case today; this does not recurse further —
 * same non-recursive convention `src/workspace/workspace-scan.ts`'s
 * `listWorkspaceTemplateFiles` uses for `briefs/`, for the analogous
 * reason: nothing today needs more, and a deeper convention should be a
 * deliberate change to this function, not something it silently already
 * handles). Repo-relative, forward-slash separated, sorted.
 */
export function listRegistryModules(srcDir: string, repoRoot: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(srcDir)) {
    const dirPath = join(srcDir, name);
    if (!statSync(dirPath).isDirectory()) continue;
    const candidate = join(dirPath, "registry.ts");
    if (existsSync(candidate)) out.push(relative(repoRoot, candidate).split(sep).join("/"));
  }
  return out.sort();
}

/** Modules that are neither this file's own known exception nor (by construction, since the caller passes in whatever exclusions it wants checked against) anything else explained away — what the check actually flags for a human to reconcile against `MEDIA_REGISTRY`. Pure. */
export function findUnexplainedRegistryModules(
  modules: readonly string[],
  exclusions: readonly RegistryModuleExclusion[] = KNOWN_NON_MEDIUM_REGISTRY_MODULES,
): string[] {
  const excluded = new Set(exclusions.map((e) => e.path));
  return modules.filter((m) => !excluded.has(m));
}

/** The failure message — short and actionable, mirroring the other three scanners' `format*Error` functions. */
export function formatUnexpectedRegistryModulesError(found: readonly string[], expected: readonly string[]): string {
  return [
    "The set of per-medium registry modules on disk does not match src/media/registry.ts's MEDIA_REGISTRY:",
    `  found:    ${found.length ? found.join(", ") : "(none)"}`,
    `  expected: ${expected.length ? expected.join(", ") : "(none)"}`,
    "",
    "RULE: MEDIA_REGISTRY is the index of every medium this codebase declares a cached-assertion withdrawal grading for. A new src/<dir>/registry.ts appearing on disk with no matching MEDIA_REGISTRY entry means a new medium shipped without being indexed — exactly this epic's own defect, showing up again in a new medium.",
    "",
    "TO FIX: add an entry to MEDIA_REGISTRY (src/media/registry.ts) for the new medium. If the new module genuinely is NOT a medium's own registry (an index, a helper, something else that merely matches the naming convention): add it to KNOWN_NON_MEDIUM_REGISTRY_MODULES in src/media/media-scan.ts instead, with a reason.",
  ].join("\n");
}

/**
 * BUTCHR-254 (applying BUTCHR-222/BUTCHR-224's mechanism to this detector).
 * This check's own blind spot, now an enumerable value with the same
 * type-level door `HEADER_BLIND_SPOTS`/`LABEL_BLIND_SPOTS`/
 * `WORKSPACE_BLIND_SPOTS`/`FAMILY_BLIND_SPOTS` already hold their own
 * families honest with. See `test/unit/media-scan.test.ts` for why this
 * one entry is `witness: null` rather than witnessed, and
 * `src/media/blind-spot.ts` for what those mean.
 *
 * SCOPE FENCE (BUTCHR-254): do not invent a discovery mechanism that
 * appears to confirm `docTitle`'s hand-declaration is complete or current —
 * it is honestly uncheckable by this file, by construction (see the entry's
 * own `claim`). A written `noWitnessReason` naming why a human has to
 * notice is the correct, honest outcome here, matching the standard
 * `src/workspace/workspace-scan.ts`'s own two `witness: null` entries set:
 * each argues, specifically, why FABRICATING an input would be wrong, not
 * merely that one is inconvenient to build.
 */
export const MEDIA_SCAN_BLIND_SPOT_IDS = ["docTitleNotRegistryConvention"] as const;
export type MediaScanBlindSpotId = (typeof MEDIA_SCAN_BLIND_SPOT_IDS)[number];

export const MEDIA_SCAN_BLIND_SPOTS: Readonly<Record<MediaScanBlindSpotId, BlindSpotEntry>> = {
  docTitleNotRegistryConvention: {
    claim:
      "A medium whose registry is NOT a file matching the `src/<dir>/registry.ts` convention is invisible to this check by construction — it only ever lists directories one level under `srcDir` and tests each for a `registry.ts` file; a medium enforced some other way never produces a candidate path for `listRegistryModules` to find or for `findUnexplainedRegistryModules` to flag. The Confluence `[unwritten]` doc-title marker (the `docTitle` entry in `./registry.ts`'s `MEDIA_REGISTRY`) is exactly such a case TODAY, deliberately: its enforcement lives directly in `src/tools/docs.ts`'s `set_doc`/`isProvisional` logic (see that entry's own `detector: null` — `structural` needs no separate scanner at all), not in a registry module of its own, and it is declared in `MEDIA_REGISTRY` BY HAND, with nothing here confirming that declaration is complete or current. A fifth medium enforced the same way — structurally, with no registry.ts — would be equally invisible to this check, and nothing in this codebase closes that; a human has to notice, the same way a human had to notice `docTitle` needed adding here in the first place.",
    witness: null,
    noWitnessReason:
      "This is a claim about what does NOT exist on disk for a medium enforced structurally, not about a parseable input this scanner fails to read correctly — there is no fixture shape to construct that would exercise this scanner against `docTitle` specifically, because `docTitle` has no scanner module and no registry.ts of its own for `listRegistryModules` to even be pointed at. Fabricating one (e.g. writing a synthetic `src/docTitle/registry.ts` into a temp fixture and confirming it IS found) would only re-demonstrate that `listRegistryModules` finds real registry.ts files — already covered by this file's own `unscannedDirectories`-shaped tests in the other three detectors and by `test/unit/media-scan.test.ts`'s own 'the actual automatic check' describe block — never this claim's actual content, which is that a medium requiring NO registry.ts file at all (docTitle's real, deliberate shape) has nothing here to find it by. Covered instead by prose in `src/media/registry.ts`'s own `docTitle` entry (`noDetectorReason`, `blindSpots`) and by this file's own module header, verified by reading `src/tools/docs.ts`, not by this mechanism.",
  },
};
