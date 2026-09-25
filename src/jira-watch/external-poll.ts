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

/**
 * Races `p` against a timer that REJECTS after `ms` — unlike `AbortSignal`,
 * this bounds a caller's WAIT even when `p` itself ignores the signal it was
 * given (a `fetchImpl` fake, or a real implementation with a bug), which is
 * exactly the failure mode PR #401's review round 1 flagged: "one bad link
 * must never stall polling of the rest" must hold IN TIME, not only in
 * eventual outcome. Every network-shaped await in this module goes through
 * this, not only the underlying `fetch`'s own `signal` option (still passed
 * where applicable, as a well-behaved-implementation fast path).
 */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

// ---------------------------------------------------------------------------
// Confluence
// ---------------------------------------------------------------------------

export interface ConfluencePollDeps {
  /** `AtlassianClient#confluencePageVersion` — a genuinely separate REST call per distinct Confluence target per tick, never batched with any other target (this ticket's own "same call shape confluence_get_page/get_doc already use"). */
  getVersion: (pageId: string) => Promise<{ ok: true; version: number } | { ok: false; transient: false; httpStatus: number } | { ok: false; transient: true }>;
  /** Overrides the default wait bound (`CONFLUENCE_TIMEOUT_MS`) below `getVersion` is raced against — see `withTimeout`'s own doc comment. Test-only knob; production wiring omits it. */
  timeoutMs?: number;
}

const CONFLUENCE_TIMEOUT_MS = 10_000;

/** `url` is the FULL Confluence page URL `discoverLinkedItems` stored as the target (see `LinkedItem.target`'s own doc comment) — resolved to a page id via the SAME `pageIdFromUrl` `get_doc`'s own read path uses, so the two can never disagree on what counts as a Confluence page URL. */
export async function pollConfluencePage(url: string, deps: ConfluencePollDeps): Promise<PollVerdict> {
  const pageId = pageIdFromUrl(url);
  if (pageId === null) return { status: "unreadable" }; // not a `/pages/<id>/` URL — nothing to poll, no HTTP call made, so no status
  let r: Awaited<ReturnType<ConfluencePollDeps["getVersion"]>>;
  try {
    r = await withTimeout(deps.getVersion(pageId), deps.timeoutMs ?? CONFLUENCE_TIMEOUT_MS);
  } catch {
    return { status: "error" }; // includes a `getVersion` that hangs past the deadline — transient, retried next tick
  }
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
  /** Overrides the default wait bound (`GITHUB_TIMEOUT_MS`) below the fetch is raced against — see `withTimeout`'s own doc comment. Test-only knob; production wiring omits it. */
  timeoutMs?: number;
}

const GITHUB_TIMEOUT_MS = 10_000;

/**
 * PR #401 review round 1: GitHub answers an EXHAUSTED primary/secondary rate
 * limit with HTTP 403 (never only 429) — carrying `x-ratelimit-remaining: 0`
 * and/or a `retry-after` header. Left undistinguished from an ordinary
 * access-denied 403, every fleet-wide rate-limit hit would render as a
 * TRANSITION into "unreadable" for every polled GitHub link at once (a false
 * "unreadable" storm from a transient condition — exactly what this
 * ticket's own UNREADABLE LINKS section says must never happen). A plain
 * 403 (no rate-limit signal) is still genuinely `unreadable` — GitHub
 * answers a private repo this token cannot see with 403, not 404.
 */
function isGithubRateLimited(res: Response): boolean {
  return res.headers.get("x-ratelimit-remaining") === "0" || res.headers.get("retry-after") !== null;
}

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
  const timeoutMs = deps.timeoutMs ?? GITHUB_TIMEOUT_MS;
  let res: Response;
  try {
    res = await withTimeout(deps.fetchImpl(url, {
      headers: { ...ghHeaders(deps.token), ...(priorEtag ? { "if-none-match": priorEtag } : {}) },
      signal: AbortSignal.timeout(timeoutMs),
    }), timeoutMs);
  } catch {
    return { status: "error" }; // network failure / timeout (including a hung fetchImpl the AbortSignal alone did not stop) — transient
  }
  if (res.status === 304) { await drain(res); return { status: "not-modified" }; }
  if (res.status === 403 && isGithubRateLimited(res)) { await drain(res); return { status: "error" }; } // rate-limited — transient, see isGithubRateLimited's own doc comment
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
  /** Overrides the default OVERALL wait bound (`WEBPAGE_TIMEOUT_MS`) below — see `pollWebpage`'s own doc comment for why this is ONE shared deadline across every redirect hop, not one per hop. Test-only knob; production wiring omits it. */
  timeoutMs?: number;
}

const WEBPAGE_TIMEOUT_MS = 10_000;
/** How long `isBlockedHost` (the DNS-resolving SSRF check) may take before this module gives up on it — bounded independently of, and never larger than, whatever's left of the overall per-item deadline (see `pollWebpage`). */
const DNS_TIMEOUT_MS = 5_000;
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
// hostname is resolved via DNS (ALL A/AAAA answers checked, not just the
// first — see `defaultIsBlockedHost`, PR #401 review round 1) and EVERY
// address checked against: IPv4 loopback (127.0.0.0/8), private
// (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16), CGNAT (100.64.0.0/10),
// link-local (169.254.0.0/16 — includes the 169.254.169.254 cloud-metadata
// address) and "this network" (0.0.0.0/8); IPv6 loopback (::1), unspecified
// (::), unique-local (fc00::/7), link-local (fe80::/10), and an
// IPv4-mapped/IPv4-compatible IPv6 address (`::ffff:a.b.c.d` OR its
// all-hex form `::ffff:AABB:CCDD`) checked by its EMBEDDED IPv4 address
// against the IPv4 rules above — plus the literal hostname `localhost`.
// Applied to the INITIAL host and to every redirect hop's host (see
// `pollWebpage`) — a page that redirects to an internal address is refused
// exactly like one that starts there.
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
  ["100.64.0.0", "100.127.255.255"], // CGNAT (RFC 6598)
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

/**
 * Parses any valid textual IPv6 address (`::` compression, an embedded
 * dotted-quad IPv4 tail included) to its 128-bit value, or `null` if it
 * isn't one — a small hand-rolled parser rather than a regex, so an
 * IPv4-mapped address's embedded IPv4 octets can be reused directly against
 * `isPrivateV4` instead of re-deriving them from a prefix match (the exact
 * bug class PR #401 review round 1 found: prefix-matching only caught the
 * dotted-quad spelling of `::ffff:127.0.0.1`, never its equivalent all-hex
 * spelling `::ffff:7f00:1`).
 */
function parseIPv6(address: string): bigint | null {
  const zone = address.indexOf("%");
  const a = zone === -1 ? address : address.slice(0, zone);
  const halves = a.split("::");
  if (halves.length > 2) return null;
  const expand = (s: string): string[] | null => {
    if (s === "") return [];
    const groups = s.split(":");
    const last = groups[groups.length - 1]!;
    if (last.includes(".")) {
      const octets = last.split(".");
      if (octets.length !== 4) return null;
      const nums = octets.map(Number);
      if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
      const hi = ((nums[0]! << 8) | nums[1]!).toString(16);
      const lo = ((nums[2]! << 8) | nums[3]!).toString(16);
      return [...groups.slice(0, -1), hi, lo];
    }
    return groups;
  };
  const head = expand(halves[0] ?? "");
  const tail = halves.length === 2 ? expand(halves[1] ?? "") : [];
  if (head === null || tail === null) return null;
  let groups: string[];
  if (halves.length === 2) {
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return null;
    groups = [...head, ...Array(missing).fill("0"), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  let value = 0n;
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    value = (value << 16n) | BigInt(Number.parseInt(g, 16));
  }
  return value;
}

function isPrivateV6(address: string): boolean {
  const v = parseIPv6(address);
  if (v === null) return true; // unparseable — fail closed, same discipline as an unresolvable hostname below
  if (v === 0n) return true; // :: (unspecified)
  if (v === 1n) return true; // ::1 (loopback)
  if (v >> 32n === 0xffffn) return isPrivateV4([24n, 16n, 8n, 0n].map((shift) => Number((v >> shift) & 0xffn)).join(".")); // ::ffff:0:0/96 — IPv4-mapped, checked by its embedded IPv4
  if (v >> 118n === 0b1111111010n) return true; // fe80::/10 — link-local
  if (v >> 121n === 0b1111110n) return true; // fc00::/7 — unique-local (ULA)
  return false;
}

/** The real DNS-resolving check `WebpagePollDeps.isBlockedHost` defaults to when a caller (production wiring) doesn't supply one. Checks EVERY address the resolver returns (PR #401 review round 1 — a hostname with both a public and a private A/AAAA record must not pass because the first-returned address happened to be public) — blocked if ANY is private. See this module's own "PRIVATE/LOOPBACK ADDRESSES" comment above for what this does and does not cover. */
export async function defaultIsBlockedHost(
  hostname: string,
  /** Injectable for testing ALL-addresses-checked without a real DNS lookup — defaults to `node:dns/promises`' own `lookup`. Production wiring never passes this. */
  lookup: (host: string, opts: { all: true }) => Promise<Array<{ address: string; family: number }>> = dnsLookup,
): Promise<boolean> {
  const lower = hostname.toLowerCase();
  if (lower === "localhost" || lower.endsWith(".localhost")) return true;
  const literalFamily = isIP(hostname);
  if (literalFamily === 4) return isPrivateV4(hostname);
  if (literalFamily === 6) return isPrivateV6(hostname);
  try {
    const results = await withTimeout(lookup(hostname, { all: true }), DNS_TIMEOUT_MS);
    return results.some((r) => (r.family === 4 ? isPrivateV4(r.address) : isPrivateV6(r.address)));
  } catch {
    return true; // unresolvable, or the lookup itself timed out — fail closed rather than let a DNS error/hang fall through to a real connect attempt
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
 * up to `WEBPAGE_MAX_REDIRECTS` hops), a `WEBPAGE_MAX_BODY_BYTES`
 * response-size cap (`readCapped` above), and NO credentials of any kind
 * ever attached — this function takes no token and sends no `authorization`
 * header, unlike `pollGithubLink` above and the Confluence path's
 * `AtlassianClient`. See this module's own "PRIVATE/LOOPBACK ADDRESSES"
 * comment for the SSRF decision.
 *
 * ONE SHARED DEADLINE, NOT ONE TIMEOUT PER HOP (PR #401 review round 1): a
 * per-hop `WEBPAGE_TIMEOUT_MS` timeout, reapplied at every redirect, let a
 * single item cost up to `WEBPAGE_TIMEOUT_MS * (WEBPAGE_MAX_REDIRECTS + 1)`
 * — worst case 60s — serially, on the rule-poll's own critical path ("one
 * bad link must never stall polling of the rest", violated in TIME even
 * when not in outcome). `deadline` below is computed ONCE, before the first
 * hop, and every fetch AND every `isBlocked` DNS check for this call races
 * against however much of it remains — so the WHOLE call (every hop
 * combined) is bounded by `WEBPAGE_TIMEOUT_MS` (or `deps.timeoutMs`),
 * period. Ties into `withTimeout` (this module's own top-of-file helper)
 * for a wait bound that holds even against a `fetchImpl`/`isBlockedHost`
 * fake that ignores its `AbortSignal` entirely.
 */
export async function pollWebpage(item: { target: string }, priorFingerprint: string | undefined, deps: WebpagePollDeps): Promise<PollVerdict> {
  const isBlocked = deps.isBlockedHost ?? defaultIsBlockedHost;
  const timeoutMs = deps.timeoutMs ?? WEBPAGE_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  let current: URL;
  try { current = new URL(item.target); } catch { return { status: "unreadable" }; }
  if (current.protocol !== "http:" && current.protocol !== "https:") return { status: "unreadable" };

  for (let hop = 0; ; hop++) {
    if (hop > WEBPAGE_MAX_REDIRECTS) return { status: "unreadable" };
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { status: "error" }; // the shared deadline ran out across earlier hops — transient, retried next tick
    let blocked: boolean;
    try {
      blocked = await withTimeout(isBlocked(current.hostname), Math.min(remaining, DNS_TIMEOUT_MS));
    } catch {
      return { status: "error" }; // the SSRF check itself timed out — transient, never treated as "not blocked"
    }
    if (blocked) return { status: "unreadable" };

    let res: Response;
    try {
      res = await withTimeout(deps.fetchImpl(current.toString(), {
        redirect: "manual",
        headers: hop === 0 ? conditionalHeadersFor(priorFingerprint) : {},
        signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
      }), Math.max(1, deadline - Date.now()));
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
