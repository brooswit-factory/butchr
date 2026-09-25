bump: minor

### Added

- **Jira-kind linked-change eventing is now live for `jira-work` rules with
  `linkedEventing: true` (BUTCHR-436, epic BUTCHR-421, story 2/4).** A
  genuine change (status, summary, or a real comment-bearing `updated` move
  — never a daemon-label-only echo, never a rule agent's own edit) to a
  linked Jira issue — an `issuelink` target (any type, either direction), the
  native `parent`, or a bare Jira key mentioned in the resource's own
  description — now produces exactly ONE coalesced channel nudge per poll
  tick to the owning resource's agent, however many linked items changed
  that tick. Built on story 1's `discoverLinkedItems`/`capLinkedItems`
  (`src/resources/linked-discovery.ts`) and `maxLinkedItems`; diffing reuses
  `isDaemonLabelOnlyDiff` (`src/jira-watch/diff.ts`) and the own-write ledger
  (`src/jira-watch/own-writes.ts`) exactly as owned-resource diffing already
  does. Discovering these targets' current state costs no new Jira call
  beyond one additional batched `key in (...)` search per poll tick, covering
  every `linkedEventing` resource's linked targets combined — never one call
  per linked item, never one per resource.
- **New knob: `linkedRemoteLinks` (boolean, default false).** Only
  meaningful when `linkedEventing` is also true. Opts a rule's resources into
  fetching their Jira remote links (`AtlassianClient#remoteLinks`) as an
  additional linked-Jira-item source — a genuinely separate REST call per
  opted-in resource, unlike issuelinks/parent/description, which ride the
  existing search fields at zero marginal cost. Only a remote link that
  resolves to a `.../browse/<KEY>` URL on this Jira site counts; anything
  else (a GitHub PR, a Confluence page, a generic webpage) is out of scope
  for this story (BUTCHR-428's). A resource whose rule leaves this
  absent/false makes zero remote-link API calls.
- **New per-agent sliding-window rate cap: `maxLinkedTurnsPerHour`,
  now enforced.** A poll tick that would exceed a rule's configured budget
  drops the coalesced nudge (never queues it) and logs
  `[notify-suppressed] ... arm=rate-capped ...`
  (`rateCappedSuppressedLine`, `src/jira-watch/suppressed-log.ts`, a new
  arm alongside `agent-fold`/`stand-down`). Nothing already-changed is lost:
  the underlying per-(owner, linked-item) comparison baseline is left
  unadvanced on a capped tick, so the next allowed tick re-detects whatever
  is still outstanding (plus anything that changed again meanwhile) and
  delivers it then.
- **Unreadable and removed linked items are now explicit, not just logged.**
  A linked key requested in a poll tick's batched fetch but not returned
  (404/403/deleted/inaccessible — Jira's `key in (...)` omits it silently,
  with no per-key HTTP status available) appears as its own
  `<key> (<kind>): unreadable` line in the delivered message on the tick it
  transitions into that state (including its first sighting); it does not
  keep re-triggering on its own while it stays unreadable, but rides along
  as a context line on any later message a real change/removal/other
  transition already earns, and reports again after being seen readable in
  between. A batched-fetch failure (e.g. a timeout) is not treated as
  "unreadable" — it skips the whole tick instead, so a transient error never
  falsely reports a healthy link. A link that disappears from
  `discoverLinkedItems`'s own
  output (e.g. an issuelink removed) is reported once as
  `<key> (<kind>): no longer linked`, then dropped from that resource's watch
  set — never re-reported while it stays absent.
- **New formatter `linkedChangeNudge`** (`src/agents/change-nudge.ts`,
  sibling of `changeNudge`/`prReviewStateNudge`): one summary line, then one
  `<link> (<kind>): <what changed>` line per event. Delivered through the
  SAME notify call path every other rule-agent nudge already uses
  (`notifyAgent` + `herd.nudge`, `src/daemon/index.ts`) — no new delivery
  mechanism, so this reaches Claude agents only; Codex delivery remains
  BUTCHR-359's own gap, untouched here. `NotifyReason` gained a new
  `{ linked }` member (`src/resources/types.ts`) carrying the coalesced
  event list.

### Scope notes (not built here — see the ticket for why)

- **Epic/Story/Task child discovery needed no new code.** This fleet's own
  Task→Story→Epic hierarchy links a child to its parent with the
  `Implements` issue-link type, which already appears on the PARENT's own
  `issuelinks` (confirmed live: BUTCHR-421's issuelinks list its own child
  stories/tasks) — story 1's generic `issuelinkItems` discovery already
  surfaces it, so a Task/Story/Epic parent already hears its children change
  through this same mechanism with zero additional code.
- **Jira-project member discovery (one JQL watch per Jira PROJECT) is
  descoped from this story**, by the epic's own decision: no live
  `jira-project` resource provider exists in the rules engine today
  (`RESOURCE_PROVIDERS`, `src/rules/agent-key.ts`, has none), and the
  separate, fully-built-but-unwired "project tier"
  (`createProjectResourceType`, `src/resources/project.ts`) has no live
  caller in production — there is exactly one `runResourceLoop` call in
  `src/daemon/index.ts` today, the rule engine's. There is therefore no live
  "project-owning agent" for a project-member watch to notify. Introducing
  one is out of this story's scope (likely BUTCHR-433's, "retiring the tier
  hierarchy"). Discovery and the coalescer are shaped so a project-member
  link source can plug in later (`jiraKindLinkedItems`,
  `src/jira-watch/linked-eventing.ts`, is a per-match pure function
  returning a plain list) with no rework to the coalescer, rate cap, or
  delivery.
