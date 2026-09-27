---
bump: minor
---

### Added

- The permission-answer loop's `answered:` journal line and `.permission-audit.jsonl` record now carry a `trigger` (`"fast"` or `"sweep"`) and, for a fast-path answer, a `latencyMs` number (FACTORY-145): elapsed time from the pane's own `blocked` push-frame receipt to the prompt being pressed, letting p50/p95 be computed straight from the audit file. A sweep-triggered answer's true wait before that scan is unknowable, so it carries no `latencyMs` at all — never a fabricated one. See `docs/permission-answer-loop.md`'s "Fast-path latency (FACTORY-145)" section for the exact field shapes and a `jq` one-liner to compute percentiles. Log/audit output only — no behavior change to what gets pressed or when.
