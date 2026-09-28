# `GET /resources/for-url` — URL → resource resolution + agent lookup

FACTORY-339 (implementing FACTORY-335, epic FACTORY-330 — "Clevr", a Chrome
extension that slides a Claude terminal in for a page IF Butchr is running an
agent on it, with a dropdown when several agents serve it). This endpoint is
the Butchr-side answer to "does this URL match a resource, and which agents
serve it?".

## Contract

```
GET /resources/for-url?url=<percent-encoded browser URL>
Authorization: Bearer <BUTCHR_EXTENSION_TOKEN>
Origin: chrome-extension://<id>   (only when the caller IS an extension; optional otherwise)
```

Response, always exactly this shape (both `resource` and `agents` are
ALWAYS present, never omitted):

```jsonc
{
  "url": "<the url query param, exactly as given>",
  "canonicalUrl": "<the canonical form, or null if url isn't a valid http(s) URL>",
  "resource": { "provider": "jira-work", "id": "BUTCHR-12" } | null,
  "agents": [
    { "agentKey": "jira-work:triage:BUTCHR-12", "ruleId": "triage", "pane": "pane-1", "live": true, "label": "triage:BUTCHR-12" }
  ]
}
```

- `resource` is `null` whenever `url` doesn't name anything this daemon
  tracks — a normal outcome, never an error.
- `agents` is `[]` in TWO distinct cases: `resource` is `null`, AND
  `resource` resolved but nothing is currently staffed on it. A caller
  (Clevr) tells these apart ONLY by reading `resource` itself, never by
  `agents.length` alone — "not a Butchr resource" and "a Butchr resource
  with nothing running" must render differently.
- `agents` is sorted deterministically by `ruleId` — the dropdown's own
  render order must not depend on this daemon's internal row order.
- `label` is `<ruleId>:<resourceId>` — no title fetch, ever.
- `live: false` (with `pane: null`) means the admission cap is currently
  withholding this agent (BUTCHR-332) — matched and (at least intended to
  be) staffed, but nothing is actually running yet to attach a terminal to.

### URL → resource matching

At most one resource per URL, in this order (a canonical URL can only ever
match one host in the first place, so the order has no observable effect —
fixed here so a future reader doesn't have to wonder):

| URL shape | provider | id |
|---|---|---|
| `https://<this daemon's Jira site>/browse/<KEY>`, the new-UI `.../issues/<KEY>` form, or `...?selectedIssue=<KEY>` | `jira-work` | the issue key, case-folded uppercase |
| `https://github.com/<owner>/<repo>/issues/<n>` | `github-issue` | `<owner>/<repo>#<n>`, lowercased |
| `https://github.com/<owner>/<repo>/pull/<n>` | `github-pr` | `<owner>/<repo>#<n>`, lowercased |
| `https://<this daemon's ZENDESK_SUBDOMAIN>.zendesk.com/agent/tickets/<id>` | `zendesk-ticket` | `<subdomain>#<id>` |
| anything else | — | `resource: null` (normal, not an error) |

Strict host matching only — Jira is checked against THIS daemon's own
configured site, GitHub only against the literal host `github.com`, Zendesk
only against THIS daemon's own configured subdomain. A lookalike host
(`github.com.evil.example`, `evilgithub.com`), a userinfo trick
(`https://github.com@evil.example/...`), a non-`http(s)` scheme, or a URL
with embedded credentials all resolve to `resource: null` — see
`src/resources/url-to-resource.ts`'s own header for the full reasoning and
`src/resources/webpage-ref.ts` for the canonicalization these checks build
on (lower-cased host, default port and fragment stripped, query kept
byte-for-byte).

## Config

| env var | required | effect |
|---|---|---|
| `BUTCHR_EXTENSION_TOKEN` | to enable the endpoint | shared bearer token; **UNSET means the endpoint is DISABLED (503 on every request), never open**. Never generated, persisted, or logged by this daemon — an operator sets it themselves, out of band, exactly once. |
| `BUTCHR_EXTENSION_ORIGINS` | no | comma-separated `chrome-extension://<id>` origins allowed to read the response. A request whose `Origin` header is present and not in this list is refused (403) before its `Authorization` header is even inspected. |

Both are parsed once in `src/config/config.ts` into `Config.extensionAuth`
and consumed by the reusable guard in `src/web/bearer-origin-guard.ts`
(`checkBearerOrigin`/`preflightBearerOrigin`) — built as a standalone
mechanism, not wired into this one route, because the later Clevr
terminal-attach story reuses the exact same auth model. CORS response
headers (`Access-Control-Allow-Origin`, `Vary: Origin`) are emitted ONLY for
an allowlisted origin and are NEVER `*`. `OPTIONS /resources/for-url`
answers the CORS preflight the same way, without ever checking a bearer
token (browsers never send `Authorization` on a preflight).

`/health`, `/state`, `/dashboard`, and `/agents` are unaffected — they stay
exactly as unauthenticated as before this change.

## WHY THE STAFFED-AGENT REGISTRY, NOT A LIVE QUERY

**Do not "optimize" this into re-running each rule's query against the
URL's resource.** The daemon already runs every rule's query on its own
poll cadence and staffs one agent per matching resource
(`src/rules/*-type.ts`). A per-request Jira/GitHub/Zendesk call here would
be:

- **slow** — a live query adds a full round trip (or several) to every
  page load Clevr checks, on the critical path of a UI a person is staring
  at;
- **rate-limited** — by that provider, shared with every other thing this
  daemon does against the same credential;
- **wrong** — it would report matches this daemon isn't actually staffing
  (a rule that matches the resource but was never enabled, or a resource
  excluded by a project allowlist) — exactly the false positive this
  endpoint's whole consumer (Clevr's terminal-open dropdown) must never
  show. Offering a terminal for an agent that doesn't exist is worse than
  offering none.

Instead, `src/resources/resource-lookup.ts`'s `buildResourcesForUrlResponse`
reads the SAME `DashboardResponse.rows` snapshot `/dashboard` itself serves
— one poll-fed registry, zero extra I/O on this route's own request path.
`src/rules/agent-key.ts`'s `decodeAnyAgentKey` recovers
`(resourceProvider, ruleId, resourceId)` from each row's own `resourceKey`,
so a resource match here is, by construction, a resource this daemon has
ALREADY matched and (at least tried to) staff — never a hypothetical one a
fresh query might turn up.

## Files

- `src/resources/url-to-resource.ts` — pure, I/O-free URL → resource mapping.
- `src/resources/resource-lookup.ts` — joins that mapping to the staffed-agent registry; builds the response.
- `src/web/bearer-origin-guard.ts` — the reusable bearer-token + origin-allowlist guard.
- `src/web/view.ts` — route wiring (`GET`/`OPTIONS /resources/for-url`).
- `src/config/config.ts` — `BUTCHR_EXTENSION_TOKEN`/`BUTCHR_EXTENSION_ORIGINS` parsing.
