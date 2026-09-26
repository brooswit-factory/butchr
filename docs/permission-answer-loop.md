# The permission-answer loop (DROVR-42)

## What it is

DROVR-37 shipped `autoAnswerPermissions(client, { auditPath, operator?, readTimeoutMs? })`
in `@brooswit/drovr` (>= 0.15.0): an unattended pass that scans every Claude
pane for a pending tool-permission dialog ("Do you want to proceed?") and
presses the "Yes, and always allow … from this project" stored-rule option
only when it is unambiguously that option — auditing every attempt. DROVR-41
proved it live against a real herdr pane and recommended wiring it into
butchr's own daemon (butchr already owns the trust relationship and live
socket to the panes it hosts, and the frozen-agent incident this whole
DROVR-37 epic exists to fix — agents frozen for hours on a permission dialog
with herdr reporting them idle/done — was observed on butchr's own fleet).

This ticket (DROVR-42) is that wiring: `src/agents/permission-answer-loop.ts`
wraps `autoAnswerPermissions` on its own `setInterval`, started in
`src/daemon/index.ts` right after `blockingEscalationTimer`.

## Why its own timer

Three independent pane-scanning timers now run in `src/daemon/index.ts`:

| Timer | Interval | Reads | Presses keys for |
| --- | --- | --- | --- |
| `watchPrompts` (`src/agents/prompt-watch.ts`) | 5s | every pane | startup dialogs, via `chooseStartupAnswer` (trust, Bypass-Permissions first-run, fullscreen-renderer, settings warning/recommendation, resume-from-summary) |
| `blockingEscalationTimer` (drovr's `createBlockingEscalationWatcher`) | 5s | every pane | nothing — detects and escalates unknown dialogs only, `sendKeys` is a permanent no-op (see `docs/managed-sessions.md`'s "Two detectors, one mark") |
| **permission-answer loop** (this ticket) | 20s | every pane | the tool-permission "always allow" dialog only, via `autoAnswerPermissions` |

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
rhythm to reason about. Re-derive this if the fleet's real pane count or
load profile changes meaningfully; it was not load-tested against this
daemon's own production pane count.

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
carries `operator`. This daemon's wiring passes `operator: "butchr-daemon"`
(drovr's own default is `"drovr-auto"`) so a shared audit file, or a human
comparing hosts, can tell butchr's own unattended pass apart from any other
caller.

## Seeing recent auto-answers

Today: `tail -f <permissionAuditPath>` (or `grep` it), same as any other JSONL
audit log this daemon writes. The daemon also logs a one-line
`[permission-answer] N answered, M skipped, K failed` summary per tick that
answered or failed anything (never logged for an all-skipped or empty tick,
to keep the console quiet under normal operation), plus one line per failed
pane naming the reason.

**Not wired into `/health` or the dashboard.** Judged not warranted for this
ticket: the audit log is append-only ground truth for anyone who needs to
verify what was pressed and when, and the daemon console line already gives
an operator watching the journal a live signal. If recent auto-answer
activity turns out to be something an operator wants at a glance (the way
`/health`'s `resourceLoops` surfaces other loop health), that is a natural,
separable follow-up — not required to satisfy DROVR-37's own goal of
un-freezing agents blocked on a permission dialog.
