import { parsePrompt, keysToSelect, type Prompt } from "./prompt.js";
import { fingerprint, escalationComment, parseDirective, freeTextOption, type Directive } from "./escalate.js";

const MARKER = "[butchr:blocked]";
const FOLLOWUP_MS = 15 * 60_000;
const DEBOUNCE_POLLS = 2;

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
  escalatedAt: number | undefined;
  followedUpAt: number | undefined;
}

export interface Escalator {
  onBlocked: (paneId: string, issue: string | null, prompt: Prompt) => Promise<void>;
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
  const log = (line: string) => deps.log(`[prompts] ${line}`);

  async function escalate(paneId: string, issue: string, prompt: Prompt, fp: string, s: PaneState): Promise<void> {
    const rows = await deps.comments(issue).catch((e) => {
      log(`comments fetch failed for ${issue}: ${(e as Error)?.message ?? e}`);
      return [] as CommentRow[];
    });
    const existing = rows.find((r) => r.body.includes(MARKER) && r.body.includes(`fingerprint: ${fp}`));
    if (existing) {
      s.escalatedAt = Date.parse(existing.created) || deps.now();
      log(`adopted existing escalation ${issue} fp=${fp} from comment ${existing.id} (daemon restart)`);
      return;
    }
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
        const newFp = freshFp!;
        const fresh_s: PaneState = { fp: newFp, blockedPolls: DEBOUNCE_POLLS, escalatedAt: undefined, followedUpAt: undefined };
        state.set(paneId, fresh_s);
        await escalate(paneId, issue, fresh, newFp, fresh_s);
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
      state.delete(paneId);
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
    state.delete(paneId);
  }

  async function onBlocked(paneId: string, issue: string | null, prompt: Prompt): Promise<void> {
    try {
      if (issue === null) {
        log(`${paneId} blocked with an unanswerable prompt but no issue key — cannot escalate`);
        return;
      }

      const fp = fingerprint(prompt);
      let s = state.get(paneId);
      if (!s || s.fp !== fp) {
        s = { fp, blockedPolls: 0, escalatedAt: undefined, followedUpAt: undefined };
        state.set(paneId, s);
      }

      s.blockedPolls++;
      if (s.blockedPolls < DEBOUNCE_POLLS) {
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
      let directive: Directive | null = null;
      for (const r of rows) {
        if (Date.parse(r.created) < escalatedAtMs) continue;
        const d = parseDirective(r.body);
        if (d) { directive = d; break; } // newest-first comments(); first match wins
      }

      if (directive) {
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
    } catch (e) {
      log(`error handling ${paneId}: ${(e as Error)?.message ?? e}`);
    }
  }

  return { onBlocked };
}
