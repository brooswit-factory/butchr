# Codex channel relay: the BUTCHR-413 stopgap wake path

BUTCHR-413 (task of story BUTCHR-395, epic BUTCHR-391). Pushes from a
`channel: true` MCP server binding must reach Codex agents as well as
Claude, without building a parallel wake path and without blocking on
BUTCHR-359 (the Codex-delivery epic, unstaffed To Do at the time of this
ticket — see epic decision on BUTCHR-391, 2026-09-24). This is that
stopgap: one narrow seam, `src/notify/codex-channel-relay.ts`, everything it
should be replaced by named explicitly below.

The story this was built for used it for Rocket.Chat. Rocket.Chat support
(per-agent accounts and the account-name header) has since been removed;
the relay itself is generic and unchanged for any channel binding.

## The gap this closes

BUTCHR-411 lets a rule bind its agent(s) to any additional MCP server
(`Rule.mcpServers`), flagged `channel: true` for push notifications. **For
Claude, that binding alone is delivery: no code in this repo is involved.**
Claude's own CLI, launched with
`--dangerously-load-development-channels=server:<name>` (BUTCHR-411's argv
wiring), opens the notification stream to that server itself and renders a
push as a `<channel>` frame natively — the same mechanism `server:butchr`
has always used, just against a second server.

Reading BUTCHR-411's own merged argv/mcp.json wiring (`src/agents/argv.ts`,
`src/agents/workspace.ts`) confirms a bound `channel: true` server is treated
identically to `server:butchr` at launch. BUTCHR-411's own PR additionally
ran a staged transport-level probe (`scripts/verify-channel-delivery.ts`)
confirming repeated pushes to a second, non-butchr server are delivered at
the transport layer (see `docs/mcp-server-bindings.md`).

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

**How it answers back:** through the bound server's own MCP tools, over
Codex's ordinary tool connection (`boundCodexServers`, `src/agents/argv.ts`).
That connection carries no extra headers: a binding's `headersEnvVar` value
never reaches Codex argv (see `docs/mcp-server-bindings.md`), so a server
that needs a secret to accept a reply can't get one from a Codex agent today.

**The daemon's own connection** resolves the binding's `headersEnvVar`
(`resolveMcpServerHeaders`): this process is the daemon itself, never a
launched child whose argv another local user can read, so a shared secret
is exactly as safe here as it already is for Claude's own direct connection.

## Design decision 3: duplicate avoidance

This module operates purely on `Rule.mcpServers` bindings and the generic
`InboxMessage` shape (`source`, `content`, `meta`) any thatch-style channel
server emits. Two delivery routes are just two different bindings (two
different `name`s) as far as it is concerned; how a server routes a message
to one agent or many is that server's concern.

Every delivered message is keyed by
`` `${source} ${meta.id ?? meta.messageId ?? content}` `` (see
`dedupKeyOf`) and remembered for `dedupWindowMs` (default 5 minutes), so an
agent reached twice by the same message on one route is woken once. Without
an id in `meta`, only an exact repeat (same source, same content) is caught;
an edited-and-resent message with no id is treated as new.

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

The entire `src/notify/codex-channel-relay.ts` file, plus its one wiring
block in `src/daemon/index.ts` (the `createCodexChannelRelayPool`
construction, its `providerOf`/`bindingsOf`/`nudge` deps, and the
`codexChannelRelayTick`/`setInterval` poll). Nothing else in this repo reads
from or calls into this module. Once BUTCHR-359 lands a real,
production-correct Codex wake path, it subsumes this module's entire job —
"make a channel-bound Codex agent receive channel pushes at all" — with no
other caller in this repo needing to change. `Herd.providerOf` (added by
this ticket to `src/agents/herd.ts`) is a small, general-purpose addition
that has no reason to be removed alongside it.

## What this ticket did NOT verify

- **An end-to-end proof against a real channel server.** This repo's tests
  use a real thatch/MCP server on loopback
  (`test/unit/codex-channel-relay.test.ts`'s `fakeChannelServer`) — a
  faithful stand-in for the wire protocol, not a claim about any particular
  server's message shape (ids, routing).
- **A real Codex PTY-pane wake**, for the same reason BUTCHR-411 could not
  verify it for Claude: no way to reproduce herdr's own pane residency from
  outside the live daemon without touching it (forbidden here, BUTCHR-368).
  What IS verified: `herd.nudge` is called with the rendered turn text the
  moment a push arrives (event-driven, no polling), and `herd.nudge` itself
  is the identical, already-relied-upon transport the rest of this daemon
  uses to wake a resident agent.
