bump: patch

### Changed
- `/config-inventory`: each valid managed-session definition entry additionally
  carries the resolved effective `resolvedModel`/`resolvedEffort` (via
  `effectiveAgent()`), alongside the existing raw `vendor`/`tier`/`modelPower`/`effort`.
- `/configurations`: definition rows show the resolved model/effort labeled as
  such, with the raw values as secondary detail; a two-axis definition no
  longer renders `claude/?`. Rule preference rows drop the stale "(model/effort
  stand in for tier)" caption and label their values as resolved/effective.
