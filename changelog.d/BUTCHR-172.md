bump: minor

### Added
- `src/media/registry.ts` — an index of the four cached-assertion media this codebase declares a withdrawal story for (Jira labels, ticket description headers, workspace-file snapshots, the Confluence `[unwritten]` doc-title marker), each graded by how strongly its records are made safe (`structural` / `same-call` / `eventual` / `time-invariant` / `self-declaring`) rather than merely whether a withdrawal path exists.
- `src/media/family-scan.ts` — a source scanner catching one source-visible shape of "a withdrawal path exists but its selection does not reach every member of its family": a string literal that hand-enumerates two or more distinct members of a registered family (`agent:*`, `pr:*`) instead of deriving the selection from the family's own value-level anchor. The exact complement of `src/labels/label-scan.ts`, which deliberately ignores this shape.
- `src/media/media-scan.ts` — asserts that every per-medium `registry.ts` module discovered on disk is accounted for in `src/media/registry.ts`'s `MEDIA_REGISTRY`, so a new medium cannot ship without being indexed.
- Short cross-references from `src/labels/registry.ts`, `src/headers/registry.ts`, and `src/workspace/registry.ts` to the new media index, and from `src/labels/label-scan.ts` to the new family scanner.
