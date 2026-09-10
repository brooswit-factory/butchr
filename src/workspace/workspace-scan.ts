import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { BlindSpotEntry } from "../media/blind-spot.js";

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
 * WHAT THIS CANNOT SEE: see `WORKSPACE_BLIND_SPOTS` below — the enumerable
 * source of truth (BUTCHR-224), each entry with either an executable witness
 * (a test that constructs the claimed-invisible input, confirms silence,
 * and pairs it with a near-miss variant that IS detected) or a written
 * `noWitnessReason` — this medium carries the epic's one genuinely required
 * `noWitnessReason` (the deployment-gap entry) alongside a second, honestly
 * unwitnessable entry of its own (the non-template write sites). This
 * comment stops enumerating the claims in prose, on purpose: a second,
 * independently-driftable copy of the same list is exactly the drift
 * BUTCHR-224 exists to remove. The substantive reasoning for each claim now
 * lives in that entry's own `claim` field.
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

/**
 * BUTCHR-224. Every blind spot this scanner's own module header (above) used
 * to enumerate in prose, now an enumerable value with a type-level door
 * (`Record` keyed by a closed union fails to compile in both directions),
 * the same door `WORKSPACE_PLACEHOLDERS`/`MEDIA_REGISTRY` already use for
 * their own families. See `test/unit/workspace-registry.test.ts` for the
 * witness or the `noWitnessReason` this drives for each entry below, and
 * `src/media/blind-spot.ts` for what those mean and the runtime link that
 * makes a declared-but-unwritten witness fail the suite.
 *
 * TWO ENTRIES BELOW ARE `witness: null`, FOR TWO DIFFERENT REASONS — DO NOT
 * CONFLATE THEM: `mergedNotDeployed` cannot be witnessed by ANY source-
 * reading check, ever, by construction (BUTCHR-222's own required case).
 * `nonTemplateWriteSites` is a narrower, more mundane gap — its write sites
 * simply never produce the `{{NAME}}` shape this scanner matches, so there
 * is no witnessable input of this detector's shape to construct for it; a
 * future medium change that gave those sites placeholder syntax would make
 * it witnessable, unlike `mergedNotDeployed`, which no future change to
 * THIS scanner's own shape could ever fix.
 */
export const WORKSPACE_BLIND_SPOT_IDS = [
  "nonTemplateWriteSites",
  "secondTemplatesDirectory",
  "nonRecursiveSubdirectory",
  "nonMdFiles",
  "placeholderLookalike",
  "mergedNotDeployed",
] as const;
export type WorkspaceBlindSpotId = (typeof WORKSPACE_BLIND_SPOT_IDS)[number];

export const WORKSPACE_BLIND_SPOTS: Readonly<Record<WorkspaceBlindSpotId, BlindSpotEntry>> = {
  nonTemplateWriteSites: {
    claim:
      "A workspace record written by a path OTHER than `interpolate()`/a `briefs/*.md` template — confirmed, today: `mcp.json`'s `x-issue` field (direct `JSON.stringify`) and `ENVIRONMENT.md`'s entire content (direct `writeFileSync` of `groundTruthText(...)`, never living under `briefs/` and never containing `{{...}}` syntax). Neither is a `briefs/*.md` template, so this scanner cannot find either write site — see `./registry.ts`'s header, 'WHAT THIS REGISTRY DOES NOT CLAIM', for how those two are covered instead (prose, verified by reading the code, not by this mechanism).",
    witness: null,
    noWitnessReason:
      "Both confirmed write sites never produce `{{NAME}}`-shaped text at all — mcp.json's x-issue value is a bare issue key, never wrapped in braces, and ENVIRONMENT.md's content is verified (this file's own module header, and workspace-registry.ts's GROUND_TRUTH entry) to never contain `{{...}}` syntax. There is no claimed-invisible input of THIS scanner's shape to construct for either site: fabricating one (e.g. injecting a synthetic `{{...}}`-shaped string into a mock mcp.json/ENVIRONMENT.md fixture) would only re-demonstrate the `secondTemplatesDirectory`/`nonMdFiles` blind spots below under a different file name, not this one's actual claim, which is about the write sites' real serialization format having no placeholder syntax at all. Covered instead by prose cross-reference in WORKSPACE_REGISTRY's KEY and GROUND_TRUTH entries (src/workspace/registry.ts), verified by reading buildWorkspace, not by this mechanism.",
  },
  secondTemplatesDirectory: {
    claim:
      "A SECOND templates directory, if one is ever added — the caller (this medium's test suite) points `scanTemplatesForWorkspacePlaceholders` at `briefs/` specifically; nothing here discovers a second templates directory on its own, same restriction `label-scan.ts`/`header-scan.ts` place on `src/`.",
    witness: "workspace:second-templates-directory",
  },
  nonRecursiveSubdirectory: {
    claim:
      "A subdirectory of `briefs/` — `listWorkspaceTemplateFiles` reads `briefs/` non-recursively; there are none today, so this was previously untested against a real case, unlike `label-scan.ts`'s recursive `listTsFiles`.",
    witness: "workspace:non-recursive-subdirectory",
  },
  nonMdFiles: {
    claim: "Non-`.md` files under `briefs/` (there are none today) — `listWorkspaceTemplateFiles` only collects names ending `.md`.",
    witness: "workspace:non-md-files",
  },
  placeholderLookalike: {
    claim:
      "A placeholder-shaped substring that is NOT actually a live interpolation target — e.g. a future brief showing `{{LIKE_THIS}}` as a worked documentation example. None exist in `briefs/` today (verified: `grep -rnoE '\\{\\{[A-Z][A-Z0-9_]*\\}\\}' briefs/` finds only real, registered placeholders). A genuine future case is handled the same way `label-scan.ts`/`header-scan.ts` handle theirs — an explicit, named entry in `KNOWN_NON_WORKSPACE_PLACEHOLDER_LITERALS` above, never by weakening the pattern or skipping a file.",
    witness: "workspace:placeholder-lookalike",
  },
  mergedNotDeployed: {
    claim:
      "THE ONE NO SOURCE-READING CHECK CAN EVER SEE: a correct mechanism that is not actually running in the fleet. This scanner (like the two it mirrors) proves something about the code at the commit it runs against — merged-code truth — never about what a live daemon is currently executing. See BUTCHR-169's own ticket for the measured deployment-gap hazard this codebase has hit repeatedly, and `src/media/registry.ts`'s `DEPLOYED_TRUTH_NOTHING` for the same claim made about every medium in this codebase, not only this one.",
    witness: null,
    noWitnessReason:
      "No unit test runs inside a deployed daemon process, by construction — a test suite IS a merged-code-truth mechanism, so it cannot ever observe the one thing this claim is about (which commit a live process is currently executing). Fabricating a witness that appeared to cover this would be a worse outcome than leaving it named and uncovered: it would convert an honest, structural gap into a false assurance. See BUTCHR-224's own ticket, criterion 5, for why this is the one entry across all three detectors this story explicitly requires to be named this way rather than forced into a witness.",
  },
};
