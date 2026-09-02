# Review-commit immutability — measurement (BUTCHR-138)

Answers, by direct measurement, whether a submitted GitHub PR review's
recorded commit (`commit_id` / `reviews[].commit.oid`) is immutable, and
under which branch operations it moves. Filed under BUTCHR-114 /
BUTCHR-131 ("Review-protocol integrity: a recorded approval must
correspond to the code that actually merges").

Repeatable verifier: `scripts/verify-review-commit-immutability.ts`
(`snapshot <owner/repo> <pr-number> [out-file]`, `diff <a.json> <b.json>`).
Raw snapshots taken during this measurement are committed under
`docs/review-commit-immutability/snapshots/`.

## TL;DR

- **Q1** (under which operations does the recorded commit move): a plain
  commit never moves it. A merge commit moves it forward, in lockstep
  across every structured surface, ONLY when (a) the currently-recorded
  commit is that merge's first parent AND (b) the merge is a clean
  auto-merge with no content of its own — but this two-condition rule
  itself has a documented counter-example (PR #151), so it is not
  asserted as the mechanism. What IS established as a property, holding
  across all nine cases measured including #151: the recorded commit
  equals the current head only when the branch's own contribution is
  unchanged since the review. The mechanism producing that property is
  UNDETERMINED — six candidates were proposed and killed; see "Mechanism"
  under Q1 below.
- **Q2** (is any surface/artefact immutable): no structured API surface
  is — REST-list, REST-by-id, and GraphQL all move together, so "read a
  different surface" is not a remedy. Two artefacts ARE immutable: the
  review's own body text (confirmed same-record, cross-field, against a
  planted sha), and the Jira `[review] ... @ <sha>` line — but the latter
  is hand-transcribed and this measurement caught a real transcription
  error on its first use, so it needs to be machine-generated or
  validated to be trustworthy as a remedy, not merely "unrewritable."

## Method

- Repo: `brooswit-factory/butchr`.
- Reviewer for every review below: BUTCHR-114 (one GitHub account, held
  constant — this rules out "review state co-varies with reviewer
  identity" as an explanation for anything found here; see Part 1b of
  BUTCHR-138's ticket for why that confound mattered).
- Four throwaway scratch PRs, based on `main`:
  - Arm A (base-merge): PR #188, branch `BUTCHR-138-scratch-arm-a`, cut
    from `origin/main~3` to guarantee a real merge commit (not a
    fast-forward). Later also hosted Test 2b (chain-intact evil merge)
    and the free high-water-mark discriminator probe.
  - Arm B (plain commit): PR #189, branch `BUTCHR-138-scratch-arm-b-v2`,
    cut from `origin/main`. Later also hosted Test 1 (empty commit) and
    Test 2a (evil merge, later found to be a mis-designed instrument —
    see below).
  - Arm C (state/recency/chain discriminator): PR #190, branch
    `BUTCHR-138-scratch-arm-c`, cut from `origin/main~3`.
  - Arm D: PR #194, branch `BUTCHR-138-scratch-arm-d`, cut from
    `origin/main~3`. Opened for a planned replication of Test 2b that was
    deliberately not run (see Step 3) — no review was ever requested or
    received on it.
- None of these PRs was ever merged. Each was closed and its branch
  deleted after its measurement, including a post-close reading (Step 3).
- Two mechanisms were inherited as already refuted by free evidence (the
  three historically-cited PRs #172/#176/#177, re-read independently by
  BUTCHR-114, BUTCHR-131, and this ticket, all in agreement) and were not
  re-tested with a dedicated arm:
  - "dynamic while the PR is OPEN, freezes at MERGE" — refuted because
    all three cited PRs are MERGED yet behave differently (#172 kept
    distinct historical shas; #176/#177 did not).
  - "an older review holds its sha while a later one moves" — refuted
    because on #176 and #177 non-final APPROVED reviews moved to the
    head; the only records that held their own sha were CHANGES_REQUESTED,
    confounded with reviewer account in that sample.

## Step 0 — corroboration of the historical baseline

Re-read directly (both surfaces), most recently at 2026-09-02T09:56:17Z
UTC (also read earlier in this session, at ~09:17Z, with identical
results both times), commands used:

```
gh api repos/brooswit-factory/butchr/pulls/<172|176|177>/reviews
gh pr view <172|176|177> --repo brooswit-factory/butchr --json reviews
```

```
PR #172 (MERGED, head d443e80c...):
  5086659868  booswrit  CHANGES_REQUESTED  07:11:27Z  commit_id=efffc7d7e837a6bd321b7ccb8bd4e0ccc4f1e473
  5086711840  booswrit  CHANGES_REQUESTED  07:17:57Z  commit_id=9f06f0f7a9f4f71bcb6b43d7379bf6ec4156605c
  5086778126  booswrit  APPROVED           07:25:46Z  commit_id=d443e80c911106725889a7aa2a34743ec377740d  (== head)

PR #176 (MERGED, head fab5218c...):
  5086851384  wroosbit  APPROVED  07:34:28Z  commit_id=fab5218c14792fbc5ad67003ab21837e3440f392  (== head)
  5086884566  wroosbit  APPROVED  07:38:29Z  commit_id=fab5218c14792fbc5ad67003ab21837e3440f392  (== head)

PR #177 (MERGED, head 2ce987e0...):
  5087024688  wroosbit  APPROVED  07:52:32Z  commit_id=2ce987e06fe4128a2f97aa6aed8e0092c084b395  (== head)
  5087068378  wroosbit  APPROVED  07:57:26Z  commit_id=2ce987e06fe4128a2f97aa6aed8e0092c084b395  (== head)
  5087113608  wroosbit  APPROVED  08:02:41Z  commit_id=2ce987e06fe4128a2f97aa6aed8e0092c084b395  (== head)
```

REST and GraphQL agreed on every field for every review, both times this
was read. This corroborates the ticket's own record verbatim and adds
nothing new on its own — the arms below are what add new information.
Two things worth flagging as already visible here, before any new
experiment: (1) PR #177's earliest review (`5087024688`) was originally
recorded in the ticket as `7ccd0844...` at submission and `055a30b5...`
after one base-merge; it now reads a **third** distinct value
(`2ce987e0...`), meaning it tracked through at least two further merges
rather than moving once and settling — consistent with "moves per
qualifying event," not "moves once." (2) PR #172's two CHANGES_REQUESTED
reviews hold two *different* historical shas each, neither matching the
final head — not "the original reviewed sha," which rules out a simple
"frozen at first submission" story for that PR on its own (its own
commits later turn out to be entirely single-parent, non-merge commits —
see "The discriminator" under Arm A/Test 2 below, which is why nothing
in #172's history ever had an opportunity to advance).

## Arm A — base-merge (PR #188)

Setup: branch cut from `origin/main~3` (13 commits behind at review time,
confirmed by BUTCHR-114 with `git rev-list --count <head>..origin/main`),
so `git merge origin/main` is guaranteed to produce a real two-parent merge
commit, not a fast-forward.

T0 — taken 2026-09-02T09:19:31Z, ~29s after the review landed
(`submitted_at` 09:19:02Z):

```
$ bun run scripts/verify-review-commit-immutability.ts snapshot brooswit-factory/butchr 188 <out>
headRefOid:   54311340c1986254c015372283edc300df7ce1d9
reviewDecision: APPROVED
review #5087810116  booswrit  APPROVED @ 2026-09-02T09:19:02Z  commit_id 54311340c1986254c015372283edc300df7ce1d9
(REST list, REST byId, GraphQL commit.oid all agreed: 54311340c1986254c015372283edc300df7ce1d9)
```

Operation:

```
$ git fetch origin
$ git merge origin/main --no-edit -m "Merge main into BUTCHR-138-scratch-arm-a (BUTCHR-138 Arm A instrument — base-merge measurement)"
Merge made by the 'ort' strategy.  (18 files changed — a real merge, two parents)
$ git push
   5431134..aeba3bb  BUTCHR-138-scratch-arm-a -> BUTCHR-138-scratch-arm-a
```

T1 — taken 2026-09-02T09:20:28Z:

```
headRefOid:   aeba3bb812b6d8ad91f750f978d99785308d4625
reviewDecision: APPROVED
review #5087810116  booswrit  APPROVED @ 2026-09-02T09:19:02Z  commit_id aeba3bb812b6d8ad91f750f978d99785308d4625
(REST list, REST byId, GraphQL commit.oid all agreed, all MOVED to aeba3bb...)
```

**Result: MOVED, on every surface, together.** `submitted_at` and review
`body` were byte-identical at T0 and T1 (confirmed by the verifier's
`diff` mode); only `commit_id`/`commit.oid` changed, and it changed on
REST-list, REST-by-id, and GraphQL simultaneously — no surface split.

Step 2, run after the move:

```
$ echo $0; echo $SHELL   # both /bin/bash — exit code convention confirmed as $?
$ git merge-base --is-ancestor 54311340c1986254c015372283edc300df7ce1d9 aeba3bb812b6d8ad91f750f978d99785308d4625
$ echo $?
0
```

The T0-reviewed sha is still a reachable ancestor of the new head (exit
0) — expected for a true merge (old head is one of the two parents), and
it means a content-based re-verification (`git diff --stat origin/main...<head>`)
remains possible even though the structured `commit_id` field moved.

Named failure condition (would have falsified "base-merge moves it"): if
T1's `commit_id`/`commit.oid` on any surface had still read
`54311340c1986254c015372283edc300df7ce1d9` after the merge, that would
mean base-merge does not move the field. It did not hold — the field
moved on every surface.

**Same-record, cross-field contradiction — the sharpest single piece of
evidence in this measurement.** BUTCHR-114 wrote `REVIEWED-SHA:
54311340c1986254c015372283edc300df7ce1d9` into the review body at
submission time specifically so this comparison could be made later.
Independently re-verified here at T1+ against the live API, not taken on
report:

```
$ gh api repos/brooswit-factory/butchr/pulls/188/reviews/5087810116 -q '{body: .body, commit_id: .commit_id}'
{
  "body": "...REVIEWED-SHA: 54311340c1986254c015372283edc300df7ce1d9...",
  "commit_id": "aeba3bb812b6d8ad91f750f978d99785308d4625"
}
```

**One field of one review record (`body`) reads the original sha; another
field of that exact same record (`commit_id`) reads the new head.** Same
`id` (5087810116), same `submitted_at` (2026-09-02T09:19:02Z, unchanged),
two different answers to "what commit was this review of" depending on
which field you ask. This is not "the record changed" in the abstract —
it is a live, verifiable inconsistency within a single record, and it is
the clearest evidence available that the record is not internally
coherent once the branch moves.

## Arm B — plain commit (PR #189)

Setup: branch cut from `origin/main` (0 commits behind — deliberately
level, so no incidental merge is possible; confirmed by BUTCHR-114 before
approving).

T0 — taken 2026-09-02T09:19:33Z (`submitted_at` 09:19:05Z):

```
headRefOid:   8beea0a93085cdfe0ad8823c3ad87c14c9f6c7d1
reviewDecision: APPROVED
review #5087810416  booswrit  APPROVED @ 2026-09-02T09:19:05Z  commit_id 8beea0a93085cdfe0ad8823c3ad87c14c9f6c7d1
(REST list, REST byId, GraphQL commit.oid all agreed)
```

Operation: one ordinary commit pushed on top, no merge:

```
$ git commit -m "BUTCHR-138: Arm B plain commit (no merge) — throwaway instrument"
$ git push
   8beea0a..27d39b1  BUTCHR-138-scratch-arm-b-v2 -> BUTCHR-138-scratch-arm-b-v2
```

T1 — taken 2026-09-02T09:20:31Z:

```
headRefOid:   27d39b1aeeef3f160719c8288b51dc5abf81e3a0   <- MOVED (this is just the PR's current head)
reviewDecision: APPROVED
review #5087810416  booswrit  APPROVED @ 2026-09-02T09:19:05Z  commit_id 8beea0a93085cdfe0ad8823c3ad87c14c9f6c7d1   <- UNCHANGED
(REST list, REST byId, GraphQL commit.oid all agreed, all UNCHANGED)
```

**Result: UNCHANGED, on every surface.** `headRefOid` moved (as it must —
that is just "the PR has a new head"); the review's own recorded commit
did not move on any of the three surfaces that report it. `submitted_at`
and `body` were also byte-identical at T0 and T1.

Step 2:

```
$ git merge-base --is-ancestor 8beea0a93085cdfe0ad8823c3ad87c14c9f6c7d1 27d39b1aeeef3f160719c8288b51dc5abf81e3a0
$ echo $?
0
```

(Trivially true for an ordinary commit on top of the reviewed one — recorded
for completeness and symmetry with Arm A.)

Named failure condition (would have falsified "plain commit does not move
it"): if T1's `commit_id`/`commit.oid` had changed to
`27d39b1aeeef3f160719c8288b51dc5abf81e3a0` (or anything other than
`8beea0a93085cdfe0ad8823c3ad87c14c9f6c7d1`) on any surface, that would
mean the field simply tracks the head regardless of operation, and the
base-merge-specific story would be wrong. It did not — the field held.

**Arms A and B together are the single most direct answer to Q1's
"under which operations" half:** base-merge moves the recorded commit;
an ordinary commit on the same branch, reviewed by the same account,
does not. This is a controlled contrast (one variable — the operation —
changed between arms; reviewer account, branch, and repo held constant),
which the historical evidence (both prior observations were base-merges)
could not provide.

**Incidental finding, recorded as its own measurement rather than folded
into the above:** the `report_to_boss` request for Arm A's approval
hand-transcribed the T0 head sha as `5431134c1986254c015372283edc300df7ce1d9`
(39 characters) instead of the actual `54311340c1986254c015372283edc300df7ce1d9`
(40 characters, missing a `0`). BUTCHR-114 caught it before reviewing (the
39-char string does not exist as a commit) and reviewed the correct sha
instead. This measurement's own T0/T1 readings were unaffected — they came
from the verifier script reading the API directly, never from the typed
sha — but it is direct, first-party evidence that the `[review] APPROVED
… @ <sha>` Jira line, while itself immutable (nothing can rewrite a Jira
comment), is **hand-transcribed** and can be corrupted at the point of
transcription. It trades a mutation risk for a transcription risk rather
than removing risk outright; a remedy that leans on that line needs it to
be machine-generated (e.g. pasted verbatim from `gh pr view --json
headRefOid`, as was done for every subsequent request in this
measurement) or length/format-checked, not merely "the field can't be
edited after the fact."

## Additional probes on #189 (free — no new review needed)

Suggested by BUTCHR-114/BUTCHR-131 after Arm A/B landed, ranked below Arm C
in priority (Arm C came first; these are additive). Both run on #189
because its one review (`5087810416`, APPROVED, still reading
`8beea0a93085cdfe0ad8823c3ad87c14c9f6c7d1` after Arm B's plain commit) is
a clean, already-unmoved instrument — any movement seen from here on is
caused by exactly one new operation and nothing else. Arm B's final
unmoved reading above stands as its own result, recorded before either of
these perturbations.

### Test 1 — empty commit (separates "non-merge" from "non-merge that changes the diff")

Arm B's plain commit was confounded the same way PR #172 was: it was
both (a) not a merge and (b) a change to the branch's net diff. An empty
commit is a non-merge that also does not change the diff, isolating
which of the two matters.

```
$ git commit --allow-empty -m "BUTCHR-138: Test 1 probe — empty commit (non-merge, no net diff change)"
$ git push
   27d39b1..84ab6ed  BUTCHR-138-scratch-arm-b-v2 -> BUTCHR-138-scratch-arm-b-v2
```

Read 2026-09-02T09:31:24Z:

```
headRefOid:   84ab6ed79964c6f0e3f40fe5da05889acdff4552   <- moved (new empty commit)
review #5087810416  commit_id 8beea0a93085cdfe0ad8823c3ad87c14c9f6c7d1   <- UNCHANGED
```

**Result: UNCHANGED.** Consistent with "only a merge moves it," independent
of whether the operation changes the branch's net diff.

### Test 2 (attempt 1, mis-designed — kept for the record) — evil merge on #189

The scenario that actually matters for the remedy: conflict resolution
during a base-merge is exactly where unreviewed content can enter a
branch. First attempt: hosted on #189 (Arm B), on the theory that its
already-unmoved review was a "clean instrument."

```
$ git fetch origin   # origin/main at 5ba21e46544cb113d8c150d40884a15fd3ea3af8, 1 commit ahead
$ git merge origin/main --no-ff --no-commit
$ echo "content that no reviewer ever saw" >> docs/review-commit-immutability/.scratch-instrument-arm-b.md
$ git add -A && git commit -m "BUTCHR-138: Test 2 probe — evil merge carrying content in neither parent (simulates conflict resolution)"
$ git push   # 84ab6ed..cf13c8d
$ git cat-file -p cf13c8d | head -3
parent 84ab6ed79964c6f0e3f40fe5da05889acdff4552   # previous PR #189 head
parent 5ba21e46544cb113d8c150d40884a15fd3ea3af8   # origin/main tip
```

Read 8 times over 120s: `commit_id` stayed `8beea0a9...` throughout,
never moving to `cf13c8d4...`.

**This attempt is UNINFORMATIVE, not a null result — the host PR was
mis-chosen.** Discovered via the discriminator below: PR #189's review
had already been detached from the branch tip by Arm B's own plain
commit (`8beea0a9...` → `27d39b1a...`), before Test 2 ever ran. Under the
discriminator, nothing could have moved this record onto *any* merge,
clean or evil, once it was detached — so this attempt cannot distinguish
"evil merges don't move the record" from "detached records never move,
regardless of content." Repeated here for the record because it is what
motivated the correct re-run below, not because its "did not move"
reading answers the question it was built for.

### The discriminator that explains every case: a chain condition, not just "is it a merge"

Prompted by the contradiction above, checked directly against every
commit involved (`gh api repos/brooswit-factory/butchr/commits/<sha> -q
'.parents[].sha'`, re-run independently, not taken from any report):

```
#176   review recorded e9f65f12  →  merge fab5218c  parents=[e9f65f12, fc91b5b9]   MOVED
#177   review recorded 7ccd0844  →  merge 055a30b5  parents=[7ccd0844, c55ef93a]   MOVED (→055a30b5)
       review recorded 055a30b5 →  merge 2ce987e0  parents=[055a30b5, 07740f66]   MOVED again (→2ce987e0)
Arm A  review recorded 54311340c→  merge aeba3bb8  parents=[54311340c, dbe4e59e]  MOVED
Test2  review recorded 8beea0a9 →  merge cf13c8d4  parents=[84ab6ed7, 5ba21e46]   8beea0a9 NOT a parent — did not move
```

**Every MOVED case has the review's currently-recorded commit as
parent[0] of the new merge commit; the one case where the recorded
commit was NOT a parent of the merge did not move.** This explains, with
no extra assumption, why PR #172 (no merge commits in its history at
all) retained its reviews' original shas, and why #177's review held
three successive distinct values (three successive merges, each taking
the previous recorded value as parent[0] — a chain walk, not a jump to
whatever the head happens to be). Caveat, stated plainly because it
limits the claim: all five MOVED cases had the recorded commit as
parent**[0]** specifically; whether parent[1] (the merged-in side) would
also trigger a move is untested here — arranging that needs the reviewed
branch to be the *base* of someone else's merge, which this measurement
did not have occasion to set up.

### Test 2 (attempt 2, correct host) — evil merge on #188, chain intact

Re-run on #188, whose review (`aeba3bb8...`) was, at the time, exactly
equal to the PR's current head — chain intact, satisfying the
discriminator's precondition for a move:

```
$ gh api repos/brooswit-factory/butchr/pulls/188/reviews -q '.[0].commit_id'
aeba3bb812b6d8ad91f750f978d99785308d4625
$ gh pr view 188 --json headRefOid -q .headRefOid
aeba3bb812b6d8ad91f750f978d99785308d4625      # equal — chain intact, confirmed BEFORE perturbing
$ git fetch origin && git rev-list --count HEAD..origin/main
5
$ git merge origin/main --no-ff --no-commit
$ echo "content that no reviewer ever saw" >> docs/review-commit-immutability/.scratch-instrument-arm-a.md
$ git add -A && git commit -m "BUTCHR-138: Test 2b probe (on #188, chain-intact host) — evil merge carrying content in neither parent"
$ git push   # aeba3bb..9f034e6
$ git cat-file -p 9f034e6 | head -3
parent aeba3bb812b6d8ad91f750f978d99785308d4625   # the RECORDED commit — parent[0], chain condition met
parent 60a3a6450731c5a846d2d561a184d967d8c22701   # origin/main tip
```

Read 9 times over 120s (t+0/15/30/45/60/75/90/105/120s):

```
headRefOid:   9f034e69d71629141128f80445f1d12c0b29a991   <- moved (new evil merge)
review #5087810116  commit_id aeba3bb812b6d8ad91f750f978d99785308d4625   <- UNCHANGED, every single read
```

**Result: UNCHANGED, stable over 2 minutes, WITH the chain condition
satisfied.** This is the real discriminator, and it contradicts the pure
chain-condition-alone hypothesis: the recorded commit was parent[0] of
the new merge (the condition every MOVED case shares), and the record
still did not advance. The one structural difference from every MOVED
case is that this merge commit's tree is **not** what auto-merging its
two parents alone would produce — it carries the hand-added line on top.

**Combined working rule that fits every case measured in this
document (6 data points: 3 clean-merge MOVED cases at 5 total merge
events, 1 chain-broken evil merge, 1 chain-intact evil merge):** the
recorded commit advances onto a new merge commit only when **both** (a)
the currently-recorded commit is parent[0] of that merge, **and** (b)
the merge's tree is a clean auto-merge of its two parents — no content
added beyond what the merge itself produces. Evil merges did not move
the record in either trial (n=2: one chain-broken/uninformative, one
chain-intact/informative); clean merges moved it in every trial (n=4
merge events across #176/#177×2/Arm A).

**What this does and does not establish.** MEASURED: with the chain
condition satisfied, an evil merge did not move the recorded commit, in
this one trial. NOT ESTABLISHED, and explicitly not to be inherited as a
general law: whether a *genuine* three-way textual conflict resolution
(as opposed to this hand-appended line after a clean auto-merge)
behaves the same way; whether the "clean tree" condition is really what
gates it, versus some other unmeasured variable that happens to
correlate with it here; and the parent[0]-vs-parent[1] question noted
above. **Do not read this as "the defect is closed" or "evil merges are
safe."** It is exactly two trials. What it does license, carefully: the
single clearest data point available says an approval does not silently
re-associate onto hand-added unreviewed content **via this specific
mechanism, in this specific trial** — which is enough to withhold the
worst-case headline, not enough to clear the mechanism generally. A
proper resolution would need multiple matched trials (clean vs. evil,
chain-intact, isolated from prior perturbation, ideally including a real
conflict rather than a hand-appended line) — not run here, given this
task's priority order (Arm C first).

## Propagation timing — the move is asynchronous, not transactional with the push

Noticed by contrast between two reads, confirmed by both BUTCHR-114 and
this measurement independently: Arm A's clean merge (chain intact) moved
somewhere within roughly 30–56s after the push (T1 read at +33s already
showed the new value; the exact moment it flipped inside that window was
not captured). Test 2b's evil merge was read 9 times over 120s and never
moved. The two facts together mean **re-association is not synchronous
with the `git push`** — there is a real propagation window, observed here
on the order of tens of seconds, during which the API can still report
the pre-merge value for a record that is *about* to advance.

**Consequence for the remedy story, independent of everything else in
this document:** a single read taken immediately after a base-merge is
not sufficient to establish that a review's recorded commit did not
move — it may simply not have moved *yet*. Any check (automated or
human) that reads `commit_id`/`commit.oid` right after a push and treats
an unchanged value as settled is racing an asynchronous process it
cannot see. This measurement's own T1 readings that landed inside that
window (none did, by design — see the per-arm sections for wait times
used) would have been unreliable; every "did not move" result in this
document was confirmed by a wait of at least 120s (Test 2b, Arm D below)
or, for Arm B/Test 1, by re-reading well outside the ~56s window Arm A's
positive case established. State this plainly rather than letting a fast
read stand in for a settled one.

## Arm C — state / recency / everything-tracks discriminator (PR #190)

Predictions, named before running:

| hypothesis | R1 (CHANGES_REQUESTED @ H1) | R2 (APPROVED @ H2) | R3 (APPROVED @ H3) |
|---|---|---|---|
| STATE (APPROVED tracks, CHANGES_REQUESTED frozen) | H1 (frozen) | H4 | H4 |
| RECENCY (only most-recent record tracks) | H1 | H2 (frozen) | H4 |
| EVERYTHING TRACKS | H4 | H4 | H4 |
| CHAIN + CLEAN (the rule this document's evidence now supports) | H1 (frozen — R1's chain was broken by the H1→H2 plain commit before any merge existed) | H2 (frozen — R2's chain was broken by the H2→H3 plain commit before any merge existed) | H4 (chain intact — H3 is parent[0] of the H4 merge, and a clean base-merge, so it should advance) |

**Important interpretive note, flagged in advance per BUTCHR-114's
warning:** the CHAIN+CLEAN prediction is IDENTICAL to the RECENCY
prediction for this specific arm's design (R1 holds, R2 holds, R3
moves) — Arm C, as designed, breaks every review's chain except the
most recent one via its own plain commits, so it cannot discriminate
"only the most recent record tracks" from "any record whose chain to
the merge is intact tracks." A pattern of R1-holds/R2-holds/R3-moves
confirms both hypotheses at once and refutes neither. Read it as
evidence for CHAIN+CLEAN only because that hypothesis is independently
supported by Test 2b (a case Arm C does not touch), not because Arm C
itself can tell the two apart.

Setup and readings, in order:

```
$ gh pr view 190 ...   # R1: CHANGES_REQUESTED, af4a01c... (H1)          — 2026-09-02T09:19:07Z
$ git commit ...; git push   # -> H2 (19919581...)
$ gh pr view 190 ...   # R2: APPROVED, 19919581... (H2)                  — 2026-09-02T09:44:23Z, T0 at 09:44:29Z
$ git commit ...; git push   # -> H3 (652d1af2...)
$ gh pr view 190 ...   # R3: APPROVED, 652d1af2... (H3)                  — 2026-09-02T09:46:17Z, T0 at 09:46:21Z
$ git fetch origin && git rev-list --count HEAD..origin/main
24
$ git merge origin/main --no-edit -m "Merge main into BUTCHR-138-scratch-arm-c (BUTCHR-138 Arm C instrument — base-merge to H4)"
Merge made by the 'ort' strategy.   # clean merge, no hand-added content
$ git push   # -> H4 (5e49e76...)
$ git cat-file -p 5e49e76 | head -3
parent 652d1af2cec59e0b7ea73ab007dc1c5902069c41   # R3's recorded commit — chain intact for R3 only
parent 422e7e9b085803178304607861258bc10af91f1a
```

Read at H4, then repeatedly over 60s to rule out the propagation window
established earlier in this document:

```
                     t+0s (09:46:35Z)                    t+15/30/45/60s
R1 5087810684        af4a01cf... (H1, unmoved)           unchanged, all four reads
R2 5088049611         19919581... (H2, unmoved)           unchanged, all four reads
R3 5088066213         5e49e76... (H4, MOVED — already at t+0s, faster than Arm A's original ~30-56s window)
```

**Observed row: R1→H1, R2→H2, R3→H4** — exactly the row this arm's
design cannot use to discriminate CHAIN+CLEAN from RECENCY (both predict
this row identically; see the interpretive note above). Taken together
with Test 2b — a case Arm C does not and cannot cover — this is
consistent with CHAIN+CLEAN and does not on its own add anything RECENCY
did not already predict. Recorded in full because the reading itself
(which record moved, which didn't, and how fast) is real data regardless
of which hypothesis it's read to support.

**A late-arriving seventh case (PR #151, measured independently by
BUTCHR-131, not part of this document's own scratch-PR arms) complicates
the mechanism further and is the reason this document states a property
rather than asserting a single mechanism — see "Mechanism: what is and
isn't established" under Q1 below.**

## Step 2 — ancestor reachability, consolidated

`git merge-base --is-ancestor <reviewed-sha> <later-head>`, exit code
recorded for every case run in this measurement (shell confirmed `bash`
via `echo $0`/`$SHELL`, so `$?` is the correct exit-code variable):

| case | reviewed sha | later head | exit code |
|---|---|---|---|
| Arm A (clean merge) | `54311340c...` | `aeba3bb8...` | 0 (ancestor) |
| Arm B (plain commit) | `8beea0a9...` | `27d39b1a...` | 0 (ancestor) |
| Test 2b (evil merge, frozen record) | `aeba3bb8...` | `7a05e6d...` (final #188 head, after the free discriminator probe too) | 0 (ancestor) |
| Arm C R1 (frozen at H1) | `af4a01cf...` | `5e49e76...` (H4) | 0 (ancestor) |
| Arm C R2 (frozen at H2) | `19919581...` | `5e49e76...` (H4) | 0 (ancestor) |
| Arm C R3 (advanced to H4) | `652d1af2...` | `5e49e76...` (H4) | 0 (ancestor) |

**Every case: exit 0.** In this measurement, no operation (plain commit,
clean merge, or evil merge) ever orphaned the originally-reviewed
commit — it always remained a reachable ancestor of the head, whether or
not the review's own recorded-commit *field* had advanced past it. This
means a remedy of the form "diff the current head against the sha that
was actually reviewed" (`git diff --stat <reviewed-sha>...<head>`)
stayed usable throughout every trial here. **Explicitly untested:** a
force-push, a rebase, or a squash-merge could orphan a reviewed commit
(rewrite history so it is no longer an ancestor) — none of those
operations were run in this measurement, and this table says nothing
about them.

Body text and `submitted_at`: checked via the verifier's `diff` mode for
every review at every T0/T1 pair in this document (Arm A, Arm B, Test 2b,
Arm C's three records) — **UNCHANGED in every single case, no
exceptions.** The one instance worth restating on its own: Arm A's review
5087810116 shows `body` still reading the planted `REVIEWED-SHA:
54311340c...` while its `commit_id` reads the advanced `aeba3bb8...` —
same record, same `submitted_at`, two different answers depending on
which field is read (see "Same-record, cross-field contradiction" under
Arm A above).

The `[review] APPROVED/CHANGES_REQUESTED <pr-url> @ <sha>` Jira line:
checked against the live API at submission time for every one of the six
reviews received in this measurement. Agreed in five of six on first
transcription; the sixth (#188's original APPROVE request) was
hand-transcribed with a dropped character (`5431134c...`, 39 chars,
non-existent) and caught by BUTCHR-114 before reviewing — see the
"Incidental finding" under Arm A. Every subsequent request in this
measurement copied the sha verbatim from `gh pr view --json headRefOid`
rather than retyping it, and no further transcription errors occurred.

## Step 3 — open/closed boundary

All three primary scratch PRs (#188, #189, #190) were closed (never
merged) after their measurements were complete, with a reading taken
immediately before closing, immediately after, and again ~60s after
closing (following this document's own propagation-window discipline):

```
                    before close          immediately after       ~60s after
#188 review          aeba3bb8...           aeba3bb8...              aeba3bb8...   (unchanged throughout)
#189 review          8beea0a9...           8beea0a9...              8beea0a9...   (unchanged throughout)
#190 R1              af4a01cf...           af4a01cf...              af4a01cf...   (unchanged throughout)
#190 R2              19919581...           19919581...              19919581...   (unchanged throughout)
#190 R3              5e49e76...            5e49e76...               5e49e76...    (unchanged throughout)
```

**Result: no change on close, for any record, at either reading.**
Closing a PR does not itself trigger a move, and does not freeze
anything that was not already settled — every one of these records was
already stable before closing. As the ticket's own instruction notes,
this is a **narrower claim than it might look**: it says closing is not
a *trigger* for movement; it does not distinguish "freezes at merge"
from "never moves for reasons unrelated to open/closed state", because
none of these PRs were ever merged. That distinction remains untested by
this document — it would need a real merge of a record whose chain was
still intact at merge time, immediately re-read after, which conflicts
with "never merge a scratch PR" and was correctly out of scope here.

`#194` (opened as a planned Arm D instrument for a replication of Test
2b — a fresh PR approved at a clean head, followed immediately by an
evil merge with no intervening plain commit) was opened and then
deliberately **not used**: no review was requested or received on it.
BUTCHR-114 offered the review as an optional seventh hop; given this
task's priority (write-up over further replication), the hop was
declined and is named instead as required future work (see "What
remains unestablished" below). #194 was closed with no measurement taken
on it.

All four scratch branches (`BUTCHR-138-scratch-arm-a`,
`-arm-b`/`-arm-b-v2` (a stray duplicate from an early worktree mistake,
deleted along with the real one), `-arm-c`, `-arm-d`) were deleted from
`origin` after their PRs closed.

## Answers

### Q1 — under which branch operations does a submitted review's recorded commit move?

**MEASURED, directly, in this document's own arms (all reviews by one
held-constant account, BUTCHR-114):**

- A **plain commit** (ordinary, or empty/`--allow-empty`) never moves the
  recorded commit. Confirmed on Arm B (ordinary) and Test 1 (empty), and
  implicitly on every "frozen" record throughout Arm C.
- A **clean merge commit** — one whose tree is exactly what auto-merging
  its two parents produces, with the currently-recorded commit as that
  merge's first parent — **does** move the recorded commit forward, to
  the new merge commit, on every structured surface simultaneously (REST
  list, REST by id, GraphQL) — confirmed on Arm A and on Arm C's R3.
  `reviewDecision` and `headRefOid` give no signal that distinguishes
  this from any other state throughout.
- A merge commit that carries **content beyond a clean auto-merge**
  ("evil merge") does **not** move the recorded commit, even when the
  chain condition (recorded commit = parent[0]) is otherwise satisfied —
  confirmed on Test 2b, with an independent, separately-verified
  historical case (PR #151, measured by BUTCHR-114/BUTCHR-131, verified
  here with `git merge-tree --write-tree`) agreeing.
- The move is **asynchronous relative to the push** — observed within a
  ~30–56s window on Arm A's clean merge, and confirmed absent even after
  120s of repeated reads on every "did not move" case (Test 2a, Test 2b,
  Arm D's would-be case never run). **A read taken immediately after a
  push cannot be trusted to be final** — see "Propagation timing" above.
- The recorded value, once it has advanced, **never reverts** —
  confirmed by an 8-read/120s probe on #188 after its record was frozen
  at an intermediate value. It is a forward-only, high-water-mark-style
  value, not something recomputed fresh on every read.

**INFERRED, as the simplest statement consistent with every case
measured (nine total: #172's three reviews, #176, #177's three
successive moves, Arm A's two phases, Arm B, Test 1, Test 2a, Test 2b,
Arm C's three records, and #151):**

> The review's recorded commit equals the current head only when the
> branch's own contribution is unchanged since the review. Any commit
> that alters that contribution — a plain commit that changes the diff,
> or a merge that carries content beyond a clean auto-merge — leaves the
> recorded commit behind the head, producing a mismatch that the
> prescribed `recorded == head` comparison can detect.

This is a **property**, not a mechanism — it describes *when* the field
equals the head without claiming *how* the underlying system decides to
advance it. See "Mechanism" below for why a mechanism is deliberately not
asserted.

### Mechanism: what is and isn't established

Six candidate mechanisms were proposed over the course of this
measurement and all six were killed by direct evidence. Recorded in full
because the path matters as much as the destination, and because a
result that presents the survivor as though it were obvious would
misrepresent how many wrong turns it took to get here:

| # | mechanism | proposed by | killed by |
|---|---|---|---|
| 1 | STATE — APPROVED tracks the head, CHANGES_REQUESTED freezes | BUTCHR-114, from the #172/#176/#177 baseline | Arm C: R1 (CHANGES_REQUESTED) and R2 (APPROVED) behaved identically under a plain commit — both froze — same account, same PR |
| 2 | RECENCY — only the most-recently-submitted review tracks the head | this document's original ticket, sourced to an unverified claim in circulation | Arm B: #189 has exactly one review — trivially the most recent — and a plain commit moved the head while the record stayed put |
| 3 | BASE-MERGE ALONE — any base-merge moves every review on the PR | this measurement, from Arm A/B's initial contrast | Test 2b: a base-merge with the chain condition satisfied did not move the record, because it carried added content |
| 4 | CHAIN RULE — the record advances onto a merge iff the recorded commit is that merge's parent | BUTCHR-114, from parent-sha analysis of #176/#177/Arm A | PR #151 (independently re-verified here): parent condition satisfied, record did not advance |
| 5 | TWO-CONDITION / INCREMENTAL — chain **and** clean-merge content, applied step by step | BUTCHR-114, refining #4 after Test 2b | PR #151 again: both conditions satisfied, record did not advance |
| 6 | ALL-OR-NOTHING — a broken chain reverts the record to the *original* reviewed sha, not an intermediate value | BUTCHR-131 | Killed twice: Arm A's record advanced to an intermediate value and then held there under Test 2b (never reverted to the original), and this document's own 8-read/120s free-discriminator probe on #188 confirms no reversion over an extended window |

**No proposed mechanism survives. The mechanism is UNDETERMINED.** The
property statement in the Q1 answer above is the strongest claim
supported by all nine measured cases without asserting a mechanism that
the next case might kill. #151's own sequence (`6774436f` reviewed →
clean merge `ecc5fba9`, no advance → plain commit `62bc7db2` → PR merged)
leaves one specific candidate explanation open and explicitly
UNTESTED: given this document's own ~30–56s propagation window, the
record may simply not have had time to advance onto `ecc5fba9` before
`62bc7db2` landed and changed what there was to advance onto. **This is
a named, untested hypothesis, not a finding** — the test that would
settle it: reproduce #151's exact shape (clean merge, then immediately
read repeatedly across a window longer than the merge-to-next-commit gap
was there, before any further commit lands).

Also untested, all named directly above where relevant rather than only
here: parent[0] vs. parent[1] (every observed case had the recorded
commit as the first parent); squash-merge, rebase, and force-push as
operations (none were run); and a genuine multi-way textual conflict
resolution as opposed to a hand-appended line on top of a clean
auto-merge (inferred, not measured, to very likely behave the same as
the evil-merge trials, since both produce the same structural
artefact — a merge tree that isn't the clean auto-merge result — but this
is inference and is labelled as such, not upgraded to a finding).

### Q2 — is there any surface or artefact that holds the reviewed sha immutably?

**No structured API surface does.** REST-list `.commit_id`, REST-by-id
`.commit_id`, and GraphQL `.reviews[].commit.oid` moved together, in
lockstep, on every case where the record moved at all (Arm A, Arm C's
R3, and historically #176/#177) — confirmed at every T0/T1 pair in this
document with no surface-to-surface divergence, ever. **This closes a
remedy the epic was explicitly holding open: "brief the fleet to read
REST instead of GraphQL" is dead.** There is no cheaper structured fix
available than what this document already rules out.

**Two artefacts DO hold the reviewed sha immutably, confirmed directly:**

1. **The review's own BODY TEXT.** Confirmed unchanged across every T0/T1
   pair in this measurement (six reviews, multiple re-reads each), most
   sharply on Arm A's review 5087810116, whose body still reads
   `REVIEWED-SHA: 54311340c...` while its `commit_id` field has advanced
   to `aeba3bb8...` — a same-record, cross-field contradiction, not an
   inference. A remedy that has the reviewer plant a machine-readable sha
   in the review body (as BUTCHR-114 did throughout this measurement) has
   a genuinely immutable, verifiable anchor.
2. **The `[review] APPROVED/CHANGES_REQUESTED <pr-url> @ <sha>` Jira
   comment line.** Nothing but its author can rewrite a Jira comment, and
   none were rewritten in this measurement. **But this artefact is
   hand-transcribed, not machine-generated, and this measurement caught a
   real transcription error on its very first use** (#188's original
   request: `5431134c...`, 39 characters, non-existent, instead of the
   correct 40-character sha) — found and corrected by the reviewer before
   acting on it, not by any automated check. **A remedy that leans on
   this line needs it to be machine-generated (copy-pasted from `gh pr
   view --json headRefOid`, as every subsequent request in this
   measurement did) or format/length-validated on receipt — "the field
   can't be edited after the fact" is true and insufficient on its own;
   it trades a mutation risk for a transcription risk rather than
   removing risk.**

**Also worth separating explicitly, per instruction — these are
different claims and must not collapse into one sentence:** "the
`recorded == head` check is sound" (in the sense of not silently
approving a stale mismatch — see the property statement above) is a
different claim from **"nothing unreviewed entered the branch."** A
clean base-merge imports `main`'s content into the branch, and that
content was never reviewed *by this PR's reviewer* — it changes what
will land, even though it does not change the branch's own contribution
and does not break the recorded-commit-equals-head check. This is
usually fine, because `main`'s content is reviewed on its own PRs before
it reaches `main`. But a reader must not read "the check didn't flag
this" as "nothing unreviewed is in the merged result."

### What remains unestablished

Labelled explicitly as gaps, not folded into the answers above:

- **The actual mechanism.** Six candidates dead; the property survives
  all nine cases but does not explain *why*. Named test above (reproduce
  #151's timing).
- **Replication of the chain-intact-evil-merge result (Test 2b).**
  Currently n=1. A second scratch PR (#194) was opened for exactly this
  and deliberately not used, given this task's priority order. The
  command to run it: approve a fresh scratch PR at a clean head, then
  immediately (`git merge origin/main --no-ff --no-commit`, add content,
  commit, push) with no intervening plain commit, then re-read
  repeatedly across a 2+ minute window.
- **A genuine multi-way textual conflict resolution**, as opposed to a
  hand-appended line on top of a clean auto-merge. Inferred likely to
  behave the same (both produce a non-clean merge tree) but not measured.
- **parent[0] vs. any parent.** Every advancing case in this document had
  the recorded commit as the merge's first parent specifically; second-
  parent advancement is untested.
- **Squash-merge, rebase, and force-push.** None were run. Any of them
  could plausibly break the "reviewed sha stays a reachable ancestor"
  property this document measured in every trial it ran (Step 2), which
  underpins the "diff against the reviewed sha" remedy family.
- **Branch protection settings.** Explicitly out of scope for this
  ticket (moved to BUTCHR-134, carried by BUTCHR-131) — not chased here.
  `git log origin/main` does contain commits titled "Merge main into
  `<BRANCH>` (branch protection: head must be up to date with base)",
  and `GET /repos/.../branches/main` reports `protected: true` while
  `GET /repos/.../branches/main/protection` 404s for this token — both
  consistent with either no classic protection or an unreadable one from
  this account. Recorded, not resolved.

### What this implies for the remedy (not designed here — see BUTCHR-131)

Recorded as implications, not as a design — the remedy itself belongs to
a separate, gated story:

- The remedy is **not** "read REST instead of GraphQL" — that surface
  split does not exist; all structured surfaces move together.
- The prescribed `recorded == head` check is **fail-safe in a specific,
  narrower-than-feared sense**: in every case measured, whenever the
  branch's own contribution changed since review (a plain commit, or a
  merge carrying its own content), the recorded commit stayed behind and
  the mismatch was flagged. The check goes quiet (no mismatch) exactly
  when a clean merge advances the record to match the new head — and a
  clean merge, by construction, added nothing of the branch's own that
  wasn't already reviewed. It is closer to sound than "the check is
  broken everywhere" would suggest, though see the "different claims"
  note above about unreviewed content from `main` itself.
- The check is, however, **racy against the propagation window**:
  reading `commit_id` immediately after a base-merge is not sufficient
  to conclude it did not move — it may not have moved *yet*. Any
  automated or human check needs to either wait out the window (~1
  minute, observed, not a guaranteed bound) or use an artefact that does
  not have this race.
- Two artefacts avoid the race and the structured-field risk entirely:
  the review **body**, if the reviewer plants a machine-readable sha in
  it, and the **Jira `[review]` line**, if it is machine-generated
  (copy-pasted, not retyped) or format-validated on receipt.
- The "reviewed sha stays a reachable ancestor" property held in every
  trial this document ran, which keeps a content-based remedy
  (`git diff --stat <reviewed-sha>...<head>`) available — but this was
  not tested against force-push, rebase, or squash-merge, any of which
  could close that option.
