import { createHash } from "node:crypto";
import type { AtlassianOps } from "./atlassian.js";
import { advanceProjectWatermark } from "../resources/project.js";
import { HTML4_NAMED_ENTITIES } from "./html4-named-entities.generated.js";
import { Refusal } from "./outcome.js";

/** The fixed remote-link globalId that carries the ticket -> doc binding. */
export const DOC_LINK_GLOBAL_ID = "butchr:doc";
/** Confluence label prefix carrying the doc -> ticket binding back. */
export const DOC_LABEL_PREFIX = "butchr-ticket-";
/** Marks a freshly created doc as obviously provisional (rule (e): staleness-that-reads-as-authoritative is the failure mode). */
const PROVISIONAL_MARKER = "[unwritten]";

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
 * already do that pre-write read (via `projectRootDoc`/`findDoc`) to
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
    throw new Refusal(
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
    throw new Refusal(`${who}: "${key}" is not a valid Jira key (expected [A-Z][A-Z0-9_]*-[0-9]+) — refusing rather than emitting a label that can't be inverted back to it`);
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

/**
 * FACTORY-909: Jira's NATIVE `fields.parent` — already on `issue`'s own
 * fetched payload (`jira.issues.getIssue`'s standard field set), never a
 * second Jira call, same cost profile as `findBossKey`. `issuetype` is
 * whatever the parent link stub hydrates (`fields.issuetype.name`),
 * `undefined` when the stub didn't carry it — never guessed.
 *
 * NOTE ON src/workspace/registry.ts's own `PARENT` finding (BUTCHR-169):
 * that comment records `parent` as empirically ALWAYS null for every issue
 * in the predecessor project at the time it was written. It is no longer
 * true today (FACTORY-908's diagnosis measured `parent` populated on dozens
 * of live FACTORY issues) — see this ticket's own fix to that comment. Read
 * this one, not that one, for the present-tense fact.
 */
export function nativeParentOf(issue: unknown): { key: string; issuetype: string | undefined } | null {
  const parent = (issue as { fields?: { parent?: { key?: string; fields?: { issuetype?: { name?: string } } } } })?.fields?.parent;
  if (!parent?.key) return null;
  return { key: parent.key, issuetype: parent.fields?.issuetype?.name };
}

/**
 * FACTORY-909: the native-parent tiers this fleet is willing to treat as an
 * EQUIVALENT boss relationship to an `Implements` link — the same two tiers
 * `adoptWorker` (src/tools/relationship.ts) already enforces for which
 * issue types it can staff as a worker (Story or Task), mirrored onto which
 * issue type each may be natively parented BY: a Story's native parent must
 * be an Epic, a Task's native parent must be a Story. Anything else (a
 * Task's native parent that is itself a Task, a parent of unknown type, a
 * Bug, …) is NOT an eligible tier — resolveBoss below reports that case as
 * `ineligibleParent` rather than silently granting boss status to a parent
 * the rest of this fleet's hierarchy was never built to let close one.
 */
export function isEligibleParentTier(childIssuetype: string | undefined, parentIssuetype: string | undefined): boolean {
  if (childIssuetype === "Story") return parentIssuetype === "Epic";
  if (childIssuetype === "Task") return parentIssuetype === "Story";
  return false;
}

/** `resolveBoss`'s own result shape — see that function's doc comment for what each field means and when it's set. */
export interface BossResolution {
  /** The resolved boss key, or `null` when there is none (today's "orphan" case, or an ineligible-parent case — see `ineligibleParent`). */
  boss: string | null;
  /** Which read produced `boss` — `"none"` covers both the orphan case and the ineligible-parent refusal case (both resolve `boss: null`). */
  source: "implements" | "parent" | "none";
  /** Set only when BOTH an Implements link and a native parent exist and DISAGREE — `boss` is still the Implements side (it always wins), this field exists purely so the caller can log the disagreement. */
  disagreement?: { implementsBoss: string; parent: string };
  /** Set only when there is NO Implements link, a native parent exists, but its tier is not one `isEligibleParentTier` recognises — the FACTORY-909 (B) warning-path trigger. */
  ineligibleParent?: { key: string; issuetype: string | undefined };
}

/**
 * FACTORY-909 (A): `findBossKey`'s own fallback — resolves a child's boss
 * via its native Jira `parent` field whenever there is no `Implements`
 * link, so a Story/Task filed under its Epic/Story via Jira's native
 * parent / Epic-link field ALONE is no longer an orphan. Stays pure and
 * I/O-free over `issue`'s own already-fetched payload, exactly like
 * `findBossKey` — `nativeParentOf` costs nothing beyond what the caller's
 * existing `getIssue` already paid for.
 *
 * PRECEDENCE, PER FACTORY-908's diagnosis: `Implements` ALWAYS wins when
 * both exist, even when they disagree — never the other way around, and
 * never "most recently written wins" or any other heuristic. A disagreement
 * is reported (not thrown — this function does no I/O and refuses nothing)
 * so the caller can log it; resolving the disagreement itself is a human or
 * `jira_link_issues` act, not this function's.
 */
export function resolveBoss(issue: unknown, childIssuetype: string | undefined): BossResolution {
  const implementsBoss = findBossKey(issue);
  const parent = nativeParentOf(issue);
  if (implementsBoss) {
    return parent && parent.key !== implementsBoss
      ? { boss: implementsBoss, source: "implements", disagreement: { implementsBoss, parent: parent.key } }
      : { boss: implementsBoss, source: "implements" };
  }
  if (parent) {
    return isEligibleParentTier(childIssuetype, parent.issuetype)
      ? { boss: parent.key, source: "parent" }
      : { boss: null, source: "none", ineligibleParent: parent };
  }
  return { boss: null, source: "none" };
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

/** BUTCHR-437: exported so `src/jira-watch/external-poll.ts` can resolve a description-derived Confluence URL to a page id without a second regex disagreeing with this one. */
export function pageIdFromUrl(url: string): string | null {
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
 * declared contract (`findDoc`, `setDoc`, `setProjectDoc`, and every
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
    throw new Refusal(`${who}: offset ${offset} is past the end of "${doc.title || doc.id}" (${total} characters) — refusing rather than silently clamping to the end`);
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
    throw new Refusal(`${who}: offset must be a non-negative integer — got ${JSON.stringify(offset)}`);
  }
  const l = limit ?? DEFAULT_GET_DOC_LIMIT_CHARS;
  if (!Number.isInteger(l) || l < 1) {
    throw new Refusal(`${who}: limit must be a positive integer — got ${JSON.stringify(limit)}`);
  }
  if (expectVersion !== undefined && (!Number.isInteger(expectVersion) || expectVersion < 1)) {
    throw new Refusal(`${who}: expectVersion must be a positive integer — got ${JSON.stringify(expectVersion)}`);
  }
  if (o > 0 && expectVersion === undefined) {
    throw new Refusal(
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
    throw new Refusal(`${who}: cannot honour expectVersion=${expectVersion} — this page read carried no version, so the pin is unverifiable. Refusing rather than assuming the document did not change under a multi-call read.`);
  }
  if (doc.version !== expectVersion) {
    throw new Refusal(
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
 * reader `findDoc` already calls below, rather than adding a second one.
 * NEVER CREATES A PAGE: a project's root doc always already exists (every
 * live product project, and ASSIST, is provisioned with one ahead of any
 * project agent running — BUTCHR-62's own doc), so unlike `findDoc` there
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
    throw new Refusal(`project ${projectKey}: "butchr" entity property is unreadable — refusing rather than guessing a root doc (${(e as Error).message})`);
  }
  const rootDocId = prop?.rootDoc?.id;
  if (!rootDocId) {
    throw new Refusal(`project ${projectKey}: "butchr" entity property is missing rootDoc.id — refusing rather than falling back to a space default`);
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
 * to `setDoc`. NEVER calls `findDoc`: a root doc always already exists
 * (see `projectRootDoc`), so there is no create/nest/label path here, only
 * resolve-then-replace. Unlike `setDoc`, `title` stays optional even on the
 * very first call: the `[unwritten]` provisional-title gate is an ISSUE-doc
 * concept (a freshly created per-ticket page needs a real title before it
 * can stop looking unwritten) — a root doc is provisioned ahead of time with
 * a real title already, so there is no provisional state to graduate out of.
 *
 * DEFECT 2 CLOSED HERE (BUTCHR-214/226) — the project wake predicate's
 * VERSION axis (src/resources/project.ts's `projectVerdict`) had NO
 * suppression at all: every root-doc body edit bumps Confluence's own page
 * version, and nothing but the project agent's own `check_in` ever advanced
 * the stored `wake.version` watermark to match — so a project that keeps its
 * doc current (every agent's explicit instruction) woke itself
 * deterministically, on every `set_doc` call, forever. Fixed with the SAME
 * identity-of-write shape `speakOnOwnChannel` already uses for the comment
 * axis (src/tools/speak.ts): immediately after `ops.updatePage` succeeds,
 * this advances THIS project's `wake.version` watermark to the version THAT
 * CALL'S OWN write produced (`updatePage`'s now-normalized `version` field —
 * see its own doc comment on `AtlassianOps` for why this is deliberately NOT
 * a read-back-after-write). A FOREIGN edit — any `updatePage` call this
 * function did not make — never runs this advance, so it is never
 * watermarked here and still wakes the project on the next poll, the same
 * failure condition `speakOnOwnChannel`'s own suppression must not swallow.
 *
 * Fail-open and logged, not fatal — copied from `speakOnOwnChannel`'s own
 * shape and its BUTCHR-105 reasoning (see that function's header comment):
 * the doc write already succeeded by the time this runs, and a secondary
 * bookkeeping failure must never surface as a failed `set_doc` call. A
 * rejected write here also feeds `advanceProjectWatermark`'s own in-process
 * fallback (DEFECT 1b, src/resources/project.ts) exactly like the comment
 * axis does, so a persistent failure on THIS axis gets the same protection
 * against waking the project on the very edit that failed to persist.
 *
 * ONLY the project root-doc path: `setDoc` (an issue's own doc, below) is a
 * different surface with no project watermark at all — it never calls this
 * function and nothing here reaches it.
 *
 * Returns a `SetDocResult` (BUTCHR-236) — a bounded receipt, never the body
 * it just wrote — built by `buildReceipt`'s own post-write read-back. That
 * read-back is independent of, and never feeds, the watermark advance
 * above: the watermark is deliberately identity-of-write (this call's own
 * `updatePage` version), while the receipt's `version` field is deliberately
 * a separate read-back (see `buildReceipt`'s own doc comment for why a
 * receipt needs "did it land", a different question from "what did THIS
 * write produce").
 */
export async function setProjectDoc(ops: AtlassianOps, projectKey: string, body: string, title?: string, log: (line: string) => void = console.error): Promise<SetDocResult> {
  const doc = await projectRootDoc(ops, projectKey);
  // BUTCHR-250's budget refusal runs BEFORE the write (same order as `setDoc`
  // above), so a refused write never happens — and therefore never advances a
  // watermark for a version that was never produced.
  refuseIfGrowingOverBudget(`setProjectDoc(${projectKey})`, doc.body, body, DOC_BODY_CHAR_BUDGET);
  // BUTCHR-214/226 defect 2: the watermark advance takes the version THIS
  // write produced (identity-of-write), never a value read back afterward — a
  // read-back would absorb a foreign bump racing into the gap and silently
  // swallow the operator's emergency wake channel. Pinned by
  // test/unit/project-resource-type.test.ts's identity-of-write test.
  const updated = await ops.updatePage({ id: doc.id, body, ...(title ? { title } : {}) });
  await advanceProjectWatermark(ops, projectKey, { version: updated.version }, log).catch((e) =>
    log(`  WARNING: [setProjectDoc] self-wake version watermark advance failed for ${projectKey} (version ${updated.version}): ${(e as Error)?.message ?? e} — doc write succeeded; project may nudge itself on its own version bump next poll`),
  );
  return buildReceipt(ops, doc.id, doc.url, title ?? doc.title, body);
}

/**
 * Reads `key`'s existing doc, if it has one. NEVER creates one, links one,
 * or infers a space/parent for one — FACTORY-84/FACTORY-86 retired Butchr's
 * own per-ticket auto-creation entirely (operator decision: no automatic
 * per-ticket Confluence docs at all; an agent that wants a fresh page
 * creates it explicitly, with `confluence_create_page`, naming its own
 * space and parent — Butchr adds no placement logic of its own). This is
 * now a thin, PUBLIC wrapper over `readLinkedPage` (this file's own direct,
 * immediately-consistent read of the `butchr:doc` remote link) — kept as its
 * own named export, rather than inlined at each call site, because
 * `set_doc`/`new_worker`/`adopt_worker`/`file_where_it_belongs` all need the
 * exact same "does this ticket already have a bound doc" read and none of
 * them may ever create one.
 *
 * A ticket that never had a doc bound to it (every ticket created after this
 * change) simply has none, forever, unless something outside Butchr's tool
 * surface links one by hand — there is no create-on-demand path left for
 * this binding. A page created via `confluence_create_page` is NOT
 * automatically bound to any ticket; nothing in this codebase performs that
 * binding anymore. Pre-existing docs (including ones still carrying the
 * `[unwritten]` provisional marker from before this change) are untouched
 * and keep working exactly as read/written today.
 */
export async function findDoc(ops: AtlassianOps, key: string): Promise<DocResult | null> {
  assertValidKey(key, "findDoc");
  return readLinkedPage(ops, key);
}

/**
 * Full-body replace of the CALLER'S OWN doc (`key` is always the caller's
 * own — see defs.ts; there is no key parameter on set_doc at all).
 *
 * NEVER CREATES A DOC (FACTORY-84/FACTORY-86): a ticket with no existing
 * doc gets a REFUSAL naming the situation and pointing at the explicit,
 * on-request path (`confluence_create_page`, with an explicit space and
 * parent) — never a lazily-manufactured page. `set_doc` on a ticket that
 * already has a linked doc is unaffected by this change and keeps working
 * exactly as before.
 *
 * While an EXISTING doc's title still carries the `[unwritten]` provisional
 * marker (a leftover from before this change — nothing can produce a fresh
 * one anymore), `title` is REQUIRED: an agent cannot write real content and
 * leave the page reading as unwritten. Once titled, `title` is optional and
 * omitting it keeps the current title.
 *
 * TITLE CHANGE -> RE-UPSERT THE LINK. If `updatePage` changes the title and
 * nothing else touches the link, the Jira ticket's human-visible web link is
 * stuck reading whatever the old title was forever, even after the doc is
 * genuinely written — exactly the stale-reads-as-authoritative failure rule
 * (f) names, and on the half of the binding a human actually looks at (PR
 * #112 review). The upsert is idempotent by globalId, so re-calling it here
 * can never create a second link — it only refreshes the one that already
 * exists. Only do this when the title actually changed: a body-only write
 * touches nothing the link displays, and an unconditional upsert would bump
 * the ticket's `updated` on every doc write, waking a boss for a non-event.
 *
 * Returns a `SetDocResult` (BUTCHR-236) — a bounded receipt, never the body
 * it just wrote — built by `buildReceipt`'s own post-write read-back.
 */
export async function setDoc(ops: AtlassianOps, key: string, body: string, title?: string): Promise<SetDocResult> {
  const doc = await findDoc(ops, key);
  if (!doc) {
    throw new Refusal(
      `set_doc: ${key} has no Confluence doc — Butchr no longer creates one automatically (FACTORY-84/FACTORY-86). ` +
        `If you need to write a Confluence page, create it explicitly with confluence_create_page (an explicit space and, optionally, a parent — nothing here will infer either for you). ` +
        `That page is a standalone Confluence page, not bound to this ticket's get_doc/set_doc: there is no longer a mechanism that links a freshly created page back to a ticket.`,
    );
  }
  if (isProvisional(doc.title) && !title) {
    throw new Refusal(`set_doc: ${key}'s doc still has its provisional title ("${doc.title}") — pass \`title\` with a real, outcome-shaped title. You cannot write real content and leave the page reading as unwritten.`);
  }
  refuseIfGrowingOverBudget(`setDoc(${key})`, doc.body, body, DOC_BODY_CHAR_BUDGET);
  await ops.updatePage({ id: doc.id, body, ...(title ? { title } : {}) });
  const finalTitle = title ?? doc.title;
  if (title && title !== doc.title) {
    await ops.upsertRemoteLink(key, DOC_LINK_GLOBAL_ID, "documented by", { title: finalTitle, url: doc.url });
  }
  return buildReceipt(ops, doc.id, doc.url, finalTitle, body);
}
