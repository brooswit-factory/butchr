import { parsePrompt, keysToSelect, type Prompt } from "./prompt.js";
import { fingerprint, escalationComment, parseDirective, freeTextOption, MARKER, type Directive } from "./escalate.js";
import type { CaptureSink } from "./session-limit-watch.js";
import { findMarked, RateCap, HOUR_MS } from "./escalation-helper.js";

const FOLLOWUP_MS = 15 * 60_000;
const DEBOUNCE_POLLS = 2;
// Comments filter by created-at-or-after the escalation, comparing Atlassian's
// server clock to the daemon's own. A grace window absorbs modest clock skew
// without risking much: parseDirective already rejects every butchr-authored
// comment, so this filter's only job is dropping genuinely pre-escalation noise.
const CLOCK_SKEW_GRACE_MS = 120_000;

export interface CommentRow { id: string; body: string; created: string }

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

export interface EscalatorDeps {
  read: (paneId: string) => Promise<string>;
  send: (paneId: string, text: string) => Promise<void>;
  addComment: (issue: string, text: string) => Promise<void>;
  /** Recent comments on an issue, newest-first is fine; plain text bodies. */
  comments: (issue: string) => Promise<CommentRow[]>;
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
   * BUTCHR-124: recent messages on `key`'s OWN CHANNEL — the read-back
   * symmetric to `addComment`'s `speakOnOwnChannel` routing (an ISSUE's Jira
   * comments for an issue key; a PROJECT's Confluence root-doc FOOTER
   * comments for a project key — see src/tools/speak.ts, src/tools/docs.ts's
   * `projectRootDoc`, and `AtlassianOps.getPageComments`'s "per-page only,
   * never the batch form" warning). Used ONLY by the sustained-unresponsive
   * alarm's restart-adoption dedupe — deliberately separate from `comments`
   * above (issue-only, unchanged, still used exactly as before by the
   * parseable-dialog `escalate()` — D7).
   *
   * MUST FAIL BY REJECTING on any read failure — never resolve to an empty
   * array to represent "could not check". `comments` above already does
   * exactly that (`.catch(() => [])` at every call site in this file), which
   * is a confident-zero: a failed read and a successful-empty read become
   * the same branch, so a transient failure right after a restart reads as
   * "no prior notice exists" and posts a duplicate. That is `escalate()`'s
   * existing, unrelated, OUT-OF-SCOPE-for-this-ticket behaviour (flagged at
   * review, not fixed here — see the doc). This dependency must not repeat
   * it: `escalateUnresponsive` below treats a REJECTED promise as "could not
   * verify — skip writing this poll, retry next time" and a RESOLVED one
   * (even an empty array) as "verified: checked, and this is what's there".
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
   */
  captures?: CaptureSink;
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
  const unresponsiveCap = new RateCap(UNRESPONSIVE_MAX_PER_HOUR, HOUR_MS);

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
   * FAILS CLOSED (review finding on this ticket): unlike `escalate()`'s own
   * comments fetch elsewhere in this file (which `.catch`es into an empty
   * array — a confident-zero this function must not repeat), a rejected
   * `deps.ownChannelComments` here is caught HERE, logged, and turned into a
   * `null` return — "could not verify, did not write anything" — never a
   * silent fall-through to "nothing exists, safe to post". The caller
   * (onNoPrompt) must leave `escalatedAt` unset on a `null` result so the
   * NEXT qualifying poll retries, exactly like parked.ts's own
   * comments-fetch-failure branch (`rows === null` -> `return null` ->
   * nothing posted, nothing latched).
   */
  async function escalateUnresponsive(paneId: string, issue: string, elapsedMinutes: number): Promise<number | null> {
    let rows: CommentRow[];
    try {
      rows = await deps.ownChannelComments(issue);
    } catch (e) {
      log(`WARNING: [unresponsive] could not verify existing notices for ${issue} pane ${paneId} — skipping this poll's attempt rather than risk a duplicate: ${(e as Error)?.message ?? e}`);
      return null;
    }
    const existing = findMarked(rows, UNRESPONSIVE_MARKER, [paneKey(paneId)]);
    if (existing) {
      log(`[unresponsive] adopted existing notice for ${issue} pane ${paneId} from comment ${existing.id} (daemon restart)`);
      return Date.parse(existing.created) || deps.now();
    }
    if (!unresponsiveCap.allow(issue, deps.now())) {
      log(`WARNING: [unresponsive] rate cap reached (${UNRESPONSIVE_MAX_PER_HOUR}/hour) for ${issue} — pane ${paneId}'s notice is being logged only, not posted`);
      return deps.now();
    }
    await deps.addComment(issue, unresponsiveComment(issue, paneId, elapsedMinutes));
    unresponsiveCap.record(issue, deps.now());
    log(`[unresponsive] escalated ${issue} pane ${paneId} (${elapsedMinutes}m sustained blocked+unparseable)`);
    return deps.now();
  }

  async function escalate(paneId: string, issue: string, prompt: Prompt, fp: string, s: PaneState): Promise<void> {
    const rows = await deps.comments(issue).catch((e) => {
      log(`comments fetch failed for ${issue}: ${(e as Error)?.message ?? e}`);
      return [] as CommentRow[];
    });
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

    const rows = await deps.comments(issue).catch((e) => {
      log(`comments fetch failed for ${issue}: ${(e as Error)?.message ?? e}`);
      return [] as CommentRow[];
    });
    const escalatedAtMs = s.escalatedAt;
    const consumed = consumedFor(paneId);
    let directive: Directive | null = null;
    let directiveCommentId: string | null = null;
    for (const r of rows) {
      if (Date.parse(r.created) < escalatedAtMs - CLOCK_SKEW_GRACE_MS) continue;
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
      await deps.addComment(
        issue,
        `${MARKER} ${issue} still waiting on the decision above (fingerprint ${s.fp}) — answer it, or if you cannot decide, say so ON YOUR OWN ticket so it escalates to whoever watches you.`,
      );
      s.followedUpAt = deps.now();
      log(`follow-up posted ${issue} fp=${s.fp}`);
    }
  }

  async function onBlocked(paneId: string, issue: string | null, prompt: Prompt, pollSeq: number): Promise<void> {
    if (issue === null) {
      log(`${paneId} blocked with an unanswerable prompt but no issue key — cannot escalate`);
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

    // BUTCHR-124: sustained blocked-and-unparseable alarm. No addressable
    // target — mirrors onBlocked's own refusal for issue === null — so there
    // is nothing to track or escalate.
    if (issue === null) return;

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

  return { onBlocked, onPoll, onNoPrompt };
}
