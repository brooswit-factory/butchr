---
bump: minor
---

### Added

- **Per-rule idle-poke config surface (epic FACTORY-836, story FACTORY-844).**
  A rule may now set `idlePokeMinutes` (positive number, no default — an
  absent value keeps today's global `stalledMinutes`, env
  `BUTCHR_STALLED_MINUTES`, default 10 — this does **not** change to the
  epic's 30-minute figure for every install, see the ticket for the
  reasoning), `idlePokeMessage` (non-empty string; empty/blank is rejected,
  not treated as "no text" — use `idlePokeEnabled: false` for that; no
  default — an absent value keeps today's existing wake text unchanged),
  and `idlePokeEnabled` (boolean, defaults to `true` — matches today's
  unconditional behaviour). Settable in `rules.json`, readable through the
  rules API/catalog, and editable in the dashboard's Rules page form. This
  is config surface only: nothing in the daemon reads these fields yet
  (follow-up engine story FACTORY-845).
