import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { atlassianTools } from "../../src/tools/defs.js";
import type { AtlassianOps } from "../../src/tools/atlassian.js";

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
