bump: patch

### Fixed

- **A boss's Implements/outward worker is no longer independently re-notified
  through the linked-eventing path — `related:` already covers it.**
  Phase-2 measurement (BUTCHR-450/BUTCHR-468) found duplicate wakes
  concentrated in boss-type agents (booswrit epics 82%, wroosbit stories 70%
  of delivered linked turns landing within 20 minutes of a same-watcher
  `related:` notify; leaf task/bug agents 0%), because `issuelinkItems()`
  discovers every issuelink type and direction while the pre-existing
  `related:` path's own `watchedKeys()` (`src/jira-watch/routes.ts`) routes
  only the Implements/outward pair — so every boss<->worker Implements pair
  was rediscovered and re-notified independently by the linked path.
  `jiraKindLinkedItems` (`src/jira-watch/linked-eventing.ts`) now excludes
  any target already in `watchedKeys(match.issue.issuelinks)`, of whatever
  `LinkedItem` kind it surfaces as — both paths read off the same
  `watchedKeys` function, so they cannot drift apart on what "already
  routed" means. Everything else the linked path discovers — every other
  link type, the reverse (worker-hears-its-own-boss) direction, and leaf
  task/bug agents with no outward Implements links — is unaffected; the
  reverse direction is left as-is deliberately (unmeasured whether those
  wakes are worth having — a condition to revisit default-on, not settled
  here). No new rule field, session-definition field, or `RULE_FIELDS`
  entry: an older build still loads every rule file and definition this one
  does, so rollback is a plain redeploy.
