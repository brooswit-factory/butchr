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

*Falsifier stated in advance: a settings read showing `protection.enabled:
false` would be evidence of absence. A protection summary showing
`required_status_checks` with no `required_pull_request_reviews` block
would show the guard exists but does not (today) gate on review.*

**The 404 ambiguity is retired for this check — named as its own finding,
§1.6 below.** `GET /branches/{b}/protection` still 404s ambiguously for a
non-admin token (the trap BUTCHR-100 hit), but `GET /branches/{b}` itself
carries a `protection` **summary** object that does not require admin:

- **MEASURED:**
  ```
  $ gh api repos/brooswit-factory/butchr/branches/main --jq '.protection'
  {"enabled":true,
   "required_status_checks":{
     "checks":[{"app_id":15368,"context":"check"},
               {"app_id":15368,"context":"release gate"}],
     "contexts":["check","release gate"],
     "enforcement_level":"everyone"}}
  ```
  `enabled: true`, one component present (`required_status_checks`, at
  `enforcement_level: everyone` — administrators are not exempt from
  *this* component specifically), **no `required_pull_request_reviews`
  block at all.**
- **MEASURED:**
  ```
  $ gh api repos/brooswit-factory/butchr/rulesets
  []
  $ gh api repos/brooswit-factory/butchr/rules/branches/main
  []
  ```
  Both genuinely empty (not a permission error — both return `200` with
  `[]`). **The protection in force on `main` is classic branch protection,
  not a repository ruleset** — worth stating in one line so a future reader
  does not assume a ruleset is doing this work; §3's operator mechanics
  name the classic knobs accordingly.
- **Caveat that must survive into any future reading of this endpoint,
  stated because it is easy to over-read the finding above:** the
  `branches/{b}` endpoint's `protection` field is a **summary**, not a full
  enumeration of every possible protection component. "Component X not
  shown" is strong evidence that X is not configured, **not proof** — X
  could in principle be omitted from this summary view rather than absent
  from the actual configuration. Below (§1.5(a)) this bites concretely: the
  `strict` sub-field (the actual "require branches up to date" flag) is
  **not present anywhere in this summary**, and that absence is reported as
  a gap, not read as `strict: false`.

- **MEASURED — a first-hand, real refusal, found while reading PR #177's
  own thread for §1.5(a) below** (not solicited for check A, but it answers
  it): `gh api repos/brooswit-factory/butchr/issues/177/comments` includes,
  verbatim, from `booswrit` (Story tier, `BUTCHR-104`), posted at the
  moment it happened:
  > "Branch protection refused the merge ('the head branch is not up to
  > date with the base branch'), so a base-merge was forced."
  and, later on the same thread:
  > "branch protection refused again ('head branch is not up to date')"

  A real, GitHub-issued refusal message, quoted at submission time by the
  agent that received it — first-hand for that agent, CITED here since I
  did not trigger it myself, but a recorded refusal, not an inference from
  a settings read. **This is the observed-behaviour route; the
  `.protection` read above is the settings-read route; they agree** (both
  say a guard exists on `main`), which is the more persuasive shape of
  evidence per this document's own method — two independent kinds of
  reading, not one confirmed fact re-stated twice.

- **CITED**: BUTCHR-100's own prior observed refusal (2026-09-02, this
  epic's founding finding) — not re-run here, cited as a prior independent
  data point.

- **A rewind-push probe was run this session and then explicitly vetoed
  mid-flight by `BUTCHR-131` — reported here as history, not as part of
  the recommended method, per that instruction.** Before the veto arrived,
  an ancestor sha was pushed to `refs/heads/main` with no `--force`
  (verified an ancestor first; a rewind cannot land under any protection
  state). It returned a plain `! [rejected] ... (non-fast-forward)` — not a
  message naming a protection hook — and `main` itself did not move
  (`git ls-remote` before/after unchanged: `dbe4e59e3e...`). **`BUTCHR-131`
  accepted the safety reasoning but overruled running it anyway**, for a
  reason worth preserving rather than only the veto: *a probe whose
  negative result "does not refute" manufactures exactly the kind of
  plausible-but-uncaveated artefact this epic exists to distrust — a
  result quoted later without the asymmetry that made it inconclusive in
  the first place.* No future reader of this document should re-run it;
  the settings-read and observed-refusal routes above answer A more safely
  and more decisively than a probe designed to be safe but not
  necessarily conclusive.

**Verdict on A: `main` is guarded — CONFIRMED, by two independent routes
that agree: a settings read (`protection.enabled: true`) and an observed,
first-hand-quoted refusal.** The guard's content is `required_status_checks`
only, at the summary level read here — no `required_pull_request_reviews`
component appears (see B).

### B. Does merging a PR into `main` currently require an approving review?

*Falsifier stated in advance: `mergeStateStatus: BLOCKED` on an open,
zero-approval-or-CHANGES_REQUESTED, green-checks PR into `main` would show
something gates on review; `CLEAN` on the same shape would show it does
not. A merged PR with zero approvals at merge time would independently show
the same. If routes disagree, that disagreement is the finding.*

**Route 0 — settings read (from A above): no `required_pull_request_reviews`
block appears in `main`'s protection summary at all.** This is the
strongest single fact for B, and it is a settings read, not a gate
evaluation or an observed behaviour — the three kinds of evidence in this
section are typed explicitly because `BUTCHR-131` is right that they carry
different weights.

**Route 1 — gate evaluation, GitHub reporting on itself for the querying
identity (not the same as an attempted merge being refused; `BUTCHR-134`'s
own reading is CITED and time-stamped, mine is MEASURED and separately
time-stamped, and they were taken at different moments — reported as such,
not merged into one fact):**

- **CITED, `BUTCHR-131` via `BUTCHR-134`, this session, before mine:** an
  open PR #182 into `main`, `reviewDecision: CHANGES_REQUESTED`,
  `mergeable: MERGEABLE`, `mergeStateStatus: CLEAN`. Explicit reviewer
  disapproval, still cleanly mergeable — the single strongest data point
  for B, because it isolates the review signal from every other gate.
  **By the time I went to re-read it independently, it had already
  merged** (`gh pr view 182` now returns `state: MERGED,
  reviewDecision: APPROVED, mergeStateStatus: UNKNOWN` — merged PRs stop
  reporting a live merge state). **This is itself a small, live instance
  of exactly the staleness this whole epic is about**, worth recording
  rather than quietly working around: a true, first-hand-measured fact
  ("CHANGES_REQUESTED and CLEAN, as of `BUTCHR-131`'s reading") went stale
  within the span of one session, with nothing in either report signalling
  which reader saw which state unless the reading is time-stamped —
  exactly the discipline `docs/identity-model.md` names as its own rule
  ("a claim written as a measurement, with a date and a vantage, stays
  good as written").
- **MEASURED, this session, replacing the now-unrepeatable #182 read with a
  live equivalent:** `gh pr view 192` — `reviewDecision: APPROVED`,
  `mergeStateStatus: BLOCKED`. At first glance this looks like it could cut
  the other way (approved, yet blocked) — but `BUTCHR-131`'s own caveat
  applies exactly here: `BLOCKED` has more than one cause, and must not be
  attributed to review without ruling out checks. `gh pr view 192 --json
  statusCheckRollup` shows two `check` runs and one `release gate` run
  still `IN_PROGRESS` at read time. **The block is fully explained by
  pending status checks — consistent with "no review gate," not evidence
  against it.**
- **MEASURED, this session, a live snapshot of every open PR into `main`:**
  ```
  $ gh pr list -R brooswit-factory/butchr --base main --state open \
      --json number,reviewDecision,mergeStateStatus,mergeable
  192  APPROVED           BLOCKED   (pending checks, see above)
  191  APPROVED           CLEAN
  190  CHANGES_REQUESTED  BEHIND    (confounded by the up-to-date rule — not usable to isolate the review signal)
  189  APPROVED           BEHIND    (same confound)
  188  APPROVED           BEHIND    (same confound)
  ```
  None of these five is a live, unconfounded repeat of #182's shape
  (zero/negative review, not `BEHIND`) — noted rather than manufactured;
  #182's own reading (CITED above) stands as the decisive instance of this
  route, not re-created live.

**Route 2 — observed behaviour, history (this session's 40-PR window — see
§2):** three PRs merged into `main` in the window with **zero** approving
reviews at merge time (`reviewDecision: ""`, confirmed via `gh api
repos/.../pulls/<n>/reviews`, no `APPROVED` state present): **#170, #171,
#178** — all self-merged (`author == merged_by`). #170 and #178 are
independently documented, elsewhere, as the epic↔task same-GitHub-account
collision's honest-refusal cases (`docs/identity-model-decision.md` §6) — a
real `gh pr review --approve` was attempted and refused there for
self-review reasons, and the verdict was recorded as a ticket `[review]`
line instead. #171 was not investigated further (out of this ticket's
scope to explain why); its `reviewDecision` is empty and it merged
regardless, which is what matters for this check.

**All three routes agree: review is not required to merge into `main`
today.** Presented as three independent kinds of evidence that would have
had to be wrong in the same direction simultaneously to produce this
agreement by accident — a settings read, a gate evaluation (twice, at two
different moments, one now-unrepeatable and reported as such), and
observed merge history.

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

- **The fleet's other GitHub identity, resolved: CITED, first-hand for that
  token, from `BUTCHR-134`** (I did not run this myself, so it is not
  MEASURED here — re-run it as an admin identity to confirm both readings
  at once): `BUTCHR-134` runs as `booswrit` and reports, this session:
  ```
  $ gh api user --jq '.login'
  booswrit
  $ gh api repos/brooswit-factory/butchr --jq '.permissions'
  {"admin":false,"maintain":false,"pull":true,"push":true,"triage":true}
  ```
  Combined with `docs/identity-model.md`'s account map — exactly two
  GitHub logins operate in this repo, `wroosbit` and `booswrit` — this
  identifies the specific second identity precisely, unlike the earlier,
  more hedged reading this document carried before `BUTCHR-134`'s review.

**Verdict on C: neither of the fleet's two GitHub identities holds admin
on this repository.** `wroosbit` — MEASURED, this session, my own token.
`booswrit` — CITED, first-hand for that token, from `BUTCHR-134`, same
session. **Both proposals below are therefore enforceable against every
identity that actually authors or merges PRs in this repo, not advisory
against one of them** — this materially strengthens both, and §3/§5 are
written on that footing rather than the earlier hedge.

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

- **MEASURED — and this sharpens D beyond "off," per the settings read in
  A:** `dismiss_stale_reviews` is a field **inside** the
  `required_pull_request_reviews` block. `main`'s protection summary (§A)
  has no such block at all. **Dismissal is not merely disabled — there is
  no container for it to be configured in today.** `rules/branches/main`
  and `rulesets` (checked under A) both returned `[]`, ruling out a
  ruleset-based equivalent too.

**Verdict on D: stale-review dismissal is off, and more specifically not
currently configurable at all (no `required_pull_request_reviews` block
exists to hold it) — CONFIRMED** by a settings read that agrees with
direct, repeated, first-hand behavioural observation across 13
push-after-approval events on 11 different PRs in this session's own
sample, none dismissed.

### §1.5 — the §3.5(a) question: is "branch must be up to date with base" mandatory on *every* merge into `main`?

*Falsifier stated in advance: if every one of this window's PRs merged into
`main` needed a post-approval push to satisfy this rule, the rule is
structurally universal and Proposal 2's cost is "all of them." If some
merged with no post-approval push at all, the rule (even if real) is not
what forces every single merge to invalidate its approval — something else
(reviewing promptly, or updating before requesting review) is already
absorbing part of the cost.*

- **Settings read attempted, and reported as a gap rather than assumed:**
  the actual flag for this requirement, in classic branch protection, is
  `required_status_checks.strict`. **It does not appear anywhere in `main`'s
  protection summary** (§A's full `.protection` output, quoted there in
  full — `checks`, `contexts`, `enforcement_level`, no `strict` key). Per
  the summary caveat already named in §A: this is **not** read as
  `strict: false` — the summary may simply not surface that sub-field —
  and it is **not** read as confirming `strict: true` either. **Genuinely
  unresolved from this endpoint**, listed in §6.
- **MEASURED — the rule is nonetheless real, from behavioural evidence
  independent of the unresolved settings field, from two first-hand
  observations:**
  1. The quoted GitHub refusal text on PR #177's own thread (§A above):
     *"the head branch is not up to date with the base branch"* — GitHub's
     own words, read directly from the live comment.
  2. **Live, right now**, three of `BUTCHR-138`'s open scratch PRs (#188,
     #189, #190) — zero-or-negative reviews, green checks, `mergeable:
     MERGEABLE` — report `mergeStateStatus: BEHIND` rather than `CLEAN`,
     because their base has moved since they were opened:
     ```
     $ gh pr view 188 -R brooswit-factory/butchr --json mergeStateStatus,reviewDecision
     {"mergeStateStatus":"BEHIND","reviewDecision":""}
     ```
     `BEHIND` is exactly the signature this ticket names for the
     up-to-date requirement, observed independent of anything I triggered
     and independent of the unresolved `strict` field above.

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

### §1.6 — a reusable finding: the 404 ambiguity is retired, with a caveat of its own

**Named here as a durable finding, not just used inline above, per this
ticket's own added deliverable.** BUTCHR-100 corrected an earlier, looser
claim after discovering that `GET /repos/{o}/{r}/branches/{b}/protection`
404s ambiguously — identically for "no protection configured" and for "the
caller lacks admin and cannot see it." That ambiguity is why this whole
document re-verified rather than inherited.

**What retires it:** `GET /repos/{o}/{r}/branches/{b}` (the branch
resource itself, not its `/protection` sub-resource) carries a `protection`
field that **is** readable without admin, and returns a real summary
(§A above) rather than a 404. A future agent hitting the same ambiguity on
`/protection` should read `/branches/{b}` instead of concluding "cannot be
determined without admin."

**The caveat that keeps this from becoming the next over-read signal,
stated with the same weight as the finding:** `/branches/{b}`'s
`protection` field is a **summary**, not a full enumeration. This document
hit that caveat concretely once already (§1.5(a) — the `strict` sub-field
is simply absent from the summary, neither confirmed nor denied) and it
should be expected to bite again on other sub-fields not yet needed here.
**"Not shown in this summary" is evidence of absence, not proof of it** —
weaker than the sub-resource read would be, if that read were available
without admin, which it is not. Use the summary as the first, cheap,
non-admin-gated check; do not treat a component's absence from it as final
without also checking, where possible, an independent behavioural signal
(as A, B and D above each do).

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
pattern BUTCHR-114/BUTCHR-131 observed on #176/#177/#172. **This is routed
to `BUTCHR-114` through `report_to_boss` at submission time, not built
upon here** — per this ticket's own §6, coordination with BUTCHR-114 goes
through `BUTCHR-134`, not directly, and this document does not treat the
observation as resolving or contradicting BUTCHR-114's own mechanism work.
**Stated at its limit: this document does
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
GitHub identities serve the fleet's tiers, so there is no third *agent*
account to absorb a re-review if the pinned boss account's *agent process*
(not the account itself) has exited — is the structural reason this
matters, cited from that ticket rather than re-derived here.
`docs/identity-model-decision.md` §1 records the fleet as holding three
Atlassian accounts in total, not two — the third is the human's own
identity, not assigned to any agent tier. That third account is exactly
the "until a human intervenes" fallback this document already names below,
not a fourth, undiscovered agent identity — scoped here so this claim does
not read as contradicting that document sitting next to this one.

---

## 3. The two proposals

### Proposal 1 — a review-gating rule on `main`

**What an operator does, concretely:** `main` already has classic branch
protection with one component configured, `required_status_checks` (§1A's
full read). Adding a review requirement means adding the
`required_pull_request_reviews` **container** to the same config —
`PUT /repos/brooswit-factory/butchr/branches/main/protection` with a body
that **includes both** the existing `required_status_checks` block
unchanged (a `PUT` to this endpoint replaces the whole protection config,
not just the block named — omitting `required_status_checks` from the body
would silently drop today's check requirement) **and** a new
`required_pull_request_reviews: { "required_approving_review_count": 1,
"dismiss_stale_reviews": false }` block. Equivalently, as a **repository
ruleset** instead (`rulesets` and `rules/branches/main` both read `[]`
today, §1A — no ruleset currently applies to `main`, so this would be a new
one, not an edit): `POST /repos/brooswit-factory/butchr/rulesets` with a
branch ruleset targeting `main`, a `pull_request` rule type,
`required_approving_review_count: 1`. This document does not recommend one
mechanism over the other; §1A already shows classic protection is what
`main` uses today, so extending it is the lower-friction path, but a
ruleset is equally capable of expressing Proposal 1 on its own.

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

**Admin-bypass question (§2C):** neither `wroosbit` nor `booswrit` holds
admin (§1C — one measured directly, one CITED first-hand from
`BUTCHR-134`). **Proposal 1 would be enforced against both identities that
actually author and merge PRs in this repo, not advisory against either.**
An admin identity (if any exists on this repo at all — unconfirmed, §6)
would still need an explicit "include administrators" setting to bind, but
that no longer matters for either of the two accounts actually doing the
work.

### Proposal 2 — stale-review dismissal

**What an operator does, concretely, and the nesting that makes this not
independent of Proposal 1:** `dismiss_stale_reviews` is a field *inside*
the same `required_pull_request_reviews` container Proposal 1 creates
(§1D) — there is no separate top-level toggle for it. `PUT
/repos/brooswit-factory/butchr/branches/main/protection` with
`required_pull_request_reviews: { "required_approving_review_count": N,
"dismiss_stale_reviews": true }`, again alongside the existing
`required_status_checks` block in the same request body.

**Settled from GitHub's documented API contract (read, not attempted, per
this ticket's explicit instruction) — is a container with
`required_approving_review_count: 0` and `dismiss_stale_reviews: true`
valid, i.e. is "Proposal 2 with no merge-blocking gate" reachable on its
own?** GitHub's REST reference for this endpoint states
`required_approving_review_count`: *"Specify the number of reviewers
required to approve pull requests. Use a number between 1 and 6 or 0 to
not require reviewers"* — `0` is an explicitly documented valid value —
and states `dismiss_stale_reviews` as an independent boolean with no
documented constraint tying it to a nonzero review count. **So yes: `count:
0` with `dismiss_stale_reviews: true` is a reachable configuration** —
dismissal fires on every push (any voluntary approval given is withdrawn),
but nothing blocks a merge with zero current approvals, so the gate stays
advisory and a worker is never stuck. This is the shape §4 calls
"Proposal 2 alone," and it is real, not merely theoretical.

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
*agent* account anywhere to absorb a re-review** (the fleet's third
Atlassian account, per `docs/identity-model-decision.md` §1, is the
human's own identity — the fallback this section already names, not a
spare agent). A worker whose approval is
dismissed cannot repair it (GitHub refuses self-approval, confirmed
elsewhere in this fleet — `docs/identity-model-decision.md` §0) and must
wait on the one specific boss agent process that reviewed it. If that
process has exited, the PR is stuck until a human intervenes — not a
"some friction" cost, a structural one, independent of anything measured
in this window.

**Admin-bypass question (§2C):** identical footing to Proposal 1 — neither
identity holds admin, so wherever this proposal's gate does bind (i.e. the
`count ≥ 1` combination, "both" in §4), it binds against both real
identities, not one.

---

## 4. The interaction, all four reachable states, and the mitigation

**Not four independent toggles — one container with two sub-fields, per
§3's nesting.** `dismiss_stale_reviews` lives inside
`required_pull_request_reviews`; there is no way to configure dismissal
without that container existing. But §3 already settled, from GitHub's own
documented schema rather than by attempting the call, that
`required_approving_review_count: 0` alongside `dismiss_stale_reviews:
true` is valid — so all four states below are genuinely reachable, just
not as four independent switches. Presented as what an operator actually
configures, not as an abstract matrix:

- **neither** — today's state: no `required_pull_request_reviews` block.
- **Proposal 1 alone** — the block exists, `required_approving_review_count
  ≥ 1`, `dismiss_stale_reviews: false` (or omitted, same default).
- **Proposal 2 alone** — the block exists, `required_approving_review_count:
  0`, `dismiss_stale_reviews: true`. Dismissal fires on every push; nothing
  blocks a merge with zero current approvals.
- **both** — the block exists, `required_approving_review_count ≥ 1`,
  `dismiss_stale_reviews: true`.

**With BOTH on:** a worker whose approval is dismissed by a routine
base-merge (12 of 13 events in this window) cannot merge and cannot
un-stick itself — the gate (`count ≥ 1`) now enforces exactly what
dismissal just removed. If its boss process has ended, the PR is stuck for
a human. **Under Proposal 1 alone**, the same base-merge is survivable —
the stale approval still counts, satisfying the gate, which is also why
Proposal 1 alone does not close BUTCHR-114's finding (§3). **Under
Proposal 2 alone** (`count: 0` + dismissal), the worker is unblocked (no
gate requires an approval, dismissed or not, to be standing) but the
guarantee is fully advisory — nothing stops an unreviewed-at-merge-time PR
like #170/#171/#178 from merging anyway, dismissal or not, exactly as
today.

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
  the fleet's existing convention — `docs/identity-model-decision.md` §6
  names its origin as `BUTCHR-73`, a citation I have not independently
  traced beyond that document (not `BUTCHR-134`'s own ticket text, which
  does not mention `BUTCHR-73` — corrected here after `BUTCHR-134` flagged
  the earlier, wrong attribution) — and is already, today, doing real work
  in this repo. It is exactly
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

**This recommendation is, explicitly, the "change nothing — strengthen the
existing convention instead" outcome named by `BUTCHR-131` as a passing
result for this story, not a consolation one.** The ticket asked for a
costed recommendation, not a predetermined one; the numbers in §2 and the
nesting in §3/§4 are what produced this answer, not a starting preference
being confirmed.

**One data point for that recommendation, from this ticket's own write
path while this story ran, filed as `BUTCHR-140`:** `correct_worker`
failed on this ticket's own description with `CONTENT_LIMIT_EXCEEDED`
mid-session, leaving `BUTCHR-139` with three records of its own
requirements — the Jira description, the on-disk `brief.md`, and a
comment — of which the two that read as authoritative on their face (the
description, the brief) are the two that went stale first. Same failure
family this document is about, arriving from this fleet's own tooling
rather than from GitHub: a field that reads as the record and is not one.
It strengthens, rather than merely illustrates, the case above for a
stated protocol over a trusted field.

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
| Whether **any** account holds admin on this repo at all (§1C) | Both measured identities (`wroosbit` MEASURED, `booswrit` CITED first-hand from `BUTCHR-134`) read `admin: false`. Neither of us can enumerate collaborators to see whether some third, non-agent account holds it | `gh api repos/brooswit-factory/butchr --jq '.permissions'` as any other collaborator, or Settings → Collaborators and teams — confirms both readings above at once and closes this residual |
| `required_status_checks.strict` — the actual "require branches up to date before merging" flag (§1.5(a)) | Absent from `GET /branches/main`'s `protection` summary, which is documented here as a *summary*, not a full enumeration — its absence is reported as a gap, not read as `false` | `gh api repos/brooswit-factory/butchr/branches/main/protection --jq '.required_status_checks.strict'` as an admin identity, or Settings → Branches → edit the rule |
| `enforce_admins` / whether an admin token can bypass `main`'s protection entirely, beyond what `enforcement_level: everyone` on `required_status_checks` already implies for that one component | Not present in the non-admin summary; the summary shows *one* component's own enforcement level, not a repo-wide bypass-admins flag | `gh api repos/brooswit-factory/butchr/branches/main/protection --jq '.enforce_admins'` as an admin identity |
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
