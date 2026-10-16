import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { buildWorkspace, knownBriefTypes } from "../../src/agents/workspace.js";

const ROOT = join(import.meta.dir, "..", "..");
const DOCS_DIR = join(ROOT, "docs");

/**
 * BUTCHR-162: the `expect() calls` tally `bun test test/unit` reports is
 * MEASURED non-deterministic (docs/expect-tally-non-determinism.md) — a
 * reviewer who compares it between runs to confirm "no assertion was
 * weakened or removed" is trusting a number driven by OS scheduler jitter
 * in this suite's real-timer polling tests, not by what a diff changed.
 *
 * This guards the two channels a reviewing agent actually reads at the
 * moment it would reach for that tally — `briefs/story.md` (task-PR
 * review) and `briefs/epic.md` (story-PR review) — read from what
 * `buildWorkspace()` actually delivers, the same discipline
 * `merge-check-guard.test.ts` established for the sibling merge check
 * (BUTCHR-56). This file is deliberately independent of that one: it does
 * not import or extend it, so it carries no risk of colliding with
 * BUTCHR-149's concurrent generalisation of that guard.
 *
 * WHAT THIS FILE CANNOT PROVE: it asserts what the TEXT says, not that a
 * reviewing agent reads or follows it, and not that the underlying
 * non-determinism finding stays true forever (that's docs/expect-tally-non-
 * determinism.md's job, not a unit test's).
 */
const EXCLUSIONS: ReadonlyArray<{ path: string; reason: string }> = [
  // BUTCHR-225: this used to be one entry lumping briefs/task.md and
  // briefs/project.md (real members of the derived brief family — see
  // knownBriefTypes()) together with briefs/default.md (NOT a member — the
  // untyped fallback every unmapped issuetype gets). task.md and
  // project.md moved to TYPE_EXCLUSIONS below, which is checked against the
  // derived family and would fail loudly if either stopped being real; the
  // reason for each is restated there rather than only here, so it survives
  // the split. default.md's note stays here, as auditable prose, precisely
  // BECAUSE it is not a family member: an entry naming "default" in
  // TYPE_EXCLUSIONS would itself be flagged STALE by this file's own
  // stale-exclusion test below — the discipline working as intended, not a
  // bug to route around (see knownBriefTypes()'s own doc comment for why
  // DEFAULT isn't a tracked brief).
  { path: "briefs/default.md", reason: "the untyped \"nothing more specific applies\" fallback every unmapped issuetype gets — not a member of knownBriefTypes(), so deliberately not in TYPE_EXCLUSIONS either" },
  { path: "test/unit/assertion-check-guard.test.ts (this file)", reason: "names the command and its trap in its own assertions/comments, not as instruction to a reviewer" },
  { path: "docs/expect-tally-non-determinism.md itself, for containing its own command", reason: "the source of truth, not a second copy to cross-check against" },
];

/**
 * BUTCHR-225: the derived family this claim is about is
 * `knownBriefTypes()` (workspace.ts's own table) — the SAME family
 * merge-check-guard.test.ts's own copy of this section is keyed to. Every
 * member must be accounted for in exactly one of: ASSERTION_CHECK_INSTRUCTING_BRIEFS
 * (the positive set, below — the same array the coverage test loops over),
 * or TYPE_EXCLUSIONS (a written, non-empty reason) — never both, never
 * neither. This implementation is a deliberate, near-identical SIBLING of
 * merge-check-guard.test.ts's copy, not a shared import — see this repo's
 * own label-scan.ts/header-scan.ts/workspace-scan.ts precedent for keeping
 * per-medium checks self-contained rather than building one shared
 * abstraction two unrelated guards would then both depend on.
 *
 * FACTORY-40: "bug" joined this list once `briefs/bug.md` was rewritten
 * from a worker-tier stub into a boss-tier brief that reviews each Story it
 * files — the same reviewer position story.md/epic.md are in, reaching for
 * the same `expect()` tally the same way, so it carries the identical
 * instruction (mirrored close to verbatim from epic.md's own review
 * section), not a bug-specific variant of it.
 */
const ASSERTION_CHECK_INSTRUCTING_BRIEFS = ["story", "epic", "bug"] as const;

interface TypeExclusion { readonly type: string; readonly reason: string }

// Unlike merge-check-guard.test.ts's sibling list (empty today), this one
// is NOT empty: briefs/task.md and briefs/project.md are real members of
// knownBriefTypes() that this instruction genuinely does not reach (see
// each reason below) — restated from the now-split EXCLUSIONS entry above.
const TYPE_EXCLUSIONS: readonly TypeExclusion[] = [
  { type: "task", reason: "task.md is the reviewee here, not the reviewer — a task has no worker below it whose test diff it would review, so this instruction (aimed at a reviewer about to reach for the expect() tally) has nothing to attach to in task.md" },
  { type: "project", reason: "project.md's epic-review workflow has no equivalent test-gate framing to attach this instruction to, unlike story (reviews a task's test diff) and epic (reviews a story's test diff)" },
];

const ASSERTED_TYPES: ReadonlySet<string> = new Set(ASSERTION_CHECK_INSTRUCTING_BRIEFS);

/**
 * The members of `family` accounted for in neither, or in BOTH, of
 * `asserted`/`exclusions` — what the coverage test below actually fails
 * on. Pure. See merge-check-guard.test.ts's near-identical copy for the
 * cross-reference this file deliberately does not import.
 */
function findUnaccountedBriefTypes(family: readonly string[], asserted: ReadonlySet<string>, exclusions: readonly TypeExclusion[]): string[] {
  const excludedTypes = new Set(exclusions.map((e) => e.type));
  return family.filter((t) => asserted.has(t) === excludedTypes.has(t));
}

function formatUnaccountedBriefTypeError(types: readonly string[]): string {
  return [
    `${types.length} brief type(s) from knownBriefTypes() are not accounted for exactly once in assertion-check-guard.test.ts: ${types.join(", ")}.`,
    "Every member of the derived brief family must appear in exactly one of: ASSERTION_CHECK_INSTRUCTING_BRIEFS above, or TYPE_EXCLUSIONS below with a written reason — never both, never neither.",
    "TO FIX: add the type to ASSERTION_CHECK_INSTRUCTING_BRIEFS (if that brief genuinely reviews a test diff this way), OR add a { type, reason } entry to TYPE_EXCLUSIONS explaining why it doesn't.",
  ].join("\n");
}

function briefChannel(issuetype: "Story" | "Epic" | "Bug"): string {
  const root = mkdtempSync(join(tmpdir(), "assertion-check-guard-"));
  const prevEnv = process.env.BUTCHR_WORKSPACES;
  process.env.BUTCHR_WORKSPACES = root;
  try {
    const dir = buildWorkspace({ key: `ACG-${issuetype}`, issuetype, summary: "verify assertion-check coverage", parent: null }, "http://localhost:7717/mcp");
    return readFileSync(join(dir, "brief.md"), "utf8");
  } finally {
    if (prevEnv === undefined) delete process.env.BUTCHR_WORKSPACES;
    else process.env.BUTCHR_WORKSPACES = prevEnv;
  }
}

function docExists(): boolean {
  return existsSync(join(DOCS_DIR, "expect-tally-non-determinism.md"));
}

// The literal, safe-to-automate command this guidance must prescribe,
// `|| true` included — that suffix is what keeps a `set -e` script alive
// through the PASSING case (nothing removed), verified by running both
// forms against a real diff in this repo (see the doc). A channel that
// names the diff-based check WITHOUT this exact trailing guard has
// reintroduced the trap this ticket closed, even if the rest of the
// sentence is intact.
//
// FACTORY-901: the grep pattern and pathspec changed from the original
// `-- test/ | grep '^-.*expect('`. That form was found to ALWAYS report
// "clean", two independent ways, on a repo whose tests are colocated (not
// under `test/`) and/or do not use an `expect(...)`-shaped assertion
// library (e.g. node:assert) — an empty match from "nothing removed" and
// an empty match from "the check doesn't apply here" are indistinguishable
// under the old command, and it silently reports the reassuring one.
//
// A first fix (widen the pathspec, drop the library-specific pattern) was
// itself found, on review of PR #792, to still miss a mixed `.test.ts`/
// `.spec.ts` suite — see the "mixed test-file naming" behavioral test
// below, which reproduces that exact false-clean case and is why there is
// now no pathspec at all: a pathspec can always be a guess shy of
// whatever naming convention a given repo actually uses, so the command
// runs over the whole diff instead.
const SAFE_COMMAND = "git diff <base>...<head> | grep -E '^-[^-]' || true";

// The two claims the guidance must make alongside the command — that the
// tally is not safe to compare, and that the command's output is a prompt
// to inspect rather than a verdict. Two independent short markers rather
// than one long brittle phrase, same discipline BASE_MERGE_CAVEAT uses in
// merge-check-guard.test.ts: a maintainer rewording either sentence while
// keeping its meaning leaves this green; deleting the claim itself does not.
const NAMES_NON_DETERMINISM = /non-deterministic/i;
const NAMES_PROMPT_NOT_VERDICT = /candidate to read|not a verdict/i;

describe("assertion-check instruction channels (BUTCHR-162)", () => {
  test("non-vacuity: the doc exists and both reviewer briefs resolve to real content", () => {
    expect(docExists()).toBe(true);
    const doc = readFileSync(join(DOCS_DIR, "expect-tally-non-determinism.md"), "utf8");
    expect(doc.includes("expect() calls")).toBe(true);

    const story = briefChannel("Story");
    const epic = briefChannel("Epic");
    const bug = briefChannel("Bug");
    expect(story.includes("You own one increment of value")).toBe(true);
    expect(epic.includes("You own one outcome")).toBe(true);
    expect(bug.includes("You own one defect")).toBe(true);

    expect(EXCLUSIONS.length).toBeGreaterThan(0);
  });

  test("all three reviewer briefs (story.md, epic.md, bug.md) name the tally as unsafe to compare, the safe command with its || true guard, and that the count is a prompt to inspect, not a verdict", () => {
    for (const issuetype of ASSERTION_CHECK_INSTRUCTING_BRIEFS) {
      const text = briefChannel((issuetype.charAt(0).toUpperCase() + issuetype.slice(1)) as "Story" | "Epic" | "Bug");
      expect(text, `${issuetype} brief should say the tally is non-deterministic`).toMatch(NAMES_NON_DETERMINISM);
      expect(text, `${issuetype} brief should carry the exact safe command, including its trailing || true`).toContain(SAFE_COMMAND);
      expect(text, `${issuetype} brief should say the count is a prompt to inspect, not a verdict`).toMatch(NAMES_PROMPT_NOT_VERDICT);
      expect(text, `${issuetype} brief should point at the measurement doc`).toContain("docs/expect-tally-non-determinism.md");
    }
  });
});

describe("BUTCHR-225: total type coverage of the derived brief family (assertion-check-guard.test.ts)", () => {
  test("every member of knownBriefTypes() is asserted or excluded, never both, never neither", () => {
    const unaccounted = findUnaccountedBriefTypes(knownBriefTypes(), ASSERTED_TYPES, TYPE_EXCLUSIONS);
    if (unaccounted.length > 0) throw new Error(formatUnaccountedBriefTypeError(unaccounted));
    expect(unaccounted).toEqual([]);
  });

  test("every TYPE_EXCLUSIONS entry matches a real member of knownBriefTypes() today, and carries a non-empty reason — a stale exclusion (naming a type no longer in the derived family) fails loudly instead of accumulating silently", () => {
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
    // about, as a STANDALONE family — not mixed into knownBriefTypes() the
    // way an earlier version of this test used the literal "probe", the
    // same name the PR's own mandated headline mutation injects. A sentinel
    // that could collide with a real member would make this test ALSO
    // redden whenever some other real member goes unaccounted, reporting a
    // noisy multi-member failure instead of the one this test means to
    // isolate. A sentinel guaranteed never to collide with a real brief
    // type name keeps this test's failure meaning exactly one thing.
    expect(findUnaccountedBriefTypes(["__not_a_real_brief_type__"], ASSERTED_TYPES, TYPE_EXCLUSIONS)).toEqual(["__not_a_real_brief_type__"]);
  });
});

/**
 * FACTORY-901, raised on PR #792's review: pinning SAFE_COMMAND's literal
 * text cannot detect a defect in what the command actually DOES. This
 * section runs the real command, via a real `git diff`, against a real
 * two-commit fixture built in a scratch repo — the same discipline the
 * doc's own "Method" section used to verify each defect by direct
 * reproduction rather than by inheriting a hypothesis.
 */
function runGitCommand(cwd: string, args: readonly string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function initScratchRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "assertion-check-behavior-"));
  runGitCommand(dir, ["init", "-q"]);
  runGitCommand(dir, ["config", "user.email", "test@example.com"]);
  runGitCommand(dir, ["config", "user.name", "test"]);
  return dir;
}

function commitAll(dir: string, message: string): string {
  runGitCommand(dir, ["add", "-A"]);
  runGitCommand(dir, ["commit", "-q", "-m", message]);
  return runGitCommand(dir, ["rev-parse", "HEAD"]).trim();
}

// Runs the actual SAFE_COMMAND (base/head substituted) through a real shell,
// exactly as a reviewer would paste it — not a reimplementation of its
// pieces in TypeScript, which could drift from what the string in the
// briefs actually does.
function runSafeCommand(dir: string, base: string, head: string): string {
  const command = SAFE_COMMAND.replace("<base>", base).replace("<head>", head);
  return execFileSync("sh", ["-c", command], { cwd: dir, encoding: "utf8" });
}

describe("SAFE_COMMAND behavior on a real diff (FACTORY-901 PR #792 review)", () => {
  test("mixed test-file naming: a removed assertion in a .spec.ts file is NOT hidden by an untouched .test.ts file alongside it", () => {
    const dir = initScratchRepo();
    writeFileSync(join(dir, "covered.test.ts"), 'test("covered", () => { assert.equal(1, 1); });\n');
    writeFileSync(join(dir, "omitted.spec.ts"), 'test("important", () => { assert.equal(actual, expected); });\n');
    const base = commitAll(dir, "base");

    // covered.test.ts: comment-only change (nothing removed here).
    writeFileSync(join(dir, "covered.test.ts"), '// unrelated note\ntest("covered", () => { assert.equal(1, 1); });\n');
    // omitted.spec.ts: the real regression — the assertion line is removed.
    writeFileSync(join(dir, "omitted.spec.ts"), 'test("important", () => {});\n');
    const head = commitAll(dir, "head");

    const output = runSafeCommand(dir, base, head);
    expect(output, "the removed assert.equal(...) line in omitted.spec.ts must be visible — a pathspec that only matched covered.test.ts would print nothing here").toContain("assert.equal(actual, expected)");
  });

  test("sanity: a diff that removes nothing prints nothing (the || true guard does not manufacture false positives)", () => {
    const dir = initScratchRepo();
    writeFileSync(join(dir, "covered.test.ts"), 'test("covered", () => { assert.equal(1, 1); });\n');
    writeFileSync(join(dir, "omitted.spec.ts"), 'test("important", () => { assert.equal(actual, expected); });\n');
    const base = commitAll(dir, "base");

    writeFileSync(join(dir, "covered.test.ts"), '// unrelated note\ntest("covered", () => { assert.equal(1, 1); });\n');
    const head = commitAll(dir, "head");

    expect(runSafeCommand(dir, base, head)).toBe("");
  });

  test("sanity: a real removal in a conventionally-named test/ file is still caught (no regression on the common case)", () => {
    const dir = initScratchRepo();
    writeFileSync(join(dir, "app.ts"), "export const x = 1;\n");
    const base = commitAll(dir, "base");
    writeFileSync(join(dir, "app.ts"), 'export const x = 1;\nexpect(x).toBe(1);\n');
    const headWithAssertion = commitAll(dir, "add assertion");
    writeFileSync(join(dir, "app.ts"), "export const x = 1;\n");
    const headWithoutAssertion = commitAll(dir, "remove assertion");

    const output = runSafeCommand(dir, headWithAssertion, headWithoutAssertion);
    expect(output).toContain("expect(x).toBe(1)");
  });
});
