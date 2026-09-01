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
 * BUTCHR-74: `reviews[].commit.oid` is NOT immutable either. Confirmed on
 * two PRs (#135, #136) that GitHub can silently rewrite it to a later
 * commit after a base-merge — on #136 (three reviews) an OLDER review kept
 * its original recorded sha while a LATER review's recorded commit had
 * already moved, matching the current head each time it was re-read. Only
 * a review's own written-at-submission BODY text stays fixed; any
 * structured field can move, and this check reads the LAST decisive
 * review — exactly the one most likely to have been rewritten. Do not
 * assert a specific rewrite mechanism beyond what's observed. It is
 * strictly better than the `reviewDecision`+`headRefOid` pair it replaced
 * (which failed on every push), but it is not sufficient, and neither this
 * nudge nor the doc comment above may claim otherwise.
 */
export function prReviewStateNudge(issue: string, from: string | null, to: string): string {
  return `[butchr] ${issue}: your PR's review state changed pr:${from ?? "none"} → pr:${to}. Before merging, verify the last decisive review's own reviews[].commit.oid against your current head — an approval is recorded against a sha, and the branch may have moved since. That check is not sufficient on its own: reviews[].commit.oid, unlike the review's own body text, can be silently rewritten after a base-merge, and this check reads the LAST review — the one most likely to have moved. If in doubt, ask for a re-review or point at the ticket's own [review] comment (GitHub can't rewrite that); your brief has the full caveat. Act: approved → merge your own PR; changes-requested → read the review, fix, push, ask for a re-review; merged → do your post-merge duties.`;
}
