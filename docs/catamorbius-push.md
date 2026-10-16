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
an arbitrarily-reconfigured server. **Covers the connect phase too, not just
an already-live stream**: the watchdog is armed before `fetch` is even
called, so a gateway that accepts the TCP connection but never sends
response headers is treated as dead by the same rule and on the same
timer, not left to hang forever — a gap caught at review and closed before
this merged.

**Generation-tagged, so `stop()` immediately followed by `start()` never
races itself**: every `start()`/`stop()` bumps an internal generation
counter, and every async continuation of a connect attempt (after `fetch`
resolves, after each stream read, inside a scheduled reconnect) checks its
own captured generation against the current one before doing anything
further. Without this, `stop()` aborting an in-flight attempt's request
while `start()` immediately begins a new one raced: the OLD attempt's own
`catch` block would see the client as "running again" (because `start()`
had already flipped that flag) and schedule its own independent reconnect,
running two connect chains at once — a review-caught bug, fixed before this
merged, with its own regression test (`client.test.ts`: "stop() then a
fresh start() WHILE a connect attempt is still awaiting fetch").

**The generation check covers control flow, not shared mutable state on its
own — a second round of the same bug, also caught at review.** `armWatchdog`/
`clearWatchdog` first only gen-guarded at each CALL SITE (e.g. `if (myGen
!== generation) return;` before calling a plain `clearWatchdog()`), but
`watchdogHandle` itself is one variable for the whole client, and a stale
attempt's own `catch`/`finally` still ran its (ungated) `clearWatchdog()`
call — cancelling the timer a NEWER attempt had just armed, in exactly the
same `stop()`-then-`start()`-during-a-pending-connect scenario the first
round fixed. Fixed by moving the generation check INTO `armWatchdog`/
`clearWatchdog` themselves (taking `myGen`, no-op when stale), so a stale
continuation's clear/arm calls are unconditionally inert rather than
depending on every call site remembering to check first. The one exception
is the public `stop()`, which calls an unconditional `clearWatchdogRaw()` —
by the time it runs, `generation` has already moved past whatever it needs
to clear, so a gen-guarded call would wrongly no-op. Regression test:
`client.test.ts`: "stop() then start() during a pending fetch leaves the
NEW attempt's watchdog intact".

**Listener isolation**: every `onStateChange`/`onEvent`/`onResyncRequired`
listener call is wrapped so a throwing consumer can never unwind into this
module's own control flow. Before this was added, a throwing `onEvent`
listener propagated out through the SSE read loop's own `try`, which
treated it exactly like a network failure and reconnected — but `lastSeq`
had already advanced past the very event the listener failed on, so the
next resume silently skipped it. Isolating each listener call (swallow, the
same way a DOM `EventTarget` isolates one listener's throw from the
dispatching code and from its other listeners) means a broken consumer
loses only its own handling of one event, never the connection's own
delivery or cursor integrity.

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

## Limits of the client alone (task 1) — see below for what task 2 adds

- No mapping for `confluence-page`, `webpage`, `filesystem`, or
  `jira-project` — the gateway has no adapter for any of them, and task 2
  does not add one: these four stay polling-only, unconditionally, forever.
- Production end-to-end proof is not obtainable: no real GitHub or Jira
  webhooks are registered against the deployed gateway (public ingress is
  not built), so no real provider traffic flows through it. The evidence
  above (and task 2's own, below) is a scratch instance plus signed
  synthetic deliveries, not production traffic — a healthy connection is
  never proof that any provider's webhooks are actually registered and
  flowing.

---

# Push mode wired into linked-eventing (FACTORY-137, task 2/2)

Task 2 makes push a real, opt-in change-detection mode for butchr's
linked-resource watchers (`src/jira-watch/linked-eventing.ts`,
BUTCHR-436/437/469/FACTORY-9/53/71), with the existing polling path as a
transparent, always-present fallback. **Goal, restated from the ticket:** a
consumer of a `LinkedChangeEvent` cannot tell which mechanism produced it.
Butchr owns the one connection centrally (`src/catamorbius/
push-controller.ts`); agents never see it; no agent-facing MCP was added.

## Architecture: hint, then refetch (D1)

A Catamorbius notification never updates a baseline directly. It only marks
a **watch key** (`src/catamorbius/mapping.ts`'s normalized identity) dirty.
The target is then fetched through the SAME fetchers `runTick` already
uses, diffed against the SAME baseline, delivered through the SAME
coalescer/rate-cap/notify. **Why:** the gateway is not the authoritative
state source, webhook delivery can be delayed, duplicated, and reordered,
and a second webhook-payload-to-snapshot normalizer would drift from the
fetchers over time. With hint-then-refetch, duplicates and out-of-order
delivery are harmless by construction — the diff is idempotent regardless
of how many times, or in what order, a dirty mark arrives.

## The coverage predicate (D2)

A `(target, owner)` pair is **COVERED** iff ALL of:

1. The target maps to a watch key (`watchKeyForResource` — only
   `issuelink`/`parent`/`jira-key` items, normalized to a Jira watch key,
   and `github-issue`/`github-pr` items, ever do).
2. Its provider is **explicitly enabled** — `CATAMORBIUS_PROVIDERS`, values
   `jira`/`github`, **default empty**. **Why default empty, not "everything
   mappable":** a healthy SSE connection does not prove any provider's
   webhooks are actually registered and flowing. As of this writing, NO
   provider webhooks are registered against the deployed gateway at all —
   covering a target against a gateway receiving nothing would silently
   turn 15-60s polling into 10-minute (TTL) latency polling, a real
   regression dressed up as a feature. An operator enabling `jira` must also
   know a Jira webhook may be JQL-filtered server-side and so may not cover
   every watched issue — say so again in the RUNBOOK below.
3. The connection is **covering right now** — `state === "live"`, or
   `"reconnecting"` within the still-active grace window (D5).

A covered target is fetched in a pass only if it has no baseline yet (for
ANY of its owners), OR is dirty, OR its TTL has expired, OR a resync is
pending. **Otherwise it is skipped: no fetch at all.** This is the actual
savings D2 exists for — a Confluence/webpage/filesystem/`jira-project`
target (uncovered, always, no adapter exists) keeps polling at its existing
cadence completely unchanged; an uncovered `github`/`jira` target (provider
disabled, or the connection down) does too.

## The on-demand pass (D3)

Skipping saves API calls but adds no latency benefit on its own — a dirty
mark that only gates the NEXT SCHEDULED tick (15s/60s) is no faster than
just... polling. `LinkedEventingState.runDirtyPass()` closes that gap: it
re-runs the exact same fetch/diff/notify pipeline, restricted to whatever is
currently dirty or resync-pending, reusing the triggering `runTick` call's
own already-discovered items — **no fresh discovery** (no member search, no
remote-links call, no managed-link listing). `runTick` and `runDirtyPass`
are serialized against each other (a plain promise-chain mutex) so they can
never double-diff the same baselines.

`runDirtyPass` is itself debounced (D6, `CATAMORBIUS_DEBOUNCE_MS`, default
2000ms): every call within the window shares the one resulting pass's
promise, so a burst of N notifications becomes one fetch, not N.

## TTL authoritative refresh (D4)

`CATAMORBIUS_TTL_MS` (default 600000 — 10 minutes), plus optional
`CATAMORBIUS_TTL_JIRA_MS`/`CATAMORBIUS_TTL_GITHUB_MS` overrides. **Global
plus per-provider-type, never per-rule or per-subscription:** the Jira-kind
fetch is shared across every owner watching a target (one batched
`key in (...)` search), so a per-rule TTL has no coherent meaning for a
fetch that isn't owned by any one rule; subscriptions are internal and have
no operator-visible identity; provider type is the one axis on which
webhook reliability and API cost genuinely differ. TTL is evaluated **when a
pass runs**, so the true refresh period is the TTL rounded up to the next
pass that actually considers that target. A settled fetch (`ok`,
`not-modified`, or `unreadable` — never a transient error, never a failed
batch) resets the TTL clock. Malformed/non-positive values fail daemon
startup loudly; the validation floor is 1ms (a sanity floor against a
nonsensical value, not a performance opinion about how aggressive is "too
aggressive" for a deployment this code knows nothing about).

## Disconnect, grace, and resync (D5)

Owned by `src/catamorbius/push-controller.ts`, one layer above
linked-eventing:

- **`everLiveInProcess`**, tracked from the client's own `onStateChange` —
  deliberately broader than the client's own per-`start()`-call `everLive`,
  which resets on every `stop()`+`start()`. Never reset for the life of the
  controller.
- **Grace** (`CATAMORBIUS_GRACE_MS`, default 60000): after having been live,
  covered targets STAY covered while the client is `reconnecting`, for up to
  this long. If the client is still not live when grace expires, every
  covered target reverts to full polling until it is live again — one
  rate-limited WARNING per transition (`stats().degrades`), never per retry.
- **Before the first live connection, and while `unauthorized`/`unavailable`,
  targets are uncovered immediately — no grace.** A bad token or an
  unconfigured gateway does not get less bad by waiting.
- **Resync**: when the client becomes live again after having been live
  before (a genuine reconnection, not the very first connection this
  process makes), OR the client's own `onResyncRequired` fires
  (`cursor-dropped` or `seq-went-backwards`), every covered target is marked
  resync-pending. The next pass (regular or on-demand) force-fetches ALL of
  them, once, then returns to skipping. `resyncPending` is STICKY: it
  survives until a pass actually runs WHILE covering with no search
  failure — it is never consumed by a pass that ran while nothing was
  covered.

## Duplicates, ordering, bursts (D6)

Transport dedup (a bounded recent-CloudEvent-id set, plus a seq-monotonic
guard reset on every resync signal) lives in the push controller — a
best-effort optimization and counter (`stats().deduped`), not the
correctness guarantee. The correctness guarantee is D1's own idempotent
diff: even a dedup miss just costs one redundant, harmless fetch. The
trailing debounce (D3's own text above) is the "N notifications become one
fetch" mechanism.

## A change the stream missed (D7)

A genuine change found by a TTL- or resync-forced fetch of a target that
was NOT dirty at fetch start is delivered as the **exact same**
`LinkedChangeEvent`, with the exact same detail text, polling would have
produced. Provenance lives only in logs (one WARNING, rate-limited to once
per 60 seconds per instance, naming the provider kind, never payload
contents) and in a counter (`stats().streamMissed`) — never in the event
itself. This is also the operator's own signal, watched for in the RUNBOOK
below, that a provider's webhooks are not actually covering something they
should be.

## Persistence (D8) — none, unchanged from polling

Baselines are in-memory today (unchanged by this ticket), so a daemon
restart reseeds silently, exactly like polling always has. No cursor or TTL
timestamp is persisted. At daemon start the client connects live-only (no
resume cursor yet) — correctness across that boundary comes from ordering
(a target is registered as watched before its first fetch starts; see T2 in
the code), not from anything persisted.

## Config and enable (D9)

Off unless `CATAMORBIUS_URL` (task 1) is configured AND at least one
provider is named in `CATAMORBIUS_PROVIDERS`. See `.env.example` for every
knob and its default. **The token-file-read split** (this ticket's own
pre-start correction, item B1): `loadCatamorbiusConfig` (task 1) lets a
throwing `readFile` propagate raw, uncaught — it does NOT itself implement
"an unreadable token file disables the feature with one WARNING." That
split lives in `src/catamorbius/push-config.ts#loadCatamorbiusFullConfig`
instead, deliberately NOT inside the task-1 loader (whose own tests this
ticket's brief says not to weaken): only the `readFile` call ITSELF
throwing (the file doesn't exist, or isn't readable) is caught and
degrades. A missing `CATAMORBIUS_TOKEN_FILE` variable and an empty token
(after trim) are config MISTAKES, not read failures, and stay loud startup
failures — a judgment call made by this ticket's implementer, flagged for
the story to confirm.

One connection per daemon (`CatamorbiusPushController` is a singleton,
constructed once in `src/daemon/index.ts`); each `createLinkedEventingState()`
call site (the issue-tier rule loop, the `jira-project` loop, and the
managed-session loop — three today) registers itself with it as its own
consumer, because baselines — and therefore dirty/TTL/resync state — are
per INSTANCE. The client's own `start()` never blocks or throws into daemon
startup; only the synchronous config parse can fail startup (loudly, same
as every other misconfigured opted-in feature in this file). The daemon's
own `SIGTERM`/`SIGINT` handlers call `stop()` — this daemon had no existing
graceful-shutdown hook to attach to before this ticket; a new, minimal one
was added, scoped to exactly this concern.

## Stats — two levels, deliberately

`CatamorbiusPushController.stats()`: `notificationsReceived`, `unmapped`,
`deduped`, `degrades`, `resyncs` — connection/stream-level facts, true once
for the whole daemon. Each `LinkedEventingState.stats()`: `dirtyMarks`,
`onDemandPasses`, `ttlRefreshes`, `streamMissed` — per-instance facts, since
baselines (and therefore what counts as "dirty" or "due for a TTL refresh")
are per instance. Not a single combined accessor: the two live at genuinely
different scopes, and folding them into one shape would either duplicate
the connection-level counters three times (once per instance) or force one
arbitrary instance to "own" them.

## RUNBOOK: enabling push mode on a live daemon

**This ticket does not perform this step on any live daemon — an operator
does, deliberately, after reading this.**

**Prerequisites — verify ALL of these before setting `CATAMORBIUS_PROVIDERS`:**

1. Real provider webhooks are registered against your deployed Catamorbius
   gateway, for EVERY provider you are about to enable, and cover EVERY
   Jira project / GitHub repo this daemon watches. A Jira webhook may be
   JQL-filtered — if yours is, it may not cover every watched issue; verify
   the filter, not just that a webhook exists.
2. The gateway is reachable from this daemon (`CATAMORBIUS_URL` correct;
   `probe()`/`GET /healthz` succeeds).
3. The token file (`CATAMORBIUS_TOKEN_FILE`) is readable by the daemon's own
   Unix account.

**A healthy connection does not prove events are flowing.** `state: "live"`
only means the SSE stream is open — it says nothing about whether any
provider is actually delivering webhooks into it. The one thing that
actually tells you push is doing its job is the ABSENCE of the D7 warning
below over time.

**Enable:** set `CATAMORBIUS_PROVIDERS` (e.g. `jira,github`) and restart the
daemon. Watch startup logs for `[catamorbius] push mode enabled: providers=...`.

**Verify:** watch for `WARNING: [catamorbius] the event stream missed a
change (...)` — this is the detector. Frequent occurrences for a provider
you just enabled mean its webhooks are not actually covering what you think
they cover; investigate the webhook registration/filter before trusting
push for that provider. Its absence over a reasonable observation window
(long enough to see several real changes go through) is the closest thing
to positive confirmation this design offers.

**Roll back:** clear `CATAMORBIUS_PROVIDERS` (or `CATAMORBIUS_URL` itself)
and restart. Every covered target reverts to full polling identically to
how it behaved before push mode was ever enabled — nothing about the
polling path itself was changed by this ticket.

## AC5: end-to-end evidence gathered for task 2

`scripts/verify-catamorbius-push-e2e.ts` is the AC5 script: it skips
(exit 0, no assertions) unless `CATAMORBIUS_SCRATCH_DIR` points at a
checkout/worktree of `brooswit-factory/catamorbius` (see "Standing up a
scratch gateway" above for how to create one); it then starts and stops
its OWN gateway process on a random port with freshly generated
tokens/secrets — never the deployed gateway — and drives the REAL client
(task 1) + the REAL `CatamorbiusPushController` + a REAL
`LinkedEventingState`, with a fake `search`/`notify` pair standing in for
Jira, through the six AC5 points. Run it with:

```sh
CATAMORBIUS_SCRATCH_DIR=/path/to/catamorbius/worktree \
  bun run scripts/verify-catamorbius-push-e2e.ts
```

Transcript from a real run against a scratch instance built exactly as
described above (catamorbius commit `6788ed3`, the tip of its `main` at
the time this evidence was gathered — re-verify at your own checkout):

1. **Baseline established.** First `runTick` performed exactly 1 search
   call (the batched `key in (...)` fetch) and produced 0 notifies — D1's
   "first sighting seeds silently."
2. **A signed webhook produces one notify within debounce + fetch time.**
   A signed `POST /webhooks/jira` for the watched target (with its status
   changed in the fake fetcher's backing world) produced exactly one
   notify **256ms** after the POST (`debounceMs: 200` plus client
   delivery + fetch time), carrying the SAME `LinkedChangeEvent` shape
   polling produces: `{"target":"KAN-5","kind":"issuelink","detail":
   "status changed from \"To Do\" to \"In Progress\""}`.
3. **Duplicates and reconnect-redelivery produce no second notify.** The
   identical delivery (same body, same `x-atlassian-webhook-identifier`)
   posted twice produced 0 additional notifies (gateway-side `(source,
   id)` dedupe — no second row, nothing new to deliver). A `stop()` +
   `start()` reconnect (forcing the D5 "live again" resync pass) also
   produced 0 notifies, since nothing had actually changed since the
   resync.
4. **Killing the gateway degrades to polling after the grace period.**
   Killing the scratch gateway process flipped `coverage.isCoveringNow()`
   to `false` within the 3000ms grace window. The next two simulated
   regular ticks each performed exactly 1 search call (2 total) — plain,
   unconditional per-tick polling, unchanged from pre-FACTORY-137
   behaviour.
5. **Restart on the same database file: resume, one resync, then
   skipping resumes.** Restarting the gateway process against the SAME
   sqlite file brought the client back to `live`; the D5 "live again"
   forced-resync pass ran once. A subsequent regular tick on the
   still-clean target performed 0 additional fetches — skipping had
   resumed.
6. **A change made with no delivery is found by the TTL refresh (D7).**
   The fake fetcher's backing world was changed with NO webhook sent
   (simulating a missed delivery). After the 2000ms TTL elapsed, the next
   tick fetched and emitted the SAME event shape polling would
   (`{"target":"KAN-5","kind":"issuelink","detail":"status changed from
   \"In Progress\" to \"Done\""}`), logged exactly one rate-limited
   WARNING (`the event stream missed a change (issuelink, provider
   jira) — found by a TTL/resync refresh instead`), and incremented
   `stats().streamMissed` to 1. Final counters for the run:
   `{"dirtyMarks":2,"onDemandPasses":4,"ttlRefreshes":1,"streamMissed":1}`.

No divergence between the documented D1-D9 behaviour and what was
actually observed was found during this run.

## Limits — what task 2 deliberately does not do

- Does not change any owner's PRIMARY polling cadence or mechanism.
- Does not add push coverage for `jira-project` as a link TARGET, project-
  member discovery, or Confluence/webpage/filesystem — all four stay
  polling-only, unconditionally (task 1's own limit, restated: the gateway
  has no adapter for any of them).
- No production end-to-end proof exists (see task 1's own limits section
  above) — the evidence for this task is a scratch gateway plus signed
  synthetic deliveries (a script/opt-in test, skipped when no scratch
  gateway checkout is configured), never presented as production proof.
- Does not edit any live daemon config, environment, or systemd unit —
  enabling this on a real deployment is the operator's own step, per the
  RUNBOOK above.
