import { parsePrompt, keysToSelect, type Prompt } from "./prompt.js";
import { fingerprint, escalationComment, parseDirective, freeTextOption, MARKER, type Directive } from "./escalate.js";
import type { CaptureSink } from "./session-limit-watch.js";

const FOLLOWUP_MS = 15 * 60_000;
const DEBOUNCE_POLLS = 2;
// Comments filter by created-at-or-after the escalation, comparing Atlassian's
// server clock to the daemon's own. A grace window absorbs modest clock skew
// without risking much: parseDirective already rejects every butchr-authored
// comment, so this filter's only job is dropping genuinely pre-escalation noise.
const CLOCK_SKEW_GRACE_MS = 120_000;

export interface CommentRow { id: string; body: string; created: string }

export interface EscalatorDeps {
  read: (paneId: string) => Promise<string>;
  send: (paneId: string, text: string) => Promise<void>;
  addComment: (issue: string, text: string) => Promise<void>;
  /** Recent comments on an issue, newest-first is fine; plain text bodies. */
  comments: (issue: string) => Promise<CommentRow[]>;
  now: () => number;
  log: (line: string) => void;
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

/** Global cap on escalation capture files kept at once — same discipline as session-limit-watch's CAPTURE_MAX_FILES, kept separate because it recognizes a different filename shape and must never evict a session-limit capture (or vice versa). */
const ESCALATION_CAPTURE_MAX_FILES = 50;

/** `<ISSUE>-escalation-<compact-UTC-timestamp>.txt` — recognizes exactly the filenames this module writes, so eviction (and a shared BUTCHR_CAPTURE_DIR holding other files) never touches anything else's captures. */
const ESCALATION_CAPTURE_NAME = /^[A-Z][A-Z0-9]*-\d+-escalation-(\d{8}T\d{6}Z)\.txt$/;

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
  }

  return { onBlocked, onPoll, onNoPrompt };
}
