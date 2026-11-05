bump: patch

### Fixed

- Remote-rule admission no longer fences every newly eligible resource
  behind one unrelated retained worker. `allowed()` previously rejected
  admission for an entire rule whenever its held/frozen `observationGraph`
  entry (kept stale on purpose so a retained worker's own query/relationship
  shape never drifts mid-flight — see `nextObservationGraph`) hadn't yet
  converged with the live wire definition, even for a resource that has no
  existing identity to protect. `current()` now evaluates a never-before-
  retained resource against the live desired definition instead
  (`admissionReady`, the convergence-independent half of `allowed`), while
  an already-known retained id keeps the stricter, convergence-gated path
  unchanged — so a resource that matched the rule all along (e.g. an
  `In Progress` task) admits immediately on a query change that only adds
  statuses, without waiting for an unrelated retained worker to disappear.
- A resource admitted this way is pinned to the live desired definition at
  admission time (`canSpawn`), not the stale frozen one — otherwise it would
  itself keep `heldObservationKeys` anchored to the old shape forever, and
  the observation graph would never converge even after the originally
  retained worker naturally completes. `heldObservationKeys` now holds a key
  only while some retained identity under it is genuinely still pinned to a
  shape the live wire has since moved past, not merely because a resource
  (freshly admitted or not) exists under it at all.
- Known limitation, not addressed here: if the physical spawn for a
  freshly-admitted resource fails mid-transition (`spawnFailed`) while its
  rule is still deferred, a retry within the same deferred window is not
  guaranteed — `current()`'s relaxed path only covers a resource with no
  prior admission decision or with one still pending (`pendingSpawns`).
