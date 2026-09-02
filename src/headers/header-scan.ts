import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as ts from "typescript";
import { listTsFiles } from "../labels/label-scan.js";

/**
 * BUTCHR-151/BUTCHR-157 — the description-header medium's source-scanning
 * door, the analogue of `src/labels/label-scan.ts`. See `./registry.ts`'s
 * header for the rule and for why this exists alongside (not instead of)
 * the type-level registry: it closes the bypass a type can't see — a new
 * header block built entirely outside `DescriptionHeaderKind`.
 *
 * WHY A PATTERN, NOT TODAY'S LITERAL TEXT — THE TRAP THIS TICKET WAS
 * SPECIFICALLY BUILT TO NOT REPEAT: a detector that greps for the literal
 * string `"[ORPHAN]"` catches today's one header and is BLIND to the next
 * one — structurally the identical trap `label-scan.ts`'s own header
 * documents for `agent:*`/`pr:*` (a family built by concatenation, whose
 * literal namespace prefix is not the whole value). A NEW description
 * header will have its OWN, DIFFERENT bracketed tag — this scanner matches
 * the SHAPE (`/^\[[A-Z][A-Z0-9_]*\]/` — a bracketed, all-caps tag opening a
 * string literal), extracts the tag, and checks THAT against
 * `HEADER_REGISTRY`'s declared tags, so a future header with a different
 * tag is still caught even though this file was never touched to add it.
 *
 * WHAT THIS SCANS: every `.ts` file under `src/` (never `test/` or
 * `scripts/` — same reasoning as `label-scan.ts`: `test/` fixtures use
 * header-shaped literals freely by design, e.g. this module's own test
 * file, and `scripts/` is operator tooling, not the write path). Uses the
 * real TypeScript parser (`ts.createSourceFile`), not a text regex, for the
 * same reason `label-scan.ts` does — a bracketed-tag-shaped substring
 * embedded inside a larger string (prose quoting a header, e.g. a ticket
 * discussing this very defect) must never be misread as a standalone
 * literal opening a new header. Matching against a string literal's own
 * `.text` via the real parser, rather than raw source text, makes that
 * distinction reliably; see `findLabelLiterals`'s own comment in
 * `label-scan.ts` for the concrete SWEEP_JQL case this same class of bug
 * produces when text regexes are used instead.
 *
 * WHAT THIS CANNOT SEE (write this down; a scanner with a silent bypass is
 * the exact failure this whole rule exists to catch):
 *   - A header block whose OPENING line is not itself a single, whole
 *     string literal — e.g. built entirely by runtime concatenation or
 *     interpolation with no literal anywhere containing the full
 *     `[TAG] ...` prefix (`` `[${tagVar}] rest` `` where `tagVar` is not a
 *     literal). Today's one real header (`orphanHeader` in
 *     `src/tools/relationship.ts`) does NOT fall into this hole — its open
 *     line, `ORPHAN_HEADER_OPEN_LINE`, is a single whole string literal —
 *     but a future header built more dynamically could. This is the same
 *     species of blind spot `label-scan.ts` names for `agent:*`/`pr:*`
 *     (label built by prefix + suffix concatenation, no literal for the
 *     whole value); the type-level door (`DescriptionHeaderKind`) is what a
 *     header shaped that way must still pass through to compile, exactly as
 *     `RegisteredLabel`'s type door is what actually covers `agent:*`/
 *     `pr:*` today, never the literal scan.
 *   - `test/` and `scripts/`. Only `src/` is scanned — see above.
 *   - A bracketed-all-caps-tag-shaped literal that is NOT actually a
 *     description-header opening line (a log-line prefix, an error-code
 *     tag, anything else that happens to match the shape). None exist in
 *     this repo's `src/` today (verified: `grep -rnoE '"\[[A-Z][A-Z0-9_
 *     -]*\]' src/` finds exactly one match, `"[ORPHAN]` — the string this
 *     scanner is meant to find). A genuine future false positive is handled
 *     the same way `label-scan.ts` handles its own — an explicit,
 *     named entry in `KNOWN_NON_HEADER_LITERALS` below, never by weakening
 *     the pattern or skipping a whole file, and never to make a real
 *     finding disappear.
 *   - Non-`.ts` files, and anything generated (none checked in under `src/`
 *     today; re-examine this assumption if that changes).
 */

const HEADER_TAG_RE = /^\[([A-Z][A-Z0-9_]*)\]/;

export interface HeaderTagLiteralHit {
  /** Repo-relative path, forward-slash separated. */
  readonly file: string;
  /** 1-indexed source line. */
  readonly line: number;
  /** The bracketed tag itself, e.g. "ORPHAN" (brackets stripped). */
  readonly tag: string;
  /** The literal's full text, for a legible failure message. */
  readonly text: string;
}

/** Find every string literal in one file's source that OPENS with a bracketed, all-caps tag. Pure — no I/O. */
export function findHeaderTagLiterals(file: string, sourceText: string): HeaderTagLiteralHit[] {
  const sourceFile = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, /* setParentNodes */ false);
  const hits: HeaderTagLiteralHit[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node)) {
      const m = HEADER_TAG_RE.exec(node.text);
      if (m) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        hits.push({ file, line: line + 1, tag: m[1]!, text: node.text });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return hits;
}

export interface HeaderTagLiteralExclusion {
  readonly file: string;
  readonly text: string;
  readonly reason: string;
}

/**
 * Confirmed, named exceptions — literals that are header-tag-shaped but are
 * NOT a description-header opening line. Empty today (see this file's own
 * header for the grep that confirms it); present so a genuine future false
 * positive has somewhere to go without weakening `HEADER_TAG_RE` or
 * skipping a file, same discipline as `label-scan.ts`'s own
 * `KNOWN_NON_LABEL_LITERALS`.
 */
export const KNOWN_NON_HEADER_LITERALS: readonly HeaderTagLiteralExclusion[] = [];

const exclusionKey = (file: string, text: string): string => `${file} ${text}`;

/** Hits whose tag is neither registered nor a known non-header exclusion — what the check actually fails on. Pure. */
export function findUnregisteredHeaderTagLiterals(
  hits: readonly HeaderTagLiteralHit[],
  registeredTags: ReadonlySet<string>,
  exclusions: readonly HeaderTagLiteralExclusion[] = KNOWN_NON_HEADER_LITERALS,
): HeaderTagLiteralHit[] {
  const excluded = new Set(exclusions.map((e) => exclusionKey(e.file, e.text)));
  return hits.filter((h) => !registeredTags.has(h.tag) && !excluded.has(exclusionKey(h.file, h.text)));
}

/** The failure message — short and actionable, mirroring `label-scan.ts`'s `formatUnregisteredLabelError`. */
export function formatUnregisteredHeaderTagError(hits: readonly HeaderTagLiteralHit[]): string {
  const lines = hits.map((h) => `  ${h.file}:${h.line}  "${h.text.length > 80 ? `${h.text.slice(0, 80)}…` : h.text}"`);
  return [
    `${hits.length} description-header-shaped literal(s) (a bracketed, all-caps tag opening a string literal) are not declared in the header registry:`,
    ...lines,
    "",
    "RULE: every description header butchr bakes into a ticket must declare, in one place, who withdraws it (src/headers/registry.ts) — a header with no declared withdrawal owner is a cached assertion that can silently go stale (this is exactly how the [ORPHAN] header itself went undeclared for a long time — see that file's header).",
    "",
    "TO FIX: add the tag to DescriptionHeaderKind and HEADER_TAGS (src/tools/relationship.ts), then add a matching entry to HEADER_REGISTRY in src/headers/registry.ts, with:",
    '  - withdrawnBy: a non-empty string naming the function/mechanism that retires this header, OR',
    '  - withdrawnBy: null, plus a required, non-empty neverWithdrawnReason string, if this header is DELIBERATELY, permanently never withdrawn.',
    "",
    "If a literal above is NOT actually a description-header opening line (some other bracketed, all-caps tag that happens to match the shape): do not register it. Add it to KNOWN_NON_HEADER_LITERALS in src/headers/header-scan.ts instead, with a reason.",
  ].join("\n");
}

/** Scan every `.ts` file under `srcDir` (repo-relative, label reported against `repoRoot`) for header-tag literals. Reuses label-scan.ts's own file-listing (a generic src/ walk, not label-specific logic) rather than duplicating it. */
export function scanDirForHeaderTagLiterals(srcDir: string, repoRoot: string): HeaderTagLiteralHit[] {
  const hits: HeaderTagLiteralHit[] = [];
  for (const file of listTsFiles(srcDir, repoRoot)) {
    hits.push(...findHeaderTagLiterals(file, readFileSync(join(repoRoot, file), "utf8")));
  }
  return hits;
}
