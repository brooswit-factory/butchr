bump: patch

### Fixed

- **A managed workspace closed out from under butchr no longer wedges its
  agent permanently — no `butchr.service` restart, no freeze/unfreeze
  (FACTORY-622).** butchr's per-issue worker identity lives in
  `ManagedHerdrLifecycle`'s own private `active` field (a `@brooswit/drovr`
  class butchr caches one instance of per issue, for the daemon's whole
  lifetime). Nothing told it when a pane went away behind its back, and its
  `start()` precondition then refused EVERY later spawn for that issue with
  `HandoffBlocked: "Current worker disappeared; refusing implicit
  replacement"` — forever, since only `stop()` or losing the process ever
  cleared that field. Confirmed live twice: the director and genius panes on
  2026-10-02 (recovered only by restarting `butchr.service` at 11:56, eleven
  minutes later) and admin-brooswit-nexus on 2026-10-03 (26 consecutive
  refusals, recovered only by a hand-run `session freeze` + `unfreeze`).
  A blocked spawn now checks whether the pane it is still holding actually
  exists and, when it positively does not, clears the stale identity so the
  next ordinary reconcile poll's spawn starts clean.
- **Keyed on evidence about the pane, never on how the pane came to be
  empty**, so it covers every reported cause with one check: an external
  herdr `workspace.close` (the original report), a `resumeInPlace` `"stuck"`
  whose `/exit` empties the pane afterwards (the 2026-10-03 case —
  FACTORY-426's fix cannot reach it, because the `herd.stop()` that fix
  relies on only runs for a `"failed"` outcome, never a `"stuck"` one), and
  any later cause nobody has seen yet. It also does not read the blocked
  reason string: the SDK owns the wording of several distinct blocked
  reasons, and the only question that decides whether the held identity is
  stale is whether anything is actually there.
- **Only ever clears on POSITIVE PROOF, which is why it reads herdr twice.**
  A pane absent from a SUCCESSFUL `pane.list()` enumeration is gone (the
  closed-workspace case). A pane herdr still lists can nevertheless be empty
  — the bare shell a `/exit` leaves behind — so a second, three-valued
  occupancy check answers that: only a SUCCESSFUL `pane.processInfo` that
  actually reported a foreground-process array with no provider in it counts
  as empty. A `pane.list()` rejection, a `processInfo` rejection, and a
  `processInfo` that reported no foreground data at all (a shell still
  starting reports none) are all `unknown`, and every one of them leaves the
  worker state exactly as it was and logs why. Clearing on any of those would
  discard a LIVE worker's identity and let the next poll launch a second
  agent beside it in the same workspace — the same unknown-is-not-vacant
  discipline `residency()`/`staleIssues()`/`paneVerdict()` already apply. The
  existing `providerOfPane` helper deliberately collapses "herdr hiccup" and
  "nothing there" into one answer and so could not be reused for this.
- **The empty-but-still-listed case also closes the orphaned bare shell**,
  through the same defensive close `resumeInPlace`'s own `"failed"` route
  already uses, so the next spawn does not have to launch beside it. The
  gone case closes nothing, because there is nothing left to close. A close
  failure never costs the state repair.
- **A crash loop on a session with no Jira ticket now reaches Rocket.Chat,
  not only the journal.** A managed session (director, genius, an admin
  agent) has no ticket to comment on, so the crash-loop detector's
  `addComment` was wired to a `console.error` and its `comments` to a
  constant `[]`: the complaint was correct and completely invisible, twice
  over — "nowhere to post" on 2026-10-02 and "a crash-loop complaint that
  reached only the journal" on 2026-10-03. It now also raises on
  FACTORY-630's generic ops-alert route, which that route's own header
  already named this detector as the planned caller for: one deduplicated
  post per session per hour, naming the session, the count, the window, and
  the refusal reason from the last spawn attempt (`"Current worker
  disappeared; refusing implicit replacement"`, in this ticket's own case),
  with no secrets — the reason rides the one field the route redacts before
  truncating. Wired ONLY into the ticketless tier; the issue tier still
  posts on the resource's own ticket and nothing about it changes, because
  duplicating a ticketed complaint into a shared room is the spam outcome
  that detector's own design ranks worse than silence. The alert
  deliberately does not depend on the comment path succeeding — for a
  ticketless session it cannot — and it inherits the existing threshold and
  the existing fleet-wide confident-zero guard rather than bypassing either.
