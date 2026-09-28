bump: minor

### Changed

- **No linked-eventing owner kind can run uncapped anymore.** `runTick`
  (`src/jira-watch/linked-eventing.ts`) now falls back to a fixed default —
  2 turns/hour, 25 items — whenever a rule leaves `maxLinkedTurnsPerHour`/
  `maxLinkedItems` absent, applied at every site that reads a cap: the
  turn-rate check, both item-cap call sites (issue owner and project owner),
  the project-member-cap warning log, and the `[linked-discovery]` log for
  an opted-in rule. This closes the gap `MANAGED_SESSION_LINKED_EVENTING_RULE`
  left open since FACTORY-53/71 (tracked as FACTORY-78): a managed session
  naming a project via `linkedEventingProjects` was on and unconditionally
  uncapped, with no config field able to cap it, because the default now
  lives at the enforcement site rather than in a rules file. An explicit
  `maxLinkedTurnsPerHour`/`maxLinkedItems` on a rule still always wins over
  the default, in both directions; there is still no value that means
  "uncapped." `linkedEventing` itself stays opt-in — absent/false is
  unaffected. No new rule field, session-definition field, or `RULE_FIELDS`
  entry: an older build still loads every rule file and definition this one
  does, so rollback is a plain redeploy.
- The rate-capped `[notify-suppressed] ... arm=rate-capped` log line no
  longer risks emitting a literal NUL byte: a managed session's
  per-(session, project) state key (`<session key>\0linked:<project ref>`)
  is no longer logged as `watcher=` — the real notified agent
  (`notifyAgentKey`) is, since a NUL byte in a journal write was confirmed
  to split it into two separate journal entries.
