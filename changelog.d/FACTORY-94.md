bump: patch

### Removed

- `AtlassianOps.getChildPages`, `getPageLabels`, and `createPageWithLabel` —
  dead since FACTORY-84/FACTORY-86 removed `ensureDoc`'s per-ticket
  auto-creation, their only caller. Removed from the interface, the real
  Confluence client (`src/tools/atlassian-real.ts`, including the
  now-unneeded raw v1-content client it alone drove), and every test fake
  that implemented them only to satisfy the interface shape. No behavior
  change: nothing in production code called these.
