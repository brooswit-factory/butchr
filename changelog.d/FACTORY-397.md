bump: minor

### Added

- **A distinct, host-wide, non-agent-mediated alert for a dead Claude Code
  credential (FACTORY-363/FACTORY-397, closes the FACTORY-357 13-hour
  silent-stall class).** Wires drovr's `createLoginExpiredWatcher`
  (`@brooswit/drovr` >= 0.16.3) on its own independent 5-second poll loop —
  deliberately NOT through `createManagedSessionEscalationWatcher`'s
  `onDrovrUnknownDialog`, whose managed-session-only routing would silently
  drop a KEYED pane (both real incidents, FACTORY-314/w1T and
  FACTORY-324/w1V, were keyed). Every `onLoginExpired` across the whole
  fleet collapses into ONE host-wide episode: a `[butchr:credential-dead]`
  journal line (distinct from `[butchr:unresponsive]` and from the routine
  `[prompts] ... blocked with no parseable dialog` debug line) fires on the
  very first detection, with no debounce, and a `/health` sibling field
  (`credentialDeathAlert`) surfaces it for as long as it stays open — both
  survive a dead credential because neither is Claude: the journal line is
  plain process stdout (readable via `journalctl` with no agent or API call
  in the path) and `/health` is a plain HTTP GET served by the daemon's own
  listener. There is no `ANSWER`/fingerprint affordance anywhere in its
  output. The alert quotes drovr's own `detail` verbatim rather than
  asserting a specific credential-death string (the installed Claude Code
  binary emits at least five distinct ones). The alert clears ONLY on
  `reason: "recovered"` — `"pane-gone"` (ordinary pane churn) and
  `"superseded"` (the ordinary shape of a dead credential being retried)
  both leave it open. See `src/agents/login-expired-alert.ts` and
  `docs/credential-death-alert.md` for the full design and delivery
  argument.
- Bumps `@brooswit/drovr` to `v0.16.3` (a new release cut from drovr `main`
  at `3bf64b7304976fa91a2e374113fc42d7d6616796`, per the FACTORY-320
  precedent — full ancestry proof and tarball sha256 in the PR body), which
  is the first cut release exporting `createLoginExpiredWatcher` (FACTORY-360)
  and the `reason: "recovered" | "pane-gone" | "superseded"` discriminator
  on `LoginExpiredResolved` (FACTORY-373). No other behavior change from
  this bump — full existing suite stays green.
