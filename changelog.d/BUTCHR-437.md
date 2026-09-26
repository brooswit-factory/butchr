bump: minor

### Added

- **Confluence page, GitHub issue/PR, and general-webpage linked-change
  eventing is now live for `jira-work` rules with `linkedEventing: true` AND
  the new `linkedDescriptionLinks: true` (BUTCHR-437, epic BUTCHR-421, story
  3/4).** Extends BUTCHR-436's coalesced, rate-capped nudge to three more
  link kinds found via description-text parsing (`descriptionItems`,
  `src/resources/linked-discovery.ts`) — a Confluence page URL, a GitHub
  issue/PR URL, or any other `http(s)` webpage URL. Every changed/unreadable/
  removed link for one owning resource in one poll tick — Jira-kind and
  these three kinds together — still produces exactly ONE coalesced
  `deps.notify` call; `maxLinkedItems` and `maxLinkedTurnsPerHour` apply
  uniformly across every kind, not per-kind. New module
  `src/jira-watch/external-poll.ts`:
  - **Confluence:** one `GET /wiki/api/v2/pages/{id}` per distinct target
    per tick (`AtlassianClient#confluencePageVersion`, same call shape
    `get_doc`/`confluence_get_page` already use, no page body fetched),
    comparing `version.number` to the last-seen value.
  - **GitHub issue/PR:** a conditional GET (`If-None-Match`) against the
    REST API per distinct target per tick — a 304 costs GitHub no
    rate-limit unit. The per-(owner,target) baseline story 2 already keeps
    now also stores the ETag for these kinds (one shared, widened store —
    no second baseline table).
  - **Webpage:** a conditional GET using `ETag`/`Last-Modified` when the
    server offers them, falling back to a body-hash compare
    (`@brooswit/sundry`'s `fnv1a`, the same hash-compare idea `watch()`
    already uses elsewhere in this codebase) when it offers neither. Only
    `http`/`https`, a 10s timeout, a 1MB response-size cap, at most 5
    redirect hops (refused, never followed, past that or to a non-`http(s)`
    scheme), and never any Jira/Confluence/GitHub credential attached.
    Refuses a target resolving to a loopback/private/link-local address
    (checked on the initial host and every redirect hop) as a partial SSRF
    mitigation — resolve-then-check, not resolve-and-pin, so a DNS-rebinding
    attacker is not covered; see the module's own top comment and this
    ticket's PR for the full reasoning.
- **New knob: `linkedDescriptionLinks` (boolean, default false).** Gates
  live polling of description-text-derived Confluence/GitHub-issue/
  GitHub-PR/webpage links specifically — as opposed to a Jira remote link,
  which stays out of scope for non-Jira targets (unchanged from story 2).
  Only meaningful when `linkedEventing` is also true. Absent/false: none of
  the three new pollers ever run, even for a resource whose description
  names such a link.
- **Unreadable now carries an HTTP status when one is available.** Jira's
  batched search still can't (BUTCHR-436's own documented limitation,
  unchanged); a Confluence/GitHub/webpage 404 or 403 now renders as
  `<link> (<kind>): unreadable (404)` — the shared `linkedChangeNudge`
  formatter (`src/agents/change-nudge.ts`) is unchanged; only the `detail`
  text these three kinds supply differs, so every existing Jira-kind
  assertion still passes unmodified.

### Not verified in a live daemon

Test suite and reviewer probes only, same disclosure story 2's doc already
carries — see the ticket's own Confluence doc for details.
