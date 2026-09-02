import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as ts from "typescript";
import { listTsFiles } from "../labels/label-scan.js";

/**
 * BUTCHR-172/BUTCHR-154 — the ONE source-visible sub-shape of "exists but
 * does not reach" this epic answered YES to checking (Q1): for a family
 * whose membership has a value-level anchor, no code under `src/` may
 * hand-enumerate two or more of its members in one string literal. Derive
 * the selection from the anchor, or fail.
 *
 * THE LIVE INSTANCE THIS CLOSES: `src/labels/sweep.ts`'s `SWEEP_JQL`, before
 * BUTCHR-155, was a hand-written `labels IN ("agent:working", "agent:idle",
 * "agent:blocked", "agent:none")` list that omitted `agent:stalled` — one
 * member missing from a family of five. `src/labels/registry.ts`'s
 * `LABEL_REGISTRY` entry for `agent:stalled` was, and remained, correct
 * throughout (a real withdrawal path exists); the registry could not see
 * the gap because a registry entry only ever records that a path EXISTS,
 * never that the SELECTION feeding it reaches every case (AC-9(b) in that
 * file). BUTCHR-155 fixed the instance by deriving `SWEEP_JQL` from
 * `src/labels/plan.ts`'s `ALL_AGENT_LABEL_KEYS` instead of adding one more
 * string to the hand-written list. This scanner is the machine check for
 * the SHAPE of that bug, not a re-fix of that one instance.
 *
 * THIS IS THE EXACT COMPLEMENT OF `../labels/label-scan.ts`, NOT A
 * DUPLICATE OF IT, AND NEITHER WEAKENS THE OTHER — CROSS-REFERENCED FROM
 * BOTH FILES ON PURPOSE:
 *   - `label-scan.ts` reads only WHOLE-literal labels and deliberately
 *     IGNORES a label-shaped substring embedded inside a larger literal
 *     (that file's own header: a text regex would misread a JQL string's
 *     embedded `"agent:working"` etc. as a standalone literal; the real
 *     parser correctly reads it as part of the one larger string). That
 *     discipline is what made `label-scan.ts` correctly say nothing about
 *     the old `SWEEP_JQL` — it was never that scanner's job to flag it.
 *   - THIS scanner looks ONLY at substrings inside a larger literal, and
 *     ignores everything `label-scan.ts` already covers (a literal that IS
 *     exactly one member, whole). The old `SWEEP_JQL` is precisely this
 *     scanner's target case: one string literal whose text contains four
 *     DISTINCT `agent:*` members as substrings.
 *   - Verified live, not merely argued: reconstructing the pre-BUTCHR-155
 *     `SWEEP_JQL` makes THIS scanner go red while `label-scan.ts` stays
 *     green on the identical injected text — see `test/unit/family-scan.
 *     test.ts`'s own falsifier test, and this ticket's PR body for the
 *     real, run-and-reverted construction.
 *
 * A "FAMILY" HERE IS DELIBERATELY A CALLER-SUPPLIED, PRE-COMPUTED SET OF
 * MEMBER STRINGS, NOT SOMETHING THIS FILE DERIVES ITSELF. Same discipline
 * `label-scan.ts` and `header-scan.ts` already use for `registered`/
 * `registeredTags` — this file stays leaf-pure, with zero import edge into
 * `../labels/plan.ts`, `../labels/registry.ts`, or any other medium's own
 * modules; the caller (today, `test/unit/family-scan.test.ts`) builds the
 * concrete families from `ALL_AGENT_LABEL_KEYS` (`../labels/plan.ts`) and
 * `REGISTERED_LABELS` (`../labels/registry.ts`) filtered by `isPrLabel`.
 *
 * THE TWO FAMILIES ACTUALLY CHECKED, AND A NAMED ASYMMETRY BETWEEN THEM —
 * these are the only two families in this codebase with a real SELECTION
 * consumer (a place in `src/` that has to enumerate "every member" to do
 * its job), which is the only shape this scanner can say anything about
 * (see "WHAT THIS SCANNER CANNOT SEE" below):
 *   - `agent:*` — anchored by `src/labels/plan.ts`'s `ALL_AGENT_LABEL_KEYS`,
 *     itself derived from the value-level `ALL_AGENT_LABELS` Record that
 *     ties it to the `AgentLabel` type. This IS the family `SWEEP_JQL`
 *     hand-enumerated before BUTCHR-155.
 *   - `pr:*` — `PrState` (`src/labels/plan.ts`) has NO value-level anchor
 *     equivalent to `ALL_AGENT_LABELS` — verified against that file, not
 *     inherited from this ticket's own description. It does not need one
 *     TODAY: `pr:*` is deliberately excluded from the startup sweep
 *     (`src/labels/sweep.ts`'s own comment: "pr:* is deliberately left
 *     alone: it isn't tied to active status"), so nothing in `src/` today
 *     hand-enumerates a `pr:*` selection for this scanner to have caught a
 *     regression in. This is an OBSERVED ASYMMETRY, stated with its reason,
 *     not a gap this ticket fixes — BUTCHR-154's scope fence forbids
 *     touching the sweep/reconcile machinery beyond what a check requires,
 *     and this check does not require `PrState` to grow one. The concrete
 *     `pr:*` family membership this scanner is still checked against comes
 *     from `REGISTERED_LABELS` (`src/labels/registry.ts`) filtered to the
 *     `pr:` prefix — DERIVED (that Set is itself forced complete by
 *     `LABEL_REGISTRY`'s own `Record<RegisteredLabel, ...>` type door), not
 *     hand-typed, even though `PrState` itself has no anchor of its own.
 *
 * WHAT THIS SCANNER CANNOT SEE (write it down; a scanner with a silent
 * bypass is the exact failure this whole rule exists to catch) — ALL FOUR
 * of the following would make this check PASS WHILE THE BUG IT EXISTS TO
 * CATCH IS STILL PRESENT, and none of them is hypothetical busywork; each
 * is a real, available way to write the same defect this scanner is meant
 * to close:
 *   - A selection built from SUFFIXES rather than one literal, e.g.
 *     `["working","idle","blocked","none"].map(l => AGENT_PREFIX + l)` —
 *     no single string literal anywhere contains two family members as
 *     substrings, so there is nothing for a literal-substring scan to find,
 *     even though the selection is exactly as incomplete as the original
 *     bug.
 *   - A selection that is complete IN SOURCE but filtered again at RUNTIME
 *     (e.g. a complete literal list immediately `.filter()`-ed down before
 *     use) — the source-level literal this scanner reads would be
 *     unimpeachable while the actual runtime selection still drops a
 *     member.
 *   - A family with NO value-level anchor at all — this scanner has
 *     nothing to check membership against, so a hand-enumerated selection
 *     over such a family is invisible to it by construction (this is
 *     exactly `pr:*`'s situation today, mitigated only because
 *     `REGISTERED_LABELS` happens to provide a derived stand-in — a family
 *     with neither its own anchor NOR a registry to borrow one from has no
 *     coverage here at all).
 *   - A family enumerated across SEVERAL SEPARATE string literals rather
 *     than one (e.g. `if (l === "agent:working" || l === "agent:idle") ...`
 *     as two separate two-member comparisons, or four single-member
 *     literals used one at a time) — each individual literal contains at
 *     most ONE family member, so no literal ever crosses this scanner's
 *     "two or more DISTINCT members in one literal" threshold, even though
 *     the selection they jointly form can still be incomplete.
 *
 * SEPARATELY, THIS SCANNER'S CORPUS ITSELF IS BOUNDED, THE SAME WAY
 * `label-scan.ts`'s/`header-scan.ts`'s IS — a scope limit, not one more
 * shape of selection drift, though a real hand-enumerated collision sitting
 * inside either would be exactly as invisible as one of the four above:
 *   - `test/` and `scripts/` are unscanned: fixtures use family-shaped
 *     literals freely by design, and `scripts/` is operator tooling, not
 *     the write path.
 *   - Non-`.ts` files, and anything generated under `src/` (none checked in
 *     today; re-examine this assumption if that changes).
 *
 * SO THIS SCANNER ASSERTS REACH FOR EXACTLY ONE SHAPE OF SELECTION DRIFT —
 * TWO OR MORE DISTINCT FAMILY MEMBERS HAND-ENUMERATED TOGETHER INSIDE ONE
 * SOURCE-LEVEL STRING LITERAL — NOT REACH IN GENERAL. Describing it as more
 * than that anywhere (a header, a PR body, a ticket comment) is exactly the
 * overclaim this whole epic exists to catch: a coverage claim built on a
 * literal scan, shipped under the epic about cached assertions outliving
 * their truth. See `src/labels/registry.ts`'s AC-9(a)/AC-9(b) for the
 * standard this file is held to.
 */

export interface Family {
  /** A short, human-legible name for error messages, e.g. "agent:*". Not itself matched against anything. */
  readonly name: string;
  /** Every full member string of this family, e.g. "agent:working". Caller-supplied and derived from the family's own value-level anchor — see this file's header. */
  readonly members: ReadonlySet<string>;
}

export interface FamilyCollisionHit {
  /** Repo-relative path, forward-slash separated. */
  readonly file: string;
  /** 1-indexed source line. */
  readonly line: number;
  /** The offending family's name. */
  readonly family: string;
  /** Every distinct member of that family found as a substring of this one literal, sorted. */
  readonly matchedMembers: readonly string[];
  /** The literal's full text (truncated by the caller's formatter if long), for a legible failure message. */
  readonly text: string;
}

/**
 * Find every string literal in one file's source that contains two or more
 * DISTINCT members of any one registered family as substrings. Pure — no
 * I/O. Uses the real TypeScript parser, same as `label-scan.ts`/
 * `header-scan.ts` and for the identical reason: a family-member-shaped
 * substring inside a larger, unrelated string (prose discussing a label, a
 * comment) must be read as part of that one string, and only a real parser
 * (asking a string literal node for its own already-unescaped `.text`)
 * makes that distinction reliably — a text regex over raw source does not.
 */
export function findFamilyCollisions(file: string, sourceText: string, families: readonly Family[]): FamilyCollisionHit[] {
  const sourceFile = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, /* setParentNodes */ false);
  const hits: FamilyCollisionHit[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node)) {
      for (const family of families) {
        const matched = [...family.members].filter((member) => node.text.includes(member)).sort();
        if (matched.length >= 2) {
          const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
          hits.push({ file, line: line + 1, family: family.name, matchedMembers: matched, text: node.text });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return hits;
}

export interface FamilyCollisionExclusion {
  /** Repo-relative path, forward-slash separated. */
  readonly file: string;
  /** The family name this exclusion covers (must match a Family.name passed to the scan). */
  readonly family: string;
  /** The exact matched-members set this exclusion covers, as a sorted, comma-joined string (matches FamilyCollisionHit.matchedMembers.join(",") after sorting) — scoped this tightly so a NEW, different collision in the same file is never silently swallowed by an old exclusion. */
  readonly matchedMembersKey: string;
  /** Why this hit is NOT a hand-enumerated selection despite matching the pattern. */
  readonly reason: string;
}

/**
 * Confirmed, named exceptions — a literal genuinely contains two or more
 * family members as substrings but is NOT a hand-enumerated selection over
 * that family (e.g. prose incidentally mentioning two label names in one
 * sentence-shaped string). Empty today: this scan was run for real against
 * this repo's src/ at HEAD, with zero exclusions needed — see
 * `test/unit/family-scan.test.ts`'s own "the actual automatic check"
 * describe block for the live re-run of that claim, and this ticket's PR
 * body for the same result reported as evidence. Adding an entry here MUST
 * be accompanied by reading the site and confirming it genuinely is not a
 * selection, never used to launder a real finding — same discipline as
 * `label-scan.ts`'s `KNOWN_NON_LABEL_LITERALS`.
 */
export const KNOWN_FAMILY_COLLISION_EXCLUSIONS: readonly FamilyCollisionExclusion[] = [];

const exclusionKey = (file: string, family: string, matchedMembersKey: string): string => `${file} ${family} ${matchedMembersKey}`;
const matchedMembersKeyOf = (matched: readonly string[]): string => [...matched].sort().join(",");

/** Hits that are neither a hand-enumerated selection this rule wants to catch nor already excluded — what the check actually fails on. Pure. */
export function findUnexplainedFamilyCollisions(
  hits: readonly FamilyCollisionHit[],
  exclusions: readonly FamilyCollisionExclusion[] = KNOWN_FAMILY_COLLISION_EXCLUSIONS,
): FamilyCollisionHit[] {
  const excluded = new Set(exclusions.map((e) => exclusionKey(e.file, e.family, e.matchedMembersKey)));
  return hits.filter((h) => !excluded.has(exclusionKey(h.file, h.family, matchedMembersKeyOf(h.matchedMembers))));
}

/**
 * The failure message. Written for a reader who has never heard of this
 * epic, same standard as `label-scan.ts`'s `formatUnregisteredLabelError`.
 */
export function formatFamilyCollisionError(hits: readonly FamilyCollisionHit[]): string {
  const lines = hits.map((h) => `  ${h.file}:${h.line}  [${h.family}] ${h.matchedMembers.join(", ")}  in "${h.text.length > 100 ? `${h.text.slice(0, 100)}…` : h.text}"`);
  return [
    `${hits.length} string literal(s) under src/ hand-enumerate two or more members of a family whose membership is derivable elsewhere:`,
    ...lines,
    "",
    "RULE: for a family whose membership has a value-level anchor (e.g. src/labels/plan.ts's ALL_AGENT_LABEL_KEYS for agent:*), no code under src/ may hand-enumerate two or more of its members in one string literal — derive the selection from the anchor instead. This is exactly the shape of bug that once let agent:stalled go missing from src/labels/sweep.ts's SWEEP_JQL: a registry entry can say a withdrawal path exists without that path's selection ever reaching every member of its family.",
    "",
    "TO FIX: build the literal from the family's own anchor (e.g. ALL_AGENT_LABEL_KEYS.map(...) or a .join(...) over it) instead of writing the member strings out by hand.",
    "",
    "If this literal genuinely is NOT a hand-enumerated selection (e.g. prose that incidentally names two members in one sentence): do not weaken this pattern. Add a named entry to KNOWN_FAMILY_COLLISION_EXCLUSIONS in src/media/family-scan.ts instead, with a reason.",
  ].join("\n");
}

/** Scan every `.ts` file under `srcDir` (repo-relative, reported against `repoRoot`) for family collisions. Reuses `label-scan.ts`'s own file-listing (a generic src/ walk, not label-specific logic) rather than duplicating it — `header-scan.ts` already sets this precedent. */
export function scanDirForFamilyCollisions(srcDir: string, repoRoot: string, families: readonly Family[]): FamilyCollisionHit[] {
  const hits: FamilyCollisionHit[] = [];
  for (const file of listTsFiles(srcDir, repoRoot)) {
    hits.push(...findFamilyCollisions(file, readFileSync(join(repoRoot, file), "utf8"), families));
  }
  return hits;
}
