# Wake path for standalone Confluence pages (FACTORY-997, story FACTORY-994, epic FACTORY-348)

What this closes: epic FACTORY-348's "Gap 2" (per the director's addendum
on that epic, and FACTORY-991's spike findings). A Confluence page edit or
new footer comment already wakes an agent when the page is reached through
a Jira ticket's linked-item list (`src/jira-watch/linked-eventing.ts`,
`pollConfluencePage`/`confluencePageVersion`, polled on the issue-tier's
15-second loop in `src/daemon/index.ts`). A STANDALONE page — no owning
Jira ticket anywhere — had no path to a wake at all before this change: it
is not reachable from any issue's linked-item list, so `linked-eventing.ts`
never sees it.

## Update (FACTORY-998): the real provider has landed

FACTORY-992/998 shipped the real `confluence-page` provider this doc's own
"What this module is, and is not" section below describes as pending —
`src/rules/confluence-page-type.ts`, registered in `RESOURCE_PROVIDERS`
(`src/rules/agent-key.ts`) and `capabilities.ts`'s `query` cell for
`confluence-page`, wired into `src/daemon/index.ts`'s production loop
lineup. See **docs/confluence-page.md** for that provider's own full
writeup (query syntax, discovery/pagination, change events, the brief-
mechanism decision, safety). The rest of THIS document is kept as-is,
unedited, as the historical record of FACTORY-997's own narrower scope —
`src/resources/confluence-page.ts` itself is unchanged by FACTORY-998 and
still serves exactly the standalone-page (no owning Jira ticket, no
ancestor rule) case this document describes.

## What this module is, and is not

`src/resources/confluence-page.ts` provides a `ResourceType<ConfluencePageSnapshot>`
(see `src/resources/types.ts` for the interface this implements) — the
change-detection/event half only. The sibling story FACTORY-992 owns the
real `confluence-page` provider: `{ancestor: pageId}` discovery via
`AtlassianOps.getChildPages`, real activation, and real spawn config for a
Confluence-backed agent. This module's own `discovery`/`activation`/
`spawnConfig` are deliberately minimal placeholders — just enough to make
`ResourceType<ConfluencePageSnapshot>` complete and runnable through the
real, unmodified `runResourceLoop` (`src/daemon/loop.ts`) for testing. They
are not wired into `src/daemon/index.ts`'s production loop lineup, and
`confluence-page` is not added to `RESOURCE_PROVIDERS`
(`src/rules/agent-key.ts`) or flipped to `query: true` in
`capabilities.ts` by this change — that registration is FACTORY-992's to
do, once its real discovery exists to feed this event half something
meaningful to watch.

## The mechanism: poll, not push

Confirmed by FACTORY-991's spike (no webhook code exists anywhere in this
codebase) and carried forward here: polling, on the same cadence the
issue-tier's Confluence-link poller already uses (`src/daemon/index.ts`'s
`startIssueLoop`, `intervalMs: 15_000` — "the 15s tier"). This module does
not itself start a loop; whatever registers its `ResourceType` (FACTORY-992,
eventually) is expected to run it on that same 15-second interval unless a
reason specific to that registration says otherwise.

## What is fingerprinted

Per poll, for each tracked page:

- **Version** — the page's own `version.number`, the exact fingerprint
  `confluencePageVersion` (`src/atlassian/client.ts`) already uses for the
  ticket-bound path. A scalar; compared by `!==`.
- **Footer-comment id set** — every id `AtlassianOps.getPageComments`
  returns this poll, compared as a SET against the previous poll's set
  (`Set` membership only — see `diffConfluencePage`'s own doc comment).
  Deliberately not "newest id": Confluence comment ids are not guaranteed
  monotonic with creation time (a fact carried forward from FACTORY-991's
  findings, echoed elsewhere in this codebase's own notes on
  `getPageComments`), so a "newest id moved" check can both miss a real
  new comment and misfire on an id that is merely different from before
  for no eventful reason.

A version change and a same-poll comment change are never reported
together: `diffConfluencePage` checks version first and only falls through
to the comment-set check when the version did not move. Documented there
as a deliberate simplification (an `EventVerdict` carries one `reason` per
`decide()` call) rather than an oversight.

## API calls per tick

For `N` tracked pages: **one** batched `getPageVersions(pageIds)` call
(confirmed live-batchable per that op's own doc comment on `AtlassianOps`)
covering all `N` pages at once, plus **N** individual `getPageComments(id)`
calls — one per page, never batched. `getPageComments`'s own doc comment
names a MEASURED trap: a batch-shaped footer-comments request
(`GET /wiki/api/v2/footer-comments?id=A&id=B`) silently ignores the `id`
filter and returns unrelated pages' comments, with no error — so this
module deliberately pays `N` separate round-trips rather than risk that.
Total: `1 + N` Confluence API calls per 15-second tick, linear in the
number of tracked pages, with no reduction available today beyond "track
fewer pages" (a provider-discovery concern, not this module's).

## First observation — baseline, not a wake

A page's first-ever appearance in a poll's snapshot establishes a
baseline silently: `diffConfluencePage(undefined, after)` returns `null`
(no change), and `createConfluencePageEventRules`'s own `poll` never adds
such an id to `changedPrimary` in the first place, so `decide()` is never
even called for it. This mirrors `src/resources/issue.ts`'s own
comment-cursor baseline-seeding discipline (a cursor's first write never
wakes anyone) rather than the `{ appeared: true }` member other resource
types use for a genuinely new related resource — a standalone page's
"appearance" from this module's point of view is just "the daemon started
watching it," not a structural event worth a notify.

## Failure behaviour — no crash, no storm

- **A single page's version read missing from `getPageVersions`'s
  response** (deleted, or otherwise unreadable this tick) — that op's own
  contract treats absence as "unknown," never a thrown error or a
  sentinel version. This module's `discovery.search()` simply drops that
  id from the poll's result. The next poll, if the page becomes readable
  again, sees it as a first observation (baseline, no wake) — a known,
  deliberate tradeoff: a disappear-then-reappear pair never produces two
  events, in exchange for never crashing or storming on a transient or
  permanent read failure.
- **A single page's `getPageComments` call throwing** — caught per-page;
  that one id is dropped from this tick's result (same effect as a
  version-read miss above), never propagated to fail the whole poll.
- Nothing in this module retries within a poll; a failure just means "try
  again next tick," the same fail-open posture `src/resources/project.ts`'s
  own version/comment reads already take.

## Why polling, not a webhook or Rocket.Chat mention

Per FACTORY-991's spike (re-verified, not re-litigated here): no webhook
receiver exists anywhere in this codebase today, and the epic's director
addendum judged a Rocket.Chat-mention alternative unnecessary once a real
poll-and-diff path (this module) was shown to generalize cleanly from the
jira-work tier's own precedent. Building a webhook receiver and verifying
Confluence's webhook delivery guarantees was out of scope for this story
and is not reconsidered here.

## Tests

- `test/unit/confluence-page-resource-type.test.ts` — the pure
  `diffConfluencePage` function (version bump, new comment by set
  membership, no change, first-observation baseline, comment-set
  shrinkage, same-poll precedence), `createConfluencePageEventRules().poll`
  wired to it (changedPrimary/decide, the deleted-page no-storm case, the
  related-space no-op case), and an integration-style suite that builds a
  real `createConfluencePageResourceType` over a fake `AtlassianOps`-shaped
  deps object and runs it through the real, unmodified `runResourceLoop`
  (`src/daemon/loop.ts`) — the same proof technique
  `test/unit/resource-type-second-instance.test.ts` already established —
  confirming a standalone page (no Jira ticket anywhere in the test)
  produces a real `notify` call for both an edit and a new comment.
