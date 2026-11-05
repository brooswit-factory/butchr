bump: patch

### Fixed

- A rule's own `query` (and `enabled`) now always tracks the latest wire
  definition for discovery, admission and retirement, even while that rule
  has a retained worker and its *other* fields are mid-transition. Before
  this, `nextObservationGraph` froze a held rule's entire definition
  (`query` included) until every retained worker under it drained, and
  `allowed()`/`current()` admitted only against that frozen definition —
  so a single retained worker anywhere under a rule silently fenced every
  other resource under that same rule from being discovered, admitted, or
  retired at all, for as long as it existed, regardless of whether the
  query change was additive, narrowing, or a full replacement.
- Narrowing or replacing a query now retires a resource that no longer
  matches through the existing safe lifecycle (`protectStop`), rather than
  that resource being structurally unreachable by discovery in the first
  place; `observationCompatible` and `safeLifecycle`'s identity comparisons
  were adjusted to stop treating a query-only difference as reason to
  protect a worker from stop/respawn — only genuine observation-*behavior*
  drift (below) still does that.
- What *does* still freeze per rule, while any retained worker under it
  exists, is the observation-**behavior** shape that worker's own in-flight
  traversal may depend on — `execution`, `relationships`,
  `linkedEventing`, `linkedPollIntervalMs`, `maxLinkedItems`,
  `linkedRemoteLinks`, `linkedDescriptionLinks` — exactly as before this
  fix, just scoped away from `query`/`enabled`. A rule reached only as
  another rule's dependency (`childRule`/`inwardConnectionRules`) still
  freezes in full, unconditionally, for as long as anything relies on its
  parent — that protection is about a different rule's own in-flight
  linked-item traversal, never an admission backlog, and must keep fencing
  fresh admission under the dependency's key.
- `current()`/`canSpawn()`/`allowed()` themselves are otherwise unchanged:
  once a directly-held rule's own `query`/`enabled` are no longer frozen,
  the existing convergence-gated admission path already does the right
  thing for every resource under it, new or retained, without any special
  casing by resource identity.
