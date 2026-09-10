import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import * as ts from "typescript";
import type { BlindSpotEntry } from "../media/blind-spot.js";

/**
 * BUTCHR-133/BUTCHR-143 — the source-scanning door. See ./registry.ts's
 * header for the rule and for why this exists alongside (not instead of) the
 * type-level registry: this closes the bypass a type can't see — a bare
 * `const FOO = "butchr:foo"` declared anywhere, never routed through
 * `LABEL_REGISTRY` at all.
 *
 * BUTCHR-172/BUTCHR-154 — this scanner and `../media/family-scan.ts` are
 * exact complements, cross-referenced from both files on purpose: THIS file
 * reads only WHOLE-literal labels and deliberately ignores a label-shaped
 * substring embedded inside a larger literal (see AC-9(a) below — that
 * discipline is exactly why this scanner correctly said nothing about the
 * pre-BUTCHR-155 `SWEEP_JQL`). `../media/family-scan.ts` looks ONLY at
 * substrings inside a larger literal, and is the machine check for that
 * specific gap. Neither weakens the other.
 *
 * WHAT THIS SCANS: every `.ts` file under `src/` (never `test/` or
 * `scripts/` — see "WHAT THIS CANNOT SEE" below), for a string literal whose ENTIRE value —
 * not a substring of a longer string — matches `agent:`, `pr:`, or `butchr:`
 * followed by one or more lowercase alphanumerics/hyphens. It uses the real
 * TypeScript parser (`ts.createSourceFile`), not a text regex, specifically
 * so a label-shaped substring embedded INSIDE a longer string is correctly
 * read as part of that one bigger string, never as a standalone literal — a
 * naive text regex over raw source cannot make that distinction reliably;
 * asking the real parser for strings' already-unescaped `.text` can. Before
 * BUTCHR-155, `SWEEP_JQL` in `./sweep.ts` was exactly this case: a hand-written
 * JQL string whose text contained `"agent:working"` etc. as literal characters
 * inside a larger single-quoted string, which this scanner correctly read as
 * part of that one bigger string rather than as four standalone literals.
 * BUTCHR-155 replaced that hand-written string with one built from
 * `./plan.ts`'s `ALL_AGENT_LABEL_KEYS`, so those literal characters no longer
 * exist in `./sweep.ts` at all — the example is gone, not the rationale for
 * using a real parser instead of a regex, which still holds for any future
 * JQL (or other) string that embeds a label-shaped substring.
 *
 * WHAT THIS CANNOT SEE: see `LABEL_BLIND_SPOTS` below — the enumerable
 * source of truth (BUTCHR-224), each entry with either an executable witness
 * (a test that constructs the claimed-invisible input, confirms silence,
 * and pairs it with a near-miss variant that IS detected) or a written
 * `noWitnessReason`. This comment stops enumerating the claims in prose, on
 * purpose: a second, independently-driftable copy of the same list is
 * exactly the drift BUTCHR-224 exists to remove. The substantive reasoning
 * for each claim — including AC-9(a), the circularity warning for the
 * agent:/pr: families — now lives in that entry's own `claim` field.
 */

const LABEL_LITERAL_RE = /^(?:agent|pr|butchr):[a-z0-9][a-z0-9-]*$/;

export interface LabelLiteralHit {
  /** Repo-relative path, forward-slash separated (e.g. "src/tools/docs.ts"). */
  readonly file: string;
  /** 1-indexed source line. */
  readonly line: number;
  /** The literal's exact string value. */
  readonly text: string;
}

/** Find every whole-string-literal match for the agent:/pr:/butchr: namespace pattern in one file's source. Pure — no I/O. */
export function findLabelLiterals(file: string, sourceText: string): LabelLiteralHit[] {
  const sourceFile = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, /* setParentNodes */ false);
  const hits: LabelLiteralHit[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node) && LABEL_LITERAL_RE.test(node.text)) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      hits.push({ file, line: line + 1, text: node.text });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return hits;
}

export interface LabelLiteralExclusion {
  /** Repo-relative path, forward-slash separated, e.g. "src/tools/docs.ts". */
  readonly file: string;
  /** The exact literal text this exclusion covers. */
  readonly text: string;
  /** Why this literal is NOT a Jira label despite matching the namespace pattern. */
  readonly reason: string;
}

/**
 * Confirmed, named exceptions — literals that are label-shaped but are not
 * Jira labels. Verified by reading the file, not guessed. Adding an entry
 * here MUST be accompanied by reading the site and confirming it never
 * appears in a `labels` array or an `addLabels`/`removeLabels` call; this
 * list is not a place to put a real finding to make the check pass (see this
 * file's header).
 */
export const KNOWN_NON_LABEL_LITERALS: readonly LabelLiteralExclusion[] = [
  {
    file: "src/tools/docs.ts",
    text: "butchr:doc",
    reason: "DOC_LINK_GLOBAL_ID — a Jira remote-link globalId used to find a ticket's bound Confluence doc. Never appears in a `labels` array or an addLabels/removeLabels call.",
  },
  {
    // This file's own entry two lines up QUOTES "butchr:doc" as a whole
    // string literal, so the scanner finds it here too — a self-reference,
    // not a second real occurrence. Excluded explicitly rather than special-
    // cased away, so this file is scanned by the same rule as everything
    // else under src/.
    file: "src/labels/label-scan.ts",
    text: "butchr:doc",
    reason: "The KNOWN_NON_LABEL_LITERALS entry above, restating the literal it documents — not a second use of it as a label.",
  },
];

const exclusionKey = (file: string, text: string): string => `${file} ${text}`;

/** Hits that are neither registered nor a known non-label exclusion — what the check actually fails on. Pure. */
export function findUnregisteredLabelLiterals(
  hits: readonly LabelLiteralHit[],
  registered: ReadonlySet<string>,
  exclusions: readonly LabelLiteralExclusion[] = KNOWN_NON_LABEL_LITERALS,
): LabelLiteralHit[] {
  const excluded = new Set(exclusions.map((e) => exclusionKey(e.file, e.text)));
  return hits.filter((h) => !registered.has(h.text) && !excluded.has(exclusionKey(h.file, h.text)));
}

/**
 * The failure message. Written for the reader AC-4 names: an agent who has
 * never read BUTCHR-133/BUTCHR-143 or its epic and has no idea why this rule
 * exists. Short and actionable on purpose — the reasoning lives in
 * ./registry.ts's header and the Confluence doc it points at, not repeated
 * here on every failure.
 */
export function formatUnregisteredLabelError(hits: readonly LabelLiteralHit[]): string {
  const lines = hits.map((h) => `  ${h.file}:${h.line}  "${h.text}"`);
  return [
    `${hits.length} label literal(s) under butchr's own namespaces (agent:, pr:, butchr:) are not declared in the label registry:`,
    ...lines,
    "",
    "RULE: every label butchr writes under its own namespaces must declare, in one place, who withdraws it (src/labels/registry.ts) — a label with no declared withdrawal owner is a cached assertion that can silently go stale.",
    "",
    "TO FIX: add an entry to LABEL_REGISTRY in src/labels/registry.ts, keyed by the exact label string above, with:",
    '  - withdrawnBy: a non-empty string naming the verb/mechanism that removes this label, OR',
    '  - withdrawnBy: null, plus a required, non-empty neverWithdrawnReason string, if this label is DELIBERATELY, permanently never withdrawn (a human decision you are writing down now, not one you are inferring to make this check pass).',
    "",
    "If a literal above is NOT actually a Jira label (an id, a marker, a JQL fragment, ...): do not register it. Add it to KNOWN_NON_LABEL_LITERALS in src/labels/label-scan.ts instead, with a reason — see that file's header for what this scanner can and cannot tell apart.",
  ].join("\n");
}

/** Every `.ts` file under `dir`, repo-relative and forward-slash separated, sorted. */
export function listTsFiles(dir: string, repoRoot: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      if (name.endsWith(".ts") && !name.endsWith(".d.ts")) out.push(relative(repoRoot, p).split(sep).join("/"));
    }
  };
  walk(dir);
  return out.sort();
}

/** Scan every `.ts` file under `srcDir` (repo-relative label reported against `repoRoot`) for label literals. */
export function scanDirForLabelLiterals(srcDir: string, repoRoot: string): LabelLiteralHit[] {
  const hits: LabelLiteralHit[] = [];
  for (const file of listTsFiles(srcDir, repoRoot)) {
    hits.push(...findLabelLiterals(file, readFileSync(join(repoRoot, file), "utf8")));
  }
  return hits;
}

/**
 * BUTCHR-224. Every blind spot this scanner's own module header (above) used
 * to enumerate in prose, now an enumerable value with a type-level door
 * (`Record` keyed by a closed union fails to compile in both directions),
 * the same door `WORKSPACE_PLACEHOLDERS`/`MEDIA_REGISTRY` already use for
 * their own families. See `test/unit/labels-registry.test.ts` for the
 * witness or the `noWitnessReason` this drives for each entry below, and
 * `src/media/blind-spot.ts` for what those mean and the runtime link that
 * makes a declared-but-unwritten witness fail the suite.
 */
export const LABEL_BLIND_SPOT_IDS = ["concatenationAndInterpolation", "unscannedDirectories", "nonLabelLookalike", "nonTsFiles"] as const;
export type LabelBlindSpotId = (typeof LABEL_BLIND_SPOT_IDS)[number];

export const LABEL_BLIND_SPOTS: Readonly<Record<LabelBlindSpotId, BlindSpotEntry>> = {
  concatenationAndInterpolation: {
    claim:
      "A label built by concatenation or interpolation whose PARTS are literals but whose WHOLE is not (e.g. `AGENT_PREFIX + label`, `` `${PR_PREFIX}${state}` ``) — this is where `agent:*` and `pr:*` are actually EMITTED (`./sync.ts`'s AGENT_PREFIX-plus-suffix and PR_PREFIX-plus-prState concatenations), and neither is a literal this scanner can parse. AC-9(a), LOAD-BEARING, DO NOT MISREAD A CLEAN SCAN: a scan of this repo's `src/` today DOES find all nine daemon-owned label values as literal text — every one of them, as a string key of `LABEL_REGISTRY` in `./registry.ts`. That is NOT this scanner confirming the emission sites above; it is the registry agreeing with itself, one file finding its own declarations. The real coverage for these nine comes ENTIRELY from `./registry.ts`'s TYPE-level door (`AgentLabelKey`/`PrLabelKey`, derived from `AgentLabel`/`PrState` themselves) — never from this scanner, clean run or not.",
    witness: "label:concatenation-and-interpolation",
  },
  unscannedDirectories: {
    claim:
      "`test/` and `scripts/` are not scanned — only `src/` is, because `scanDirForLabelLiterals` is always called with `srcDir` fixed to the repo's `src/` directory (see `test/unit/labels-registry.test.ts`'s own call). Labels are runtime state written by `src/`'s own code; `test/` fixtures use label literals freely by design (see e.g. `test/unit/relationship.test.ts`), and `scripts/` is operator tooling, not the write path. Scanning those directories too would either false-positive on every fixture or require a second exclusion list just as large as `KNOWN_NON_LABEL_LITERALS`.",
    witness: "label:unscanned-directories",
  },
  nonLabelLookalike: {
    claim:
      "Anything that is a real Jira-label-shaped literal STRING but is not actually used as a Jira label (an ID, a marker, a JQL fragment). This scanner cannot tell such a literal apart from a real label by shape alone. Two confirmed examples are hardcoded in `KNOWN_NON_LABEL_LITERALS` above, each with why. A new one must be added there explicitly, by name, with a reason — NEVER by weakening `LABEL_LITERAL_RE` or skipping a whole file, and never to make a real finding disappear (see `./registry.ts`'s header and BUTCHR-143's own ticket: using this list to launder a label whose withdrawal path someone forgot to write is the one outcome this mechanism must never produce).",
    witness: "label:non-label-lookalike",
  },
  nonTsFiles: {
    claim:
      "Non-`.ts` files, and anything generated (this repo has none checked in under `src/` today; if that changes, re-examine this assumption) — `listTsFiles` only collects names ending `.ts` (and excludes `.d.ts`), so an identical label-shaped literal sitting in, say, a `.md` or `.json` file under `src/` is never even read.",
    witness: "label:non-ts-files",
  },
};
