import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { briefFor, knownBriefTypes, BEFORE_YOU_STOP_INCLUDE_MARKER } from "../../src/agents/workspace.js";
import { KICKOFF_PROMPT, AGENTS_KICKOFF_PROMPT } from "../../src/agents/argv.js";

const ROOT = join(import.meta.dir, "..", "..");
const BRIEFS_DIR = join(ROOT, "briefs");

/**
 * FACTORY-735/FACTORY-739: the required text (semantically) every tier's
 * brief and kickoff reminder must carry — a worker's comment on its own
 * ticket, before it stops or goes idle, naming what it did, links, what's
 * left, blockers, and the next owner. Phrased loosely enough to survive a
 * future wording polish of `briefs/_before-you-stop.md` without this test
 * going stale on cosmetics, while still failing if the SUBSTANCE drops.
 */
const REQUIRED_PHRASES = [
  /before you stop or go idle/i,
  /post a comment on this ticket/i,
  /no silent stops/i,
];

/**
 * Every template under `briefs/` that is actually a shipped brief — never a
 * hand-copied literal list (that is exactly how `briefs/project.md` went
 * uncovered, per `knownBriefTypes()`'s own doc comment). `AGENTS.md`/
 * `CLAUDE.md` are generic provider-pointer files with no tier-specific
 * content of their own, and `_before-you-stop.md` is the shared section
 * itself — the DoD's own "the shared file itself must not be treated as a
 * template needing an include" — so all three are excluded the same way
 * `brief-tool-surface.test.ts` excludes them for its own, adjacent claim.
 */
function briefTemplateFiles(): string[] {
  return readdirSync(BRIEFS_DIR).filter((f) => f.endsWith(".md") && f !== "AGENTS.md" && f !== "CLAUDE.md" && f !== "_before-you-stop.md");
}

describe("FACTORY-735/FACTORY-739: shared 'before you stop' section", () => {
  test("briefs/_before-you-stop.md exists and carries the required text", () => {
    const text = readFileSync(join(BRIEFS_DIR, "_before-you-stop.md"), "utf8");
    for (const phrase of REQUIRED_PHRASES) expect(text).toMatch(phrase);
  });

  // THE FALSIFIER (DoD item 3): fails loud if any template under briefs/ —
  // present today, or added later for a brand-new brief type — lacks the
  // include marker. Reads raw files on disk, never BRIEF_BY_TYPE, so a
  // template that forgot the marker cannot pass just because some OTHER
  // caller composes it correctly.
  test("every brief template under briefs/ (epic, story, task, and any others) carries the shared-section include marker", () => {
    const files = briefTemplateFiles();
    expect(files.length).toBeGreaterThan(0); // non-vacuity: fails loud if briefs/ ever moves instead of silently checking nothing
    const missing = files.filter((f) => !readFileSync(join(BRIEFS_DIR, f), "utf8").includes(BEFORE_YOU_STOP_INCLUDE_MARKER));
    expect(missing, `missing the include marker (${BEFORE_YOU_STOP_INCLUDE_MARKER}): ${missing.join(", ")}`).toEqual([]);
  });

  // Every template this repo ships today, named explicitly (not derived),
  // so a reviewer can see at a glance which files this ticket touched —
  // the loop above is the one that actually protects a future addition.
  test("today's five mapped tiers plus the default fallback all carry the marker", () => {
    for (const file of ["epic.md", "story.md", "task.md", "bug.md", "project.md", "default.md"]) {
      expect(readFileSync(join(BRIEFS_DIR, file), "utf8")).toContain(BEFORE_YOU_STOP_INCLUDE_MARKER);
    }
  });

  // DoD item 2: "Built briefs for each tier visibly contain the section" —
  // not just the source template, but what briefFor() actually hands back
  // (what buildWorkspace() writes to brief.md), and the marker itself must
  // be fully RESOLVED there, never leaked to the agent verbatim.
  test("briefFor() resolves the include for every known tier plus the DEFAULT fallback — the built brief, not just the template, carries the real text", () => {
    for (const type of [...knownBriefTypes(), "Sub-task"]) {
      const brief = briefFor(type);
      for (const phrase of REQUIRED_PHRASES) expect(brief).toMatch(phrase);
      expect(brief).not.toContain(BEFORE_YOU_STOP_INCLUDE_MARKER);
    }
  });

  test("briefFor is case-insensitive and still resolves the include for every casing", () => {
    for (const type of knownBriefTypes()) {
      expect(briefFor(type.toUpperCase())).not.toContain(BEFORE_YOU_STOP_INCLUDE_MARKER);
    }
  });

  // DoD item 4: the SAME text, in the worker's kickoff prompt — delivered
  // (and so in context) from the agent's very first turn, not only inside
  // brief.md.
  test("the Claude kickoff prompt carries the same required text", () => {
    for (const phrase of REQUIRED_PHRASES) expect(KICKOFF_PROMPT).toMatch(phrase);
    expect(KICKOFF_PROMPT).toContain("follow your CLAUDE.md");
  });

  test("the non-Claude (AGENTS.md) kickoff prompt carries the same required text", () => {
    for (const phrase of REQUIRED_PHRASES) expect(AGENTS_KICKOFF_PROMPT).toMatch(phrase);
    expect(AGENTS_KICKOFF_PROMPT).toContain("follow your AGENTS.md");
  });
});
