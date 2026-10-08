# The permission-answer loop / "lizard mode" (DROVR-42, FACTORY-67, FACTORY-87/FACTORY-76)

> **FACTORY-722: a wedged herdr socket no longer leaves the watch dead
> forever.** Two independent fixes: (1) the daemon's shared herdr client now
> carries a client-side call deadline (`Config.herdrCallTimeoutMs`/
> `BUTCHR_HERDR_TIMEOUT_MS`, default 10s), and the one call path that bypasses
> it (`herdr.subscribe()`) gets its own deadline wrapper at the daemon's own
> call site — before this, a hung `agent.list()`/`subscribe()` call left the
> tick's in-flight guard set forever, with no recovery. (2) An independent
> watchdog, on its own timer rather than the tick's, detects a pane whose
> push-triggered `blocked` event has sat unconsumed for over 5 minutes and
> force-restarts the watch — clears the in-flight guard, reopens the
> subscription, kicks a fresh tick — logging `[watchdog] restarted
> permission-answer` and raising an ops alert. See `permission-answer-watch.ts`'s
> own header and `PermissionAnswerWatchDeps.watchdogThresholdMs`'s doc comment.
>
> **FACTORY-751/FACTORY-775: the subscribe deadline wrapper above could not
> abort a herdr that accepted the connection and never acked, so each
> retry (`scheduleReconnect`, default every ~`herdrCallTimeoutMs +
> resubscribeDelayMs`) opened another raw socket nobody ever closed.**
> `@brooswit/herdr-sdk` exposes no way to abort an in-flight `subscribe()`,
> so the daemon-side wrapper (`subscribeAgentStatus`, `src/daemon/index.ts`)
> now tracks the one outstanding raw attempt and will not start a second
> one while the first has neither settled nor been closed — at most one
> socket is ever outstanding past this fix, not zero: a herdr that never
> acks at all still holds that one connection open forever (the SDK gives
> no way to reclaim it), but no additional connections pile up behind it.
> `BUTCHR_HERDR_TIMEOUT_MS` also gained an upper bound (300000ms / 5
> minutes) — see `Config.herdrCallTimeoutMs`'s own doc comment for why a
> larger value made this knob mean its own opposite.

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
> path (CPU sanity, respawn-loop safety). The scan itself, its opt-in gate,
> its cadence, and its audit/journal behavior are unchanged.

> **FACTORY-93 (drovr >= 0.15.1): the loop now calls `autoAnswerPermissions`
> with `scope: "once"` — it presses option 1 "Yes" (allow once), never the
> "always allow" option.** Matching Claude's "always allow" wording was
> fragile: the read-permission dialog says "Yes, allow reading … from this
> project" and was silently skipped, freezing the codey canary. No stored
> allow rules are written any more. Every skipped pane is now logged
> (`[permission-answer] <label> (<pane>) SKIPPED, left for a human: <reason>`),
> once per pane+reason.

## What it is

DROVR-37 shipped `autoAnswerPermissions(client, { auditPath, operator?, readTimeoutMs?, scope? })`
in `@brooswit/drovr` (>= 0.15.0): an unattended pass that scans every Claude
pane for a pending tool-permission dialog ("Do you want to proceed?") and
presses an option on it, only when it is unambiguously the right one —
auditing every attempt. As wired here (FACTORY-93, drovr >= 0.15.1) it always
calls with `scope: "once"`, pressing plain "Yes" (allow once) and never the
"Yes, and always allow … from this project" stored-rule option; no stored
rule is ever written. DROVR-41 proved the mechanism live against a real
herdr pane and recommended wiring it into butchr's own daemon.

That recommendation (DROVR-42) was originally scoped as a blanket sweep over
every Claude pane. Before it merged, FACTORY-67's director narrowed the ask:
the operator wants this as an **explicit, per-agent opt-in** — `lizardMode: true`
on a managed-session definition (`SessionDefinition`, `src/resources/session-definition.ts`)
— named "lizard mode". It is a SEPARATE toggle from `permissionMode`, not
tied to any one value of it: it pairs with any `permissionMode` that still
prompts before a tool call (manual/`"default"` included, but also, e.g.,
`"acceptEdits"`, which auto-accepts file edits but still prompts for Bash and
MCP tool calls), so an agent gets that mode's own safety for every prompt it
still shows while never sitting frozen on the ONE dialog drovr already knows
how to answer unambiguously. FACTORY-138 (operator decision, FACTORY-67
director comment 2026-09-26 22:24Z) made a `vendor: "claude"` definition that
doesn't set the field ELIGIBLE by default, pairing with the new
`permissionMode: "acceptEdits"` launch default; only an explicit
`lizardMode: false` opts a definition back out. This is still not a blanket
sweep over every pane — see "The opt-in gate" below for exactly which panes
are eligible now.

`src/agents/permission-answer-loop.ts` is the daemon-side wiring:
`startPermissionAnswerLoop` wraps `autoAnswerPermissions` on its own
`setInterval`, started in `src/daemon/index.ts` right after
`blockingEscalationTimer`, scoped every tick to exactly the panes an
`eligiblePanes` hook names.

## The opt-in gate

`SessionDefinition.lizardMode?: boolean` is validated at manifest load like
every other definition field. **As of FACTORY-108, `vendor: "codex"` is
accepted, not rejected** — see "Codex support (FACTORY-108)" below for what
an explicit `true` does for that vendor. `strictMcpConfig` keeps its own,
unrelated Codex rejection unchanged. Since FACTORY-138, absent resolves to
ELIGIBLE for a `vendor: "claude"` definition and stays NOT-eligible for
`vendor: "codex"` — the FACTORY-138 default applies to Claude only, and this
is independent of Codex's manifest-load acceptance above (a Codex definition
CAN set the field, it just isn't defaulted on when it doesn't); an explicit
`false` always means never scanned, for either vendor.

For `vendor: "claude"` — unlike `permissionMode`/`strictMcpConfig` (see "No
argv, no stale-argv risk" below) — `lizardMode` never reaches `SpawnSpec` or
the launched process's argv. It is surfaced purely as a **live,
rebuilt-every-poll map** —
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
managed-session definition does). Since FACTORY-138, "never set the field"
resolves ELIGIBLE for a rule (`ruleLizardModeOf`: `rule.lizardMode !== false`,
unconditionally — no vendor gate at this layer, since a `Rule` has no fixed
vendor) and for a `vendor: "claude"` managed session (`lizardMode ?? (vendor
=== "claude")`); only an explicit `lizardMode: false`, a Codex/agy-resolved
launch, a legacy/bare-issue agent, or a managed session not yet observed this
daemon's lifetime is excluded. A tick with nothing eligible still costs
exactly one `agent.list()` call and nothing else (see
`runPermissionAnswerTick`'s own doc comment) — that call-count property is
unchanged by the default flip.
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

For **Claude**, `lizardMode` was deliberately kept OUT of that shape rather
than extended into it: it never becomes a CLI flag (`specForSessionDefinition`,
`src/rules/session-definition-type.ts`, never puts it on the `SpawnSpec` for
`vendor: "claude"` — see that module's own test asserting exactly this), so
there is no argv for a stale-argv check to compare in the first place, and no
persist/read-back pair to keep in sync. This is checked in, not merely
asserted: see `session-definition-type.test.ts`'s "lizardMode is deliberately
NEVER carried into the SpawnSpec" test (now scoped to `vendor: "claude"` —
see "Codex support (FACTORY-108)" below for the Codex exception). `Rule.lizardMode`
(FACTORY-87) keeps the exact same Claude-only shape: no `specFor*` builder
ever puts it on a Claude `SpawnSpec` output either, for the same reason.

### Codex support (FACTORY-108)

**For `vendor: "codex"`, the opposite is true, by necessity.** drovr v0.16.0's
Codex auto-answerer (`autoAnswerCodexApprovals`) is a no-op on a Codex agent
launched with `--dangerously-bypass-approvals-and-sandbox` — there is no
separate on/off switch for Codex the way `classifyPermissionPrompt`'s scan
gate is for Claude; the bypass flag itself is what has to change. So an
EXPLICIT `lizardMode: true` on a `vendor: "codex"` definition, or on a
`Rule.lizardMode` for a rule-launched Codex agent, DOES reach `SpawnSpec.lizardMode`
and the launch argv: `agentLaunchConfig`'s Codex branch (`src/agents/argv.ts`)
drops ONLY `--dangerously-bypass-approvals-and-sandbox` — never adding
`--ask-for-approval`/`--sandbox` flags. Unset or explicit `false` launches
exactly as today. Because this DOES reach argv, it needs — and gets — the
exact FACTORY-43 persist/read-back shape `permissionMode`/`strictMcpConfig`
already have: `buildWorkspace()` persists the raw explicit value to
`.butchr-lizard-mode.json`, and `HerdrHerd.staleIssues()` reads it back
(`workspaceLizardMode`, `src/agents/workspace.ts`/`src/agents/herd.ts`) into
the same `spawnArgs()` builder the real launch uses — without this, a lizard
Codex agent's real (bypass-flag-less) argv would forever mismatch a naively
recomputed "expected" argv that still assumes the bypass flag, respawn-looping
it forever, the exact bug FACTORY-43 closed for the other two fields.

**Explicit only — never a resolved/defaulted value — and why that matters.**
FACTORY-127 (shipped with FACTORY-138) made `lizardMode` default to `true`
where it is resolved for ELIGIBILITY (the `eligiblePanes` gate above) for a
`vendor: "claude"` managed-session definition, and promises that default
flip never reaches argv or respawns anything. Reading the raw field, not the
resolved one, at Codex launch-config time is what keeps a parallel promise
true for Codex: if the launch decision instead keyed off a resolved/defaulted
eligibility value, a default flip (present or future, for either vendor)
could silently drop the bypass flag from every running Codex agent at once,
with no canary. The launch-flag decision lives in one small function in
`src/agents/argv.ts` carrying this reasoning as its own comment.

**Codex's own ELIGIBILITY default stayed `false` — a deliberate, separate
decision (FACTORY-106/FACTORY-324), not an oversight inherited from
FACTORY-127.** FACTORY-127/FACTORY-138's default-eligible flip is scoped to
`vendor: "claude"` only: a `vendor: "codex"` managed-session definition that
never sets `lizardMode` resolves NOT eligible for scanning
(`m.definition.lizardMode ?? (m.definition.vendor === "claude")`,
`src/rules/session-definition-type.ts`) — only an explicit `true` makes it
eligible, and that same explicit `true` is also what the paragraph above
requires for the LAUNCH to drop the bypass flag, so eligible-for-scanning and
capable-of-showing-a-dialog move together for Codex, by construction. Making
Codex default-eligible too (mirroring Claude) would have decoupled them: a
newly-eligible-by-default Codex pane would be scanned every tick for a dialog
its still-bypassed launch can never show — a harmless no-op, but one that
silently claims coverage nobody canaried, which is exactly the failure shape
this whole epic exists to avoid elsewhere. See `docs/managed-sessions.md`'s
"Codex eligibility for SCANNING vs. LAUNCH" table for the full three-case
breakdown, including the deliberate, documented asymmetry on the
`Rule.lizardMode` (non-managed-session) path, which resolves scanning
eligibility as `!== false` (absent IS eligible) regardless of vendor and was
left unchanged — see `Rule.lizardMode`'s own doc comment
(`src/rules/rules.ts`) for why.

**Fixture coupling — "no `-a`/`-s` flags" is deliberate, not an oversight.**
drovr's Codex prompt recognition was captured against codex-cli 0.145.0
launched with only `--cd` — see `docs/codex-permission-approval.md` (shipped
in the drovr release). A different `--ask-for-approval`/`--sandbox` policy
renders prompt shapes nobody has captured fixtures for; drovr reports those
as `unrecognised` (see "Codex outcomes get their own log lines" below),
never answered — the agent freezes on the prompt, the exact failure this
epic exists to remove. Changing the launch policy requires capturing new
drovr fixtures first.

**Recognised prompt surface:** a command-execution prompt (a network-access
escalation renders the identical shape, just a network-flavoured `Reason:`
line — not a distinct kind); a file edit/patch prompt; an MCP tool-call
prompt. Only the plain approve-once option is ever pressed — never "don't ask
again for …", "for this session", or "always allow". The pre-existing
directory-trust dialog is untouched by this module. See
`docs/managed-sessions.md`'s "Codex support (FACTORY-108)" section for the
full wording table and the toggle-on-a-running-agent and host-config
caveats — not repeated here to avoid the two docs drifting apart.

**Codex outcomes get their own log lines, never merged into Claude's.**
`autoAnswerCodexApprovals` returns a differently-shaped result
(`{paneId,label,outcome:"answered",kind,detail}` / `{outcome:"skipped",reason}`
/ `{outcome:"unrecognised",excerpt}` / `{outcome:"failed",reason,detail}`) —
structurally incompatible with `autoAnswerPermissions`'s Claude-shaped
`{tool,request}` fields. `runPermissionAnswerTick` gives the Codex pass its
own counted summary line (`[permission-answer] codex: N answered, M skipped,
K unrecognised, J failed`) and its own per-result log lines, rather than
folding Codex results into the Claude counters — merging them naively would
throw inside the Claude-shaped logging (`a.tool`/`a.request` undefined on a
Codex result) and miscount `unrecognised` as `skipped`. `unrecognised` is
always logged, never silently dropped, deduped per pane **and excerpt**
(not just per pane) — a persistently unrecognised pane logs once, but a
newly-appeared, different unrecognised dialog on that same pane is a new
thing a human hasn't seen and logs again.

**The two passes run concurrently, not sequentially.** Both the Claude and
Codex passes are independently bounded by the same `readTimeoutMs` (8s, see
"Cadence: 20s, and why" below); run sequentially, they could together
approach 16s, eating most of the margin that budget exists to preserve.
`runPermissionAnswerTick` runs them via `Promise.all` instead, keeping one
tick's total bound at ~8s — safe because the two passes touch disjoint panes
internally (each vendor's own classifier never matches the other vendor's
screen) and share nothing to race over except `deps.auditPath`, which both
drovr functions already append to safely under concurrent callers.

**Wired on both loop paths.** Both `startPermissionAnswerLoop`'s 20s sweep
and `permission-answer-watch.ts`'s event-driven fast path call the same
`runPermissionAnswerTick`, so Codex answering is automatically wired onto
both — there is no separate Codex-only entry point to keep in sync. The
event path's own caveat below still applies to Codex exactly as it does to
Claude: whether herdr reports a Codex pane as `"blocked"` while it's showing
an approval dialog was not verified for this ticket (unlike Claude, where
FACTORY-98 established it live) — until it is, treat Codex as answered by
the 20s sweep, not the ~1s event path, even though the code path is shared.

**`trigger`/`latencyMs` (FACTORY-145) are Claude-only — a Codex answer gets
neither field.** `runPermissionAnswerTick` only consumes `fastPathTriggers`
and computes an elapsed-ms latency for panes in the Claude-shaped `results`
array; the Codex loop (`codexAnswered`/`codexFailed`/`codexUnrecognised`)
never reads `fastPathTriggers` and never appends the trailing
`.permission-audit.jsonl` latency record described above, so a Codex pane's
own `[permission-answer] … answered (codex): …` journal line carries no
`, fast, …ms`/`, sweep` suffix and its audit trail is exactly whatever
`autoAnswerCodexApprovals` itself writes (`vendor: "codex"`, no `trigger` or
`latencyMs` key). Deliberate, not an oversight: FACTORY-145 measured Claude's
own `pane.agent_status_changed` push path (FACTORY-98) specifically; whether
herdr's push frame is even a reliable "blocked" signal for a Codex pane is
the open question the paragraph above already flags as unverified, so wiring
a latency computation on top of an unverified trigger would produce a number
that looks precise and is not. A p50/p95 computed from the audit file (see
"Computing p50/p95 from the audit file" below) is therefore Claude-only by
construction — every row it can select has `vendor` absent (Claude) never
`"codex"`.

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
| **permission-answer loop / lizard mode** (this ticket) | 20s scan, plus an event-driven fast path (~1s) since FACTORY-98 — see "Event-driven: the fast path" below | only lizard-eligible panes (`lizardMode: true`, or absent and defaulting eligible since FACTORY-138 — see "The opt-in gate" above) | the tool-permission dialog only, pressing plain "Yes" (allow once), via `autoAnswerPermissions` |

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
carries `operator` and, once a prompt's option was resolved, the exact
`option` text that was pressed — always "Yes" (allow once) as this daemon
calls it (`scope: "once"`), never a stored-rule option. This daemon's wiring
passes `operator: "butchr-daemon"` (drovr's own default is `"drovr-auto"`) so a
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
for the exact option text)`, plus a per-tick summary line
(`N answered, M skipped, K failed`) whenever a tick answers or fails
anything (an all-skipped or empty tick logs nothing, to keep the console
quiet in normal operation). The exact option text pressed — always "Yes"
today — is not returned by `autoAnswerPermissions` itself — recovering it
without re-parsing the pane's screen a second time (which this module
deliberately never does; dialog recognition is drovr's job, not butchr's,
per FACTORY-49/FACTORY-67) means pointing at the audit log's own `option`
field for that literal text, which the journal line does.

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

- **No live definition or rule was switched over (history — at FACTORY-87/FACTORY-76 time).**
  Per FACTORY-67's own constraint, that ticket (and its rule-side companion,
  FACTORY-87/FACTORY-76) was code + tests + docs only — no live runtime,
  service, definition, or rule was touched, and at the time neither an unset
  `permissionMode` nor an unset `lizardMode` changed a definition's or rule's
  behavior. **Superseded by FACTORY-127/FACTORY-138**, which shipped the
  `acceptEdits` + lizard-eligible-by-default launch pairing described
  throughout this doc: an existing `vendor: "claude"` definition or rule that
  sets neither field now gets both defaults live, no re-save needed (see "The
  opt-in gate" above). FACTORY-129 later removed `jira-project`'s own
  unconditional `permissionMode: "auto"` override, so a `jira-project` rule
  that sets nothing now gets the same `acceptEdits` + lizard-eligible
  default as every other rule kind. Deploys and any live cutover go through
  admin-assembly at the operator's direction.

## Approval sound (FACTORY-100/FACTORY-103)

An OPT-IN, OFF-by-default sound played on **this daemon's own host** every
time this loop's `runPermissionAnswerTick` reports a pane `answered` — the
operator's own request: a human in earshot of the host should hear each
unattended approval as it happens, not just find it later in
`permissionAuditPath`'s JSONL trail. Implemented in
`src/agents/approval-sound.ts`, wired into the `onApproved` dep shared by
`startPermissionAnswerLoop` and `startPermissionAnswerWatch`
(`src/daemon/index.ts`), called once per answered pane regardless of which
of the two wires it up — `onApproved` lives on `PermissionAnswerLoopDeps`,
and `startPermissionAnswerWatch` forwards its own deps straight through to
`runPermissionAnswerTick` (see `permission-answer-watch.ts`), so this hook
does not care which sits on top.

**Why the hook sits here, not in drovr.** The "approval" audit record itself
(`outcome: "approved"`) is written by `@brooswit/drovr`'s
`approvePermission` — a separate published npm package, not this repo.
`runPermissionAnswerTick`'s own `answered` filter is the EARLIEST point in
BUTCHR'S OWN code that knows a prompt was just approved, and it already
flows through this exact function on every tick, whether the tick was fired
by the sweep timer or the event-driven watch — tailing drovr's audit file as
an event source would be strictly later, more expensive (a file watch or
poll on top of the poll this loop already is), and has no precedent anywhere
in this codebase. (An operator FACTORY-100 comment briefly asked whether the
sound asset and its playback should both move into drovr; the ruling that
followed keeps the hook here — only the SOUND ASSET itself moved into drovr,
see "Default sound source" below.)

**Config:** `Config.lizardApprovalSound?: { overridePath?: string }` — TWO
SEPARATE env vars (`src/config/config.ts`): `BUTCHR_LIZARD_APPROVAL_SOUND`
(any non-empty value enables the feature; absent/empty means disabled,
today's behaviour exactly) and `BUTCHR_LIZARD_APPROVAL_SOUND_PATH` (optional,
`~` expanded) as a local-file-path override. A path with the enable flag
unset does NOT enable the feature — the flag is the master switch. Daemon/host
level, not per-managed-session: the sound plays on the HOST's own speakers
regardless of which agent's pane triggered it, so one knob is the natural
fit — a per-definition setting would imply a per-agent sound the host cannot
actually produce independently.

**Default sound source: drovr's own bundled asset.** With the flag on and no
override path, the source is `@brooswit/drovr`'s own bundled
`assets/sounds/lizard-button.mp3` (FACTORY-122 ships it there) — resolved at
runtime (`resolveDrovrBundledAsset`) by asking `import.meta.resolve` for the
package's main entry (the only subpath its `exports` field exposes), then
walking up the filesystem to the ancestor directory whose OWN `package.json`
declares `name: "@brooswit/drovr"` (that package's `exports` does NOT expose
`./package.json` or an arbitrary asset subpath as importable specifiers, so
this walks the filesystem after resolving only the "." export rather than
trying to `import()` either directly). The package or asset failing to
resolve (missing, or a pin without the asset) logs ONE warning and disables
the sound for the daemon's remaining lifetime, same as any other unresolvable
source — see `test/unit/approval-sound.test.ts`'s REAL-PACKAGE GUARD test for
why this is deliberately re-checked against the actually-installed package
rather than only against fakes. **URL sources are out of scope** (cut after
the operator's suggested `https://www.myinstants.com/...` value turned out to
403 non-browser clients on this fleet's hosts, and a later redirect asked for
the asset to live inside drovr rather than as a URL or a Butchr-side
download) — this module does not build, keep, or document any download/cache
path.

**Player selection** (`chooseSoundPlayer`/`candidateSoundPlayers`): tries, in
this fixed order, whichever of `gst-play-1.0`, `afplay`, `mpv`, `ffplay`
(`-nodisp -autoexit -loglevel quiet`), `paplay`, `pw-play`, `aplay` is found
on `PATH` (`Bun.which`, same detection primitive `detectTerminalPrefix`
already uses for terminal emulators, `src/terminal/open.ts`). `aplay` (ALSA)
cannot decode mp3, so it is restricted to `.wav` sources; every other player
is tried against any format. `gst-play-1.0` is tried FIRST specifically
because a live measurement on codey found `paplay`/`pw-play` both fail on mp3
there (its libsndfile build has no mp3 support) while `gst-play-1.0` plays it
fine — a candidate that exits non-zero or errors is treated as "try the next
one", not success, walking the full fallback chain rather than giving up
after the first installed candidate. The first candidate that actually
succeeds is REMEMBERED and tried directly (skipping the PATH-lookup probe
entirely) on every later approval; if it ever stops working, it is forgotten
and the full fallback chain is re-probed from scratch. No usable player at
all logs ONE warning and disables the sound for the daemon's remaining
lifetime — it is never re-checked.

**Coalescing:** `DEFAULT_COALESCE_MS` (1500ms, `createApprovalSoundNotifier`'s
`coalesceMs` option) — a burst of approvals inside that window plays at most
one sound (a leading-edge throttle: the first approval in a quiet period
plays immediately; every approval before the window elapses is coalesced
away; the next approval after the window plays again).

**Journal evidence.** Every ACTUAL play logs one concise line naming the
player, the file, and the exit status (e.g. `played <path> via "gst-play-1.0"
(exit 0)`) — deliberately not a once-ever message like the failure warnings
below, so admin-assembly can confirm from the journal alone that a real
approval played the sound, every time.

**Never touches the approval path.** `notifyApproved` is synchronous, never
awaited by its caller, and wraps everything in `try`/`catch` — a throwing
`onApproved` (or a throwing `now`/`has`/`spawn` dependency) cannot propagate
into `runPermissionAnswerTick`, which ALSO wraps its own call to
`deps.onApproved?.()` defensively (belt-and-suspenders). A player that fails
to spawn (ENOENT), reports an async `"error"` event, or exits non-zero (the
headless-host, no-audio-device case) each log at most one warning and are
otherwise silent — this is a **deliberately different** failure mode from
"no player found"/"source unresolvable" above: a playback-runtime failure
does not disable the feature forever, since the underlying condition (no
audio sink attached to a headless host) can never be distinguished here from
a merely transient one, and the ticket's own requirement is "degrade silently
after one warning", not "give up permanently".
