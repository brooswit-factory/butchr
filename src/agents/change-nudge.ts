import type { NotifyReason } from "../resources/types.js";

/**
 * BUTCHR-87: the daemon nudge and the `[notify]` log line for every
 * NotifyReason member EXCEPT `pr` — that one keeps its own dedicated
 * rendering, `prReviewStateNudge` (src/agents/pr-nudge.ts), guarded by
 * test/unit/merge-check-guard.test.ts and deliberately NOT touched by this
 * ticket (see that file's own doc comment, and src/resources/types.ts's
 * NotifyReason doc comment, for why). `changeNudge` and `notifyReasonTag`
 * below are this module's own precedent-following pair: exported functions
 * a test can assert the RENDERED string against, same as `prReviewStateNudge`
 * — not text built inline in src/daemon/index.ts, which a test could only
 * reach by pattern-matching daemon source.
 *
 * Both functions are built on the same `reasonClause` so the two audiences
 * (an agent deciding whether to act, an operator reading the daemon's own
 * log) never drift on WHAT happened — only on how much sentence surrounds
 * it. Widening `NotifyReason` again (a new member) means widening
 * `reasonClause` and `notifyReasonTag` together, in the same commit, for
 * the same reason src/resources/issue.ts's decide() comment gives: a stale
 * renderer beside a correct type is the failure mode this epic exists to
 * kill.
 */

/**
 * BUTCHR-34 (epic comment on this ticket): a bare "updated" is ambiguous
 * between "the poll genuinely could not tell" and "this class was never
 * wired up" — the reader would act on those two differently. This phrase is
 * the honest, distinguishable fallback: it says the classifier ran and came
 * up with nothing in its taxonomy, not that nobody looked. Used whenever
 * `decide()` (src/resources/issue.ts) delivers with no `reason` at all
 * (still possible from a caller that never populates `reason`, e.g. the
 * project tier) OR with `reason: { undetermined: ... }` (BUTCHR-350) — the
 * issue tier's own three-way split of "could not tell" (see
 * NotifyReason's own doc comment, src/resources/types.ts) collapses back to
 * this SAME agent-facing sentence: the finer distinction is operator-facing
 * forensics (`notifyReasonTag` below), not something an agent acting on its
 * own ticket needs to see.
 */
const REASON_NOT_DETERMINABLE = "reason not determinable from the poll";

/**
 * The short, present-tense fact-clause for one non-`pr` NotifyReason — a
 * verb phrase meant to follow "Ticket X " / "About-ticket " (see
 * `changeNudge`), not a full sentence on its own. `pr` is deliberately
 * unreachable here in practice (see this module's top comment) but handled
 * defensively rather than asserted unreachable, since a caller passing one
 * through by mistake should get the honest fallback, not a crash or a
 * silently wrong label.
 */
function reasonClause(reason: NotifyReason | undefined): string {
  if (!reason || "pr" in reason || "undetermined" in reason) return `was updated (${REASON_NOT_DETERMINABLE})`;
  if ("appeared" in reason) return "just appeared in the watch set";
  if ("disappeared" in reason) return "just dropped out of the watch set";
  if ("status" in reason) return `changed status from "${reason.status.from}" to "${reason.status.to}"`;
  if ("label" in reason) {
    const { prefix, from, to } = reason.label;
    return `changed its ${prefix}:* label from ${prefix}:${from ?? "none"} to ${prefix}:${to ?? "none"}`;
  }
  if ("summary" in reason) return "had its summary edited";
  // BUTCHR-351: `reason.comment === null` means the mover was a comment
  // DELETION, not an addition (see NotifyReason's own doc comment) —
  // "got a new comment" would be actively wrong there.
  return reason.comment === null ? "had a comment removed" : "got a new comment"; // "comment" in reason
}

/**
 * The agent-facing channel push for every NotifyReason except `pr` (see
 * this module's top comment — `pr` renders via `prReviewStateNudge`
 * instead). Mirrors the two audiences src/daemon/index.ts's old inline
 * ternary already distinguished: `about === issue` is the ticket's own
 * agent hearing about itself; anything else is a boss/watcher hearing about
 * something it watches via the Implements chain, told explicitly to act on
 * what changed rather than just re-read.
 */
export function changeNudge(issue: string, about: string, reason: NotifyReason | undefined): string {
  const clause = reasonClause(reason);
  return about === issue
    ? `[butchr] Ticket ${issue} ${clause} — re-read it.`
    : `[butchr] ${about} (related to your ${issue}) ${clause} — re-read it, then act on what changed.`;
}

/**
 * The operator-facing `[notify]` log-line tag for ANY NotifyReason,
 * `pr` included — this is the direct successor to src/daemon/index.ts's old
 * inline `transitionTag` ternary (` (pr:from→pr:to)` or `""`), now covering
 * every class instead of only pr:*, and never empty: a delivery that
 * genuinely could not be explained now says so (` (reason: not
 * determinable)`) instead of appending nothing, so the measurement this
 * ticket is answering (`grep '\[notify\]'` — see BUTCHR-34's own journal
 * counts) stays reproducible: every line names why it fired, or says
 * plainly that the poll could not tell.
 *
 * BUTCHR-350 (§3D): two changes to the `comment`/no-reason members, both
 * ADDITIVE to this line's existing shape — `[notify]` itself, and every
 * other reason's rendering, are byte-for-byte unchanged, so no distinct tag
 * is warranted (AC4's concern is a READER silently misparsing an OLD line
 * as a NEW one, or vice versa; nothing in this codebase parses `[notify]`
 * lines programmatically today — grep is the only consumer, and every
 * pre-existing grep pattern this ticket is aware of still matches):
 *   1. `comment` now carries the moved-to comment id (`{comment: string}`,
 *      widened from a bare `true`) — rendered as `(comment:<id>)`, a
 *      SUPERSET of the old `(comment)` literal for any `grep '(comment'`
 *      (prefix, not exact-string) reader. Lets a reader recognise a LATER
 *      `(comment:<id>)` delivery and an EARLIER `(reason: not
 *      determinable …)` delivery for the same key as the SAME underlying
 *      change once the id is known on at least one of the pair — see
 *      `NotifyReason`'s own doc comment (src/resources/types.ts) for how
 *      `decide()` sometimes learns the id even on the earlier delivery now.
 *   2. `reason: { undetermined: ... }` (new — src/resources/issue.ts's
 *      `decide()` emits this INSTEAD OF a bare no-`reason` fallback now)
 *      renders as one of three DISTINCT sentences, replacing the one
 *      collapsed `(reason: not determinable)` that used to cover all three
 *      facts — see NotifyReason's own doc comment for exactly which fact
 *      each one states. `reason: undefined` itself (still possible from a
 *      caller that never populates it) is UNCHANGED: still the bare
 *      `(reason: not determinable)`, pinned by this module's own test
 *      against the literal pre-BUTCHR-350 string.
 */
export function notifyReasonTag(reason: NotifyReason | undefined): string {
  if (!reason) return " (reason: not determinable)";
  if ("pr" in reason) return ` (pr:${reason.pr.from ?? "none"}→pr:${reason.pr.to})`;
  if ("appeared" in reason) return " (appeared)";
  if ("disappeared" in reason) return " (disappeared)";
  if ("status" in reason) return ` (status:${reason.status.from}→${reason.status.to})`;
  if ("label" in reason) return ` (${reason.label.prefix}:${reason.label.from ?? "none"}→${reason.label.prefix}:${reason.label.to ?? "none"})`;
  if ("summary" in reason) return " (summary changed)";
  if ("undetermined" in reason) {
    if (reason.undetermined === "check-failed") return " (reason: could not check — comments fetch failed)";
    if (reason.undetermined === "checked-unchanged") return " (reason: not determinable — checked comments, unchanged)";
    return " (reason: not determinable — comments not checked this poll)"; // "unchecked"
  }
  // BUTCHR-351: `reason.comment` can now be `null` (the comment-deletion
  // edge — see NotifyReason's own doc comment) — rendered as the honest
  // `comment:deleted`, never the literal string "null" a bare template
  // would produce. Still a `(comment:` PREFIX, so AC4's own reasoning for
  // why no distinct tag is warranted (this module's top comment) still
  // holds: additive, not a meaning change to the existing shape.
  return ` (comment:${reason.comment === null ? "deleted" : reason.comment})`; // "comment" in reason
}
