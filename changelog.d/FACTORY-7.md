bump: minor

### Added
- `ResourceRef`: a canonical, validated reference type covering six provider kinds (`jira-work-item`, `jira-project`, `confluence-page`, `github-issue`, `filesystem`, `webpage`), each with a canonical `<provider>:<id>` string form used for CLI, MCP, and on-disk storage alike (`src/resources/resource-ref.ts` and its per-provider `-ref.ts` modules).
- A provider-agnostic, versioned, butchr-managed link collection (`src/resources/link-store.ts`), plus `mergeEffectiveLinks` (`src/resources/managed-links.ts`) — the documented contract a future provider adapter will use to combine it with provider-native links into one effective sensor set.
- `list_links`/`add_link`/`remove_link`: core operations, MCP tools (`src/tools/resource-links.ts`), and a new `butchr link list|add|remove` CLI (`src/cli/link-cli.ts`) — the first subcommand `butchr` has ever had. Idempotent add, non-destructive remove, self-link refusal.
- `docs/resource-links.md`: the decisions (schema/versioning, dedup/canonicalization per provider, recursion, persistence, the merge contract, the `ProviderAdapter` extension point) and the stable surface FACTORY-5/FACTORY-6 build on next.
