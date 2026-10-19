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
 * still fails it. Kept broad/overlapping on purpose for the "every tier
 * resolves it" sweep below; `SCENARIO_PHRASES` (further down) is what
 * actually falsifies each individual DoD scenario — this array alone is
 * NOT a substitute for that (PR #818 review, round 2, finding 3).
 */
const REQUIRED_LIFECYCLE_PHRASES = [
  /move to in progress/i,
  /move to in review/i,
  /move to done/i,
  /changes_requested/i,
  /read the issue back/i,
  /release\/deployment/i,
  /explicit user waiver/i,
  /newer conflicting owner/i,
  /do not open a duplicate review request/i,
];

/**
 * PR #818 review, round 2, finding 3: the old array above claimed (in a
 * comment, never in actual assertions) to falsify draft-PR, unavailable/
 * denied transition, readback mismatch, blocked/incomplete acceptance,
 * named-requirement waiver scope, and unchanged-comment dedup — but each of
 * those specific sentences could be deleted from
 * `briefs/_before-you-stop.md` while every existing test stayed green,
 * because the phrases actually asserted were broader catch-alls that
 * matched OTHER, still-present sentences. Each entry below targets the
 * exact sentence for ONE named scenario (plus the two finding-1 gaps), so
 * deleting that sentence — and only that sentence — fails ITS OWN test.
 */
const SCENARIO_PHRASES: Record<string, RegExp> = {
  "draft PR -> back to In Progress": /a draft pr,\s+or a review that comes back CHANGES_REQUESTED, means\s+back to in progress/i,
  "transition unavailable on this issue's workflow": /the target status\s+doesn't exist on this issue's workflow/i,
  "transition denied": /it was denied/i,
  "readback mismatch": /the readback doesn't match/i,
  "blocked\\/incomplete acceptance cannot close": /acceptance that hasn't actually happened yet/i,
  "waiver is scoped to the named requirement": /waiver of that named\s+requirement/i,
  "no duplicate unchanged comment on every wake": /don't repost the same still-true comment on every wake/i,
  // finding 1a: use jira_transition by name when supported, else discover
  // the real transition ID live — never hardcode/copy either.
  "transition-ID discovery fallback when status-name transition isn't supported": /discover the actual transition id through\s+the live api/i,
  // finding 1b: an agent:working label change is never grounds for Done.
  "agent:working label change is never grounds for Done": /an?\s+agent:working label changing is never by itself grounds to move to done/i,
};

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

/**
 * PR #818 review, round 2, finding 3: a hand-copied `PARENT_TIER_FILES`
 * allow-list cannot catch a FUTURE template that owns children but forgets
 * the recursive-closure include — it would simply never appear on the
 * list. Inverted here into a small, explicit, justified LEAF exclusion
 * list instead: every template is assumed to be able to own children (and
 * so required to carry the include) UNLESS it is named here, with a
 * reason. Today that's exactly `task.md` (a Task is `hierarchyLevel: 0`
 * with no child-owning concept in this fleet) and `default.md` (the
 * untracked-type fallback — carrying no committed claim about what it
 * owns). Adding a new brief template with no entry here defaults to
 * REQUIRING the include, which is the safe failure direction.
 */
const LEAF_TIER_FILES = ["task.md", "default.md"];

/** Every shipped brief template that is not an explicit leaf — i.e., must carry the recursive-closure include. Derived, never hand-copied. */
const parentTierFiles = (): string[] => briefTemplateFiles().filter((f) => !LEAF_TIER_FILES.includes(f));

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

  // Broad sweep: every lifecycle phrase, in the one shared source.
  test("the shared source carries every required lifecycle rule", () => {
    const text = readFileSync(join(BRIEFS_DIR, "_before-you-stop.md"), "utf8");
    for (const phrase of REQUIRED_LIFECYCLE_PHRASES) expect(text).toMatch(phrase);
  });

  // THE FALSIFIERS (PR #818 review, round 2, finding 3 + finding 1): one
  // assertion per named DoD scenario, each targeting ONLY that scenario's
  // own sentence. Deleting any one of these sentences from
  // briefs/_before-you-stop.md fails exactly its own case here and no
  // other — unlike the broad sweep above, which several of these could
  // vanish from without failing anything.
  for (const [scenario, phrase] of Object.entries(SCENARIO_PHRASES)) {
    test(`the shared source falsifies: ${scenario}`, () => {
      const text = readFileSync(join(BRIEFS_DIR, "_before-you-stop.md"), "utf8");
      expect(text).toMatch(phrase);
    });
  }

  // DoD item 1: "all built applicable briefs containing the lifecycle
  // rules" — the RESOLVED brief for every known tier plus the DEFAULT
  // fallback, mirroring the existing before-you-stop assertion above but
  // for the full lifecycle rule set added by this ticket.
  test("briefFor() resolves the lifecycle rules into every known tier plus the DEFAULT fallback", () => {
    for (const type of [...knownBriefTypes(), "Sub-task"]) {
      const brief = briefFor(type);
      for (const phrase of REQUIRED_LIFECYCLE_PHRASES) expect(brief).toMatch(phrase);
      for (const phrase of Object.values(SCENARIO_PHRASES)) expect(brief).toMatch(phrase);
    }
  });

  // Both supported kickoff reminders (DoD: "both supported kickoff
  // reminders receiving the same text") carry the lifecycle rules too, not
  // just the original before-you-stop phrasing.
  test("both kickoff prompts carry the lifecycle rules and every named scenario", () => {
    for (const phrase of [...REQUIRED_LIFECYCLE_PHRASES, ...Object.values(SCENARIO_PHRASES)]) {
      expect(KICKOFF_PROMPT).toMatch(phrase);
      expect(AGENTS_KICKOFF_PROMPT).toMatch(phrase);
    }
  });

  test("briefs/_recursive-child-closure.md exists and requires recursive, verified descendant closure with project-key safety", () => {
    const text = readFileSync(join(BRIEFS_DIR, "_recursive-child-closure.md"), "utf8");
    expect(text).toMatch(/read the actual current state of every\s+descendant/i);
    expect(text).toMatch(/verify that correction yourself/i);
    expect(text).toMatch(/never silently treat an unmet descendant as\s+done/i);
    expect(text).toMatch(/never on the\s+project key itself/i); // project-key safety
  });

  // THE FALSIFIER for recursive traversal + per-level evidence (PR #818
  // review, round 1, finding 2): fails if either requirement is removed.
  test("the recursive-closure fragment requires traversing EVERY level, not just immediate children, and verified closure evidence at each level", () => {
    const text = readFileSync(join(BRIEFS_DIR, "_recursive-child-closure.md"), "utf8");
    expect(text).toMatch(/not just its immediate children/i); // falsifier: recursion requirement
    expect(text).toMatch(/recursively/i);
    expect(text).toMatch(/recurse into\s+its own children/i);
    expect(text).toMatch(/level by level/i);
    expect(text).toMatch(/is not by itself sufficient to trust/i); // falsifier: evidence requirement
    expect(text).toMatch(/has the linked closure\/acceptance evidence/i);
    expect(text).toMatch(/at any depth/i);
  });

  // THE FALSIFIERS for "correct only what's actually wrong" (PR #818
  // review, round 2, finding 2): a descendant that is genuinely, accurately
  // open needs NO owner correction — it just blocks closure as-is. Only a
  // STALE status — including a false/unevidenced Done — gets "corrected."
  // Each assertion targets one half; collapsing the distinction (e.g.
  // telling every open descendant's owner to "correct" it) fails these.
  test("the recursive-closure fragment treats a false/unevidenced Done as a stale status requiring owner correction, same as a stuck one", () => {
    const text = readFileSync(join(BRIEFS_DIR, "_recursive-child-closure.md"), "utf8");
    expect(text).toMatch(/is a stale status\s+exactly like a\s+status that never advanced/i);
    expect(text).toMatch(/require its owner to correct it/i);
  });

  test("the recursive-closure fragment does NOT ask for owner correction of genuinely, accurately open work — it simply blocks closure", () => {
    const text = readFileSync(join(BRIEFS_DIR, "_recursive-child-closure.md"), "utf8");
    expect(text).toMatch(/genuinely,\s*\n?\s*accurately open, in-scope work that is not cancelled or waived needs no/i);
    expect(text).toMatch(/it already carries the right status/i);
    expect(text).toMatch(/simply blocks this ticket from closing/i);
  });

  // THE FALSIFIER for recursive closure (PR #818 review, round 2, finding
  // 3): derived from `briefTemplateFiles()` minus the small, justified
  // `LEAF_TIER_FILES` list, NOT a hand-copied allow-list — so a brand-new
  // parent-capable template that forgets the include fails this by
  // default (the safe direction) instead of silently never being checked.
  test("every non-leaf brief template carries the recursive-closure include marker", () => {
    const files = parentTierFiles();
    expect(files.length).toBeGreaterThan(0); // non-vacuity
    const missing = files.filter((f) => !readFileSync(join(BRIEFS_DIR, f), "utf8").includes(RECURSIVE_CHILD_CLOSURE_INCLUDE_MARKER));
    expect(missing, `missing the recursive-closure marker (${RECURSIVE_CHILD_CLOSURE_INCLUDE_MARKER}): ${missing.join(", ")}`).toEqual([]);
  });

  // Every template this repo ships today, named explicitly, so a reviewer
  // sees at a glance which files carry the include — the derived check
  // above is the one that actually protects a future addition.
  test("today's parent tiers (epic, story, bug, project) are exactly today's non-leaf templates", () => {
    expect(parentTierFiles().sort()).toEqual(["bug.md", "epic.md", "project.md", "story.md"].sort());
  });

  // task.md/default.md own no children, so they must NOT gain the
  // recursive-closure text — a bare Task recursing into nonexistent
  // children would be a confusing, false instruction.
  test("the explicit leaf tiers (task.md, default.md) do not carry the recursive-closure include", () => {
    for (const file of LEAF_TIER_FILES) {
      expect(readFileSync(join(BRIEFS_DIR, file), "utf8")).not.toContain(RECURSIVE_CHILD_CLOSURE_INCLUDE_MARKER);
    }
  });

  test("briefFor() resolves the recursive-closure include for every parent tier, and never leaks the marker", () => {
    for (const type of ["epic", "story", "bug", "project"]) {
      const brief = briefFor(type);
      expect(brief).toMatch(/is a stale status\s+exactly like a\s+status that never advanced/i);
      expect(brief).not.toContain(RECURSIVE_CHILD_CLOSURE_INCLUDE_MARKER);
    }
  });

  test("briefFor() for task and the DEFAULT fallback does NOT resolve recursive-closure text", () => {
    for (const type of ["task", "Sub-task"]) {
      expect(briefFor(type)).not.toMatch(/is a stale status\s+exactly like a\s+status that never advanced/i);
    }
  });

  // Review finding (PR #818, round 1): project.md correctly says a
  // project key is not an issue key, but the shared lifecycle section used
  // to tell EVERY brief (project included) to manage "your own Jira
  // lifecycle" and call `jira_transition` on "this issue" — internally
  // unsafe once resolved into project.md, which owns a PROJECT key, not an
  // issue key. The shared source now exempts a project resource
  // explicitly; this is the falsifier for that exemption.
  test("the shared lifecycle section exempts a project resource from issue-transition instructions", () => {
    const text = readFileSync(join(BRIEFS_DIR, "_before-you-stop.md"), "utf8");
    expect(text).toMatch(/if what you own is\s+a project resource/i);
    expect(text).toMatch(/never call `jira_transition` with a project\s+key/i);
    expect(text).toMatch(/it is not an issue key/i);
  });

  test("the resolved project brief never directs a transition of the project key — it carries both the project-key warning and the issue-scoped exemption", () => {
    const brief = briefFor("project");
    // project.md's own, pre-existing warning (never touched by this ticket):
    expect(brief).toMatch(/a project key is not an issue key; never/i);
    // the shared section's new exemption, now resolved into this same brief:
    expect(brief).toMatch(/never call `jira_transition` with a project\s+key/i);
    expect(brief).toMatch(/skip them entirely for the\s+project resource itself/i);
  });

  test("a non-project brief (task) is unaffected by the project exemption — it still gets the full issue-transition rules unconditionally", () => {
    const brief = briefFor("task");
    for (const phrase of REQUIRED_LIFECYCLE_PHRASES) expect(brief).toMatch(phrase);
    for (const phrase of Object.values(SCENARIO_PHRASES)) expect(brief).toMatch(phrase);
    // the conditional exemption text is present (it's shared), but nothing
    // about task.md's OWN content tells it to skip transitioning its issue —
    // task.md never claims to own a "project resource".
    expect(brief.toLowerCase()).not.toContain("you own a product direction");
  });
});
