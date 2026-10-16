# Catamorbius push: the SSE client foundation (FACTORY-134, story FACTORY-22)

FACTORY-134 (task 1 of 2 under story FACTORY-22, epic FACTORY-13) built the
foundation for butchr acting as a **client** of the
[Catamorbius](https://github.com/brooswit-factory/catamorbius) gateway:
webhook → CloudEvents → durable log → SSE. Three pieces only:

1. an SSE client (`src/catamorbius/client.ts`) — connection lifecycle,
   resume, liveness watchdog, reconnect backoff, and a reachability probe;
2. typed config parsing (`src/catamorbius/config.ts`);
3. identity mapping (`src/catamorbius/mapping.ts`) between butchr's watched
   resources and Catamorbius CloudEvents, built on the existing
   provider-capability model (FACTORY-10/`src/resources/capabilities.ts`),
   not a parallel table.

**Nothing in the daemon constructs or starts this client.** No wiring, no
behaviour change on any running system. Task 2 (FACTORY-137, shelved until
this merges) builds push mode into butchr's linked-resource watchers on top
of this API and is the first real caller — this document is what it builds
against.

## The wire contract this client is built against — VERIFIED, not assumed

Source: the gateway's own README ("SSE egress: GET /events" — Auth, Frame
format, Filters, Cursors & resume; "The event format contract"; its GitHub
and Jira subsections; "Configuration"; "Run locally") and its
`src/adapters`/`src/egress`, read at commit
`d147fbe292b721711300a9fac0c50e0e23b7163a` of `brooswit-factory/catamorbius`
— **re-verify at your own checkout**, this pin will go stale.

- `GET /events` is SSE with header auth: `Authorization: Bearer <token>`.
  Missing/wrong token → `401` with `WWW-Authenticate: Bearer`. No tokens
  configured server-side → `503`. A bad `Last-Event-ID`/`?from` cursor →
  `400`.
- First frame is `retry: 3000`. Event frames: `event: <type>`, `id: <seq>`,
  `data: <CloudEvent JSON>`, blank line. A heartbeat is the comment line
  `: heartbeat` every `CATAMORBIUS_HEARTBEAT_MS` (server-side, default
  `15000`) — **a client-side setting cannot know the true value**, only the
  documented default; see "Watchdog" below.
- Cursors: no cursor = live only; `Last-Event-ID: N` replays `seq > N` then
  live (wins over `?from`); `?from=N` is inclusive; `?from=earliest` replays
  everything. `seq` is strictly increasing on one connection, **not
  gapless** (a deduped delivery still reserves an autoincrement value).
- Filters (`type` prefix, `source` exact, `subject` exact, ANDed) exist
  server-side, but this client does not use a server-side `subject` filter —
  see mapping trap (a) below for why.
- `GET /healthz` is unauthenticated: `{"ok":true,"seq":<latest>}`.
- CloudEvent shape: `id`, `source` (`//github/<owner>`,
  `//jira/<site host>`), `type` (`com.github.<event>[.<action>]`,
  `com.atlassian.jira.<...>`), `subject`, `time`, `data.raw.body` (provider
  payload verbatim), `data.summary`. GitHub `subject`:
  `<repository.full_name>#<n>` when the payload has `pull_request.number` or
  `issue.number`; `<full_name>@<ref>` for a push; else the bare
  `repository.full_name`. Jira `subject`: `issue.key`, else `project.key`,
  else a sprint/version/board id, else absent.

**No divergence from the README was found** during this task's real-gateway
evidence gathering (see below) — every behaviour this client relies on
matched the documented contract exactly.

## No new runtime dependency

The README suggests the `eventsource` package for header support. This repo
had no existing streaming/SSE code, and the wire format is narrow (see
`sse-parser.ts`'s own header for exactly what it must survive). A small
parser over `fetch` is simpler than adapting a general `EventSource`
polyfill to inject an `Authorization` header and to carry this client's own
resume/backoff/watchdog semantics — logic a general polyfill's own
reconnect handling would fight or duplicate anyway.

## The client (`src/catamorbius/client.ts`)

Suggested surface (names are ours to choose; documented here since task 2
codes against it): `createCatamorbiusClient(opts)` returning
`{ start, stop, state, onStateChange, onEvent, onResyncRequired, lastSeq, probe }`.
The client never reads files — the token is passed in already resolved.

**States**: `idle` (never started, or stopped) → `connecting` (first attempt
this `start()` call) → `live` (200 response; events may or may not have
arrived yet) → `reconnecting` (a retry after having been live at least once
this `start()` call) → `unauthorized` (401, **terminal**: no further
attempts until `stop()`+`start()`) → `unavailable` (503, **terminal**, same
reason: a bad token or an unconfigured gateway does not get less bad by
retrying — "never hammer the gateway").

**Resync** (`onResyncRequired`), distinct from every state transition,
fires exactly two ways:
- `"cursor-dropped"` — the gateway returned `400` for our `Last-Event-ID`.
  The client drops the remembered cursor (no `Last-Event-ID` on the next
  attempt, so the gateway resumes live-only) and reconnects; this signal
  tells the caller (task 2) that "resume" alone hasn't recovered full
  continuity and an authoritative catch-up may be needed.
- `"seq-went-backwards"` — the first event delivered after a reconnect
  carries a `seq` lower than the cursor we resumed from (a gateway log
  reset). Checked once per connection, against the resume cursor only — the
  gateway already guarantees `seq` is strictly increasing within one
  connection, so a running per-event check would be redundant.

**Backoff**: exponential (`backoffBaseMs * 2^attempt`, capped at
`backoffCapMs`) with full jitter (`random() * delay`, uniformly distributed
in `[0, delay]` — spreads a reconnect storm across a fleet of clients rather
than herding them onto the same schedule), then floored at the most recent
`retry:` hint the gateway sent (never lower than what the server asked for).
`attempt` resets to 0 once a connection has been continuously live for
`STABLE_PERIOD_MS` (== `backoffCapMs`; not a separately tunable value per
this ticket's own config list — a connection that outlives the worst-case
backoff delay is treated as healthy).

**Watchdog**: no bytes at all (an event frame OR a heartbeat comment) within
`watchdogMs` means the connection is presumed dead: abort and reconnect.
Default `watchdogMs` is `45000` — **3x the gateway's documented default**
heartbeat interval (`CATAMORBIUS_HEARTBEAT_MS`, default `15000`). The true
server-side interval is not knowable to the client (it isn't on the wire
anywhere), so this is a margin against jitter/slow ticks against the
*documented default*, never a guarantee the multiplier is "enough" against
an arbitrarily-reconfigured server.

**Parsing robustness** (`sse-parser.ts`, exercised at the client level too):
frames split at arbitrary chunk boundaries including inside a multi-byte
UTF-8 character (a persistent `TextDecoder({stream:true})` per connection
absorbs this); CRLF or LF line endings; `data:` with or without the one
optional space; multi-line `data:` (joined with `\n`); comment lines
(`onComment`, never accumulated into a dispatched message); unknown fields
(ignored, forward-compatible); a stream that ends mid-frame (the
unterminated trailing record is dropped, **never delivered**).

**Injected, never global**: `fetch`, the clock (`now`), timers
(`setTimeout`/`clearTimeout`), and randomness (`random`) all come from
`CatamorbiusClientDeps` — no real timer, no real network call, and no real
`Math.random()` in this module's own tests.

**`stop()`**: aborts any in-flight request, cancels the stream reader, and
clears every pending timer (watchdog and reconnect backoff both) —
idempotent, and proven to leave nothing dangling (`client.test.ts`'s own
`stop()` suite advances a fake clock by a very large amount afterward and
asserts zero further fetch calls).

**Secret handling**: the bearer token is used only as the `Authorization`
header value on `GET /events` — never logged, never in a URL, never in any
`state`/`onResyncRequired`/`probe()` value. `probe()`'s own request to
`GET /healthz` carries no `Authorization` header at all (the endpoint is
documented unauthenticated).

## Config (`src/catamorbius/config.ts`)

Follows `../config/config.ts`'s own conventions: `readFile` injected for
testability, a `*_TOKEN_FILE`-style path (never a bare token in the
environment or argv, same convention as `ATLASSIAN_TOKEN_FILE`/
`GITHUB_TOKEN_FILE`), malformed values fail loudly once the feature is
opted in.

**Off unless `CATAMORBIUS_URL` is set** — the same "absent means disabled,
never a startup crash for unrelated config" contract `loadConfig`'s own
optional blocks (`github`/`rocketchat`) use.

| Variable | Meaning | Default |
| --- | --- | --- |
| `CATAMORBIUS_URL` | Gateway base URL. Unset = feature off. | — |
| `CATAMORBIUS_TOKEN_FILE` | Path to a file holding the bearer token, trimmed. Required once `CATAMORBIUS_URL` is set. | — |
| `CATAMORBIUS_WATCHDOG_MS` | Liveness watchdog window. | `45000` |
| `CATAMORBIUS_BACKOFF_BASE_MS` | Reconnect backoff starting point. | `1000` |
| `CATAMORBIUS_BACKOFF_CAP_MS` | Reconnect backoff ceiling. | `60000` |
| `CATAMORBIUS_PROBE_TIMEOUT_MS` | Timeout for `probe()`'s `GET /healthz` request. | `5000` |

Deliberately a **standalone module**, not a new field on `Config`/
`ConfigEnv`: nothing calls `loadCatamorbiusConfig` today, so its being
unconfigured or misconfigured cannot affect a running daemon. This is a
large part of how "no daemon wiring, no behaviour change" is guaranteed
rather than merely intended. Task 2 (FACTORY-137) wires it in.

## Identity mapping (`src/catamorbius/mapping.ts`)

Built on the `catamorbiusPush` capability (see
`docs/provider-capabilities.md`'s own section on it) — true exactly for
`jira-work-item`, `github-issue` and `github-pr`, the three providers the
gateway has an adapter for. Two pure, total, synchronous functions, zero I/O:

- `watchKeyForResource(resource)` — a watched resource (either the
  structured `{provider, ...}` shape or linked-eventing's own
  `{kind, target}` `LinkedItem` shape) → a normalized `WatchKey`, or `null`
  when unsupported/malformed.
- `watchKeysForEvent(event)` — a Catamorbius CloudEvent → zero or more watch
  keys it concerns, in the same normalization.

**Invariant** (exhaustively tested in `mapping.test.ts`): for every mappable
resource `R` and every gateway event about `R`, the watch key of `R` is
among the keys of the event — covering mixed-case GitHub repos, PR vs
issue, and Jira comment events with and without a top-level issue.

Normalized key format: `jira:<ISSUE-KEY>` (uppercase) or
`github:<owner>/<repo>#<number>` (lowercase owner/repo).

**Traps handled, each with its own test**:

- **(a) Case.** butchr canonicalizes GitHub refs to lowercase owner/repo.
  The gateway's `subject` carries GitHub's real casing (mixed-case
  orgs/repos are legal). `watchKeysForEvent` lower-cases what it parses out
  of `subject` before formatting the key, so a mixed-case resource and its
  mixed-case event agree. **This is exactly why no server-side `subject`
  filter is used** — an exact-match filter built from butchr's lower-cased
  ref would silently miss the gateway's real-cased subject. The client
  subscribes to one unfiltered (or type-prefix-filtered only) stream and
  this module matches client-side instead.
- **(b) Jira comments/worklogs.** The gateway's README documents that it
  does not know whether a `comment_*`/`worklog_*` payload carries a
  top-level `issue` object. When it does, `subject` is already the issue
  key. When it doesn't, `subject` falls back to a project/sprint/version/
  board id (or is absent), and this module ALSO checks
  `data.raw.body.issue.key` defensively — today's fixtures
  (`comment-created-without-issue.json` et al.) have neither, so that path
  yields `[]` (unmapped), same as the project-key-subject case. Unmapped is
  a normal, non-error outcome, never thrown.
- **(c) Issue vs PR.** A GitHub `subject` of `owner/repo#n` never says
  whether `n` is an issue or a pull request — they share one per-repo
  number counter. Rather than guess, a `github-issue` and a `github-pr`
  resource with the same owner/repo/number map to the IDENTICAL watch key,
  and an event's `owner/repo#n` subject always produces that same single
  key. A caller that must distinguish issue from PR needs a side channel
  this module deliberately does not provide — no such distinction exists on
  the wire.
- **(d) Push / repo-level events.** `owner/repo@ref` (push) and a bare
  `repository.full_name` subject (repo-level events) concern no watched
  issue or PR: `[]`, unmapped, never an error.
- **(e) Tenant scoping (`source`).** The gateway's `source` narrows the
  tenant, but this module does NOT check it against any configured
  site/org list: a pure mapping function has no config to check against,
  and `source` is a coarser, less reliable identity than what's already
  embedded in `subject`/the resource's own ref (narrowing on it risks false
  negatives, e.g. the GitHub `//github/unknown` fallback source). A caller
  that wants to filter by configured site/org can do so itself, one layer
  up, on the raw `event.source` this module leaves untouched.

## `catamorbiusPush` capability — what it means and does not mean

Declares that a mapping EXISTS in `mapping.ts` for a provider — **never**
that a Catamorbius gateway is configured or reachable. The capability table
is a static declaration with no I/O; reachability is a dynamic,
per-deployment fact carried entirely by the client's own `state`/`probe()`.
See `docs/provider-capabilities.md`'s own section for the full inventory row
and reasoning.

## Standing up a scratch gateway for real-gateway testing

**Never** read, copy, or depend on the deployed gateway's environment file,
and never connect to its `GET /events` or `POST` to it. `GET /healthz`
against the deployed service is read-only and safe. For everything else,
stand up your own scratch instance:

```sh
git -C ~/code/brooswit-factory/catamorbius worktree add /path/to/scratch/catamorbius <deployed-commit>
cd /path/to/scratch/catamorbius
bun install
HOST=127.0.0.1 PORT=<your own port> \
  CATAMORBIUS_DB=/path/to/scratch/db.sqlite \
  CATAMORBIUS_TOKENS=<randomly generated> \
  WEBHOOK_SECRET_GITHUB=<randomly generated> \
  WEBHOOK_SECRET_JIRA=<randomly generated> \
  bun run src/index.ts
```

Generate secrets at run time (e.g. `openssl rand -hex 16`) — never commit
or paste one anywhere. Sign a synthetic delivery with the exact shapes the
gateway's own README documents (they are NOT the same signature shape):

```sh
BODY='{"action":"opened","pull_request":{"number":42},"repository":{"full_name":"Acme/Widgets","owner":{"login":"Acme"}}}'
SIG="sha256=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET_GITHUB" | sed 's/^.* //')"
curl -X POST "http://127.0.0.1:<port>/webhooks/github" \
  -H "Content-Type: application/json" -H "X-GitHub-Event: pull_request" \
  -H "X-GitHub-Delivery: <uuid>" -H "X-Hub-Signature-256: $SIG" -d "$BODY"
```

```sh
BODY='{"webhookEvent":"comment_created","issue":{"key":"KAN-5"},"comment":{"id":"9001"}}'
SIG="$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET_JIRA" | sed 's/^.* //')"
curl -X POST "http://127.0.0.1:<port>/webhooks/jira" \
  -H "Content-Type: application/json" -H "X-Atlassian-Webhook-Identifier: <uuid>" \
  -H "X-Hub-Signature: sha256=$SIG" -d "$BODY"
```

Note the Jira signature header has **no `-256`** and prefixes the hex with
the HMAC method name (`sha256=<hex>`) — a different shape from GitHub's,
confirmed against the README and `src/adapters/jira.ts` while gathering this
task's evidence.

## Real-gateway evidence gathered for this task

Run against a scratch instance built exactly as above (commit
`d147fbe292b721711300a9fac0c50e0e23b7163a`), never the deployed gateway,
except for the read-only probe noted last:

1. **Live delivery and mapping.** Connected the real client, sent signed
   GitHub PR/issue deliveries (including a mixed-case owner/repo) and a
   Jira comment-with-issue delivery, and confirmed each event arrived with
   the documented `subject` shape and that `watchKeysForEvent` produced the
   expected normalized key (`github:acme/widgets#42`,
   `github:brooswit-factory/butchr#7`, `jira:KAN-5`).
2. **Kill + restart on the same database, resume.** Delivered two events,
   killed the scratch gateway, restarted it pointed at the SAME sqlite
   file, delivered two more. The client reconnected and resumed with
   `Last-Event-ID`; delivered seqs across the restart were `[13, 14, 15,
   16]` — no missing, no duplicate.
3. **Wrong token.** A deliberately wrong bearer token produced exactly one
   `GET /events` call over a 4-second window (state `unauthorized`,
   terminal) — no retry storm.
4. **Watchdog.** A scratch instance started with
   `CATAMORBIUS_HEARTBEAT_MS=600000` (so no heartbeat would arrive in the
   test window) and a client `watchdogMs` of `2000`: the client went
   `live` → `reconnecting` → `live` on its own liveness judgement alone,
   with no server-initiated close and no heartbeat received.
5. **`probe()` against the deployed gateway** (read-only `GET /healthz`
   only): `{ ok: true, seq: 66 }` — matches the documented contract exactly.

No divergence between the gateway's documented contract and its actual
behaviour was found during any of the above.

## Limits — what this task deliberately does not do

- No daemon wiring: nothing constructs or starts this client outside its
  own tests. Task 2 (FACTORY-137) does that.
- No mapping for `confluence-page`, `webpage`, `filesystem`, or
  `jira-project` — the gateway has no adapter for any of them.
- Production end-to-end proof is not obtainable: no real GitHub or Jira
  webhooks are registered against the deployed gateway (public ingress is
  not built), so no real provider traffic flows through it. The evidence
  above is a scratch instance plus signed synthetic deliveries, not
  production traffic.
- TTLs, dirty tracking, and fallback decisions for a caller that uses this
  client are task 2's responsibility, not this one's.
