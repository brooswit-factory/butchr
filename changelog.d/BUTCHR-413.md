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
- Each relay connects with the agent's OWN Rocket.Chat identity when it has
  one (BUTCHR-412's per-agent `.butchr-rocketchat.json`), falling back to
  the rule-level shared credential only for an `account: "none"` rule —
  needed so a channel server can route a DM to one agent rather than every
  agent sharing that rule's binding.

### Known gap (filed, not fixed here)

- A Codex agent still cannot reply through an authenticated bound server's
  own tools (e.g. `rocketr`): BUTCHR-411 strips every bound-server header
  from a Codex launch to keep credentials out of argv. Filed as BUTCHR-418.
  Inbound delivery to Codex works; that specific reply path does not yet.

### Fixed

- Nothing in this repo — but recorded here since it was found while building
  the above: pinned `@brooswit/drovr` 0.11.1's `InboxRelay.push()` has a
  reproducible race that silently drops a message pushed just as the
  previous drain loop finishes (`draining` is cleared in a `.finally()`
  scheduled one microtask after the loop's own synchronous return, not as
  part of it). `src/notify/codex-channel-relay.ts` uses its own corrected
  reimplementation instead of `InboxRelay`; the upstream defect is filed
  separately (see BUTCHR-413's own ticket comments for where).
