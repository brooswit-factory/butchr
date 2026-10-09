/**
 * FACTORY-810 (implementing FACTORY-754, epic FACTORY-748) — the upgrade
 * migration FACTORY-757's own changelog entry (`changelog.d/FACTORY-757.md`)
 * explicitly shipped WITHOUT: "No migration and no UI ship with this
 * change; stored rule config is untouched." That left a real hazard —
 * FACTORY-757 deleted `UNCOUNTED_ISSUE_TYPES` (the hardcoded Epic/Story/Bug
 * capacity exemption, `src/agents/capacity-role.ts`'s pre-PR#691 history),
 * so any `jira-work` rule whose JQL selected only those issue types, which
 * used to be uncounted for free, now falls through to the schema's
 * `role: "worker"` default and COUNTS toward `BUTCHR_MAX_AGENTS` — a
 * real, silent behaviour change for an operator who never asked for one.
 *
 * WHAT THIS MIGRATES, AND WHY NOTHING ELSE (FACTORY-754's own corrected
 * description, read at this ticket's commit — see that ticket for the
 * full reasoning, restated briefly here):
 *   1. `jira-work` rules whose JQL relies on the deleted issue-type
 *      exemption — the ONLY real target. Migrated to `role: "sentinel"`.
 *   2. `jira-work` task/subtask rules — already counted before and after
 *      (the schema default), so writing `role: "worker"` would be a
 *      redundant no-op. Left untouched.
 *   3. `jira-project` (manager) rules — `capacityRoleFor`
 *      (`src/agents/capacity-role.ts`) returns `"sentinel"` for every
 *      `jira-project` agent BY CONSTRUCTION, before it ever consults the
 *      rule's own `role`. Writing `role` onto one would be config the
 *      capacity path never reads. Left untouched (never even considered —
 *      `planCapacityRoleMigration` below filters to `resourceProvider ===
 *      "jira-work"` before anything else).
 *   4. Bare project-tier ids — sentinel by construction too, and have no
 *      rule at all to write onto.
 *   5. `github-issue`/`github-pr`/`zendesk-ticket`/`filesystem` rules — the
 *      pre-FACTORY-757 exemption only ever keyed on a Jira issue's type, so
 *      these were always counted and still are. Left untouched (filtered
 *      out the same way as `jira-project`, by `resourceProvider`).
 *
 * HOW A RULE'S QUERY EXPRESSES ISSUE TYPE (verified against the live
 * convention, `docs/rules.example.json`, and `searchRules`/`parseRules` —
 * `jira-work`'s `query` is a plain JQL string handed verbatim to Jira's own
 * search; nothing in this codebase parses it today): an `issuetype`
 * comparison, e.g. `issuetype = Epic` or `issuetype in (Story, Bug)`,
 * typically AND-ed with `assignee`/`status` clauses. `classifyJqlQuery`
 * below recognises exactly that shape and nothing more exotic — see its own
 * doc comment for precisely which shapes it refuses to guess about, and
 * why: this migration would rather leave a rule counted (today's new, but
 * SAFE, default) than wrongly exempt one from the cap it should be subject
 * to.
 *
 * IDEMPOTENCY (hard requirement, not a nicety — FACTORY-754's own
 * "interim operator step" may have already set `role` explicitly on some
 * or all rules before this code ever runs): `planCapacityRoleMigration`
 * only ever proposes a rule that has NO `role` member in the raw JSON at
 * all — an explicit `role` (`"sentinel"` OR `"worker"`, operator-set or
 * admin-assembly-set) is never inspected for its value, never overwritten,
 * and never even classified (classification is skipped entirely once a
 * rule already carries an explicit `role` — see `planCapacityRoleMigration`).
 * `runCapacityRoleMigration` (the only I/O entry point) goes one step
 * further: when nothing needs to change, it never calls `updateRulesFile`
 * at all, so a second run performs ZERO filesystem writes — no new backup,
 * no touched mtime, truly a no-op, not merely a written-but-unchanged file.
 *
 * NO READ-THEN-WRITE RACE: the plan `runCapacityRoleMigration` applies is
 * always computed from the SAME locked text `updateRulesFile`'s mutator
 * receives, never from the earlier unlocked read (that earlier plan exists
 * only to decide the cheap "nothing to migrate" early-out above). A rule
 * that gained an explicit `role`, or was deleted, in the window between the
 * unlocked and locked reads is therefore classified correctly against the
 * text actually being written — never overwritten, never missing and
 * causing a throw.
 */
import { type AgentRole, type ReadRulesFile, type RulesEnv, rulesPath } from "./rules.js";
import { type WriteRulesIo, defaultIo, setRuleRole, updateRulesFile } from "./write-rules.js";

/** The only issue types the pre-FACTORY-757 hardcoding ever exempted (`UNCOUNTED_ISSUE_TYPES`, PR #691's pre-change `src/agents/capacity-role.ts`) — lower-cased, since Jira issue type names are matched case-insensitively here, same as that old code's own `.trim().toLowerCase()`. */
const EXEMPT_ISSUE_TYPES: ReadonlySet<string> = new Set(["epic", "story", "bug"]);

export type CapacityMigrationSkipReason =
  | "not-jira-work"
  | "already-has-role"
  | "no-top-level-issuetype-clause"
  | "ambiguous-issuetype-clause-count"
  | "issuetype-clause-is-negated-or-unrecognised-operator"
  | "issuetype-clause-combined-with-or"
  | "issuetype-clause-malformed-value"
  | "unbalanced-query-syntax"
  | "issuetype-set-not-a-subset-of-epic-story-bug";

export interface ClassifyResult {
  outcome: "migrate" | "skip";
  reason?: CapacityMigrationSkipReason;
  /** The normalized (lower-cased) issue type names the query's top-level `issuetype` clause named, when exactly one such clause was found and recognised — present for both "migrate" and the "issuetype-set-not-a-subset-of-epic-story-bug" skip, absent otherwise. */
  issueTypes?: string[];
}

/**
 * A single quote/paren-aware left-to-right scan, the same technique
 * `scanJql` (`src/tools/jira-project-scope.ts`) uses for its own, differently-
 * scoped purpose — duplicated rather than imported (that function is
 * module-private, and this one tracks a different thing: not parens/ORDER
 * BY, but every character index where the bare word `issuetype` starts at
 * parenthesis depth 0 and outside any quoted string literal). Returns
 * `null` when `jql`'s own parens or quotes are unbalanced — unsafe to
 * reason about "top level" at all, so the caller must refuse to classify.
 */
function topLevelIssuetypeIndices(jql: string): number[] | null {
  let depth = 0;
  let quote: string | null = null;
  const indices: number[] = [];
  for (let i = 0; i < jql.length; i++) {
    const ch = jql[i]!;
    if (quote) {
      if (ch === "\\") { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === "(") { depth++; continue; }
    if (ch === ")") {
      depth--;
      if (depth < 0) return null;
      continue;
    }
    if (depth === 0) {
      const prevChar = i > 0 ? jql[i - 1] : undefined;
      const atWordStart = prevChar === undefined || !/\w/.test(prevChar);
      if (atWordStart && /^issuetype\b/i.test(jql.slice(i))) indices.push(i);
    }
  }
  if (depth !== 0 || quote !== null) return null;
  return indices;
}

/** The word immediately preceding index `idx` (skipping whitespace), lower-cased — `""` if `idx` is at (or near) the start of the string. Used to tell an AND-ed clause from an OR-ed one; by construction (see `topLevelIssuetypeIndices`) this is never a `(` or a quote, since either would have changed `depth`/`quote` before reaching `idx` at depth 0. */
function precedingWord(jql: string, idx: number): string {
  let i = idx - 1;
  while (i >= 0 && /\s/.test(jql[i]!)) i--;
  if (i < 0) return "";
  let j = i;
  while (j >= 0 && /\w/.test(jql[j]!)) j--;
  return jql.slice(j + 1, i + 1).toLowerCase();
}

/** The word immediately following index `idx` (skipping whitespace), lower-cased — `""` at end of string. */
function followingWord(jql: string, idx: number): string {
  let i = idx;
  while (i < jql.length && /\s/.test(jql[i]!)) i++;
  let j = i;
  while (j < jql.length && /\w/.test(jql[j]!)) j++;
  return jql.slice(i, j).toLowerCase();
}

interface ParsedValueList { values: string[]; end: number }

/** One bare-word-or-quoted-string value starting at `start` (after leading whitespace already skipped by the caller); returns the decoded value and the index just past it. */
function parseOneValue(jql: string, start: number): { value: string; end: number } | null {
  const ch = jql[start];
  if (ch === '"' || ch === "'") {
    const quote = ch;
    let i = start + 1;
    let value = "";
    while (i < jql.length) {
      const c = jql[i]!;
      if (c === "\\") { value += jql[i + 1] ?? ""; i += 2; continue; }
      if (c === quote) { i++; return { value, end: i }; }
      value += c;
      i++;
    }
    return null; // unterminated quote
  }
  const m = /^[A-Za-z0-9_]+/.exec(jql.slice(start));
  if (!m) return null;
  return { value: m[0], end: start + m[0].length };
}

/** Parses a parenthesized, comma-separated value list starting at `openParenIdx` (which must point at `(`). `null` on any malformed element or an unterminated list. */
function parseValueList(jql: string, openParenIdx: number): ParsedValueList | null {
  let i = openParenIdx + 1;
  const values: string[] = [];
  for (;;) {
    while (i < jql.length && /\s/.test(jql[i]!)) i++;
    const parsed = parseOneValue(jql, i);
    if (!parsed) return null;
    values.push(parsed.value);
    i = parsed.end;
    while (i < jql.length && /\s/.test(jql[i]!)) i++;
    if (jql[i] === ",") { i++; continue; }
    if (jql[i] === ")") return { values, end: i + 1 };
    return null;
  }
}

/**
 * Classifies ONE `jira-work` rule's JQL `query` against the deleted
 * issue-type capacity exemption, recognising exactly the canonical shape
 * `docs/rules.example.json` uses (`issuetype = Epic`, `issuetype IN (Story,
 * Bug)`, each AND-ed with the rest of the query, never OR-ed, never
 * negated) and refusing ("skip", never a guess) anything looser:
 *
 * - zero, or more than one, top-level `issuetype` clause: `skip` — nothing
 *   to anchor a single-valued decision on, or genuinely ambiguous which
 *   clause governs.
 * - a clause joined to its neighbours by a top-level `OR` (on either side):
 *   `skip` — an `OR` can let a non-exempt branch widen what the query
 *   actually matches; this function only trusts a pure `AND` chain.
 * - an operator other than plain `=` or `in` (`!=`, `not in`, `~`, `is not`,
 *   …): `skip` — this function recognises restriction, never exclusion;
 *   `issuetype != Task` says nothing about which OTHER types are matched.
 * - a malformed value, an unterminated quote, or unbalanced parens anywhere
 *   in the query: `skip` — `topLevelIssuetypeIndices`/`parseValueList`
 *   return `null`/fail rather than letting a misparse produce a wrong
 *   classification.
 * - a syntactically clean, singular, AND-ed, non-negated `issuetype =` /
 *   `issuetype in (...)` clause whose named type(s), case-insensitively,
 *   are NOT every one a subset of `{epic, story, bug}` (e.g. `Task`, an
 *   unrecognised custom type, or a mix like `Epic, Task`): `skip` — this
 *   rule's matches were never exempt before FACTORY-757 either (a Task
 *   half of that mix always counted), so there is nothing to preserve.
 *
 * Only when every one of the above holds AND the named set is non-empty and
 * a subset of `{epic, story, bug}` does this return `"migrate"` — the one
 * shape FACTORY-757 actually changed the counting behaviour for.
 */
export function classifyJqlQuery(query: string): ClassifyResult {
  const indices = topLevelIssuetypeIndices(query);
  if (indices === null) return { outcome: "skip", reason: "unbalanced-query-syntax" };
  if (indices.length === 0) return { outcome: "skip", reason: "no-top-level-issuetype-clause" };
  if (indices.length > 1) return { outcome: "skip", reason: "ambiguous-issuetype-clause-count" };
  const idx = indices[0]!;

  const before = precedingWord(query, idx);
  if (before !== "" && before !== "and") return { outcome: "skip", reason: before === "or" ? "issuetype-clause-combined-with-or" : "issuetype-clause-is-negated-or-unrecognised-operator" };

  let i = idx + "issuetype".length;
  while (i < query.length && /\s/.test(query[i]!)) i++;

  let values: string[];
  let afterIdx: number;
  if (query[i] === "=") {
    i++;
    while (i < query.length && /\s/.test(query[i]!)) i++;
    const parsed = parseOneValue(query, i);
    if (!parsed) return { outcome: "skip", reason: "issuetype-clause-malformed-value" };
    values = [parsed.value];
    afterIdx = parsed.end;
  } else if (/^in\b/i.test(query.slice(i))) {
    i += 2;
    while (i < query.length && /\s/.test(query[i]!)) i++;
    if (query[i] !== "(") return { outcome: "skip", reason: "issuetype-clause-malformed-value" };
    const list = parseValueList(query, i);
    if (!list) return { outcome: "skip", reason: "issuetype-clause-malformed-value" };
    values = list.values;
    afterIdx = list.end;
  } else {
    // `!=`, `not in`, `~`, `is not`, or anything else this function does not trust as a pure restriction.
    return { outcome: "skip", reason: "issuetype-clause-is-negated-or-unrecognised-operator" };
  }

  // A top-level `ORDER BY ...` is JQL's own final, always-trailing construct
  // (never inside parens, never followed by anything else — the same fact
  // `scanJql`'s `orderByIndex`, `src/tools/jira-project-scope.ts`, exists to
  // find) — it ends the filter exactly like end-of-string does, so it must
  // not make an otherwise-clean, AND-ed, non-negated issuetype clause look
  // unclassifiable just because something follows it.
  const after = followingWord(query, afterIdx);
  if (after !== "" && after !== "and" && after !== "order") return { outcome: "skip", reason: after === "or" ? "issuetype-clause-combined-with-or" : "issuetype-clause-is-negated-or-unrecognised-operator" };

  const normalized = values.map((v) => v.trim().toLowerCase());
  if (normalized.length === 0 || !normalized.every((v) => EXEMPT_ISSUE_TYPES.has(v))) {
    return { outcome: "skip", reason: "issuetype-set-not-a-subset-of-epic-story-bug", issueTypes: normalized };
  }
  return { outcome: "migrate", issueTypes: normalized };
}

export interface CapacityMigrationPlanEntry {
  id: string;
  outcome: "migrate" | "skip";
  reason?: CapacityMigrationSkipReason;
  issueTypes?: string[];
}

/** One raw rule object as `JSON.parse` returns it — deliberately untyped/unvalidated (`Rule`'s own defaults, e.g. `role: "worker"` when absent, must NOT be applied here, or this migration could never tell an explicit `role` from an absent one). */
type RawRule = Record<string, unknown>;

/**
 * The pure planning half: given the rules file's raw JSON text, decides
 * which `jira-work` rules should be migrated to `role: "sentinel"` and
 * why every other rule was left alone. Never touches disk, never mutates
 * `text` — `applyCapacityRoleMigration` below does that, from exactly this
 * plan. Throws only on genuinely malformed JSON/shape; a caller that wants
 * "no migration, no crash" for that case should catch and skip, same as
 * `runCapacityRoleMigration` does.
 */
export function planCapacityRoleMigration(text: string): CapacityMigrationPlanEntry[] {
  const doc: unknown = JSON.parse(text);
  if (!doc || typeof doc !== "object" || !Array.isArray((doc as Record<string, unknown>).rules)) {
    throw new Error(`expected an object with a "rules" array`);
  }
  const rules = (doc as { rules: RawRule[] }).rules;
  const plan: CapacityMigrationPlanEntry[] = [];
  for (const raw of rules) {
    if (raw === null || typeof raw !== "object") continue; // malformed entry — not this migration's job to validate; loadRules will refuse it properly
    const id = raw.id;
    if (typeof id !== "string") continue;
    if (raw.resourceProvider !== "jira-work") { plan.push({ id, outcome: "skip", reason: "not-jira-work" }); continue; }
    if (Object.prototype.hasOwnProperty.call(raw, "role")) { plan.push({ id, outcome: "skip", reason: "already-has-role" }); continue; }
    const query = typeof raw.query === "string" ? raw.query : "";
    const classified = classifyJqlQuery(query);
    plan.push({
      id,
      outcome: classified.outcome,
      ...(classified.reason !== undefined ? { reason: classified.reason } : {}),
      ...(classified.issueTypes !== undefined ? { issueTypes: classified.issueTypes } : {}),
    });
  }
  return plan;
}

/**
 * Applies a plan's `"migrate"` entries to `text`, writing `role: "sentinel"`
 * onto each one via `setRuleRole` (`src/rules/write-rules.ts`) — the SAME
 * surgical, formatting-preserving text editor `setRuleEnabled` already uses
 * for the `enabled` field, so every rule's untouched fields, indentation,
 * key order, and comments-adjacent whitespace survive byte-for-byte; only
 * the migrated rules' own `role` member (newly inserted — `already-has-role`
 * rules are never in the plan's `"migrate"` set to begin with) changes.
 * Idempotent by construction: re-running `planCapacityRoleMigration` against
 * the result finds every just-migrated rule already carrying an explicit
 * `role`, so nothing is ever in its `"migrate"` set twice.
 */
export function applyCapacityRoleMigration(text: string, plan: readonly CapacityMigrationPlanEntry[]): string {
  let next = text;
  for (const entry of plan) {
    if (entry.outcome !== "migrate") continue;
    next = setRuleRole(next, entry.id, "sentinel" as AgentRole);
  }
  return next;
}

export type CapacityRoleMigrationOutcome =
  | { kind: "no-rules-file" }
  | { kind: "unreadable"; error: string }
  | { kind: "no-op"; plan: CapacityMigrationPlanEntry[] }
  | { kind: "migrated"; plan: CapacityMigrationPlanEntry[]; migratedIds: string[]; backupPath: string | null };

/**
 * The one I/O entry point, meant to be called once at daemon startup,
 * mirroring `../agents/workspace-migration.ts`'s own convention (existence-
 * based, idempotent, never overwrites explicit state) and
 * `../rules/seed-first-run.ts`'s (runs BEFORE `loadRules` is called for
 * real, returns a typed outcome the caller logs rather than logging itself).
 *
 * Reads the CURRENT rules file text directly (not through `loadRules`,
 * which would apply schema defaults this migration must see THROUGH — an
 * absent `role` must read as "absent", never as the defaulted `"worker"`)
 * and does nothing at all — no parse-and-rewrite, no backup, no touched
 * mtime — when the file is absent, unreadable as the expected shape, or
 * the plan has nothing to migrate: a true no-op second run, not merely a
 * written-but-unchanged one. That unlocked read's plan is used ONLY for
 * this cheap early-out; it is never the plan that gets applied. Only when
 * at least one rule needs migrating does it call `updateRulesFile` (the
 * same locked, validated, backed-up, atomic write path every other rules
 * writer uses), and INSIDE that mutator `planCapacityRoleMigration` runs
 * AGAIN, against the text read under that same lock, with
 * `applyCapacityRoleMigration` applying THAT plan — not the stale one from
 * the unlocked read above. This is what makes "no read-then-write race
 * with a concurrent writer" true: a rule that gained an explicit `role`
 * between the two reads is re-classified as `"already-has-role"` by the
 * locked re-plan and never overwritten; a rule deleted in that window is
 * simply absent from the locked plan and never passed to `setRuleRole`, so
 * it can't throw.
 *
 * A rules file that fails to `JSON.parse`, or does not have the expected
 * `{ rules: [...] }` shape, is left entirely alone here (`"unreadable"`):
 * this migration is not the place to report that — the daemon's own
 * `loadRules` call (right after this, in `src/daemon/index.ts`) already
 * produces a clear, well-tested error for a genuinely broken rules file,
 * and this function running first must never pre-empt or obscure that.
 */
export function runCapacityRoleMigration(env: RulesEnv = process.env, io: WriteRulesIo = defaultIo()): CapacityRoleMigrationOutcome {
  const path = rulesPath(env);
  const readFile: ReadRulesFile = io.readFile;
  const currentText = readFile(path);
  if (currentText === undefined) return { kind: "no-rules-file" };

  let plan: CapacityMigrationPlanEntry[];
  try {
    plan = planCapacityRoleMigration(currentText);
  } catch (e) {
    return { kind: "unreadable", error: (e as Error).message };
  }

  const migratedIds = plan.filter((e) => e.outcome === "migrate").map((e) => e.id);
  if (migratedIds.length === 0) return { kind: "no-op", plan };

  let lockedPlan: CapacityMigrationPlanEntry[] = plan;
  const result = updateRulesFile((text) => {
    const lockedText = text ?? currentText;
    lockedPlan = planCapacityRoleMigration(lockedText);
    return applyCapacityRoleMigration(lockedText, lockedPlan);
  }, env, io);
  const lockedMigratedIds = lockedPlan.filter((e) => e.outcome === "migrate").map((e) => e.id);
  return { kind: "migrated", plan: lockedPlan, migratedIds: lockedMigratedIds, backupPath: result.backupPath };
}
