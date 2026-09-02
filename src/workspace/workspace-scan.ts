import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * BUTCHR-169 — the workspace-file medium's source-scanning door, the
 * analogue of `src/headers/header-scan.ts` (itself modelled on
 * `src/labels/label-scan.ts`). See `./registry.ts`'s header for the rule and
 * for why this exists alongside (not instead of) the type-level registry: it
 * closes the bypass door 1 cannot see FROM THE TEMPLATE SIDE — a new
 * `{{THING}}` placeholder introduced into a `briefs/*.md` template that
 * nobody wired into `interpolate()`'s substitution table yet, which would
 * otherwise render LITERALLY (a real, silent bug: the placeholder text
 * leaking straight to the agent, unsubstituted) with nothing catching it.
 *
 * WHY A REGEX OVER RAW TEXT, NOT THE TYPESCRIPT PARSER `label-scan.ts`/
 * `header-scan.ts` USE: this medium's "source" is `briefs/*.md` — plain-text
 * Markdown, not TypeScript — so there is no AST to ask. The
 * false-positive/false-negative discipline those two files' parser-based
 * approach protects (a label- or header-shaped SUBSTRING embedded inside a
 * larger, unrelated string must not be misread as a real occurrence) is
 * preserved here by a DIFFERENT, cheaper mechanism suited to the medium: a
 * `KNOWN_NON_WORKSPACE_PLACEHOLDER_LITERALS` exclusion list (empty today,
 * see below) for the day a brief legitimately needs to SHOW `{{LIKE_THIS}}`
 * as a documentation example rather than use it as a real placeholder —
 * verified today (see the grep this file's test suite runs) to not yet be a
 * real case in this repo.
 *
 * WHY A PATTERN (`{{[A-Z][A-Z0-9_]*}}`), NOT TODAY'S FIVE LITERAL NAMES —
 * the same reasoning `header-scan.ts` gives for matching a SHAPE rather than
 * `"[ORPHAN]"` specifically: a future template author adding a SIXTH
 * placeholder with a name this scanner never special-cased is still caught,
 * because the shape (not the name) is what's matched, and the found name is
 * then checked against `WORKSPACE_REGISTRY`'s declared keys.
 *
 * WHAT THIS SCANS: every `.md` file directly under `briefs/` (that directory
 * has no subdirectories today; this does not recurse — see "WHAT THIS
 * CANNOT SEE" below for what that means if one is ever added).
 *
 * WHAT THIS CANNOT SEE (write this down; a scanner with a silent bypass is
 * the exact failure this whole rule exists to catch):
 *   - A workspace record written by a path OTHER than `interpolate()`/a
 *     `briefs/*.md` template — confirmed, today: `mcp.json`'s `x-issue`
 *     field (direct `JSON.stringify`) and `ENVIRONMENT.md`'s entire content
 *     (direct `writeFileSync` of `groundTruthText(...)`, never living under
 *     `briefs/` and never containing `{{...}}` syntax). Neither is a
 *     `briefs/*.md` template, so this scanner cannot find either write site
 *     — see `./registry.ts`'s header, "WHAT THIS REGISTRY DOES NOT CLAIM",
 *     for how those two are covered instead (prose, verified by reading the
 *     code, not by this mechanism).
 *   - A SECOND templates directory, if one is ever added — the caller (this
 *     medium's test suite) points `scanTemplatesForWorkspacePlaceholders` at
 *     `briefs/` specifically; nothing here discovers a second templates
 *     directory on its own, same restriction `label-scan.ts`/
 *     `header-scan.ts` place on `src/`.
 *   - A subdirectory of `briefs/` — `listWorkspaceTemplateFiles` below reads
 *     `briefs/` non-recursively; there are none today, so this is untested
 *     against a real case, unlike `label-scan.ts`'s recursive `listTsFiles`.
 *   - Non-`.md` files under `briefs/` (there are none today).
 *   - A placeholder-shaped substring that is NOT actually a live
 *     interpolation target — e.g. a future brief showing `{{LIKE_THIS}}` as
 *     a worked documentation example. None exist in `briefs/` today
 *     (verified: `grep -rnoE '\{\{[A-Z][A-Z0-9_]*\}\}' briefs/` finds only
 *     real, registered placeholders — see this file's own test suite for the
 *     live rerun of that claim). A genuine future case is handled the same
 *     way `label-scan.ts`/`header-scan.ts` handle theirs — an explicit,
 *     named entry in `KNOWN_NON_WORKSPACE_PLACEHOLDER_LITERALS` below, never
 *     by weakening the pattern or skipping a file.
 *   - THE ONE NO SOURCE-READING CHECK CAN EVER SEE: a correct mechanism that
 *     is not actually running in the fleet. This scanner (like the two it
 *     mirrors) proves something about the code at the commit it runs
 *     against — merged-code truth — never about what a live daemon is
 *     currently executing. See BUTCHR-169's own ticket for the measured
 *     deployment-gap hazard this codebase has hit repeatedly.
 */

const WORKSPACE_PLACEHOLDER_RE = /\{\{([A-Z][A-Z0-9_]*)\}\}/g;

export interface WorkspacePlaceholderHit {
  /** Repo-relative path, forward-slash separated (e.g. "briefs/task.md"). */
  readonly file: string;
  /** 1-indexed source line. */
  readonly line: number;
  /** The placeholder name, brackets stripped (e.g. "SUMMARY"). */
  readonly name: string;
}

/** Find every `{{NAME}}`-shaped placeholder in one template's raw text. Pure — no I/O. */
export function findWorkspacePlaceholders(file: string, sourceText: string): WorkspacePlaceholderHit[] {
  const hits: WorkspacePlaceholderHit[] = [];
  const lines = sourceText.split("\n");
  lines.forEach((lineText, i) => {
    WORKSPACE_PLACEHOLDER_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = WORKSPACE_PLACEHOLDER_RE.exec(lineText))) hits.push({ file, line: i + 1, name: m[1]! });
  });
  return hits;
}

export interface WorkspacePlaceholderExclusion {
  readonly file: string;
  readonly name: string;
  readonly reason: string;
}

/**
 * Confirmed, named exceptions — placeholder-shaped text that is NOT a real
 * interpolation target. Empty today (see this file's own header for the
 * grep that confirms it); present so a genuine future false positive has
 * somewhere to go without weakening `WORKSPACE_PLACEHOLDER_RE` or skipping a
 * file, same discipline as `label-scan.ts`'s `KNOWN_NON_LABEL_LITERALS` /
 * `header-scan.ts`'s `KNOWN_NON_HEADER_LITERALS`.
 */
export const KNOWN_NON_WORKSPACE_PLACEHOLDER_LITERALS: readonly WorkspacePlaceholderExclusion[] = [];

const exclusionKey = (file: string, name: string): string => `${file} ${name}`;

/** Hits whose name is neither registered nor a known non-placeholder exclusion — what the check actually fails on. Pure. */
export function findUnregisteredWorkspacePlaceholders(
  hits: readonly WorkspacePlaceholderHit[],
  registeredNames: ReadonlySet<string>,
  exclusions: readonly WorkspacePlaceholderExclusion[] = KNOWN_NON_WORKSPACE_PLACEHOLDER_LITERALS,
): WorkspacePlaceholderHit[] {
  const excluded = new Set(exclusions.map((e) => exclusionKey(e.file, e.name)));
  return hits.filter((h) => !registeredNames.has(h.name) && !excluded.has(exclusionKey(h.file, h.name)));
}

/** The failure message — short and actionable, mirroring `header-scan.ts`'s `formatUnregisteredHeaderTagError`. */
export function formatUnregisteredWorkspacePlaceholderError(hits: readonly WorkspacePlaceholderHit[]): string {
  const lines = hits.map((h) => `  ${h.file}:${h.line}  {{${h.name}}}`);
  return [
    `${hits.length} workspace-template placeholder(s) are not declared in the workspace registry:`,
    ...lines,
    "",
    "RULE: every {{PLACEHOLDER}} a briefs/*.md template interpolates must declare, in one place, who withdraws it (src/workspace/registry.ts) — a snapshotted record with no declared withdrawal owner is a cached assertion that can silently go stale.",
    "",
    "TO FIX: add the name to WORKSPACE_PLACEHOLDERS (src/agents/workspace.ts) and wire it into interpolate()'s substitution table, then add a matching entry to WORKSPACE_REGISTRY in src/workspace/registry.ts, with:",
    "  - withdrawnBy: a non-empty string naming the function/mechanism that keeps this record from going stale, OR",
    "  - withdrawnBy: null, plus a required, non-empty neverWithdrawnReason string, if this record is DELIBERATELY, permanently never withdrawn.",
    "",
    "If a hit above is NOT actually a live interpolation target (a documentation example showing the {{...}} syntax itself): do not register it. Add it to KNOWN_NON_WORKSPACE_PLACEHOLDER_LITERALS in src/workspace/workspace-scan.ts instead, with a reason.",
  ].join("\n");
}

/** Every `.md` file directly under `dir` (non-recursive — see this file's header), repo-relative to `repoRoot` and forward-slash separated, sorted — same convention as `label-scan.ts`'s `listTsFiles`. */
export function listWorkspaceTemplateFiles(dir: string, repoRoot: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name.endsWith(".md")) out.push(relative(repoRoot, join(dir, name)).split(sep).join("/"));
  }
  return out.sort();
}

/** Scan every `.md` file under `templatesDir` (repo-relative, reported against `repoRoot`) for workspace placeholders. */
export function scanTemplatesForWorkspacePlaceholders(templatesDir: string, repoRoot: string): WorkspacePlaceholderHit[] {
  const hits: WorkspacePlaceholderHit[] = [];
  for (const file of listWorkspaceTemplateFiles(templatesDir, repoRoot)) {
    hits.push(...findWorkspacePlaceholders(file, readFileSync(join(repoRoot, file), "utf8")));
  }
  return hits;
}
