bump: patch

### Changed
- **The fleet agent cap (`BUTCHR_MAX_AGENTS`) and admission now count only leaf work: Task, Sub-task and Bug agents.** Project-tier agents and Epic/Story agents are never counted toward the cap and never withheld (Brooswit, 2026-09-25; an interim measure until query-based resources replace those tiers).
- Implemented on BUTCHR-398's capacity role: `capacityRoleFor` (`src/agents/capacity-role.ts`) classifies those agents as `sentinel`, which admission already excludes. It's keyed on the agent's kind and its issue's type (from the daemon's own `issueMeta`), not on a rule-file flag, so **no rules-file change is needed on any daemon**. An issue whose type isn't known yet stays counted (fail-safe). In `[admission2]` lines, uncounted Epic/Story/project agents now appear under `sentinels=`.
