bump: minor

### Changed

- Idle pokes are now opt-in per rule. A rule without `idlePokeEnabled` used
  to resolve to `true`; it now resolves to `false`, so only a rule that sets
  `idlePokeEnabled: true` (the dashboard's "Poke idle agents" switch) pokes
  its idle agents, and a ticket that no enabled rule turned pokes on for is
  never poked. `GET /api/rules` reports the resolved value, and the
  dashboard's rule dialogs start from it. Set `idlePokeEnabled: true` on a
  rule to keep the old behaviour. `BUTCHR_IDLE_POKE_MODE` still decides
  whether pokes are only logged (`dry-run`, the default) or sent (`live`).
