bump: minor

### Added

- A Codex agent whose rule binds a `channel: true` MCP server (`Rule.mcpServers`,
  BUTCHR-411 — e.g. Rocket.Chat's `rocketr`) now actually receives that
  server's push: the daemon itself holds the notification stream open on the
  agent's behalf (Codex has no development-channel concept and would
  otherwise receive nothing for a bound channel server at all) and turns
  each push into a `herd.nudge()` prompt turn — event-driven, no polling.
  Claude needs no new code: its own CLI already opens that stream directly
  per BUTCHR-411. A stopgap, deliberately isolated behind one seam
  (`createCodexChannelRelayPool`/`startCodexChannelRelay`,
  `src/notify/codex-channel-relay.ts`) for BUTCHR-359 to subsume — see that
  file's own top comment for exactly what it should replace.
- `Herd.providerOf(issue)`: the live, pane-observed provider of a running
  agent (never a static config guess, which ordered provider fallback can
  make stale). A relay is kept, never rebuilt or torn down, while an
  issue's provider is transiently unknown (`null` — a herdr hiccup, a
  starting shell, a pane blocked on a dialog).
- **`McpServerBinding.accountHeader`** (`src/rules/rules.ts`), the small,
  explicit extension to BUTCHR-411's own contract this ticket's review
  found necessary: a header NAME that carries this agent's own non-secret
  Rocket.Chat account name (`rcUsernameFor(agentKey)`, a deterministic
  public identifier, never a credential) — safe on every launch surface,
  Codex argv/mcp.json included, unlike `headersEnvVar`'s resolved value,
  which still never reaches Codex. This is what lets a Codex agent identify
  itself to `rocketr` on its own outbound tool calls (a reply) — `rocketr`
  is a central bridge that holds every account's real token itself, so an
  agent never needs to present one; naming its account is enough.
  `HerdrHerd.spawn`/`HerdrHerd.staleIssues` inject the same account name
  (via a new `accountNameOf` constructor param) so a launched agent's argv
  and a later poll's expectation of it can never drift apart.
- Each relay connects with the SAME per-agent, non-secret account name
  (`accountNameOf`, shared with the launch-time wiring above) rather than a
  shared rule-level credential — needed so a channel server can route a DM
  to one agent rather than every agent sharing that rule's binding.

### Corrected mid-flight (epic design correction, 2026-09-25)

- The account-lifecycle design this ticket first built against (an agent
  reads its own Rocket.Chat token from a workspace file) was superseded by
  the epic: **agents never hold a Rocket.Chat credential.** `rocketr` is a
  central bridge that keeps every token; an agent's binding names only its
  account. This ticket's relay was reworked to match: it no longer reads
  any credential file, computing the (already-non-secret) account name
  directly instead.
- The "Codex cannot reply through rocketr" gap filed as BUTCHR-418 in the
  first review round is resolved by the above: the reason it couldn't reply
  (BUTCHR-411 strips secret header values from Codex argv) never applied to
  a non-secret account name in the first place.
- The account-name field is `SpawnSpec.rocketchatAccount` (not a second,
  independently-named field) — the sibling BUTCHR-412 task landed the same
  `accountHeader` concept independently and converged on this name first
  (via `account-lifecycle.ts`'s `ensure()`, from the real `ensureAccount`
  outcome); `HerdrHerd`'s own `accountNameOf` fills it only when `ensure()`
  never ran for a launch (no accountLifecycle wired at all), never
  overwriting an already-set value.

### Fixed

- Nothing in this repo — but recorded here since it was found while building
  the above: pinned `@brooswit/drovr` 0.11.1's `InboxRelay.push()` has a
  reproducible race that silently drops a message pushed just as the
  previous drain loop finishes (`draining` is cleared in a `.finally()`
  scheduled one microtask after the loop's own synchronous return, not as
  part of it). `src/notify/codex-channel-relay.ts` uses its own corrected
  reimplementation instead of `InboxRelay`; the upstream defect is filed
  separately (see BUTCHR-413's own ticket comments for where).
