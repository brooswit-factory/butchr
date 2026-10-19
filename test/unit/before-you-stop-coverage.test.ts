import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { briefFor, knownBriefTypes, BEFORE_YOU_STOP_INCLUDE_MARKER, RECURSIVE_CHILD_CLOSURE_INCLUDE_MARKER } from "../../src/agents/workspace.js";
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
 * FACTORY-1020: the lifecycle rules now folded into the shared section —
 * phrased loosely, same discipline as `REQUIRED_PHRASES` above, so a future
 * wording polish doesn't break this on cosmetics while a dropped SUBSTANCE
 * still fails it.
 */
const REQUIRED_LIFECYCLE_PHRASES = [
  /move to in progress/i,
  /move to in review/i,
  /move to done/i,
  /changes_requested/i, // draft PR / changes requested -> back to In Progress
  /read the issue back/i, // readback after every transition
  /do not claim success/i, // unavailable/denied/mismatched transition
  /release\/deployment/i, // deployment acceptance is part of Done where required
  /explicit user waiver/i,
  /newer conflicting owner/i,
  /do not open a duplicate review request/i,
];

/** Every template under `briefs/` whose name starts with "_" is a shared fragment, never a standalone brief. */
const isSharedFragment = (f: string): boolean => f.startsWith("_");

/**
 * Every template under `briefs/` that is actually a shipped brief — never a
 * hand-copied literal list (that is exactly how `briefs/project.md` went
 * uncovered, per `knownBriefTypes()`'s own doc comment). `AGENTS.md`/
 * `CLAUDE.md` are generic provider-pointer files with no tier-specific
 * content of their own, and any `_`-prefixed file is a shared fragment
 * itself (`_before-you-stop.md`, `_recursive-child-closure.md`) — the
 * DoD's own "a shared fragment must not be treated as a standalone
 * template needing an include," checked generically so a FUTURE shared
 * fragment is excluded too without touching this list — so all are
 * excluded the same way `brief-tool-surface.test.ts` excludes them for its
 * own, adjacent claim.
 */
function briefTemplateFiles(): string[] {
  return readdirSync(BRIEFS_DIR).filter((f) => f.endsWith(".md") && f !== "AGENTS.md" && f !== "CLAUDE.md" && !isSharedFragment(f));
}

/** Templates whose issue type can own children today — the ones that must carry the recursive-closure include. */
const PARENT_TIER_FILES = ["epic.md", "story.md", "bug.md", "project.md"];

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

describe("FACTORY-1020: worker briefs own verified In Review and Done transitions", () => {
  test("briefs/_before-you-stop.md exists and carries the required text", () => {
    const text = readFileSync(join(BRIEFS_DIR, "_before-you-stop.md"), "utf8");
    for (const phrase of REQUIRED_PHRASES) expect(text).toMatch(phrase);
  });

  // THE FALSIFIER for the lifecycle rules: In Progress -> In Review -> Done,
  // changes-requested/draft -> In Progress, unavailable/denied transition,
  // readback mismatch, blocked/incomplete acceptance cannot close, required
  // deployment acceptance, explicit scoped waiver, newer conflicting owner
  // action, and no duplicate review/comment — all must be present in the
  // ONE shared source every brief includes, not hand-copied per tier.
  test("the shared source carries every required lifecycle rule", () => {
    const text = readFileSync(join(BRIEFS_DIR, "_before-you-stop.md"), "utf8");
    for (const phrase of REQUIRED_LIFECYCLE_PHRASES) expect(text).toMatch(phrase);
  });

  // DoD item 1: "all built applicable briefs containing the lifecycle
  // rules" — the RESOLVED brief for every known tier plus the DEFAULT
  // fallback, mirroring the existing before-you-stop assertion above but
  // for the full lifecycle rule set added by this ticket.
  test("briefFor() resolves the lifecycle rules into every known tier plus the DEFAULT fallback", () => {
    for (const type of [...knownBriefTypes(), "Sub-task"]) {
      const brief = briefFor(type);
      for (const phrase of REQUIRED_LIFECYCLE_PHRASES) expect(brief).toMatch(phrase);
    }
  });

  // Both supported kickoff reminders (DoD: "both supported kickoff
  // reminders receiving the same text") carry the lifecycle rules too, not
  // just the original before-you-stop phrasing.
  test("both kickoff prompts carry the lifecycle rules", () => {
    for (const phrase of REQUIRED_LIFECYCLE_PHRASES) {
      expect(KICKOFF_PROMPT).toMatch(phrase);
      expect(AGENTS_KICKOFF_PROMPT).toMatch(phrase);
    }
  });

  test("briefs/_recursive-child-closure.md exists and requires recursive, verified child closure with project-key safety", () => {
    const text = readFileSync(join(BRIEFS_DIR, "_recursive-child-closure.md"), "utf8");
    expect(text).toMatch(/read the actual current state of every\s+child/i);
    expect(text).toMatch(/require its owner to correct the status/i);
    expect(text).toMatch(/verify that correction yourself/i);
    expect(text).toMatch(/do not close\s+this ticket while scoped child work remains unmet/i);
    expect(text).toMatch(/never silently treat an unmet child as done/i);
    expect(text).toMatch(/never on the project key itself/i); // project-key safety
  });

  // THE FALSIFIER for recursive closure: fails loud if a parent-tier
  // template (present today, or added later) lacks the include — reads raw
  // files on disk, never BRIEF_BY_TYPE.
  test("every parent-tier template (epic, story, bug, project) carries the recursive-closure include marker", () => {
    const missing = PARENT_TIER_FILES.filter(
      (f) => !readFileSync(join(BRIEFS_DIR, f), "utf8").includes(RECURSIVE_CHILD_CLOSURE_INCLUDE_MARKER),
    );
    expect(missing, `missing the recursive-closure marker (${RECURSIVE_CHILD_CLOSURE_INCLUDE_MARKER}): ${missing.join(", ")}`).toEqual([]);
  });

  // task.md/default.md own no children, so they must NOT gain the
  // recursive-closure text — a bare Task recursing into nonexistent
  // children would be a confusing, false instruction.
  test("task.md and default.md do not carry the recursive-closure include", () => {
    for (const file of ["task.md", "default.md"]) {
      expect(readFileSync(join(BRIEFS_DIR, file), "utf8")).not.toContain(RECURSIVE_CHILD_CLOSURE_INCLUDE_MARKER);
    }
  });

  test("briefFor() resolves the recursive-closure include for every parent tier, and never leaks the marker", () => {
    for (const type of ["epic", "story", "bug", "project"]) {
      const brief = briefFor(type);
      expect(brief).toMatch(/require its owner to correct the status/i);
      expect(brief).not.toContain(RECURSIVE_CHILD_CLOSURE_INCLUDE_MARKER);
    }
  });

  test("briefFor() for task and the DEFAULT fallback does NOT resolve recursive-closure text", () => {
    for (const type of ["task", "Sub-task"]) {
      expect(briefFor(type)).not.toMatch(/require its owner to correct the status/i);
    }
  });
});
