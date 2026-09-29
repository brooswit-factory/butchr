# `GET`/`POST /resources/for-url` — URL → resource resolution + agent lookup

FACTORY-339 (implementing FACTORY-335, epic FACTORY-330 — "Clevr", a Chrome
extension that slides a Claude terminal in for a page IF Butchr is running an
agent on it, with a dropdown when several agents serve it). This endpoint is
the Butchr-side answer to "does this URL match a resource, and which agents
serve it?".

FACTORY-464/FACTORY-465 (a deliberate, operator-decided security-posture
change) dropped the bearer-token requirement this endpoint originally had —
see "Security tradeoff" below before assuming the `Authorization` header
still does anything here. It doesn't; this route is now gated on the
`Origin` allowlist alone.

FACTORY-478/FACTORY-480: a real MV3 extension service worker's GET carries
NO `Origin` header at all (Chrome only stamps `Origin` on a POST from that
context — measured against headless Chrome for Testing 148 with a real
built `clevr` extension; see FACTORY-478's comments for the full
measurement). The strict Origin-required guard below therefore 403s
`GET /resources/for-url` on every real Clevr install, and no
`BUTCHR_EXTENSION_ORIGINS` entry can fix that — it's not a config problem.
**Clevr's own client now uses `POST /resources/for-url` (URL in the JSON
body) instead**, because that's the request shape Chrome does stamp with
`Origin` from a service worker. `GET` is KEPT, unchanged, for any other
caller that can present a real `Origin` header itself (e.g. `curl -H
"Origin: chrome-extension://<id>"`) — it still requires a present
allowlisted Origin, exactly as before; it was not removed because nothing
about the fix requires removing it, and doing so would be a needless
behavior change for such a caller. Do not add a variant that accepts an
absent Origin on either method — see "Security tradeoff" below for why that
line is never to be crossed on this route.

## Contract

```
POST /resources/for-url
Origin: chrome-extension://<id>   (REQUIRED — see Security tradeoff below)
Content-Type: application/json

{"url": "<browser URL, plain, not percent-encoded>"}
```

```
GET /resources/for-url?url=<percent-encoded browser URL>
Origin: chrome-extension://<id>   (REQUIRED — see Security tradeoff below;
                                   NOTE: a real MV3 service-worker GET never
                                   carries this — see above — so this form
                                   is unreachable from Clevr's own extension
                                   context and exists for other callers only)
```

Both forms answer with the same response shape (both `resource` and
`agents` are ALWAYS present, never omitted):

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
| `BUTCHR_EXTENSION_ORIGINS` | optional | comma-separated `chrome-extension://<id>` origins allowed to reach it. **UNSET defaults to `chrome-extension://geffpgminecanhmpafbliajpeleoocan` alone** — Clevr's fixed extension id (FACTORY-475/FACTORY-477; see the `clevr` repo's README, "Fixed extension id"), so a fresh Clevr install needs no daemon-side config. A non-empty explicit value is ADDITIVE (it adds to that default, not replacing it); an explicitly EMPTY value fails closed to no origins at all — the endpoint is DISABLED (403 on every request), losing even the default. A request whose `Origin` header is absent, or present but not in the resulting list, is refused (403). |

Parsed once in `src/config/config.ts` into `Config.extensionAuth` and
consumed by the reusable guard in `src/web/origin-guard.ts`
(`checkExtensionOrigin`/`preflightExtensionOrigin`) — built as a standalone
mechanism, not wired into this one route, because `GET /agents/:agentKey/pty`
(FACTORY-453) reuses the exact same guard. CORS response headers
(`Access-Control-Allow-Origin`, `Vary: Origin`) are emitted ONLY for an
allowlisted origin and are NEVER `*`. `OPTIONS /resources/for-url` answers
the CORS preflight the same way, advertising both `GET` and `POST` in
`Access-Control-Allow-Methods` and `content-type` in
`Access-Control-Allow-Headers` (FACTORY-480: the JSON-body POST is a
non-simple request, so the browser preflights it, and blocks the real POST
afterward unless the preflight response says `content-type` is allowed).

`/health`, `/state`, `/dashboard`, and `/agents` are unaffected — they stay
exactly as unauthenticated as before this change.

## Security tradeoff (FACTORY-464/FACTORY-465)

This endpoint used to require a shared bearer token (`BUTCHR_EXTENSION_TOKEN`)
in addition to the Origin allowlist. That requirement is GONE: the operator
weighed the tradeoff and chose to drop it — "one should just be able to
start Clevr and work if butchr is there." The daemon binds loopback-only
(`src/daemon/listen.ts`), and on a single-user local box, the operator judged
an Origin-allowlist-only check sufficient.

**What this does and does not protect against.** `Origin` is enforced by the
browser, so this still stops another website open in a browser tab from
reaching this endpoint. **It does NOT stop any other local process** — a
script, another user on the same box, `curl` — from setting
`Origin: chrome-extension://<allowlisted-id>` by hand; nothing here can tell
that apart from the real extension. This is accepted as reasonable for a
single-user local box, not overlooked.

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
- `src/web/origin-guard.ts` — the reusable Origin-allowlist guard.
- `src/web/view.ts` — route wiring (`GET`/`OPTIONS /resources/for-url`).
- `src/config/config.ts` — `BUTCHR_EXTENSION_ORIGINS` parsing.
