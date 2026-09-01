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
 * catch). It now names the field that actually records what a reviewer saw
 * (`reviews[].commit.oid`) and the last-decisive-review ordering, without
 * pasting the full multi-line jq — the agent's own brief has that.
 */
export function prReviewStateNudge(issue: string, from: string | null, to: string): string {
  return `[butchr] ${issue}: your PR's review state changed pr:${from ?? "none"} → pr:${to}. Before merging, verify the last decisive review's own reviews[].commit.oid against your current head — an approval is recorded against a sha, and the branch may have moved since; your brief has the exact command. Act: approved → merge your own PR; changes-requested → read the review, fix, push, ask for a re-review; merged → do your post-merge duties.`;
}
