bump: patch

### Fixed
- A managed-session agent (started via the built-in `startManagedSessionsLoop`
  query, e.g. buddy/genius) deferring a model/effort-only resume no longer
  goes unnoticed: `onResumeWaiting` now fires (logged; managed-session agents
  have no Jira ticket to comment on) after the usual number of consecutive
  deferred/stuck polls, and `onResumePreserved` now logs a successful
  in-place resume for the same agents.
