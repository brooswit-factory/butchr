/**
 * external-poll.ts — BUTCHR-437 (epic BUTCHR-421, story 3/4): the three
 * lightweight pollers this story adds — Confluence page, GitHub issue/PR,
 * and general webpage. Jira-kind links stay `linked-eventing.ts`'s own job
 * (BUTCHR-436, story 2), untouched by this module. Each poller answers ONE
 * question for ONE already-discovered target (`LinkedItem`, see
 * src/resources/linked-discovery.ts): "does this target's current
 * fingerprint differ from the fingerprint linked-eventing.ts has on file for
 * it?" — nothing here knows about an OWNING resource, a baseline store, the
 * rate cap, or delivery; `linked-eventing.ts` owns all of that, exactly as
 * it already does for Jira-kind targets.
 *
 * PollVerdict IS THE ONE SHAPE EVERY POLLER RETURNS, so `linked-eventing.ts`
 * can drive all three through one shared per-item switch, the same
 * discipline the existing Jira-kind loop already applies per item:
 * - `"ok"`: the target is readable; `fingerprint` is this poller's own
 *   opaque identity-of-current-state string (a Confluence version number as
 *   text, a GitHub ETag, or a webpage's ETag/Last-Modified/body-hash,
 *   distinguishably prefixed so a stored baseline can be read back into the
 *   right conditional-request header next tick — see `pollWebpage`). The
 *   CALLER compares this byte-for-byte against the stored baseline
 *   fingerprint to decide changed vs. unchanged (mirrors the
 *   status/summary/updated compare the Jira-kind loop already does with its
 *   own Snapshot) — a FIRST-sighting target (no baseline yet) also resolves
 *   `"ok"`; seeding is the caller's job, not this module's, same as the
 *   Jira-kind path's own `if (!before) { seed silently }`.
 * - `"not-modified"`: the SERVER ITSELF said so (HTTP 304 against a
 *   conditional GET) — a stronger, cheaper claim than "ok" with an
 *   unchanged fingerprint: no body was even transferred, no rate-limit unit
 *   spent (GitHub). The caller treats this exactly like "ok" with the SAME
 *   fingerprint as before.
 * - `"unreadable"`: 404/403, a DNS failure, an unsupported host/scheme, a
 *   redirect this poller refused to follow, or a URL this module cannot
 *   resolve to a fetchable identity at all (e.g. a Confluence `/wiki/...`
 *   URL with no `/pages/<id>/` segment). Carries `httpStatus` only when the
 *   poller actually got one back from the remote server — never fabricated
 *   for a DNS failure, an SSRF refusal, or a pre-fetch parse rejection,
 *   none of which have one.
 * - `"error"`: a TRANSIENT failure (5xx, timeout, network error, a response
 *   body over the size cap) — the caller must retry next tick, never report
 *   unreadable and never advance any state, mirroring this story's own
 *   Jira-kind precedent: a batched search failure must never read as "every
 *   link unreadable" (see linked-eventing.ts's own top comment, "SEARCH
 *   FAILURE SKIPS THE WHOLE TICK"). A response over the size cap is treated
 *   as transient rather than unreadable on purpose: hashing a TRUNCATED body
 *   would either wrongly report "unchanged" forever (a huge, slowly-growing
 *   log-shaped page) or flicker "changed" on every poll (a huge page whose
 *   first bytes are volatile) — neither is an honest "unreadable", and
 *   "error" is the one status this module never uses to seed OR advance any
 *   baseline, so a page that is merely large today and readable-sized
 *   tomorrow is not falsely reported as "no longer linked" or "unreadable".
 */
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { fnv1a } from "@brooswit/sundry";
import { ghHeaders, type FetchLike } from "../labels/pr.js";
import { parseGithubIssueRef } from "../resources/github-issue-ref.js";
import { pageIdFromUrl } from "../tools/docs.js";

export type PollVerdict =
  | { status: "ok"; fingerprint: string }
  | { status: "not-modified" }
  | { status: "unreadable"; httpStatus?: number }
  | { status: "error" };

// ---------------------------------------------------------------------------
// Confluence
// ---------------------------------------------------------------------------

export interface ConfluencePollDeps {
  /** `AtlassianClient#confluencePageVersion` — a genuinely separate REST call per distinct Confluence target per tick, never batched with any other target (this ticket's own "same call shape confluence_get_page/get_doc already use"). */
  getVersion: (pageId: string) => Promise<{ ok: true; version: number } | { ok: false; transient: false; httpStatus: number } | { ok: false; transient: true }>;
}

/** `url` is the FULL Confluence page URL `discoverLinkedItems` stored as the target (see `LinkedItem.target`'s own doc comment) — resolved to a page id via the SAME `pageIdFromUrl` `get_doc`'s own read path uses, so the two can never disagree on what counts as a Confluence page URL. */
export async function pollConfluencePage(url: string, deps: ConfluencePollDeps): Promise<PollVerdict> {
  const pageId = pageIdFromUrl(url);
  if (pageId === null) return { status: "unreadable" }; // not a `/pages/<id>/` URL — nothing to poll, no HTTP call made, so no status
  const r = await deps.getVersion(pageId);
  if (!r.ok) return r.transient ? { status: "error" } : { status: "unreadable", httpStatus: r.httpStatus };
  return { status: "ok", fingerprint: String(r.version) };
}

// ---------------------------------------------------------------------------
// GitHub issue / PR
// ---------------------------------------------------------------------------

export interface GithubConditionalDeps {
  fetchImpl: FetchLike;
  /** Omitted: an unauthenticated request — GitHub still serves public issues/PRs, at a much lower rate limit. Never sent to any host but api.github.com (this module builds that URL itself; nothing here takes a caller-supplied host). */
  token?: string;
}

const GITHUB_TIMEOUT_MS = 10_000;

/**
 * `item.target` is the canonical `owner/repo#number` `formatGithubIssueRef`
 * produces (see `LinkedItem.target`'s own doc comment) — the SAME identity a
 * linked GitHub issue/PR's own agent key already uses. `priorEtag` is sent
 * as `If-None-Match` when present, so an unchanged issue/PR costs GitHub
 * NO rate-limit unit (a 304 response does not count against the REST API
 * rate limit) — the entire reason this poller is conditional-GET-shaped
 * rather than a plain re-fetch-and-diff.
 */
export async function pollGithubLink(item: { kind: "github-issue" | "github-pr"; target: string }, priorEtag: string | null, deps: GithubConditionalDeps): Promise<PollVerdict> {
  const ref = parseGithubIssueRef(item.target);
  if (!ref) return { status: "unreadable" };
  const path = item.kind === "github-issue" ? "issues" : "pulls";
  const url = `https://api.github.com/repos/${ref.owner}/${ref.repo}/${path}/${ref.number}`;
  let res: Response;
  try {
    res = await deps.fetchImpl(url, {
      headers: { ...ghHeaders(deps.token), ...(priorEtag ? { "if-none-match": priorEtag } : {}) },
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
  } catch {
    return { status: "error" }; // network failure / timeout — transient
  }
  if (res.status === 304) { await drain(res); return { status: "not-modified" }; }
  if (res.status === 404 || res.status === 403) { await drain(res); return { status: "unreadable", httpStatus: res.status }; }
  if (!res.ok) { await drain(res); return { status: "error" }; } // 5xx and anything else non-2xx — transient
  const etag = res.headers.get("etag");
  await drain(res);
  // GitHub's issue/PR read endpoints always carry a strong ETag in practice; the
  // fallback below only matters if that ever stops being true, and degrades to
  // "cannot detect a further change" rather than throwing.
  return { status: "ok", fingerprint: etag ?? `no-etag:${res.headers.get("last-modified") ?? ""}` };
}

// ---------------------------------------------------------------------------
// General webpage
// ---------------------------------------------------------------------------

export interface WebpagePollDeps {
  fetchImpl: FetchLike;
  /**
   * Whether `hostname` resolves to a private/loopback/link-local address (or
   * is itself `localhost`) and must be refused rather than fetched — see
   * this module's own "PRIVATE/LOOPBACK ADDRESSES" section below for what
   * this does and does not protect against. Optional; omitted, the REAL
   * DNS-resolving check (`defaultIsBlockedHost`) runs. Tests inject a fake
   * so "SSRF guard fires" and "ordinary host proceeds" are both assertable
   * without a real DNS lookup.
   */
  isBlockedHost?: (hostname: string) => Promise<boolean>;
}

const WEBPAGE_TIMEOUT_MS = 10_000;
/** A page whose body exceeds this many bytes is never hashed — see this module's own top comment for why that resolves `"error"`, not `"unreadable"`. */
const WEBPAGE_MAX_BODY_BYTES = 1_000_000;
/** GitHub's own guidance for "stop following, something is wrong" — reused here for the same reason. */
const WEBPAGE_MAX_REDIRECTS = 5;

async function drain(res: Response): Promise<void> {
  await res.arrayBuffer().catch(() => undefined); // an unread body on a reused connection can otherwise stall a later request on some fetch implementations
}

function conditionalHeadersFor(fingerprint: string | undefined): Record<string, string> {
  if (!fingerprint) return {};
  if (fingerprint.startsWith("etag:")) return { "if-none-match": fingerprint.slice("etag:".length) };
  if (fingerprint.startsWith("lm:")) return { "if-modified-since": fingerprint.slice("lm:".length) };
  return {}; // a hash-only baseline has nothing Last-Modified/ETag-shaped to send — the server has never offered a validator for this page, so every tick is a full re-fetch, compared by hash after the fact
}

/**
 * Read `res`'s body up to `maxBytes`, or `null` if it would exceed the cap —
 * checked against `content-length` first (cheap, no bytes read when a
 * well-behaved server states its size up front) and enforced again while
 * streaming (a missing or LYING `content-length` must not defeat the cap).
 * The connection is cancelled, not merely abandoned, the moment the cap is
 * crossed — this function never buffers more than `maxBytes` + one chunk.
 */
async function readCapped(res: Response, maxBytes: number): Promise<Uint8Array | null> {
  const len = res.headers.get("content-length");
  if (len !== null && Number(len) > maxBytes) { await drain(res); return null; }
  if (!res.body) {
    const buf = await res.arrayBuffer();
    return buf.byteLength > maxBytes ? null : new Uint8Array(buf);
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) { await reader.cancel().catch(() => undefined); return null; }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.byteLength; }
  return out;
}

// PRIVATE/LOOPBACK ADDRESSES (ticket's own "state what you decided and why"):
// this poller fetches URLs found in Jira ticket description text — content a
// ticket author (not this daemon's operator) controls — so a webpage target
// naming an internal address is a real SSRF surface: the daemon's own
// network position, not the ticket author's, is what would reach it.
// DECISION: refuse by RESOLVED ADDRESS, not by hostname string alone — a
// hostname is resolved via DNS and the RESULT checked against the loopback
// (127.0.0.0/8, ::1), private (10/8, 172.16/12, 192.168/16), link-local
// (169.254.0.0/16 — includes the 169.254.169.254 cloud-metadata address —
// and fe80::/10), and "this network" (0.0.0.0/8) ranges, plus the literal
// hostname `localhost`. Applied to the INITIAL host and to every redirect
// hop's host (see `pollWebpage`) — a page that redirects to an internal
// address is refused exactly like one that starts there.
// STATED LIMITATION, NOT FIXED HERE: this is a resolve-then-check, not a
// resolve-and-PIN-to-that-address fetch — the actual `fetch()` call still
// re-resolves the hostname itself, so a DNS answer that changes between this
// check and the underlying connect (DNS rebinding) is not caught. Closing
// that gap needs connecting to a pinned IP while still presenting the
// original hostname for TLS/Host purposes, which plain `fetch()` cannot do
// without a custom dispatcher/agent — judged out of scope for this story's
// lightweight poller; flagged here and in the PR for whoever revisits it.
const PRIVATE_V4_RANGES: ReadonlyArray<readonly [string, string]> = [
  ["10.0.0.0", "10.255.255.255"],
  ["172.16.0.0", "172.31.255.255"],
  ["192.168.0.0", "192.168.255.255"],
  ["127.0.0.0", "127.255.255.255"],
  ["169.254.0.0", "169.254.255.255"],
  ["0.0.0.0", "0.255.255.255"],
];

function ipToInt(ip: string): number {
  return ip.split(".").reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0;
}

function isPrivateV4(address: string): boolean {
  const n = ipToInt(address);
  return PRIVATE_V4_RANGES.some(([lo, hi]) => n >= ipToInt(lo) && n <= ipToInt(hi));
}

function isPrivateV6(address: string): boolean {
  const lower = address.toLowerCase();
  return lower === "::1" || lower.startsWith("fe80:") || lower.startsWith("::ffff:127.");
}

/** The real DNS-resolving check `WebpagePollDeps.isBlockedHost` defaults to when a caller (production wiring) doesn't supply one. See this module's own "PRIVATE/LOOPBACK ADDRESSES" comment above for what this does and does not cover. */
export async function defaultIsBlockedHost(hostname: string): Promise<boolean> {
  const lower = hostname.toLowerCase();
  if (lower === "localhost" || lower.endsWith(".localhost")) return true;
  const literalFamily = isIP(hostname);
  if (literalFamily === 4) return isPrivateV4(hostname);
  if (literalFamily === 6) return isPrivateV6(hostname);
  try {
    const { address, family } = await dnsLookup(hostname);
    return family === 4 ? isPrivateV4(address) : isPrivateV6(address);
  } catch {
    return true; // unresolvable — fail closed rather than let a DNS error fall through to a real connect attempt
  }
}

/**
 * `item.target` is the webpage's own URL (already confirmed `http(s)` by
 * `classifyUrl`/`descriptionItems` at discovery time — re-checked here
 * defensively, never trusted blindly). `priorFingerprint` is this module's
 * own opaque, PREFIXED fingerprint (see `conditionalHeadersFor` above) —
 * `etag:<value>` or `lm:<value>` drive a real conditional GET; a
 * `hash:<value>` baseline (the server offered neither validator last time)
 * cannot, so that case re-fetches the full body and compares by hash.
 *
 * SECURITY, per this ticket: only `http`/`https` (checked on the initial URL
 * AND on every redirect hop — `redirect: "manual"`, followed by hand here,
 * up to `WEBPAGE_MAX_REDIRECTS` hops), a `WEBPAGE_TIMEOUT_MS` request
 * timeout, a `WEBPAGE_MAX_BODY_BYTES` response-size cap (`readCapped`
 * above), and NO credentials of any kind ever attached — this function takes
 * no token and sends no `authorization` header, unlike `pollGithubLink`
 * above and the Confluence path's `AtlassianClient`. See this module's own
 * "PRIVATE/LOOPBACK ADDRESSES" comment for the SSRF decision.
 */
export async function pollWebpage(item: { target: string }, priorFingerprint: string | undefined, deps: WebpagePollDeps): Promise<PollVerdict> {
  const isBlocked = deps.isBlockedHost ?? defaultIsBlockedHost;
  let current: URL;
  try { current = new URL(item.target); } catch { return { status: "unreadable" }; }
  if (current.protocol !== "http:" && current.protocol !== "https:") return { status: "unreadable" };

  for (let hop = 0; ; hop++) {
    if (hop > WEBPAGE_MAX_REDIRECTS) return { status: "unreadable" };
    if (await isBlocked(current.hostname)) return { status: "unreadable" };

    let res: Response;
    try {
      res = await deps.fetchImpl(current.toString(), {
        redirect: "manual",
        headers: hop === 0 ? conditionalHeadersFor(priorFingerprint) : {},
        signal: AbortSignal.timeout(WEBPAGE_TIMEOUT_MS),
      });
    } catch {
      return { status: "error" };
    }

    if (res.status === 304) { await drain(res); return { status: "not-modified" }; }
    if (res.status >= 300 && res.status < 400) {
      await drain(res);
      const location = res.headers.get("location");
      if (!location) return { status: "unreadable" };
      let next: URL;
      try { next = new URL(location, current); } catch { return { status: "unreadable" }; }
      if (next.protocol !== "http:" && next.protocol !== "https:") return { status: "unreadable" }; // refused, never followed
      current = next;
      continue;
    }
    if (res.status === 404 || res.status === 403) { await drain(res); return { status: "unreadable", httpStatus: res.status }; }
    if (!res.ok) { await drain(res); return { status: "error" }; }

    const etag = res.headers.get("etag");
    if (etag) { await drain(res); return { status: "ok", fingerprint: `etag:${etag}` }; }
    const lastModified = res.headers.get("last-modified");
    if (lastModified) { await drain(res); return { status: "ok", fingerprint: `lm:${lastModified}` }; }
    const body = await readCapped(res, WEBPAGE_MAX_BODY_BYTES);
    if (body === null) return { status: "error" }; // over the size cap — see this module's own top comment for why this is "error", not "unreadable"
    return { status: "ok", fingerprint: `hash:${fnv1a(Buffer.from(body).toString("latin1"))}` };
  }
}
