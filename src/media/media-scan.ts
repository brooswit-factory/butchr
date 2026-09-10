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
 * BUTCHR-254 (applying BUTCHR-222/BUTCHR-224's mechanism to this detector),
 * SPLIT INTO TWO ENTRIES UNDER BUTCHR-223 AFTER REVIEW. This check's own
 * blind spots, as an enumerable value with the same type-level door
 * `HEADER_BLIND_SPOTS`/`LABEL_BLIND_SPOTS`/`WORKSPACE_BLIND_SPOTS`/
 * `FAMILY_BLIND_SPOTS` already hold their own families honest with. See
 * `test/unit/media-scan.test.ts` for the witness the first entry drives and
 * `src/media/blind-spot.ts` for what "witness" means here.
 *
 * WHY TWO ENTRIES, AND THE MISTAKE THAT MADE IT ONE — worth reading before
 * writing a `noWitnessReason` anywhere in this codebase. These were
 * originally a SINGLE entry, `docTitleNotRegistryConvention`, carrying
 * `witness: null` and an argument that no fixture could reach it. Review
 * refuted that argument by BUILDING THE WITNESS IT SAID COULD NOT EXIST,
 * in the idiom this file's siblings already use twice. The entry had
 * conflated two claims of different kinds:
 *
 *   - A MECHANICAL claim — a medium with no `registry.ts` inside the
 *     scanned root is invisible to this scan by construction. Fully
 *     witnessable, and now witnessed.
 *   - A CURRENCY claim — that the hand-maintained set of such media in
 *     `MEDIA_REGISTRY` is complete and current. Genuinely unwitnessable,
 *     because the input that would falsify it is one a human never
 *     noticed, and no fixture can construct an absence in attention.
 *
 * Bundled, the unwitnessable half's reason excused the witnessable half,
 * and the type door cannot see that: a `noWitnessReason` is prose, and
 * NOTHING in this mechanism checks whether it is TRUE. That is a real,
 * unguarded gap in the mechanism itself — the same shape as the per-list
 * coverage residue named in `blind-spot.ts`'s header, one level up: door 1
 * forces a reason to EXIST, door 2 forces a declared witness id to have
 * RUN, and neither can tell a sound reason from a plausible one. Only a
 * reader who tries to build the witness anyway can. One did.
 *
 * THE SCOPE FENCE STILL HOLDS, and the split is what respects it rather
 * than breaks it: do NOT invent a discovery mechanism that appears to
 * confirm `docTitle`'s hand-declaration is complete or current. That claim
 * keeps `witness: null` and a written reason. What is witnessed below is
 * the mechanical blindness, using a synthetic fixture that never asserts
 * anything about the real `MEDIA_REGISTRY`'s completeness.
 *
 * WHAT THIS LIST NOW BUYS THIS DETECTOR, MEASURED (BUTCHR-223): killing
 * this file's detector — making `listRegistryModules` return `[]`
 * unconditionally — fails the witness below at its `positiveControl` and
 * leaves its `silence` half green, the same 1-and-0 shape per witness that
 * `./family-scan.ts`'s six produce. BEFORE THE SPLIT this same attack
 * produced 0 failures at `positiveControl` and 0 at `silence`, because the
 * list contained no witnesses at all and `assertBlindSpotCoverage` passed
 * TRIVIALLY against a dead detector. That number is recorded here, not
 * quietly dropped, because it is the measurement that made the split
 * necessary and it is what a reader should expect to see return if the
 * witness below is ever deleted.
 *
 * WHAT REMAINS ARGUED RATHER THAN VERIFIED: the second entry, and only it.
 * A green `assertBlindSpotCoverage` says nothing about that entry beyond
 * "it declares no witness id" — do not read it as coverage.
 *
 * AND, AS EVERYWHERE ELSE UNDER THIS EPIC: this list closes "is the stated
 * blind spot true," never "is the list of stated blind spots complete." A
 * second structurally-enforced medium that nobody noticed would be absent
 * from this list and invisible to this check at the same time — the
 * doubled blindness the second entry names, and the reason that entry
 * cannot be witnessed.
 */
export const MEDIA_SCAN_BLIND_SPOT_IDS = [
  "nonRegistryConventionMediumInvisible",
  "docTitleHandDeclarationCurrency",
] as const;
export type MediaScanBlindSpotId = (typeof MEDIA_SCAN_BLIND_SPOT_IDS)[number];

export const MEDIA_SCAN_BLIND_SPOTS: Readonly<Record<MediaScanBlindSpotId, BlindSpotEntry>> = {
  nonRegistryConventionMediumInvisible: {
    claim:
      "THE MECHANICAL CLAIM, and it is witnessable: a medium whose registry is NOT a file matching the `src/<dir>/registry.ts` convention is invisible to this check by construction. `listRegistryModules` only ever lists directories one level under `srcDir` and tests each for a `registry.ts` file, so a medium enforced some other way never produces a candidate path for it to find or for `findUnexplainedRegistryModules` to flag — EVEN WHEN THAT MEDIUM'S OWN ENFORCEMENT CODE SITS INSIDE THE SCANNED ROOT. That last clause is what makes this a claim about the CONVENTION this scanner requires within a root it is already scanning, and NOT a restatement of `family-scan.ts`'s `unscannedDirectories` (which is about which root the scanner is pointed at in the first place). `docTitle` is the live instance today: its enforcement lives directly in `src/tools/docs.ts`'s `set_doc`/`isProvisional` logic (see that entry's own `detector: null` in `./registry.ts` — `structural` needs no separate scanner at all), inside `src/`, with no registry.ts of its own — and this check cannot see it.",
    witness: "media:non-registry-convention-medium",
  },
  docTitleHandDeclarationCurrency: {
    claim:
      "THE UNWITNESSABLE CLAIM, and it is a DIFFERENT KIND of claim from the one above — split out from it under BUTCHR-223 after review demonstrated that the two had been conflated, and that bundling them let a genuinely witnessable claim hide behind an unwitnessable one's `noWitnessReason`. `docTitle` is declared in `MEDIA_REGISTRY` BY HAND, and nothing anywhere confirms that declaration is COMPLETE or CURRENT. A fifth medium enforced the same way — structurally, with no registry.ts — would be equally invisible to this check AND equally absent from `MEDIA_REGISTRY`, and nothing in this codebase closes that: a human has to notice, the same way a human had to notice `docTitle` needed adding here in the first place.",
    witness: null,
    noWitnessReason:
      "This is a claim about the CURRENCY AND COMPLETENESS of a hand-maintained declaration — whether the set of structurally-enforced media a human has written into `MEDIA_REGISTRY` matches the set that actually exists. No fixture can reach it, and the reason is not inconvenience: any fixture I build would contain exactly the media I put in it, so confirming that the registry lists them would confirm only that I wrote down what I just created. The thing that could falsify this claim is a structurally-enforced medium that exists in the real codebase and that NOBODY WROTE DOWN — and a test cannot construct an artifact whose defining property is that its author never noticed it. Fabricating one would answer a question nobody is asking. This is distinct from the reason the sibling scanners give for their own unwitnessed entries (one because no test can run inside a deployed process; the other because a fabricated fixture would re-demonstrate a different blind spot under another filename); this one is unwitnessable because the input's defining property is an absence in a human's attention, not an absence on disk. Verified by reading `src/tools/docs.ts` and `./registry.ts`'s `docTitle` entry, never by this mechanism. NOTE WHAT IS NOT COVERED BY THIS REASON: the mechanical half of the original combined entry — that a medium with no registry.ts inside the scanned root is invisible here — IS witnessable, is witnessed above, and was wrongly excused by an earlier version of this reason.",
  },
};
