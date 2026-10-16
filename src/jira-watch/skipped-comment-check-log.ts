/**
 * skipped-comment-check-log.ts — FACTORY-922 (implementing story
 * FACTORY-921). `createIssueEventRules`'s §3(D) fallback (src/resources/
 * issue.ts) used to deliver, unconditionally, on a pure `updated` bump it
 * could not attribute to any tracked field — even when the one thing that
 * COULD explain it (a foreign comment) was never actually looked up, or was
 * looked up and the lookup itself failed. That is the ~2-wakes/min/daemon
 * noise this ticket removes: a poll that cannot CONFIRM a diff must not
 * notify. This module is the one place that line is written, so a reader
 * (or a test) has one literal string to grep/parse instead of inline text
 * at the call site — same precedent as `suppressed-log.ts`'s
 * `[notify-suppressed]` lines for the sibling "swallowed, not delivered"
 * concern.
 *
 * Tag is deliberately `[poll]`, not `[notify-suppressed]`: this is not a
 * suppression of an OBSERVED change (every `[notify-suppressed]` emitter
 * already learned a real diff existed and chose not to deliver it) — it is
 * the honest admission that THIS poll could not even determine whether a
 * diff exists. The previous snapshot for `key` is left untouched (see
 * `decide()`'s own comment at the call site), so the identical comparison
 * re-runs next poll; this line is the only place that retry contract is
 * named for an operator reading the journal, not merely inferred.
 */

export const SKIPPED_COMMENT_CHECK_TAG = "[poll]";

/** Why the comment fetch could not confirm a diff this poll — see `fetchComments` in src/resources/issue.ts. */
export type SkippedCommentCheckReason = "load" | "failed";

/**
 * `key`'s comment fetch could not confirm whether a diff exists this poll —
 * `reason` is `"load"` when the fetch itself was never attempted because
 * this poll's own Atlassian call failed with a load-shedding status (429,
 * or a 5xx — the server itself saying "not now", distinct from a genuine
 * client-side failure), `"failed"` for every other rejection (network
 * error, a 4xx other than 429, or no `comments` dep wired at all). The
 * snapshot for `key` is retained (never advanced) by the caller — this line
 * names that fact (`retained-snapshot`) rather than leaving it implicit.
 */
export function skippedCommentCheckLine(key: string, reason: SkippedCommentCheckReason): string {
  return `${SKIPPED_COMMENT_CHECK_TAG} skipped-comment-check key=${key} reason=${reason} retained-snapshot`;
}
