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
 * `decide()` (src/resources/issue.ts) delivers with no `reason` at all —
 * every field identical but `updated` itself, or a class whose only signal
 * came from a Jira call this poll never made.
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
  if (!reason || "pr" in reason) return `was updated (${REASON_NOT_DETERMINABLE})`;
  if ("appeared" in reason) return "just appeared in the watch set";
  if ("disappeared" in reason) return "just dropped out of the watch set";
  if ("status" in reason) return `changed status from "${reason.status.from}" to "${reason.status.to}"`;
  if ("label" in reason) {
    const { prefix, from, to } = reason.label;
    return `changed its ${prefix}:* label from ${prefix}:${from ?? "none"} to ${prefix}:${to ?? "none"}`;
  }
  if ("summary" in reason) return "had its summary edited";
  return "got a new comment"; // "comment" in reason
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
 */
export function notifyReasonTag(reason: NotifyReason | undefined): string {
  if (!reason) return " (reason: not determinable)";
  if ("pr" in reason) return ` (pr:${reason.pr.from ?? "none"}→pr:${reason.pr.to})`;
  if ("appeared" in reason) return " (appeared)";
  if ("disappeared" in reason) return " (disappeared)";
  if ("status" in reason) return ` (status:${reason.status.from}→${reason.status.to})`;
  if ("label" in reason) return ` (${reason.label.prefix}:${reason.label.from ?? "none"}→${reason.label.prefix}:${reason.label.to ?? "none"})`;
  if ("summary" in reason) return " (summary changed)";
  return " (comment)"; // "comment" in reason
}
