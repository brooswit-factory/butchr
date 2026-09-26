---
bump: minor
---

### Added

- Lizard mode now answers a blocked pane's permission prompt within about a second instead of waiting up to 20s for the next sweep tick (FACTORY-98/FACTORY-97): the daemon subscribes to herdr's own `pane.agent_status_changed` push event for each currently lizard-eligible pane and answers immediately on a `blocked` transition, with the existing 20s scan kept as a fallback (a dropped subscription, or a pane not yet known eligible, is still caught within one sweep — no regression against the previous behavior). No change to what gets pressed (still option 1 "Yes", once, per FACTORY-93) or to the opt-in gate (still `lizardMode: true` only).
