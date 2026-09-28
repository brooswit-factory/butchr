# The credential-death alert (FACTORY-363/FACTORY-397)

## The condition

Claude Code's own OAuth session can expire mid-fleet. When it does, EVERY
Claude pane on that daemon dies at once, because they all share one
credential. Twice on 2026-09-26/27 this happened and nothing escalated: 13
panes sat dead for 13-22 hours, found only by a human looking by hand
(FACTORY-357's diagnosis).

Every escalation butchr had before this story was structurally unable to
see or report this condition:

- The sustained-unresponsive alarm (`[butchr:unresponsive]`,
  `src/agents/escalation-loop.ts`) only ever fires for panes `blockedNow`
  reports (`agent_status === "blocked"`) — a login-expired pane renders
  `✻ Churned for 0s · done` and reports done/idle, never blocked.
- Even a pane that flickers into `blocked` needs strictly consecutive poll
  observations before the alarm accumulates enough `unresponsiveMinutes` to
  fire — a flickering pane never gets there.
- The only existing consumer of a drovr escalation watcher
  (`createManagedSessionEscalationWatcher`'s `onDrovrUnknownDialog`) is a
  no-op for a KEYED pane (`managedSessionOf` resolves to `null`) or a
  keyless pane that isn't a managed session. Both real incidents
  (FACTORY-314/w1T, FACTORY-324/w1V) were on keyed panes.

drovr's `createLoginExpiredWatcher` (`@brooswit/drovr` >= 0.16.3,
`src/login-expired-escalation.ts`) closes the detection gap: it reads a
pane's own Claude transcript (never the screen — the authentic error string
was measured sitting byte-identical in a healthy pane's scrollback for 41+
minutes after the condition cleared) and fires `onLoginExpired`/
`onLoginExpiredResolved` for every Claude pane regardless of `agent_status`
or keyed/managed identity. This document covers butchr's CONSUMING half:
`src/agents/login-expired-alert.ts`, wired in `src/daemon/index.ts` on its
own independent 5-second poll loop.

## Why this alert cannot be agent-mediated

Every recovery lever butchr already has — `[butchr:stall]`,
`[butchr:unresponsive]`, `tell_worker`, an `@`-mention of any agent account
— is agent-mediated: "waking" an agent means spawning or resuming a Claude
session, and a fresh session cannot make a single API call either while the
credential that condition just killed is dead. The lever and the breakage
share one point of failure. A Jira comment, an `ANSWER` affordance, or a
fallback to a DIFFERENT agent account on the SAME host are all the same
trap wearing different masks — none of them work when the one thing that is
actually broken is the host's ability to talk to Claude at all.

So this alert's delivery is deliberately NOT any of those. It is:

1. **A distinct journal line**, `[butchr:credential-dead]` — plain
   `console.log` output, captured by systemd/journald exactly like every
   other daemon log line. `journalctl --user -u <unit>` (or the system-level
   form, per your own `ENVIRONMENT.md`) shows it with no Claude session, no
   API call, and no agent involved anywhere in the path — a human can read
   it directly. It is greppable and distinguishable at a glance both from
   `[butchr:unresponsive]` (a different alarm, for a different condition)
   and from the routine `[prompts] <pane> blocked with no parseable dialog:
   ...` debug line, which fires constantly for healthy panes and was the
   ONLY place the words "Login expired" appeared during the entire first
   13-hour incident.
2. **A `/health` sibling field**, `credentialDeathAlert`
   (`src/daemon/health.ts`) — the daemon's own HTTP endpoint, served by its
   own listener process. A human (or an uptime monitor) can `curl
   http://127.0.0.1:<port>/health` and see the alert with no agent or
   Claude API call in the path either. Absent entirely when no episode is
   open, the same convention `managedSessionEscalations` already uses.

Both delivery paths are pure daemon-process behavior: no LLM call, no agent
spawn, nothing that depends on the very credential this condition kills.
**This alert never carries an `ANSWER`-prefixed line or anything shaped
like a fingerprint a directive parser could mistake for one** — drovr's own
`episodeId` is explicitly not answerable (there is no fix for an expired
OAuth token except a human doing a real, interactive browser `/login`), and
wiring or documenting it as such would be actively misleading.

## Why it is host-wide, not per-pane or per-ticket

One expired credential kills every pane on a daemon at once. Escalating
per-pane (13 identical alerts on 13 unrelated tickets) buries the actual
message — "this daemon's credential is dead, a human must run `/login`" —
under noise, and per-ticket comments are agent-mediated Jira comments
besides (see above).

`src/agents/login-expired-alert.ts`'s `createCredentialDeathTracker`
collapses every `onLoginExpired` into ONE open episode: the first call
while none is open fires the alert immediately (no debounce — the alarm
must fire on the very first poll that carries the condition, since a stall
sweep already existed and still took 13 hours, twice); every subsequent
call while the episode stays open just updates bookkeeping (which panes are
currently contributing, and the latest quoted `detail`) without firing a
second alert. This tolerates the churn drovr's own docs describe: a dead
credential being retried produces roughly one escalate/resolve
(`"superseded"`) pair per retry on a still-dead pane, and the reconciler can
tear down and replace a pane mid-episode (a pane id genuinely changing
under the alert, e.g. `w6Z:p1` -> `w74:p1`, while nothing has been fixed).
The host-wide episode's identity is never tied to any single pane's
lifetime — only to whether ANY pane currently has an unresolved episode.

## Why only `reason: "recovered"` clears it

`onLoginExpiredResolved`'s `reason` is `"recovered" | "pane-gone" |
"superseded"`, and treating any of the three as "the outage is over" is
wrong for two of them:

- **`"pane-gone"`** means the pane vanished from `agent.list()` — closed,
  respawned, torn down by the reconciler. It says NOTHING about whether the
  credential recovered; panes churn constantly during exactly this
  condition.
- **`"superseded"`** means a NEW failure record replaced the episode on the
  SAME still-live pane before it ever saw a completion — the ORDINARY shape
  of a dead credential being retried. The credential did NOT recover; a new
  `onLoginExpired` for the replacement episode follows immediately.
- **`"recovered"`** is the ONLY reason backed by a later genuine (non-error)
  transcript turn — real evidence the credential itself works again.

If the host-wide alert cleared on any resolved event regardless of reason,
ordinary pane churn or a single retry would switch the alarm off while the
daemon is still completely dead — and a human would see it disappear and
reasonably conclude someone fixed it. That is actively worse than the
original 13-hour silence, because a switched-off alarm tells a human the
outage is over while it is still running, instead of just staying quiet.
So `createCredentialDeathTracker` clears the alert only once EVERY pane
currently tracked inside the open episode has individually resolved with
`reason: "recovered"` — see that module's own tests for the churn
(`"pane-gone"`) and retry (`"superseded"`) cases that must NOT clear it, and
the case that must. The clearing journal line always names the reason that
closed it (`reason: recovered`), because a cleared-alert log line that
omits WHY reproduces the exact ambiguity this whole story exists to remove
— a human grepping that line later needs to know whether the credential
came back or a pane merely closed.

## What this alert does not cover

- It does not attempt any automated re-login. `startClaudeLogin` needs a
  human in a real browser by design; this alert only tells a human that is
  needed and names the daemon.
- It describes the condition generically ("credential death") and quotes
  drovr's own `detail` verbatim rather than asserting a specific message —
  the installed Claude Code binary is known to emit at least five distinct
  credential-death strings, and drovr's watcher does not distinguish which
  one occurred.
- It covers exactly what drovr's `createLoginExpiredWatcher` reports — no
  more. There is an open, drovr-side question about revoked-token tagging
  (FACTORY-393, out of scope here).
- It does not touch, broaden, or debounce `blockedNow`/`onNoPrompt`'s
  existing consecutive-poll rule, and does not route through
  `createManagedSessionEscalationWatcher` — both are separate, deliberate,
  and unchanged by this story.
