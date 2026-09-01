import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { briefFor } from "../../src/agents/workspace.js";
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
 * not from a copy that resembles it: `briefFor()` is the function that
 * renders a real brief into a workspace; `atlassianTools()` is the real
 * tool registry an agent's tool list is built from; docs/*.md are read as
 * files, the way a reader reads them; and the daemon nudge is reached
 * through `prReviewStateNudge`, a function `src/daemon/index.ts` itself
 * calls to build the message it pushes — not a regex over the daemon's
 * source text, which would only prove a template resembling what ships,
 * not what ships.
 *
 * WHAT THIS FILE CANNOT PROVE: it asserts what the TEXT SAYS. It says
 * nothing about whether `gh pr view` actually returns a `reviews[].commit.oid`
 * field shaped the way the text claims, or whether the jq in the briefs is
 * correct — that's a runtime property, not a text-content one, and this is
 * a unit test over strings.
 *
 * COVERAGE, STATED (see the PR description for the authoritative version):
 * covered — briefs (epic/story/task/default), tool descriptions, docs/*.md,
 * the daemon's PR-state-change nudge. NOT covered, deliberately: CHANGELOG.md
 * and changelog.d/*.md (they're the historical record of this defect being
 * fixed, not instruction — a guard that reddens on its own changelog gets
 * deleted); this guard file and test/unit/workspace.test.ts (they name the
 * forbidden pair in negative assertions/comments, not as instruction);
 * src/labels/pr.ts's code comment (documents the GitHub REST API's own
 * `reviewDecision` semantics, not an agent instruction); and the Confluence
 * glossary named upstream as a fifth channel, which lives outside this repo
 * and which no unit test here can see.
 */

interface Channel { label: string; text: string }

// BRIEFS — every issue type briefFor() actually serves, including the
// default fallback (an unrecognized type, e.g. "Bug", still gets a brief).
function briefChannels(): Channel[] {
  return ["Epic", "Story", "Task", "Bug"].map((t) => ({ label: `brief:${t}`, text: briefFor(t) }));
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
// misfire on exactly the correct explanation of the bug.
const FORBIDDEN_PAIR = /reviewDecision\s*,\s*headRefOid|headRefOid\s*,\s*reviewDecision/;

// Hand-wrapped markdown prose in this repo hard-wraps at ~80 columns, which
// can split "last decisive review" across a line break — whitespace-
// (including newline-) tolerant on purpose, so a wrap doesn't produce a
// false negative for a phrase that IS there.
const LAST_DECISIVE_REVIEW = /last\s+decisive\s+review/i;

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

    expect(briefs.some((c) => c.text.includes("one unit of work"))).toBe(true);
    expect(tools.some((c) => c.text.includes("Read a Jira issue"))).toBe(true);
    expect(docs.some((c) => c.text.includes("The agent model"))).toBe(true);
    expect(nudges.every((c) => c.text.includes("your PR's review state changed"))).toBe(true);
  });

  test("the forbidden reviewDecision+headRefOid pair appears in no covered channel", () => {
    const hits = allChannels().filter((c) => FORBIDDEN_PAIR.test(c.text));
    expect(hits.map((c) => c.label)).toEqual([]);
  });

  // A pure negative guard permits deleting the instruction entirely, so
  // every channel that DOES instruct an agent on merging must also name the
  // field that actually matters (`reviews[].commit.oid`) and the
  // last-decisive-review ordering — not just avoid the old pair. This is
  // explicit about WHICH channels instruct on merging (built from the same
  // channel-producing functions above, not inferred by scanning content for
  // a word like "merge" — that would just rebuild the bare-vs-namespaced
  // trap in a new shape).
  test("every channel that instructs on merging names reviews[].commit.oid and the last-decisive ordering", () => {
    const briefs = briefChannels().filter((c) => c.label === "brief:Story" || c.label === "brief:Task");
    const docs = docChannels();
    const nudges = nudgeChannels();

    for (const c of [...briefs, ...docs, ...nudges]) {
      expect(c.text, `${c.label} should name reviews[].commit.oid`).toContain("reviews[].commit.oid");
      expect(c.text, `${c.label} should name the last-decisive ordering`).toMatch(LAST_DECISIVE_REVIEW);
    }
  });
});
