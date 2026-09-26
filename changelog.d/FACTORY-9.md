bump: minor

### Added

- **FACTORY-4's butchr-managed links now feed the existing linked-change
  eventing notify path (FACTORY-9, implements FACTORY-6, epic FACTORY-3,
  story 3/3).** A `jira-work` rule's own agents now reconcile their
  butchr-managed links (`butchr link add`, `add_link`) alongside their
  native Jira links into ONE effective, deduped watch set
  (`mergeEffectiveLinks`), on every poll tick — a link newly present starts
  a watcher (first sighting seeds silently, never fires); a link no longer
  present tears its watcher AND cached snapshot down (fixed a latent gap: a
  removed link's baseline is now actually deleted, not left stale, so a
  later re-add reseeds cleanly instead of firing a spurious change). A
  managed link to a `confluence-page`, `github-issue`, or `webpage` target
  reuses the existing BUTCHR-437 pollers unchanged; a managed link to a
  `filesystem` target is watched via a new lightweight `fs.stat` (mtime+size)
  poller — no network call. A managed link to a `jira-project` target is an
  explicit, documented scope gap (no live Jira project-level change-token
  source exists yet) — skipped, logged once, never a crash.
- **Jira-kind linked items now detect a new (or deleted) comment
  specifically**, not just a bare "updated". The existing status/summary/
  updated/labels snapshot gains an optional newest-comment-id cursor,
  populated by one new per-target comment fetch per tick (Jira has no
  batched comments endpoint) when the daemon wires a `comments` dependency
  — omitted, behavior is byte-for-byte unchanged from before this story.
  Renders as `got a new comment` / `had a comment removed` in the coalesced
  `linkedChangeNudge` line, ahead of the generic "updated" fallback.
- **Re-proves the FACTORY-1 regression class for this new path**: a test
  exhausts an owner's `maxLinkedTurnsPerHour` budget with unrelated
  MANAGED-link churn, then shows a rate-capped managed-link change is
  retried (delayed, never lost) on the next allowed tick, and that a
  cross-daemon boss/worker `related:` handoff (architecturally independent
  of the `linked:` rate cap — see FACTORY-1's own investigation) still fires
  the instant it happens regardless.
- Everything reuses the EXISTING capped, deduped `deps.notify` delivery —
  no second notification mechanism. `docs/resource-links.md` has the full
  writeup (kind-mapping table, wiring, what's explicitly out of scope).
