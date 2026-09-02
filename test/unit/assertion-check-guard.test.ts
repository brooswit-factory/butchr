import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildWorkspace } from "../../src/agents/workspace.js";

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
  { path: "briefs/task.md / briefs/project.md / briefs/default.md", reason: "neither reviews a task's or story's test diff in this fleet (task.md is the reviewee, not the reviewer; project.md's epic review has no equivalent test-gate framing to attach this to; default.md is the untyped fallback)" },
  { path: "test/unit/assertion-check-guard.test.ts (this file)", reason: "names the command and its trap in its own assertions/comments, not as instruction to a reviewer" },
  { path: "docs/expect-tally-non-determinism.md itself, for containing its own command", reason: "the source of truth, not a second copy to cross-check against" },
];

function briefChannel(issuetype: "Story" | "Epic"): string {
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
const SAFE_COMMAND = "git diff <base>...<head> -- test/ | grep '^-.*expect(' || true";

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
    expect(story.includes("You own one increment of value")).toBe(true);
    expect(epic.includes("You own one outcome")).toBe(true);

    expect(EXCLUSIONS.length).toBeGreaterThan(0);
  });

  test("both reviewer briefs (story.md, epic.md) name the tally as unsafe to compare, the safe command with its || true guard, and that the count is a prompt to inspect, not a verdict", () => {
    for (const issuetype of ["Story", "Epic"] as const) {
      const text = briefChannel(issuetype);
      expect(text, `${issuetype} brief should say the tally is non-deterministic`).toMatch(NAMES_NON_DETERMINISM);
      expect(text, `${issuetype} brief should carry the exact safe command, including its trailing || true`).toContain(SAFE_COMMAND);
      expect(text, `${issuetype} brief should say the count is a prompt to inspect, not a verdict`).toMatch(NAMES_PROMPT_NOT_VERDICT);
      expect(text, `${issuetype} brief should point at the measurement doc`).toContain("docs/expect-tally-non-determinism.md");
    }
  });
});
