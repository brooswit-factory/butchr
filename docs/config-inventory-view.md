# Configurations view: `GET /configurations`

FACTORY-81 (story FACTORY-70, epic FACTORY-68) — the UI half of the
"dashboard shows every query-agent configuration, not just running agents"
epic. FACTORY-72/FACTORY-69 (story FACTORY-70's own dependency, epic
FACTORY-68) shipped the read-only data layer this view renders; see that
work's own Confluence doc, [Query-Agent Configuration Inventory — Shipped
Shape](https://wroosbit.atlassian.net/wiki/spaces/BROOSWITFACTORY/pages/44138548/Query-Agent+Configuration+Inventory+Shipped+Shape),
for the authoritative `QueryAgentInventory` response shape, the reason
vocabulary, and the no-secrets discipline this view inherits rather than
re-derives. Verify any code path or line number below against your own
checkout — this document does not repeat that shape, only how it is rendered.

## What this is

An additive, read-only "Configurations" view in the daemon's existing web
dashboard: every rule and managed-session definition the daemon has loaded,
whether or not it currently has a running agent — disabled rules, unstaffed
rules (with their real, computed reason), and archived/invalid session
definitions all included, never hidden.

## Endpoint

`GET /configurations` on the daemon's own HTTP port (same host/port as `/`,
`/dashboard`, `/config-inventory`, `/health` — trust your own workspace's
`ENVIRONMENT.md` for that host/port, never a value copied from someone
else's). Registered in `src/web/view.ts`'s `liveView()`. No auth (same
exposure as the existing `/` dashboard page). Auto-refreshes every 5s, same
convention as `/`.

This is a NEW route, separate from the pre-existing `GET /config-inventory`
(FACTORY-72), which continues to serve the raw `QueryAgentInventory` JSON
unchanged — `/configurations` is the human-readable render of that same
data, plus the cross-links described below.

## Module entry point

`src/web/config-inventory-page.ts` — main export `renderConfigInventory(result,
rows, opts): string`. Pure, synchronous, no I/O of its own — same discipline
as the pre-existing `src/web/dashboard-page.ts` (BUTCHR-339): every
time-dependent or fetched value is an input, so the render is unit-testable
directly against real `QueryAgentInventory`/`DashboardRow[]` shapes
(`test/unit/config-inventory-page.test.ts`).

- `result: {ok:true; inventory: QueryAgentInventory} | {ok:false; error:string}`
  — the caller's own attempt to read `/config-inventory`'s data, mirroring
  `ViewDeps.resourceLink`'s existing `{ok,...}` convention rather than
  throwing through this render function. `ok:false` renders a loud banner
  with **no tables at all** below it — an empty table there would read as
  "no configuration exists", which is never the right claim about a failed
  read (this is DoD requirement 4's "also make it visible when a fetch of
  `/config-inventory` itself fails").
- `rows: readonly DashboardRow[]` — the SAME poll-fed `/dashboard` snapshot
  the existing agent view already reads, passed in only for the cross-link
  matching below; never echoed back onto the page directly.
- `opts.agentCensusChecked: boolean` (FACTORY-132, required) — the SAME
  `DashboardResponse.checked` the `rows` above already came from. Drives the
  COULD NOT CHECK vs. "no running agent" choice in the cross-link area (see
  below); required rather than optional-with-a-default so a caller that
  forgets to wire it is a compile error, not a silent wrong "no running
  agent" while the census is actually unavailable.

The route itself (`src/web/view.ts`'s `GET /configurations`) does the actual
`await deps.configInventory()` call, wrapped in a `try`/`catch` so a rejected
promise (real disk I/O — see `query-agent-inventory.ts`'s own top comment for
why that I/O is unavoidable) becomes the `ok:false` case rather than a 500.

## Cross-links, both directions

`src/agents/config-inventory-links.ts` — small, pure, unit-testable functions
(`test/unit/config-inventory-links.test.ts`), reused by both render
directions rather than each inventing its own half of the match, per the
ticket's own "do the matching in a small, unit-testable pure function"
requirement:

- **Forward** (a config entry → its running agent row(s), used by
  `config-inventory-page.ts`): `agentRowsForRule(rule, rows)` matches a LIVE
  (`kind: "agent"`) row when `decodeAnyAgentKey(row.resourceKey)` yields the
  same `(resourceProvider, ruleId)` pair as the rule's own
  `(resourceProvider, id)` — the exact correlation identifier the FACTORY-72
  doc's own "Correlation identifier" section documents, never a second,
  invented format. `agentRowsForSessionDefinition(entry, rows)` matches a
  live row whose `resourceKey` equals the entry's own `agentKey` EXACTLY
  (not decoded-and-compared — an archived definition's `agentKey` is
  deliberately derived from the path it would be restored to, per
  BUTCHR-455).
- **Back** (a running agent row → its config entry, used by
  `dashboard-page.ts`'s additive back-link): `configAnchorForResourceKey(resourceKey)`
  computes the target anchor WITHOUT taking the inventory as an input at
  all — deliberately, so this back-link adds **no I/O** to `/`'s existing
  no-fetch-of-its-own request path. It tells a managed-session row apart
  from an ordinary filesystem-provider rule the same way `herd.ts`/
  `workspace.ts` already do elsewhere in this codebase: the reserved
  `MANAGED_SESSIONS_RULE_ID` sentinel (`resourceProvider === "filesystem" &&
  ruleId === "managed-sessions"`) — that id never appears in `rules.json`'s
  own loaded rules, so the check is airtight, not a guess.

Anchor ids: `ruleAnchorId(resourceProvider, ruleId)` and
`sessionAnchorId(agentKey)` are the `id` attributes a rule/session row
carries on `/configurations`; `agentRowAnchorId(resourceKey)` is the `id` an
agent row carries on `/`. All three are percent-encoded, `--`-joined tokens —
safe as both an HTML `id` and a URL fragment, with no `:`/`/`/`#` of their
own.

## The additive change to the existing agent view (`/`)

Per this ticket's own requirement 7, the ONLY change to the pre-existing
`renderDashboard`/`renderAgentRow` (`src/web/dashboard-page.ts`) is:

1. Each agent row's own `<div>` now carries `id="<agentRowAnchorId>"`.
2. Each agent row renders one additional link, `<a class="link"
   href="...">config</a>`, pointing at its own `configAnchorForResourceKey`
   anchor on `/configurations` (default `/configurations#<anchor>`,
   overridable via the new, OPTIONAL `RenderDashboardOpts.configLinkHref`
   — same pure-URL-builder pattern as the pre-existing
   `terminalLinkHref`/`resourceLinkHref`). Nothing renders when the
   resourceKey fails to decode at all (nothing in this daemon produces that
   today).
3. A withheld row gets no back-link — requirement 3 speaks of the "running
   agent row" specifically, and a withheld row's own `reason` field already
   names the admission cap.

Every pre-existing assertion in `test/unit/dashboard-page.test.ts` and
`test/unit/app.test.ts` (existing rows still render and attach the same way)
passes unmodified — the new tests are additive, in their own `describe`
blocks.

## No secrets

Same discipline as `query-agent-inventory.ts`'s own data layer, extended to
rendering: every field is read from a `RuleInventoryEntry`/
`SessionDefinitionInventoryEntry` **by name** — never `Object.keys`, never a
JSON dump of an entry — so a future, unexpected field (secret-shaped or not)
can never reach the page. `test/unit/config-inventory-page.test.ts` proves
this against an entry carrying a fake extra field with a secret-shaped
value.

## Known/could-not-check/not-applicable, restated for config data

Mirrors `dashboard-page.ts`'s own three-way split (see that module's header
comment), for config data rather than agent-status data:

- **KNOWN**: a real value — plain text, or (for a notable state like
  `DISABLED`/`INVALID`/`UNSTAFFED`) the `cnc` class for visual weight, still
  a known fact.
- **NOT APPLICABLE** (`na` class, an em-dash): an INVALID session
  definition's content fields (`vendor`, `tier`, `permissionMode`, …)
  structurally do not exist — never confused with a failed read.
- **No running agent** (`na` class): nothing failed; there is simply no row
  to link to, for a rule or session definition this poll — rendered ONLY
  while the agent census is available (see COULD NOT CHECK below for the
  case where it is not).
- **COULD NOT CHECK** (`cnc` class, the literal words "COULD NOT CHECK"):
  FACTORY-132 extends this idiom (previously only the whole-page
  fetch-failure banner) to per-row staffing and to the cross-link area.
  `QueryAgentInventory`'s per-rule `staffed` is `boolean | null` — `null`
  means the agent census itself is unavailable this poll (the SAME
  `DashboardResponse.checked === false` predicate `dashboard-page.ts`'s own
  `/` banner keys on), so this daemon genuinely cannot say whether the rule
  is staffed. A rule in this state renders its staffing cell as `COULD NOT
  CHECK: <reason>`, never `UNSTAFFED`. Independently, the cross-link area
  (`renderAgentLinks`, shared by rule rows and session-definition rows
  alike) renders `COULD NOT CHECK` instead of "no running agent" whenever it
  would otherwise show "no running agent" AND the census is unavailable — a
  row WITH a matching live row still links regardless of census state (see
  "stale carry-forward" below), and a row whose non-staffing is a config
  fact (disabled, or a provider-config reason) still says `UNSTAFFED: ...`
  in its staffing cell even while its own cross-link area independently
  reads `COULD NOT CHECK` — the two axes are independent. The flag reaches
  the render layer as `RenderConfigInventoryOpts.agentCensusChecked`
  (required, not optional-with-a-default), supplied by `GET /configurations`
  from the SAME `dashboard()` snapshot whose `.rows` it already passes, so
  the matches and the flag they depend on always come from one snapshot.

### A rule's OWN admission source, not just the agent census (FACTORY-136)

The COULD NOT CHECK idiom above closes the gap for the whole-fleet agent
census (`DashboardResponse.checked`) but, before FACTORY-136, left a second,
narrower gap open: each rule provider's `admission-cap withheld` reason
depends on that provider's OWN admission source (`admission.sources[]` on
`DashboardResponse`, `src/agents/dashboard.ts`) having reported THIS poll —
a source that is declined or has never reported keeps its PRIOR withheld
rows (or none, if it has never reported at all), so a rule whose one covering
source is down had no way to know whether a matched resource was currently
withheld, and fell through to the final "genuine zero" branch worded
`UNSTAFFED: no matching resources this poll` even though the true state was
unknown.

`ruleStaffingReason` (`src/agents/query-agent-inventory.ts`) closes this by
resolving each rule's own covering admission source via a verified,
total, 1:1 mapping (`RULE_ADMISSION_SOURCE` in that module — every
`ResourceProvider`'s own admission-source name, confirmed by reading every
`admissionController.admit(...)` call site in `src/daemon/index.ts`; the
one non-identity mapping is `jira-work` → `"issue"`). When that source's own
`census.checked === false` (declined OR never-reported) AND the rule has no
live agent and no withheld row (from ANY poll, including one carried
forward from an earlier successful report of that same source), the rule
reports `staffed: null` with a reason naming the unavailable source and its
own decline reason (`"census-threw"` / `"census-untrusted"` /
`"never-reported"`) — e.g. `COULD NOT CHECK: census unavailable: the "issue"
admission source covering this rule has not reported this poll
(never-reported), so an admission-cap withholding for this rule cannot
currently be ruled out`.

**Design decision (DoD requirement 3):** this is the SAME `staffed: null`
tri-state FACTORY-132 introduced for the agent census — not a distinct
fourth state, and NOT a second render flag. `renderStaffed`
(`src/web/config-inventory-page.ts`) already renders any `staffed === null`
as `COULD NOT CHECK: <reason>` regardless of which census produced it, so
this fix needed no change to that function, `RenderConfigInventoryOpts`, or
`GET /configurations`'s own wiring — only the reason TEXT distinguishes the
two causes. `RenderConfigInventoryOpts.agentCensusChecked` keeps its
existing, narrower meaning (`DashboardResponse.checked` — the agent census
only) and drives ONLY the cross-link area's COULD NOT CHECK vs. "no running
agent" choice, which is unaffected by this ticket: a rule's cross-link area
answers "is there a live agent row", a question the agent census alone
already answers regardless of admission-source state.

**Check order** (unchanged for every existing branch): disabled → provider
config reason → live agent → admission-cap withheld → agent census
unavailable (`!dashboardChecked`) → **this rule's own admission source
unavailable (NEW)** → genuine observed zero. The new check sits strictly
after the broader agent-census check and after the withheld-row check, so a
fully-down agent census is still reported as that broader unknown, and a
rule with an already-known live or withheld row (fresh or carried forward)
keeps that answer regardless of this poll's admission-source state. A rule
whose covering source reported this poll is completely unaffected — see
`test/unit/query-agent-inventory.test.ts`'s "FACTORY-136" describe block
(through a REAL `createDashboardFeed`/`createAdmissionController`, control
case included) and `test/unit/config-inventory-page.test.ts`'s own
FACTORY-136 render-level block.

### Stale carry-forward: "agent wins" is unaffected

If the agent census's most recent poll failed AFTER an earlier success, the
previous snapshot's rows are carried forward (stale, but still present) —
see `dashboard.ts`'s own `createDashboardFeed`. A rule or session definition
that still matches one of those stale rows renders exactly as if the census
were current: `staffed: true` and a working cross-link, never `COULD NOT
CHECK`. Only an EMPTY match list's meaning depends on census state. This is
deliberate, not a gap: a live (if possibly stale) row is itself a stronger
fact than the census flag, and the agents view (`/`) already labels such a
row STALE in its own right.

## Coping with an evolving inventory shape

Per this ticket's own note (FACTORY-74 may change managed-session `tier`'s
shape): `tier`/`vendor` are rendered as `String(value)`, never assumed to be
one of today's known enum values — an unexpected future shape renders as
whatever value is present rather than hard-failing.

## Known limit: two session definitions sharing an `agentKey`

An archived definition's `agentKey` is deliberately derived from the ACTIVE
path it would be restored to, not its current archive-directory path
(BUTCHR-455's own identity rule — see `query-agent-inventory.ts`'s top
comment). If an active definition and an archived one both resolve to the
same identity path (e.g. the same basename present in both the active and
archive directories at once — an unusual, but not rejected, on-disk state),
their two rows on this page render the SAME `id` (`sessionAnchorId`) and both
match the same running-agent row. Nothing crashes and nothing renders wrong
data, but the anchor is no longer unique, and the browser resolves `#<id>`
to whichever such row is first in document order. Not fixed here (raised as
non-blocking in this ticket's own review) — a future fix would suffix the
anchor for whichever of the two is `archived`, distinct from the correlation
`agentKey` itself, which must stay untouched for the freeze-state matching
to remain correct.
