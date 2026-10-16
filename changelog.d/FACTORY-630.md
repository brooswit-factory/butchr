bump: minor

### Added

- **The `credential-dead` alert now POSTS TO ROCKET.CHAT, through a new
  generic ops-alert route (FACTORY-630 — the alert fired at 18:37Z on
  2026-10-02 and nobody saw it).** Nothing about the detector
  (`src/agents/login-expired-alert.ts`, FACTORY-363/FACTORY-397) was broken:
  it wrote its `[butchr:credential-dead]` journal line and populated
  `/health`'s `credentialDeathAlert` exactly as designed. But both of those
  channels are PULL-only — they need a human already looking at the right
  host's journal or curling `/health` — so a correct alert reached nobody.
  The new third channel is a PUSH to a Rocket.Chat room over the
  FACTORY-369/609/611 poster's own credential, which is an RC
  user-id/token pair and therefore has nothing to do with the Claude
  credential this condition kills: posting involves no Claude session, no
  Anthropic API call and no agent in the path, which is what lets it coexist
  with this alert's standing rule that it can never be agent-mediated. It
  carries no `ANSWER`/fingerprint affordance, for the same reason as before —
  there is no answer to an expired OAuth token except a human in a real
  browser.
- **The route is GENERIC, not credential-specific** (`src/agents/ops-alert.ts`):
  a typed ops alert — a `key`, a `condition`, a `subject`, a `reason`, a
  `remedy` and a dedup window — with no credential concept in it anywhere.
  `credential-dead` is its first and, in this change, only caller.
  FACTORY-622's crash-loop detector and FACTORY-625's PreToolUse hook's
  block/fail-open counter can each become a second caller without touching
  the route; FACTORY-625 asked for exactly that on FACTORY-630 and can plan
  on reuse.
- **Dedup: at most one post per condition per hour**, configurable via
  `BUTCHR_OPS_ALERT_DEDUP_MINUTES` fleet-wide and per alert via the typed
  entry point's own `dedupWindowMs`, with a short "recovered" post when the
  condition clears. A flapping credential cannot spam the room. The
  deliberate asymmetry with the journal line is documented in
  `docs/credential-death-alert.md`: the journal collapses on EPISODE
  boundaries and is never time-capped (a window could swallow a new
  episode's first line), while the ROOM is time-capped because that is where
  real people read. The cost — a genuinely new episode inside the window is
  not re-posted — is stated, and never silent: every suppression writes its
  own `[butchr:ops-alert]` journal line naming when the next post becomes
  possible. A recovery post additionally requires that the alert post for
  that condition actually SUCCEEDED first, since a lone "X recovered" in a
  room that never heard X was broken reads as one somebody else handled.
- **Reuses the existing poster and the existing hardened-post pipeline — no
  second Rocket.Chat client, no second sanitiser.** The route takes the
  narrow `(room, text)` seam `EscalatorDeps.teamAdminNotify` is already wired
  behind in `src/daemon/index.ts`, built from the same
  `createRocketChatPoster` and the same one credential (there is no second
  Nexus grant to ask for, only a second room per call). FACTORY-611's
  neutralisation pipeline — secret redaction before truncation,
  mention/markup defanging, control/bidi/line-separator stripping, the fixed
  3-backtick fence with backtick-run breaking, surrogate-safe truncation,
  newline flattening so a quoted field cannot forge a labelled line — moved
  verbatim out of `src/agents/escalation-loop.ts` (where it was
  module-private) into `src/agents/rocketchat-text.ts`, and both posters now
  import it. The move is behaviour-preserving: every moved function is
  byte-identical to the escalation path's own, and that path's existing tests
  are the regression proof.
- **Routing config, not literals** (`Config.opsAlert`, defaults in
  `OPS_ALERT_DEFAULTS`): `BUTCHR_OPS_ALERT_ROOM` (default `team-admin`, the
  director's choice on FACTORY-630), `BUTCHR_OPS_ALERT_MENTION` (default
  `@director`, since every condition on this route is by construction one no
  agent can fix; a literal `none` posts with no mention) and
  `BUTCHR_OPS_ALERT_DEDUP_MINUTES` (default 60). Always present, like
  `managedEscalationRouting`, because the journal line needs these values
  whether or not posting is configured.
- **Fails open, always.** `raise`/`recover` are synchronous and documented
  never to throw: an unconfigured poster logs once per key, a rejected post
  logs a WARNING and leaves the dedup window unconsumed so the next raise
  retries, an in-flight post is never dispatched twice, and a poster that
  throws SYNCHRONOUSLY (the one shape a bare `.catch()` would miss) is caught
  too. A detector that crashed on a posting failure would lose the one
  channel that was already working.
