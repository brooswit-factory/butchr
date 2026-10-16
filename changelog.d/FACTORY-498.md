bump: major

### BREAKING
- Remove `shelve_worker`, the dashboard/API `/api/agents/:issue/shelve` action, and the shelving disposition from worker creation and adoption. Only an explicit `start` disposition is accepted; legacy and malformed calls fail before writes instead of silently starting work.

### Removed
- Remove the shelving label registry/producer and label-based exemptions from closure guards and stop classification. Historical labels are inert.

### Changed
- Update briefs, documentation and regression tests for the removed shelving system. Ordinary statuses, assignment, explicit stop/freeze, approval, quota and dependency controls are unchanged. This change does not deploy or restart the fleet.
