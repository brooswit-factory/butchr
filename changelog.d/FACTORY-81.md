bump: minor

### Added

- New `GET /configurations` daemon route: a read-only "Configurations" view
  in the web dashboard rendering FACTORY-72's `/config-inventory` inventory —
  every rule (id, provider, query, enabled/disabled, execution,
  harness/model/effort, linked-eventing, staffed/unstaffed with its real
  reason) and every managed-session definition (vendor/tier, permission mode,
  execution, account, role, working directory, MCP server names, both frozen
  states, freeze/unfreeze controllers, archived flag, valid/problems) —
  whether or not it currently has a running agent. Load/parse errors and a
  failed inventory fetch are both displayed prominently, never as an
  empty-looking table. Only named fields are ever rendered, so no future
  field can leak a secret value.
- Additive cross-links, both ways: each rule/session-definition entry links
  to its running agent row(s) on the existing dashboard, and each agent row
  gains one additional "config" link back to its own entry — computed via a
  small, pure, unit-tested matching module
  (`src/agents/config-inventory-links.ts`) reusing the existing
  `decodeAnyAgentKey`/`sessionAgentKey` correlation identifiers rather than
  inventing a new one. The existing dashboard's rows and attach-via-herdr
  behavior are otherwise unchanged.
