# The `expect() calls` tally is not safe to compare — measurement and decision (BUTCHR-162)

Settles, by direct measurement rather than by inheriting BUTCHR-107's
hypothesis, whether `bun test test/unit`'s reported `expect() calls` tally
is safe to use as evidence that "no assertion was weakened or removed"
between two points in the test suite's history. Filed under BUTCHR-113
("The test suite's reported `expect() calls` tally is non-deterministic"),
epic BUTCHR-118.

## TL;DR

- **Falsifier, stated before running it:** a stable tally across ≥4 runs of
  an unchanged tree would refute the story's premise. It did not hold —
  measured independently by three parties (BUTCHR-107, BUTCHR-113's own
  review, and this ticket), on different hosts, different commits: the
  tally moves while pass/fail counts stay perfectly stable.
- **Root cause DIAGNOSED, not inherited.** At least one concrete test —
  `test/unit/blocked.test.ts`, `"onTick fires once per poll..."` — drives a
  real `setTimeout`-based poll loop over a fixed wall-clock window and then
  loops `expect()` once per captured tick. The number of ticks a fixed
  real-time window captures is a function of OS scheduler timing, so that
  loop's iteration count — and therefore the file's own `expect()` count —
  varies run to run, confirmed even with this ONE file run in complete
  isolation (no other test files loaded at all). The same architectural
  pattern (real-timer poll loop → array of captured ticks → one `expect()`
  per array entry) recurs at scale elsewhere in `test/unit/` — see
  "Evidence" below.
- **DECISION: the tally is not pinned by this ticket.** The variance is
  produced by a widespread, deliberate testing technique (asserting on the
  actual behavior of a real-timer polling loop over real wall-clock time),
  not a single bug — pinning it fully would mean auditing and likely
  rewriting the timer-driven assertions in a dozen-plus files (see
  "Evidence"), which is disproportionate to and riskier than what this
  ticket owns. This is a legitimate outcome, not a fallback: see
  `briefs/story.md` / `briefs/epic.md` for the guidance this decision
  produced.
- **The substitute:** read the diff for removed assertion lines, not the
  tally. See "The substitute" below for the exact command and its two
  known defects, both handled or stated explicitly.

## Method

Both the falsifier and the diagnosis below were run in a git worktree of
`brooswit-factory/butchr`, on the same commit
(`57407dd8c73e5c0d9bfe91fc6c04d4d8f2b6cde6`, the commit `BUTCHR-113` was cut
from) with a clean working tree confirmed via `git status --porcelain`
before and between runs. Runtime version, core count and host identity are
this session's own measurements (`bun --version`, `nproc`), read from this
workspace's own `ENVIRONMENT.md` rather than copied from any ticket — a
future reader on a different host should do the same rather than trust
these numbers as universal:

```
bun --version: 1.3.14
nproc: 4
```

## Falsifier — repeated runs of an unchanged tree

Command: `bun test test/unit`, repeated with nothing touched between runs.
Raw tally lines, verbatim, across two separate batches:

```
43280 expect() calls   1397 pass  0 fail
43279 expect() calls   1397 pass  0 fail
43264 expect() calls   1396 pass  1 fail   (one flaky failure this run; see note below)
43279 expect() calls   1397 pass  0 fail
43277 expect() calls   1397 pass  0 fail
43279 expect() calls   1397 pass  0 fail
43273 expect() calls   1397 pass  0 fail
43274 expect() calls   1397 pass  0 fail
43278 expect() calls   1397 pass  0 fail
```

**Falsifier did NOT trip: the tally is not stable.** The 43264 outlier run
also had 1 fail where every other run had 0 — recorded for completeness,
but not chased further here: it is a single occurrence, out of scope for
this ticket's outcome (a flaky *assertion*, not the *tally*, which is the
subject under test), and refiled if it recurs (see "Scope" in BUTCHR-162).

Corroboration, independently measured by BUTCHR-113 on the same commit,
before this ticket's own run (quoted from its ticket comment, not
re-derived): `43279 / 43279 / 43279 / 43281 / 43280 / 43279`, `1397`
pass / `0` fail every time. BUTCHR-107's own prior measurement, at a
different, earlier commit: `2694 / 2696 / 2696 / 2695`, `1195` pass / `0`
fail every time. Three independent measurements, three different commits,
at least two different hosts — same shape every time: pass/fail rock
stable, tally not.

**Per-file sums, for comparison — stable, matching BUTCHR-107's own
finding:** running every `test/unit/*.ts` file individually and summing
each file's own tally gave `43281` on two separate trials. Every
full-directory run above landed at or below that per-file sum, consistent
with the diagnosis below (a fixed real-time polling window sometimes
capturing fewer ticks under a full-suite run's extra load, never more).

## Diagnosis — testing the hypothesis, not inheriting it

BUTCHR-107 offered a hypothesis (a timing- or concurrency-dependent loop,
a retry, or state shared across files) and explicitly labelled it
untested. This section reports what was actually run to test it.

**Step 1 — bisection.** Splitting `test/unit/*.ts` in half and running
each half four times found one half (28 files) stable and the other (32
files) unstable. Repeating the split on the unstable half narrowed it to
two groups of 9 and 8 files that were each independently STABLE when run
alone, but became unstable again the moment they were run together —
which rules out a single bad file in isolation and points at something
sensitive to overall load/timing rather than a specific pairwise
interaction (each of several unrelated files, paired individually with
the 9-file group, could independently trigger the same ±2 variance).

**Step 2 — direct reproduction in one file.** `test/unit/blocked.test.ts`
run completely alone, 10 consecutive times, nothing else loaded:

```
19 expect() calls   5 pass  0 fail
19 expect() calls   5 pass  0 fail
19 expect() calls   5 pass  0 fail
21 expect() calls   5 pass  0 fail
21 expect() calls   5 pass  0 fail
21 expect() calls   5 pass  0 fail
21 expect() calls   5 pass  0 fail
21 expect() calls   5 pass  0 fail
21 expect() calls   5 pass  0 fail
21 expect() calls   5 pass  0 fail
```

Same 5 tests pass every time; the tally alone moves, by exactly 2, in one
file, with zero other files loaded. **This is enough on its own to
disprove "it's cross-file shared state" as the sole explanation** — there
is no other file here to share state with.

**Step 3 — the mechanism, read from the test itself.**
`test/unit/blocked.test.ts`'s `"onTick fires once per poll with the full
blocked set and a strictly increasing sequence number"` test polls a fake
resource every 10ms for a real 45ms (`setTimeout`), records one entry into
a `ticks` array per poll, then does:

```ts
for (let i = 1; i < ticks.length; i++) expect(ticks[i]!.seq).toBe(ticks[i - 1]!.seq + 1);
...
for (const b of blocked) { ... expect(t?.ids).toContain(b.pane); }
```

`ticks.length` is however many polls the OS scheduler actually delivered
inside a 45ms real-time window — not a fixed number — so both loops'
iteration counts, and therefore this test's own `expect()` count, are a
direct function of scheduler jitter. This is not a bug in the code under
test: it is the test correctly observing that a real timer, under real
scheduling, does not deliver ticks at a perfectly fixed cadence.

**Step 4 — this is a pattern, not one file.** The same shape (a real
`setTimeout`-driven poll loop, results recorded into an array, then
iterated with `expect()`) recurs at scale across `test/unit/`:

```
test/unit/loop.test.ts:                      47 setTimeout uses
test/unit/resource-type-second-instance.test.ts: 6
test/unit/blocked.test.ts:                    5
test/unit/sleep.test.ts:                      3
test/unit/session-limit-watch.test.ts:        1
test/unit/prompt-watch.test.ts:               1
test/unit/idle-dialog.test.ts:                1
test/unit/escalation-loop.test.ts:            1
```

(`grep -c "setTimeout" test/unit/*.ts`, this commit — verify at yours,
`main` moves.) Not every one of these necessarily produces variance
individually (`loop.test.ts` alone was stable across 6 runs in this
measurement — recorded as a genuine negative result, not chased further,
since one confirmed source plus a widespread recurring pattern is already
sufficient grounds for the decision below), but the pattern's prevalence
is itself the reason full pinning is out of this ticket's scope.

**What was NOT established, named explicitly:** which, if any, of the
other seven files above independently reproduce their own variance in
isolation (only `blocked.test.ts` was confirmed directly); whether the
±2/±17 magnitudes seen in different runs share one root cause or several;
and whether `blocked.test.ts`'s specific test could be rewritten to assert
without depending on the exact tick count (e.g. `toBeGreaterThanOrEqual`
plus a monotonicity check that doesn't loop per-tick) without weakening
what it verifies — plausible, untried, and if attempted would need its own
mutation verification. Left as a candidate for whoever later decides
pinning is worth it after all.

## Decision

**Outcome 2: the tally cannot reasonably be pinned within this ticket's
scope, and should not be compared across runs.** Making it fully
deterministic would mean finding and rewriting every real-timer-driven
assertion loop across at least eight files (one confirmed, several more
plausible) so that none of them assert a variable number of times on a
real wall-clock outcome — a multi-file test-suite rewrite disproportionate
to a single Task, and one that risks weakening genuine coverage of actual
polling behavior in the process (the thing this whole epic exists to
prevent). This is a complete, deliberate delivery of this ticket's
increment, not a placeholder for a future Outcome-1 attempt.

## The substitute

**Do not compare `bun test test/unit`'s own reported tally between two
points in history.** To check whether a diff removed an assertion, read
the diff itself:

```bash
git diff <base>...<head> -- test/ | grep '^-.*expect(' || true
```

**Two defects, both handled or stated:**

- **The trailing `|| true` is required, not optional prose.** Plain `grep`
  exits 1 when nothing matches — and "nothing matches" (no assertion-shaped
  line removed) is the PASSING result. Verified directly in this repo:
  `git diff 7dd88fe~1...7dd88fe -- test/ | grep '^-.*expect('` exits 1 on a
  commit that removed no assertions; under `set -e` a script built from the
  bare command dies silently at exactly the moment the news is good.
  Appending `|| true` (confirmed: exits 0 in both the match and no-match
  case above) makes the command safe to run inside any script, including
  one under `set -e`.
- **Every line this prints is a candidate to read, not a verdict.**
  Verified directly in this repo against a real historical diff
  (`88883e2...`): the command printed one line —
  `-    expect(issues.get("BUTCHR-2")!.comments).toHaveLength(2); // the archive lands each time (safe to retry)`
  — from a `Merge main into ...` commit, i.e. a false positive produced by
  the diff mechanics of a merge, not a real removal on that branch. The
  same shape of false positive was independently observed by BUTCHR-107 on
  its own merged range (4 hits, 0 real removals: one deliberately-updated
  pinned count, three occurrences of the word `assert` inside rewritten
  comments). **Read each printed line by eye before concluding anything was
  actually weakened or removed — a nonzero line count is a prompt to look,
  never grounds by itself to request changes or to approve.**

Guidance pointing at this document and carrying the command above is in
`briefs/story.md` (task-PR review) and `briefs/epic.md` (story-PR review) —
the channels a reviewing agent actually reads at the moment it would
otherwise reach for the tally.
