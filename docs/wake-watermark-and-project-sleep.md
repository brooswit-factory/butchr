# Wake watermark persistence and the project tier's sleep cycle (BUTCHR-187, implementing BUTCHR-119)

Answers, by direct measurement against a live production daemon and the
live Jira/Confluence artefact, one of two questions BUTCHR-68 left FAILED
— and documents, as a finding in its own right, why this document does
not attempt to answer the other one:

1. Does the project tier's `wake` watermark write (`advanceProjectWatermark`
   -> `AtlassianOps.setProjectProperty`) now persist, without corrupting the
   other keys already on the `butchr` project entity property? **Answered
   here: PROVEN**, independently reconfirmed.
2. Does a project agent that has caught up on its watermark actually EXIT —
   row gone from `herdr agent list`, pane released — rather than merely
   reporting `agent_status: "done"`? **Not answered here.** This agent's
   own daemon turned out to be the wrong one to observe it from (see
   "Two `butchr` daemons, one host, side by side" below) — a live,
   worked instance of the exact "right question, wrong daemon" trap this
   estate's own docs warn about. The verdict is recorded on story
   BUTCHR-119 instead, from the daemon that can actually see it.

Filed under story BUTCHR-119, epic BUTCHR-115. The causal chain this
measurement is checking, as stated by the story:

    check_in / speak.ts -> advanceProjectWatermark -> setProjectProperty -> 403
      -> `wake` never persists -> projectVerdict FAIL-OPEN -> "active" forever
        -> project always desired -> agent never stopped -> pane never released

**This document separates OBSERVATION from MEANING throughout, by explicit
instruction from the parent story.** Where a value was inherited from
another agent's write-up rather than measured here directly, that is
stated — inherited values are treated as claims, not as settled fact, per
BUTCHR-68's own caution about a single pane-id observation.

## Environment this measurement was taken in

Resolved live, from this workspace's own `ENVIRONMENT.md` and from the
daemon's own self-report — never inherited from the ticket, never from
another agent's doc (see this repo's `docs/review-commit-immutability.md`
for why an inherited environment fact is worthless to a different reader).

- Daemon health: `GET http://<host>:<port>/health` reported `pid: 1000239`,
  `build.sha: d386322a9f3e15fa0d32a64e9324f68de1dcd870`,
  `startedAt: 2026-09-02T14:21:08.427Z` — matching this workspace's
  `ENVIRONMENT.md` snapshot (measured 2026-09-02T14:40:12.020Z, same pid),
  so the snapshot was not stale for this measurement.
- Credentials resolved from the daemon's own process environment:
  `tr '\0' '\n' < /proc/1000239/environ`, never from a unit file, never
  guessed.
- Deployed working tree confirmed via `/proc/1000239/cwd` ->
  `/home/wroosbit/code/brooswit/butchr` (a different LOCAL PATH than this
  repo's canonical clone, `~/code/brooswit-factory/butchr` — same GitHub
  remote, `brooswit-factory/butchr`, just a different checkout directory
  name; not two different repos). `git rev-parse HEAD` there ==
  `d386322a9f3e15fa0d32a64e9324f68de1dcd870`, matching `/health`'s
  `build.sha` exactly — the RUNNING commit, not `main` (deployment here is
  an hourly pull-and-restart on the `:43` boundary; a merge is not a
  deployment). Every source citation below was re-checked directly against
  this exact deployed commit, not assumed to still say what an earlier
  read of a different ref said.
- `herdr` instance used for every Signal-2 read: `HERDR_SOCKET_PATH=
  /home/wroosbit/.config/herdr/herdr.sock`, this session's own user
  (`wroosbit`) socket. Confirmed to be a real, correctly-functioning
  instance two ways: (a) `systemctl --user status herdr.service` shows
  this socket's `herdr server` process (pid 190643) has been running
  continuously since `2026-08-21 12:39:48 PDT` — no restart anywhere near
  this measurement window; (b) this very agent's own row
  (`butchr-butchr-187`, `cwd: /home/wroosbit/butchr-workspaces/BUTCHR-187`)
  appears correctly in its output. **What this does NOT establish — see
  "A wrong-daemon measurement, caught before publishing" below — is that
  this is the herdr/daemon pair that staffs the project agent under test.**
  It is not. A second, DIFFERENT herdr process (pid 167214) exists on this
  host under a different Unix user (`booswrit`) and was never queried by
  this document.

## Checks and their failure conditions, as required by the story to be
## written down before being run

### Signal 1 — the `wake` key appears in the project entity property, and nothing else changes

- **Check:** `GET /rest/api/3/project/BUTCHR/properties/butchr`, parsed as
  JSON (not eyeballed), HTTP status printed on every request.
- **Fails as:** "still not persisting" if `wake` is absent after a restart
  and a full poll interval.
- **Fails as: STOP EVERYTHING** if `wake` appears but any of `space`,
  `rootDoc`, `repos`, `archiveProject`, `scaffolded` is missing or changed
  against Baseline A — the data-loss path firing in production despite the
  fix. Unrecoverable; escalate immediately, do not retry, do not attempt to
  repair the property.
- **Fails as "instrument, not world"** on 401/403/5xx.

### Signal 2 — demonstration 6: the project agent actually exits

- **Check:** `herdr agent list`, parsed as JSON, checked for a row whose
  `name` is exactly `butchr-butchr` (the project tier's agent name for
  project key `BUTCHR` — see `nameFor`/`issueOf`, `src/agents/herd.ts`,
  quoted below).
- **The definition this check rests on, quoted from the exact deployed
  commit** (`src/labels/plan.ts`, `mapAgentStatus`, doc comment and body
  unchanged from what the story quoted):

  > "idle and blocked map directly. `done` — herdr's status for an agent
  > sitting at its prompt after finishing a turn (confirmed against a live
  > `herdr agent list`: several done agents doing nothing) — is idle in
  > every sense this board cares about, so it maps to idle too... Any other
  > non-empty status... is 'working'."
  >
  > ```
  > export const mapAgentStatus = (raw: string | null): ObservedAgentLabel => {
  >   if (raw === "idle" || raw === "done") return "idle";
  >   if (raw === "blocked") return "blocked";
  >   if (raw == null) return "none";
  >   return "working";
  > };
  > ```

  Only `raw == null` — the row **absent** from `herdr agent list` — maps to
  `"none"`. `"done"` is idle, never an exit. **An exit is the row
  disappearing. It is never a status word.**
- **Where "pane release" is defined in code**, so this check has a concrete
  target rather than a vibe (`src/agents/herd.ts`):

  ```
  async stop(issue: string): Promise<void> {
    const pane = (await this.byIssue()).get(issue)?.pane;
    if (pane) await this.herdr.pane.close(pane);
  }
  ```

  `Herd.stop` is invoked from `reconcileNow`'s `plan.stop` loop
  (`src/daemon/loop.ts`), where `plan = planReconcile(desired, running,
  stale, atRest)` and (`src/reconcile/plan.ts`):

  ```
  stop: [...have].filter((k) => !want.has(k) && !resting.has(k)).sort(),
  ```

  i.e. `stop = running − desired − atRest`.
- **Fails as FAILED** if `butchr-butchr` still holds `w47:p1` after a full
  poll interval following the watermark write.
- **Fails as "the BUTCHR-68 trap, not a pass"** if `agent_status` becomes
  `done` or stays `idle` while the row and pane persist.
- **Fails as "a blink, not sleep"** if the row disappears for one poll and
  comes back — the story requires the row absent for **at least three
  consecutive polls** before counting it as released.
- **Fails as "instrument, not world"** if `herdr agent list` is unreadable
  or is answering for the wrong daemon (see the two-herdr-instance note
  above for how that trap looks from the inside).

## Baseline A — the property PRE-state (inherited from the story; not independently re-derivable, since it precedes this agent's spawn)

Captured twice, independently, 52 seconds apart, byte-identical:

- by story BUTCHR-119 at `2026-09-02T14:36:33.477Z`, HTTP 200 (primary)
- by epic BUTCHR-115 at `2026-09-02T14:37:25Z`, HTTP 200 (corroboration)

```json
{"key":"butchr","value":{"space":{"key":"BUTCHR","id":"11599874"},"rootDoc":{"id":"11600050"},"repos":["brooswit-factory/butchr"],"archiveProject":"KAN","scaffolded":"2026-08-29"}}
```

`wake` absent — the property of a genuine pre-write baseline, not one of
unknown provenance. `rootDoc.id = 11600050` is the one value in this whole
measurement that is not reconstructible from anything else in the system.

## Baseline B — the pane PRE-state (inherited from the story; the record a pane was HELD is destroyed by the very event under test, so it cannot be re-taken)

Captured at ~`2026-09-02T14:38Z` by story BUTCHR-119:

```
name: butchr-butchr   pane_id: w47:p1   tab_id: w47:t1   workspace_id: w47
agent_status: "working"
```

The story states this is consistent with BUTCHR-68's own independent
record of `w47:p1` being held continuously since 06:43 the previous day.
**Treated here as an inherited claim, not settled fact** — per the story's
own instruction, and because this agent could not independently observe
`w47:p1` at all from its own vantage point (see "Signal 2" below for why).

## Signal 1 result: PROVEN — independently reconfirmed, not merely inherited

The story reports the transition bracketed to a 61-second window: last
clean poll (no `wake`) at `2026-09-02T14:43:24Z`; first write observed at
`2026-09-02T14:44:25Z`, HTTP 200:

```json
{"key":"butchr","value":{"space":{"key":"BUTCHR","id":"11599874"},"rootDoc":{"id":"11600050"},"repos":["brooswit-factory/butchr"],"archiveProject":"KAN","scaffolded":"2026-08-29","wake":{"version":16,"comment":"17334326","epics":{}}}}
```

**This agent independently re-ran the check** — a second source, not a
repeated read of the same claim — at `2026-09-02T14:48:23.066Z`, HTTP 200:

```json
{"key":"butchr","value":{"space":{"key":"BUTCHR","id":"11599874"},"rootDoc":{"id":"11600050"},"repos":["brooswit-factory/butchr"],"archiveProject":"KAN","scaffolded":"2026-08-29","wake":{"version":16,"comment":"17334326","epics":{}}}}
```

Byte-identical to the story's post-state. Key-by-key, by parse, not by eye:

```
INTACT  space           {"key":"BUTCHR","id":"11599874"}
INTACT  rootDoc         {"id":"11600050"}
INTACT  repos           ["brooswit-factory/butchr"]
INTACT  archiveProject  "KAN"
INTACT  scaffolded      "2026-08-29"
rootDoc.id pre = 11600050 ; post = 11600050 ; identical: True
keys ADDED: ["wake"]   keys REMOVED: []
```

**Meaning, stated separately from the observation:** `setProjectProperty`'s
read-modify-write (`src/resources/project.ts`,
`advanceProjectWatermark` -> `{ ...current, wake: nextWake }`) succeeded in
production under the exact condition it exists for, observed on the
artefact by two independent agents at two different times, not inferred
from an absence of errors. Signal 1 is **PROVEN**.

## Signal 2 — demonstration 6: observations, and a wrong-daemon measurement caught before publishing

### The story's own snapshot, inherited

At `2026-09-02T14:45:07Z`: `butchr-butchr  w47:p1  idle` — **still present**,
still holding the pane. (Correctly NOT treated by the story as an exit,
per the `done`/`idle` trap above.)

### A positive control the story obtained and handed down

Between `14:42Z` and `14:45Z`, the unrelated row `butchr-butchr-164`
vanished from `herdr agent list` entirely, releasing pane `wBC:p1` — on
the story's own herd. Recorded here as inherited context for the section
below, not as something this agent's own instrument corroborated (see
next section for why).

### This agent's own polls, and the check that invalidates them as Signal-2 evidence

This agent independently polled `herdr agent list` four times looking for
a row named `butchr-butchr` (all parsed as JSON, all timestamped):

| # | UTC timestamp | `butchr-butchr` row (on THIS agent's herd) |
|---|---|---|
| 1 | `2026-09-02T14:48:16.518Z` | absent |
| 2 | `2026-09-02T14:49:36.213Z` | absent |
| 3 | `2026-09-02T14:50:43.575Z` | absent |
| 4 | `2026-09-02T14:51:05.191Z` | absent |

**This agent's first draft of this document treated that as Signal 2
PROVEN-as-an-observation.** That draft was wrong, and the mechanism by
which it was wrong is itself the single most reusable finding in this
document — recorded here rather than quietly deleted, per this repo's own
convention (see `docs/review-commit-immutability.md`) of keeping a caught
mistake visible rather than erasing it.

**What actually happened, established by running the story's own decision
procedure against fresh reads (not reused from earlier in this
document):**

- This agent's `ENVIRONMENT.md` names host `servyboi`, port `7717`. A
  **fresh** `GET /health` at `2026-09-02T14:55:10Z` — not the earlier read
  quoted under "Environment" above — returned `pid: 1000239`,
  `startedAt: 2026-09-02T14:21:08.427Z`, **identical** to this agent's very
  first check of the same session. No restart occurred; this is not a
  stale-pid situation.
- `ps -o pid=,user=,args= -p 1000239` → owned by Unix user `wroosbit` —
  the same user this agent runs as. So pid 1000239 is legitimately this
  agent's own daemon, not a permissions artefact.
- `tr '\0' '\n' < /proc/1000239/environ | grep ALLOWLIST` → **no match.**
  `BUTCHR_PROJECT_ALLOWLIST` is genuinely unset on this process, live,
  printed directly (not inferred from a stale banner).
- Scanning this agent's own `herdr agent list` (same instance described
  under "Environment" above, confirmed un-restarted since `2026-08-21`)
  for anything shaped like a project id (`^[A-Z][A-Z0-9_]*$`, no
  `-<digits>` suffix — `isProjectId`, `src/resources/id.ts`) across all 15
  currently-tracked rows: **zero matches.**

That last point is the correction to the table above: the four "absent"
polls were not four observations of a row disappearing. **This herd never
had a project-tier row on it at any point this agent could check.** "Never
present" and "present, then released" produce an identical `herdr agent
list` reading (no row) but are not the same claim, and this document's
first draft conflated them — exactly the fusing-observation-with-meaning
error the story's def-of-done explicitly warns against, caught here by
re-deriving the check from scratch rather than trusting the earlier
framing.

**Independent corroboration that this is a genuinely different daemon,
not a reading error, inherited from the story** (obtained by the story
from ITS OWN vantage point — a different Unix user than this agent, and
so not independently reproducible here; recorded as inherited, not
verified first-hand):

- The story's `/health` (its own port, not this agent's) reports
  `pid: 1015210`, `startedAt: 2026-09-02T14:47:10.673Z`, same
  `build.sha: d386322a9f3e15fa0d32a64e9324f68de1dcd870` — a restart of the
  same build, not a new deploy.
- Its `BUTCHR_PROJECT_ALLOWLIST` environment value:
  `BUTCHR,CATA,SCHEM,SICKOS,RINTH,LIBS,DROVR,CNDLX` — non-empty, and
  contains `BUTCHR`.
- Its own `herdr agent list`, checked at `14:51:34Z`, `14:52:04Z` and
  `14:52:34Z`, shows `BUTCHR:w47:p1:idle` present and unchanged across all
  three reads, alongside seven other project-tier rows.
- A set comparison the story ran on its own side at `14:52:37Z`: its
  allowlist (8 keys) and its running project-tier agents (8 keys) are
  **exactly equal**, zero difference either direction — the project tier
  it observes is fully staffed to its allowlist, which this agent's own
  daemon (allowlist empty, zero project agents running) could not
  possibly produce.

This agent attempted to read pid 1015210 directly to corroborate the
above first-hand and could not: it is not a pid this agent's own
`/proc` access covers (the earlier draft's `/proc/1000239/...` reads
were of THIS agent's own daemon, pid 1000239 — a coincidentally similar
but materially different pid). This document does not know this host's
full topology of daemons/Unix users beyond what the story reported and
what this agent independently confirmed about its own daemon; per the
story's explicit instruction, that topology was not investigated further.

**Meaning, stated separately from the observation:** this agent's own
`herdr`/daemon vantage point (host `servyboi`, port `7717`, pid `1000239`,
user `wroosbit`) is confirmed, live, to be a daemon whose project tier
stops nothing and starts nothing for `BUTCHR` — not because of anything
to do with the wake watermark, but because it was never given `BUTCHR` on
its allowlist. **Demonstration 6 is UNOBSERVABLE from this vantage
point** — not FAILED (nothing here shows the mechanism doesn't work) and
not PROVEN (nothing here shows it does). This finding — that a
right-question/wrong-daemon read produces a real, well-formed, internally
consistent, and completely wrong answer, one that looked exactly like a
clean PROVEN result until re-derived from first principles — is itself
the concrete, reusable value of this section, independent of demonstration
6's own outcome.

### Two `butchr` daemons, one host, side by side — a worked instance of "right question, wrong daemon"

`ENVIRONMENT.md`'s own warning ("a host can run more than one butchr
daemon, and one can be owned by another user and invisible to your own
`ss -ltnp`") is usually abstract. This measurement made it concrete, with
both sides' numbers gathered independently and placed next to each other
— worth recording as a finding in its own right, not just as an aside
inside Signal 2's story, because a future reader hitting two contradictory
`herdr` results will have exactly this shape to check against:

> **CURRENCY NOTE, added by BUTCHR-119.** Everything in this section and the
> table below is an accurate record of what was true at the timestamps it
> names, and is kept for that reason. It is NOT current: at
> `2026-09-02T16:51:08Z` herdr restarted and at `16:52:01Z` both daemons
> redeployed from `d386322a` to `55ec1424`, which changed every pid and every
> pane id. Read pids, shas and pane ids below as history. For the
> post-restart state, see "Signal 2 / demonstration 6: FAILED" at the end of this
> page, and read your own host/port/unit from your own workspace's
> `ENVIRONMENT.md` rather than from any value on this page.

| | This agent's daemon | The story's daemon |
|---|---|---|
| host : port | `servyboi` : `7717` | `servyboi` : `7718` (same host) |
| pid | `1000239` | `1015210` |
| Unix user | `wroosbit` | (different user — this agent could not read its `/proc`) |
| `startedAt` | `2026-09-02T14:21:08.427Z`, no restart across this whole measurement | `2026-09-02T14:47:10.673Z` (a restart of the same `build.sha`, not a new deploy) |
| `build.sha` | `d386322a9f3e15fa0d32a64e9324f68de1dcd870` | `d386322a9f3e15fa0d32a64e9324f68de1dcd870` (same build) |
| `herdr` socket | `/home/wroosbit/.config/herdr/herdr.sock` (pid 190643, up since `2026-08-21`) | a different socket, under the story's own user — not queried by this agent |
| `BUTCHR_PROJECT_ALLOWLIST` | unset (confirmed by printing the matching `grep` line — no match) | `BUTCHR,CATA,SCHEM,SICKOS,RINTH,LIBS,DROVR,CNDLX` |
| project-tier rows on that herd | **zero project-shaped rows among the 15 agents tracked by the herdr at `/home/wroosbit/.config/herdr/herdr.sock`, checked at `2026-09-02T14:55:19Z`** — not "the row disappeared," never present | eight, one per allowlist entry; running-set == allowlist-set exactly (checked by the story at `2026-09-02T14:52:37Z`) |

The port discovery itself (`7717` vs. `7718`, same host) came out of this
comparison — neither agent could have found it from its own side alone,
since each side's own `ENVIRONMENT.md`/`/health` only ever names its own
daemon. **Both readings, taken alone, were internally consistent and
neither instrument errored or returned an ambiguous result** — that is
what makes this shape dangerous: a second read of the SAME wrong daemon
would have agreed with the first perfectly, and been equally wrong. The
only thing that caught it was cross-checking against a second,
INDEPENDENT source (the story's own vantage point), not a repeated read
from the same one — the general form of "arrange for a second source
before you need one" this ticket asks for throughout.

## Signal 2 verdict

**RECORDED BELOW, by story BUTCHR-119** — see "Signal 2 / demonstration 6: FAILED"
at the end of this page.

(This section originally said the verdict lived on BUTCHR-119 and not on
this page. The story owed that verdict, took the measurement, and has
appended it here instead, so that the durable artefact carries the result
rather than pointing at a page that does not. The forward-reference is
rewritten rather than left standing, because a page that promises a result
it does not contain is exactly the staleness this repo's review convention
exists to catch.)

**The verdict is FAILED**, and the section below locates the mechanism:
`projectVerdict` does not return `"asleep"` for BUTCHR even with all three
wake rules caught up, so the project never leaves `desired` and its pane is
never released. The defect is upstream of both `atRest` and the exit path.

Two earlier drafts of this page reached different conclusions on weaker
evidence — one recording FAILED on a window later voided by a herdr restart,
one recording UNOBSERVABLE while an unconsumed wake trigger was still
pending. Both were withdrawn before shipping. The section below records that
history rather than deleting it, because a withdrawn verdict is part of the
record.

BUTCHR-187's own vantage point could not observe the project agent that
demonstration 6 is about (see above); the story's own vantage point can, and
per the story's own instruction ("if you are not \[on the right daemon\], say
so plainly and hand back what you have — I will take the measurements from
here and that is a complete delivery on your side, not a shortfall"), the
story took the measurements from its own daemon and recorded them below.
Note that the daemon it observed was restarted and redeployed partway
through; the section below states which observations that voided.

What this document DOES establish, first-hand, and stands behind:

- **Signal 1 is PROVEN** — see above — and is unaffected by any of this,
  because the Jira/Confluence artefact it reads is a single shared
  resource with no per-daemon view; this agent's independent read of it
  matches the story's exactly.
- **This agent's own daemon cannot perform demonstration 6 at all**,
  confirmed by direct, fresh, first-hand measurement (not inherited): its
  `BUTCHR_PROJECT_ALLOWLIST` is empty, live, and its herd has never
  contained a `BUTCHR` project-tier agent.
- **A live specimen of "right question, wrong daemon"** producing a
  confidently-wrong PROVEN-shaped answer, caught by re-deriving the check
  rather than by a second read agreeing with the first (a second read of
  the SAME wrong daemon would have agreed perfectly and been equally
  wrong — the trap this repo's other docs and this ticket both name as
  the dangerous one).

## What this document could not establish

- The full daemon/Unix-user topology of this host — how many
  `butchr.service` instances exist, under which users, and which one(s)
  are authoritative for which projects. Not investigated further, per the
  story's explicit instruction not to chase the multi-daemon situation
  itself.
- Whether the `2026-09-02T14:21:59Z` log line, on THIS agent's own
  (wrong-for-this-purpose) daemon, `[labels] BUTCHR: quiet label writes
  enabled (ADMINISTER_PROJECTS)`, is the same administrative grant the
  story refers to as unblocking the property write, or a separate
  permission surface — and, now that this agent's daemon is known not to
  be the one staffing `BUTCHR`'s project agent, whether that log line is
  even relevant to demonstration 6 at all.
- Demonstration 6 itself — PROVEN or FAILED — which this document
  explicitly does not attempt to resolve from inherited snapshots of a
  daemon this agent cannot independently query, for the reasons above.

---

# Signal 2 / demonstration 6: **FAILED** — recorded by story BUTCHR-119

Measured from the daemon that can see the project tier — the vantage point
BUTCHR-187 correctly identified it did not have. Read your own host, port and
unit from your own workspace's `ENVIRONMENT.md`; more than one butchr daemon
runs on this host under different Unix users, and a wrong-daemon query returns
REAL data about the wrong daemon.

**OBSERVATION and MEANING are kept separate below, as everywhere on this page.**

## OBSERVED

Watermark advance, then 22 consecutive polls at 60s:

```
advance                      17:04:02Z   version 16 -> 17 , comment 17334326 -> 17760259
polls after the advance      22 consecutive, 17:04:02Z .. 17:25:12Z
BUTCHR row                   PRESENT on ALL 22, pane wDJ:p1 throughout
BUTCHR_ABSENT polls          0
HERDR_UNREADABLE polls       0
five non-wake keys           byte-intact on all 22 polls
[butchr:frozen] on root doc  0    (12 footer comments, PER-PAGE form, HTTP 200)
[frozen] in daemon journal   0    (whole post-deploy window, LOCAL --since)
```

All three wake rules caught up, each read off the artefact it is computed from:

```
wake.version = 17         root doc 11600050 current version.number = 17    -> caught up
wake.comment = 17760259   newest footer comment id = 17760259              -> caught up
wake.epics   = {}         BUTCHR epics with status "In Review" = 0         -> caught up
```

Rule 3 was checked BEFORE concluding, with its failure condition stated first:
*any BUTCHR epic In Review and absent from `wake.epics` would be a genuine
pending trigger, making `"active"` correct behaviour and leaving the window
uninformative.* Zero found.

## MEANING — FAILED, and the mechanism is LOCATED

**The project agent does not exit and its pane is not released, with nothing
left for it to do.**

The verdict rests on row presence and the pane, never on a status word — every
one of those 22 polls read `done`, and `mapAgentStatus` maps both `done` and
`idle` to idle. Only an absent row (`raw == null`) means no agent.

**It is the verdict, not the guard and not the exit path.** The frozen-asleep
detector is obliged to SPEAK FIRST, ACT SECOND: it posts `[butchr:frozen]` on
the resource's own channel *before* protection is ever withdrawn, and it also
logs `[frozen]`. BUTCHR's `firstObservedAt` could start no later than ~17:07;
the bound is 10 minutes; project polls land ~17:17 and ~17:22. **Two qualifying
polls passed with nothing on either channel.**

Therefore BUTCHR is **not in `restingRunning` at all** — `projectVerdict` is not
returning `"asleep"` for it, despite every wake rule being caught up:

```
projectVerdict never says "asleep"
  -> the project never leaves `desired`
    -> `stop = running − desired − atRest` never contains it
      -> the pane is never released
```

**The defect is upstream of both `atRest` and the exit path.** The agent does not
freeze; `atRest` does not over-protect. **The exit path has not been tested — it
has never been reached.**

## What moved, and it is not nothing

BUTCHR-68's chain was `403 -> wake never persists -> FAIL-OPEN -> "active"
forever -> never stopped -> pane never released`. **The first link is broken**:
the watermark persists, and persisted across a process restart AND a 15-commit
deploy with all five pre-existing keys byte-intact. The failure has moved to a
later link. "FAILED" alone would hide that.

## What this does NOT establish

- One subject, one window, immediately after a restart. It says nothing about
  the other allowlisted projects and licenses no fleet-wide claim.
- It does **not** settle whether a released pane would mean the agent exited or
  the daemon reaped it. That distinction splits the row-goes-absent branch; the
  row never went absent, so the question is untouched — not answered.
- `checkFrozenAsleep` remains **untested**: it cannot fire for a resource that
  never reads asleep. "Exists" and "fires" stay separate claims.

## Two corrections to this story's own pre-registered criterion

Recorded rather than smoothed over, because quietly moving a threshold after
seeing data is the exact failure pre-registration exists to prevent. Both were
disclosed before the data landed under them, and both made the more publishable
FAILED verdict *harder* to reach.

1. The original threshold — row present three polls after the advance — sat
   **inside** the 10-minute `atRest` window, where a correctly-sleeping project
   is protected from being stopped. It could not distinguish "never sleeps" from
   "slept and is guarded", and would have produced a **false FAILED**.
2. The corrected threshold was **still wrong**: the bound runs from
   `firstObservedAt` — the first poll reading asleep-and-running — not from the
   watermark advance, and is evaluated only on 5-minute project polls.

The superseded thresholds are deliberately not restated as results: a number in
the record that looks like a verdict but is not one is worse than no number.

## Method worth reusing: a duty to announce is an instrument

Correction 2 turned a purely absence-shaped demonstration into one with a
**positive** signal. When a module documents an obligation to announce before it
acts — "speak first, act second" — that obligation is a probe: its silence
carries information about internal state that is otherwise unobservable. Here it
is what separates "the agent froze past the bound" from "the verdict never said
asleep", a distinction previously recorded as undecidable from outside.

Generalisable wherever such a rule is written down; `[butchr:frozen]` is only
this story's instance of it.

## What these instruments could not see

- **60s polling.** Anything appearing and disappearing inside one interval is
  invisible to every claim here.
- **Pane release IS visible** — proved by an unplanned positive control
  (`butchr-butchr-164` vanished and released `wBC:p1`), not assumed. So an
  absent row would have been detected had one occurred.
- **The complaint-absence is a two-channel negative** (Confluence footer
  comments AND the journal), and the daemon does emit `[frozen]` from that
  module, so it is meaningful rather than vacuous. It excludes a complaint
  *posted*; it cannot exclude a detector that never ran — which is why the
  conclusion is stated as "not in `restingRunning`", not "the detector is
  broken".
- **A momentary `"inactive"` verdict between two polls remains unexcluded.**
  Nothing here turns on it, since the row never went absent.
- **Verdict internals are not logged at this level** (emitted tags post-deploy:
  `[tools]`, `[labels]`, `[notify]`, `[pr]`, `[prompts]`, `[health]`,
  `[reconcile]`). The complaint, not the log, is what carries the signal.

## The next measurement, named rather than left as a shrug

**Why does `projectVerdict` not return `"asleep"` for BUTCHR when all three wake
rules are caught up?** That is now the whole remaining question for this
demonstration, and it is a code-reading question rather than an observation one.
Verdict-level logging — the value returned for a project on a given poll, or the
contents of `desired`/`atRest`/`plan.stop` — would settle it directly.

## Scope kept

`atRest` was **observed and reported, never changed**. One correction for the
record: the premise that its window is "unbounded, and nothing enforces it" is
not merely stale — `checkFrozenAsleep` and `atRestMinutes` defaulting to 10 are
**BUTCHR-123's shipped deliverable** (BUTCHR-95, BUTCHR-116 and BUTCHR-123 are
all Done). The ticket text describing that defect as open has outlived the work.

`finish_without_a_boss` untouched (BUTCHR-101, standing hold). The `/health`
five-minute post-restart red window observed again (`projectNotify` state
`"starting"`) and deliberately not decided. Pane contention not investigated
(BUTCHR-111). The herdr restart and the deploy not investigated.

## One consequence worth stating plainly

The project tier is enabled fleet-wide — the running daemon's allowlist names
nine projects. BUTCHR-68 projected "-1 pane permanently today, and -6 if the tier
were fully enabled with the 403 unfixed". **With demonstration 6 FAILED, that
exposure is unretired**: a project that cannot sleep holds its pane, from a pool
that is already the binding constraint under burst. The measured subject is
BUTCHR alone; the other projects are not measured and are not claimed.
