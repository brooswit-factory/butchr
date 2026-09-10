import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { atlassianTools } from "../../src/tools/defs.js";
import type { AtlassianOps } from "../../src/tools/atlassian.js";
import { BRIEF_COVERAGE, type BriefCoverageEntry } from "../../src/tools/brief-coverage.js";

const ROOT = join(import.meta.dir, "..", "..");
const BRIEFS_DIR = join(ROOT, "briefs");

/**
 * Extraction rule, and its deliberate limit: a brief backticks a verb call
 * as a bare name (`ask_boss`) or a name plus a parenthesized arg list
 * (`shelve_worker(story, reason)`, `set_doc(body, title?)`) — so a span
 * counts ONLY when its entire trimmed backtick content is a lowercase
 * identifier of two-or-more underscore-joined segments, optionally
 * followed by "(...)". Every verb this vocabulary actually serves is
 * multi-segment snake_case; requiring the underscore is what lets this
 * rule skip the OTHER identifiers the briefs backtick in prose — bare
 * parameter names (`title`, `text`, `summary`, `description`,
 * `disposition`), commands (`gh`, `claude`, `git push`), files
 * (`CHANGELOG.md`, `ENVIRONMENT.md`, `changelog.d/`), and shout-case
 * tokens (`CHANGES_REQUESTED`) — without hand-listing any of them. It does
 * NOT verify a call's argument names or count, does not catch a verb
 * mentioned without backticks or split across a line wrap, and does not
 * understand prose like "the epic's own `new_worker`" beyond pulling out
 * `new_worker` itself. That is a narrower claim than "this brief is
 * correct" — it only catches a named verb that does not exist.
 */
function extractVerbs(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(/`([^`]+)`/g)) {
    const span = m[1]!.trim();
    const verb = span.match(/^([a-z]+(?:_[a-z]+)+)(?:\(.*\))?$/);
    if (verb) found.add(verb[1]!);
  }
  return [...found];
}

/** The real tool registry the daemon serves — never a hand-maintained second list. */
function realToolSurface(): Set<string> {
  return new Set(Object.keys(atlassianTools({} as AtlassianOps)));
}

describe("brief↔tool-surface drift guard (BUTCHR-48)", () => {
  test("every backticked verb a brief instructs an agent to call exists in the real tool registry", () => {
    const registry = realToolSurface();
    const files = readdirSync(BRIEFS_DIR).filter((f) => f.endsWith(".md"));
    expect(files.length).toBeGreaterThan(0); // fails loud if the briefs/ layout moves instead of silently checking nothing

    const missing: Array<{ file: string; verb: string }> = [];
    for (const file of files) {
      const text = readFileSync(join(BRIEFS_DIR, file), "utf8");
      for (const verb of extractVerbs(text)) {
        if (!registry.has(verb)) missing.push({ file, verb });
      }
    }
    expect(missing, missing.map((m) => `${m.file} names \`${m.verb}\`, which is not a tool the daemon serves`).join("\n")).toEqual([]);
  });

  test("the extraction rule is not vacuous — it actually names verbs in the shipped briefs", () => {
    const names = new Set<string>();
    for (const file of readdirSync(BRIEFS_DIR).filter((f) => f.endsWith(".md"))) {
      for (const verb of extractVerbs(readFileSync(join(BRIEFS_DIR, file), "utf8"))) names.add(verb);
    }
    // A handful of verbs every brief in this vocabulary is expected to teach;
    // if extraction silently stopped matching anything, this is what would notice.
    for (const verb of ["jira_get_issue", "ask_boss", "report_to_boss", "submit_to_boss", "tell_worker", "get_doc", "set_doc"]) {
      expect(names.has(verb)).toBe(true);
    }
  });
});

/** Every verb any shipped brief names, via the SAME extractVerbs rule the forward check above uses — never a second, hand-written notion of "taught". */
function allTaughtVerbs(): Set<string> {
  const names = new Set<string>();
  for (const file of readdirSync(BRIEFS_DIR).filter((f) => f.endsWith(".md"))) {
    for (const verb of extractVerbs(readFileSync(join(BRIEFS_DIR, file), "utf8"))) names.add(verb);
  }
  return names;
}

/**
 * The registry verbs with NO `BRIEF_COVERAGE` entry at all — the "never
 * neither" half of total coverage. A verb newly added to `atlassianTools()`
 * with no matching entry in `BRIEF_COVERAGE` shows up here, failing the
 * suite exactly as BUTCHR-257's DoD #1 requires ("adding a verb to the
 * registry FAILS THE SUITE until someone declares whether a brief must
 * teach it"). Because `BRIEF_COVERAGE`'s value type is a discriminated union
 * (`BriefCoverageEntry`) rather than two separate hand-written lists, "never
 * both" is enforced by construction — a single key can only ever resolve to
 * one branch of the union, so there is no second list this function needs
 * to cross-check against for an overlap.
 */
function findUncoveredVerbs(family: readonly string[], coverage: Readonly<Record<string, BriefCoverageEntry>>): string[] {
  return family.filter((v) => !(v in coverage));
}

/** The inverse gap: a `BRIEF_COVERAGE` entry naming a verb no longer in the registry — stale, same as a stale TYPE_EXCLUSIONS entry in merge-check-guard.test.ts. */
function findStaleCoverageEntries(family: readonly string[], coverage: Readonly<Record<string, BriefCoverageEntry>>): string[] {
  const familySet = new Set(family);
  return Object.keys(coverage).filter((v) => !familySet.has(v));
}

/**
 * The verbs `BRIEF_COVERAGE` declares `taught: true` for, that are NOT
 * actually named by any real brief (per `extracted`) — what makes "taught"
 * an executable, re-checked claim rather than a label nobody re-verifies. A
 * `taught: false` entry is never checked here: its whole point is that no
 * brief is expected to name it, so its absence from `extracted` proves
 * nothing wrong.
 */
function findFalselyTaughtVerbs(coverage: Readonly<Record<string, BriefCoverageEntry>>, extracted: ReadonlySet<string>): string[] {
  return Object.entries(coverage)
    .filter(([, entry]) => entry.taught)
    .map(([verb]) => verb)
    .filter((verb) => !extracted.has(verb));
}

function formatUncoveredVerbsError(verbs: readonly string[]): string {
  return [
    `${verbs.length} registry verb(s) from atlassianTools() have no BRIEF_COVERAGE entry in src/tools/brief-coverage.ts: ${verbs.join(", ")}.`,
    'TO FIX: add an entry — { taught: true } if a brief is expected to name it (and does — see the corroboration test below), or { taught: false, reason: "..." } with a real, non-empty reason otherwise.',
  ].join("\n");
}

function formatStaleCoverageError(verbs: readonly string[]): string {
  return `${verbs.length} BRIEF_COVERAGE entr${verbs.length === 1 ? "y names" : "ies name"} a verb no longer in atlassianTools(): ${verbs.join(", ")}. Remove the stale entr${verbs.length === 1 ? "y" : "ies"} from src/tools/brief-coverage.ts.`;
}

function formatFalselyTaughtError(verbs: readonly string[]): string {
  return [
    `${verbs.length} BRIEF_COVERAGE entr${verbs.length === 1 ? "y claims" : "ies claim"} { taught: true } but no briefs/*.md file actually names ${verbs.length === 1 ? "it" : "them"} (per extractVerbs): ${verbs.join(", ")}.`,
    "Either a brief needs to actually teach this verb, or the entry should become { taught: false, reason: \"...\" } — a claimed-but-unwritten teaching is exactly the silent gap this guard exists to catch.",
  ].join("\n");
}

/**
 * The converse of `findFalselyTaughtVerbs` (BUTCHR-257 review round 1): a
 * `taught: false` entry's `reason` claims "no brief teaches this" — this
 * flags any such verb a real brief NOW names (per `extracted`), so that
 * claim is re-verified too, not left as an unchecked label. See
 * brief-coverage.ts's own header for the honest limit this inherits from
 * `extractVerbs`: a bare backticked mention that WARNS against a verb
 * (`` never call `jira_transition` ``) is indistinguishable from one that
 * TEACHES it, so this can fire on a genuine non-teaching mention — a
 * deliberate trade-off, not an oversight; see that header for what to do
 * when it does. A `taught: true` entry is never checked here — it already
 * has its own corroboration test above.
 */
function findTaughtFalseButNamedVerbs(coverage: Readonly<Record<string, BriefCoverageEntry>>, extracted: ReadonlySet<string>): string[] {
  return Object.entries(coverage)
    .filter(([, entry]) => !entry.taught)
    .map(([verb]) => verb)
    .filter((verb) => extracted.has(verb));
}

function formatTaughtFalseButNamedError(verbs: readonly string[], coverage: Readonly<Record<string, BriefCoverageEntry>>): string {
  const reasonFor = (v: string) => {
    const entry = coverage[v];
    return entry && !entry.taught ? entry.reason : "(reason unavailable)";
  };
  return [
    `${verbs.length} BRIEF_COVERAGE entr${verbs.length === 1 ? "y claims" : "ies claim"} { taught: false } but a briefs/*.md file now names ${verbs.length === 1 ? "it" : "them"} (per extractVerbs): ${verbs.map((v) => `${v} (stated reason: "${reasonFor(v)}")`).join("; ")}.`,
    "Either the stated reason is now stale — verify the verb is genuinely taught and flip the entry to { taught: true } — or this is a non-teaching mention (e.g. a deprecation warning) tripping extractVerbs's known imprecision (it cannot tell teaching from mentioning); see brief-coverage.ts's header for what to do in that case. Never delete or weaken this check to silence a real, honestly-explained false positive.",
  ].join("\n");
}

// ---------------------------------------------------------------------
// BUTCHR-257: TOTAL COVERAGE OF THE DERIVED REGISTRY FAMILY, BY CONSTRUCTION
// ---------------------------------------------------------------------
// The forward test above ("every backticked verb... exists in the real tool
// registry") only ever enforced one direction. This section makes the
// REVERSE claim explicit and executable: every verb `atlassianTools()` ships
// is accounted for in `src/tools/brief-coverage.ts`'s `BRIEF_COVERAGE`,
// either as `taught: true` (verified below against the real briefs/*.md
// text) or `taught: false` with a written, non-empty reason — never neither.
// See brief-coverage.ts's own header for why this is a per-verb boolean
// declaration rather than a per-tier one, and why it does not derive its
// exclusions from alias-audit.ts's aliasTag.
//
// Deliberately NOT sharing findUnaccountedBriefTypes/TYPE_EXCLUSIONS'
// machinery from merge-check-guard.test.ts / assertion-check-guard.test.ts —
// this repo keeps near-identical guards as separate, cross-referenced files
// on purpose (see those files' own headers); this section's three small
// pure functions above are self-contained, matching that idiom, checking a
// DIFFERENT derived family (registry verbs, not brief types).
describe("BUTCHR-257: total brief-coverage accounting of the derived tool registry", () => {
  test("every verb atlassianTools() ships has exactly one BRIEF_COVERAGE entry, and BRIEF_COVERAGE names no stale verb", () => {
    const registry = [...realToolSurface()];
    expect(registry.length).toBeGreaterThan(0); // rules out "passes because the registry is empty"

    const uncovered = findUncoveredVerbs(registry, BRIEF_COVERAGE);
    if (uncovered.length > 0) throw new Error(formatUncoveredVerbsError(uncovered));
    expect(uncovered).toEqual([]);

    const stale = findStaleCoverageEntries(registry, BRIEF_COVERAGE);
    if (stale.length > 0) throw new Error(formatStaleCoverageError(stale));
    expect(stale).toEqual([]);
  });

  test("every BRIEF_COVERAGE taught:false entry carries a non-empty reason", () => {
    for (const [verb, entry] of Object.entries(BRIEF_COVERAGE)) {
      if (entry.taught) continue;
      expect(entry.reason.trim().length, `BRIEF_COVERAGE["${verb}"] has an empty/whitespace reason`).toBeGreaterThan(0);
    }
  });

  test("every BRIEF_COVERAGE taught:true entry is corroborated by a real briefs/*.md file (BUTCHR-257's executable criterion)", () => {
    const extracted = allTaughtVerbs();
    expect(extracted.size).toBeGreaterThan(0); // rules out "passes because no brief names anything"

    const falselyTaught = findFalselyTaughtVerbs(BRIEF_COVERAGE, extracted);
    if (falselyTaught.length > 0) throw new Error(formatFalselyTaughtError(falselyTaught));
    expect(falselyTaught).toEqual([]);
  });

  test("every BRIEF_COVERAGE taught:false entry's claim is re-verified too — no briefs/*.md file names it (BUTCHR-257 review round 1)", () => {
    const extracted = allTaughtVerbs();
    const taughtFalseButNamed = findTaughtFalseButNamedVerbs(BRIEF_COVERAGE, extracted);
    if (taughtFalseButNamed.length > 0) throw new Error(formatTaughtFalseButNamedError(taughtFalseButNamed, BRIEF_COVERAGE));
    expect(taughtFalseButNamed).toEqual([]);
  });

  test("non-vacuity: the four accounting functions flag an uncovered verb, a stale entry, a falsely-taught claim, and a stale taught:false claim on synthetic fixtures; accept correct fixtures; and — fed the REAL BRIEF_COVERAGE with a sentinel neither knows about — still catch it", () => {
    // Synthetic fixtures: prove the functions distinguish good from bad, not just "always empty".
    expect(findUncoveredVerbs(["ghost"], {})).toEqual(["ghost"]);
    expect(findUncoveredVerbs(["a"], { a: { taught: true } })).toEqual([]);

    expect(findStaleCoverageEntries(["a"], { a: { taught: true }, ghost: { taught: true } })).toEqual(["ghost"]);
    expect(findStaleCoverageEntries(["a"], { a: { taught: true } })).toEqual([]);

    expect(findFalselyTaughtVerbs({ x: { taught: true } }, new Set())).toEqual(["x"]);
    expect(findFalselyTaughtVerbs({ x: { taught: true } }, new Set(["x"]))).toEqual([]);
    // A taught:false entry is never flagged by findFalselyTaughtVerbs, however
    // the extraction set looks — that's findTaughtFalseButNamedVerbs's job instead.
    expect(findFalselyTaughtVerbs({ x: { taught: false, reason: "r" } }, new Set())).toEqual([]);

    expect(findTaughtFalseButNamedVerbs({ x: { taught: false, reason: "r" } }, new Set(["x"]))).toEqual(["x"]);
    expect(findTaughtFalseButNamedVerbs({ x: { taught: false, reason: "r" } }, new Set())).toEqual([]);
    // A taught:true entry is never flagged by findTaughtFalseButNamedVerbs, however
    // the extraction set looks — that's findFalselyTaughtVerbs's job instead.
    expect(findTaughtFalseButNamedVerbs({ x: { taught: true } }, new Set(["x"]))).toEqual([]);

    // Rules out "passes because BRIEF_COVERAGE silently matches everything":
    // feed the REAL declared map a family/verb it has never heard of.
    expect(findUncoveredVerbs(["__not_a_real_verb__"], BRIEF_COVERAGE)).toEqual(["__not_a_real_verb__"]);
    // And the mirror image: feed the REAL BRIEF_COVERAGE keys against a fake
    // family that doesn't contain them, proving stale-detection isn't vacuous
    // against real data either.
    expect(findStaleCoverageEntries(["__not_a_real_verb__"], BRIEF_COVERAGE).length).toBe(Object.keys(BRIEF_COVERAGE).length);
    // And the same technique for the taught:false corroboration: feed the REAL
    // BRIEF_COVERAGE an extracted set containing every taught:false verb by name —
    // proves the function isn't vacuously empty against real declared data either.
    const realTaughtFalseVerbs = Object.entries(BRIEF_COVERAGE).filter(([, e]) => !e.taught).map(([v]) => v);
    expect(realTaughtFalseVerbs.length).toBeGreaterThan(0); // rules out "passes because there are no taught:false entries to test against"
    expect(findTaughtFalseButNamedVerbs(BRIEF_COVERAGE, new Set(realTaughtFalseVerbs)).sort()).toEqual([...realTaughtFalseVerbs].sort());
  });
});
