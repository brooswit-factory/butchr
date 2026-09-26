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

## The corrected design (2026-09-25): agents never hold a Rocket.Chat credential

The epic recorded a design correction after this ticket's first round
(BUTCHR-391 comments 23997/23999/24003/24007, mirrored on the story as
"[roadmap] Design corrections for S4") that changes the shape of "per-agent
identity" used throughout the rest of this document: **agents never hold a
Rocket.Chat credential at all.** `rocketr` is a central bridge that keeps
every account's token itself; an agent's MCP binding (Claude's mcp.json,
Codex's own launch config, and this relay's own daemon-side connection)
names only its account in a non-secret header — `x-rocketr-account` — never
a token. BUTCHR-412 owns how a per-agent account is provisioned, the 0600
token files `rocketr`/Nexus use, and the hand-off manifest; this relay does
not read any of that. What this relay (and Codex's own launch config) need
is just the account NAME, which is `rcUsernameFor(agentKey)`
(`src/accounts/identity.ts`) — already a deterministic, public identifier
with no secret material in it, computed directly from the agent's own key
with no file read and no dependency on BUTCHR-412's still-evolving
provisioning mechanism. Sections 2 and 3 below describe the resulting
design; the "first version" text they correct is kept only as history.

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

**How it answers back — CORRECTED TWICE now (review finding 1, resolved
against the rocketr design):** the first version of this doc claimed a
Codex agent replies through the bound server's own MCP tools "exactly as a
Claude agent would". That did not survive contact with BUTCHR-411's own
merged review fix (b669346): a Codex launch's bound-server config is
rendered into process argv by Drovr, so BUTCHR-411 deliberately strips
EVERY bound-server header VALUE from a Codex launch, for every binding, to
keep a credential out of argv/logs/`ps` (`boundCodexServers`,
src/agents/argv.ts). The second round filed this as **BUTCHR-418** and left
it open, reasoning that Rocket.Chat's `rocketr` is "an authenticated
server" and a Codex agent's own tool calls therefore "have no way to
authenticate". The corrected design overturns that reasoning: under a
central `rocketr` bridge, an agent never authenticates to `rocketr` with a
credential at all — it identifies its account with a non-secret name, and
`rocketr` (which holds the real token centrally) does the authenticating on
the agent's behalf. An account NAME is not the thing BUTCHR-411's fix was
protecting — a bearer token is. So `McpServerBinding` gained a small,
explicit extension, `accountHeader` (`src/rules/rules.ts`): the NAME of a
header (`"x-rocketr-account"` for `rocketr`) that should carry THIS AGENT'S
OWN account name, `spec.rocketchatAccount` — and `boundCodexServers`
(src/agents/argv.ts) reaches for exactly that value, and ONLY that value,
when building Codex's own bound-server config: `headersEnvVar`'s resolved
value still never reaches Codex argv, unweakened, but `accountHeader`'s
non-secret account name now does. `spec.rocketchatAccount` itself is injected
by `HerdrHerd.spawn` (never by a `specFor*` function) from an
`accountNameOf(issue)` callback that is nothing more than
`rcUsernameFor(issue)` gated on this issue's rule granting it an account —
the exact same deterministic value `src/daemon/index.ts`'s wiring hands to
this relay's own `accountNameOf` dep (decision 3 below), so Codex's own
launch and this relay's daemon-side connection can never disagree about
which account an issue is. `HerdrHerd.staleIssues()` recomputes the SAME
value fresh (never caching the original spawn's spec) so an agent launched
with its account header is not perpetually flagged stale against an
expectation built without one — see `test/unit/herd.test.ts`'s
`accountNameOf` tests for exactly that hazard and its fix. **A Codex agent
can now identify its account to `rocketr` on its own outbound tool calls.**
Commented on BUTCHR-418 that its core "Codex has no way to authenticate"
premise is resolved by this design (an account name needs no separate
env-var/file-reference mechanism — it was never secret); any residual scope
there is `rocketr`'s own real behavior once it exists, not a Butchr code
gap. Proven here with `test/unit/argv.test.ts`'s "a binding's accountHeader
reaches Codex argv" (and the paired "...but never the secret" test proving
`headersEnvVar` and `accountHeader` coexist safely) and
`test/unit/herd.test.ts`'s spawn-level equivalent.

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

**Per-agent identity — CORRECTED TWICE (review finding 2, then the rocketr
design):** the first version of this module opened every (issue, binding)
connection with `resolveMcpServerHeaders(binding)` alone — ONE static
credential shared by every agent a rule binds. A channel server can only
route a DM to "this agent's own account" by the identity presented ON THE
CONNECTION; with a shared credential, every Codex agent bound by the same
rule would look identical to the server, so a DM meant for one would reach
all of them (or none). The second round fixed this by reading a per-agent
credential file directly (BUTCHR-412's old `RC_ACCOUNT_FILE` design,
`url`/`userId`/`authToken`/`username`) — but that design is itself
superseded: agents (and this relay, acting as a stand-in for one) never
hold an RC credential now, so there is no token to read at all. The current
fix: this relay's own connection carries this issue's own non-secret
account NAME under `binding.accountHeader` (e.g. `"x-rocketr-account"`),
resolved via `resolveMcpServerHeaders(binding, undefined, log,
accountNameOf(issue))` — `resolveMcpServerHeaders`, not the Codex-safe
subset, because THIS process is the daemon itself, never a launched child
whose argv another local user can read, so `headersEnvVar`'s own resolved
value (a genuine shared secret, when a rule names one) is exactly as safe
here as it already is for Claude's own direct connection; the account name
merges on top of it, never in place of it. `accountNameOf` (a
`CodexChannelRelayPoolDeps`/`CodexChannelRelayDeps` field) is, in the real
daemon wiring, the exact same function passed to `HerdrHerd` for Codex's
own launch config (decision 2 above) — `src/daemon/index.ts` defines it
once (`rcUsernameFor(id)` gated on `accountPolicyOf(id) !== "none"`) and
hands it to both, so this relay's inbound connection and a Codex agent's
own outbound reply can never disagree about which account an issue is.
Tested (`test/unit/codex-channel-relay.test.ts`): two Codex agents bound to
the identical binding, each with its own account name, and a message
addressed by that name (mirroring `src/daemon/app.ts`'s own `notifyAgent`
`sendAll(..., { where: ... })` targeting pattern) reaches only the intended
one; a shared `headersEnvVar` secret and a per-agent `accountHeader` name
resolving together never leak the secret into a log line. Unverified beyond
that: the assumption that a real `rocketr` accepts `x-rocketr-account` as
its own account-routing header name — `rocketr` does not exist yet to
confirm against.

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

The entire `src/notify/codex-channel-relay.ts` file, plus its one wiring
block in `src/daemon/index.ts` (the `createCodexChannelRelayPool`
construction, its `providerOf`/`bindingsOf`/`nudge`/`accountNameOf` deps,
and the `codexChannelRelayTick`/`setInterval` poll). Nothing else in this
repo reads from or calls into this module. Once BUTCHR-359 lands a real,
production-correct Codex wake path (with proper reconcile-on-restart,
observed-delivery proof, and whatever else that epic's own investigation
finds), it subsumes this module's entire job — "make a channel-bound Codex
agent receive channel pushes at all" — with no other caller in this repo
needing to change. `Herd.providerOf` (added by this ticket to
`src/agents/herd.ts`) and `Herd`/`HerdrHerd`'s own `accountNameOf`
constructor param (used for Codex's REPLY path, decision 2 above — a
different consumer than this module) are smaller, general-purpose additions
that are not themselves part of this stopgap and have no reason to be
removed alongside it: a Codex agent's own ability to identify its account
on an outbound bound-server call is useful behaviour BUTCHR-359 would want
to keep, not something specific to this relay's inbound-only mechanism.

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
- **A Codex agent's reply actually reaching a real `rocketr`** — see "How it
  answers back" above: Codex's own bound-server config now carries its
  account name, so it CAN identify itself; whether a real `rocketr` accepts
  `x-rocketr-account` and treats it as sufficient identification for a
  reply is unconfirmed, since `rocketr` does not exist yet. Proven only at
  the argv/mcp.json level (the header is present, correctly named, correctly
  valued, and no secret ever accompanies it into Codex argv).
- **A real per-agent account name's header name/DM-routing behaviour** — see
  "Per-agent identity" above: `x-rocketr-account` is this ticket's own
  choice of header name, unconfirmed against a real `rocketr`.
