bump: minor

### Added
- A `jira-project`-owned managed-link collection persisted in the Jira project entity property `brooswit.butchr.links` (`src/resources/jira-project-link-store.ts`, `createJiraProjectLinkStore`) — a second `LinkStore` implementation alongside the file-backed one, sharing its version/unknown-provider discipline and its size-ceiling/race-window namings independently.
- Owner routing (`src/resources/link-store-router.ts`, `createRoutingLinkStore`): `list_links`/`add_link`/`remove_link` now route a `jira-project:<KEY>` owner to the project-property store and every other owner kind to the existing file store, with `listLinks`/`addLink`/`removeLink` themselves unchanged.
- `butchr link ...` for a `jira-project` owner now loads Jira credentials lazily from the same environment the daemon uses, so every other resource kind's CLI usage stays credential-free exactly as before; a missing credential or a Jira 4xx/5xx surfaces as the existing clean stderr line + exit 1.
- `docs/resource-links.md` Decision 9: value shape, version rule, size cap, the read-modify-write race window, and the credential/permission note for the new store.
