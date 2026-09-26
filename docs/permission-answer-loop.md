# The permission-answer loop / "lizard mode" (DROVR-42, FACTORY-67)

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
`src/daemon/index.ts`) consults that map fresh every 20s tick: for each pane
herdr reports, resolve its managed-session agent id from `cwd`
(`agentIdOfWorkspacePath` + `ownsManagedSessionAgent`, the same resolution
`managedSessionOfPane` already uses for escalation), and include it only if
`managedSessionLizardModes.get(id) === true`. A pane that resolves to
anything else — an ordinary rule-launched agent, a managed session that
never set the field, one not yet observed this daemon's lifetime — is
excluded, matching "absent field means today's behaviour exactly" down to
the herdr call count: a tick with nothing eligible costs exactly one
`agent.list()` call and nothing else (see `runPermissionAnswerTick`'s own
doc comment).

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
carried into the SpawnSpec" test.

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

- **Rule-launched agents** (jira-work / jira-project / github / filesystem
  rules) do not get a `lizardMode`-equivalent switch here — FACTORY-76 is
  the companion story extending the same mechanism to them, filed
  separately so the two don't diverge on field name/shape. Coordinate with
  that ticket rather than duplicating its work.
- **No live definition was switched over.** Per FACTORY-67's own
  constraint, this ticket is code + tests + docs only — no live runtime,
  service, or definition was touched. The existing codey definitions (all
  `permissionMode: "auto"`, none setting `lizardMode`) load and behave
  unchanged. Deploys and any live cutover go through admin-assembly at the
  operator's direction.
