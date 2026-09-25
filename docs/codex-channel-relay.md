# Codex channel relay: the BUTCHR-413 stopgap wake path

BUTCHR-413 (task of story BUTCHR-395, epic BUTCHR-391). Rocket.Chat (RC)
channel and DM delivery must reach Codex agents as well as Claude, without
building a parallel wake path and without blocking on BUTCHR-359 (the
Codex-delivery epic, unstaffed To Do at the time of this ticket — see epic
decision on BUTCHR-391, 2026-09-24). This is that stopgap: one narrow seam,
`src/notify/codex-channel-relay.ts`, everything it should be replaced by
named explicitly below.

## The gap this closes

BUTCHR-411 lets a rule bind its agent(s) to any additional MCP server
(`Rule.mcpServers`), flagged `channel: true` for push notifications —
concretely, Rocket.Chat's `rocketr` for this story. **For Claude, that
binding alone is delivery: no code in this repo is involved.** Claude's own
CLI, launched with `--dangerously-load-development-channels=server:rocketr`
(BUTCHR-411's argv wiring), opens the notification stream to `rocketr`
itself and renders a push as a `<channel>` frame natively — the same
mechanism `server:butchr` has always used, just against a second server.

**Verification of that claim, stated precisely:** this ticket did not run a
fresh live test of it — `rocketr` does not exist in this repo or anywhere
this ticket had access to (no live Rocket.Chat, per this ticket's own scope).
What this ticket DID verify: reading BUTCHR-411's own merged argv/mcp.json
wiring (`src/agents/argv.ts`, `src/agents/workspace.ts`) confirms a bound
`channel: true` server is treated identically to `server:butchr` at launch
— there is no Claude-specific code path this ticket would need to add
alongside it. BUTCHR-411's own PR additionally ran a staged transport-level
probe (`scripts/verify-channel-delivery.ts`) confirming repeated pushes to a
second, non-butchr server are delivered at the transport layer, and recorded
that it could NOT reproduce herdr's own PTY-pane residency from outside the
daemon to confirm a live wake end-to-end (see that PR's own description and
`docs/mcp-server-bindings.md`). This ticket adds nothing to that evidence;
it is cited, not re-claimed.

Codex has no development-channel concept, and even its ordinary MCP tool
connection to a bound server never opens a notification stream — confirmed
by reading `notifyAgent`/`notifyIssue`'s own `!["codex","agy"].includes(...)`
filter in `src/daemon/app.ts`, which treats a Codex connection as one that
will never read a push (the daemon's OWN server already assumes this). So a
Codex agent bound to a channel server would receive **nothing** for it: not
even the Jira-tracked rule loop's `herd.nudge` fallback, because nothing
anywhere is watching this second, non-butchr server on Codex's behalf.

## Design decision 1: reuse Drovr's inbox transport, not its queue

`@brooswit/drovr` ships `inbox-relay.ts` for exactly this shape: "a relay
holds the notification stream in the agent's place and delivers each
message as a turn through the host's own API" for "an agent whose vendor
cannot render a channel frame (agy, codex)". This ticket reuses:

- `keepChannelSource` — the reconnecting MCP-client connection to a channel
  server, with capped exponential backoff. This is what the daemon itself
  now holds open, per (Codex issue, channel binding) pair, in place of the
  Codex CLI's own (absent) notification stream.
- `renderInboxTurn` — the same `<channel>` frame rendering, with the same
  injection neutralisation (`</channel>` in a message body cannot end the
  frame early), so a Codex agent's rendered turn text is the equivalent of
  what Claude's own CLI would have shown it.

It does **not** reuse `InboxRelay` itself, the queue/retry wrapper around
those. Pinned `@brooswit/drovr` 0.11.1's `InboxRelay.push()` has a
reproducible race:

```
this.draining ??= this.drain().finally(() => { this.draining = undefined; });
```

`drain()`'s own async body returns (its `while` loop exits because the queue
is empty) one full microtask BEFORE the `.finally()` callback actually clears
`this.draining` — that clearing is a callback chained onto the settled
promise, not part of the function's own synchronous continuation. A `push()`
landing in that gap sees `draining` still truthy, skips starting a new drain,
and the newly queued message sits in `queue` forever with nothing left
running to ever drain it. Reproduced deterministically in this ticket's own
work by pushing two messages back-to-back with no delay (see
`test/unit/codex-channel-relay.test.ts`'s "messages are delivered one at a
time" and "distinct messages" tests, and the module's own top comment).
Filed upstream rather than patched here, since Drovr owns that module (see
this ticket's Jira comments for the exact filing).

`src/notify/codex-channel-relay.ts`'s own `sequentialDeliver` is a ~30-line
corrected replacement for just the queue/drain loop (same retry/backoff/
`maxAttempts` shape `InboxRelay` documents), with the fix being a `finally`
**inside** the async function body rather than a `.finally()` chained onto
its returned promise — closing exactly the gap above.

**Ownership-boundary justification (BUTCHR-359's own boundary, BUTCHR-391):**
Drovr owns reusable, provider-neutral agent transport; Butchr owns
notification policy and orchestration — deciding which event warrants a
wake, rendering, suppression/deduplication. Reusing `keepChannelSource`/
`renderInboxTurn` but owning the queue/dedup/retry policy in this repo (even
though `InboxRelay` would have been the more direct reuse, absent the bug)
keeps this split intact rather than blurring it: connection transport stays
Drovr's; the policy this file was always going to own regardless is now
fully in Butchr's own code, not silently delegated to a dependency with an
open defect.

## Design decision 2: how a Codex agent is woken, what it receives, how it answers

**Woken by:** the daemon's own `keepChannelSource` connection receiving a
push — this is push-based and event-driven end to end; nothing anywhere in
this path polls the channel server or the agent's pane. The push is turned
into exactly one `herd.nudge(issue, text)` call — the same proven,
event-driven PTY-prompt transport every provider already falls back to for
Jira-tracked updates (`src/daemon/index.ts`'s existing `notify` closures).
`herd.nudge` already starts a turn on an idle agent and queues (without
double-prompting) on a busy one — this module adds no separate busy/idle
logic of its own; it just calls `nudge` once per distinct message and trusts
that existing contract.

**What it receives:** the same `renderInboxTurn` frame Claude's own CLI
renders for a channel push — an explicit "this is external data, not your
operator" notice, then a `<channel source="...">...</channel>` block holding
the message content, with any `</channel>`/`<channel` in the body itself
neutralised so a hostile message body cannot forge a frame boundary.

**How it answers back — CORRECTED, a real gap, not "no new code":** the
first version of this doc claimed a Codex agent replies through the bound
server's own MCP tools "exactly as a Claude agent would". That does not
survive contact with BUTCHR-411's own merged review fix (b669346): a Codex
launch's bound-server config is rendered into process argv by Drovr, so
BUTCHR-411 deliberately strips EVERY bound-server header value from a Codex
launch, for every binding, to keep a credential out of argv/logs/`ps`
(`boundCodexServers`, src/agents/argv.ts; `docs/mcp-server-bindings.md`
states plainly a Codex agent gets a bound server's tools "with no extra
headers"). Rocket.Chat's `rocketr` is an authenticated server — BUTCHR-395's
own consumers (admin-brooswit-nexus, the 3 Candlestix directors) are
permanent RC accounts — so a Codex agent's own tool calls to `rocketr` have
no way to authenticate and cannot actually succeed. **A Codex agent cannot
yet reply through an authenticated bound server's own tools.** This is
separate from this ticket's own inbound relay (which makes its OWN
daemon-side connection, with its own per-agent identity — see decision 3
below — and never touches the Codex agent's own launch config at all).
Filed as **BUTCHR-418** → BUTCHR-391 via `file_where_it_belongs`, since
fixing it means changing how a Codex agent's OWN launch authenticates to a
bound server (BUTCHR-411's own domain), not this ticket's inbound-only
relay. Until BUTCHR-418 lands: inbound delivery to a Codex agent works
(this ticket); a Codex agent replying through `rocketr`'s own tools does
not. A Codex agent can still reply through `server:butchr`'s own tools
(e.g. a Jira comment) exactly as before — only a bound, authenticated,
non-butchr server's tools are affected.

## Design decision 3: DM vs channel, and duplicate avoidance

This module is deliberately agnostic to "DM vs channel" as a Rocket.Chat
concept: it operates purely on `Rule.mcpServers` bindings (BUTCHR-411's
generic MCP-channel-server abstraction, not an RC-specific one) and the
generic `InboxMessage` shape (`source`, `content`, `meta`) any thatch-style
channel server emits. A DM route and a channel route are just two different
bindings (two different `name`s) as far as this module is concerned; RC/
`rocketr`'s own routing (a DM to an agent's own RC user vs a broadcast to
the shared `rocketr` channel the consumers list — admin-brooswit-nexus and
the 3 Candlestix directors) is that server's concern, not this one's.

**Per-agent identity — CORRECTED (review finding 2):** the first version of
this module opened every (issue, binding) connection with
`resolveMcpServerHeaders(binding)` — ONE static credential shared by every
agent a rule binds. A channel server can only route a DM to "this agent's
own RC user" by the identity presented ON THE CONNECTION; with a shared
credential, every Codex agent bound by the same rule would look identical
to the server, so a DM meant for one would reach all of them (or none).
Fixed: `startCodexChannelRelay` now reads THIS agent's own Rocket.Chat
connection material first (BUTCHR-412's `RC_ACCOUNT_FILE`, written to the
agent's own workspace directory — `readRcAccountIdentity`) and connects
with that agent's own `x-user-id`/`x-auth-token` headers (matching RC's own
header-name convention, `src/resources/rocketchat.ts`'s client). The
rule-level shared credential (`resolveMcpServerHeaders`) is used only when
this agent has no personal RC identity at all — an `account: "none"` rule
(e.g. Candlestix's MUD players), for whom a shared credential is correct
and the only option, since there is no personal identity to route by.
Tested (`test/unit/codex-channel-relay.test.ts`): two Codex agents bound to
the identical binding, each with its own identity, and a message addressed
by identity (mirroring `src/daemon/app.ts`'s own `notifyAgent`
`sendAll(..., { where: ... })` targeting pattern) reaches only the intended
one. Unverified beyond that: the assumption that a real `rocketr` uses
RC's own `x-user-id`/`x-auth-token` header names and routes a DM by
connection identity at all — `rocketr` does not exist yet to confirm
against.

**Duplicate avoidance:** every delivered message is keyed by
`` `${source} ${meta.id ?? meta.messageId ?? content}` `` (see
`dedupKeyOf`) and remembered for `dedupWindowMs` (default 5 minutes). This
covers the case named by this ticket explicitly — an agent bound to more
than one delivery route (e.g. a channel binding and a separate DM binding)
receiving the identical underlying RC message twice, once per route/
connection — as long as the channel server forwards a stable message id in
`meta`. Without an id, only an exact-repeat (same source, same content) is
caught; an edited-and-resent message with no id is treated as new. This is a
real, named limitation, not closed by this module: a real `rocketr` is
expected to forward RC's own message id, but this repo has no live RC
instance to confirm that against (this ticket's own scope explicitly
excludes live RC access — fakes and local staging only).

## Reconcile robustness (review finding 3)

`createCodexChannelRelayPool.reconcile()` originally tore a relay down
whenever `providerOf(issue)` returned anything other than exactly
`"codex"` — including `null`, which `Herd.providerOf` returns for "can't be
determined right now" (a herdr hiccup, a starting shell, a pane blocked on
a dialog), NOT "confirmed not codex". Tearing a live relay down on a
transient `null` closes its connection and discards its queue/dedup state;
rebuilding it a poll later means anything the channel server pushed in the
gap is lost. Fixed: `null` now only ever PRESERVES an already-running relay
(never starts a new one on `null` — this daemon isn't sure yet it's even
Codex — and never tears one down on it either). Only a running issue's
OBSERVED non-codex provider, or the issue no longer running at all, tears a
relay down. Tested: an existing relay survives repeated `null` polls and
still delivers the next push.

## What BUTCHR-359 should replace, exactly

The entire `src/notify/codex-channel-relay.ts` file (including
`readRcAccountIdentity`/`RcAccountIdentity`, the per-agent identity helper
added for review finding 2), plus its one wiring block in
`src/daemon/index.ts` (the `createCodexChannelRelayPool` construction, its
`providerOf`/`bindingsOf`/`nudge` deps, and the
`codexChannelRelayTick`/`setInterval` poll). Nothing else in this repo reads
from or calls into this module. Once BUTCHR-359 lands a real,
production-correct Codex wake path (with proper reconcile-on-restart,
observed-delivery proof, and whatever else that epic's own investigation
finds), it subsumes this module's entire job — "make a channel-bound Codex
agent receive channel pushes at all" — with no other caller in this repo
needing to change. `Herd.providerOf` (added by this ticket to `src/agents/herd.ts`)
is a smaller, general-purpose addition (the live, pane-observed provider of
a running agent) that is not itself part of this stopgap and has no reason
to be removed alongside it.

## What this ticket did NOT verify

- **A real Rocket.Chat end-to-end proof** — explicitly out of scope for this
  ticket (see its own Definition of Done: the staged real-RC gate is a
  separate task, executed later in Codey staging by
  manager-factory-butchr). This repo's tests use a real thatch/MCP server on
  loopback standing in for `rocketr` (`test/unit/codex-channel-relay.test.ts`'s
  `fakeChannelServer`) — a faithful stand-in for the wire protocol, not a
  claim about `rocketr`'s own message shape (ids, DM-vs-channel framing),
  which does not exist yet.
- **A real Codex PTY-pane wake**, for the same reason BUTCHR-411 could not
  verify it for Claude: no way to reproduce herdr's own pane residency from
  outside the live daemon without touching it (forbidden here, BUTCHR-368).
  What IS verified: `herd.nudge` is called with the rendered turn text the
  moment a push arrives (event-driven, no polling), and `herd.nudge` itself
  is the identical, already-relied-upon transport the rest of this daemon
  uses to wake a resident agent.
- **A Codex agent replying through `rocketr`'s own tools** — see "How it
  answers back" above: not possible today (BUTCHR-411 strips headers from
  every Codex bound-server connection), filed as BUTCHR-418. Do not read
  this ticket as having closed the reply half of "Brooswit must be able to
  talk to the agent while it runs" for Codex specifically — inbound only.
- **A real per-agent RC identity's header names/DM-routing behaviour** — see
  "Per-agent identity" above: assumed to match `src/resources/rocketchat.ts`'s
  own convention, unconfirmed against a real `rocketr`.
