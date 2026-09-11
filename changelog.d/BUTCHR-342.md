bump: patch

### Fixed
- **The dashboard's PANE field is now visible text on every agent row, not just an href (BUTCHR-342).** BUTCHR-266's own acceptance criterion names five fields per agent row — resource key, tier, agent status, pane, and time-in-status — but `row.pane` was only ever used to build the terminal-attach link's `href`; a person reading the rendered page had no way to see it without hovering the link or opening devtools. `renderAgentRow` (`src/web/dashboard-page.ts`) now renders the pane as its own escaped `<span class="pane">`, in the same small-monospace visual family as `.key`/`.tier`/`.st`. Withheld rows are unaffected — they still structurally have no agent and therefore no pane slot at all.
