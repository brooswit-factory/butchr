bump: minor

### Added

- Add a `filesystem` resource provider: rules select files or directories
  under a local root with a small JSON query (root, file-or-directory kind,
  a basename glob, a recursion depth, and an optional extension/hasEntry
  predicate), staffed through the same query -> agent model as every other
  provider, under all three execution modes (swarm/singleton/persistent).
  Needs no external credential. Change events (create, modify, remove) are
  delivered to singleton/persistent agents; a swarm agent is notified when
  its own resource's content changes. Symlinks are never followed, so a
  match can never resolve outside the declared root. See `docs/filesystem.md`.
