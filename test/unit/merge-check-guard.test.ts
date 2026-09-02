import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildWorkspace } from "../../src/agents/workspace.js";
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
];

interface Channel { label: string; text: string }

// BRIEFS — the actual files `buildWorkspace()` writes into a real agent
// workspace (CLAUDE.md + the interpolated brief.md), for every issue type
// briefFor() serves plus the default fallback ("Bug"). Reading the files
// buildWorkspace() writes, rather than the brief.md template alone, is what
// makes this channel catch CLAUDE.md too — the first instruction file an
// agent reads, and a real, separate delivered artifact from brief.md.
function briefChannels(): Channel[] {
  const root = mkdtempSync(join(tmpdir(), "merge-check-guard-"));
  const prevEnv = process.env.BUTCHR_WORKSPACES;
  process.env.BUTCHR_WORKSPACES = root;
  try {
    return ["Epic", "Story", "Task", "Bug"].flatMap((t) => {
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

// BUTCHR-74: `reviews[].commit.oid` is not the immutable fallback the text
// used to claim it was — confirmed on two PRs (#135, #136) that GitHub can
// silently rewrite it to a later commit after a base-merge, and on #136
// (three reviews) an OLDER review kept its original recorded sha while a
// LATER review's recorded commit had already moved. Only a review's own
// written-at-submission body text stays fixed; any structured field can
// move, and this check reads the LAST decisive review — exactly the one
// most likely to have been rewritten. Every merge-instructing channel must
// say so (without asserting a rewrite mechanism beyond what's observed)
// and must not describe the check as sufficient.
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
});
