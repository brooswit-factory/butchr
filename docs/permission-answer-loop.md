# The permission-answer loop / "lizard mode" (DROVR-42, FACTORY-67, FACTORY-87/FACTORY-76)

> **FACTORY-145: every `answered:` journal line and audit record now carries
> a `trigger` (`"fast"` or `"sweep"`), plus a `latencyMs` number when
> `trigger` is `"fast"`.** See "Fast-path latency (FACTORY-145)" further down
> for the exact field shapes and how to compute p50/p95 from the audit file.
> `latencyMs` is a lower bound on the operator-visible wait (it excludes
> whatever time herdr itself took to notice the pane went blocked and get a
> frame to butchr, plus ordinary network/socket delay before receipt) and is
> never emitted for a sweep-triggered answer, whose true wait is unknowable.

> **FACTORY-98 (FACTORY-97): a lizard-eligible pane is now usually answered
> within about a second, not up to 20s.** The daemon opens a herdr push
> subscription (`pane.agent_status_changed`) filtered to exactly the
> currently-eligible pane ids, and answers a pane at once on a `blocked`
> transition. The 20s scan below is unchanged and still runs as a fallback —
> see "Event-driven: the fast path (FACTORY-98)" further down for what
> changed, why it still needs the scan at all, and what stayed a scan-only
> path (CPU sanity, respawn-loop safety). Text above and below that section
> describing "the" 20s timer as the only mechanism predates this change but
> is otherwise still accurate: the scan itself, its opt-in gate, its cadence,
> and its audit/journal behavior are all unchanged.

> **FACTORY-93 (drovr >= 0.15.1): the loop now calls `autoAnswerPermissions`
> with `scope: "once"` — it presses option 1 "Yes" (allow once), never the
> "always allow" option.** Matching Claude's "always allow" wording was
> fragile: the read-permission dialog says "Yes, allow reading … from this
> project" and was silently skipped, freezing the codey canary. No stored
> allow rules are written any more. Every skipped pane is now logged
> (`[permission-answer] <label> (<pane>) SKIPPED, left for a human: <reason>`),
> once per pane+reason. Text below describing the "always allow" option
> predates this change.

## What it is

DROVR-37 shipped `autoAnswerPermissions(client, { auditPath, operator?, readTimeoutMs? })`
in `@brooswit/drovr` (>= 0.15.0): an unattended pass that scans every Claude
pane for a pending tool-permission dialog ("Do you want to proceed?") and
presses the "Yes, and always allow … from this project" stored-rule option
only when it is unambiguously that option — auditing every attempt. DROVR-41
proved it live against a real herdr pane and recommended wiring it into
butchr's own daemon.

That recommendation (DROVR-42) was originally scoped as a blanket sweep over
every Claude pane. Before it merged, FACTORY-67's director narrowed the ask:
the operator wants this as an **explicit, per-agent opt-in** — `lizardMode: true`
on a managed-session definition (`SessionDefinition`, `src/resources/session-definition.ts`)
— named "lizard mode" for the combination the field exists for: `permissionMode: "default"`
(Claude's manual/ask mode, prompting before every tool call) plus this field,
so an agent gets manual mode's own safety for every OTHER decision while
never sitting frozen on the ONE dialog drovr already knows how to answer
unambiguously. A definition that doesn't set the field behaves exactly as
before — nothing here is a blanket sweep.

`src/agents/permission-answer-loop.ts` is the daemon-side wiring:
`startPermissionAnswerLoop` wraps `autoAnswerPermissions` on its own
`setInterval`, started in `src/daemon/index.ts` right after
`blockingEscalationTimer`, scoped every tick to exactly the panes an
`eligiblePanes` hook names.

## The opt-in gate

`SessionDefinition.lizardMode?: boolean` (default `false`/absent) is
validated at manifest load like every other definition field (rejected for
`vendor: "codex"` — drovr's `classifyPermissionPrompt` is Claude-specific and
never matches a Codex pane's screen, so a Codex definition setting this would
silently do nothing; same treatment as `strictMcpConfig`'s own Codex
rejection, not `permissionMode`'s more lenient "stored but unforwarded"
precedent).

Unlike `permissionMode`/`strictMcpConfig` (see "No argv, no stale-argv risk"
below), `lizardMode` never reaches `SpawnSpec` or the launched process's
argv. It is surfaced purely as a **live, rebuilt-every-poll map** —
`ManagedSessionResourceDeps.lizardModes` (`src/rules/session-definition-type.ts`),
threaded through `ManagedSessionsLoopDeps.lizardModes`
(`src/daemon/session-definitions-loop.ts`) to a module-level
`managedSessionLizardModes: Map<string, boolean>` in `src/daemon/index.ts`,
cleared and repopulated from that poll's eligible definitions every
managed-sessions poll (`MANAGED_SESSIONS_POLL_MS`, 15s), same shape as the
pre-existing `roles`/`accountPolicies` maps (BUTCHR-408/BUTCHR-460).

The permission-answer timer's own `eligiblePanes` hook (`lizardModeLabel` in
`src/daemon/index.ts`) consults `ruleLizardModeOf`/`lizardModeLabelFor` fresh
every 20s tick: for each pane herdr reports, resolve its rule-engine agent id
from `cwd` (`agentIdOfWorkspacePath`, the same resolution
`managedSessionOfPane` already uses for escalation), and include it only if
that id's own lizard-mode opt-in is `true`. For a managed session
(`ownsManagedSessionAgent`) that opt-in comes from the live
`managedSessionLizardModes` map exactly as before; for every OTHER
rule-engine agent id (FACTORY-87/FACTORY-76 — a `jira-work`, `jira-project`,
`github-issue`, `github-pr`, or plain `filesystem` rule) it comes from that
id's own `Rule.lizardMode`, looked up against the daemon's already-loaded
`rules` list (see `docs/execution-modes.md`'s "`permissionMode` and
`lizardMode`" section for why a rule needs no live poll the way a
managed-session definition does). A pane that resolves to anything else — a
legacy/bare-issue agent, a managed session or rule that never set the field,
a managed session not yet observed this daemon's lifetime — is excluded,
matching "absent field means today's behaviour exactly" down to the herdr
call count: a tick with nothing eligible costs exactly one `agent.list()`
call and nothing else (see `runPermissionAnswerTick`'s own doc comment).
`ruleLizardModeOf`/`lizardModeLabelFor` themselves are pure, exported
functions in `src/agents/permission-answer-loop.ts` (`src/daemon/index.ts`
only binds them to its own live `rules`/`managedSessionLizardModes`/
`ownsManagedSessionAgent`) — extracted there specifically so the decision has
its own unit tests independent of `src/daemon/index.ts`, which has no
exports and cannot itself be imported by a test without running the whole
daemon's startup side effects (PR #478 review, `permission-answer-loop.test.ts`'s
own "`ruleLizardModeOf` / `lizardModeLabelFor`" tests).

**Toggling the field is live, no respawn.** Since it isn't part of argv, an
operator can flip `lizardMode` in a manifest and see it take effect on the
very next managed-sessions poll (up to 15s) plus the next permission-answer
tick (up to 20s) — no agent restart, no stale-argv complaint, nothing to
reconcile.

## No argv, no stale-argv risk (FACTORY-43)

FACTORY-43 fixed a real bug: `HerdrHerd.staleIssues()` used to recompute its
"expected argv" for a running managed-session agent from scratch, silently
ignoring the definition's actual `permissionMode`/`strictMcpConfig` and
respawn-looping whenever they diverged from a hardcoded default. The fix
persists both fields at spawn time (`buildWorkspace()`,
`.butchr-permission-mode.json`/`.butchr-strict-mcp-config.json`) and reads
them back into the SAME `spawnArgs()`/`agentLaunchConfig()`-style builder the
real launch path uses — no second, independently-recomputed expectation.

`lizardMode` was deliberately kept OUT of that shape rather than extended
into it: it never becomes a CLI flag (`specForSessionDefinition`,
`src/rules/session-definition-type.ts`, never puts it on the `SpawnSpec` —
see that module's own test asserting exactly this), so there is no argv for
a stale-argv check to compare in the first place, and no persist/read-back
pair to keep in sync. This is checked in, not merely asserted: see
`session-definition-type.test.ts`'s "lizardMode is deliberately NEVER
carried into the SpawnSpec" test. `Rule.lizardMode` (FACTORY-87) keeps the
exact same shape: no `specFor*` builder ever puts it on its `SpawnSpec`
output either, for the same reason.

`Rule.permissionMode` (FACTORY-87) is the opposite case, and needed no new
persist/read-back logic at all: `buildWorkspace()`/`staleIssues()`'s pair
above already reads/writes `spec.permissionMode` generically, for any spawn —
it was never gated on being a managed session — so a rule-launched agent
setting `permissionMode` gets FACTORY-43's stale-argv safety for free. See
`docs/execution-modes.md`'s "`permissionMode` and `lizardMode`" section for
the full field story on the rule side.

## Why its own timer

Three independent pane-scanning timers now run in `src/daemon/index.ts`:

| Timer | Interval | Scope | Presses keys for |
| --- | --- | --- | --- |
| `watchPrompts` (`src/agents/prompt-watch.ts`) | 5s | every pane | startup dialogs, via `chooseStartupAnswer` (trust, Bypass-Permissions first-run, fullscreen-renderer, settings warning/recommendation, resume-from-summary) |
| `blockingEscalationTimer` (drovr's `createBlockingEscalationWatcher`) | 5s | every pane | nothing — detects and escalates unknown dialogs only, `sendKeys` is a permanent no-op (see `docs/managed-sessions.md`'s "Two detectors, one mark") |
| **permission-answer loop / lizard mode** (this ticket) | 20s | only `lizardMode: true` panes | the tool-permission "always allow" dialog only, via `autoAnswerPermissions` |

Each is deliberately separate: a Jira reconcile failure must never stall
permission-answering, a wedged permission-approve attempt must never stall
reconcile, and neither pane-scanning timer's own hiccup should affect the
other. `startPermissionAnswerLoop` uses the same in-flight guard
`blockingEscalationTimer` does — two ticks never run concurrently against the
same pane set; a slow tick just makes the next firing a no-op.

**No double-answerer hazard.** `chooseStartupAnswer` has no case for the
"Do you want to proceed?" tool-permission dialog — it only recognizes
startup-shaped dialogs (see the table above). `autoAnswerPermissions` only
recognizes tool-permission dialogs (drovr's `classifyPermissionPrompt`). The
two answerers' target dialog shapes are disjoint, so — unlike drovr's
escalation watcher, which needed its `sendKeys` overridden to a no-op to
avoid racing `chooseStartupAnswer` on the *same* startup dialogs — nothing
here needed suppressing.

## Cadence: 20s, and why

DROVR-41's own recommendation was the 15-30s order of magnitude. Landed at
20s: inside that range, slower than the two 5s status-poll timers above (a
scan for *any* pending prompt, worth doing more often since it's cheap —
`scanPendingPermissions`'s own per-pane read deadline is a fixed 1500ms,
reads run in parallel), and close to this daemon's own ~15s Jira reconcile
cadence under load (BUTCHR-117: repeated `agent_pane_busy` spawn failures
observed at a 15s poll interval) — a bound already proven acceptable
elsewhere in this same daemon, without adding a fourth distinct polling
rhythm to reason about. The lizard-mode opt-in gate only shrinks the real
per-tick cost further (most ticks, on a fleet with zero or few lizard-mode
panes, do one `agent.list()` call and nothing else), so this cadence has
even more headroom than the "every pane" version it replaced. Re-derive this
if the fleet's real lizard-mode pane count grows meaningfully; it was not
load-tested against a fully-populated fleet.

`readTimeoutMs` (8s) — the deadline for one pane's whole approve attempt —
is set comfortably below the 20s interval, per
`AutoAnswerPermissionsOptions.readTimeoutMs`'s own doc comment: without that
margin, a wedged pane's approve attempt could still be in flight when the
next tick fires. 8s itself has margin over drovr's own internal
approve-verify budget (`verifyTimeoutMs` defaults to 5000ms, `pollMs` to
250ms — `node_modules/@brooswit/drovr/dist/index.js`), not picked to exactly
match it.

If `readTimeoutMs` is hit, the outcome is a `failed`/`timeout` result — NOT
proof nothing was pressed. `approvePermission` is not cancelled: it keeps
running and may still press keys and record `approved` in the audit log
after the tick that logged the timeout has already returned. Check the audit
log for the pane, not just the console line.

## Event-driven: the fast path (FACTORY-98)

FACTORY-97 (the story this ticket implements) reported blocks up to 47s live
on codey: every tool call needing permission waited for the next 20s tick,
and a tool-heavy agent felt visibly slower for it. FACTORY-98 investigated
what `@brooswit/herdr-sdk`/`@brooswit/drovr` actually offer for this —
"pick what is real, not what is assumed" — and found a real one:
`events.subscribe` (`HerdrClient.subscribe`, passed straight through by
`DrovrClient.subscribe`) is a genuine long-lived push connection, and
`pane.agent_status_changed` is one of its subscription kinds.

**The catch, verified against the SDK's own generated types
(`generated/params.d.ts`'s `Subscription` union), not assumed:**
`pane.agent_status_changed` is one of exactly three subscription kinds that
REQUIRE a specific `pane_id` filter — there is no "any pane" wildcard the
way there is for, say, `pane.created`. So this cannot replace the scan
above: something still has to read `agent.list()` and the `lizardMode` gate
to learn WHICH panes are eligible before it can even ask herdr to push their
status changes. What the push connection changes is WHEN an already-known
eligible pane gets answered.

**Wiring (`src/agents/permission-answer-watch.ts`,
`startPermissionAnswerWatch`, replacing the bare
`startPermissionAnswerLoop` call in `src/daemon/index.ts`):**

- The 20s sweep keeps running exactly as described above — same
  `eligiblePanes` gate, same `agent.list()` call, same `autoAnswerPermissions`
  pass, same audit/journal output. It is now also the mechanism that keeps
  the push subscription's pane-id filter in sync: `runPermissionAnswerTick`
  gained an optional `onEligiblePaneIds` hook, called with the exact set
  `eligiblePanes` returned THIS tick, before any screen is read. The watch
  uses it to notice the eligible set changed and, only then, close the old
  subscription and open a new one for the new set — no second `agent.list()`
  call to notice topology change.
- On a `pane.agent_status_changed` push frame reporting `blocked` for a pane
  in the current set, the watch fires a tick immediately, the same
  `runPermissionAnswerTick` call the sweep itself uses.
- **One shared in-flight guard, coalescing rather than dropping.** The
  event-triggered tick and the periodic sweep both go through the same
  `inFlight` boolean `startPermissionAnswerLoop` already used for the
  sweep-only case — they can never run concurrently against the same pane
  set. A `fire()` that arrives mid-tick does NOT drop the request: it sets a
  `pending` flag, and the running tick's own completion runs exactly one
  more tick before going idle if it sees that flag set. This matters for the
  exact case the story exists for — a tool-heavy agent whose own NEXT tool
  call goes `blocked` again while the current tick is still mid-approve/
  verify on the previous one; dropping that event would leave it to the 20s
  fallback, missing the latency goal whenever more than one prompt is in
  flight at a time. A burst of N such requests during one tick still costs
  at most one trailing tick, never N — bounding the read-scan rate the same
  way `startPermissionAnswerLoop`'s own "a slow tick just makes the next
  firing a no-op" bound always did, just without discarding the request that
  arrived during the busy window.
- **A newly-eligible pane's first tick is still scan-driven.** A pane isn't
  subscribed to until a sweep tick has seen it as eligible at least once —
  so it gets the ≤20s bound (unchanged from before this ticket) on its first
  tick as a lizard-mode pane, and the fast, sub-3s path from the second tick
  onward. Not a regression: nothing before this ticket had a fast path at
  all. This is the one latency gap the coalescing above does not close.
- **Reconnection.** A subscription that ends on its own (herdr closed it, or
  it errored — a real socket can drop) is reopened after `resubscribeDelayMs`
  (default 2000ms) for the same pane-id set, unless a topology change has
  already superseded it. A `subscribe()` call that fails outright is logged
  (`[permission-answer] watch subscribe failed: …`) and retried the same way
  — a dead push connection degrades to "sweep only, same as before this
  ticket," never to "nothing answers."

**CPU sanity for a large fleet (20+ panes):** the push connection is exactly
one socket per DISTINCT pane-id SET, reopened only when that set changes —
not a poll, not a per-second cost, and not one connection per pane. The
`lizardMode` opt-in gate (above) is what actually bounds the set's size: an
ordinary fleet with zero or a handful of lizard-mode panes among 20+ total
panes pays for one small subscription and the same one `agent.list()` call
every 20s the scan-only version always paid — nothing here scales with the
TOTAL pane count, only with the lizard-eligible one.

**Respawn-loop safety:** unchanged from the scan-only version — `lizardMode`
still never reaches `SpawnSpec` or a launched process's argv (see "No argv,
no stale-argv risk" above), and this ticket added no new persisted state a
restart could see as stale. A `stop()`/restart of the watch simply closes
whatever subscription is open and re-derives everything from the next
`agent.list()` call, same as the scan-only version always did.

## Fast-path latency (FACTORY-145)

FACTORY-98 made a lizard-eligible pane usually get answered within about a
second, but the `answered:` journal line only recorded that an answer
happened, with the journal's own 1s timestamp resolution — no number a p50/p95
could be computed from. FACTORY-145 adds one.

**What's measured, and from where.** `permission-answer-watch.ts` records a
monotonic instant (`deps.now`, default `performance.now`, never wall-clock —
wall-clock can step backward or forward under NTP adjustment, corrupting an
elapsed-time subtraction) the moment a pane's own `pane.agent_status_changed`
push frame reports `blocked` (`fastPathTriggers: Map<paneId, instant>`).
`runPermissionAnswerTick` (`permission-answer-loop.ts`) consumes that instant
(reads it, then deletes it) for every pane it scans this tick, whether or not
the pane ends up answered — a `skipped`/`failed` outcome must not leave a
stale trigger instant behind for a later tick to (wrongly) measure against.
For a pane that ends up `answered`, the elapsed time from that trigger
instant to "this tick pressed its prompt" is `latencyMs`.

**This is a lower bound on the operator-visible wait, not the whole of it.**
The push frame's own shape (`{ pane_id, agent_status }`, no timestamp —
checked against `@brooswit/herdr-sdk`'s own generated
`PaneAgentStatusChangedEvent` type, which carries none) never tells butchr
when herdr itself observed the pane go blocked, only when butchr received the
frame reporting it. So `latencyMs` excludes whatever time herdr took to
notice the transition and get a frame to butchr, plus ordinary network/socket
delay ahead of receipt. Name it "latency from frame receipt", not "latency
from the pane going blocked", if you write about it elsewhere.

**Sweep-triggered answers carry no latency number at all — never a fabricated
one.** A pane the sweep's own `agent.list()` scan discovers (no fast-path
frame ever recorded for it — herdr's push connection was down, or the pane
became eligible too recently to be subscribed yet, see "A newly-eligible
pane's first tick is still scan-driven" above) may have been sitting blocked
anywhere from 0 to one whole sweep interval before the scan happened to look.
"Now minus when the sweep looked" is not a latency, it is an artefact that
LOOKS like one and would silently drag a computed p95 downward. Such an
answer's `trigger` is `"sweep"` and it carries no `latencyMs` field at all
(never `latencyMs: null` — the field itself is entirely absent, so any reader
that filters on the field being present rather than merely truthy still gets
the right answer).

**Field shapes**, both on the `[permission-answer] … answered: …` journal
line (as a trailing `, fast, 247ms` or `, sweep` suffix) and on the
`.permission-audit.jsonl` record appended right after drovr's own two
records (`approving`/`approved`) for that pane's attempt:

| field | present | type | meaning |
| --- | --- | --- | --- |
| `trigger` | always | `"fast" \| "sweep"` | which path caused this pane to be looked at THIS tick |
| `latencyMs` | only when `trigger === "fast"` | number (ms, rounded, >= 0) | elapsed time from frame receipt to this tick pressing the prompt |

The rest of the appended record (`ts`, `paneId`, `label`, `tool`, `request`)
mirrors the journal line's own fields, so `jq` can filter and join on them
without cross-referencing drovr's own `approving`/`approved` records for the
same attempt.

**Logging never risks or delays an answer.** The audit append happens AFTER
`autoAnswerPermissions` has already returned its outcome for the pane — a
failing `appendAudit` (disk full, permission denied) is caught and logged
(`latency audit write failed for <pane>: <detail>`), never thrown, and never
prevents or retries the answer itself, which has already happened by the time
this write is attempted.

### Computing p50/p95 from the audit file

Every fast-path answer's own latency record is a single JSONL line with
`trigger: "fast"` and a numeric `latencyMs` — filter on both (not just the
field's presence) so a future record shape with `latencyMs: null` for some
other reason can't sneak into the computation:

```sh
jq -s '
  [ .[] | select(.trigger == "fast" and (.latencyMs | type == "number")) | .latencyMs ]
  | sort
  | . as $s
  | { n: length,
      p50: $s[(length * 0.50 | floor)],
      p95: $s[(length * 0.95 | floor)] }
' .permission-audit.jsonl
```

A `trigger: "sweep"` record has no `latencyMs` at all, so `.latencyMs | type
== "number"` alone already excludes it — the explicit `trigger == "fast"`
check is belt-and-suspenders documentation of intent, not load-bearing on its
own, but keep both: a filter that only checks `.latencyMs` existing would
misread a future field with a different meaning if one is ever added under
the same name.

## The audit log

`Config.permissionAuditPath` (`src/config/config.ts`): a JSONL file, default
`.permission-audit.jsonl` under the workspace root (`BUTCHR_PERMISSION_AUDIT_PATH`
overrides), dot-prefixed like `.captures` so it can never collide with a
per-issue workspace directory. Deliberately separate from `captureDir` (the
session-limit watcher's own evidence captures) — distinct write activity,
distinct file.

Every `approvePermission` attempt appends an `approving` record before any
key is sent, and a second record with the outcome after — see
`approvePermission`'s own doc comment (`@brooswit/drovr`). Every record
carries `operator` and (on an `approved` outcome) the exact stored-rule
`option` text that was pressed. This daemon's wiring passes
`operator: "butchr-daemon"` (drovr's own default is `"drovr-auto"`) so a
shared audit file, or a human comparing hosts, can tell butchr's own
unattended pass apart from any other caller.

**A third record follows drovr's own two, for every answered pane
(FACTORY-145):** `runPermissionAnswerTick` itself appends one more JSONL line
to the SAME `auditPath` right after drovr's `approving`/`approved` pair —
this module owns that write, not drovr, since drovr's own `approvePermission`
has no way to accept extra fields to fold into its own records. See "Fast-path
latency (FACTORY-145)" above for its exact shape. A reader that assumed
exactly two records per answered attempt (drovr's own historical contract)
now sees three; nothing about drovr's own two records changed.

## Seeing recent auto-answers (FACTORY-67: mandatory, not optional)

The daemon's own journal names WHICH AGENT and WHICH TOOL for every
answer/failure, not just an opaque pane id: `[permission-answer] <definition
file> (<pane id>) answered: <tool> — "<request excerpt>" (see <auditPath>
for the exact stored-rule text)`, plus a per-tick summary line
(`N answered, M skipped, K failed`) whenever a tick answers or fails
anything (an all-skipped or empty tick logs nothing, to keep the console
quiet in normal operation). The exact "always allow" rule text pressed is
not returned by `autoAnswerPermissions` itself — recovering it without
re-parsing the pane's screen a second time (which this module deliberately
never does; dialog recognition is drovr's job, not butchr's, per
FACTORY-49/FACTORY-67) means pointing at the audit log's own `option` field
for that literal text, which the journal line does.

`tail -f <permissionAuditPath>` (or `grep`) gets the full per-attempt detail
(promptId, scope, the exact option text, both the `approving` and `approved`/
`not-cleared`/etc. records).

**Not wired into `/health` or the dashboard.** Judged not warranted for this
ticket: the journal (which now names the agent) and the audit log (append-
only ground truth) together satisfy FACTORY-67's "visible somewhere an
operator actually looks — journal and/or dashboard" requirement. If recent
auto-answer activity turns out to be something an operator wants at a
glance (the way `/health`'s `resourceLoops` surfaces other loop health),
that is a natural, separable follow-up.

## Not in this version

- **No live definition or rule was switched over.** Per FACTORY-67's own
  constraint, this ticket (and its rule-side companion, FACTORY-87/FACTORY-76)
  is code + tests + docs only — no live runtime, service, definition, or rule
  was touched. The existing codey definitions (all `permissionMode: "auto"`,
  none setting `lizardMode`) and every existing rule (none setting either new
  field) load and behave unchanged. Deploys and any live cutover go through
  admin-assembly at the operator's direction.
