import { parsePrompt, keysToSelect, type Prompt } from "./prompt.js";
import { fingerprint, escalationComment, parseDirective, freeTextOption, MARKER, type Directive } from "./escalate.js";
import type { CaptureSink } from "./session-limit-watch.js";
import { findMarked, RateCap, HOUR_MS } from "./escalation-helper.js";
import type { CoverageRecorder } from "../daemon/coverage.js";
import { managedSessionShortDisplayId } from "../rules/session-definition-type.js";

const FOLLOWUP_MS = 15 * 60_000;
const DEBOUNCE_POLLS = 2;
// Comments filter by created-at-or-after the escalation, comparing Atlassian's
// server clock to the daemon's own. A grace window absorbs modest clock skew
// without risking much: parseDirective already rejects every butchr-authored
// comment, so this filter's only job is dropping genuinely pre-escalation noise.
const CLOCK_SKEW_GRACE_MS = 120_000;

export interface CommentRow { id: string; body: string; created: string }

/**
 * FACTORY-45: journal-line prefix for a KEYLESS managed-session pane's own
 * escalation (`issue === null`, filesystem-provider `managed-sessions` rule
 * — see docs/managed-sessions.md) — deliberately distinct from `[prompts]`
 * (this module's ordinary log wrapper) so an operator can `journalctl --user
 * -u <unit> | grep managed-escalation` and find every such event regardless
 * of how noisy the ordinary prompt log is. Real dialog recognition/auto-
 * answer is drovr's own job (FACTORY-46) — this fires only for a dialog
 * `watchPrompts` already decided it cannot auto-answer.
 */
export const MANAGED_ESCALATION_MARKER = "[managed-escalation]";

/**
 * FACTORY-45: a keyless pane's managed-session identity, resolved fresh on
 * every poll from the pane's own workspace path (`EscalatorDeps.managedSessionOf`)
 * — never persisted by this module. `agentKey` is the filesystem agent key
 * butchr's own managed-sessions rule assigned this definition
 * (`filesystem:managed-sessions:<encoded path>`, src/rules/agent-key.ts);
 * `definitionPath` is that key's decoded resource id — the definition
 * file's own path — which is what the journal line and the `/health`
 * sibling actually name for an operator.
 */
export interface ManagedSessionTarget {
  agentKey: string;
  definitionPath: string;
}

/** One currently-"stalled" managed session — the `/health` sibling `EscalatorDeps.log`'s journal line is paired with (see `Escalator.managedSessionEscalations`). */
export interface ManagedSessionEscalation {
  agentKey: string;
  definitionPath: string;
  paneId: string;
  fingerprint: string;
  /** ISO timestamp of this episode's first escalated poll. */
  since: string;
}

/**
 * BUTCHR-124: marker for the sustained-blocked-and-unparseable alarm —
 * deliberately distinct from escalate.ts's `MARKER` (`[butchr:blocked]`) so a
 * reader can tell the two apart at a glance: `[butchr:blocked]` means "here
 * is a decision you can make" (a fingerprint, an ANSWER protocol);
 * `[butchr:unresponsive]` means "come look at this pane" — there is no
 * parsed dialog, so there is nothing to answer. It carries NO fingerprint
 * and no ANSWER instructions, and (verified: neither `MARKER` nor any
 * `ANSWER `-prefixed line ever appears in `unresponsiveComment`'s output —
 * see the pinned test) is never picked up by `parseDirective`.
 */
export const UNRESPONSIVE_MARKER = "[butchr:unresponsive]";

/**
 * BUTCHR-171: the follow-up nudge's own discriminator, checked ALONGSIDE
 * (never instead of) a fingerprint substring — see the constant's use-site
 * below for why both are required together. Both the escalation
 * (`escalationComment`, escalate.ts) and this follow-up start with the SAME
 * `MARKER` and both mention the fingerprint in their text, which is exactly
 * why a single-signal discriminator is not safe here: this tag exists SO
 * THAT an escalation is never mistaken for an already-posted follow-up
 * (which would silently suppress a real escalation — the single most
 * dangerous direction, this epic's outcome inverted) and a follow-up is
 * never mistaken for an escalation (which would corrupt `escalatedAt`'s
 * origin, this file's `escalate()` adoption). Deliberately NOT reusing
 * escalate.ts's `fingerprint: ` (colon) spelling anywhere in the follow-up
 * text below — that exact substring is what `escalate()`'s own adoption
 * check anchors on, and reusing it would make a follow-up match it too.
 */
export const FOLLOWUP_STAGE = "[stage: followup]";

export interface EscalatorDeps {
  read: (paneId: string) => Promise<string>;
  send: (paneId: string, text: string) => Promise<void>;
  addComment: (issue: string, text: string) => Promise<void>;
  now: () => number;
  log: (line: string) => void;
  /**
   * BUTCHR-124: minutes a pane must be reported blocked, with text that does
   * not parse as a recognized dialog, CONTINUOUSLY (see onNoPrompt), before
   * the sustained-unresponsive alarm fires. Mirrors parkedMinutes/
   * idleDialogMinutes/stalledMinutes — an in-memory floor, so a daemon
   * restart mid-episode costs at most one threshold's delay (see onNoPrompt's
   * doc comment on `unresponsive`).
   */
  unresponsiveMinutes: number;
  /**
   * BUTCHR-124/BUTCHR-159: recent messages on `key`'s OWN CHANNEL — the
   * read-back symmetric to `addComment`'s `speakOnOwnChannel` routing (an
   * ISSUE's Jira comments for an issue key; a PROJECT's Confluence root-doc
   * FOOTER comments for a project key — see src/tools/speak.ts,
   * src/tools/docs.ts's `projectRootDoc`, and `AtlassianOps.getPageComments`'s
   * "per-page only, never the batch form" warning).
   *
   * THE ONLY comment-read dep on this interface: BUTCHR-159 removed the
   * former issue-only `comments` dep and rewired every reader in this file —
   * `escalate()`'s dedupe/adoption check, `handleBlocked`'s directive/
   * follow-up check, and `escalateUnresponsive`'s restart-adoption check —
   * through this one tier-aware seam instead. Before that, `escalate()` and
   * `handleBlocked` read the issue-only dep (a 404 for a project key) and
   * `.catch`ed a rejection into `[]` — a confident-zero that made "could not
   * check" indistinguishable from "checked, found nothing": it posted a
   * DUPLICATE escalation at the dedupe site, and — far worse, since neither
   * follow-up gate term below reads the fetch outcome — made a blocked
   * PROJECT agent's `ANSWER` unfindable FOREVER at the directive site while
   * telling its boss the daemon was still waiting.
   *
   * MUST FAIL BY REJECTING on any read failure — never resolve to an empty
   * array to represent "could not check": every caller below treats a
   * REJECTED promise as "could not verify — write nothing this poll, retry
   * next time" and a RESOLVED one (even an empty array) as "verified:
   * checked, and this is what's there".
   */
  ownChannelComments: (key: string) => Promise<CommentRow[]>;
  /**
   * BUTCHR-16: durable, LOCAL-DISK-ONLY landing spot for a blocked pane's
   * full text at the moment it escalates — evidence for the NEXT unknown
   * shape, since a pane holds no scrollback and the fixture for a dialog
   * Claude Code stops showing is gone within hours (the effort-recommendation
   * dialog this ticket exists to fix is the concrete case: nothing survived
   * it but an operator's hand transcription). Optional and injected, like
   * session-limit-watch's own CaptureSink: when absent, escalation behaves
   * exactly as it did before this ticket (comment only, no capture).
   *
   * FACTORY-50 (Part C): the SAME sink also lands a keyless managed-session
   * pane's full text via `captureManagedSessionEscalationText` — a
   * different filename shape (`MANAGED_ESCALATION_CAPTURE_NAME`), so the
   * two capture kinds never collide in listing or eviction, but the same
   * "optional, fails open, local disk only" contract.
   */
  captures?: CaptureSink;
  /**
   * BUTCHR-179: reports the unresponsive-alarm's own declining verification
   * (`escalateUnresponsive`'s `ownChannelComments` read) on `/health` — see
   * src/daemon/coverage.ts. `recordChecked("escalation:unresponsive")` on a
   * resolved read (adopted, rate-capped, or freshly posted — all a
   * completed check), `recordDeclined("escalation:unresponsive")` on the
   * caught rejection. Optional; omitted, coverage is simply not reported for
   * this dimension, exactly as before this ticket. The other two declining
   * sites in this module (`escalate`'s dedupe check, `handleBlocked`'s
   * directive/follow-up check) are NOT wired to this yet — see BUTCHR-179's
   * own report for why (deliberately scoped to two modules total, not all
   * declining call sites in this one).
   */
  coverage?: CoverageRecorder;
  /**
   * FACTORY-45: resolves `paneId` -> its managed-session identity, called
   * ONLY when `onBlocked` was given `issue === null` — never for a keyed
   * pane. Returns `null` for any OTHER keyless pane (an unowned/legacy
   * workspace, a query-level agent, …), which keeps today's log-only
   * behavior exactly for those — this ticket widens the keyless path only
   * for a pane that is genuinely a filesystem-provider `managed-sessions`
   * agent (see docs/managed-sessions.md). Optional: absent means no
   * managed-session awareness at all, byte-for-byte the same log-only
   * behavior as before this ticket.
   */
  managedSessionOf?: (paneId: string) => Promise<ManagedSessionTarget | null>;
  /**
   * PR #455 review: overrides `MANAGED_ESCALATION_CAPTURE_TIMEOUT_MS` for
   * `captureManagedSessionEscalationText` — exists so a test can inject a
   * short value (milliseconds) to exercise a hung read/write without an
   * actual multi-second wait or fake timers. Absent means the real,
   * production default.
   */
  managedSessionCaptureTimeoutMs?: number;
  /**
   * FACTORY-369: "post this text to this room" — the ONE narrow interface a
   * managed-session escalation is delivered through, injected so this
   * module never inlines a bare `fetch`/RC call. Bound to a specific room
   * (`#team-admin`) and identity by the caller (`src/daemon/index.ts`, from
   * `Config.managedEscalationRocketChat` / `RocketChatPoster`) — this
   * function takes only the fully-composed message text. MUST THROW on any
   * delivery failure (transport, RC refusal, anything) and MUST NOT be
   * called again concurrently for work this module has already retried —
   * every caller below treats a rejection as "not delivered — retry next
   * qualifying poll, never latch as handled" (AC 7), mirroring this file's
   * existing `escalateUnresponsive`/`escalate` fail-safe-by-not-latching
   * discipline for its Jira paths. Optional: absent means #team-admin
   * routing is not configured, and every managed-session escalation stays
   * exactly what it already was before this ticket — a loud, complete
   * `[managed-escalation]` journal line, nothing else (AC 6).
   */
  teamAdminNotify?: (text: string) => Promise<void>;
}

interface PaneState {
  fp: string;
  blockedPolls: number;
  /**
   * The pollSeq (see watchBlocked) at which `blockedPolls` was last
   * incremented for this exact fingerprint. undefined means "not yet
   * observed via a real poll" — freshly reset, waiting to re-earn the
   * debounce from zero. Consecutive means the next call's pollSeq is
   * EXACTLY one more than this: any gap (the pane wasn't blocked, or didn't
   * parse, on an intervening poll) or a different fp resets the count.
   */
  lastPollSeq: number | undefined;
  escalatedAt: number | undefined;
  followedUpAt: number | undefined;
}

const newState = (fp: string): PaneState =>
  ({ fp, blockedPolls: 0, lastPollSeq: undefined, escalatedAt: undefined, followedUpAt: undefined });

export interface Escalator {
  onBlocked: (paneId: string, issue: string | null, prompt: Prompt, pollSeq: number) => Promise<void>;
  /**
   * Called once per watchBlocked tick, synchronously, with the full set of
   * currently-blocked pane ids (see watchBlocked's onTick). Resets the
   * debounce for any tracked pane that is NOT in that set: a poll on which
   * the herd no longer reports a pane blocked is exactly as much a "this
   * fingerprint was not observed on a consecutive poll" event as a
   * different fingerprint would be, and nothing else can deliver that
   * signal — onBlocked is only ever called for panes that ARE blocked.
   */
  onPoll: (pollSeq: number, blockedPaneIds: readonly string[]) => void;
  /**
   * A pane the herd reports blocked whose text does not parse as a dialog
   * (see prompt-watch's onUnparseable). Resets the debounce like any other
   * gap, and logs — deduplicated by distinct text, never one line per poll
   * — so a real dialog the parser wrongly rejects shows up instead of
   * silently sitting stuck (KAN-682, applied to the parser).
   */
  onNoPrompt: (paneId: string, issue: string | null, text: string, pollSeq: number) => void;
  /**
   * FACTORY-45: every managed-session pane CURRENTLY marked stalled — an
   * escalated (logged), not-yet-resolved dialog on a keyless managed-session
   * pane. Read by `src/daemon/index.ts`'s `/health` wiring (a sibling field,
   * same "additive, never flips `ok`" pattern `admission`/`coverage` already
   * use — see src/daemon/health.ts) so an operator has a status SURFACE to
   * find a blocked managed session on, not only the journal line. A pure
   * snapshot of this instance's own in-memory tracking; empty when nothing
   * is stalled, or when `EscalatorDeps.managedSessionOf` was never wired.
   */
  managedSessionEscalations: () => readonly ManagedSessionEscalation[];
  /**
   * FACTORY-45 Part B: the two halves of drovr's host-neutral escalation
   * hook (`createBlockingEscalationWatcher`, `@brooswit/drovr` >= 0.15.0) —
   * pass this pair as `{ onUnknownDialog: escalator.onDrovrUnknownDialog,
   * onDialogResolved: escalator.onDrovrDialogResolved }` to that function
   * (see src/daemon/index.ts). Deliberately independent of `onBlocked`/
   * `onPoll`/`onNoPrompt` above: drovr's watcher carries its own
   * (pane, fingerprint) episode state in its own closure, so these never
   * touch the Jira-shaped `state` map or its pollSeq-based debounce — only
   * `managedSessionEscalations`'s own tracking, which `onBlocked`'s
   * Butchr-detected path (`handleManagedSessionBlocked`) also feeds. See
   * `onDrovrUnknownDialog`'s own doc comment for why a keyed or non-managed
   * keyless pane is a no-op here.
   */
  onDrovrUnknownDialog: (escalation: { paneId: string; question: string; options: readonly string[]; fingerprint: string }) => Promise<void>;
  onDrovrDialogResolved: (resolved: { paneId: string; fingerprint: string }) => void;
  /**
   * FACTORY-581 SAFETY GUARD 3 (butchr's half — see FACTORY-460's diagnosis
   * comment (c): "GUARD 3 spans two repos"): the third, previously
   * unattributed way a managed session's pane can clear — `@brooswit/drovr`
   * >= 0.16.8's own standalone lizard-mode pass
   * (`src/agents/permission-answer-loop.ts`'s `runPermissionAnswerTick`,
   * wired via its `deps.onAnswered`) PRESSING a tool-permission dialog,
   * distinct from both `onDrovrDialogResolved` above (an ESCALATED/unknown
   * dialog's own resolution — a human or something else, never butchr's own
   * answer pass) and the generic `onPoll` fallback below (a pane that simply
   * stopped being reported blocked, with neither of the other two
   * explaining why). Called for EVERY answered pane, managed session or
   * not — `clearManagedSessionStalled` is already a no-op for a `paneId`
   * with no tracked entry, so this costs nothing for a non-managed-session
   * pane and needs no identity check of its own.
   *
   * `recognizedVia` is threaded straight through from drovr's own
   * `AutoAnswerPermissionResult` (`PermissionPrompt["recognizedVia"]`:
   * `"separator" | "no-separator-mcp-tool" | "no-separator-bash" |
   * "no-separator-file-edit"`) rather than invented here — it is ALREADY the
   * distinct, attributable tag per drovr matcher (including the new
   * FACTORY-580/586/587 file-edit fallback), and reusing it is what makes
   * this line compose with drovr's own JSONL audit attribution
   * (`grep '"recognizedVia":"<value>"'`, `docs/permission-approval.md`
   * GUARD 3/7) instead of duplicating or contradicting it — the composition
   * FACTORY-460's diagnosis required.
   */
  onPermissionAnswered: (paneId: string, recognizedVia: string) => void;
}

/** Cheap FNV-1a 32-bit hash, for de-duplicating repeated unparseable text without storing it. */
function hashText(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * BUTCHR-124: max unresponsive-alarm comments per TARGET (issue or project
 * key) per hour, via the shared `RateCap` primitive (escalation-helper.ts).
 * Keyed by TARGET, deliberately NOT by pane — parked.ts's own choice, not
 * escalate()'s: escalate()'s per-pane budget makes sense there because its
 * dedupe key is the DIALOG's fingerprint, so a genuinely different dialog on
 * the SAME pane is a real, distinct, budget-worthy event. Here the dedupe
 * key (`paneKey`, below) is the PANE itself, not its content — so a repeat
 * episode on the SAME pane always finds and adopts that pane's one prior
 * comment (see `escalateUnresponsive`'s own doc comment on that tradeoff)
 * and never even reaches this check again. A per-PANE cap would therefore
 * only ever see each pane's fresh, all-allowed first attempt and could never
 * actually fire. What this cap protects against instead is what parked.ts's
 * target-keyed cap protects against: several DIFFERENT panes (e.g. an
 * agent's pane recreated by the herd under the same ticket, more than once
 * in an hour) each escalating their own fresh notice onto the SAME ticket.
 */
const UNRESPONSIVE_MAX_PER_HOUR = 3;

/**
 * The DEDUPE/ADOPTION key embedded in `unresponsiveComment`'s last line —
 * factored out so `escalateUnresponsive`'s `findMarked` lookup can never
 * drift from what the comment actually contains. Bracket-delimited on BOTH
 * sides, not bare `pane: ${paneId}`: `findMarked` (escalation-helper.ts)
 * matches by plain substring `includes`, so an unanchored needle is a real
 * false-positive-adoption risk whenever one pane id is a PREFIX of
 * another's — e.g. paneId `p1` would substring-match a DIFFERENT episode's
 * `pane: p12` line (`"pane: p12".includes("pane: p1")` is true). Rule 2b
 * (BUTCHR-124 review): a successful string match is not proof it matched
 * the RIGHT thing — the closing `]` is the post-condition that rules out
 * every longer paneId as a false match, without depending on trailing
 * whitespace (which Jira/Confluence may or may not preserve).
 */
function paneKey(paneId: string): string {
  return `pane: [${paneId}]`;
}

/**
 * The comment posted for a sustained blocked-and-unparseable pane.
 * Deliberately observational (report what was measured, let the reader
 * conclude — parked.ts's register) and deliberately carries NO fingerprint
 * and NO `ANSWER` instruction (§3c of BUTCHR-124): there is no parsed
 * dialog, so there is nothing to answer, and the comment must not look
 * answerable. `paneKey(paneId)` is a stable ADOPTION key for restart dedupe
 * (see `findMarked` below) — not a fingerprint, and not meant to be quoted
 * back the way `[butchr:blocked]`'s `fingerprint: <fp>` is.
 */
function unresponsiveComment(issue: string, paneId: string, elapsedMinutes: number): string {
  return [
    `${UNRESPONSIVE_MARKER} ${issue}'s pane has been reported blocked for ${elapsedMinutes} minute(s), and its text does not parse as a recognized dialog.`,
    "",
    "This is NOT an answerable prompt — there is no fingerprint here and no ANSWER protocol for it. A human should look at the pane directly and decide: answer whatever is actually on screen, restart the agent, or investigate why it is stuck.",
    "",
    paneKey(paneId),
  ].join("\n");
}

/** Global cap on escalation capture files kept at once — same discipline as session-limit-watch's CAPTURE_MAX_FILES, kept separate because it recognizes a different filename shape and must never evict a session-limit capture (or vice versa). */
const ESCALATION_CAPTURE_MAX_FILES = 50;

/**
 * `<ISSUE>-escalation-<compact-UTC-timestamp>.txt` OR (BUTCHR-96)
 * `<PROJECT>-escalation-<compact-UTC-timestamp>.txt` — recognizes exactly the
 * filenames this module writes, for BOTH an issue caller's id (`BUTCHR-68`,
 * `-\d+` suffix) and a project caller's bare key (`BUTCHR`, no suffix — see
 * `src/resources/id.ts`), so eviction (and a shared BUTCHR_CAPTURE_DIR
 * holding other files) never touches anything else's captures. The disjoint
 * half of that guarantee comes from the literal `-escalation-` segment, not
 * from the optional `-\d+`: session-limit-watch's own capture names use
 * `-unrecognised-` / `-no-reset-time-` in that position instead, so the two
 * shapes stay mutually exclusive regardless of the issue-vs-project prefix.
 */
const ESCALATION_CAPTURE_NAME = /^[A-Z][A-Z0-9]*(?:-\d+)?-escalation-(\d{8}T\d{6}Z)\.txt$/;

function compactUtc(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d\d\dZ$/, "Z");
}

/**
 * Durably capture the pane's full, UNREDACTED text to `deps.captures` at the
 * moment a NEW escalation comment is about to post — never on an adopted or
 * rate-capped one, since either means a comment (and, ordinarily, a capture)
 * already exists for this fingerprint. Redaction is deliberately skipped
 * here: this lands on local disk only (never Jira), exactly like
 * session-limit-watch's own captures, and only the returned PATH — never the
 * content — ever reaches `escalationComment`. Fails open: a capture failure
 * is logged once and must never block the escalation comment itself from
 * posting.
 */
async function captureEscalationText(deps: EscalatorDeps, paneId: string, issue: string): Promise<string | null> {
  const sink = deps.captures;
  if (!sink) return null;
  try {
    const text = await deps.read(paneId);
    const capturedAt = deps.now();
    const name = `${issue}-escalation-${compactUtc(capturedAt)}.txt`;
    const header =
      `# butchr escalation capture\n` +
      `# issue: ${issue}\n` +
      `# pane: ${paneId}\n` +
      `# captured-at: ${new Date(capturedAt).toISOString()}\n` +
      `# --- pane text follows verbatim (ANSI already stripped, UNREDACTED — local disk only) ---\n` +
      `\n`;
    const all = await sink.list();
    const ours = all
      .map((n) => ({ n, m: ESCALATION_CAPTURE_NAME.exec(n) }))
      .filter((x): x is { n: string; m: RegExpExecArray } => x.m !== null)
      .map((x) => ({ name: x.n, ts: x.m[1]! }))
      .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
    while (ours.length >= ESCALATION_CAPTURE_MAX_FILES) {
      const oldest = ours.shift()!;
      await sink.remove(oldest.name);
    }
    return await sink.write(name, header + text);
  } catch (e) {
    deps.log(`escalation capture failed for ${issue} pane ${paneId}: ${(e as Error)?.message ?? e}`);
    return null;
  }
}

/**
 * FACTORY-50 (Part C): global cap on managed-session escalation capture
 * files kept at once — same discipline as `ESCALATION_CAPTURE_MAX_FILES`
 * just above and session-limit-watch's own `CAPTURE_MAX_FILES`, kept
 * separate because it recognizes a different filename shape (there is no
 * issue/project key here — a managed session has neither) and must never
 * evict, or be evicted by, either sibling's captures.
 */
const MANAGED_ESCALATION_CAPTURE_MAX_FILES = 50;

/**
 * `<agentKey>-managed-escalation-<paneId>-<compact-UTC-timestamp>.txt` —
 * recognizes exactly the filenames `captureManagedSessionEscalationText`
 * writes. `agentKey` is already `encodeURIComponent`-escaped per component
 * (`encodeAgentKey`, src/rules/agent-key.ts) and this ticket's own path is
 * always the `filesystem` provider (see `ManagedSessionTarget`'s doc
 * comment), so it is filename-safe as written — no extra sanitizing needed.
 * Disjoint from `ESCALATION_CAPTURE_NAME` and session-limit-watch's
 * `CAPTURE_NAME` by the literal `-managed-escalation-` segment: those two
 * always key on an issue/project id, which this shape never has.
 */
const MANAGED_ESCALATION_CAPTURE_NAME = /^filesystem:[a-z0-9-]+:[A-Za-z0-9%._~-]+-managed-escalation-.+-(\d{8}T\d{6}Z)\.txt$/;

/**
 * PR #455 review: a capture that ERRORS is handled (logged, `null`
 * returned), but a capture that HANGS is not — `deps.read` (herdr's own
 * pane read) carries no deadline of its own (see drovr's DROVR-33, raised
 * for the exact same reason), and an unbounded `list`/`write` on the
 * injected sink is no safer. A few seconds, not milliseconds: a real pane
 * read is fast, and the failure mode this guards is a genuinely stuck
 * call, not ordinary latency.
 */
const MANAGED_ESCALATION_CAPTURE_TIMEOUT_MS = 5_000;

/**
 * FACTORY-50 (Part C): durably capture a keyless managed-session pane's
 * full, UNREDACTED text the moment `markManagedSessionStalled` marks a
 * genuinely NEW (pane, fingerprint) episode. Mirrors `captureEscalationText`
 * above: local disk only (never Jira — a managed session has no ticket to
 * post to), no redaction, and only the returned PATH — never the content —
 * ever reaches the `[managed-escalation]` journal line.
 *
 * PR #455 review: bounded by `MANAGED_ESCALATION_CAPTURE_TIMEOUT_MS` (or
 * `deps.managedSessionCaptureTimeoutMs`, for a test's short injected value)
 * via `Promise.race` against the real work below — a capture that ERRORS
 * OR HANGS must fail open the same way, since either would otherwise delay
 * or suppress the alarm line itself, hold `onBlocked`'s `inFlight` guard
 * open for that pane, and — through `onDrovrUnknownDialog` — stall drovr's
 * own serialized poll for every pane. The timer is cleared the instant
 * EITHER side settles, so a genuinely slow (not hung) capture that finishes
 * just after losing the race still completes its own write on local disk —
 * this only bounds how long `markManagedSessionStalled` itself waits, it
 * never cancels the underlying read/list/write — but its result is
 * discarded: a late resolution must never retroactively change the journal
 * line or any state already committed to.
 */
async function captureManagedSessionEscalationText(deps: EscalatorDeps, paneId: string, target: ManagedSessionTarget, fp: string): Promise<string | null> {
  const sink = deps.captures;
  if (!sink) return null;
  let timedOut = false;
  const work = (async (): Promise<string | null> => {
    try {
      const text = await deps.read(paneId);
      const capturedAt = deps.now();
      const name = `${target.agentKey}-managed-escalation-${paneId}-${compactUtc(capturedAt)}.txt`;
      const header =
        `# butchr managed-session escalation capture\n` +
        `# agent-key: ${target.agentKey}\n` +
        `# definition: ${target.definitionPath}\n` +
        `# pane: ${paneId}\n` +
        `# fingerprint: ${fp}\n` +
        `# captured-at: ${new Date(capturedAt).toISOString()}\n` +
        `# --- pane text follows verbatim (ANSI already stripped, UNREDACTED — local disk only) ---\n` +
        `\n`;
      const all = await sink.list();
      const ours = all
        .map((n) => ({ n, m: MANAGED_ESCALATION_CAPTURE_NAME.exec(n) }))
        .filter((x): x is { n: string; m: RegExpExecArray } => x.m !== null)
        .map((x) => ({ name: x.n, ts: x.m[1]! }))
        .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
      while (ours.length >= MANAGED_ESCALATION_CAPTURE_MAX_FILES) {
        const oldest = ours.shift()!;
        await sink.remove(oldest.name);
      }
      return await sink.write(name, header + text);
    } catch (e) {
      // "WARNING: [managed-escalation] ..." — NOT bare
      // `${MANAGED_ESCALATION_MARKER} ...` (matching `onDrovrUnknownDialog`'s
      // own resolve-failure log just below): a bare
      // `${MANAGED_ESCALATION_MARKER}`-prefixed line here would be
      // indistinguishable, to any `startsWith(MANAGED_ESCALATION_MARKER)`
      // reader (including this file's own tests), from the real
      // stalled-mark line this same poll already logs — turning one
      // escalation into two apparent ones. Suppressed entirely once this
      // capture has already lost the race below: a late-arriving error must
      // never log anything either, same as a late-arriving success.
      if (!timedOut) deps.log(`WARNING: [managed-escalation] capture failed for pane ${paneId} (${target.agentKey}): ${(e as Error)?.message ?? e}`);
      return null;
    }
  })();
  const timeoutMs = deps.managedSessionCaptureTimeoutMs ?? MANAGED_ESCALATION_CAPTURE_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<string | null>((resolve) => {
    timer = setTimeout(() => { timedOut = true; resolve(null); }, timeoutMs);
  });
  const result = await Promise.race([work, timeout]);
  clearTimeout(timer!);
  if (timedOut) deps.log(`WARNING: [managed-escalation] capture timed out after ${timeoutMs}ms for pane ${paneId} (${target.agentKey}) — logging the escalation without a capture path`);
  return result;
}

/**
 * The blocked-prompt escalation state machine: fingerprint a dialog, debounce
 * a transient block, escalate once per fingerprint to the blocked agent's own
 * ticket, watch for an `ANSWER` directive, verify it against the LIVE dialog
 * before ever sending a keystroke, and follow up once after 15 minutes of
 * silence. One Map of per-pane state; the daemon owns nothing but wiring.
 */
export function createEscalator(deps: EscalatorDeps): Escalator {
  const state = new Map<string, PaneState>();
  // watchBlocked/watchPrompts fire onBlocked/onExposed without awaiting the
  // previous call (they poll on a timer, not a queue), so createEscalator can
  // be re-entered for the SAME pane while an earlier call is still suspended
  // on a Jira round-trip. Without this guard two overlapping polls can both
  // observe `escalatedAt === undefined` and both post the escalation comment.
  const inFlight = new Set<string>();
  const paneEscalations = new Map<string, number[]>();
  const cappedPanes = new Set<string>();
  const log = (line: string) => deps.log(`[prompts] ${line}`);

  // KAN-756, item (D): consumed directive comment ids, kept PER PANE but
  // OUTSIDE PaneState so they survive every reset (a REFUSED directive, a
  // flicker, an unparseable poll, a fresh fingerprint) — not just the one
  // mechanism-2 originally reset. Without this a stale ANSWER comment is
  // re-read and re-refused on a loop for as long as the pane stays blocked.
  const consumedComments = new Map<string, Set<string>>();
  function consumedFor(paneId: string): Set<string> {
    let s = consumedComments.get(paneId);
    if (!s) { s = new Set(); consumedComments.set(paneId, s); }
    return s;
  }

  // KAN-756, item (C): one log line per pane per DISTINCT unparseable text,
  // not one per poll.
  const lastUnparseableHash = new Map<string, string>();

  // PR #40 review (comments 14969/14983): backstop against counting the
  // SAME escalation toward the budget more than once — a genuine daemon
  // restart (no in-memory PaneState) adopts every escalation it discovers,
  // and even in-session a fingerprint can be re-escalated after the pane
  // moved to a different dialog and back (a full, correct reset — the
  // carry-over above is deliberately keyed on the SAME fp only), which
  // re-adopts its own earlier comment. Keyed on FINGERPRINT, not comment
  // id: the freshly-posted path below has no id to key on either (addComment
  // returns void), and fp already has the right property — one escalation
  // comment ever exists per (pane, fp). Finding 2's deeper fix (escalatedAt
  // survives a flicker) closes the common case where adoption used to be
  // re-entered at all; this Set only ever needs to stop a fp from being
  // counted twice, never more.
  const countedFingerprints = new Map<string, Set<string>>();
  function countedFor(paneId: string): Set<string> {
    let s = countedFingerprints.get(paneId);
    if (!s) { s = new Set(); countedFingerprints.set(paneId, s); }
    return s;
  }

  // ===========================================================================
  // BUTCHR-124: sustained blocked-and-unparseable — a fully separate tracker
  // from `state`/PaneState above. Deliberately disjoint state: `state` exists
  // to debounce and then DELIVER an answer to a PARSEABLE dialog; this exists
  // only to ALARM on a pane that has none. Mixing them would risk exactly the
  // regression D7 forbids — any behaviour change to the parseable path.
  // ===========================================================================

  interface UnresponsiveEntry {
    /**
     * Daemon's first observation of this pane's CURRENT sustained-unparseable
     * episode — same reasoning as StalledTracker/IdleDialogTracker/
     * ParkedTracker: a conservative floor that can only DELAY the alarm
     * across a daemon restart (a fresh floor starts from the restart's first
     * qualifying poll), never fabricate one. Never persisted to disk — see
     * `unresponsiveMinutes`'s doc comment on EscalatorDeps for the restart
     * cost this implies.
     */
    firstObservedAt: number;
    /** The pollSeq this episode was last observed on — a gap (a different value than lastPollSeq+1) ends the episode, exactly like PaneState's own lastPollSeq. */
    lastPollSeq: number;
    /** Set once this episode has been through escalateUnresponsive (posted, adopted, or rate-capped) — gates further attempts for the SAME episode, mirroring PaneState.escalatedAt. */
    escalatedAt?: number;
  }
  const unresponsive = new Map<string, UnresponsiveEntry>();
  const unresponsiveInFlight = new Set<string>();
  /**
   * FACTORY-369 AC 2: the managed-session mirror of `unresponsive` above —
   * same shape (`UnresponsiveEntry`), same `deps.unresponsiveMinutes` gate,
   * same consecutive-pollSeq/gap-resets-the-episode semantics, but keyed
   * into `markManagedSessionStalled` (the SAME sink `handleManagedSessionBlocked`/
   * `onDrovrUnknownDialog` already use) once the threshold is reached,
   * instead of `escalateUnresponsive`'s Jira comment — a managed session has
   * no ticket to post an unresponsive-alarm comment on, same reason
   * `onBlocked`'s own `issue === null` branch needed `handleManagedSessionBlocked`
   * in the first place. See `handleManagedSessionUnresponsive` below.
   */
  const managedUnresponsive = new Map<string, UnresponsiveEntry>();
  const managedUnresponsiveInFlight = new Set<string>();
  const unresponsiveCap = new RateCap(UNRESPONSIVE_MAX_PER_HOUR, HOUR_MS);
  // BUTCHR-124 review (PR #180, non-blocking finding): mirrors parked.ts's
  // own `cappedLogged` — one WARNING per target while capped, not one per
  // poll, since (unlike a fresh episode) a capped episode is NOT latched
  // (see escalateUnresponsive's `null` return below) and therefore keeps
  // re-attempting, and re-checking the cap, on every qualifying poll until
  // the window frees up.
  const unresponsiveCappedLogged = new Set<string>();

  /**
   * Post (or adopt) the sustained-unresponsive notice for one episode.
   * Dedupe/adoption first, exactly like parked.ts's postStage — a daemon
   * restart mid-episode finds its own prior comment (keyed on `pane:
   * <paneId>`, a stable ADOPTION key, never presented as a fingerprint — see
   * unresponsiveComment's doc comment) and adopts it rather than re-posting.
   * KNOWN LIMITATION, same one parked.ts accepts for its own stage comments:
   * this dedupe is keyed on the pane alone, not on a per-episode identity, so
   * a LONG-AGO episode's comment (still sitting on the ticket) could in
   * principle be adopted by a genuinely NEW episode on the same pane much
   * later, silently skipping a fresh notice. Accepted deliberately, stated
   * here rather than hidden — see the doc for the full writeup.
   *
   * FAILS CLOSED — matching `escalate()`'s and `handleBlocked`'s own fix
   * (BUTCHR-159; before it, `escalate()`'s dedupe read `.catch`ed a
   * rejection into an empty array, a confident-zero this function was
   * written not to repeat — all three comment-reads in this file now share
   * this discipline): a rejected `deps.ownChannelComments` here is caught
   * HERE, logged, and turned into a `null` return — "could not verify, did
   * not write anything" — never a
   * silent fall-through to "nothing exists, safe to post". The caller
   * (onNoPrompt) must leave `escalatedAt` unset on a `null` result so the
   * NEXT qualifying poll retries, exactly like parked.ts's own
   * comments-fetch-failure branch (`rows === null` -> `return null` ->
   * nothing posted, nothing latched).
   *
   * A RATE-CAPPED attempt returns `null` for the SAME reason (review finding
   * on this ticket, matching parked.ts's own `postStage`, which returns
   * `null` for BOTH its failed-fetch AND its rate-cap branches): capped
   * means "not written this poll", not "handled" — the episode must stay
   * unlatched so it retries once the target's rolling-hour budget frees up,
   * rather than permanently dropping that pane's notice the moment a THIRD
   * pane's notice happened to land first.
   */
  async function escalateUnresponsive(paneId: string, issue: string, elapsedMinutes: number): Promise<number | null> {
    let rows: CommentRow[];
    try {
      rows = await deps.ownChannelComments(issue);
      // BUTCHR-179: a resolved read is a COMPLETED check, whatever it finds
      // downstream (adopted, rate-capped, or freshly posted) — coverage is
      // about whether verification happened, not what it decided.
      deps.coverage?.recordChecked("escalation:unresponsive");
    } catch (e) {
      log(`WARNING: [unresponsive] could not verify existing notices for ${issue} pane ${paneId} — skipping this poll's attempt rather than risk a duplicate: ${(e as Error)?.message ?? e}`);
      deps.coverage?.recordDeclined("escalation:unresponsive");
      return null;
    }
    const existing = findMarked(rows, UNRESPONSIVE_MARKER, [paneKey(paneId)]);
    if (existing) {
      log(`[unresponsive] adopted existing notice for ${issue} pane ${paneId} from comment ${existing.id} (daemon restart)`);
      return Date.parse(existing.created) || deps.now();
    }
    if (!unresponsiveCap.allow(issue, deps.now())) {
      if (!unresponsiveCappedLogged.has(issue)) {
        unresponsiveCappedLogged.add(issue);
        log(`WARNING: [unresponsive] rate cap reached (${UNRESPONSIVE_MAX_PER_HOUR}/hour) for ${issue} — pane ${paneId}'s notice is being logged only until the cap frees up (further cap hits for ${issue} are logged only once until it does)`);
      }
      return null; // not written — retry once the target's budget frees up, not dropped
    }
    unresponsiveCappedLogged.delete(issue);
    await deps.addComment(issue, unresponsiveComment(issue, paneId, elapsedMinutes));
    unresponsiveCap.record(issue, deps.now());
    log(`[unresponsive] escalated ${issue} pane ${paneId} (${elapsedMinutes}m sustained blocked+unparseable)`);
    return deps.now();
  }

  // ===========================================================================
  // FACTORY-45: the KEYLESS managed-session escalation — a fully separate
  // tracker from `state`/PaneState above, deliberately, same precedent
  // BUTCHR-124's `unresponsive` tracker sets just above: there is no issue
  // to comment on, no ANSWER directive to read back, and no 15-minute
  // follow-up for a managed session (docs/managed-sessions.md: no Implements
  // links, no boss/worker model) — reusing PaneState's Jira-shaped fields
  // for a concept that has none of them would only risk the very regression
  // this whole file's own precedent (item D7, KAN-756) forbids: a change to
  // the Jira flow's behaviour. Real dialog recognition/auto-answer is
  // drovr's job (FACTORY-46); this only logs + marks a dialog `watchPrompts`
  // ALREADY decided it cannot auto-answer.
  // ===========================================================================

  interface ManagedSessionEntry {
    target: ManagedSessionTarget;
    fp: string;
    /** ISO timestamp of this episode's first escalated poll — carried into `ManagedSessionEscalation.since`. */
    since: string;
    /** The dialog's question — `"(sustained unparseable pane — no recognized dialog)"` for the onNoPrompt path (FACTORY-369 AC 2), which has no parsed question at all. Retained (not just used once) so a #team-admin retry attempt on a LATER poll can recompose the exact same message without re-reading the pane. */
    question: string;
    options: readonly string[];
    /** `null` when no capture sink is wired, or the capture itself failed/timed out — see `captureManagedSessionEscalationText`. Never re-captured on a retry: the pane's live text may have already moved on. */
    capturePath: string | null;
    /** Set once `deps.teamAdminNotify` has been called and RESOLVED for this exact episode — AC 4/AC 7: a `undefined` value here (not "no notifier configured") is exactly what makes a retry attempt next poll, never a second attempt for an already-delivered post. */
    notifiedAt?: number;
  }
  const managedSessionStalled = new Map<string, ManagedSessionEntry>();
  // FACTORY-369: mirrors `inFlight`/`unresponsiveInFlight`'s own guard —
  // `deps.teamAdminNotify` is awaited, and this file's callers are
  // fire-and-forget on a timer, so two overlapping polls for the same pane
  // must never both be mid-POST at once (which could double-post if the
  // first's failure/success races the second's read of `notifiedAt`).
  const teamAdminInFlight = new Set<string>();
  /**
   * FACTORY-369 (AC 4 extension, FACTORY-367 comment 26602/26603): a
   * per-PANE cap on NEW #team-admin posts, independent of whether the
   * dedupe fingerprint itself stays stable. FACTORY-146 measured (FACTORY-357
   * generalised) that a dialog's recognized question/options can drift with
   * how much unrelated scrollback chatter sits above it — if that ever
   * degrades this pane's per-fingerprint dedupe to per-poll, this is the
   * backstop that keeps #team-admin from receiving an unbounded stream:
   * mirrors `escalate()`'s own per-pane rate cap for the Jira path above
   * (KAN-756 item E — keyed by PANE, not by target, for the identical
   * reason: a pane can rack up many distinct "new" fingerprints in a burst,
   * and the thing worth bounding is posts-per-pane, not posts-per-fingerprint,
   * which by construction only ever fires once each). This is NOT a fix for
   * the underlying recognizer instability (FACTORY-146/FACTORY-359's job) —
   * it only bounds the blast radius if that instability is present.
   */
  const MANAGED_TEAM_ADMIN_MAX_PER_HOUR = 3;
  const managedTeamAdminCap = new RateCap(MANAGED_TEAM_ADMIN_MAX_PER_HOUR, HOUR_MS);
  const managedTeamAdminCappedLogged = new Set<string>();

  /**
   * FACTORY-369 AC 3/AC 10: `@admin-assembly` normally, `@director` when the
   * STUCK SESSION IS admin-assembly itself (the routing spec's own
   * self-reference case, binding per FACTORY-358 comment 26435/FACTORY-367).
   * `sessionName` is the managed session's own bare display name
   * (`managedSessionShortDisplayId`, e.g. `"admin-assembly"` from
   * `.../admin-assembly.json`) — the same short id already shown in every
   * other managed-session surface (herdr labels, `/health`), so a reader
   * recognizes it without needing to know this ticket's internal `agentKey`
   * encoding.
   */
  function teamAdminMention(sessionName: string): string {
    return sessionName === "admin-assembly" ? "@director" : "@admin-assembly";
  }

  /**
   * FACTORY-369 AC 10: the post's text must stand alone for a HUMAN reading
   * #team-admin — legible without an agent to interpret it, because the
   * mentioned agent may be down for the same reason the session is (see
   * this file's own header note on AC 10, and FACTORY-367's "LATE-ARRIVING
   * REQUIREMENT" section). Every field the routing spec requires is a
   * labeled line: session name, pane id, the dialog's question and options,
   * the fingerprint, and the capture file path — never packed into prose a
   * reader has to parse.
   */
  function teamAdminMessage(target: ManagedSessionTarget, paneId: string, question: string, options: readonly string[], fp: string, capturePath: string | null): string {
    const sessionName = managedSessionShortDisplayId(target.definitionPath);
    const optionsLine = options.length ? options.map((o, i) => `${i + 1}. ${o}`).join(" | ") : "(none)";
    return [
      `${teamAdminMention(sessionName)} managed session **${sessionName}** is blocked and cannot answer for itself — it has no Jira ticket, so it cannot escalate the way a normal agent would.`,
      "",
      `session: ${sessionName}`,
      `pane: ${paneId}`,
      `question: ${question}`,
      `options: ${optionsLine}`,
      `fingerprint: ${fp}`,
      `capture: ${capturePath ?? "(none)"}`,
    ].join("\n");
  }

  /** The clear-up follow-up — FACTORY-369 AC 5, posted once when a dialog a notice was already sent about clears. */
  function teamAdminClearedMessage(target: ManagedSessionTarget, paneId: string, fp: string): string {
    const sessionName = managedSessionShortDisplayId(target.definitionPath);
    return `managed session **${sessionName}** (pane ${paneId}, fingerprint ${fp}) is no longer blocked — the dialog above has cleared.`;
  }

  /**
   * FACTORY-369: attempts the #team-admin post for `entry`'s CURRENT episode
   * — called both right after a fresh mark (AC 1/2) and, harmlessly, on
   * every repeat poll of an already-marked episode whose post has not yet
   * SUCCEEDED (AC 7's retry). A no-op the moment `entry.notifiedAt` is set
   * (delivered — never re-posted, AC 4) or `deps.teamAdminNotify` is absent
   * (not configured — AC 6 is already satisfied by the journal line
   * `markManagedSessionStalled` always writes regardless of this function).
   * FAILS OPEN and NEVER THROWS: a rejected post is logged and left
   * unlatched (`entry.notifiedAt` stays `undefined`) so the NEXT qualifying
   * poll retries — mirrors `escalateUnresponsive`'s own null-means-retry
   * discipline for the Jira path (AC 7).
   */
  async function attemptTeamAdminNotify(paneId: string, entry: ManagedSessionEntry): Promise<void> {
    if (entry.notifiedAt !== undefined) return;
    if (!deps.teamAdminNotify) return;
    if (teamAdminInFlight.has(paneId)) return;
    teamAdminInFlight.add(paneId);
    try {
      const text = teamAdminMessage(entry.target, paneId, entry.question, entry.options, entry.fp, entry.capturePath);
      await deps.teamAdminNotify(text);
      entry.notifiedAt = deps.now();
      deps.log(`${MANAGED_ESCALATION_MARKER} posted to #team-admin for ${entry.target.agentKey} pane ${paneId} fingerprint ${entry.fp}`);
    } catch (e) {
      deps.log(`WARNING: ${MANAGED_ESCALATION_MARKER} #team-admin post failed for ${entry.target.agentKey} pane ${paneId} fingerprint ${entry.fp} — will retry next qualifying poll: ${(e as Error)?.message ?? e}`);
    } finally {
      teamAdminInFlight.delete(paneId);
    }
  }

  /**
   * Log + mark once per (pane, fingerprint) episode — the shared core both
   * `handleManagedSessionBlocked` (Butchr's own KAN-756-hardened dialog
   * parser, below), `onDrovrUnknownDialog` (FACTORY-45 Part B: drovr's
   * `createBlockingEscalationWatcher` hook, src/daemon/index.ts), and
   * (FACTORY-369) `handleManagedSessionUnresponsive` (the sustained-
   * unparseable path, onNoPrompt below) all funnel into — three detectors,
   * one mark. A NO-OP whenever the TRACKED fingerprint for this pane is
   * unchanged (dedupe is the in-memory map itself, never a re-read of
   * anything external: there is no comment channel to adopt from, unlike
   * `escalate`/`escalateUnresponsive` above, so a daemon restart mid-episode
   * simply re-logs once — acceptable per this ticket's own reduced scope,
   * unlike the Jira flow's restart-safe adoption) EXCEPT that it still
   * retries the #team-admin post if that post has not yet succeeded
   * (FACTORY-369 AC 7) — the journal mark and the RC delivery are tracked
   * independently for exactly this reason. KNOWN, ACCEPTED RESIDUAL:
   * Butchr's own parser and drovr's may derive slightly different
   * fingerprints for the SAME real dialog (different text-extraction), so
   * the two detectors racing the same episode can each log once under their
   * own fingerprint — an extra journal line, never a functional miss, and
   * the mark still reads "stalled" correctly either way.
   *
   * FACTORY-50 (Part C): also durably captures the pane's full text via
   * `captureManagedSessionEscalationText` for a genuinely NEW episode
   * (never on a no-op re-entry) — the state map entry above is set BEFORE
   * that await, so an overlapping synchronous re-entry for the same fp
   * still short-circuits on the guard above and never double-captures.
   */
  async function markManagedSessionStalled(paneId: string, target: ManagedSessionTarget, question: string, options: readonly string[], fp: string): Promise<void> {
    const prior = managedSessionStalled.get(paneId);
    if (prior?.fp === fp) {
      await attemptTeamAdminNotify(paneId, prior); // already logged + marked this episode — only a pending RC retry remains to attempt
      return;
    }
    const since = new Date(deps.now()).toISOString();
    const capturePath = await captureManagedSessionEscalationText(deps, paneId, target, fp);
    const entry: ManagedSessionEntry = { target, fp, since, question, options, capturePath };
    managedSessionStalled.set(paneId, entry);
    const optionsLine = options.length ? options.map((o, i) => `${i + 1}. ${o}`).join(" | ") : "(none)";
    // AC 6: this line fires unconditionally, whether or not #team-admin
    // routing is configured — a loud, complete journal line is the
    // not-configured fallback, and a diagnostic record either way.
    deps.log(`${MANAGED_ESCALATION_MARKER} ${target.agentKey} (definition: ${target.definitionPath}) pane ${paneId} blocked on an unrecognized dialog and has no issue to escalate to — marked stalled. question: "${question}" options: ${optionsLine} fingerprint: ${fp}${capturePath ? ` capture: ${capturePath}` : ""}`);
    // AC 4 extension: the journal line above always fires (it's this
    // ticket's not-configured fallback, AC 6) — only the #team-admin POST
    // is capped, and only per-PANE, so a genuinely stable fleet (one real
    // dialog, one fingerprint) never comes near this and a drifting one is
    // bounded rather than unbounded.
    if (!managedTeamAdminCap.allow(paneId, deps.now())) {
      if (!managedTeamAdminCappedLogged.has(paneId)) {
        managedTeamAdminCappedLogged.add(paneId);
        deps.log(`WARNING: ${MANAGED_ESCALATION_MARKER} #team-admin rate cap reached (${MANAGED_TEAM_ADMIN_MAX_PER_HOUR}/hour) for pane ${paneId} — further managed-session dialogs on this pane are being logged only until the cap frees up`);
      }
      return;
    }
    managedTeamAdminCappedLogged.delete(paneId);
    managedTeamAdminCap.record(paneId, deps.now());
    await attemptTeamAdminNotify(paneId, entry);
  }

  /** The clear/resolve half of `markManagedSessionStalled` — a no-op if nothing is currently marked for `paneId`. FACTORY-369 AC 5: fires the clear-up follow-up post once, but only for an episode that was actually delivered to #team-admin (`notifiedAt` set) — an episode nobody was ever told about needs no "never mind". */
  function clearManagedSessionStalled(paneId: string, reason: string): void {
    const entry = managedSessionStalled.get(paneId);
    if (!entry) return;
    managedSessionStalled.delete(paneId);
    deps.log(`${MANAGED_ESCALATION_MARKER} pane ${paneId} ${reason} — clearing stalled mark`);
    if (entry.notifiedAt !== undefined && deps.teamAdminNotify) {
      const text = teamAdminClearedMessage(entry.target, paneId, entry.fp);
      void deps.teamAdminNotify(text).catch((e) =>
        deps.log(`WARNING: ${MANAGED_ESCALATION_MARKER} #team-admin clear-up post failed for ${entry.target.agentKey} pane ${paneId} fingerprint ${entry.fp}: ${(e as Error)?.message ?? e}`),
      );
    }
  }

  async function handleManagedSessionBlocked(paneId: string, target: ManagedSessionTarget, prompt: Prompt): Promise<void> {
    await markManagedSessionStalled(paneId, target, prompt.question, prompt.options, fingerprint(prompt));
  }

  /**
   * FACTORY-45 Part B: the other end of drovr's host-neutral escalation
   * hook (`createBlockingEscalationWatcher`, `@brooswit/drovr` >= 0.15.0) —
   * wired in `src/daemon/index.ts`. Drovr's own watcher already dedupes a
   * dialog to exactly one call per (pane, fingerprint) episode in ITS OWN
   * closure (see that package's docs/blocking-escalation.md), so this never
   * re-derives a fingerprint of its own; it only decides WHERE the episode
   * goes. `deps.managedSessionOf` resolving to `null` — a keyed pane, or a
   * keyless pane that isn't a managed session — is deliberately a no-op
   * here: Butchr's OWN existing pipeline (`onBlocked`'s own `issue`/
   * `managedSessionOf` resolution) stays the authoritative detector and
   * escalator for both of those, completely unchanged by this ticket.
   */
  async function onDrovrUnknownDialog(escalation: { paneId: string; question: string; options: readonly string[]; fingerprint: string }): Promise<void> {
    if (!deps.managedSessionOf) return;
    let target: ManagedSessionTarget | null;
    try {
      target = await deps.managedSessionOf(escalation.paneId);
    } catch (e) {
      deps.log(`WARNING: [managed-escalation] could not resolve managed-session identity for pane ${escalation.paneId} (drovr hook): ${(e as Error)?.message ?? e}`);
      return;
    }
    if (!target) return;
    await markManagedSessionStalled(escalation.paneId, target, escalation.question, escalation.options, escalation.fingerprint);
  }

  /** The resolution half of `onDrovrUnknownDialog` — drovr's own `hook.onDialogResolved`. Only clears an episode THIS fingerprint opened; a stale/foreign fingerprint (the episode already moved on, e.g. a newer one Butchr's own parser logged in the meantime) is left alone rather than clearing a live mark on a guess. */
  function onDrovrDialogResolved(resolved: { paneId: string; fingerprint: string }): void {
    const prior = managedSessionStalled.get(resolved.paneId);
    if (!prior || prior.fp !== resolved.fingerprint) return;
    clearManagedSessionStalled(resolved.paneId, "no longer blocked (drovr)");
  }

  /** See `Escalator.onPermissionAnswered`'s own doc comment. */
  function onPermissionAnswered(paneId: string, recognizedVia: string): void {
    clearManagedSessionStalled(paneId, `no longer blocked (answered: recognizedVia=${recognizedVia})`);
  }

  /** Every managed session CURRENTLY marked stalled — see `Escalator.managedSessionEscalations`'s own doc comment. */
  function managedSessionEscalations(): readonly ManagedSessionEscalation[] {
    return [...managedSessionStalled.entries()].map(([paneId, e]) => ({
      agentKey: e.target.agentKey, definitionPath: e.target.definitionPath, paneId, fingerprint: e.fp, since: e.since,
    }));
  }

  /**
   * BUTCHR-159: the dedupe/adoption read routes through `deps.
   * ownChannelComments` — the tier-aware reader (an issue's Jira comments,
   * or a project's Confluence root-doc footer comments) — and FAILS CLOSED
   * on a rejected read: a read this function cannot verify must never be
   * treated as "no prior escalation exists". Before this fix that reading
   * posted a DUPLICATE on the issue tier, and was permanently wrong on the
   * project tier (an issue-shaped read against a project key is the WRONG
   * RESOURCE, not merely a flaky one — it failed every time, forever). A
   * failed read here leaves `s.escalatedAt` unset, so the NEXT qualifying
   * poll retries this function from scratch — nothing is posted, and
   * nothing is lost, only delayed.
   */
  async function escalate(paneId: string, issue: string, prompt: Prompt, fp: string, s: PaneState): Promise<void> {
    let rows: CommentRow[];
    try {
      rows = await deps.ownChannelComments(issue);
    } catch (e) {
      log(`WARNING: [escalate] could not verify existing escalation for ${issue} pane ${paneId} — skipping this poll's attempt rather than risk a duplicate: ${(e as Error)?.message ?? e}`);
      return;
    }
    const existing = rows.find((r) => r.body.startsWith(MARKER) && r.body.includes(`fingerprint: ${fp}`));
    const counted = countedFor(paneId);
    if (existing) {
      const adoptedAt = Date.parse(existing.created) || deps.now();
      s.escalatedAt = adoptedAt;
      // KAN-756, item (F): an escalation adopted after a daemon restart is
      // still an escalation comment that exists on the ticket — the spec is
      // explicit that it counts toward the hourly budget. Recorded at the
      // COMMENT's own timestamp, not deps.now(), so a restart adopting three
      // hour-old escalations doesn't grant a fresh budget it didn't earn.
      // Counted at most once per fingerprint (the backstop above).
      if (!counted.has(fp)) {
        counted.add(fp);
        const recent = (paneEscalations.get(paneId) ?? []).filter((t) => deps.now() - t < 60 * 60_000);
        recent.push(adoptedAt);
        paneEscalations.set(paneId, recent);
      }
      log(`adopted existing escalation ${issue} fp=${fp} from comment ${existing.id} (daemon restart)`);
      return;
    }
    // Rate cap: at most 3 escalation comments per pane per hour. Beyond that,
    // one summary notice, then log-only — a misbehaving parser must never be
    // able to spam a ticket unboundedly. KAN-756, item (E): keyed by PANE,
    // not issue — a pane can outlive an issue key in the herd (e.g. an
    // agent's pane is recreated under the same ticket), and a budget tied to
    // the issue would wrongly carry over to what is, from the daemon's
    // perspective, a fresh pane.
    const HOUR = 60 * 60_000;
    const recent = (paneEscalations.get(paneId) ?? []).filter((t) => deps.now() - t < HOUR);
    if (recent.length >= 3) {
      if (!cappedPanes.has(paneId)) {
        cappedPanes.add(paneId);
        await deps.addComment(issue, `${MARKER} ${issue}: escalation rate cap reached (3/hour) — further blocked-prompt changes are being logged only. An operator or parent can still reply ANSWER <n> <fingerprint> against the latest logged fingerprint.`);
      }
      s.escalatedAt = deps.now();
      log(`RATE-CAPPED escalation ${issue} fp=${fp} (log-only) "${prompt.question.slice(0, 60)}"`);
      return;
    }
    recent.push(deps.now());
    paneEscalations.set(paneId, recent);
    counted.add(fp);
    cappedPanes.delete(paneId);
    const capturePath = await captureEscalationText(deps, paneId, issue);
    await deps.addComment(issue, escalationComment(issue, prompt, fp, capturePath));
    s.escalatedAt = deps.now();
    log(`escalated ${issue} fp=${fp} "${prompt.question.slice(0, 60)}"${capturePath ? ` (captured to ${capturePath})` : ""}`);
  }

  async function handleDirective(paneId: string, issue: string, directive: Directive, s: PaneState): Promise<void> {
    // THE VERIFICATION GUARD: never trust the prompt/state passed into this
    // call for delivery — re-read and re-parse the pane RIGHT NOW, because the
    // dialog may have moved on since it was escalated or since the directive
    // was posted. A stale answer selecting an option in a different dialog is
    // the one failure mode this whole function exists to prevent.
    const text = await deps.read(paneId);
    const fresh = parsePrompt(text);
    const freshFp = fresh ? fingerprint(fresh) : null;
    const matches = fresh !== null && freshFp === s.fp && (directive.fp === null || directive.fp === s.fp);

    if (!matches) {
      const directiveFp = directive.fp ?? s.fp;
      log(`REFUSED directive on ${issue}: fingerprint ${directiveFp} no longer matches pane (${freshFp ?? "no prompt"}) — re-escalating`);
      state.delete(paneId);
      if (fresh) {
        // Do NOT escalate the fresh dialog immediately: a moving pane is how
        // transient prose masquerades as dialogs (measured: 3 escalations in
        // 2 minutes). The fresh fingerprint must re-earn the debounce through
        // handleBlocked like any other. consumedComments is untouched here —
        // it lives outside PaneState precisely so this reset cannot forget a
        // comment id already acted on (item D).
        state.set(paneId, newState(freshFp!));
      }
      return;
    }

    if (directive.kind === "option") {
      if (directive.n < 1 || directive.n > fresh!.options.length) {
        log(`REFUSED ANSWER ${directive.n} on ${issue}: out of range (1..${fresh!.options.length})`);
        return;
      }
      await deps.send(paneId, keysToSelect(fresh!.current, directive.n));
      log(`delivered ANSWER ${directive.n} ("${fresh!.options[directive.n - 1]}") to ${issue} pane ${paneId}`);
      return;
    }

    const i = freeTextOption(fresh!);
    if (i === null) {
      log(`REFUSED ANSWER TEXT on ${issue}: no free-text option on this dialog`);
      await deps.addComment(issue, `${MARKER} ${issue}: no free-text option exists on this dialog — reply with \`ANSWER <n> ${s.fp}\` instead.`);
      return;
    }
    await deps.send(paneId, keysToSelect(fresh!.current, i));
    log(`delivered ANSWER TEXT to ${issue} pane ${paneId}: selected option ${i} ("${fresh!.options[i - 1]}")`);
    await deps.send(paneId, directive.text);
    log(`sent free text to ${issue} pane ${paneId}`);
    await deps.send(paneId, "\r");
    log(`submitted (Enter) to ${issue} pane ${paneId}`);
  }

  async function handleBlocked(paneId: string, issue: string, prompt: Prompt, pollSeq: number): Promise<void> {
    const fp = fingerprint(prompt);
    const prior = state.get(paneId);

    // Out-of-order async guard: onExposed/onBlocked are fire-and-forget, so a
    // LATER poll's result can resolve before an EARLIER one's. A pollSeq at
    // or behind what this pane has already processed is stale — a more
    // current observation has already superseded it — and must never be
    // allowed to fabricate or destroy a reset by being applied out of order.
    if (prior && prior.lastPollSeq !== undefined && pollSeq <= prior.lastPollSeq) {
      log(`ignored stale poll ${pollSeq} for ${issue} pane=${paneId} (already at ${prior.lastPollSeq})`);
      return;
    }

    // "Consecutive" means consecutive polls OF THE WATCHER: the same
    // fingerprint, observed on the very next pollSeq. Any gap — the pane
    // wasn't blocked, or didn't parse, on an intervening poll (both reset
    // the debounce fields in place via onPoll/onNoPrompt below, WITHOUT
    // discarding the rest of the pane's state) — or a different
    // fingerprint, resets the debounce count to a fresh first observation.
    const consecutive = !!prior && prior.fp === fp && prior.lastPollSeq !== undefined && pollSeq === prior.lastPollSeq + 1;
    if (!consecutive && prior) {
      log(`debounce reset ${issue} pane=${paneId}: ${prior.fp !== fp ? `fp changed (${prior.fp} -> ${fp})` : "poll gap"}`);
    }
    let s: PaneState;
    if (consecutive) {
      s = prior!;
    } else {
      s = newState(fp);
      // PR #40 review, Finding 2: a gap (flicker, unparseable poll) must
      // reset ONLY the debounce fields. If the SAME dialog reappears after
      // one, it is not a new escalation attempt — carrying escalatedAt/
      // followedUpAt forward is what lets handleBlocked skip straight past
      // the (now irrelevant) debounce below and into the directive/
      // follow-up phase, instead of re-entering escalate() and adopting
      // the same comment again (which used to double-count the rate-cap
      // budget) and silently losing the 15-minute follow-up timer on every
      // flicker. A genuinely DIFFERENT fingerprint (prior.fp !== fp) does
      // NOT carry over — that is a new dialog and must start clean.
      if (prior && prior.fp === fp) {
        s.escalatedAt = prior.escalatedAt;
        s.followedUpAt = prior.followedUpAt;
      }
    }
    state.set(paneId, s);
    s.lastPollSeq = pollSeq;
    s.blockedPolls++;
    // Once escalated, the debounce is irrelevant — a carried-over
    // escalatedAt (same fp, reappeared after a gap) must fall straight
    // through to the directive/follow-up phase below regardless of
    // blockedPolls, or the carry-over above would be pointless: the pane
    // would sit "debouncing" a dialog it already escalated.
    if (s.escalatedAt === undefined && s.blockedPolls < DEBOUNCE_POLLS) {
      log(`debounce ${issue} fp=${fp} (poll ${s.blockedPolls}/${DEBOUNCE_POLLS})`);
      return;
    }

    if (s.escalatedAt === undefined) {
      await escalate(paneId, issue, prompt, fp, s);
      return;
    }

    // BUTCHR-159: routes through the tier-aware reader and FAILS CLOSED — a
    // read this function cannot verify must never be treated as "nobody
    // replied". Before this fix the read `.catch`ed a rejection into an
    // empty array and fell straight through to the follow-up gate below
    // (neither gate term reads the fetch outcome, only elapsed time), so a
    // failed read didn't just lose the ANSWER — it told the boss the daemon
    // was STILL WAITING while the unread ANSWER sat a few rows above the
    // nudge. A failed read now returns before that gate is even reached:
    // nothing is posted, and `s.followedUpAt` stays unset so the NEXT
    // qualifying poll retries — a suppressed follow-up delays, never loses.
    let rows: CommentRow[];
    try {
      rows = await deps.ownChannelComments(issue);
    } catch (e) {
      log(`WARNING: [directive] could not verify ${issue}'s own channel for pane ${paneId} — skipping this poll's directive/follow-up check rather than risk a false "nobody replied": ${(e as Error)?.message ?? e}`);
      return;
    }
    const escalatedAtMs = s.escalatedAt;
    const consumed = consumedFor(paneId);
    let directive: Directive | null = null;
    let directiveCommentId: string | null = null;
    for (const r of rows) {
      // BUTCHR-171 review fix (Finding 1): `Date.parse(r.created)` on an
      // empty/unparseable `created` is `NaN`, and `NaN < x` is ALWAYS
      // `false` — an unguarded comparison here treats "recency unknown"
      // identically to "definitely current", reopening this ticket's own
      // replay hazard for exactly the row shape (no retrievable timestamp)
      // it exists to close. Explicit and deliberate, matching this file's
      // own EscalatorDeps doc comment on `ownChannelComments` ("MUST FAIL
      // BY REJECTING... never resolve to empty to represent 'could not
      // check'"): a row whose recency cannot be verified is treated as
      // suspect and skipped, the same conservative default this file
      // already applies when the whole channel read fails, not treated as
      // safe-by-default. The tradeoff this accepts is the opposite
      // direction: a genuine ANSWER on a row with NO retrievable timestamp
      // (measured live as essentially unreachable — `version.createdAt` is
      // populated on the default response, see AtlassianOps.getPageComments)
      // would never be found. Given the choice, replaying a stale decision
      // into a live pane is the worse failure of the two — an action taken
      // on unverifiable grounds, not merely a missed reminder.
      const createdMs = Date.parse(r.created);
      if (Number.isNaN(createdMs) || createdMs < escalatedAtMs - CLOCK_SKEW_GRACE_MS) continue;
      if (consumed.has(r.id)) continue; // an answer is consumed exactly once, across fingerprint resets
      const d = parseDirective(r.body);
      if (d) { directive = d; directiveCommentId = r.id; break; } // newest-first comments(); first match wins
      if (r.body.trimStart().startsWith(MARKER) && /^\s*ANSWER /m.test(r.body)) {
        log(`ignored an answer on ${issue} (comment ${r.id}) that quotes the escalation marker; reply without quoting`);
      }
    }

    if (directive && directiveCommentId) {
      // Record BEFORE the delivery side effects run: a send() that throws must
      // never leave the directive re-armed for the next poll to replay.
      consumed.add(directiveCommentId);
      log(`directive seen on ${issue}: ${JSON.stringify(directive)}`);
      await handleDirective(paneId, issue, directive, s);
      return;
    }

    if (s.followedUpAt === undefined && deps.now() - escalatedAtMs >= FOLLOWUP_MS) {
      // BUTCHR-171: durable dedupe, mirroring escalate()'s own restart-safe
      // adoption — read-the-channel-and-adopt-your-own-prior-comment instead
      // of trusting the in-memory `followedUpAt` alone (which a restart
      // clears, turning "no memory of nudging" into "never nudged"). Reuses
      // the SAME `rows` already fetched above for the directive scan — one
      // channel snapshot per poll, not a second read. `FOLLOWUP_STAGE` plus
      // the fingerprint is required TOGETHER so this can only ever adopt
      // ITS OWN prior follow-up for THIS episode's fingerprint, never a
      // stale follow-up for a since-replaced dialog, and — the collision
      // this constant's own doc comment names — never the escalation
      // comment itself, which carries neither `FOLLOWUP_STAGE` nor this
      // parenthesised fingerprint spelling.
      const existingFollowup = findMarked(rows, MARKER, [FOLLOWUP_STAGE, `(fingerprint ${s.fp})`]);
      if (existingFollowup) {
        s.followedUpAt = Date.parse(existingFollowup.created) || deps.now();
        log(`adopted existing follow-up ${issue} fp=${s.fp} from comment ${existingFollowup.id} (daemon restart)`);
      } else {
        await deps.addComment(
          issue,
          `${MARKER} ${issue} still waiting on the decision above (fingerprint ${s.fp}) — answer it, or if you cannot decide, say so ON YOUR OWN ticket: a Story's or Task's boss reads that ticket regardless of status, but an Epic's project boss reads it only while the epic is In Review — an In Progress epic reaches nobody this way. Post it anyway: only a PERSON READING THIS TICKET DIRECTLY will see it, no agent will answer, and you must not wait as though one will. ${FOLLOWUP_STAGE}`,
        );
        s.followedUpAt = deps.now();
        log(`follow-up posted ${issue} fp=${s.fp}`);
      }
    }
  }

  async function onBlocked(paneId: string, issue: string | null, prompt: Prompt, pollSeq: number): Promise<void> {
    if (issue === null) {
      // FACTORY-45: widen the keyless path ONLY for a pane that is
      // genuinely a filesystem-provider `managed-sessions` agent — every
      // OTHER keyless pane (an unowned/legacy workspace, a query-level
      // agent, ...) keeps today's log-only behavior exactly (5.: "do not
      // widen the change"). `managedSessionOf` is called fresh every poll
      // rather than cached: it is cheap (one herd.agent.list() the caller
      // already needed to resolve `issue` itself — see daemon/index.ts's
      // `issueForPane`), and a pane's own identity cannot change mid-life.
      if (inFlight.has(paneId)) {
        log(`skipped overlapping poll for ${paneId} — no issue key, a previous poll is still in flight`);
        return;
      }
      inFlight.add(paneId);
      try {
        const session = deps.managedSessionOf ? await deps.managedSessionOf(paneId) : null;
        if (session) await handleManagedSessionBlocked(paneId, session, prompt);
        else log(`${paneId} blocked with an unanswerable prompt but no issue key — cannot escalate`);
      } catch (e) {
        log(`error handling ${paneId}: ${(e as Error)?.message ?? e}`);
      } finally {
        inFlight.delete(paneId);
      }
      return;
    }
    if (inFlight.has(paneId)) {
      log(`skipped overlapping poll for ${paneId} on ${issue} — a previous poll is still in flight`);
      return;
    }
    inFlight.add(paneId);
    try {
      await handleBlocked(paneId, issue, prompt, pollSeq);
    } catch (e) {
      log(`error handling ${paneId}: ${(e as Error)?.message ?? e}`);
    } finally {
      inFlight.delete(paneId);
    }
  }

  // PR #40 review, Finding 2 (comments 14976/14983): a gap resets ONLY the
  // debounce fields (blockedPolls, lastPollSeq), in place — it must never
  // discard escalatedAt/followedUpAt. Deleting the whole entry (the
  // original shape) silently regressed KAN-732's 15-minute follow-up on
  // any pane whose herd status flickers — measured on a flickering,
  // already-escalated pane: zero follow-ups, ever, because the adoption
  // branch `return`s as soon as it re-sets escalatedAt, so the follow-up
  // check further down handleBlocked was never reached, and the NEXT
  // flicker deleted the state again before any later poll could reach it
  // either. It also forced escalate() to re-adopt the same comment on
  // every flicker, which is what caused item (F)'s rate-cap budget to
  // double-count in the first place. consumedComments/paneEscalations/
  // cappedPanes are unaffected either way — they already lived outside
  // PaneState (item D).
  function resetDebounce(paneId: string): void {
    const s = state.get(paneId);
    if (!s) return;
    s.blockedPolls = 0;
    s.lastPollSeq = undefined;
  }

  function onPoll(_pollSeq: number, blockedPaneIds: readonly string[]): void {
    const blocked = new Set(blockedPaneIds);
    for (const paneId of state.keys()) {
      if (!blocked.has(paneId)) {
        log(`debounce reset pane=${paneId}: not blocked`);
        resetDebounce(paneId);
      }
    }
    // BUTCHR-124: a pane the herd no longer reports blocked at all ends its
    // sustained-unresponsive episode too, exactly like the parseable-dialog
    // debounce above — belt and suspenders alongside onNoPrompt's own gap
    // detection (this covers the case where the pane simply stops being
    // called at all, which the pollSeq check alone would only notice the
    // NEXT time onNoPrompt happens to fire for it, if ever).
    for (const paneId of unresponsive.keys()) {
      if (!blocked.has(paneId)) unresponsive.delete(paneId);
    }
    // FACTORY-369: same cleanup, for the managed-session mirror of the
    // tracker above (`handleManagedSessionUnresponsive`, onNoPrompt below).
    for (const paneId of managedUnresponsive.keys()) {
      if (!blocked.has(paneId)) managedUnresponsive.delete(paneId);
    }
    // FACTORY-45: "clear the stalled mark when the dialog clears" — the
    // herd no longer reporting this pane blocked AT ALL is the resolution
    // signal (mirrors the `unresponsive` cleanup just above); a fingerprint
    // CHANGE while still blocked is handled inline in
    // `handleManagedSessionBlocked` itself (a new fp simply overwrites the
    // old entry and re-logs, satisfying "a new fingerprint escalates
    // again" without needing a separate clear step here).
    //
    // FACTORY-581 SAFETY GUARD 3: this is the LAST-RESORT, UNATTRIBUTED
    // path — it only ever fires for a pane neither `onDrovrDialogResolved`
    // (an escalated dialog's own resolution) nor `onPermissionAnswered`
    // (drovr's lizard-mode pass pressing a tool-permission dialog, tagged
    // with its own `recognizedVia`) already cleared: both of those call
    // `clearManagedSessionStalled` directly and it is a no-op the second
    // time (the entry is already gone), so a pane they attributed never
    // reaches this untagged branch at all. What DOES reach it: a human
    // typing directly into the pane, or any other clearing this detector's
    // own callbacks do not observe. Left bare (no parenthesized reason) on
    // purpose, so a reader can tell "attributed" from "not" at a glance —
    // see the two other call sites of `clearManagedSessionStalled` for the
    // attributed tags.
    for (const [paneId] of managedSessionStalled) {
      if (!blocked.has(paneId)) clearManagedSessionStalled(paneId, "no longer blocked");
    }
  }

  /**
   * FACTORY-369 AC 2: the managed-session mirror of the BUTCHR-124 sustained
   * blocked-and-unparseable alarm — same gate (`deps.unresponsiveMinutes`,
   * `managedUnresponsive`'s own `UnresponsiveEntry` shape, the identical
   * consecutive-pollSeq/gap-resets-the-episode rules as `unresponsive`
   * above), but funnels into `markManagedSessionStalled` (the SAME sink
   * `handleManagedSessionBlocked`/`onDrovrUnknownDialog` use) once the
   * threshold is reached, instead of `escalateUnresponsive`'s Jira comment —
   * a managed session has no ticket to post that comment to, the identical
   * reason `onBlocked`'s own `issue === null` branch needed a different
   * route in the first place. There is no PARSED dialog here, so `question`/
   * `options` are synthetic placeholders (AC 1's fields still all appear in
   * the #team-admin post — see `teamAdminMessage`'s "(none)" rendering for
   * empty `options`) and the fingerprint is `hashText(text)` (already
   * computed by the caller, `onNoPrompt`, for its own dedupe of the plain
   * journal line just above) — a genuinely different unparseable text is
   * exactly as much a "new" episode here as a new dialog fingerprint is for
   * `handleManagedSessionBlocked`.
   */
  function handleManagedSessionUnresponsive(paneId: string, textHash: string, pollSeq: number): void {
    const prior = managedUnresponsive.get(paneId);
    if (prior && pollSeq <= prior.lastPollSeq) return; // stale/out-of-order, same guard as `unresponsive`'s own
    const consecutive = !!prior && pollSeq === prior.lastPollSeq + 1;
    const u: UnresponsiveEntry = consecutive ? prior! : { firstObservedAt: deps.now(), lastPollSeq: pollSeq };
    u.lastPollSeq = pollSeq;
    managedUnresponsive.set(paneId, u);

    if (u.escalatedAt !== undefined) return; // this episode already handled
    const elapsedMinutes = Math.floor((deps.now() - u.firstObservedAt) / 60_000);
    if (elapsedMinutes < deps.unresponsiveMinutes) return; // not sustained long enough yet — the gate AC 2 requires
    if (managedUnresponsiveInFlight.has(paneId)) return;

    managedUnresponsiveInFlight.add(paneId);
    void (async () => {
      try {
        const session = deps.managedSessionOf ? await deps.managedSessionOf(paneId) : null;
        if (session) {
          u.escalatedAt = deps.now();
          await markManagedSessionStalled(paneId, session, "(sustained unparseable pane — no recognized dialog)", [], textHash);
        }
        // `session === null`: not a managed session (unowned/legacy, or a
        // query-level agent) — nothing more to do here; the plain
        // "blocked with no parseable dialog" journal line (onNoPrompt, above
        // this call) already fired and stays the only signal, exactly as
        // before this ticket.
      } catch (e) {
        deps.log(`WARNING: [managed-escalation] error resolving managed-session identity for sustained-unparseable pane ${paneId}: ${(e as Error)?.message ?? e}`);
      } finally {
        managedUnresponsiveInFlight.delete(paneId);
      }
    })();
  }

  function onNoPrompt(paneId: string, issue: string | null, text: string, pollSeq: number): void {
    const s = state.get(paneId);
    // Same staleness rule as handleBlocked: don't let a late-arriving "no
    // prompt" for an already-superseded poll destroy newer state.
    if (s && !(s.lastPollSeq !== undefined && pollSeq <= s.lastPollSeq)) {
      log(`debounce reset ${issue ?? paneId} pane=${paneId}: no prompt`);
      resetDebounce(paneId);
    }
    const h = hashText(text);
    if (lastUnparseableHash.get(paneId) !== h) {
      lastUnparseableHash.set(paneId, h);
      log(`${paneId} blocked with no parseable dialog: "${text.trim().slice(0, 60)}"`);
    }

    // FACTORY-369 AC 2: a keyless pane widens to the SAME managed-session
    // check `onBlocked` already does for `issue === null` — every OTHER
    // keyless pane (unowned/legacy, query-level) still falls through to
    // nothing, exactly as before this ticket (see
    // `handleManagedSessionUnresponsive`'s own doc comment).
    if (issue === null) { handleManagedSessionUnresponsive(paneId, h, pollSeq); return; }

    const prior = unresponsive.get(paneId);
    // Stale/out-of-order guard, same reasoning as handleBlocked's: a LATER
    // poll's onNoPrompt can resolve before an EARLIER one's (fire-and-forget
    // callers), and an out-of-order pollSeq must never fabricate or destroy
    // a more current observation.
    if (prior && pollSeq <= prior.lastPollSeq) return;
    // "Consecutive" mirrors PaneState's own definition: the SAME pane
    // observed sustained-unparseable on the very next pollSeq. Any gap —
    // reported not-blocked (onPoll above already deletes the entry for
    // that), or blocked-but-NOW-parseable (onBlocked fires instead, so
    // onNoPrompt simply isn't called that poll, which this pollSeq check
    // catches on its own) — resets the episode to a fresh first observation,
    // exactly like D6 requires.
    const consecutive = !!prior && pollSeq === prior.lastPollSeq + 1;
    const u: UnresponsiveEntry = consecutive ? prior! : { firstObservedAt: deps.now(), lastPollSeq: pollSeq };
    u.lastPollSeq = pollSeq;
    unresponsive.set(paneId, u);

    if (u.escalatedAt !== undefined) return; // this episode already handled, one way or another
    const elapsedMinutes = Math.floor((deps.now() - u.firstObservedAt) / 60_000);
    if (elapsedMinutes < deps.unresponsiveMinutes) return;
    if (unresponsiveInFlight.has(paneId)) return; // an escalation attempt for this pane is already in flight

    unresponsiveInFlight.add(paneId);
    void (async () => {
      try {
        // A `null` result means "could not verify — nothing was written":
        // escalatedAt stays unset so the NEXT qualifying poll retries this
        // episode from scratch, exactly like parked.ts's own comments-fetch
        // failure. Only a non-null result (posted, adopted, or rate-capped —
        // all of which are a definite, checked outcome) latches the episode.
        const result = await escalateUnresponsive(paneId, issue, elapsedMinutes);
        if (result !== null) u.escalatedAt = result;
      } catch (e) {
        // escalateUnresponsive already catches its own read failure; this
        // only guards an unexpected throw elsewhere (e.g. deps.addComment)
        // — same fail-safe-by-not-latching behaviour applies.
        log(`[unresponsive] error escalating ${issue} pane ${paneId}: ${(e as Error)?.message ?? e}`);
      } finally {
        unresponsiveInFlight.delete(paneId);
      }
    })();
  }

  return { onBlocked, onPoll, onNoPrompt, managedSessionEscalations, onDrovrUnknownDialog, onDrovrDialogResolved, onPermissionAnswered };
}
