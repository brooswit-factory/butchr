# `confluence-page`: one agent per child page

`confluence-page` is its own resource provider (FACTORY-998, story
FACTORY-992, epic FACTORY-348). A rule names an ANCESTOR Confluence page; one
agent is staffed per DIRECT CHILD of that page, keyed
`confluence-page:<ruleId>:<child-page-id>`.

Unlike `github-issue`/`zendesk-ticket`, `confluence-page` needs no dedicated
staffing gate: this daemon never reaches its real rule loops at all without a
fully-configured Atlassian site/email/token (`src/daemon/index.ts`'s own
setup-mode gate, checked before any loop starts), so the same `AtlassianOps`
instance every other Confluence/Jira read path in this codebase already uses
is always available — no new credential, no new staffing predicate.

## Relationship to FACTORY-997's standalone-page event path

`src/resources/confluence-page.ts` (FACTORY-997) provides the pure
`diffConfluencePage` function and `ConfluencePageSnapshot`/
`ConfluencePageChange` shapes — this story REUSES those directly rather than
reinventing "what changed about one page between two polls". What it does
NOT reuse: that module's own `discovery`/`activation`/`spawnConfig`, which
its own top comment calls a deliberately thin, provisional seam this story
should "replace wholesale rather than build on" — `trackedPageIds()` there is
an INJECTED dependency standing in for real child-page enumeration, and its
`spawnConfig.specFor` sets `key: p.id` (a bare page id, never an encoded
agent key), which only worked because that module was never registered into
`RESOURCE_PROVIDERS` or any production loop.

This story's own module, `src/rules/confluence-page-type.ts`, is the real
one: real discovery (`AtlassianOps.getChildPages`, paginated to exhaustion),
real `encodeAgentKey`-based identity, and real spawn config. `confluence-page.ts`
itself is UNCHANGED by this story and keeps serving the standalone-page event
path it was built for (a page with no owning Jira ticket, reached through no
ancestor rule) — the two modules coexist; a page can in principle be watched
through BOTH paths at once (as someone's rule's child, and as a FACTORY-997
standalone target), and nothing here changes that.

## Query syntax

```json
{ "ancestor": "123456" }
```

| field | required | meaning |
|---|---|---|
| `ancestor` | yes | A bare numeric Confluence page id (`ConfluencePageRef`'s own canonical form, `src/resources/confluence-page-ref.ts`) — the page whose DIRECT children this rule watches. No URL, no `{space, pageId}` pair: a rule's query uses the same spelling a resource id under it will take. |

A bad query (invalid JSON, an unknown field, a non-numeric/URL-shaped
`ancestor`) is rejected at rule-load time with the problem named, same style
as every other provider (`confluencePageQueryProblems`,
`src/resources/confluence-page-query.ts`). The ancestor's own existence and
readability are deliberately NOT checked here — that is a discovery-time
fact (see "Safety" below), not a load-time one.

## Resource identity

A matched child page's id is its OWN bare numeric Confluence page id — the
SAME canonical form `ConfluencePageRef`/`isConfluencePageRef`/
`formatConfluencePageRef` (`src/resources/confluence-page-ref.ts`) already
define, and the same shape `isConfluencePageResourceId`
(`src/resources/id.ts`, FACTORY-996) already assumes for a managed-session
agent's own `x-issue`. This provider never invents a second spelling: the
rule's own `ancestor` and a matched child's resource id are both bare
numeric page ids, just naming different pages.

## Discovery, and what "matches" means

Each poll, for every enabled `confluence-page` rule
(`searchConfluencePageRules`, `src/rules/confluence-page-type.ts`):

1. Page through `AtlassianOps.getChildPages(ancestor, cursor)` to EXHAUSTION
   — every cursor, never just the first page — collecting the ancestor's
   full current direct-child list. Crossing `MAX_CHILD_PAGES` (5,000)
   rejects the WHOLE rule's poll, never a silently truncated list (the same
   "a partial result must never read as a smaller true set" discipline
   `filesystem`'s own `MAX_RESULTS` already applies).
2. One batched `getPageVersions(ids)` call across every child id found.
3. One `getPageComments(id)` call PER child — never batched (that op's own
   doc comment on `AtlassianOps` names a MEASURED trap: a batch-shaped
   footer-comments request silently returns the wrong pages' comments).

Call count per tick is therefore `2 + N` Confluence API calls for one rule
with `N` current children (one or more `getChildPages` pages, one batched
`getPageVersions`, `N` individual `getPageComments`) — linear in the number
of children, same shape FACTORY-997's own event path documents for its
`1 + N`.

A child whose version is missing from `getPageVersions`'s response (deleted,
or otherwise unreadable this tick), or whose `getPageComments` call throws,
is DROPPED from that tick's result for that rule — never a sentinel, never
failing the whole rule's poll.

## Change events — reusing `diffConfluencePage`

**Swarm** (the default execution mode): a child page entering or leaving the
ancestor's children is NOT itself a notification — the generic reconciler
(`runResourceLoop`, `src/daemon/loop.ts`) spawns an agent the moment a new
child id appears in discovery's result and stops it the moment the id stops
appearing, the same "appear/disappear needs no dedicated event" discipline
every simple swarm provider already follows (confirmed against
`src/rules/resource-type.ts`'s running-minus-desired reconciliation — no
special-casing needed here for a removed child page to drop its agent). A
child that STAYS matched across two polls is diffed with
`diffConfluencePage` exactly as FACTORY-997's own event path diffs a
standalone page: a version bump reports `{confluencePageEdit: {from, to}}`;
a footer-comment id SET that gained members (never one that only shrank)
reports `{confluencePageComment: {ids}}`; the two are mutually exclusive
within one poll (version checked first).

**Singleton/persistent**: the rule's one query agent additionally sees
`{appeared: true}`/`{disappeared: true}` for a child page entering/leaving
its scope — the same BUTCHR-398 "create/modify/remove delivered to
singleton/persistent agents" requirement `filesystem-type.ts`'s own
`unionDiff` implements, reusing `diffConfluencePage` for the "stayed
matched but changed" case exactly as the swarm path does.

A `confluence-page` agent is nudged with `confluencePageNudge`
(`src/agents/change-nudge.ts`): no page-authored text in the push, naming
`get_my_confluence_page` as the tool to re-read with.

## Activation

A matched child page is always `"active"` — this provider has no notion of
rest (same as `filesystem`/`github-issue`).

## Brief mechanism — a deliberate decision, not a silent default

The epic's own gloss says "the child page's text becomes the agent's
brief." FACTORY-991/995's spike (see FACTORY-995, comment 33373) found that
is NOT what any existing provider actually does: `filesystem`'s "brief" is
ALWAYS `rule.brief` — the rule author's own fixed text — never the matched
resource's own content.

**Decision: follow that precedent exactly.** `specForConfluencePage`
(`src/rules/confluence-page-type.ts`) sets `brief: rule.brief`, never the
child page's rendered body. An agent that needs its own page's content
reads it with `get_my_confluence_page` (FACTORY-993/996,
`src/tools/defs.ts`) — a tool call, resolved server-side from the caller's
own `x-issue`, not a brief substitution.

Why (b) over (a) — inlining the page's content as the brief:

- Consistency: no other provider inlines a resource's own content into the
  spawn brief (`jira-work`'s brief is the rule's own text; an issue's
  description/comments are read via tools, not pushed into `brief`).
  `confluence-page` special-casing the spawn path would be the one provider
  that behaves differently for no structural reason.
- `get_my_confluence_page`/`get_my_confluence_page_comments` were built by
  FACTORY-993/996 SPECIFICALLY to serve this need — using them is not a
  workaround, it is the intended read path.
- Inlining raw page content into a brief widens the injection surface at
  spawn time, before any of the runtime bounded-read/size-cap protections
  `get_my_confluence_page` already has (see "Agent safety" in this story's
  own PR description) apply.

## Safety

- **Read-only discovery.** The provider's own I/O is
  `getChildPages`/`getPageVersions`/`getPageComments` — reads only; nothing
  in discovery ever writes to Confluence. An agent working a child page may
  of course edit it with its own tools; the PROVIDER itself never does.
- **No new credential, no new auth surface.** Every real call goes through
  the SAME `AtlassianOps` instance (`src/daemon/index.ts`'s `ops`) every
  other Confluence/Jira read path in this daemon already uses.
- **A missing/unreadable ancestor, or either safety cap crossed
  (`MAX_CHILD_PAGES`), fails the WHOLE rule's poll** — never a partial
  child list, which would read as "those pages' agents stopped existing"
  and wrongly stop healthy agents.
- **A single child's unreadable version/comments is dropped, not fatal** —
  costs only that one page for that one tick; the rule's poll otherwise
  succeeds normally.
- **Page content is never pushed into a prompt by the provider itself** —
  see "Brief mechanism" above; a page's own text (and any footer comment
  text) reaches an agent only through a deliberate tool call
  (`get_my_confluence_page`/`get_my_confluence_page_comments`), both of
  which are bounded, caller-controllable range reads with a size cap — see
  that tool's own doc comment (`src/tools/defs.ts`) and this story's PR
  description's "Agent safety" section for the full writeup.
