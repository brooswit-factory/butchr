---
bump: patch
---

### Fixed

- **Butchr notices no longer reach a resident Claude agent twice (FACTORY-894/FACTORY-893).** Every delivery seam (the jira-work rule engine plus the github-issue, github-pr, jira-idea, zendesk-ticket, filesystem and managed-sessions loops) used to push the notice over the agent's MCP dev channel AND, unconditionally and in the same breath, type it into the agent's prompt (`herd.nudge`) — the channel push's own result was discarded rather than consulted. All seven seams now route through one shared gate (`deliverNotice`, src/notify/deliver.ts): the prompt is only used when the channel push did not positively confirm at least one live connection took the frame (push rejected, nothing attached, or an ambiguous `sent`/`refused` read) — never the reverse, so under-delivery (a silently lost notice) is treated as strictly worse than the harmless double-delivery this closes. The `[notify]` log line now states which delivery actually happened (`Claude channel delivered` / `Claude channel unavailable (<reason>), fell back to prompt: ...`) instead of asserting both unconditionally. Codex agents are unaffected: the channel push already excludes them, so the gate falls back to the prompt for them exactly as before.
