/**
 * The `filesystem` resource provider's query: WHAT it selects, kept apart
 * from HOW it walks the disk (src/resources/filesystem.ts) so validation at
 * rule-load time (parseRules, src/rules/rules.ts) never touches the
 * filesystem itself — the same "validate the shape, not the disk" discipline
 * `zendeskTicketQueryProblems`/`githubIssueQueryProblems` already apply to
 * their own string queries.
 *
 * SYNTAX DECISION (BUTCHR-407, recorded on the epic per the ticket's own
 * instruction): every existing provider's `Rule.query` is a plain STRING
 * (JQL, GitHub/Zendesk search syntax) — there is no precedent anywhere in
 * this schema for a structured field on `Rule` itself, and widening
 * `Rule.query`'s type would touch every provider's validation branch in
 * src/rules/rules.ts for one provider's benefit. A filesystem query needs
 * several independent, typed axes (root, kind, name pattern, depth, a
 * content/metadata predicate) that a hand-rolled mini-language would only
 * re-encode clumsily, so the query is a small JSON OBJECT, serialized into
 * that same string field and parsed here — structured data riding the
 * existing string-only schema, not a new mini-language and not a schema
 * change.
 */
import { homedir as realHomedir } from "node:os";

export type FilesystemKind = "file" | "directory";

/**
 * "directories containing a file named X" / "files whose extension is Y" —
 * the two worked examples the ticket names — as one discriminated union
 * rather than two separate optional fields, so a query can never accidentally
 * carry both (or neither) at once. `extension` requires `kind: "file"`;
 * `hasEntry` requires `kind: "directory"` — enforced in `filesystemQueryProblems`.
 */
export type FilesystemPredicate =
  | { predicateKind: "extension"; value: string }
  | { predicateKind: "hasEntry"; name: string; entryKind?: FilesystemKind };

export interface FilesystemQuery {
  /** Canonical (post-`~`, no `..`) absolute path — the search boundary itself, never a candidate resource. */
  root: string;
  kind: FilesystemKind;
  /** Glob over the candidate's OWN basename only (`*`/`?`; no `/`, no `**`, no brace/character-class syntax). Absent matches every name. */
  namePattern?: string;
  /** Directory levels below `root` to descend; `root`'s own direct children sit at depth 1. 1..MAX_ALLOWED_DEPTH; defaults to MAX_ALLOWED_DEPTH when omitted. */
  maxDepth: number;
  predicate?: FilesystemPredicate;
}

/** Also the depth default when a query omits `maxDepth` — see `FilesystemQuery.maxDepth`. Bounds cost alongside `MAX_VISITED`/`MAX_RESULTS` (src/resources/filesystem.ts). */
export const MAX_ALLOWED_DEPTH = 64;
const MAX_ROOT_LENGTH = 4096;
const QUERY_FIELDS = new Set(["root", "kind", "namePattern", "maxDepth", "predicate"]);
const PREDICATE_FIELDS = new Set(["predicateKind", "value", "name", "entryKind"]);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * `~` and `~/rest` expand against `home`; a bare `~user` form is refused
 * (`null`) rather than guessed at — resolving another account's home
 * directory needs a passwd lookup this module deliberately never performs
 * (no I/O at validation time). Anything not starting with `~` is returned
 * unchanged.
 */
export function expandHome(root: string, home: string = realHomedir()): string | null {
  if (root === "~") return home;
  if (root.startsWith("~/")) return `${home.replace(/\/+$/, "")}${root.slice(1)}`;
  if (root.startsWith("~")) return null;
  return root;
}

function rootProblems(root: unknown, home: string): string[] {
  if (typeof root !== "string" || !root.trim()) return ["query.root must be a non-empty string"];
  const expanded = expandHome(root.trim(), home);
  if (expanded === null) return [`query.root "${root}": ~user is not supported; use an absolute path`];
  if (expanded.length > MAX_ROOT_LENGTH) return [`query.root is longer than ${MAX_ROOT_LENGTH} characters`];
  if (expanded.includes("\0")) return [`query.root "${root}" contains a NUL byte`];
  if (expanded[0] !== "/") return [`query.root "${root}" must be absolute (or start with ~)`];
  if (expanded === "/") return [];
  if (expanded.endsWith("/")) return [`query.root "${root}" must not have a trailing slash`];
  const segments = expanded.slice(1).split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) return [`query.root "${root}" must not contain "." or ".." segments or repeated slashes`];
  return [];
}

function predicateProblems(raw: unknown, kind: unknown): string[] {
  const at = "query.predicate";
  if (!isObject(raw)) return [`${at} must be an object`];
  const problems: string[] = [];
  for (const k of Object.keys(raw)) if (!PREDICATE_FIELDS.has(k)) problems.push(`${at} has unknown field "${k}"`);
  const predicateKind = raw.predicateKind;
  if (predicateKind === "extension") {
    if (kind !== "file") problems.push(`${at}: an "extension" predicate requires query.kind "file"`);
    if (typeof raw.value !== "string" || !raw.value.startsWith(".") || raw.value.length < 2 || raw.value.includes("/") || /\s/.test(raw.value)) {
      problems.push(`${at}.value must be an extension starting with "." (e.g. ".ts"), with no "/" or whitespace`);
    }
    if (raw.name !== undefined || raw.entryKind !== undefined) problems.push(`${at}: an "extension" predicate takes only "value"`);
  } else if (predicateKind === "hasEntry") {
    if (kind !== "directory") problems.push(`${at}: a "hasEntry" predicate requires query.kind "directory"`);
    if (typeof raw.name !== "string" || !raw.name || raw.name.includes("/") || raw.name === "." || raw.name === "..") {
      problems.push(`${at}.name must be a direct child name (no "/", not "." or "..")`);
    }
    if (raw.entryKind !== undefined && raw.entryKind !== "file" && raw.entryKind !== "directory") problems.push(`${at}.entryKind must be "file" or "directory"`);
    if (raw.value !== undefined) problems.push(`${at}: a "hasEntry" predicate takes no "value"`);
  } else {
    problems.push(`${at}.predicateKind must be "extension" or "hasEntry"`);
  }
  return problems;
}

/**
 * Why a `filesystem` rule query is unusable, or `[]`. Checked at rule-load
 * time (parseRules) — deliberately never touches the filesystem itself:
 * `root`'s existence, and whether it is actually a directory, are DISCOVERY-time
 * facts (src/resources/filesystem.ts), not load-time ones — a root that is
 * temporarily unmounted must fail a POLL, the same "a bad read is not a valid
 * empty result" discipline as `ZENDESK_SEARCH_LIMIT`, never the daemon's own
 * startup.
 */
export function filesystemQueryProblems(query: string, home: string = realHomedir()): string[] {
  let doc: unknown;
  try { doc = JSON.parse(query); } catch (e) { return [`query is not valid JSON: ${(e as Error).message}`]; }
  if (!isObject(doc)) return ["query must be a JSON object"];
  const problems: string[] = [];
  for (const k of Object.keys(doc)) if (!QUERY_FIELDS.has(k)) problems.push(`query has unknown field "${k}"`);
  problems.push(...rootProblems(doc.root, home));
  if (doc.kind !== "file" && doc.kind !== "directory") problems.push(`query.kind must be "file" or "directory"`);
  if (doc.namePattern !== undefined && (typeof doc.namePattern !== "string" || !doc.namePattern || doc.namePattern.includes("/"))) {
    problems.push(`query.namePattern must be a non-empty string with no "/"`);
  }
  if (doc.maxDepth !== undefined && (typeof doc.maxDepth !== "number" || !Number.isInteger(doc.maxDepth) || doc.maxDepth < 1 || doc.maxDepth > MAX_ALLOWED_DEPTH)) {
    problems.push(`query.maxDepth must be an integer between 1 and ${MAX_ALLOWED_DEPTH}`);
  }
  if (doc.predicate !== undefined) problems.push(...predicateProblems(doc.predicate, doc.kind));
  return problems;
}

/**
 * The query actually used, resolved from the rule's JSON string. Throws for
 * anything `filesystemQueryProblems` would flag — callers only ever call this
 * after that check has already passed at rule-load time, same discipline as
 * `scopedTicketQuery`/`scopedIssueQuery`.
 */
export function parseFilesystemQuery(query: string, home: string = realHomedir()): FilesystemQuery {
  const problems = filesystemQueryProblems(query, home);
  if (problems.length) throw new Error(`filesystem query rejected: ${problems.join("; ")}`);
  const doc = JSON.parse(query) as Record<string, unknown>;
  const root = expandHome((doc.root as string).trim(), home)!;
  const out: FilesystemQuery = {
    root,
    kind: doc.kind as FilesystemKind,
    maxDepth: typeof doc.maxDepth === "number" ? doc.maxDepth : MAX_ALLOWED_DEPTH,
  };
  if (typeof doc.namePattern === "string") out.namePattern = doc.namePattern;
  if (doc.predicate !== undefined) {
    const p = doc.predicate as Record<string, unknown>;
    out.predicate = p.predicateKind === "extension"
      ? { predicateKind: "extension", value: p.value as string }
      : { predicateKind: "hasEntry", name: p.name as string, ...(p.entryKind ? { entryKind: p.entryKind as FilesystemKind } : {}) };
  }
  return out;
}
