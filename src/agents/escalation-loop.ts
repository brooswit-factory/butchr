import { parsePrompt, keysToSelect, type Prompt } from "./prompt.js";
import { fingerprint, escalationComment, parseDirective, freeTextOption, MARKER, type Directive } from "./escalate.js";

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
  const cappedIssues = new Set<string>();
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

  async function escalate(issue: string, prompt: Prompt, fp: string, s: PaneState): Promise<void> {
    const rows = await deps.comments(issue).catch((e) => {
      log(`comments fetch failed for ${issue}: ${(e as Error)?.message ?? e}`);
      return [] as CommentRow[];
    });
    const existing = rows.find((r) => r.body.startsWith(MARKER) && r.body.includes(`fingerprint: ${fp}`));
    if (existing) {
      s.escalatedAt = Date.parse(existing.created) || deps.now();
      log(`adopted existing escalation ${issue} fp=${fp} from comment ${existing.id} (daemon restart)`);
      return;
    }
    // Rate cap: at most 3 escalation comments per pane per hour. Beyond that,
    // one summary notice, then log-only — a misbehaving parser must never be
    // able to spam a ticket unboundedly.
    const HOUR = 60 * 60_000;
    const recent = (paneEscalations.get(issue) ?? []).filter((t) => deps.now() - t < HOUR);
    if (recent.length >= 3) {
      if (!cappedIssues.has(issue)) {
        cappedIssues.add(issue);
        await deps.addComment(issue, `${MARKER} ${issue}: escalation rate cap reached (3/hour) — further blocked-prompt changes are being logged only. An operator or parent can still reply ANSWER <n> <fingerprint> against the latest logged fingerprint.`);
      }
      s.escalatedAt = deps.now();
      log(`RATE-CAPPED escalation ${issue} fp=${fp} (log-only) "${prompt.question.slice(0, 60)}"`);
      return;
    }
    recent.push(deps.now());
    paneEscalations.set(issue, recent);
    cappedIssues.delete(issue);
    await deps.addComment(issue, escalationComment(issue, prompt, fp));
    s.escalatedAt = deps.now();
    log(`escalated ${issue} fp=${fp} "${prompt.question.slice(0, 60)}"`);
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
    // via onPoll/onNoPrompt below, which delete the pane's state) — or a
    // different fingerprint, resets the count to a fresh first observation.
    const consecutive = !!prior && prior.fp === fp && prior.lastPollSeq !== undefined && pollSeq === prior.lastPollSeq + 1;
    if (!consecutive && prior) {
      log(`debounce reset ${issue} pane=${paneId}: ${prior.fp !== fp ? `fp changed (${prior.fp} -> ${fp})` : "poll gap"}`);
    }
    const s: PaneState = consecutive ? prior! : newState(fp);
    state.set(paneId, s);
    s.lastPollSeq = pollSeq;
    s.blockedPolls++;
    if (s.blockedPolls < DEBOUNCE_POLLS) {
      log(`debounce ${issue} fp=${fp} (poll ${s.blockedPolls}/${DEBOUNCE_POLLS})`);
      return;
    }

    if (s.escalatedAt === undefined) {
      await escalate(issue, prompt, fp, s);
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

  function onPoll(_pollSeq: number, blockedPaneIds: readonly string[]): void {
    const blocked = new Set(blockedPaneIds);
    for (const paneId of state.keys()) {
      if (!blocked.has(paneId)) {
        log(`debounce reset pane=${paneId}: not blocked`);
        state.delete(paneId);
      }
    }
  }

  function onNoPrompt(paneId: string, issue: string | null, text: string, pollSeq: number): void {
    const s = state.get(paneId);
    // Same staleness rule as handleBlocked: don't let a late-arriving "no
    // prompt" for an already-superseded poll destroy newer state.
    if (s && !(s.lastPollSeq !== undefined && pollSeq <= s.lastPollSeq)) {
      log(`debounce reset ${issue ?? paneId} pane=${paneId}: no prompt`);
      state.delete(paneId);
    }
    const h = hashText(text);
    if (lastUnparseableHash.get(paneId) !== h) {
      lastUnparseableHash.set(paneId, h);
      log(`${paneId} blocked with no parseable dialog: "${text.trim().slice(0, 60)}"`);
    }
  }

  return { onBlocked, onPoll, onNoPrompt };
}
