import { createHash } from "node:crypto";
import { isApiError } from "confluence.js/core";
import type { AtlassianOps } from "./atlassian.js";
import { HTML4_NAMED_ENTITIES } from "./html4-named-entities.generated.js";

/** The fixed remote-link globalId that carries the ticket -> doc binding. */
export const DOC_LINK_GLOBAL_ID = "butchr:doc";
/** Confluence label prefix carrying the doc -> ticket binding back. */
export const DOC_LABEL_PREFIX = "butchr-ticket-";
/** Marks a freshly created doc as obviously provisional (rule (e): staleness-that-reads-as-authoritative is the failure mode). */
const PROVISIONAL_MARKER = "[unwritten]";
// Confluence's own title limit isn't consistently documented (255 shows up most often); this
// stays comfortably under any figure actually enforced rather than chasing the exact number.
const MAX_TITLE_LEN = 200;
// A depth cap, not a visited-set: a genuine Implements cycle would recurse forever without one,
// and any real boss chain in this fleet is a handful of hops (task -> story -> epic).
const MAX_BOSS_DEPTH = 20;

/**
 * `get_doc`'s default `limit`, in characters, when the caller omits one (BUTCHR-270).
 * (a) 20,000 characters.
 * (b) Reasoning: the margin here is NOT about JSON-serialization overhead — two
 *     independent measurements (a sibling story's real root-doc read at 81,032
 *     result chars vs 80,743 body chars, ~0.36%; and a real storage-format XHTML
 *     file in this repo inflating from 7,761 to 7,828 chars under
 *     `JSON.stringify`, ~0.86%) put that overhead well under 1%, not the doubling
 *     an earlier draft of this ticket wrongly assumed from `"` -> `\"` escaping.
 *     The margin that actually matters is the THRESHOLD'S OWN UNCERTAINTY: the
 *     measured oversize bracket is (56,239, 61,376] characters, from one
 *     controlled experiment on one host/CLI build/day (docs/tool-result-size-cap.md)
 *     — an order of magnitude to stay well clear of, not a constant to shave
 *     against. 20,000 characters, plus a sub-1% serialization tax and a few
 *     hundred envelope-field characters (id, url, title, size, slice, next,
 *     warning), lands under a third of the bracket's own low end.
 * (c) This is a CONSERVATIVE GUESS about the calling harness's environment, not a
 *     measured property of butchr's own transport or of any specific caller's
 *     budget — re-derive docs/tool-result-size-cap.md's bracket against whatever
 *     CLI build is current before trusting this number long-term.
 * (d) FALSIFIED BY: a live `get_doc` call with `limit` omitted whose JSON-serialized
 *     MCP result still gets spooled (preview or error shape) by the calling harness
 *     — that would mean this default is not conservative enough for the harness
 *     actually in use, and it should come down.
 */
export const DEFAULT_GET_DOC_LIMIT_CHARS = 20000;

/**
 * Character budget for a doc's full body on the WRITE path (BUTCHR-250).
 * "Characters" here means `.length` — JS UTF-16 code units, matching the
 * unit the MCP harness cap itself compares against (docs/tool-result-size-cap.md
 * Q2: the harness reports "N characters" and N is a codepoint/UTF-16-unit
 * count, not a UTF-8 byte count — the two diverge measurably in this corpus'
 * em-dash-heavy prose, so do not swap this for `Buffer.byteLength`).
 *
 * METHOD, not a present-tense fact: this must sit BELOW the low end of the
 * measured PREVIEW-to-ERROR boundary for the MCP result cap — the (56,239,
 * 61,376] character bracket docs/tool-result-size-cap.md's Q2 cites from
 * BUTCHR-216's controlled experiment — with margin for three things that are
 * not constants, so re-derive them rather than trusting this comment:
 *   (1) the cap bounds the WHOLE MCP result (JSON envelope + HTML escaping
 *       around the body), not the body alone, and that envelope is NOT a
 *       fixed subtraction — read back live on the BUTCHR root doc, it
 *       measured ~289 characters on 2026-09-02 and ~303 on 2026-09-10 (the
 *       same page), i.e. it grows with the body's own escaping;
 *   (2) the 56,239-61,376 bracket comes from one experiment of undetermined
 *       precision, not a spec;
 *   (3) a body sitting exactly at the boundary is one comment away from
 *       crossing it.
 * 50,000 leaves >6,000 characters (>10%) of margin over all three combined.
 * Re-measure the bracket (docs/tool-result-size-cap.md) before trusting this
 * is still conservative enough — it is a snapshot, not a proof.
 */
export const DOC_BODY_CHAR_BUDGET = 50_000;

/**
 * The MEASURED RULE, corrected once already (BUTCHR-250 PR #299's third
 * review round): Confluence's storage layer re-encodes a NON-ASCII character
 * into a longer named XML entity IF AND ONLY IF that character has a
 * standard HTML 4 named character reference — confirmed by a 37-character
 * live probe with no exception either direction. The SECOND round's own
 * probe was, by its own author's later correction, entirely non-ASCII (every
 * character tested was above U+007F) and over-generalised the rule to ALL
 * 252 HTML4 named entities, including 4 that are themselves Confluence's
 * OWN STORAGE-FORMAT SYNTAX rather than content it re-encodes: `"` (quot),
 * `&` (amp), `<` (lt), `>` (gt) — the quotes around an attribute value, the
 * angle brackets of a tag, the leading `&` of an entity reference already
 * present. Those four are measurably left alone (a 54,824-character real
 * stored body containing 160 literal `&`, 953 literal `<`, 953 literal `>`
 * and 30 literal `"` round-tripped byte-identical), so `HTML4_NAMED_ENTITIES`
 * (`src/tools/html4-named-entities.generated.ts`, vendored from the W3C
 * HTML 4.01 spec itself, not hand-typed — see `scripts/vendor/html4-entities.ts`,
 * whose own header names the 4-codepoint exclusion and why) EXCLUDES those
 * four by construction: it is the spec's 252 minus exactly those 4 = 248.
 * The remaining 248 were checked for the same kind of storage-syntax
 * significance and found clean (that generator's header comment has the
 * detail). A character outside this 248-entry table is, by the same
 * measured rule, one Confluence's storage layer does NOT re-encode — so
 * this is not a residual to be widened later; the measured boundary IS the
 * table's boundary. (BUTCHR-235's own, separate, unresolved caution about
 * attribute ordering/whitespace/self-closing-tag normalisation still stands
 * — this closes the CHARACTER-SUBSTITUTION residual specifically, not every
 * possible way Confluence's storage layer could change a body.)
 */
const HTML4_ENTITY_BY_CODEPOINT: ReadonlyMap<number, string> = new Map(HTML4_NAMED_ENTITIES);

/**
 * Estimates what `body` will look like once Confluence's storage layer has
 * round-tripped it, by replacing every character with an HTML4 named entity
 * (per `HTML4_ENTITY_BY_CODEPOINT`, which deliberately excludes the 4
 * storage-syntax codepoints — see its own doc comment) with that entity.
 * Used to bring a not-yet-stored `proposed` body into the SAME
 * representation `stored` is already in (whatever
 * `get_doc`/`confluence_get_page` returned is already post-transform) and
 * that `DOC_BODY_CHAR_BUDGET` was itself calibrated against
 * (docs/tool-result-size-cap.md's cap is measured on the STORED/returned
 * body, not on what a caller sends).
 *
 * BOTH DIRECTIONS OF ERROR ARE REAL, AND EQUALLY WORTH GUARDING AGAINST —
 * an earlier version of this comment claimed only under-estimating was a
 * risk, which is wrong: OVER-estimating is not "safe" here, it is the
 * OPPOSITE failure this bound exists to avoid — a body this function scores
 * as over budget when its real stored size is not locks the writing tier
 * out of a page it is entitled to write (measured live: exactly this
 * happened when this table still counted the 4 storage-syntax codepoints,
 * inflating a genuinely under-budget real page by ~14% and scoring it
 * over). Correctness here means neither direction of error, not merely
 * "never shrinks" — hence excluding the 4 codepoints above rather than
 * treating their inclusion as a harmless conservative bias.
 */
function estimateStoredLength(body: string): number {
  let total = 0;
  for (const ch of body) {
    const entity = HTML4_ENTITY_BY_CODEPOINT.get(ch.codePointAt(0)!);
    total += entity ? entity.length + 2 : ch.length; // +2 for "&" and ";"
  }
  return total;
}

/**
 * Refuses a doc write IFF it would both exceed `budget` AND grow the page
 * (estimated-stored `proposed` length > `stored.length`) — BUTCHR-250's
 * anti-bricking design. `stored` MUST be read from the page BEFORE the
 * write being adjudicated: a post-write measurement can't do this job,
 * because the anti-bricking clause needs "what's on the page right now",
 * not "what this write would produce". Both `setProjectDoc` and `setDoc`
 * already do that pre-write read (via `projectRootDoc`/`ensureDoc`) to
 * resolve the page id, so this reuses it — no second fetch.
 *
 * Deliberately allows `proposed === stored` (equal size is not growth — a
 * same-size rewrite is a correction, not an expansion) and `proposed ===
 * budget` (the budget line itself is not "over" it). Both edge cases are
 * pinned by the boundary test arms in test/unit/docs.test.ts, so a later
 * edit that flips either `>` to `>=` fails loudly rather than silently.
 *
 * A SIZE comparison, not a content one — this never inspects WHAT changed,
 * only how large the two bodies are once both are expressed in the same
 * (estimated-stored) representation via `estimateStoredLength`. That
 * normalisation closes the MEASURED character-substitution residual exactly
 * (see `HTML4_ENTITY_BY_CODEPOINT`'s own comment) but is NOT a claim that
 * every way Confluence's storage layer could change a body is covered —
 * BUTCHR-235's separate, unresolved caution about attribute ordering,
 * whitespace and self-closing-tag normalisation still stands. Prior to
 * BUTCHR-250's review, this compared raw (un-normalised) lengths and was
 * measurably unsound in the permissive direction — a write that swapped
 * stored entities for their literal, longer-when-re-encoded characters
 * could score as a shrink while the stored page did not shrink at all. See
 * docs/root-doc-write-budget.md for the measurement and
 * test/unit/docs.test.ts for the regression arm.
 */
function refuseIfGrowingOverBudget(who: string, stored: string, proposed: string, budget: number): void {
  const storedLen = stored.length;
  const proposedLen = estimateStoredLength(proposed);
  if (proposedLen > budget && proposedLen > storedLen) {
    throw new Error(
      `${who}: refusing this write — proposed body is an estimated ${proposedLen} characters once stored ` +
        `(${proposed.length} as sent), over the ${budget}-character budget and larger than what's currently ` +
        `stored (${storedLen} characters). This would grow an already-oversized page. Move the excess into a ` +
        `child page linked from this doc's index, then retry with a body no larger than what's stored now — ` +
        `an over-budget page can always be corrected or shrunk, it just cannot be grown further.`,
    );
  }
}

/** `[A-Z][A-Z0-9_]*-[0-9]+` — any valid Jira key. The lowercase round-trip (KEY -> label -> KEY) is lossless only for keys shaped like this. */
export const JIRA_KEY_RE = /^[A-Z][A-Z0-9_]*-[0-9]+$/;

function assertValidKey(key: string, who: string): void {
  if (!JIRA_KEY_RE.test(key)) {
    throw new Error(`${who}: "${key}" is not a valid Jira key (expected [A-Z][A-Z0-9_]*-[0-9]+) — refusing rather than emitting a label that can't be inverted back to it`);
  }
}

/** `butchr-ticket-<key lowercased>`. Refuses a key the label couldn't losslessly invert back from. */
export function labelForKey(key: string): string {
  assertValidKey(key, "labelForKey");
  return `${DOC_LABEL_PREFIX}${key.toLowerCase()}`;
}

function isProvisional(title: string): boolean {
  return title.startsWith(PROVISIONAL_MARKER);
}

function provisionalTitle(key: string, summary: string): string {
  const base = `${PROVISIONAL_MARKER} ${key} — ${summary}`;
  return base.length > MAX_TITLE_LEN ? `${base.slice(0, MAX_TITLE_LEN - 1)}…` : base;
}

/**
 * The opening line of a freshly created doc. The ticket hyperlink here is an
 * AFFORDANCE for a human reader, NOT THE MECHANISM — the real ticket<->doc
 * binding is the remote link (out) plus the Confluence label (back). Deleting
 * this line, or this whole paragraph, must break nothing; that asymmetry is
 * the entire difference between this design and the prose convention the
 * design page records rejecting for the project-to-space link.
 *
 * IT ALSO CARRIES THE ONLY POINTER TO ASSIST, AND THAT IS DELIBERATE. The
 * assistant documents the estate in a Confluence space (ASSIST) that nothing
 * routed an agent to, and the operator's reason for adding this is the same
 * one this whole epic rests on: knowledge that exists but is never read is
 * not knowledge, and a library nobody is sent to is a diary. This paragraph
 * is the ONLY text the tool itself ever authors, and it is read exactly once,
 * by an agent that has just been born and knows nothing — which makes it the
 * one place a pointer is certain to land.
 *
 * Link the SPACE plus a couple of durable entry points, never a list of
 * pages: an enumeration here goes stale silently and this file is the last
 * place anyone would look to fix it. The space's own index is the list. The
 * two pages linked below were each read before being cited (the cold-start
 * page, the obvious-looking choice, is written for the ASSISTANT operating
 * the fleet, not for a worker agent on a ticket — pointing a newborn worker
 * at it would have been plausible and wrong).
 *
 * This text is TRANSIENT BY DESIGN: the first `set_doc` replaces the whole
 * body, pointer included. That is correct and not a leak to engineer around —
 * by then the agent has read it, and the doc's job has changed from
 * orienting its author to recording what happened.
 */
function provisionalBody(key: string, ticketUrl: string, site: string): string {
  const assist = `${site}/wiki/spaces/ASSIST`;
  return (
    `<p>This doc was created together with <a href="${ticketUrl}">${key}</a>. It has not been written yet and is not a record of anything.</p>` +
    `<p><strong>New here?</strong> The assistant documents this estate — how work is created, routed and reviewed, how the fleet is run, and where it has failed before — in ` +
    `<a href="${assist}/overview">the ASSIST space</a>. Two places to start: ` +
    `<a href="${assist}/pages/12714016">The factory, end to end: how a ticket becomes shipped code</a>, and ` +
    `<a href="${assist}/pages/12386388">Working agreements between the assistant and the agents</a>. ` +
    `Every page there carries the date it was last verified, and the space's own rule is that when a page disagrees with a measurement you just took, the measurement wins.</p>`
  );
}

/**
 * Exported (BUTCHR-35, approved by BUTCHR-27): the Implements link direction
 * is the single most commonly inverted fact in this fleet — on the
 * implementer, the boss is the INWARD side — and one shared reader means one
 * place to be wrong and one place to fix, instead of five relationship verbs
 * (src/tools/relationship.ts) each growing their own version of this read.
 */
export function findBossKey(issue: unknown): string | null {
  const links = (issue as { fields?: { issuelinks?: unknown[] } })?.fields?.issuelinks ?? [];
  for (const l of links as Array<{ type?: { name?: string }; inwardIssue?: { key?: string } }>) {
    // On the IMPLEMENTER (this ticket), its boss appears as `inwardIssue` — see
    // src/atlassian/types.ts's IssueLink doc comment for the live evidence.
    if (l?.type?.name === "Implements" && l.inwardIssue?.key) return l.inwardIssue.key;
  }
  return null;
}

/** One of a caller's own workers, as read off the caller's own already-fetched issue payload — never a second Jira call. `status` is whatever the link stub's own hydrated `fields.status.name` carries; a stub Jira does not hydrate (or a garbage payload) leaves it `undefined` rather than a guessed value. `summary` (BUTCHR-244) is the same stub's hydrated `fields.summary` — present in the SAME measured field set as `status` (see `findWorkers`'s own doc comment), so reading it costs nothing beyond what `status` already costs; used by `new_worker`'s idempotency check (relationship.ts's `findDuplicateWorker`) to match a retry against the caller's own not-Done children with no extra Jira call. */
export interface WorkerRef {
  key: string;
  status: string | undefined;
  summary: string | undefined;
}

/**
 * `findBossKey`'s own mirror (BUTCHR-193): on a BOSS's own `getIssue`
 * payload, its workers appear as `Implements` links in the OUTWARD
 * direction — the opposite side from `findBossKey`'s inward read, and the
 * ONLY other direction an `Implements` link stub can point. MEASURED live
 * (BUTCHR-127's own payload, 2026-09-02): the outward stub arrives already
 * hydrated with `fields.status.name`, at no extra Jira call beyond the
 * `getIssue` the caller already made — so this stays PURE AND TOTAL over
 * that payload, exactly like `findBossKey`: no I/O here, and it tolerates a
 * missing, absent, or garbage `fields.issuelinks` the same way.
 *
 * WHAT THE STUB DOES NOT CARRY, AND WHY THAT IS THIS FUNCTION'S BUSINESS TO
 * SAY, NOT ITS CALLER'S TO DISCOVER BY SURPRISE: the same measurement showed
 * the outward stub's hydrated field set is exactly
 * `issuetype, priority, status, summary` — `labels` is NOT there, confirmed
 * even against a worker that genuinely carries labels (BUTCHR-127 itself
 * carries `butchr:orphan`/`pr:merged`, and neither appears on BUTCHR-156's
 * outward link to it). So this can answer "is this worker Done" for free,
 * but it can NEVER answer "does this worker carry `butchr:shelved`"
 * (`EXEMPT_LABEL`, src/agents/parked.ts) from this payload alone — a caller
 * that needs the shelved-exemption has to pay for a SEPARATE `getIssue` per
 * non-Done worker to find out. That cost, and where it's paid, lives in
 * relationship.ts's own open-worker guard, not here — this function's only
 * job is the total, I/O-free read of what the payload already contains.
 */
export function findWorkers(issue: unknown): WorkerRef[] {
  const links = (issue as { fields?: { issuelinks?: unknown[] } })?.fields?.issuelinks ?? [];
  const workers: WorkerRef[] = [];
  for (const l of links as Array<{ type?: { name?: string }; outwardIssue?: { key?: string; fields?: { status?: { name?: string }; summary?: string } } }>) {
    // On the BOSS (this ticket), a worker appears as `outwardIssue` — the
    // mirror image of findBossKey's `inwardIssue` read above.
    if (l?.type?.name === "Implements" && l.outwardIssue?.key) {
      workers.push({ key: l.outwardIssue.key, status: l.outwardIssue.fields?.status?.name, summary: l.outwardIssue.fields?.summary });
    }
  }
  return workers;
}

/** Jira's issue `self` URL (`https://site/rest/api/3/issue/…`) with the API suffix stripped, for building a human browse link. */
function siteFromSelf(self: unknown): string | null {
  const s = typeof self === "string" ? self : undefined;
  if (!s) return null;
  const i = s.indexOf("/rest/api/");
  return i === -1 ? null : s.slice(0, i);
}

function pageIdFromUrl(url: string): string | null {
  const m = /\/pages\/(\d+)(?:\/|$)/.exec(url);
  return m?.[1] ?? null;
}

export interface DocResult {
  id: string;
  url: string;
  title: string;
  body: string;
}

/**
 * `DocResult` plus the page's own Confluence version number — a strict
 * additive widening, never a replacement: everywhere `DocResult` is the
 * declared contract (`ensureDoc`, `setDoc`, `setProjectDoc`, and every
 * non-tool caller of `projectRootDoc` — see docs.ts's own module doc for the
 * grep), a value of this shape satisfies it unchanged, so this stays purely
 * additive for THOSE callers. Exists so `get_doc`'s tool-facing layer
 * (BUTCHR-270) can report `version` on a hit "for free" — the page read
 * `readLinkedPage`/`projectRootDoc` already perform includes it — WITHOUT
 * widening the write path's own `DocResult` contract, which BUTCHR-235 owns
 * and this ticket must not touch.
 */
interface VersionedDocResult extends DocResult {
  /** The page's own Confluence version number, or `null` when the read didn't carry one (e.g. a fake/test double). Never guessed. */
  version: number | null;
}

/** `{ chars, bytes }` — the vocabulary BUTCHR-235 (the write-side receipt) already uses, kept identical here rather than inventing a second one. `chars` is the JS string `.length` (UTF-16 code units) — equal to the Unicode codepoint count for this corpus's Basic-Multilingual-Plane content, and the unit `offset`/`limit` are also expressed in, so the two stay mutually consistent. `bytes` is the UTF-8 byte length, carried alongside because it's nearly free and protects a reader on a different, byte-governed path (see docs/tool-result-size-cap.md's scope note) without this path depending on it. */
export interface DocSize {
  chars: number;
  bytes: number;
}

/** Where a partial slice starts and how much it actually carries, in the same `{chars, bytes}` unit as `size` — `chars` is the ACTUAL returned length (it can be one shorter than the requested `limit` when a surrogate-pair boundary was nudged), not an echo of the request. */
export interface GetDocSlice {
  offset: number;
  chars: number;
  bytes: number;
}

/** Present iff characters remain after this slice. Its `offset` is exactly what the caller passes back next; absence is how a caller knows pagination is finished — never `complete`, which stays `false` on every slice of a partial read, including the last one. */
export interface GetDocNext {
  offset: number;
}

export type GetDocResult =
  | { found: false }
  | {
      found: true;
      /** `true` iff `body` is present iff the request started at offset 0 and reached the end of the stored body. */
      complete: true;
      id: string;
      url: string;
      title: string;
      version: number | null;
      size: DocSize;
      /** The ENTIRE stored body. Present only on this arm — see `complete`'s own doc comment. */
      body: string;
    }
  | {
      found: true;
      complete: false;
      id: string;
      url: string;
      title: string;
      version: number | null;
      size: DocSize;
      slice: GetDocSlice;
      next?: GetDocNext;
      /**
       * THE SAFETY-CRITICAL FIELD NAME (BUTCHR-270): a partial's content
       * lives under `chunk`, NEVER under `body`. `set_doc` is a full-body
       * replace, and the taught workflow is "call get_doc, edit the body you
       * got back, write the whole thing" — if a partial populated `body`, a
       * caller that never heard of pagination would read a truncated body,
       * write it back, and permanently destroy the rest of the document in a
       * corpus where nothing is ever archived. With `body` absent on this
       * arm, that same caller gets `undefined` and fails loudly instead.
       * Never rename this to make the two arms look more similar — the
       * asymmetry is the entire point.
       */
      chunk: string;
      /** Human-readable courtesy, not the machine-readable signal — the shape (this arm existing, `body`'s absence) is that. */
      warning: string;
    };

/**
 * The one line every partial `get_doc` result carries under `warning`. A
 * courtesy for a human skimming a transcript, never the mechanism a caller
 * should branch on — branch on `complete`/`body`/`next` instead, which are
 * structural and can't be missed the way prose can.
 */
const PARTIAL_READ_WARNING =
  "This is a PARTIAL read, not the whole document: `body` is deliberately absent so this result can never be mistaken for the whole page and fed to set_doc as a full-body replace. " +
  "TO READ THE REST: call get_doc again with the SAME key, offset=<next.offset>, AND expectVersion=<the `version` of THIS result>, until `next` is absent; then concatenate every `chunk` in offset order. " +
  "expectVersion IS REQUIRED on every call with offset > 0 and it is not bookkeeping: if the page is edited mid-read, the call REFUSES rather than handing you a slice from a different version. " +
  "NEVER concatenate chunks that came from different versions — the result would be a body that never existed at any point in time, and feeding that to set_doc (a full-body replace) destroys the real page just as surely as a truncated body would. " +
  "If a call refuses for version drift, DISCARD every chunk you have collected and restart from offset 0.";

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}
function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * Never split a surrogate pair (BUTCHR-270): JS `.slice()` cuts on UTF-16
 * code units, and a cut landing between a high and low surrogate emits two
 * lone surrogates that do not survive UTF-8/JSON cleanly. Nudges `end`
 * backward one code unit when it lands mid-pair, EXCEPT when that would
 * make the slice empty (`end - 1 === start`, i.e. the pair starts exactly at
 * `start` and a 1-character `limit` asked to stop inside it) — there, it
 * nudges forward instead, past the whole pair, so a slice can never regress
 * to zero-length and stall pagination. Either way `slice.chars` reports
 * whatever length actually resulted, never the raw requested `limit`.
 */
function nudgeSurrogateBoundary(body: string, start: number, end: number): number {
  if (end > start && end < body.length && isHighSurrogate(body.charCodeAt(end - 1)) && isLowSurrogate(body.charCodeAt(end))) {
    return end - 1 === start ? end + 1 : end - 1;
  }
  return end;
}

function utf8ByteLength(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

function sizeOf(body: string): DocSize {
  return { chars: body.length, bytes: utf8ByteLength(body) };
}

/**
 * The one place `get_doc`'s three-arm shape (BUTCHR-270) is assembled, shared
 * by both dispatch branches (`getDoc`/`getProjectDoc`) so the arm logic exists
 * exactly once. `offset`/`limit` are ASSUMED ALREADY VALIDATED for shape
 * (non-negative/positive integers) by `validateRange` — this function's own
 * job is the ONE check that needs the body's actual length to evaluate:
 * `offset` past the end.
 */
function buildGetDocResult(who: string, doc: VersionedDocResult, offset: number, limit: number): GetDocResult {
  const { body } = doc;
  const total = body.length;
  if (offset > total) {
    throw new Error(`${who}: offset ${offset} is past the end of "${doc.title || doc.id}" (${total} characters) — refusing rather than silently clamping to the end`);
  }
  const rawEnd = Math.min(offset + limit, total);
  const end = nudgeSurrogateBoundary(body, offset, rawEnd);
  const chunk = body.slice(offset, end);
  const size = sizeOf(body);
  const complete = offset === 0 && end === total;

  if (complete) {
    return { found: true, complete: true, id: doc.id, url: doc.url, title: doc.title, version: doc.version, size, body };
  }

  const sliceChars = chunk.length;
  const nextOffset = offset + sliceChars;
  return {
    found: true,
    complete: false,
    id: doc.id,
    url: doc.url,
    title: doc.title,
    version: doc.version,
    size,
    slice: { offset, chars: sliceChars, bytes: utf8ByteLength(chunk) },
    ...(nextOffset < total ? { next: { offset: nextOffset } } : {}),
    chunk,
    warning: PARTIAL_READ_WARNING,
  };
}

/** Validates `offset`/`limit` SHAPE only (integer-ness, sign) — everything that needs the body's actual length (offset past the end) is `buildGetDocResult`'s job, since the body isn't fetched yet when this runs. */
/**
 * Validates `offset`/`limit` SHAPE only (integer-ness, sign), plus the ONE
 * cross-argument rule that makes a spliced read unrepresentable rather than
 * merely discouraged (BUTCHR-230 review): **`expectVersion` is REQUIRED
 * whenever `offset > 0`.**
 *
 * Why a refusal rather than an instruction. `set_doc` is a full-body replace
 * and the taught workflow is "read, edit, write the whole thing back." A
 * document edited between two slices of one paginated read yields a
 * concatenation that never existed at any point in time — and handing THAT to
 * `set_doc` destroys the real page exactly as thoroughly as the truncated
 * `body` this design already made unrepresentable, while being much harder to
 * notice. Telling callers to compare `version` themselves is prose, and prose
 * is what this whole contract exists to stop relying on.
 *
 * Costs nothing in compatibility: `offset` did not exist before this change,
 * so no caller can already be passing one without a version.
 *
 * The version equality check itself needs the page, so it lives in
 * `assertVersionMatches`, called once the read has happened.
 */
function validateRange(who: string, offset: number | undefined, limit: number | undefined, expectVersion: number | undefined): { offset: number; limit: number; expectVersion?: number } {
  const o = offset ?? 0;
  if (!Number.isInteger(o) || o < 0) {
    throw new Error(`${who}: offset must be a non-negative integer — got ${JSON.stringify(offset)}`);
  }
  const l = limit ?? DEFAULT_GET_DOC_LIMIT_CHARS;
  if (!Number.isInteger(l) || l < 1) {
    throw new Error(`${who}: limit must be a positive integer — got ${JSON.stringify(limit)}`);
  }
  if (expectVersion !== undefined && (!Number.isInteger(expectVersion) || expectVersion < 1)) {
    throw new Error(`${who}: expectVersion must be a positive integer — got ${JSON.stringify(expectVersion)}`);
  }
  if (o > 0 && expectVersion === undefined) {
    throw new Error(
      `${who}: expectVersion is required when offset > 0 — pass the \`version\` from the first slice of this read, so a mid-read edit REFUSES instead of silently splicing two versions into a body that never existed. Start again at offset 0 if you no longer have it.`,
    );
  }
  return { offset: o, limit: l, ...(expectVersion !== undefined ? { expectVersion } : {}) };
}

/**
 * The version gate itself (BUTCHR-230 review). Refuses rather than guessing in
 * BOTH failure directions: a version that differs from the caller's, and a page
 * whose version could not be read at all — an unverifiable pin is not a
 * satisfied pin, and silently accepting one would reopen the exact hole
 * `expectVersion` exists to close.
 */
function assertVersionMatches(who: string, doc: VersionedDocResult, expectVersion: number | undefined): void {
  if (expectVersion === undefined) return;
  if (doc.version === null) {
    throw new Error(`${who}: cannot honour expectVersion=${expectVersion} — this page read carried no version, so the pin is unverifiable. Refusing rather than assuming the document did not change under a multi-call read.`);
  }
  if (doc.version !== expectVersion) {
    throw new Error(
      `${who}: the document changed mid-read — you pinned expectVersion=${expectVersion} but "${doc.title || doc.id}" is now version ${doc.version}. DISCARD every chunk collected so far and restart from offset 0; concatenating across versions would produce a body that never existed.`,
    );
  }
}

/** `chars` is string length (UTF-16 code units, i.e. what `.length` reports); `bytes` is UTF-8 byte length — carried separately because the incident this contract exists to fix reported "characters" while naming a "token" limit, and this project has already paid once for that unit ambiguity. */
export interface WriteDigest {
  chars: number;
  bytes: number;
  sha256: string;
}

/**
 * `set_doc`'s new write receipt (BUTCHR-236, story BUTCHR-235). Replaces the
 * old `DocResult`-shaped echo — which returned the caller's own input `body`
 * back at it, proving nothing about what actually landed, and which scaled
 * with document size (an oversize doc turned a SUCCESSFUL write into an
 * error indistinguishable from a failed one). This type is bounded — a few
 * hundred bytes — AT EVERY ARM, for any document size: no body, no preview,
 * no excerpt, ever.
 *
 * `landed` is the deliverable: `"confirmed"` means the page was re-read
 * after the write and returned a body — the write landed. `"unconfirmed"`
 * means the update call itself succeeded but the read-back did not; almost
 * certainly landed, but "I could not check" is not "I checked and it
 * differed" — keep the two apart.
 *
 * Byte-for-byte equality is NOT achievable on this surface (MEASURED:
 * Confluence's storage-format normalisation rewrites ordinary prose on
 * write — a literal em dash reads back as `&mdash;`), so `identical` is a
 * convenience only, and MUST NOT be the only thing a caller reads:
 * `identical: false` is the ORDINARY case on a healthy write, not an error.
 * The numbers (`wrote` vs `stored`) are the primary, machine-readable
 * signal — normalisation makes `stored` slightly LARGER than `wrote`, while
 * truncation or mangling makes it dramatically SMALLER, so a caller can
 * apply its own threshold instead of being taught how to read a boolean.
 *
 * `version` is the page's version number as reported on the read-back, or
 * `null` when unavailable (e.g. `landed: "unconfirmed"`) — bounded,
 * server-authoritative, and monotonic evidence that the write took effect.
 *
 * Nothing about this type can be produced by a throw except a genuinely
 * failed write: `landed: "unconfirmed"` and `identical: false` are both
 * ordinary, resolved results, never rejections.
 */
export interface SetDocResult {
  id: string;
  url: string;
  title: string;
  version: number | null;
  wrote: WriteDigest;
  stored: WriteDigest | null;
  landed: "confirmed" | "unconfirmed";
  identical: boolean | null;
}

function digest(body: string): WriteDigest {
  const buf = Buffer.from(body, "utf8");
  return { chars: body.length, bytes: buf.byteLength, sha256: createHash("sha256").update(buf).digest("hex") };
}

/**
 * Builds the write receipt shared by `setDoc` and `setProjectDoc`: re-reads
 * the page AFTER `updatePage` has already resolved, rather than trusting
 * anything `updatePage` itself returned — a read-back is the only thing
 * that can tell "landed" from "looked like it landed". The read-back is
 * NEVER allowed to throw out of this function: a failed confirmation read
 * is `landed: "unconfirmed"`, not a rejection, because a caller must be
 * able to tell "the write failed" (a thrown error, from `updatePage`
 * itself, above this call) apart from "the write very likely succeeded but
 * this call couldn't confirm it" (this catch branch).
 */
async function buildReceipt(ops: AtlassianOps, id: string, url: string, title: string, body: string): Promise<SetDocResult> {
  const wrote = digest(body);
  try {
    const page = (await ops.getPage(id)) as { version?: { number?: number }; body?: { storage?: { value?: string } } } | undefined;
    const storedBody = page?.body?.storage?.value;
    const version = page?.version?.number ?? null;
    if (storedBody === undefined) {
      return { id, url, title, version, wrote, stored: null, landed: "unconfirmed", identical: null };
    }
    const stored = digest(storedBody);
    return { id, url, title, version, wrote, stored, landed: "confirmed", identical: stored.sha256 === wrote.sha256 };
  } catch {
    return { id, url, title, version: null, wrote, stored: null, landed: "unconfirmed", identical: null };
  }
}

async function readLinkedPage(ops: AtlassianOps, key: string): Promise<VersionedDocResult | null> {
  const link = await ops.getRemoteLink(key, DOC_LINK_GLOBAL_ID);
  const url = link?.object?.url;
  if (!url) return null;
  const id = pageIdFromUrl(url);
  if (!id) return null;
  const page = (await ops.getPage(id)) as { title?: string; body?: { storage?: { value?: string } }; version?: { number?: number } } | undefined;
  return {
    id,
    url,
    title: page?.title ?? link?.object?.title ?? "",
    body: page?.body?.storage?.value ?? "",
    version: page?.version?.number ?? null,
  };
}

/**
 * Pure read: does `key` already have a doc? NEVER creates one, for the
 * caller's own ticket or any other. On a miss, returns `{ found: false }`
 * — not an error, not a lazily-manufactured page — so an agent can tell
 * "no page" from "empty page" from "call failed". (Reversed from this
 * ticket's original draft, which had the arg-less form create lazily; the
 * settled spec — https://wroosbit.atlassian.net/wiki/spaces/BUTCHR/pages/12484678
 * — makes get_doc the one verb here that writes nothing at all.)
 *
 * BOUNDED, CALLER-CONTROLLABLE RANGE READ (BUTCHR-270): `offset`/`limit` let
 * a caller page through a body too large for one MCP result — see
 * `GetDocResult`'s own doc comment for the three-arm shape this returns.
 * The bound lives HERE, in the TOOL-FACING layer, deliberately NOT inside
 * `readLinkedPage` — that shared resolver is also reached by internal,
 * non-tool code paths (verify at your own commit; docs.ts's own imports are
 * the grep) that only ever use the returned `id`, never the body, and
 * bounding it there would slice bodies for callers that never asked.
 */
export async function getDoc(ops: AtlassianOps, key: string, offset?: number, limit?: number, expectVersion?: number): Promise<GetDocResult> {
  assertValidKey(key, "get_doc");
  const { offset: o, limit: l, expectVersion: v } = validateRange("get_doc", offset, limit, expectVersion);
  const doc = await readLinkedPage(ops, key);
  if (!doc) return { found: false };
  assertVersionMatches("get_doc", doc, v);
  return buildGetDocResult("get_doc", doc, o, l);
}

/**
 * Resolves a PROJECT's doc: the page named by that project's `butchr`
 * entity property, at `rootDoc.id` — reusing `getProjectProperty`, the same
 * reader `ensureDoc` already calls below, rather than adding a second one.
 * NEVER CREATES A PAGE: a project's root doc always already exists (every
 * live product project, and ASSIST, is provisioned with one ahead of any
 * project agent running — BUTCHR-62's own doc), so unlike `ensureDoc` there
 * is no create/nest/label step here at all, for either `getProjectDoc` or
 * `setProjectDoc` below. A missing property or missing `rootDoc.id` is a
 * REFUSAL naming the project and what's missing, never a fallback to
 * creating a page or to a space default — creating a stray page here would
 * be unrecoverable in a corpus where nothing is ever archived.
 */
export async function projectRootDoc(ops: AtlassianOps, projectKey: string): Promise<VersionedDocResult> {
  let prop: { rootDoc?: { id?: string } } | undefined;
  try {
    prop = (await ops.getProjectProperty(projectKey, "butchr")) as typeof prop;
  } catch (e) {
    throw new Error(`project ${projectKey}: "butchr" entity property is unreadable — refusing rather than guessing a root doc (${(e as Error).message})`);
  }
  const rootDocId = prop?.rootDoc?.id;
  if (!rootDocId) {
    throw new Error(`project ${projectKey}: "butchr" entity property is missing rootDoc.id — refusing rather than falling back to a space default`);
  }
  const page = (await ops.getPage(rootDocId)) as { title?: string; body?: { storage?: { value?: string } }; _links?: { base?: string; webui?: string }; version?: { number?: number } } | undefined;
  return {
    id: rootDocId,
    url: `${page?._links?.base ?? ""}${page?._links?.webui ?? ""}`,
    title: page?.title ?? "",
    body: page?.body?.storage?.value ?? "",
    version: page?.version?.number ?? null,
  };
}

/**
 * Pure read of a PROJECT's root doc — the project-caller counterpart to
 * `getDoc`. Never creates one; see `projectRootDoc`'s own doc comment.
 * BOUNDED the same way and for the same reason as `getDoc` (BUTCHR-270) —
 * see that function's own doc comment for the three-arm shape and why the
 * bound lives here rather than inside `projectRootDoc` itself. THE PROJECT
 * ROOT DOC IS THE LARGEST DOCUMENT ON THIS SURFACE and the reason this
 * bound exists at all — this dispatch branch is not an afterthought.
 */
export async function getProjectDoc(ops: AtlassianOps, projectKey: string, offset?: number, limit?: number, expectVersion?: number): Promise<GetDocResult> {
  const { offset: o, limit: l, expectVersion: v } = validateRange("get_doc", offset, limit, expectVersion);
  const doc = await projectRootDoc(ops, projectKey);
  assertVersionMatches("get_doc", doc, v);
  return buildGetDocResult("get_doc", doc, o, l);
}

/**
 * Full-body replace of a PROJECT's root doc — the project-caller counterpart
 * to `setDoc`. NEVER calls `ensureDoc`: a root doc always already exists
 * (see `projectRootDoc`), so there is no create/nest/label path here, only
 * resolve-then-replace. Unlike `setDoc`, `title` stays optional even on the
 * very first call: the `[unwritten]` provisional-title gate is an ISSUE-doc
 * concept (a freshly created per-ticket page needs a real title before it
 * can stop looking unwritten) — a root doc is provisioned ahead of time with
 * a real title already, so there is no provisional state to graduate out of.
 *
 * Returns a `SetDocResult` (BUTCHR-236) — a bounded receipt, never the
 * body it just wrote — built by `buildReceipt`'s own post-write read-back.
 */
export async function setProjectDoc(ops: AtlassianOps, projectKey: string, body: string, title?: string): Promise<SetDocResult> {
  const doc = await projectRootDoc(ops, projectKey);
  refuseIfGrowingOverBudget(`setProjectDoc(${projectKey})`, doc.body, body, DOC_BODY_CHAR_BUDGET);
  await ops.updatePage({ id: doc.id, body, ...(title ? { title } : {}) });
  return buildReceipt(ops, doc.id, doc.url, title ?? doc.title, body);
}

/**
 * Exhaustive scan of `parentId`'s DIRECT children for one labelled
 * `label` — step 3 of ensureDoc.
 *
 * THIS MUST NEVER BE A CQL LABEL SEARCH, even though CQL is one call and
 * obviously tidier. MEASURED live: immediately after creating a page
 * carrying a fresh label, a CQL search for that label returned ZERO hits,
 * while a direct read of the same page's labels — and a direct listing of
 * its parent's children — both returned it instantly. Confluence's CQL
 * index is asynchronous; direct reads are not. A CQL-based step 3 passes
 * every test a human writes slowly by hand and fails exactly in the
 * situation it exists for — a retry seconds after a partial failure — by
 * reporting "no doc" and creating a SECOND page. Rule (d) (no archiving)
 * makes that duplicate permanent.
 *
 * THIS MUST ALSO NEVER STOP AT ONE PAGE OF CHILDREN. `getChildPages` is
 * cursor-paginated (MEASURED live: a `limit`-bounded call came back with
 * `_links.next` set whenever more children existed); a single unpaginated
 * call is the CQL bug wearing a different hat — silently partial on a
 * parent with more children than one page, reporting "no doc" and creating
 * a permanent duplicate. So this follows `nextCursor` to exhaustion.
 */
async function findLabelledChild(ops: AtlassianOps, parentId: string, label: string): Promise<string | null> {
  let cursor: string | undefined;
  do {
    const { results, nextCursor } = await ops.getChildPages(parentId, cursor);
    for (const child of results) {
      const labels = await ops.getPageLabels(child.id);
      if (labels.includes(label)) return child.id;
    }
    cursor = nextCursor;
  } while (cursor);
  return null;
}

/**
 * Ensures `key` has a doc, creating one (recursively, nested under its
 * boss's doc) if it doesn't, and returns it. Called from exactly ONE place:
 * set_doc's write path — get_doc is a pure read and never calls this.
 *
 * `ensureDoc(key)`:
 *   (0) read the project property -> { spaceKey, rootDocId }
 *   (1) read the `butchr:doc` remote link on the ticket. Present -> return its page. [direct read, immediately consistent]
 *   (2) resolve the boss via the Implements link; recurse to get the parent page id; no boss -> parent = rootDocId.
 *   (3) list the parent's children (exhaustively — see findLabelledChild) and check each child's labels for `butchr-ticket-<key>`. Found -> adopt it, skip to (5).
 *   (4) create the page under that parent WITH THE LABEL in the same API call.
 *   (5) upsert the remote link (idempotent by globalId).
 *
 * WHAT THIS MAKES TRUE, AND WHAT IT DOESN'T: this makes doc creation
 * CONVERGENT under retry, not ATOMIC. Rule (a)'s full promise — ticket, doc,
 * and both links, or nothing at all — is BUTCHR-28's problem (creating the
 * ticket itself), not this function's: ensureDoc only ever runs against a
 * ticket that already exists. What IS true here is what each partial
 * failure of THIS function leaves behind, and why a retry always converges:
 *   - fail at 0,1,2,3 -> reads only. NOTHING written.
 *   - fail at 4 -> Confluence's create is one transaction. Either no page at
 *     all, or a page already nested, already labelled, and therefore ALREADY
 *     DISCOVERABLE BY STEP 3 on the next call. There is no half-made page.
 *   - fail at 5 -> the page exists; the ticket has no link to it yet. The
 *     next call re-runs: step 3 finds the page (by its label, exhaustively),
 *     step 5 completes. The idempotent upsert means a retry cannot make a
 *     second link; step 3 means it cannot make a second page.
 * So the only survivable partial state across SEQUENTIAL retries is exactly
 * the one step 3 exists to recover, and a retry converges. Nothing to roll
 * back, so there is no delete op here and none should be added.
 *
 * THE RACE THAT SEQUENTIAL CONVERGENCE DOESN'T COVER: two callers running
 * this concurrently can both pass step 3 (nothing found yet) and both reach
 * step 4. Confluence enforces unique page titles per space, and the
 * provisional title is DETERMINISTIC from the issue key, so the loser's
 * create 400s ("a page with this title already exists") INSTEAD OF making a
 * duplicate — MEASURED live, twice in a row. That 400 is treated as "someone
 * else just won the race", triggering one bounded re-scan of step 3 (not a
 * fatal error) to adopt the winner's page. This is DEFENSE IN DEPTH ON TOP
 * OF the exhaustive-pagination fix above, not a replacement for it: the
 * title guard only holds while the title is still the provisional,
 * key-derived one — once an agent retitles its doc, a stale/duplicate
 * provisional-titled create would no longer collide with it, and only the
 * exhaustive children scan still catches that case.
 */
export async function ensureDoc(ops: AtlassianOps, key: string, depth = 0): Promise<DocResult> {
  assertValidKey(key, "ensureDoc");
  if (depth > MAX_BOSS_DEPTH) {
    throw new Error(`ensureDoc: boss chain for ${key} is more than ${MAX_BOSS_DEPTH} hops deep — refusing rather than risking an Implements-link cycle looping forever`);
  }

  // (1) direct read, immediately consistent.
  const existing = await readLinkedPage(ops, key);
  if (existing) return existing;

  // (0) project property -> space + root doc, keyed off THIS key's project prefix.
  const projectKey = key.split("-")[0]!;
  let prop: { space?: { key?: string }; rootDoc?: { id?: string } } | undefined;
  try {
    prop = (await ops.getProjectProperty(projectKey, "butchr")) as typeof prop;
  } catch (e) {
    throw new Error(`ensureDoc: project entity property "butchr" is unreadable for project ${projectKey} — refusing rather than guessing a space/root doc (${(e as Error).message})`);
  }
  const spaceKey = prop?.space?.key;
  const rootDocId = prop?.rootDoc?.id;
  if (!spaceKey || !rootDocId) {
    throw new Error(`ensureDoc: project entity property "butchr" for project ${projectKey} is missing space.key or rootDoc.id — refusing rather than falling back to Confluence's implicit space default`);
  }

  // (2) resolve the boss via Implements; recurse for the parent page, or bottom out at the root doc.
  //
  // VERIFIED FOR BUTCHR-71's CONTRACT 2, NOT ASSUMED: an Epic created by a
  // PROJECT caller (src/tools/relationship.ts's `newWorker` project branch)
  // gets NO Implements link at all — a project/epic relationship is
  // membership, not a link — so `findBossKey` on such an Epic returns `null`
  // exactly like any other bossless ticket, and `parentId` bottoms out at
  // `rootDocId` here. `rootDocId` was just read (step 0) from the SAME
  // project's `butchr` property the Epic's own `projectKey` (`key.split("-")[0]`
  // above) belongs to — the project that created it. So the epic's doc nests
  // under that project's own root doc with NO second code path: this branch
  // already does the right thing for a project-created Epic, unchanged.
  const issue = await ops.getIssue(key);
  const bossKey = findBossKey(issue);
  const parentId = bossKey ? (await ensureDoc(ops, bossKey, depth + 1)).id : rootDocId;

  const summary = (issue as { fields?: { summary?: string } })?.fields?.summary ?? key;
  const title = provisionalTitle(key, summary);
  const label = labelForKey(key);
  const ticketSite = siteFromSelf((issue as { self?: unknown })?.self);
  const ticketUrl = ticketSite ? `${ticketSite}/browse/${key}` : `/browse/${key}`;

  // (3) exhaustive scan for an already-existing (fail-at-5) page.
  let pageId = await findLabelledChild(ops, parentId, label);

  if (!pageId) {
    // (4) create, with the label, in the same call.
    try {
      const created = await ops.createPageWithLabel({ spaceKey, parentId, title, body: provisionalBody(key, ticketUrl, ticketSite ?? ""), label });
      pageId = created.id;
    } catch (e) {
      // RACE GUARD (defense in depth — see the function doc comment above):
      // a concurrent ensureDoc(key) may have created the page between our
      // step-3 scan and this create, and Confluence's title-uniqueness 400 is
      // the server telling us that happened — so ANY 400 here re-scans once
      // rather than failing outright or retrying the create into a loop. Most
      // 400s reaching this branch genuinely are the title collision, but a
      // malformed body or a bad parentId would also 400 and land here; the
      // re-scan is harmless either way (it just won't find anything to
      // adopt), so the message below doesn't assert which one happened.
      if (isApiError(e) && e.status === 400) {
        const adopted = await findLabelledChild(ops, parentId, label);
        if (!adopted) throw new Error(`ensureDoc: create for ${key} failed with 400 (possibly a title collision with a concurrent creator) and a re-scan of parent ${parentId} still found no page labelled "${label}" — giving up rather than looping (${(e as Error).message})`);
        pageId = adopted;
      } else {
        throw e;
      }
    }
  }

  const page = (await ops.getPage(pageId)) as { title?: string; body?: { storage?: { value?: string } }; _links?: { base?: string; webui?: string } } | undefined;
  const finalTitle = page?.title ?? title;
  const finalUrl = `${page?._links?.base ?? `${ticketSite ?? ""}/wiki`}${page?._links?.webui ?? ""}`;

  // (5) upsert the remote link — idempotent by globalId, so a retry can never make a second link.
  await ops.upsertRemoteLink(key, DOC_LINK_GLOBAL_ID, "documented by", { title: finalTitle, url: finalUrl });

  return { id: pageId, url: finalUrl, title: finalTitle, body: page?.body?.storage?.value ?? "" };
}

/**
 * Full-body replace of the CALLER'S OWN doc (`key` is always the caller's
 * own — see defs.ts; there is no key parameter on set_doc at all). Ensures
 * the doc exists first (the only call site of ensureDoc), then writes.
 *
 * While the doc's title still carries the `[unwritten]` provisional marker,
 * `title` is REQUIRED: an agent cannot write real content and leave the page
 * reading as unwritten. Once titled, `title` is optional and omitting it
 * keeps the current title.
 *
 * TITLE CHANGE -> RE-UPSERT THE LINK. `ensureDoc` already upserted the
 * `butchr:doc` remote link once, but it did so with the title the page had
 * AT THAT MOMENT — the provisional one, on first write. If `updatePage`
 * changes the title and nothing else touches the link, the Jira ticket's
 * human-visible web link is stuck reading "[unwritten] …" forever, even
 * after the doc is genuinely written — exactly the stale-reads-as-
 * authoritative failure rule (f) names, and on the half of the binding a
 * human actually looks at (PR #112 review). The upsert is idempotent by
 * globalId (see ensureDoc's step 5 comment), so re-calling it here can never
 * create a second link — it only refreshes the one that already exists.
 * Only do this when the title actually changed: a body-only write touches
 * nothing the link displays, and an unconditional upsert would bump the
 * ticket's `updated` on every doc write, waking a boss for a non-event.
 *
 * Returns a `SetDocResult` (BUTCHR-236) — a bounded receipt, never the body
 * it just wrote — built by `buildReceipt`'s own post-write read-back.
 */
export async function setDoc(ops: AtlassianOps, key: string, body: string, title?: string): Promise<SetDocResult> {
  const doc = await ensureDoc(ops, key);
  if (isProvisional(doc.title) && !title) {
    throw new Error(`set_doc: ${key}'s doc still has its provisional title ("${doc.title}") — pass \`title\` with a real, outcome-shaped title. You cannot write real content and leave the page reading as unwritten.`);
  }
  refuseIfGrowingOverBudget(`setDoc(${key})`, doc.body, body, DOC_BODY_CHAR_BUDGET);
  await ops.updatePage({ id: doc.id, body, ...(title ? { title } : {}) });
  const finalTitle = title ?? doc.title;
  if (title && title !== doc.title) {
    await ops.upsertRemoteLink(key, DOC_LINK_GLOBAL_ID, "documented by", { title: finalTitle, url: doc.url });
  }
  return buildReceipt(ops, doc.id, doc.url, finalTitle, body);
}
