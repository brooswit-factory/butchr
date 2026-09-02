/**
 * HALF B of BUTCHR-49/BUTCHR-63: a per-call classification for a deprecated
 * alias's audit line, machine-readable enough for scripts/audit-alias-calls.ts
 * to key on without regex-guessing English prose, and readable enough for a
 * human skimming a journal.
 *
 * THE TAG. Every alias-tool audit line in src/tools/defs.ts ends with:
 *
 *     [alias tool=<toolName> class=drift|sanctioned|ambiguous]
 *
 * `aliasTag` builds it; `parseAliasAuditLine` (HALF A's ingest point) reads
 * it back out of a raw journal line. A line with no such tag but the OLD
 * unconditional `[deprecated alias;` marker is a pre-deploy line — real,
 * countable, but genuinely unclassifiable (see DEPLOY REALITY on the
 * ticket); `parseAliasAuditLine` reports that as classification "unknown"
 * rather than silently dropping it, same as a permission-gated empty
 * journal must never be silently mistaken for a quiet one.
 *
 * THE THREE CLASSES, AND WHY A CALL LANDS IN EACH ONE:
 *
 *   DRIFT — this call exists only because something reached for a name the
 *     relationship verbs already replace. This is what the removal
 *     condition needs to see reach zero.
 *
 *   SANCTIONED — the tool's OWN description blesses this exact shape of
 *     call as legitimate, ongoing, permanent use — never drift, and no
 *     amount of it should block removing anything, because nothing at
 *     "removal" would actually be removing this behavior.
 *
 *   AMBIGUOUS — the tool's own description blesses SOME calls to this tool
 *     as legitimate permanent use, but the call's arguments do not carry
 *     enough information to tell that use apart from drift. Reaching for a
 *     confident DRIFT or SANCTIONED label here would be a guess wearing the
 *     costume of a measurement — exactly the failure mode this ticket
 *     exists to kill on the discovery side (a silent empty journal read as
 *     "zero calls"). An honest AMBIGUOUS is the parallel move on the
 *     classification side.
 *
 * THE RULE, TOOL BY TOOL — re-verify each tool's own `description` in
 * ./defs.ts before trusting this table; a description can change there
 * without this comment being touched:
 *
 *   jira_link_issues — decided by `type`. `type === "Implements"` is
 *     AMBIGUOUS: `relationship.ts`'s own adopt_worker refusal (a worker
 *     already linked to a different boss) tells the caller to reach for
 *     exactly this call to steal it deliberately — the same shape as
 *     habitual drift toward the old alias, and the two are not
 *     distinguishable from `{from, to, type}` alone. Any other `type`
 *     (Blocks, Relates, …) is SANCTIONED — the description calls it "the
 *     only way" to make a non-Implements link.
 *
 *   jira_transition — always DRIFT. Nothing in its description blesses a
 *     permanent use; the relationship verbs fully cover every case it
 *     names.
 *
 *   jira_create_issue — decided by `issuetype` and `implements`.
 *     An Epic is SANCTIONED: new_worker never creates one ("Epics are the
 *     human's" — a Story/Task-only tool), so there is no successor to have
 *     drifted away from, ever; that is a permanent fact about the shape of
 *     the hierarchy, not a gap waiting to be filled. A deliberate orphan
 *     (`implements` trims, case-insensitively, to `"none"`) is also
 *     SANCTIONED: the description says this "still works, unchanged" even
 *     though file_where_it_belongs is the better-documented route for one
 *     kind of orphan. Everything else (a Story/Task with a resolved or
 *     attempted implements/parent target) is DRIFT — exactly the shape
 *     new_worker replaces.
 *
 *   jira_set_priority — always DRIFT. prioritize_worker fully replaces it;
 *     no caveat in its description.
 *
 *   jira_assign — always AMBIGUOUS. Its own description keeps it alive for
 *     "a raw reassignment that isn't an adoption" — legitimate, permanent
 *     — but `{key, assignee}` carries no signal distinguishing that from a
 *     call that should have been adopt_worker.
 *
 *   confluence_create_page / confluence_update_page / confluence_get_page
 *     — always AMBIGUOUS. Each keeps a "general-purpose" / "page that
 *     ISN'T a ticket's doc" use blessed as legitimate, but none of their
 *     arguments (a raw page id, a title, a body) say whether the page in
 *     question is a ticket's own doc or not.
 */

export type AliasClass = "drift" | "sanctioned" | "ambiguous";

/** Build the machine-readable tag appended to an alias tool's audit line. */
export function aliasTag(tool: string, cls: AliasClass): string {
  return `[alias tool=${tool} class=${cls}]`;
}

/**
 * jira_link_issues's classification is decided entirely by its own `type`
 * argument (already resolved to a concrete string, default "Implements",
 * by the caller) — see the tool-by-tool rule above.
 */
export function classifyLinkIssues(resolvedType: string): AliasClass {
  return resolvedType === "Implements" ? "ambiguous" : "sanctioned";
}

/**
 * jira_create_issue's classification is decided by `issuetype` and the raw
 * `implements` argument — see the tool-by-tool rule above. `implementsRaw`
 * is the UNRESOLVED input string (before any parent/target resolution),
 * so this can classify even a call that goes on to refuse for a missing
 * assignee, before the create/link logic has run at all.
 */
export function classifyCreateIssue(issuetype: "Epic" | "Story" | "Task", implementsRaw: string | undefined): AliasClass {
  if (issuetype === "Epic") return "sanctioned";
  const impl = implementsRaw?.trim().toLowerCase();
  if (impl === "none") return "sanctioned";
  return "drift";
}

/** A single alias call recovered from one raw audit-line's worth of text (journal or otherwise). */
export interface ParsedAliasCall {
  /** The caller's `x-issue`, or `"?"` for an untagged connection — verbatim from the line, never inferred. */
  identity: string;
  /** `null` only for an old-format (pre-BUTCHR-63) line, where the tool that was called cannot be recovered without guessing at prose. */
  tool: string | null;
  classification: AliasClass | "unknown";
}

const TOOLS_LINE = /\[tools\]\s+(\S+)\s+→/;
const NEW_ALIAS_TAG = /\[alias tool=([A-Za-z_]+) class=(drift|sanctioned|ambiguous)\]/;
const OLD_ALIAS_MARKER = "[deprecated alias;";

/**
 * Parse ONE line of text (typically one `journalctl` line, journald prefix
 * and all — this matches anywhere in the line, never anchored to its
 * start) into a `ParsedAliasCall`, or `null` when the line isn't a
 * `[tools]`-audited alias call at all (a permanent verb like
 * jira_get_issue, a relationship verb like new_worker, an unrelated daemon
 * log line, …). Pure — no filesystem, no subprocess — so it is fixturable
 * against literal strings, including hand-written pre-BUTCHR-63 lines.
 */
export function parseAliasAuditLine(line: string): ParsedAliasCall | null {
  const idMatch = line.match(TOOLS_LINE);
  if (!idMatch) return null;
  const identity = idMatch[1]!;

  const newMatch = line.match(NEW_ALIAS_TAG);
  if (newMatch) return { identity, tool: newMatch[1]!, classification: newMatch[2] as AliasClass };

  if (line.includes(OLD_ALIAS_MARKER)) return { identity, tool: null, classification: "unknown" };

  return null;
}
