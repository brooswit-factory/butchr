# Wake watermark persistence and the project tier's sleep cycle (BUTCHR-187, implementing BUTCHR-119)

Answers, by direct measurement against the live production daemon and the
live Jira/Confluence artefact, two questions BUTCHR-68 left FAILED:

1. Does the project tier's `wake` watermark write (`advanceProjectWatermark`
   -> `AtlassianOps.setProjectProperty`) now persist, without corrupting the
   other keys already on the `butchr` project entity property?
2. Does a project agent that has caught up on its watermark actually EXIT —
   row gone from `herdr agent list`, pane released — rather than merely
   reporting `agent_status: "done"`?

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
  (`wroosbit`) socket. Confirmed to be the correct instance for this
  daemon two ways: (a) `systemctl --user status herdr.service` shows this
  socket's `herdr server` process (pid 190643) has been running
  continuously since `2026-08-21 12:39:48 PDT` — no restart anywhere near
  this measurement window, so nothing here can be explained by an
  observation-tool restart; (b) this very agent's own row
  (`butchr-butchr-187`, `cwd: /home/wroosbit/butchr-workspaces/BUTCHR-187`)
  appears correctly in its output. A second, DIFFERENT herdr process
  (pid 167214) exists on this host under a different Unix user
  (`booswrit`) — exactly the "invisible to your own tooling" trap the
  story warns about — and was not used for anything in this document.

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
own instruction, and because (see "An unresolved tension" below) this
document found a fact in the running code that is in tension with it.

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

## Signal 2 — demonstration 6: observations

### The story's own snapshot, inherited

At `2026-09-02T14:45:07Z`: `butchr-butchr  w47:p1  idle` — **still present**,
still holding the pane. (Correctly NOT treated by the story as an exit,
per the `done`/`idle` trap above.)

### A positive control the story obtained and handed down

Between `14:42Z` and `14:45Z`, the unrelated row `butchr-butchr-164`
vanished from `herdr agent list` entirely, releasing pane `wBC:p1`. This is
what makes a later "row absent" interpretable at all: without a
demonstrated case of this exact instrument catching a real release, a
"row absent" result could not be distinguished from "this instrument
cannot see releases" (the blocked-read-is-a-fact-about-the-instrument
trap). Not independently re-derivable by this agent (the row is long gone
by the time this agent could check) — inherited, but the underlying
mechanism (row disappearing = release) is the same one this document's own
polls exercise below, on the SAME `herdr` instance, confirmed above to be
the correct one.

### This agent's own, independently timestamped polls

All four against the same confirmed-correct `herdr` instance, all parsed
as JSON (never `grep -q`), all printing what was matched:

| # | UTC timestamp | `butchr-butchr` row |
|---|---|---|
| 1 | `2026-09-02T14:48:16.518Z` | **ABSENT** |
| 2 | `2026-09-02T14:49:36.213Z` | **ABSENT** |
| 3 | `2026-09-02T14:50:43.575Z` | **ABSENT** |
| 4 | `2026-09-02T14:51:05.191Z` | **ABSENT** |

Four consecutive polls, spanning ~2m49s, all absent — satisfies the
story's "at least three consecutive polls" bar against a one-poll blink.
No poll in this window returned an error or an ambiguous read; every poll
returned a well-formed agent list containing OTHER rows (this agent's own
row among them), so this is not a case of "instrument unreadable."

**Beyond the row: the whole workspace is gone, not just the agent's
status.** `herdr workspace list`, checked at the same time as poll 3-4, has
no workspace with id `w47` at all — not merely an agent-status change on a
surviving pane, but the container itself torn down. This is a stronger
observation than a status flip: `pane.close()` (the code Signal 2's check
targets, above) is consistent with this outcome.

**Meaning, stated separately:** the project agent's row and its pane/
workspace were observed to be gone, in a sustained way (not a blink), by
the time this agent began observing (first read `2026-09-02T14:48:16Z`,
i.e. sometime in the ~3-minute window after the story's own
`14:45:07Z` "still present" snapshot). **The row-disappeared /
pane-released FACT is well established.** What that fact is attributable
to is addressed next, separately, because the two are not the same claim.

## An unresolved tension this document found, and could not resolve from outside observation alone

While establishing Signal 2's check (see the `plan.stop` derivation
quoted above), this agent also re-checked, against the exact deployed
commit, how the project tier's `desired` and `atRest` sets are computed —
because both feed directly into whether `stop` fires.

**This daemon's own startup log line, unprompted, printed:**

```
projectAllowlist=EMPTY — project tier staffs nothing
```

(`src/config/config.ts`'s `describeConfig`.) Checked at TWO daemon boots:
this one (`2026-09-02T14:21:08Z`) and the immediately preceding one
(the routine hourly deploy at `2026-09-01T21:43:04` local) — both EMPTY.
`BUTCHR_PROJECT_ALLOWLIST` is a process-start env var, so it cannot have
changed without a restart; none occurred between those two boots and this
measurement.

`src/resources/project.ts`, `loadProjects`, at the exact deployed commit:

```
const led = raw.values.filter((p) => p.lead?.accountId === me.accountId && deps.allowlist.has(p.key));
```

With the allowlist empty, `led` — and everything the function derives from
it (`eligible`, `ineligible`, and therefore its entire return value) — is
`[]` on every single poll, unconditionally. `src/daemon/loop.ts`'s poll
body confirms `desired` and `atRest` are both computed from that exact
same `issues` array (`desiredFrom(issues, ...)`, `atRestFrom(issues, ...)`)
with no other source. So under this daemon's live, currently-running
configuration: **`BUTCHR` never reaches `eligible`, is never a member of
`desired`, and is never a member of `atRest` — regardless of what
`projectVerdict`/the wake watermark says.** `stop = running − desired −
atRest` therefore contains `BUTCHR` on every project poll in which it is
running, **unconditionally** — the exact same outcome the wake-fix path
would also produce once the watermark catches up, but reached by a
completely different, wake-independent route.

**This also answers the story's def-of-done item about what `atRest` was
observed doing during the post-watermark window: it could not have been
protecting `BUTCHR` at all, because `BUTCHR` was never in the set
`atRestFrom` computes over in the first place.** Whatever stopped the
pane, it did not pass through an `atRest`-guarded window for this
project, under this configuration — not because the guard failed, but
because this project was never a candidate for it. (`atRest` itself was
not touched, loosened, or investigated further — out of scope per the
story, and this finding does not require touching it.)

**The tension this creates, stated plainly:** the same allowlist gate has,
on the story's own telling, been `EMPTY` across at least the last two
daemon boots (spanning the period `BUTCHR-68` reports `w47:p1` as
continuously held since `06:43` the previous day). If `stop` really does
include `BUTCHR` unconditionally on every ~5-minute project poll whenever
it is running, that predicts repeated stop attempts throughout that
24+-hour window — in tension with a pane reportedly held continuously
across it. This document could not resolve that tension: it did not find
a log line recording an explicit `herd.stop("BUTCHR")` call or its
outcome (success or failure) at any point, before or during this
measurement, and does not know whether the pane was being
closed-and-silently-recreated by some other mechanism, whether earlier
`stop` attempts were failing, or whether the "continuously held" premise
itself (inherited from BUTCHR-68, explicitly flagged by the story as not
settled fact) does not hold up. **Named here as NOT ESTABLISHED rather
than guessed at.**

**Practical consequence for THIS measurement:** because the allowlist gate
is independently sufficient to force the exact same observable outcome
(row gone, pane released) regardless of the wake watermark's value, this
document cannot, from `herdr`/Jira observation alone, distinguish:

- (a) the wake watermark persisted -> `projectVerdict` correctly computed
  `"asleep"` -> excluded from `desired`, protected briefly by `atRest`
  until settled -> `stop` -> pane released (the mechanism this story
  exists to prove), from
- (b) `BUTCHR` was never eligible/desired/at-rest at all, this poll or any
  other, because of the allowlist gate -> `stop` -> pane released,
  entirely independent of the watermark.

Both produce byte-identical `herdr agent list` output. This agent raised
this specific tension to the story (`ask_boss` on BUTCHR-187,
`2026-09-02T14:50:39Z`) before committing verdict language here, precisely
because a wrong claim in the flattering direction is the one this ticket
warns is least likely to be caught by the agent making it.

## Signal 2 verdict

- **The observation** — `butchr-butchr`'s row and pane/workspace gone,
  sustained across four consecutive independently-timestamped polls
  spanning ~2m49s, following a successful watermark write, with a positive
  control proving the instrument can see a real release — is **PROVEN**.
- **The causal claim demonstration 6 exists to establish** — that this
  release happened BECAUSE the persisted wake watermark caused
  `projectVerdict` to compute `"asleep"` — is **NOT ESTABLISHED**. A fully
  sufficient, independently-verified alternative explanation
  (`projectAllowlist=EMPTY` on the currently-running daemon, which forces
  the identical `stop` outcome regardless of watermark state) was found in
  the exact deployed source and could not be ruled out from outside
  observation. "Not established" is stated here as a first-class result,
  per the story's own instruction, rather than resolved by picking
  whichever reading flatters this increment.

This is not a claim that the fix does not work — Signal 1 shows the write
genuinely persists, cleanly, with no data loss, which is real, hard-won
progress this story asked for. It is a claim that **this specific
environment's current configuration cannot currently distinguish "the fix
caused the sleep" from "the sleep would have happened regardless of the
fix,"** and that distinguishing them needs either a resolution of the
allowlist tension above, or a repeat of this observation once `BUTCHR` is
confirmed to sit on `BUTCHR_PROJECT_ALLOWLIST` with the watermark
deliberately made stale first (so `projectVerdict` would name it
`"active"`, and a stop in that state would be unambiguous evidence the
allowlist path, not the verdict path, was firing).

## What this document could not establish

- Why the pane was reportedly held continuously for 24+ hours under a
  config that (per the code read here) should force a stop attempt on
  every ~5-minute project poll — see "An unresolved tension" above.
- Whether the `2026-09-02T14:21:59Z` log line `[labels] BUTCHR: quiet
  label writes enabled (ADMINISTER_PROJECTS)` is the same administrative
  grant the story refers to as unblocking the property write, or a
  separate permission surface. Circumstantial (same daemon boot, close in
  time to the grant being expected) but not independently confirmed to be
  the identical grant.
- Whether `herd.stop("BUTCHR")` was actually attempted-and-failed multiple
  times before this measurement window, attempted-and-succeeded exactly
  once, or never attempted at all before now — no log line recording this
  call's outcome was found for the project id specifically.
