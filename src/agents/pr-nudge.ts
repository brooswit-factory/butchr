/**
 * The single-line channel push sent to an agent when its PR's review state
 * changes (`pr:from → pr:to`). Exported (rather than built inline where it's
 * used) so a guard can assert against the actual rendered string instead of
 * pattern-matching daemon source text — see test/unit/merge-check-guard.test.ts.
 *
 * BUTCHR-56: this used to tell the agent to check `reviewDecision` +
 * `headRefOid`, a pair that cannot detect a stale approval (`headRefOid` is
 * the PR's CURRENT head, so it keeps matching local HEAD after every push,
 * while `reviewDecision` stays APPROVED because this repo doesn't dismiss
 * reviews on push — both signals survive exactly the event they exist to
 * catch). It now names `reviews[].commit.oid` — the field this check
 * anchors on instead of `headRefOid` — and the last-decisive-review
 * ordering, without pasting the full multi-line jq — the agent's own brief
 * has that.
 *
 * BUTCHR-74: `reviews[].commit.oid` is NOT immutable either. GitHub
 * re-points it when the branch takes a merge from its base (a base-merge),
 * confirmed live on PR #135: the review body quotes the approved sha, but
 * both GraphQL and REST report the merge commit instead. So this check
 * cannot detect a head move caused by a base-merge — it is strictly better
 * than the `reviewDecision`+`headRefOid` pair it replaced (which failed on
 * every push), but it is not sufficient, and neither this nudge nor the
 * doc comment above may claim otherwise.
 */
export function prReviewStateNudge(issue: string, from: string | null, to: string): string {
  return `[butchr] ${issue}: your PR's review state changed pr:${from ?? "none"} → pr:${to}. Before merging, verify the last decisive review's own reviews[].commit.oid against your current head — an approval is recorded against a sha, and the branch may have moved since. That check does not detect a head move caused by a base-merge (GitHub re-points reviews[].commit.oid too); your brief has the exact command and the full caveat. Act: approved → merge your own PR; changes-requested → read the review, fix, push, ask for a re-review; merged → do your post-merge duties.`;
}
