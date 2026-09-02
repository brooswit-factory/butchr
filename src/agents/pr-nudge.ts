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
 * BUTCHR-74/BUTCHR-138: `reviews[].commit.oid` is NOT immutable either — no
 * structured API surface is (`docs/review-commit-immutability.md` has the
 * full measurement; do not re-derive a mechanism here, none survived). A
 * mismatch against the current head is a real signal (the branch's own
 * contribution changed since that review); a match is the narrower claim
 * that it did not, not a guarantee that nothing unreviewed landed (a clean
 * base-merge imports `main`'s own already-reviewed content, which this PR's
 * reviewer never personally read). The field's move is also ASYNCHRONOUS,
 * observed ~30-56s after a base-merge — a read taken right after a push can
 * still be racing that update. Do not assert a specific rewrite mechanism
 * beyond what's observed. It is strictly better than the
 * `reviewDecision`+`headRefOid` pair it replaced (which failed on every
 * push), but it is not sufficient, and neither this nudge nor the doc
 * comment above may claim otherwise.
 */
export function prReviewStateNudge(issue: string, from: string | null, to: string): string {
  return `[butchr] ${issue}: your PR's review state changed pr:${from ?? "none"} → pr:${to}. Before merging, verify the last decisive review's own reviews[].commit.oid against your current head — an approval is recorded against a sha, and the branch may have moved since. A mismatch is a real signal (don't merge); a match is not sufficient on its own: it doesn't mean nothing unreviewed landed (a clean base-merge brings in main's own content, not this PR's reviewer's read of it), and reviews[].commit.oid can take ~30-56s to catch up after a base-merge, so a read taken right after your own push may just be racing that update — wait it out. If in doubt, ask for a re-review or point at the ticket's own [review] comment, pasted (never retyped) from the API — GitHub can't rewrite it, but a hand-typed one can be wrong; your brief has the full caveat. Act: approved → merge your own PR; changes-requested → read the review, fix, push, ask for a re-review; merged → do your post-merge duties.`;
}
