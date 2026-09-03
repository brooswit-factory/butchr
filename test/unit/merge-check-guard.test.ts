import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildWorkspace, knownBriefTypes } from "../../src/agents/workspace.js";
import { prReviewStateNudge } from "../../src/agents/pr-nudge.js";
import { atlassianTools } from "../../src/tools/defs.js";
import type { AtlassianOps } from "../../src/tools/atlassian.js";

const ROOT = join(import.meta.dir, "..", "..");
const DOCS_DIR = join(ROOT, "docs");

/**
 * BUTCHR-56: agent-facing instruction text teaching the merge check is
 * authored in at least four unrelated places (briefs, tool descriptions,
 * docs, and the daemon's own PR-state-change nudge), and until this file
 * only briefs had a guard (test/unit/workspace.test.ts). A correction
 * applied to one channel could silently leave the others teaching the old,
 * defective `reviewDecision`+`headRefOid` check — which cannot detect a
 * stale approval: `headRefOid` is the PR's CURRENT head so it keeps
 * matching local HEAD after every push, and `reviewDecision` stays APPROVED
 * because this repo doesn't dismiss reviews on push. Both signals survive
 * exactly the event they exist to catch.
 *
 * Each channel below is read from what is actually DELIVERED to an agent,
 * not from a copy that resembles it: BRIEFS are read from the files
 * `buildWorkspace()` actually writes to a real workspace directory (CLAUDE.md
 * AND brief.md — not just the brief.md template, since CLAUDE.md is the
 * first instruction file an agent reads and is a real, separate delivered
 * channel); tool descriptions come from the real `atlassianTools()`
 * registry an agent's tool list is built from; docs/*.md are read as files,
 * the way a reader reads them; and the daemon nudge is reached through
 * `prReviewStateNudge`, a function `src/daemon/index.ts` itself calls to
 * build the message it pushes — not a regex over the daemon's source text,
 * which would only prove a template resembling what ships, not what ships.
 *
 * WHAT THIS FILE CANNOT PROVE: it asserts what the TEXT SAYS. It says
 * nothing about whether `gh pr view` actually returns a `reviews[].commit.oid`
 * field shaped the way the text claims, or whether the jq in the briefs is
 * correct — that's a runtime property, not a text-content one, and this is
 * a unit test over strings.
 *
 * COVERAGE: covered channels are the four functions below (briefChannels,
 * toolDescriptionChannels, docChannels, nudgeChannels). Everything NOT
 * covered is enumerated in EXCLUSIONS, with a reason, so the list is
 * auditable by someone who wasn't here rather than living only as prose.
 */
const EXCLUSIONS: ReadonlyArray<{ path: string; reason: string }> = [
  { path: "CHANGELOG.md", reason: "the historical record of this defect being fixed, not an instruction to an agent" },
  { path: "changelog.d/*.md", reason: "same as CHANGELOG.md — per-PR fragments are history, not instruction" },
  { path: "test/unit/merge-check-guard.test.ts (this file)", reason: "names the forbidden pair in its own assertions/comments/mutation notes, not as instruction" },
  { path: "test/unit/workspace.test.ts", reason: "names the forbidden pair in a negative brief assertion/comment, not as instruction" },
  { path: "src/labels/pr.ts", reason: "code comment documents the GitHub REST API's own reviewDecision semantics, not an agent instruction" },
  { path: "Confluence glossary (ASSIST space)", reason: "named upstream as a fifth instruction channel; lives outside this repo, invisible to a unit test" },
  { path: "briefs/task.md (`[review] APPROVED ... @ <sha>` mentions)", reason: "BUTCHR-165: author-side — text a task READS when it wakes to decide whether to merge, never an instruction to EMIT a `[review]` line. A task has no worker below it to review, so unlike epic/story/project it never sends one down." },
];

interface Channel { label: string; text: string }

// BRIEFS — the actual files `buildWorkspace()` writes into a real agent
// workspace (CLAUDE.md + the interpolated brief.md), for every issue type
// `briefFor()` maps explicitly PLUS one representative ("Bug") of the
// DEFAULT fallback every unmapped type gets. The mapped types are DERIVED
// from `knownBriefTypes()` (workspace.ts's own table), not hand-copied here
// as a literal list — BUTCHR-149: a hardcoded four-element array
// (["Epic","Story","Task","Bug"]) is exactly how `briefs/project.md` went
// unbuilt, unread, and unasserted-against when the `project` tier was added
// to that table but not to this one. "Bug" stays a literal on purpose: it
// isn't a tracked key, it's a stand-in for "any type nobody mapped", so
// there is nothing for it to derive from. Reading the files
// buildWorkspace() writes, rather than the brief.md template alone, is what
// makes this channel catch CLAUDE.md too — the first instruction file an
// agent reads, and a real, separate delivered artifact from brief.md.
function briefChannels(): Channel[] {
  const root = mkdtempSync(join(tmpdir(), "merge-check-guard-"));
  const prevEnv = process.env.BUTCHR_WORKSPACES;
  process.env.BUTCHR_WORKSPACES = root;
  try {
    const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
    const types = [...knownBriefTypes().map(capitalize), "Bug"];
    return types.flatMap((t) => {
      const dir = buildWorkspace({ key: `MCG-${t}`, issuetype: t, summary: "verify merge-check coverage", parent: null }, "http://localhost:7717/mcp");
      return [
        { label: `brief:${t}:CLAUDE.md`, text: readFileSync(join(dir, "CLAUDE.md"), "utf8") },
        { label: `brief:${t}:brief.md`, text: readFileSync(join(dir, "brief.md"), "utf8") },
      ];
    });
  } finally {
    if (prevEnv === undefined) delete process.env.BUTCHR_WORKSPACES;
    else process.env.BUTCHR_WORKSPACES = prevEnv;
  }
}

// TOOL DESCRIPTIONS — the text an agent literally reads in its tool list,
// from the real registry (never a hand-maintained second list of it).
function toolDescriptionChannels(): Channel[] {
  const tools = atlassianTools({} as AtlassianOps);
  return Object.entries(tools).map(([name, def]) => ({ label: `tool:${name}`, text: (def as { description: string }).description }));
}

// DOCS — docs/*.md read as files, tolerating a moved/missing directory so
// the non-vacuity assertion below is what fails, not an uncaught readdir
// exception (see the mutation-6 note in the PR description).
function docChannels(): Channel[] {
  if (!existsSync(DOCS_DIR)) return [];
  return readdirSync(DOCS_DIR)
    .filter((f) => f.endsWith(".md"))
    .map((f) => ({ label: `docs/${f}`, text: readFileSync(join(DOCS_DIR, f), "utf8") }));
}

// DAEMON NUDGE — the actual rendered string from the exported function
// src/daemon/index.ts calls, across the transitions the nudge fires for.
function nudgeChannels(): Channel[] {
  return [
    { label: "nudge:none→open", text: prReviewStateNudge("KAN-1", null, "open") },
    { label: "nudge:open→approved", text: prReviewStateNudge("KAN-1", "open", "approved") },
    { label: "nudge:approved→changes_requested", text: prReviewStateNudge("KAN-1", "approved", "changes_requested") },
    { label: "nudge:changes_requested→merged", text: prReviewStateNudge("KAN-1", "changes_requested", "merged") },
  ];
}

function allChannels(): Channel[] {
  return [...briefChannels(), ...toolDescriptionChannels(), ...docChannels(), ...nudgeChannels()];
}

// The literal command text an agent would type. A comma-joined pair, either
// order, with arbitrary whitespace around the comma (so "reviewDecision,
// headRefOid" — the wrapped form a line-fill could produce — still matches).
// Deliberately NOT stripped of all whitespace / matched loosely across the
// whole string: the two field names legitimately appear far apart in
// correct prose (e.g. briefs explaining why `headRefOid` alone doesn't
// work), and a document-wide "both names appear somewhere" test would
// misfire on exactly the correct explanation of the bug. This sweeps EVERY
// covered channel (briefs, tools, ALL of docs/*.md, the nudge) — broad is
// right for a negative assertion: a new doc must never reintroduce the pair
// either, even one that has nothing to do with merging.
const FORBIDDEN_PAIR = /reviewDecision\s*,\s*headRefOid|headRefOid\s*,\s*reviewDecision/;

// Hand-wrapped markdown prose in this repo hard-wraps at ~80 columns, which
// can split "last decisive review" across a line break — whitespace-
// (including newline-) tolerant on purpose, so a wrap doesn't produce a
// false negative for a phrase that IS there.
const LAST_DECISIVE_REVIEW = /last\s+decisive\s+review/i;

// Channels required to carry the merge check, named EXPLICITLY rather than
// inferred by scanning content for a word like "merge" (an inferred rule
// would just rebuild the bare-vs-namespaced trap in a new shape). This is
// the positive half of the guard, so it must be narrower than the negative
// sweep above: a channel with nothing to do with merging (an ordinary
// unrelated doc, say) must never be required to teach this check, or the
// guard reddens on correct, unrelated work and gets weakened out of spite.
const MERGE_INSTRUCTING_BRIEFS = ["brief:Story:brief.md", "brief:Task:brief.md"];
const MERGE_INSTRUCTING_DOCS = ["agent-model.md"];

// BUTCHR-74, refined by BUTCHR-138 (docs/review-commit-immutability.md —
// read that document for the full measurement rather than this comment):
// `reviews[].commit.oid` is not the immutable fallback the text used to
// claim it was — no structured API surface is (REST-list, REST-by-id and
// GraphQL all move together). BUTCHR-138's controlled arms narrowed this
// past BUTCHR-74's original #135/#136 observation: a plain commit never
// moves it; a CLEAN merge (no content beyond the auto-merge of its
// parents) moves it forward to match the new head, asynchronously
// (~30-56s observed); a merge carrying content of its own does NOT move
// it. Only a review's own written-at-submission body text is immutable —
// this check still reads the LAST decisive review's structured field, so
// it inherits that field's non-immutability regardless of which case
// applies. Every merge-instructing channel must say so (without asserting
// a rewrite mechanism — six were proposed and killed; see the doc) and
// must not describe the check as sufficient: a mismatch is a real signal,
// a match is the narrower claim that the branch's own contribution didn't
// change, not that nothing unreviewed landed (a clean base-merge imports
// `main`'s own, separately-reviewed content).
//
// Requires TWO independent short markers to both be present, anywhere in
// the channel, rather than one token or one long sentence:
//   - "base-merge" — names the hazard.
//   - "not sufficient" — denies sufficiency; this is the actual point of
//     the caveat, not just its topic.
// One token alone is not discriminating: a single "base-merge" anchor was
// tried first and passed review with a real hole — briefs/story.md and
// briefs/task.md each also carry an OPERATIONAL sentence this same ticket
// added ("confirm you have not taken a base-merge since the approval"),
// which still contains the word "base-merge" after the caveat sentence
// itself is deleted, so a bare-token assertion stayed green with the
// caveat gone. "not sufficient" appears ONLY inside the caveat sentence in
// every covered channel (verified when this was written), so requiring it
// too closes that hole: deleting the caveat removes "not sufficient" from
// the channel even though "base-merge" survives via the operational
// sentence. Two short, independently-reworded-resistant markers, not one
// long brittle phrase — a maintainer rewording either sentence while
// keeping its meaning (and thus keeping both markers) leaves this green;
// only an actual deletion of the sufficiency claim turns it red.
//
// FORWARDING ADDRESS: this caveat is true only because the check has this
// hole. BUTCHR-73 is filing the remedy for the base-merge hole itself. If
// BUTCHR-73 (or any later ticket) closes that hole, this caveat becomes
// FALSE, this assertion SHOULD go red, and that red is correct — it is
// telling you the pinned text must be updated or removed, not that the test
// is broken. Do not delete this assertion to get green; fix the text.
const BASE_MERGE_CAVEAT = /(?=[\s\S]*base-merge)(?=[\s\S]*not sufficient)/i;

// BUTCHR-149 (project.md) + BUTCHR-165 (epic.md, story.md): all three are
// pure REVIEWERS of the tier below them (project reviews epic's PR, epic
// reviews story's PR, story reviews task's PR) — none of the three merges a
// PR of its own, so none belongs in MERGE_INSTRUCTING_BRIEFS (that list
// asserts the AUTHOR-side stale-approval check: reviews[].commit.oid,
// last-decisive ordering, base-merge caveat). What each of these three DOES
// carry, and must keep carrying, is a narrower reviewer-side instruction:
// the `[review] APPROVED|CHANGES_REQUESTED <pr-url> @ <sha>` line it sends
// DOWN to its worker, with the sha sourced correctly. This is not
// hypothetical: while delivering BUTCHR-135's correction to this exact
// protocol text, briefs/project.md was the one channel that did NOT receive
// the transcription caveat that briefs/story.md and briefs/epic.md received
// in the same change (caveat-phrase counts at that point: task 2, story 4,
// epic 2, project 0) — and no test caught it, because until BUTCHR-149
// nothing read this file at all, and until now nothing asserted the SAME
// instruction in epic.md/story.md either, even though both already carried
// it correctly. briefs/task.md is deliberately NOT here — see EXCLUSIONS:
// it only ever READS a `[review]` line (author-side), it never emits one,
// because a task has no worker below it to review.
const REVIEW_LINE_INSTRUCTING_BRIEFS = ["brief:Project:brief.md", "brief:Epic:brief.md", "brief:Story:brief.md"];

// ---------------------------------------------------------------------
// BUTCHR-225: TOTAL COVERAGE OF THE DERIVED brief FAMILY, BY CONSTRUCTION
// ---------------------------------------------------------------------
// MERGE_INSTRUCTING_BRIEFS and REVIEW_LINE_INSTRUCTING_BRIEFS above are
// hand-written, and until this ticket were tied to nothing: adding a new
// entry to workspace.ts's BRIEF_BY_TYPE table (see knownBriefTypes()) ships
// a brand-new agent-facing brief that neither list ever mentions, and
// nothing here failed. This section makes that state impossible: every
// member of the DERIVED family (knownBriefTypes()) must be accounted for
// in exactly one of — "asserted" (present in the UNION of the two positive
// lists above; a type naming two DIFFERENT instructional claims in both
// lists, e.g. "story", is still just "asserted" once, not a conflict), or
// "excluded" (a written, non-empty reason in TYPE_EXCLUSIONS below). Never
// both, never neither.
//
// Deliberately NOT shared with assertion-check-guard.test.ts's own,
// near-identical copy of this section — see this repo's own precedent for
// keeping label-scan.ts/header-scan.ts/workspace-scan.ts as separate,
// cross-referenced files rather than one shared abstraction (their own
// headers say so). Each guard's accounting is a property of THAT guard's
// own hand-written lists; a shared helper would blur which file's list
// actually went stale. See assertion-check-guard.test.ts's matching
// section for the sibling.
//
// briefs/CLAUDE.md and briefs/default.md are deliberately OUT OF SCOPE for
// this accounting: both are shipped, agent-facing files, but neither is a
// member of knownBriefTypes() (CLAUDE.md ships alongside every type;
// DEFAULT is the "nothing more specific applies" fallback —
// knownBriefTypes()'s own doc comment says so explicitly). An exclusion
// entry naming "default" here would itself be flagged STALE by the test
// below, which is the discipline working as intended, not a bug: don't add
// one. (briefChannels() above separately builds a literal "Bug" channel as
// a stand-in for "any unmapped type" — that's a DEFAULT-fallback probe for
// the existing merge-check/review-line assertions, not a member of the
// derived family this section accounts for.)

interface TypeExclusion { readonly type: string; readonly reason: string }

// Empty today: every member of the derived family is already covered by
// the UNION of MERGE_INSTRUCTING_BRIEFS (task, story) and
// REVIEW_LINE_INSTRUCTING_BRIEFS (project, epic, story) above — together,
// epic/story/task/project, i.e. all four of knownBriefTypes(). Left as an
// explicit, typed, empty list — same precedent
// test/unit/family-scan.test.ts's own KNOWN_FAMILY_COLLISION_EXCLUSIONS
// sets for an empty-but-checked list — rather than omitted, so the
// "every exclusion still matches a real family member" test below has
// something to iterate that isn't vacuously true by omission.
const TYPE_EXCLUSIONS: readonly TypeExclusion[] = [];

const labelToType = (label: string): string => {
  const m = /^brief:([A-Za-z]+):brief\.md$/.exec(label);
  if (!m) throw new Error(`not a brief:<Type>:brief.md label: ${label}`);
  return m[1]!.toLowerCase();
};

const ASSERTED_TYPES: ReadonlySet<string> = new Set([...MERGE_INSTRUCTING_BRIEFS, ...REVIEW_LINE_INSTRUCTING_BRIEFS].map(labelToType));

/**
 * The members of `family` accounted for in neither, or in BOTH, of
 * `asserted`/`exclusions` — what the coverage test below actually fails
 * on. Pure. See assertion-check-guard.test.ts's near-identical copy for
 * the cross-reference this file deliberately does not import.
 */
function findUnaccountedBriefTypes(family: readonly string[], asserted: ReadonlySet<string>, exclusions: readonly TypeExclusion[]): string[] {
  const excludedTypes = new Set(exclusions.map((e) => e.type));
  return family.filter((t) => asserted.has(t) === excludedTypes.has(t));
}

function formatUnaccountedBriefTypeError(types: readonly string[]): string {
  return [
    `${types.length} brief type(s) from knownBriefTypes() are not accounted for exactly once in merge-check-guard.test.ts: ${types.join(", ")}.`,
    "Every member of the derived brief family must appear in exactly one of: a positive-assertion list (MERGE_INSTRUCTING_BRIEFS / REVIEW_LINE_INSTRUCTING_BRIEFS) above, or TYPE_EXCLUSIONS below with a written reason — never both, never neither.",
    "TO FIX: add the type to whichever positive-assertion list actually applies (if the brief genuinely carries that instruction), OR add a { type, reason } entry to TYPE_EXCLUSIONS explaining why it doesn't.",
  ].join("\n");
}

// The `[review]` line format itself — BOTH verdicts required as two
// SEPARATE patterns, not one regex that only happens to match the APPROVED
// half (BUTCHR-149 round 1: deleting the CHANGES_REQUESTED clause from
// briefs/project.md left a single combined-looking assertion green, because
// it never actually required the reject half). Each is whitespace-tolerant
// across the line wrap this repo's ~80-column hand-wrapping produces
// between "@" and the sha placeholder (see briefs/project.md's own
// rendering of the APPROVED line, which wraps; CHANGES_REQUESTED does not
// today, but nothing here assumes it won't).
//
// BUTCHR-165, measured directly rather than assumed: briefs/project.md
// writes the placeholder as `<sha>`, while briefs/epic.md and
// briefs/story.md both write it as `<full 40-char sha>` — two genuinely
// different, both-correct renderings of the same instruction (project.md's
// paragraph doesn't carry a "40-char" figure elsewhere to draw the longer
// form from; epic.md/story.md's does). SHA_PLACEHOLDER is an ALTERNATION of
// exactly those two known-shipped literal strings — not a wildcard and not
// "any token after @" — so this stays exactly as strict as the
// single-string version it replaces for every channel it already covered,
// while also accepting the one other literal string this repo actually
// ships. A regex loosened to `@\s*\S+` or similar would defeat the point of
// this whole file (it would accept "@ headRefOid" or "@ nothing-in-
// particular"); an alternation of two named, verified-shipped strings does
// not.
const SHA_PLACEHOLDER = "(?:<sha>|<full 40-char sha>)";
const REVIEW_LINE_APPROVED = new RegExp(String.raw`\[review\]\s+APPROVED\s+<pr-url>\s+@\s*${SHA_PLACEHOLDER}`);
const REVIEW_LINE_CHANGES_REQUESTED = new RegExp(String.raw`\[review\]\s+CHANGES_REQUESTED\s+<pr-url>\s+@\s*${SHA_PLACEHOLDER}`);

// Mirrors BASE_MERGE_CAVEAT's two-independent-marker design, for the same
// reason: a maintainer rewording either sentence while keeping its meaning
// should stay green, and only an actual deletion of the caveat should go
// red. "pasted verbatim" names the required sourcing (from `gh pr view
// --json headRefOid`); "retyped by hand" denies the alternative — this is
// the actual point of the caveat, not just its topic. Both phrases are
// present in briefs/project.md today (verified when this was written).
const TRANSCRIPTION_CAVEAT = /(?=[\s\S]*pasted verbatim)(?=[\s\S]*retyped by hand)/i;

// BUTCHR-165, found by mutation-testing this exact assertion against
// briefs/story.md (see the PR description): checking TRANSCRIPTION_CAVEAT
// against the WHOLE channel text is vacuous for story.md specifically.
// Unlike project.md and epic.md — each of which carries "pasted verbatim"
// and "retyped by hand" exactly ONCE — briefs/story.md carries the pair
// TWICE: once in the reviewer-side paragraph this test means to guard (the
// one directly following the `[review] APPROVED <pr-url> ...` line), and
// once more, unrelated, ~4.6KB later in story.md's OWN author-side
// "verify the LAST decisive review" reading instructions (the same text
// task.md carries, since a story is also a worker that reads a `[review]`
// line sent down to it). Deleting only the reviewer-side caveat sentence
// left the whole-channel regex green, because the distant author-side
// occurrence of the identical two phrases still satisfied it — measured
// directly: `perl -0pi -e 's/retyped by hand/X/' briefs/story.md` (first
// occurrence only) produced NO test failure until this fix. A window
// anchored at the `[review] APPROVED <pr-url>` match and extending 400
// characters forward comfortably contains the near, reviewer-side caveat
// (measured today: "pasted verbatim" and "retyped by hand" sit 151-292
// characters after that match in all three of project.md/epic.md/story.md)
// while excluding story.md's distant, unrelated author-side occurrence
// (measured today: ~4.6KB after that same match) — so this scoping fixes
// story.md's vacuity without changing behavior for project.md or epic.md,
// which only ever had the one, near occurrence anyway.
function textNear(text: string, marker: RegExp, span: number): string {
  const m = marker.exec(text);
  if (!m) return "";
  return text.slice(m.index, m.index + span);
}

describe("merge-check instruction channels (BUTCHR-56)", () => {
  test("non-vacuity: every channel group actually resolves to content, and it's the content we expect", () => {
    const briefs = briefChannels();
    const tools = toolDescriptionChannels();
    const docs = docChannels();
    const nudges = nudgeChannels();

    expect(briefs.length).toBeGreaterThan(0);
    expect(tools.length).toBeGreaterThan(0);
    expect(docs.length).toBeGreaterThan(0);
    expect(nudges.length).toBeGreaterThan(0);

    expect(briefs.some((c) => c.label.endsWith(":brief.md") && c.text.includes("one unit of work"))).toBe(true);
    expect(briefs.some((c) => c.label.endsWith(":CLAUDE.md") && c.text.includes("Your entire assignment is in"))).toBe(true);
    expect(tools.some((c) => c.text.includes("Read a Jira issue"))).toBe(true);
    expect(docs.some((c) => c.text.includes("The agent model"))).toBe(true);
    expect(nudges.every((c) => c.text.includes("your PR's review state changed"))).toBe(true);

    // The exclusion list itself is non-vacuous, and actually excludes
    // something the covered channels above would otherwise sweep in.
    expect(EXCLUSIONS.length).toBeGreaterThan(0);
    expect(EXCLUSIONS.some((e) => e.path === "CHANGELOG.md")).toBe(true);
  });

  test("the forbidden reviewDecision+headRefOid pair appears in no covered channel", () => {
    const hits = allChannels().filter((c) => FORBIDDEN_PAIR.test(c.text));
    expect(hits.map((c) => c.label)).toEqual([]);
  });

  // A pure negative guard permits deleting the instruction entirely, so
  // every channel EXPLICITLY named as merge-instructing must also name the
  // field that actually matters (`reviews[].commit.oid`) and the
  // last-decisive-review ordering — not just avoid the old pair. Verified by
  // mutation: stripping `reviews[].commit.oid` from the rendered nudge (not
  // its source comment) turns this assertion red — see the PR description's
  // "direction 2" mutation.
  test("every channel explicitly named as merge-instructing names reviews[].commit.oid, the last-decisive ordering, and the base-merge caveat (BUTCHR-74)", () => {
    const briefs = briefChannels().filter((c) => MERGE_INSTRUCTING_BRIEFS.includes(c.label));
    expect(briefs.length).toBe(MERGE_INSTRUCTING_BRIEFS.length); // the explicit list actually matched something

    const docs = docChannels().filter((c) => MERGE_INSTRUCTING_DOCS.includes(c.label.replace(/^docs\//, "")));
    expect(docs.length).toBe(MERGE_INSTRUCTING_DOCS.length);

    const nudges = nudgeChannels();

    for (const c of [...briefs, ...docs, ...nudges]) {
      expect(c.text, `${c.label} should name reviews[].commit.oid`).toContain("reviews[].commit.oid");
      expect(c.text, `${c.label} should name the last-decisive ordering`).toMatch(LAST_DECISIVE_REVIEW);
      // See BASE_MERGE_CAVEAT above for the forwarding address to BUTCHR-73:
      // this assertion is EXPECTED to go red once that hole is closed.
      expect(c.text, `${c.label} should carry the base-merge caveat (BUTCHR-74)`).toMatch(BASE_MERGE_CAVEAT);
    }
  });

  // BUTCHR-149: briefs/project.md previously appeared in NO channel this
  // file builds or asserts against at all — that gap is what BUTCHR-149
  // closed. BUTCHR-165: briefs/epic.md and briefs/story.md carry the exact
  // same reviewer-side instruction (each is the reviewer of the tier below
  // it) and were left just as unasserted — this extends the same treatment
  // to both. Deliberately separate from the test above: none of the three
  // must ever be pulled into MERGE_INSTRUCTING_BRIEFS (none merges its own
  // PR), so this asserts the narrower, actually-true claim instead.
  test("the project/epic/story briefs instruct the reviewer-side [review]-line transcription caveat (BUTCHR-149, BUTCHR-165)", () => {
    const briefs = briefChannels().filter((c) => REVIEW_LINE_INSTRUCTING_BRIEFS.includes(c.label));
    expect(briefs.length).toBe(REVIEW_LINE_INSTRUCTING_BRIEFS.length); // the explicit list actually matched something

    for (const c of briefs) {
      expect(c.text, `${c.label} should carry the [review] APPROVED line format`).toMatch(REVIEW_LINE_APPROVED);
      expect(c.text, `${c.label} should carry the [review] CHANGES_REQUESTED line format`).toMatch(REVIEW_LINE_CHANGES_REQUESTED);
      // Scoped to a window right after the reviewer-side APPROVED line, not
      // the whole channel — see textNear's comment for why: briefs/story.md
      // carries this same phrase pair a second time, unrelated, in its own
      // author-side reading instructions, which would otherwise make this
      // assertion vacuous for that one channel.
      const nearReviewLine = textNear(c.text, REVIEW_LINE_APPROVED, 400);
      expect(nearReviewLine, `${c.label} should carry the sha transcription caveat NEAR its reviewer-side [review] line`).toMatch(TRANSCRIPTION_CAVEAT);
    }
  });
});

describe("BUTCHR-225: total type coverage of the derived brief family (merge-check-guard.test.ts)", () => {
  test("every member of knownBriefTypes() is asserted or excluded, never both, never neither", () => {
    const unaccounted = findUnaccountedBriefTypes(knownBriefTypes(), ASSERTED_TYPES, TYPE_EXCLUSIONS);
    if (unaccounted.length > 0) throw new Error(formatUnaccountedBriefTypeError(unaccounted));
    expect(unaccounted).toEqual([]);
  });

  test("TYPE_EXCLUSIONS is empty today, so this is vacuously true — but it fails loudly instead of letting a stale exclusion (naming a type no longer in the derived family) accumulate silently", () => {
    const family = new Set(knownBriefTypes());
    for (const exclusion of TYPE_EXCLUSIONS) {
      expect(family.has(exclusion.type), `TYPE_EXCLUSIONS names "${exclusion.type}", which is not (or no longer) in knownBriefTypes()`).toBe(true);
      expect(exclusion.reason.trim().length, `TYPE_EXCLUSIONS entry "${exclusion.type}" has an empty/whitespace reason`).toBeGreaterThan(0);
    }
  });

  test("non-vacuity: the accounting function flags an unaccounted member, flags a both-asserted-and-excluded member, accepts an asserted-only or excluded-only member, and the derived family used above is not empty", () => {
    expect(knownBriefTypes().length).toBeGreaterThan(0); // rules out "passes because the family is empty"

    expect(findUnaccountedBriefTypes(["ghost"], new Set(), [])).toEqual(["ghost"]);
    expect(findUnaccountedBriefTypes(["dup"], new Set(["dup"]), [{ type: "dup", reason: "x" }])).toEqual(["dup"]);
    expect(findUnaccountedBriefTypes(["a", "b"], new Set(["a"]), [{ type: "b", reason: "x" }])).toEqual([]);

    // Rules out "passes because ASSERTED_TYPES/TYPE_EXCLUSIONS silently
    // matches everything": feed the REAL sets a sentinel neither one knows
    // about. Deliberately NOT mixed into knownBriefTypes() the way the
    // sentinel above is a standalone family, unlike the mutation-1 fixture
    // above — a sentinel that also matched a real member (e.g. this file
    // once used the literal "probe", the same name the PR's own mandated
    // headline mutation injects) would make this test ALSO redden whenever
    // some other real member goes unaccounted, reporting a noisy multi-
    // member failure instead of the one this test means to isolate. A
    // sentinel guaranteed never to collide with a real brief type name
    // keeps this test's failure meaning exactly one thing.
    expect(findUnaccountedBriefTypes(["__not_a_real_brief_type__"], ASSERTED_TYPES, TYPE_EXCLUSIONS)).toEqual(["__not_a_real_brief_type__"]);
  });
});
