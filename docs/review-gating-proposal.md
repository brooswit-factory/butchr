# Review-gating settings for `main`: a proposal, with measured costs

**Written 2026-09-02, Task tier, `BUTCHR-139`, for `BUTCHR-134` (Story) /
`BUTCHR-131` (Epic — "Review-protocol integrity: a recorded approval must
correspond to the code that actually merges").**

**A fresh measurement beats this page.** Every claim below is tagged
**MEASURED** (a command run in this session, output reported), **CITED**
(a claim from another ticket/agent, attributed and dated, not re-run), or
**INFERRED** (reasoned from the other two, premises named). Account
permissions, PR history and branch state are deployment/repository state
and drift independently of this document. Re-run the commands named inline
before trusting a row here.

**Nothing in this document has been executed.** No repository setting,
branch protection rule, ruleset, or required-check configuration has been
changed, created, or removed by this ticket. §2 and §3 propose operator
actions; none of them has been taken.

This document's companion is `docs/identity-model-decision.md`
(`BUTCHR-104`/`BUTCHR-125`), which established, independently, that `main`
is guarded and that the guard does not gate on review, and named the
review-gating gap this document now costs and proposes against. Where this
page repeats a fact stated there, it is a re-verification, not a
duplication.

---

## 0. What this document is answering

Two candidate settings for `brooswit-factory/butchr`'s `main` branch:

- **Proposal 1** — a review-gating rule: require an approving review before
  merge (branch protection already exists on `main`; a rule requiring
  review does not, per §1 below).
- **Proposal 2** — stale-review dismissal (`dismiss_stale_reviews`):
  dismiss an approval outright when new commits are pushed to the PR
  branch, so a moved branch cannot carry a stale-but-still-`APPROVED`
  verdict forward.

Both are operator actions (a human, in the GitHub UI or API with admin).
This ticket forbids taking either action; it delivers the proposal and its
measured costs so a human can act without redoing the work.

---

## 1. Behavioural re-verification (checks A–D and §3.5(a))

Every check below states what result would falsify it, before the command
that was run. All commands were run from this session's worktree,
`brooswit-factory/butchr`, 2026-09-02, against the live repository —
re-run them yourself before trusting a row.

### A. Does `main` currently refuse a direct push?

*Falsifier stated in advance: a rewind-push probe that returns a message
naming the protection hook would CONFIRM a guard; a plain non-fast-forward
rejection would neither confirm nor refute one — the fast-forward check may
simply answer first. If `.protected` reads `false`, that would be evidence
of absence (this field carries no 404 ambiguity).*

- **MEASURED:**
  ```
  $ gh api repos/brooswit-factory/butchr/branches/main --jq '.protected'
  true
  ```
  This field is readable without admin (unlike `/branches/main/protection`,
  which 404s ambiguously for "absent" and "caller lacks admin" alike — the
  trap BUTCHR-100 already hit once). `true` here is not subject to that
  ambiguity.

- **MEASURED:**
  ```
  $ gh api repos/brooswit-factory/butchr/rules/branches/main
  []
  ```
  Empty. This endpoint surfaces **ruleset**-based rules only, not classic
  branch protection — an empty array here does not mean "unguarded," and is
  not read as such below.

- **MEASURED — the safe rewind-push probe** (added to this ticket by
  `BUTCHR-134` mid-session; ancestry verified before pushing, no `--force`
  used, so the ref could not have moved under any protection state):
  ```
  $ git fetch origin --prune
  $ OLD=$(git rev-parse origin/main~5)   # fc91b5b938b5b51767e1103ef33ad5f2599aa1a1
  $ git merge-base --is-ancestor "$OLD" origin/main && echo confirmed
  confirmed
  $ git push origin "$OLD":refs/heads/main
  To https://github.com/brooswit-factory/butchr.git
   ! [rejected]        fc91b5b938b5b51767e1103ef33ad5f2599aa1a1 -> main (non-fast-forward)
  error: failed to push some refs to 'https://github.com/brooswit-factory/butchr.git'
  $ git ls-remote origin refs/heads/main
  dbe4e59e3e612e973d2199fd98c3cf3887efc219   refs/heads/main   # unchanged
  ```
  **Read per the asymmetry stated in advance: this is a plain
  non-fast-forward rejection, not one naming a protection hook. Per the
  falsifier above, this is INCONCLUSIVE — it neither confirms nor refutes a
  guard.** `main` itself did not move (confirmed by the `ls-remote` before
  and after), so the probe was safe as designed, but it did not reach the
  behavioural evidence it was built to surface.

- **MEASURED — a first-hand, real refusal, found while reading PR #177's
  own thread for §1.5(a) below** (not solicited for check A, but it answers
  it): `gh api repos/brooswit-factory/butchr/issues/177/comments` includes,
  verbatim, from `booswrit` (Story tier, `BUTCHR-104`), posted at the
  moment it happened:
  > "Branch protection refused the merge ('the head branch is not up to
  > date with the base branch'), so a base-merge was forced."
  and, later on the same thread:
  > "branch protection refused again ('head branch is not up to date')"

  This is a real, GitHub-issued refusal message, quoted at submission time
  by the agent that received it — first-hand for that agent, CITED here
  since I did not trigger it myself, but it is a recorded refusal, not an
  inference from a settings read. It confirms *some* protection rule is
  active and enforced on `main` (though its wording is about the
  up-to-date requirement specifically — see §1.5(a) — not about review).

- **CITED**: BUTCHR-100's own prior observed refusal (2026-09-02, this
  epic's founding finding) — not re-run here, cited as a prior
  independent data point.

**Verdict on A: `main` is guarded — CONFIRMED**, from `.protected: true`
(not 404-ambiguous) plus a real, quoted, first-hand-recorded refusal
message from GitHub's own pre-receive hook (§ above). **What the guard
actually consists of (which rule, whether it covers a plain force-push,
whether it covers review) is not settled by this alone** — see B and
§1.5(a). The rewind-push probe added mid-session did not itself produce
confirming evidence, and is reported as inconclusive per its own stated
asymmetry, not folded into the confirmation above.

### B. Does merging a PR into `main` currently require an approving review?

*Falsifier stated in advance: `mergeStateStatus: CLEAN` on an open,
zero-approval, green-checks PR into `main` would show review is not
required; a merged PR with zero approvals at merge time would independently
show the same. If both routes disagree, that disagreement is the finding.*

- **MEASURED, route 1 (open PR, live, cost nothing — no scratch PR
  needed):**
  ```
  $ gh pr view 189 -R brooswit-factory/butchr \
      --json mergeable,mergeStateStatus,reviewDecision,statusCheckRollup
  {"mergeable":"MERGEABLE","mergeStateStatus":"CLEAN","reviewDecision":""}
  ```
  (checks: two `SUCCESS`, one `SKIPPED`, one `SUCCESS` — green.) PR #189 is
  one of `BUTCHR-138`'s scratch instrument PRs (read-only for this ticket,
  not touched) — zero approving reviews, green checks, into `main`, and
  `CLEAN`. **A PR with no approval can merge into `main` today.**

- **MEASURED, route 2 (history, this session's 40-PR window — see §2):**
  three PRs merged into `main` in the window with **zero** approving
  reviews at merge time (`reviewDecision: ""`, confirmed via
  `gh api repos/.../pulls/<n>/reviews`, no `APPROVED` state present):
  **#170, #171, #178** — all self-merged (`author == merged_by`). #170 and
  #178 are independently documented, elsewhere, as the epic↔task
  same-GitHub-account collision's honest-refusal cases
  (`docs/identity-model-decision.md` §6) — a real `gh pr review --approve`
  was attempted and refused there for self-review reasons, and the verdict
  was recorded as a ticket `[review]` line instead. #171 was not
  investigated further (out of this ticket's scope to explain why); its
  `reviewDecision` is empty and it merged regardless, which is what
  matters for this check.

**Both routes agree: review is not required to merge into `main` today.**

### C. Does the token this agent runs with hold admin on that repository?

*Falsifier stated in advance: `.permissions.admin: true` would mean this
account can bypass protection rules by default and any proposed rule needs
an explicit "include administrators" / empty-bypass-list setting to bind it.*

- **MEASURED:**
  ```
  $ gh api repos/brooswit-factory/butchr --jq '.permissions'
  {"admin":false,"maintain":false,"pull":true,"push":true,"triage":true}
  $ gh auth status
  ✓ Logged in to github.com account wroosbit
  Token scopes: 'gist', 'read:org', 'repo', 'workflow'
  $ gh api user --jq '.login'
  wroosbit
  ```
  **This account (`wroosbit`) does not hold admin.** It cannot bypass a
  branch-protection rule by default (no "include administrators"
  workaround needed for this identity).

- **The fleet's other GitHub identity, `booswrit`, is not measurable from
  this vantage** — I cannot run `gh api user`/`gh api repos/.../permissions`
  as that account. Per `BUTCHR-134`'s §3.5(b), exactly two GitHub logins
  operate in this repo (`wroosbit`, `booswrit`), each pinned to a tier
  pairing; **whether `booswrit` holds admin is unestablished here and must
  not be assumed to match `wroosbit`'s `false`.** This is listed in §6 as
  an item a person with admin can check in ten seconds
  (Settings → Collaborators, or `gh api repos/.../collaborators/booswrit/permission`
  run as an admin identity) that I cannot check myself.

**Verdict on C: at least one of the fleet's two GitHub identities
(`wroosbit`) cannot bypass protection. The other's admin status is an open
item — see §6.** Any rule proposed below is enforceable against `wroosbit`
by construction; whether it is enforceable against `booswrit` is unproven,
and both proposals below state that explicitly rather than assuming it.

### D. Is stale-review dismissal (`dismiss_stale_reviews`) currently on?

*Falsifier stated in advance: any review record showing `state: "DISMISSED"`
after a push to its PR, where the review had previously been `APPROVED`,
would show dismissal is on. Its absence across many observed push events is
evidence — not proof — that it is off.*

- **MEASURED, re-confirmed directly this session** (not merely inherited
  from BUTCHR-114):
  ```
  $ gh api repos/brooswit-factory/butchr/pulls/176/reviews --jq '.[] | {id,user:.user.login,state,commit_id,submitted_at}'
  {"id":5086851384,"user":"wroosbit","state":"APPROVED", ...}
  {"id":5086884566,"user":"wroosbit","state":"APPROVED", ...}
  $ gh api repos/brooswit-factory/butchr/pulls/177/reviews --jq '...'
  # three records, all state APPROVED
  ```
  No `DISMISSED` state anywhere on either PR, despite both having been
  pushed to (base-merged) after their first approval — this is the same
  observation BUTCHR-114/BUTCHR-100 made, **re-run and re-confirmed live
  in this session, not taken on citation.**

- **MEASURED, extended well beyond #176/#177 — this session's own §2 data
  set independently reproduces the same null result nine more times.** Of
  the 40 PRs sampled for the cost analysis (§2), **11 received at least one
  push after an already-submitted `APPROVED` review, and not one of those
  reviews was ever recorded as `DISMISSED`** — every one stayed `APPROVED`
  (or was superseded by a fresh, separately-submitted `APPROVED` review
  requested by the worker, never by an automatic dismissal). This is the
  strongest evidence in this document for D, precisely because it was
  gathered for an unrelated purpose (§2's cost count) and lands on the same
  conclusion as a side effect.

- **MEASURED:** `rules/branches/main` (checked under A) returned `[]` —
  rules out a **ruleset**-based `dismiss_stale_reviews_on_push` parameter
  specifically. It does not by itself rule out the equivalent **classic**
  branch-protection checkbox, which this endpoint does not surface (see A);
  the direct behavioural evidence above is what actually settles D.

**Verdict on D: stale-review dismissal is off — CONFIRMED**, by direct,
repeated, first-hand behavioural observation across 13 push-after-approval
events on 11 different PRs in this session's own sample, none dismissed.

### §1.5 — the §3.5(a) question: is "branch must be up to date with base" mandatory on *every* merge into `main`?

*Falsifier stated in advance: if every one of this window's PRs merged into
`main` needed a post-approval push to satisfy this rule, the rule is
structurally universal and Proposal 2's cost is "all of them." If some
merged with no post-approval push at all, the rule (even if real) is not
what forces every single merge to invalidate its approval — something else
(reviewing promptly, or updating before requesting review) is already
absorbing part of the cost.*

- **MEASURED — the rule is real**, from two independent, first-hand
  observations:
  1. The quoted GitHub refusal text on PR #177's own thread (§A above):
     *"the head branch is not up to date with the base branch"* — GitHub's
     own words, read directly from the live comment.
  2. **Live, right now**, two of `BUTCHR-138`'s open scratch PRs (#188,
     #190) — zero reviews, green checks, `mergeable: MERGEABLE` — report
     `mergeStateStatus: BEHIND` rather than `CLEAN`, because their base has
     moved since they were opened:
     ```
     $ gh pr view 188 -R brooswit-factory/butchr --json mergeStateStatus,reviewDecision
     {"mergeStateStatus":"BEHIND","reviewDecision":""}
     ```
     `BEHIND` is exactly the signature this ticket names for the
     up-to-date requirement, observed independent of anything I triggered.

- **MEASURED — but the rule is NOT structurally universal in practice,
  contrary to the feared framing.** Of the 18 PRs in this session's window
  (§2) that merged into `main` **with** an approval, **11 (61%)** received
  at least one push after that approval was submitted; **7 (39%) did not**
  — they merged with no push after their approval at all, meaning `main`
  either had not moved since their approval, or they were already
  up to date by the time review happened. **§3.5(a)'s feared "all of them,
  structurally" is not what this window shows.** The up-to-date rule is
  real and binds at merge time, but a meaningful share of merges already
  satisfy it without needing a fresh push after approval — most plausibly
  because review turnaround in this fleet is fast relative to how often
  `main` moves, not because the rule is being routed around.

- **Method note, satisfying the ticket's "cross-check at least two
  sources" requirement:** the above uses PR commit committer dates
  (`gh api .../pulls/<n>/commits`) as the primary source. Spot-checked
  against `gh api issues/<n>/timeline` (`committed`/`reviewed`/`merged`
  event **order**, not timestamps — this repo's timeline events carry
  `created_at: null` for `committed`/`reviewed`) on PR #176 and PR #151:
  both agree on event order with the commit-date method. No disagreement
  found in the PRs checked this way.

**Verdict on §1.5(a): the up-to-date-with-base rule is real and currently
enforced on `main` (CONFIRMED, by a quoted refusal and live `BEHIND`
signature) — but it is not, in this window, forcing a post-approval push
on every merge (61%, not 100%). §2 and §4 use the measured 61% figure, not
the feared "all of them," and this section is the place that resolves that
question rather than leaving it open**, per the ticket's own instruction
that §3/§4 must state which regime they describe.

---

## 2. The cost analysis

### Window, chosen and stated before the count

**The 40 most recently merged pull requests in `brooswit-factory/butchr`,
across all base branches, as of 2026-09-02** (`gh pr list --state merged
--json number,mergedAt,... --limit 300`, sorted by `mergedAt` descending,
top 40 taken). This window spans **2026-09-01T23:59:27Z to
2026-09-02T09:17:17Z** — about 9.3 hours of the fleet's most recent,
ordinary activity, out of 184 total merged PRs in the repository's history.

**Why this window, stated before the numbers below were computed:** "last
N merged" is defensible because it captures current practice rather than
the repository's early history (when conventions may have differed), and N
= 40 was fixed as a round, tractable number before any per-PR data was
pulled — not chosen after seeing which N produced a cleaner result. The
narrowness (9.3 hours) is a property of this fleet's actual current
throughput, not a chosen narrowing — noted as a limitation below, not
hidden.

**Limitation, stated plainly:** a 9.3-hour window cannot speak to
longer-horizon effects (e.g. a boss agent that goes fully offline for
days). §2.4 states exactly what this window can and cannot show about
boss-liveness.

### Method

For each of the 40 PRs: `gh api repos/.../pulls/<n>/reviews` (all reviews,
`state`, `commit_id`, `submitted_at`), `gh api repos/.../pulls/<n>/commits`
(sha, committer date, parent count, message), and `gh api
repos/.../pulls/<n>` (author, merged_by, merged_at, base ref). Commands
were run verbatim per PR and captured to
`/tmp/.../scratchpad/pr_data.jsonl`; the derivation below is reproducible
from that method, not from a script whose logic is undocumented here.

**"After":** for every `APPROVED` review on a PR (not only the last one —
a PR re-reviewed after a push has more than one, and each one that a later
commit follows is a real occurrence of what Proposal 2 would have
dismissed), a commit with `committer.date` later than that review's
`submitted_at` and no later than the PR's `merged_at` counts as "after."
**Committer-date caveat, as the ticket requires it stated:** committer
dates are author-controlled metadata for a hand-made commit, but
**every** post-approval commit found in this window is itself a merge
commit produced by GitHub's own "Update branch" action or an ordinary
`git merge`/direct commit made and pushed within the same session as the
review — none of the timestamps here showed anomalous ordering against the
PRs' own review/merge sequence, and the two timeline cross-checks (§1.5(a))
found no disagreement.

**Shape, per occurrence:** (i) *base-merge only* — every post-approval
commit on that occurrence has 2 parents (a merge of the base, no new
authored diff); (ii) *new authored commits present* — at least one
post-approval commit has 1 parent (real new work landed after approval).

### The numbers

| | main-based (n=21) | other-based, i.e. into a story/task integration branch (n=19) | all 40 |
|---|---|---|---|
| merged with **zero** approving reviews | 3 (#170, #171, #178) | 0 | 3 |
| merged **with** at least one approval | 18 | 19 | 37 |
| of those, received **≥1 push after an approval** ("would have stalled under Proposal 2") | **11 (61.1%)** | **0 (0.0%)** | 11 (29.7% of 37) |
| total stall **events** (some PRs stalled more than once) | 13 | 0 | 13 |
| — shape (i) base-merge only | 12 | 0 | 12 |
| — shape (ii) new authored commits present | 1 | 0 | 1 |
| merged by the PR's own author (self-merge) | 21 / 21 (100%) | 19 / 19 (100%) | 40 / 40 (100%) |

**Stalled PRs (main-based):** #184, #177, #176, #162, #155, #141, #153,
#151, #149, #137, #146.

**The most decision-relevant number in this table, as the ticket asked for
by name:** the shape ratio is **12:1 in favour of the routine, blameless
case.** Of 13 stall events, 12 were a base-merge with no new authored work
— the case that would make Proposal 2 feel unfair, dismissing an approval
for a change nobody needs to re-review. Exactly **one** event (PR #151,
below) is the case dismissal genuinely exists to catch: a real authored
commit landed after approval, and the PR still merged.

**The sharpest single finding in this window, found while gathering §2's
count rather than sought out (`author == merged_by`, `reviewDecision`
empty is filtered out — this PR *had* a formal approval): PR #151.** It
was approved (`wroosbit`, 00:15:49Z, against commit `6774436`). Two more
commits landed after that: a base-merge (00:17:55Z, titled *"Merge main
into BUTCHR-76: branch protection requires an up-to-date head before
merge"*) **and a real authored commit** (00:18:12Z, `changelog: say three
verbs' entries, not four`) — shape (ii). The PR merged two minutes later
(00:20:03Z), self-merged by its own author (`booswrit`), **with no
recorded re-review and no comment on the PR thread explaining why one
wasn't sought** (`gh api issues/151/comments` — empty). Its review record,
re-read live this session, still shows `commit_id: 6774436...` — the
originally-approved commit, not the merged head — which is itself
inconsistent with the "APPROVED reviews always track the current head"
pattern BUTCHR-114/BUTCHR-131 observed on #176/#177/#172 (worth flagging
to route to BUTCHR-114 as a fifth data point, not resolved or built upon
here — see §5's filing note). **Stated at its limit: this document does
not claim #151 merged bad code** — the reviewer may have verified by
content, exactly as BUTCHR-114's own evidence base documents was done on
#176/#177. What is measured, plainly: a real authored change landed after
the recorded approval, and the PR merged on that approval with nothing in
the record showing a second look. That is precisely the failure shape this
whole epic exists to make visible, found in the fleet's ordinary course,
independent of BUTCHR-114's own arms.

### 2.1 — merged by their own author

**All 40 (100%).** Every PR in this window, stalled or not, was merged by
its own author — consistent with `BUTCHR-134`'s brief describing this as
the fleet's normal path, not an edge case. Under Proposal 2, every one of
the 11 stalled main-based PRs would have needed its approval restored by a
**different** account before its author could merge — self-approval is
refused by GitHub, confirmed elsewhere in this fleet's own history
(`docs/identity-model-decision.md` §0, §3).

### 2.2 — the two shapes, and why the split matters

Per §3.5(a) and the table above: (i) base-merge-only dominates 12:1 over
(ii) new-authored-work. Under Proposal 2, **both dismiss the approval
identically** — the setting cannot distinguish them. That is the core of
the fairness objection to Proposal 2: eleven times out of twelve (in this
window), the round-trip it would force is for a change the boss has
already seen, byte-for-byte, arriving from `main` rather than from the
worker.

### 2.3 — how often did `main` move between a PR's approval and its merge

**This is the same 61.1% figure** (11 of 18 approved main-based PRs) —
restated here because §4's mitigation costing needs it directly: in this
window, base-merging **before** requesting review would have avoided the
stall in the 7 PRs that did not need a post-approval push, but would
**not** have avoided it in the 11 that did, because (for those 11) `main`
moved again between the approval and the merge — after any pre-review
update the worker might have done. **The mitigation shrinks the window; it
does not close it**, in these words, as the ticket asked.

### 2.4 — boss-agent liveness: what this window can and cannot show

**Measurable, and measured:** of the 11 stalled main-based PRs, **10**
show a **second** `APPROVED` review recorded after the stalling push (a
real re-review round-trip that actually happened) — direct evidence the
boss agent was alive and responsive for a second hop in those 10 real
cases. The one exception is **#151** (§2 above): no second review was
recorded at all before it merged.

**Not measurable, and not estimated, per the ticket's own instruction:**
whether a boss agent would *still* have been running at the moment a
dismissal-triggered re-review request arrived, for a PR whose boss had
already finished its own work and exited. This window contains no case of
that happening (every re-review that was needed, happened, within the
window's own ~9-hour span) — which is itself informative (short-lived
stalls are recoverable in this fleet's actual cadence) but **does not
answer the longer-horizon question the ticket asks**, and no number is
manufactured for it here. `BUTCHR-134`'s §3.5(b) context — exactly two
GitHub identities serve the fleet's tiers, so there is no third account to
absorb a re-review if the pinned boss account's *agent process* (not the
account itself) has exited — is the structural reason this matters, cited
from that ticket rather than re-derived here.

---

## 3. The two proposals

### Proposal 1 — a review-gating rule on `main`

**What an operator does, concretely:** `main` already has classic branch
protection (`protected: true`, §1A). Adding a review requirement to an
**existing** classic protection config is
`PUT /repos/brooswit-factory/butchr/branches/main/protection` with
`required_pull_request_reviews: { required_approving_review_count: 1 }`
merged into whatever the current body already holds (a `PUT` to this
endpoint replaces the whole protection config — **read the current
config first**, e.g. via the UI, since a non-admin token cannot safely
introspect it here — see §1C). Equivalently, if the operator prefers a
**repository ruleset** instead of classic protection (`rules/branches/main`
reads `[]` today, confirming no ruleset currently applies to `main`):
`POST /repos/brooswit-factory/butchr/rulesets` with a branch ruleset
targeting `main`, a `pull_request` rule type, `required_approving_review_count: 1`.
Either is a single settings action; this document does not recommend one
over the other, only names both since the ticket asks for the concrete
call.

**What it buys:** GitHub will refuse to merge (via UI or API) any PR into
`main` with fewer than the configured number of approvals — closing check
B's finding (§1B) that review is not currently required.

**What it costs, using §2's numbers:** on its own (no dismissal), **zero**
new stalls — a stale-but-still-`APPROVED` approval (the exact case
BUTCHR-114 measured — the recorded commit can follow the branch) still
satisfies this gate, because the gate only checks `reviewDecision`, which
stays `APPROVED` through a base-merge (§1D). **This is precisely why
Proposal 1 alone does not close BUTCHR-114's finding** — it enforces that
*a* review happened, not that the reviewed code is what merges.

**What breaks:** the 3 PRs in this window that merged with zero approvals
(#170, #171, #178) would no longer be able to merge without a review —
including the two documented epic↔task self-review collisions
(`docs/identity-model-decision.md` §6), whose accounts cannot produce a
GitHub approval at all today. **Proposal 1 alone would newly block exactly
the collapsed-hop case that fleet already has an honest-refusal fallback
for** — worth naming since it is a real, live population (3 of 40 in this
window, 7.5%), not hypothetical.

**Admin-bypass question (§2C):** `wroosbit` cannot bypass (not admin).
`booswrit`'s admin status is unmeasured from this vantage (§1C) — **if
`booswrit` holds admin, Proposal 1 is advisory against that identity
unless the operator also enables "include administrators" / an empty
bypass list**, which this document cannot confirm is or isn't already the
case. Flagged for the operator to check directly (§6).

### Proposal 2 — stale-review dismissal

**What an operator does, concretely:** classic protection —
`PUT /repos/brooswit-factory/butchr/branches/main/protection` with
`required_pull_request_reviews: { dismiss_stale_reviews: true }` (requires
`required_pull_request_reviews` to already be configured — i.e. this
setting has no effect unless Proposal 1's gate, or an equivalent, is also
in place, which is why §4 treats the two as an interacting pair rather
than independent line items). Ruleset equivalent: a `pull_request` rule
with `dismiss_stale_reviews_on_push: true`.

**What it buys:** the strongest available remedy for BUTCHR-114's finding,
framed **mechanism-free** per `BUTCHR-134`'s §3.5(c) — regardless of
whether a review's recorded `commit_id` follows the branch or stays fixed,
an approval that is dismissed outright on push cannot be read as covering
code it never saw. It does not matter whether `reviewDecision` plus a
recorded commit distinguishes stale from fresh (§1.5(a)'s own #151 finding
shows, independently, that in this fleet's real history that distinction
was not made even without invoking BUTCHR-114's specific mechanism) —
dismissal removes the ambiguity by removing the stale approval, not by
detecting it.

**What it costs, using §2's numbers:** **11 of 18 (61.1%)** approved,
main-based merges in this window would have had their approval dismissed
at least once before merging — **13 dismissal events total**, 12 of them
(92%) for a base-merge carrying no new authored work. Every one of those
11 PRs was self-merged (§2.1), so every one would have needed its boss
agent to look again, live, before the worker could merge — and per §2.4,
in 10 of 11 real cases the boss agent demonstrably did so within the
window; the 11th (#151) shows what happens today with **no** dismissal and
**no** re-review — under Proposal 2, that PR would have been unable to
merge at all until one arrived.

**What breaks:** the liveness cost `BUTCHR-134`'s §3.5(b) names as
structural, restated in its own terms: with exactly two GitHub identities
serving the fleet's tiers and each tier pinned to one, **there is no third
account anywhere to absorb a re-review.** A worker whose approval is
dismissed cannot repair it (GitHub refuses self-approval, confirmed
elsewhere in this fleet — `docs/identity-model-decision.md` §0) and must
wait on the one specific boss agent process that reviewed it. If that
process has exited, the PR is stuck until a human intervenes — not a
"some friction" cost, a structural one, independent of anything measured
in this window.

**Admin-bypass question (§2C):** identical framing to Proposal 1 — `wroosbit`
cannot bypass; `booswrit`'s status is unmeasured and must be checked by the
operator before trusting the guarantee applies to both identities that
actually merge PRs in this repo.

---

## 4. The interaction, all four combinations, and the mitigation

**With BOTH proposals on:** a worker whose approval is dismissed by a
routine base-merge (12 of 13 events in this window) cannot merge and
cannot un-stick itself — the gate (Proposal 1) now enforces exactly what
dismissal (Proposal 2) just removed. If its boss process has ended, the PR
is stuck for a human. **Under Proposal 1 alone**, the same base-merge is
survivable — the stale approval still counts, satisfying the gate, which
is also why Proposal 1 alone does not close BUTCHR-114's finding (§3).
**Under Proposal 2 alone**, the worker is unblocked (no gate requires the
approval to still be standing) but the guarantee is advisory — nothing
stops an unreviewed-at-merge-time PR like #170/#171/#178 from merging
anyway, dismissal or not.

| combination | integrity (does an unreviewed-diff merge get caught) | autonomy (worker merges its own approved PR without a human) | liveness (does a boss's exit strand a PR) |
|---|---|---|---|
| **neither** (today) | No — §1B/§1D both confirm | Yes, always | No |
| **1 only** | No — stale approval still satisfies the gate (§3, Proposal 1) | Yes, always | No |
| **2 only** | No — nothing requires the (possibly dismissed) approval to be restored before merge | Yes, always | No |
| **both** | Yes — a dismissed approval cannot satisfy the gate | **No, in 61% of this window's approved main-based PRs** (§2) | **Yes, structurally, per §3.5(b)** — for however many of those 61% land on a boss that has exited |

**This table is the trade named plainly, as the ticket asked: only "both"
buys the integrity property BUTCHR-114's finding is about, and it buys it
by giving up autonomy and liveness for a majority of this fleet's actual
main-bound merges, not a minority.**

### The mitigation: base-merge before requesting review, not after

**Costed, not merely listed, per §2.3:** in this window, doing this would
have avoided the stall in the 7 of 18 approved main-based PRs that did
*not* receive a post-approval push — but **not** in the 11 that did,
because `main` moved again, after approval, before merge, in every one of
those 11 cases (that is what "stalled" means in this document's method).
**Stated in the ticket's own required words: this mitigation shrinks the
window; it does not close it.** The residual it leaves is exactly this
window's own headline number — 61% of approved main-based merges, not a
small tail.

**Whether the mitigation is *always possible*:** no — the same reason it
cannot close the window is the reason it cannot be made airtight: `main`
moves under ordinary, concurrent work from other agents, so a branch can
be brought up to date immediately before requesting review and still fall
behind again before a human or agent boss gets to it. The residual shown
above is not a measurement gap; it is what a moving `main` guarantees will
happen some fraction of the time, however disciplined the pre-review
update habit becomes.

### Other mitigations, costed only where costable

- **Last-reviewer-can-bypass:** not costed here — doing so honestly would
  require knowing whether GitHub's bypass-list mechanism can be scoped to
  a specific reviewing identity per-PR (it cannot, in the classic
  protection model — bypass lists are account/team-level, not PR-scoped),
  which makes this mitigation effectively identical in shape to the
  admin-bypass question already covered in §2C/§3, not a distinct option.
- **Require branches up to date before merge, so the base-merge always
  precedes the review round rather than following it:** this is not a
  distinct mitigation from "base-merge before requesting review" above —
  it is the same behaviour enforced structurally rather than by habit.
  Costs the same residual (§2.3), because the enforcement point (merge
  time) cannot move review earlier than whenever the boss actually looks.
- **A second identity that re-approves automatically on a
  content-equivalence check:** **not a free option** — per
  `BUTCHR-134`'s §3.5(b), the fleet has no spare identity; this requires
  provisioning a new account, which is itself an operator action with its
  own cost (not costed further here — out of this ticket's scope to
  design a bot identity).
- **Treat the `[review] APPROVED <pr-url> @ <sha>` Jira line as the
  authoritative record instead of a settings change at all:** this is
  the fleet's existing convention (`BUTCHR-73`, cited via `BUTCHR-134`'s
  evidence base) and is already, today, doing real work — it is exactly
  what let #170 and #178 merge honestly despite a collapsed review hop
  (`docs/identity-model-decision.md` §6). **It is a real alternative to
  both proposals, not merely a fallback**: it is append-only, cannot
  follow a branch the way `reviews[].commit.oid` can (BUTCHR-114's
  finding), and costs no repository setting at all. Its own cost, stated
  plainly: it is **manual** — nothing enforces that a merger actually
  checks it before merging, unlike a GitHub-native gate. §5 weighs this
  against the two settings proposals rather than assuming a settings
  change is the answer.

---

## 5. Recommendation

**Do not enable Proposal 2 (dismissal) alone or in combination with
Proposal 1, on the evidence in this document.** §4's table shows "both" is
the only combination that buys the integrity property, and §2/§4 show it
would have cost autonomy on 61% of this window's approved main-based
merges and carries a structural liveness risk (§3.5(b)) that this window's
short span (9.3 hours) cannot bound — every stall in this window happened
to recover, but the mechanism that makes recovery non-guaranteed (a
two-identity fleet with no spare account) is independent of window length.
**A three-way trade this lopsided, traded away by a settings change rather
than a choice made deliberately each time, is not what this document
recommends**, even though it is the only combination that closes
BUTCHR-114's finding via a repository setting.

**Recommend instead: adopt Proposal 1 (a review-gating rule), and treat
the existing `[review] APPROVED <pr-url> @ <sha>` Jira-line convention as
the authoritative record for whether the code that actually merged was the
code that was actually reviewed — not the GitHub `reviewDecision`/`commit_id`
pair.** This is not a null recommendation:

- Proposal 1 closes §1B's actual gap (review is not required today at
  all) — real and immediate, at effectively zero measured cost in this
  window (§3), aside from the 3 collapsed-hop PRs it would newly block,
  which already have an honest, working fallback procedure
  (`docs/identity-model-decision.md` §6) that does not depend on a GitHub
  `APPROVE` existing.
- The Jira-line convention closes BUTCHR-114's specific finding (a
  recorded commit that can follow the branch) **without** the liveness
  cost §4 measures for Proposal 2, because it asks a human/agent merger to
  check one more append-only fact rather than asking GitHub's merge button
  to enforce one — the cost moves from "structural, fleet-wide, per merge"
  to "a discipline the merge protocol already names" (§8 of this ticket's
  own brief already prescribes exactly this check before merging).
- **What this recommendation trades away, stated plainly per §4's own
  requirement:** the Jira-line check is not GitHub-enforced. Nothing stops
  a merger from skipping it, the way nothing stops a merger from skipping
  any manual step. Proposal 2 would make the check unconditional; this
  recommendation deliberately keeps it conditional on the merger actually
  doing it, in exchange for not stranding 61% of this window's approved
  main-based merges on a boss agent's continued liveness.

**If the operator judges the liveness risk acceptable** — for instance,
because a human is reliably available to unstick a PR whose boss agent has
exited — **Proposal 2 with Proposal 1 is the combination that actually
closes the integrity gap by settings alone**, and §4's table is written so
that choice can be made with the real numbers rather than "there may be
some friction." This document does not make that call; it names the
trade and recommends against it on the evidence gathered, per §5.3's own
instruction to give one clear recommendation while stating what is traded
away.

---

## 6. What could not be determined, and the ten-second admin check for each

| item | why it could not be settled from this vantage | check a person with admin could run |
|---|---|---|
| `booswrit`'s admin/bypass status on this repo (§1C, §3 both proposals) | Only measurable for the token this agent runs as (`wroosbit`) | `gh api repos/brooswit-factory/butchr/collaborators/booswrit/permission` (as an admin identity), or Settings → Collaborators and teams |
| The precise content of `main`'s classic branch-protection config (which checks, which review count if any, `enforce_admins`, existing `dismiss_stale_reviews` value) | `GET .../branches/main/protection` 404s from a non-admin token — ambiguous between absent and forbidden (§1A) | Settings → Branches → edit the rule for `main`, or `gh api repos/brooswit-factory/butchr/branches/main/protection` as an admin identity |
| Whether the rewind-push probe's non-fast-forward rejection would, on a force-capable probe, resolve to a named protection hook or to nothing (§1A) | This ticket forbids any push that could actually move `main`, and a force-push is exactly that class of action | An admin can read the protection rule directly (above) rather than needing to provoke a refusal at all |
| Whether a boss agent's continued *process* liveness (not account existence) would hold for a re-review requested outside this window's 9.3-hour span (§2.4) | No case of a multi-hour-or-longer stall occurred in the sampled window to observe | Not a settings check — an operational/staffing question about how long a boss agent process is kept alive relative to its worker's PR lifecycle |

---

## Provenance

Written 2026-09-02, Task tier, `BUTCHR-139`, host and daemon per this
workspace's own `ENVIRONMENT.md` (not restated here, per this ticket's own
instruction against citing another agent's — or even this document's own
future reader's — environment as settled fact; read your own). Every
MEASURED claim above is a command run in this session against the live
repository; every CITED claim names its source and is not re-asserted as
first-hand. The raw per-PR data underlying §2 (`pr_data.jsonl`, one line
per PR: reviews, commits, metadata, as returned by the `gh api` calls named
in §2's Method) is not committed alongside this document — it is
reconstructible verbatim from the commands given, against whatever the
repository's history looks like when re-run, which is the point: a fresh
re-run is the check, not a frozen data file. Re-run §1's checks and §2's
window before trusting a row of this page for an operator decision made
after this date.
