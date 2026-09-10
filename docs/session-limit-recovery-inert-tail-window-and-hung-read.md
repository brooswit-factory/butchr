# Why session-limit recovery didn't re-drive the fleet (2026-09-02) — measurement

BUTCHR-243, implementing BUTCHR-241 (epic: BUTCHR-207). Attribution only —
**no behaviour change accompanies this document.**

Every environment fact below (host, port, unit, journal command, capture
directory, remote URL) was read from **this task's own workspace and its own
daemon process**, never copied from the ticket. If you are re-verifying this
on a different workspace, re-derive them from your own `ENVIRONMENT.md` and
your own `git remote -v` — do not reuse the values printed here as anything
but "what was true for this specimen."

- Daemon: `journalctl --user -u butchr.service`, systemd unit `butchr.service`.
  A system-level `journalctl -u butchr.service` (no `--user`) prints
  `-- No entries --` for this same unit — silent, not an error; every query
  below explicitly used `--user`.
- Repo checkout read at commit `8c00b6a1` (`8c00b6a11c0222f9873474e22959d3ec020bfb13`),
  reported CURRENT against `origin/main` by this workspace's own daemon at
  `2026-09-03T04:56:06.688Z` — a timestamped reading, not a standing fact,
  per the epic's own warning that build currency will sawtooth once the
  30-minute deploy tick (below) is live.
- **The repo's GitHub remote is `https://github.com/brooswit-factory/butchr.git`**
  (`git remote -v` in this checkout), **not** `brooswit/butchr` as BUTCHR-241's
  ticket text states — `brooswit/butchr` is the local clone-path convention
  (`~/code/<owner>/<repo>`), not the GitHub slug. Flagged per the
  "your own checkout wins" rule; the story agent independently caught and
  corrected the same thing on the ticket.
- Capture directory resolved by reading `src/config/config.ts` and
  `src/agents/workspace.ts` at the commit above:
  `env.BUTCHR_CAPTURE_DIR?.trim() || join(workspaceRoot(), ".captures")`,
  `workspaceRoot = process.env.BUTCHR_WORKSPACES ?? join(homedir(), "butchr-workspaces")`.
  Neither env var is set in the running daemon's own `/proc/<pid>/environ`
  (pid resolved live via `systemctl --user show butchr.service -p MainPID`,
  not taken from a possibly-decayed `ENVIRONMENT.md` value), so the real
  directory is `/home/wroosbit/butchr-workspaces/.captures` — verified to
  exist, with 52 files, before relying on it.

## Falsifiers — written before any of the evidence below was read

Per BUTCHR-209's own standard and this ticket's AC1, in the order they were
run:

1. **Cheapest discriminator.** Both gate candidates are simultaneously
   falsified if a `[session-limit] … refused …, resets … — will close the
   pane …` line was emitted at any point in the incident window. If found,
   stop chasing the gates and look at why `close()` failed instead.
2. **Candidate 1 (status gate) is falsified** if the quota-parked panes'
   recorded `agent_status` was `idle` or `done` — the watch would then have
   read them, and the failure is downstream of the gate.
3. **Candidate 2 (positional gate) is falsified** if the captured banners
   sit within the module's actual `TAIL_LINES`-content-line window, counted
   the way the module counts it (walking up from the end, skipping
   blank/decorative lines, not `tail -n`).
4. **Candidate 3 (loop liveness) is falsified** if the watch loop
   demonstrably kept ticking through the silent window — its own capture
   files are timestamped proof-of-life if fresh ones appear.
5. **Absence control.** Before any "no such line" is read as a finding, the
   same `journalctl --user -u butchr.service` query, scoped with an explicit
   `UTC` suffix on `--since`/`--until`, must first be shown to return lines
   known to exist in that window.

None of these were adjusted after looking at the data; the order and wording
above is what was written down before the first query ran.

## Evidence

### Absence control (run before anything else was trusted)

```
journalctl --user -u butchr.service --no-pager \
  --since "2026-09-02 20:45:00 UTC" --until "2026-09-02 20:48:00 UTC" \
  | grep -c '\[labels\]'
# → 26
```

26 `[labels]` lines came back for a 3-minute UTC-scoped window using the
`--user` flag on a unit whose journal, checked separately, spans
`2026-07-19` through the present — well past the incident. The instrument
works and covers the window; an absence read from here on is a real
absence, not a mis-scoped query. (Journal coverage: first line
`2026-07-19T17:15:04-07:00`; the window in question, `2026-09-02`, sits
comfortably inside it.)

### Discriminator 1: was "will close the pane" ever logged?

```
journalctl --user -u butchr.service --no-pager \
  --since "2026-09-02 00:00:00 UTC" --until "2026-09-03 05:00:00 UTC" \
  | grep '\[session-limit\]' | grep -oE '(unrecognised|no-reset-time|will close the pane|poll failed)' \
  | sort | uniq -c
#   56 unrecognised
```

Every `[session-limit]` line logged across the entire incident day (both
becalmings, both phases, UTC-scoped and verified against the absence
control above) is the `unrecognised` trigger. Zero `no-reset-time`. Zero
`will close the pane`. Zero `poll failed`. **Discriminator 1: recovery was
never scheduled, not even once, anywhere in this window** — both gate
candidates stay live, and the "something prevented the close" branch is
ruled out.

### Discriminator 2: capture population, partitioned by regime (AC9)

`ls /home/wroosbit/butchr-workspaces/.captures` (52 files). All
session-limit-watch captures (as opposed to `escalation-loop.ts`'s own,
disjoint by the `-escalation-` filename segment) carry the `unrecognised`
trigger and fall into four UTC clusters, all **before** the 2026-09-03
deploy-cadence change (see "Cadence change" below), so all four are safely
inside the incident population and none needed to be excluded:

| cluster (UTC) | tickets | notes |
|---|---|---|
| 17:30:15–18:17:15 | 8 issues, 1 later straggler at 18:17 | pre-becalming-1 |
| 19:24:22 | 11 issues | **inside becalming 1's stated dead window (19:10→19:40Z)** |
| 20:45:26–20:47:27 | 17 issues across BUTCHR/CATA/DROVR/WYZR | **the fleet-wide quota-hit burst** |
| 04:22:51–04:22:52 (next day) | 17 issues, same set as the 20:45 cluster | **the human-restart capture, matching the ticket's "04:22:51Z … still shows resets 5:10pm"** |

One divergence from the ticket worth recording rather than silently
reconciling: the ticket describes the quota-hit burst as "ten tickets
across five projects." This checkout's own capture inventory for that
cluster counts **17** distinct issues across **4** projects (BUTCHR, CATA,
DROVR, WYZR). Per the tie-break rule the story set ("your observation
against current code/data wins unless the difference is itself the
finding"), this is recorded as a discrepancy, not silently corrected —
it does not change any candidate's verdict, since the falsifiers above
don't depend on the exact count.

Every capture file's own header records `agent_status`. Across all 50
non-escalation captures: **50 of 50 say `agent_status: done`**, zero say
anything else.

### Candidate 1 (status gate) — FALSIFIED for every captured row

At this commit, `src/agents/session-limit-watch.ts`'s `tick()`:

```ts
if (row.agent_status !== "idle" && row.agent_status !== "done") continue;
if (!row.issue) continue;
const text = await deps.read(row.pane_id);
...
if (phrasePresent) await maybeCapture(deps, captured, row, "unrecognised", ...);
```

Both `maybeCapture` call sites for both trigger classes (`unrecognised` and
`no-reset-time`) occur strictly after the status-gate `continue` on line
209 and the `deps.read` call that follows it — verified by reading the
whole function, not just the two call sites: there is no earlier branch in
`tick()` that can reach `maybeCapture`. This confirms BUTCHR-210's brokered
structural argument at this commit, for both capture-writing sites, and
finds no capture site that can be reached before the gate.

Given that, **the mere existence of a capture for an issue is proof that
row's `agent_status` passed the gate at that poll** — and every capture's
own header additionally records `agent_status: done` directly, so this
isn't argued from structure alone. **Candidate 1 is falsified for all 50
captured rows across both becalmings.** This does not rule out the status
gate as a contributor for some *other*, never-captured ticket that was
quota-parked while reporting a non-idle/done status — no capture could
exist for such a row by construction, so this population can't speak to
it either way. No such row was independently identified in this
investigation.

### Candidate 2 (positional gate) — REVISED after review: the anchor rejects the banner regardless of window size

**Correction, entered after story review on PR #265, not silently folded
into the original text.** The first version of this section attributed the
`null` result to the banner sitting outside the `TAIL_LINES = 4` window,
based on three hand replications of the walk-back algorithm. That
walk-back was accurate about *where the line sits*, but never tested
whether `REFUSAL_LINE` would actually match that line *if* it were inside
the window — and it does not. The story's review caught this by running
its own independent 50-capture population (a different capture directory,
different Unix user) through the real detector at every window size up to
80 lines and finding 0/50 matches anywhere, then identifying the cause:
every banner line begins with `⎿` (U+23BF), a space, and a non-breaking
space (U+00A0) — the way Claude Code renders a `⎿` tool-result line —
and `.trim()` strips the trailing/leading *whitespace* (which includes
U+00A0) but not `⎿` itself, since `⎿` is not whitespace. The trimmed line
therefore starts with `⎿`, and `/^You(?:'|’)ve hit your session
limit\b.*$/` requires the string to start with `You` — so it can never
match, at any window size, however wide.

**Independently reproduced against this task's own population, using the
real production function rather than a hand simulation**, before accepting
the correction:

```ts
import { detectSessionLimitRefusal } from "./src/agents/session-limit.js";
// fed the verbatim post-header body of all 50 own captures, unmodified
```

```
{ total: 50, matchInWindow: 0, anyMatchAnywhere: 0 }
```

`matchInWindow` uses the real `TAIL_LINES = 4`; `anyMatchAnywhere` runs the
same anchor test with no window limit at all, over every content line in
the file. **Both are 0/50.** And directly on the byte level, for every one
of the 97 banner-line occurrences found across these 50 files:

```
"  ⎿  You've hit your session limit · resets 5:10pm (America/Los_Angeles)"
prefix before "You": U+23bf U+20 U+a0
```

identical in every occurrence — the same `⎿ `+NBSP prefix the review
described, confirmed by direct `codePointAt` inspection, not inferred.

**This changes the attribution.** Position is not what is causing the
`null` result in this population: even an *unlimited* window still finds
zero matches, because the anchor itself rejects the line before position
is ever relevant. The three hand-replications in the previous version of
this section (BUTCHR-183 at `20:45:26Z` and `04:22:51.928Z`, CNDLX-1 at
`19:24:22Z`) are not wrong as *position* observations — the banner genuinely
does sit outside the 4-line window in all three, by 1 to 4+ positions, and
that is worth keeping on record since a wider window is still one of two
things that would need to change — but position is not *sufficient* to
explain the failure, and on this evidence it is not *necessary* either: the
anchor alone fully accounts for all 50 nulls, with or without a window.

Two independently-sufficient barriers are therefore in play for this
population: (1) the anchor rejects a `⎿`-prefixed rendering of the banner
outright, regardless of position, and (2) where the banner would
nonetheless have needed to be inside a window for some other reason, it
also sits outside `TAIL_LINES = 4`, for the chrome-displacement reasons
recorded below. **(1) is the one that is proven to matter here**, since it
alone is sufficient to produce every observed `null` with no dependency on
window size; (2) remains true as an independent observation but is not
shown to be load-bearing once (1) already accounts for the result.

For completeness, the chrome-displacement observation from the original
replications, kept because it is still accurate as a position measurement
and still relevant if the anchor is ever fixed: walking up from the pane's
end on BUTCHR-183 at `20:45:26Z`, the composer help line
(`⏵⏵ bypass permissions on …`) → content #1; a bare `❯` (not decorative
under the module's own regex — it isn't in `[─│╭╮╰╯·\s]`) → #2; a rule
line → skipped (decorative); a blank → skipped; the `✻ Worked for 58s ·
done 1:45 PM` status line → #3; a blank → skipped; the banner's own
second, wrapped line (`/usage-credits to finish …`) → #4 — budget
exhausted, with the (anchor-rejected) banner line itself one position
further back. By `04:22:51.928Z`, 7h37m later on the same pane, additional
generic chrome (`✔ Update installed · Restart to update`,
`new task? /clear to save 557.4k tokens`) pushes it to 8 positions back.
CNDLX-1 at `19:24:22Z` (becalming 1) shows the identical shape.

**Confirmed CANDIDATE 2, revised: the anchor-rejection mechanism, not the
tail-window mechanism, is the proximate and independently-sufficient cause
of every `unrecognised` capture inspected, in this population, in both
becalmings.** The reviewer's own population is recorded as an independent
confirmation, not a discrepancy to reconcile away — obtained under a
different Unix user from a different capture directory, and it agrees with
this population exactly on the mechanism (0/50 or equivalent, same leading
code points). Per the same tie-break rule already used for the 17-vs-10
ticket-count discrepancy above, an unreconciled difference would have been
recorded rather than silently resolved — here there was no difference to
reconcile once both were actually measured the same way.

### Candidate 3 (loop liveness) — supported for becalming 2's long tail, with an honest gap

**A real, verified structural hazard exists.** `daemon/index.ts` constructs
`new HerdrClient(config.herdrSocket ? { socketPath: config.herdrSocket } :
{})` — `timeoutMs` is never passed. In
`node_modules/@brooswit/herdr-sdk/dist/index.js`'s `rpc()`:
`const timer = opts.timeoutMs ? setTimeout(...) : undefined;` — with no
`timeoutMs`, an RPC call that never gets a response from herdr's socket
**never settles, ever**: not resolved, not rejected. `tick()`'s per-row
loop is a plain sequential `for…of` with `await deps.read(row.pane_id)`
inside it (`deps.read` → `readPane` → `herdr.pane.read(...)`) — one hung
read freezes the whole function before it reaches its own trailing
`if (!stopped) timer = setTimeout(() => void tick(), intervalMs)`. No
catch block ever sees a hang (there is nothing to catch), so this failure
mode logs nothing, matching the ticket's own prediction exactly.

**What the journal shows, self-measured:** the pre-restart daemon instance
(pid `338538`, confirmed via `bun[338538]` in every line attributed to it)
logged its **last** `[session-limit]` line at `20:47:27Z`
(`13:47:27` local, inside the quota-hit burst) and its last `[notify]`
line 12 seconds later at `20:47:39Z`. It then logged **zero**
`[session-limit]`, `[notify]`, `[reconcile]`, or `[crashloop]` lines for
the rest of its life, up to the moment `systemd` recorded
`Stopping/Started butchr.service` at `21:22:50` local (`04:22:50Z`) —
**a 7h35m gap.** That same process was demonstrably still running the
whole time: **1,784 `[labels]` lines and 5,386 `[prompts]` lines** were
logged by `bun[338538]` after `20:47:27Z`, and its last `[pr]` line landed
at `21:22:12` local — **38 seconds before the restart**.

`syncLabels`'s `agentStatuses` callback calls the exact same
`herdr.agent.list()` that `watchSessionLimits`'s own `deps.list()` calls
(`daemon/index.ts`, both wired to `herdr.agent.list()` directly) — and
`[labels]` lines kept firing 1,784 times in the silent window. **This
rules out a hang on `herdr.agent.list()` itself**, since the same call
that `watchSessionLimits` would make at the top of every `tick()` was
provably succeeding throughout, via a different caller. That narrows the
candidate hang to something specific to the session-limit watch's own
loop body — most plausibly `deps.read()` (`herdr.pane.read()`, a
per-pane RPC that `syncLabels` never calls), consistent with the
structural hazard above.

`[notify]`/`[reconcile]`/`[frozen]`/`[crashloop]` going silent in the same
window is a weaker signal than it first looks: all four only log when
something changed or a threshold tripped, and a fleet that is genuinely
quota-parked fleet-wide would legitimately produce very little for any of
them to report — their silence is also fully consistent with "nothing to
say," not only with "the code that would say it is dead." That
possibility was not ruled out here.

**The honest gap:** `watchSessionLimits`'s own per-(issue, trigger, pane)
capture dedupe (`captured` map in `session-limit-watch.ts`) is **never
cleared** for a pane that keeps showing the same banner (`clearCaptured`
only fires when `phrasePresent` goes false) — so for these specific 17
already-captured panes, **zero new `[session-limit]` log lines is the
expected output of a perfectly healthy, still-ticking loop**, not only of
a dead one. No pane entered the idle/done + phrase-present state for the
*first* time anywhere in the 7h35m gap that could have produced a fresh,
undeduped capture and settled this directly; none was found in this
investigation. **This candidate is therefore not fully falsifiable or
confirmable from the artefacts on disk alone** — the structural hazard is
real and verified, the correlated silence of `[session-limit]`/`[notify]`
alongside continued `[labels]`/`[prompts]`/`[pr]` activity is consistent
with it, but the dedupe means the same observation is also consistent with
"alive and uneventful." **What would settle it:** a heartbeat/tick-count
log line inside `watchSessionLimits` independent of whether anything was
captured (a recommendation, not applied here — see below), or a herdr-side
request log (not available in this workspace) showing a `pane.read` issued
around `20:47Z` that never received a reply.

**A related, already-retracted lead, addressed explicitly per the story's
instruction not to weigh it unless independently resurrected:** "a restart
disarms the remediation" was formally withdrawn upstream before this
measurement. What was found here is a **different claim** and does not
resurrect it: the loop's silence in this data does not correlate with
*being freshly restarted* (the pattern shows a loop that logs fine
immediately after a restart, then goes silent **partway through** that
same instance's life, well before the next restart) — it correlates with
a specific await inside its own body hanging at some point during normal
operation. A subsequent restart "fixes" it only incidentally, because a
process restart resets all in-memory state including a wedged promise
chain — not because restarting is what disarms anything.

**Becalming 1:** too short (30 minutes) and too close to this day's
otherwise-routine ~30–90 minute daemon restart cadence (unrelated,
pre-dating the incident — nine `Stopping/Started` cycles were logged
before the quota-hit burst even happened) to attribute a loop-liveness
verdict with any confidence. No daemon restart was found in the journal
matching the ticket's stated `19:40Z` end of becalming 1 specifically (the
nearest restarts bracket it at `19:24:21Z` and `20:21:04Z`), so whatever
ended becalming 1 was not, on this evidence, a `systemctl` restart of the
whole unit. **Could not determine** whether loop-liveness played any part
in becalming 1; candidate 2 alone is sufficient to explain its
positional-gate failures, and no further loop-specific evidence was
available to test with.

### Cadence change (AC9)

The deploy regime changed to a 30-minute tick on **2026-09-03**, reported
to this task mid-run. Every capture and journal line used as evidence
above is timestamped `2026-09-02T17:30Z` through `2026-09-03T04:22:52Z` —
**entirely before** the change (reported as landing around
`2026-09-03T05:00Z`, from the timestamp on the comment that announced it).
No forward-looking observation is pooled with the above; none was taken.

### Dedupe-survives-restart corollary (AC10)

**It firms up, and it matters to how a future reader should treat the
04:22:51Z capture cluster.** BUTCHR-183 (and the other 16 tickets in that
cluster) has captures at **both** `20:45:26Z` and `04:22:51.928Z`, same
pane, same `unrecognised` trigger, with the pane text essentially
unchanged (still the same frozen "5:10pm" banner) across the 7h37m gap.
The `captured` dedupe map lives only in daemon-process memory
(`session-limit-watch.ts`'s `tick()` closure) and is discarded on every
restart. **The 04:22:51Z burst is not the mechanism starting to work
again — it is the same unresolved failure being re-captured because the
restart wiped the in-memory dedupe, not because anything changed in the
world.** A future reader (or a fix author) comparing capture-file
timestamps without this context could mistake a denser post-restart
cluster for a sign of life; it is not one.

## Which sense of "unrecognised"? (AC3)

The evidence supports sense **(b)** exclusively — the session-limit
watch's own `-unrecognised-` capture class, meaning the refusal phrase was
present in the pane text but `detectSessionLimitRefusal` returned `null`.
Every one of the 56 `[session-limit]` journal lines and 50 non-escalation
capture files for the day carries this literal trigger name, and every
inspected capture's header records `agent_status: done` — i.e., herdr's
own status classifier correctly recognised these agents as done/idle
throughout; sense **(a)** (an unrecognised *herdr agent status* mapping to
`agent:working`) is not what happened to any row in this population. This
investigation found no evidence of sense (a) occurring at all; it cannot
rule out sense (a) having affected some other, uncaptured ticket, for the
same reason noted under Candidate 1 — such a row would leave no capture by
construction.

## Attribution

For the 50 captured rows, across both becalmings:

- **Candidate 1 (status gate): falsified.** All captured rows had
  `agent_status: done`, and the code path that would have to be true for
  a capture to exist at all (row read strictly after the status-gate
  `continue`) independently proves the same thing.
- **Candidate 2 (positional gate, revised): confirmed as the proximate
  cause, but the mechanism is anchor-rejection, not window position.**
  Detection returned `null` because the banner renders as a `⎿`-prefixed
  line (`U+23BF`, space, `U+00A0`) — the way Claude Code renders a
  tool-result line — and `.trim()` does not strip `⎿` itself, so the
  anchored `/^You(?:'|’)ve hit.../` can never match it, **at any window
  size**: re-running the real detector with the window unbounded still
  finds 0/50 matches. The banner also happens to sit outside
  `TAIL_LINES = 4` in every sample checked, displaced by generic idle-pane
  chrome plus its own two-line wrap, but that displacement is not what is
  actually producing the `null` — the anchor alone is sufficient on its
  own. Confirmed identically across this task's own 50-capture population
  and an independent 50-capture population gathered under a different
  Unix user during story review.
- **Candidate 3 (loop liveness): a real, verified hazard, best-supported
  but not conclusively settled for becalming 2's long silent tail; could
  not be evaluated with confidence for becalming 1.** The watch's own
  sequential per-row `await` has no timeout anywhere beneath it in this
  codebase, so a single hung `herdr.pane.read()` can freeze the entire
  self-rescheduling loop forever with no log line — and the loop's
  observed 7h35m silence during becalming 2, while sibling subsystems
  using a related-but-distinct herdr call stayed alive, is consistent
  with exactly that. It is not distinguishable, from artefacts on disk
  alone, from "alive and correctly silent because of the capture dedupe."

**Bottom line:** for every quota-parked pane this investigation could
inspect, recovery did not fire because detection itself returned a false
negative (Candidate 2) — the refusal was present, but rendered as a
`⎿`-prefixed tool-result line that the anchored match rejects outright,
regardless of window size or position. Whether the watch loop also
independently stopped ticking for hours at a time during the longer of
the two becalmings (Candidate 3) is likely but not proven by this
evidence; if it did, it compounds the outage duration but is not required
to explain why recovery never scheduled in the first place — Candidate 2
alone is sufficient for that, and was confirmed directly.

## Recommendations (prose only — not implemented here, per this task's scope)

- **Fix the anchor first — a `TAIL_LINES` change alone would repair none
  of these 50 panes.** `REFUSAL_LINE` needs to match a banner that renders
  as a `⎿`-prefixed tool-result line: either strip known leading render
  chrome (`⎿` and its following whitespace, including `U+00A0`) before
  anchoring, or anchor on the trimmed remainder after a small set of known
  prefixes, and add a fixture built from a real `⎿`-prefixed capture (not
  a hand-built one) so this doesn't regress silently. Only after that:
  re-derive `TAIL_LINES` against real idle-pane captures, with an explicit
  budget line for the refusal's own two-line wrap plus the composer/status
  chrome documented above — or switch from "last N content lines" to "last
  content line before the composer prompt, skipping known status-line
  patterns," which would be robust to chrome count changing in future
  Claude Code versions.

  **This is a constraint on that fix, not a detail to defer to
  implementation:** `REFUSAL_LINE`'s own comment excludes "a `⎿` tool-result
  line" by name, and `TAIL_LINES`' own comment explains why — the refusal
  phrase sits verbatim in KAN-804 and KAN-807's own ticket text, so an
  unanchored or over-broadly-anchored match would close a perfectly healthy
  pane the moment an agent merely reads either ticket. A naive strip of
  `⎿`-and-whitespace before anchoring **removes that exact protection**, so
  the anchor fix and the false-close guard have to be solved together, not
  sequentially, or "fixed" recovery starts killing working agents instead of
  leaving stuck ones stuck. Sharper still: the genuine banner and a rendered
  KAN-804/807 ticket body both render as `⎿`-prefixed tool-result lines with
  the identical leading code points found above — **prefix-stripping cannot
  distinguish them, because the prefix is not the discriminating signal.**
  Whatever the fix is, it needs a signal other than the line's leading
  characters — recency/position within the *live* pane state, or the
  presence or absence of surrounding ticket-body context, are the kinds of
  signal that could work; this document is not proposing which.
- Give `HerdrClient` a real `timeoutMs` in `daemon/index.ts`, and/or wrap
  each row's `deps.read()` in `watchSessionLimits` with its own timeout,
  so one wedged pane read can no longer freeze the whole polling loop
  indefinitely.
- Add a heartbeat/tick-counter log line to `watchSessionLimits`,
  independent of whether anything was captured, so a future incident can
  distinguish "loop dead" from "loop alive, nothing new to report" without
  the ambiguity this investigation ran into.
- Document the dedupe-survives-restart corollary (AC10, above) wherever
  capture files are described, so a post-restart capture burst is never
  mistaken for the mechanism recovering on its own.
