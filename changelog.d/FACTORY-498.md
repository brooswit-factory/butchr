# FACTORY-498 — remove codified shelving

Removed `shelve_worker`, the dashboard/API shelve action, and the shelving disposition from worker creation and adoption. Only an explicit `start` disposition is accepted; legacy and malformed calls fail before writes instead of silently starting work.

Removed the shelving label registry/producer and label-based exemptions from closure guards and stop classification. Historical labels are inert. Ordinary statuses, assignment, explicit stop/freeze, approval, quota and dependency controls are unchanged. Updated briefs, documentation and regression tests. This change does not deploy or restart the fleet.
