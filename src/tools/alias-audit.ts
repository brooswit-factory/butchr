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

/**
 * BUTCHR-343 blocker 3, and its own round-2 tightening (BUTCHR-316's review
 * of #348, non-blocking but decided here — see below): before BUTCHR-316/341
 * shipped `[tools2]`, every line carrying a `[tools]` tag WAS an old audit
 * line, so the first `[tools]` on a line was always the real caller's own.
 * `[tools2]`'s free-text `msg=` (an upstream/`ops` error or a `Refusal`
 * message, e.g. `jira_transition` passing its caller-supplied `status`
 * straight into `ops.transition`'s no-match `Error`, which interpolates it
 * verbatim) can itself contain a complete embedded OLD-format fragment, tag
 * and all — e.g. `… msg=no transition to "Done [tools] BUTCHR-1 →
 * transition [alias tool=jira_transition class=drift]" …`. Since `TOOLS_LINE`
 * used to match ANYWHERE in the line, that embedded `[tools]` was, before
 * this guard, indistinguishable from a genuine caller's own tag — see
 * `test/unit/butchr-343-forged-embedded-tags.test.ts` for a `msg=` produced
 * by driving a hostile-but-caller-reachable `status` through the real
 * `withOutcomeRecording` wrapper (the throw site itself is faked, since the
 * real `ops.transition` needs a live Jira — that limit is intentional, see
 * the test's own comment).
 *
 * ROUND 1 of this fix rejected a `[tools]` match only when a `[tools2]` tag
 * preceded it — closing exactly the embedded-in-`msg=` vector above, but (as
 * the reviewer named, explicitly NON-blocking, and left to this file's own
 * judgement) not the more general shape: `TOOLS_LINE` matching anywhere also
 * lets a `[tools]`-tagged fragment embedded in ANY OTHER daemon line — not
 * only a `[tools2]` one — forge an identity+call. This predates BUTCHR-316/
 * 341 entirely (`TOOLS_LINE` has always matched anywhere), so it was never
 * this story's own regression, but the fix for blocker 2's OWN round 2
 * (`src/tools/outcome.ts`'s `OUTCOME_LINE_RE`) already builds the general
 * mechanism this needs — a real structural anchor, not a check against one
 * named tag — so the marginal cost of closing it here too is near zero, and
 * leaving a known, mechanically-identical hole open in the sibling reader
 * once the tooling to close it exists would be an inconsistent posture, not
 * a considered one. Decision recorded here rather than left implicit: CLOSED,
 * not filed as a separate ticket.
 *
 * THE FIX: mirrors `OUTCOME_LINE_RE`'s own doc comment exactly (`src/tools/
 * outcome.ts`) — `[tools]` is always the very first thing `defs.ts`'s
 * `audit` helper puts on its own line (`  [tools] <issue> → <what>`, mod
 * `journalctl`'s own fixed, `-o`-flag-free "short" transport prefix, which
 * this repo never overrides — re-grep before trusting that at your own
 * commit). Anchor the identity match to the START of the line (that prefix
 * optionally aside) instead of searching for it anywhere. Deliberately NOT
 * anchored at the END, unlike `OUTCOME_LINE_RE`: an OLD line's trailing
 * content is genuinely free-form and verb-specific (`get <key>`, `search
 * <jql>`, `transition <key> → <status> [deprecated alias; …] [alias …]`, …)
 * with no single fixed shape to anchor against — the START anchor alone is
 * what "is the line's own tag" requires; requiring a fixed tail shape that
 * does not exist would just make this function reject real lines.
 */
const JOURNALD_SHORT_PREFIX_SRC = String.raw`(?:[A-Za-z]{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\S+\s+\S+?(?:\[\d+\])?:\s*)?`;

const TOOLS_LINE = new RegExp(`^${JOURNALD_SHORT_PREFIX_SRC}\\s*\\[tools\\]\\s+(\\S+)\\s+→`);
const NEW_ALIAS_TAG = /\[alias tool=([A-Za-z_]+) class=(drift|sanctioned|ambiguous)\]/;
const OLD_ALIAS_MARKER = "[deprecated alias;";

/**
 * Parse ONE line of text (typically one `journalctl` line, journald prefix
 * and all — see `TOOLS_LINE`'s own doc comment for exactly what prefix is
 * tolerated and why) into a `ParsedAliasCall`, or `null` when the line isn't
 * GENUINELY a `[tools]`-audited alias call — a permanent verb like
 * jira_get_issue, a relationship verb like new_worker, an unrelated daemon
 * log line, and now also every line where a `[tools]`-shaped fragment is
 * merely embedded inside another line's own free text, a `[tools2]` line's
 * `msg=` included (see `TOOLS_LINE`'s own doc comment above). Pure — no
 * filesystem, no subprocess — so it is fixturable against literal strings,
 * including hand-written pre-BUTCHR-63 lines.
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
