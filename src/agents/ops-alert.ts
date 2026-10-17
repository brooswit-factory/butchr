/**
 * FACTORY-630: the ops-alert route — one `[butchr:ops-alert]` journal line
 * for a daemon condition that no agent can fix and no agent can even be told
 * about: a dead Claude credential (`./login-expired-alert.ts`), a
 * settings-file problem, a first-run seed, a stuck loop watchdog, a
 * ticketless crash loop (`./crash-loop.ts`).
 *
 * This route used to also post each alert to a Rocket.Chat room. Rocket.Chat
 * support is gone, so it is now a journal line only: the same pull channel
 * as `/health` and each detector's own marker line, deduplicated per
 * condition so a condition observed on every poll doesn't flood the journal.
 *
 * WHY IT IS GENERIC RATHER THAN CREDENTIAL-SPECIFIC (the director's item 4).
 * The entry point is a typed ops alert — a `key`, a `condition`, a
 * `subject`, a `reason`, and a dedup window — with NO credential concept
 * anywhere in it, so any detector can raise one without touching this file.
 *
 * It FAILS OPEN: nothing here throws back into the detector that raised the
 * alert, because a detector that crashed while reporting would lose the
 * line it was already writing.
 */
import { redact } from "./escalate.js";
import { RateCap, HOUR_MS } from "./escalation-helper.js";
import { sanitizeForJournal, truncateField } from "./journal-text.js";

/** Greppable prefix for every journal line this module writes — distinct from `[butchr:credential-dead]` (the CONDITION's own line, written by the detector). */
export const OPS_ALERT_MARKER = "[butchr:ops-alert]";

/** One raised ops condition. Every field is required except `remedy`, because a line that omits any of them is not useful on its own. */
export interface OpsAlert {
  /**
   * The dedup identity. At most one line per key per window (see
   * `OpsAlertRouterDeps.dedupWindowMs`), so this must be stable across
   * repeated raises of the SAME ongoing condition and distinct between
   * conditions that a human would want to hear about separately. The
   * credential-death caller uses `credential-dead:<host>`.
   */
  key: string;
  /** The condition's own short name, e.g. `credential-dead` — what the line leads with, and what a later recovery line refers back to. */
  condition: string;
  /** WHAT is affected, in a human's terms: the account, session, pane or host. May be agent-derived. */
  subject: string;
  /** WHY, free text — the only field expected to carry live, possibly secret-bearing text (a quoted error string), so it is redacted. */
  reason: string;
  /** What a human should actually DO. Omitted only when there is genuinely nothing to say. */
  remedy?: string;
  /** Overrides the router's default window for this key alone; `0` logs every raise. */
  dedupWindowMs?: number;
}

/** A condition clearing. Logged at most once per key per window, and ONLY when an alert line for that same key was logged first — see `recover`. */
export interface OpsRecovery {
  key: string;
  condition: string;
  subject: string;
  /** Short free text: what closed it, and anything a human needs to know about the gap. Redacted like `OpsAlert.reason`. */
  note: string;
  /** Overrides the router's default window for this recovery, on the same terms as `OpsAlert.dedupWindowMs`. */
  dedupWindowMs?: number;
}

export interface OpsAlertRouterDeps {
  /** This daemon's own hostname, named in every line: a journal collected from more than one daemon has to say which one is affected. */
  host: string;
  now: () => number;
  log: (line: string) => void;
  /** Default dedup window for every key. Defaults to one hour (`HOUR_MS`) — the director's own figure. */
  dedupWindowMs?: number;
}

export interface OpsAlertRouter {
  /**
   * Raise `alert`. Synchronous and never throws. Safe to call on EVERY poll
   * that observes the condition — the dedup window, not the caller, decides
   * what is logged.
   */
  raise(alert: OpsAlert): void;
  /**
   * Note that `key`'s condition has cleared. Logs at most one short
   * "cleared" line, and ONLY if an alert line for that key was logged since
   * the last recovery: a lone "X cleared" for a condition the journal never
   * reported reads as one somebody else already handled. Never throws.
   */
  recover(recovery: OpsRecovery): void;
}

/** Per-field caps, so one pathological field (a long quoted error string) can't make a single journal line unbounded. */
const CONDITION_CAP = 80;
/** A legal DNS hostname cannot exceed 253 characters, so this never truncates a real one. */
const HOST_CAP = 253;
const SUBJECT_CAP = 300;
const REASON_CAP = 2000;
const REMEDY_CAP = 400;
const NOTE_CAP = 600;

/** One field, made safe for a single journal line: control characters stripped, newlines flattened (so a field can't forge a second marker line), secrets redacted where asked, then capped. */
function field(raw: string, cap: number, redactSecrets = false): string {
  const flat = sanitizeForJournal(raw);
  return truncateField(redactSecrets ? redact(flat) : flat, cap);
}

/** The alert line. Exported for the tests, which assert on the exact text that would be logged. */
export function opsAlertLine(alert: OpsAlert, host: string): string {
  const remedy = alert.remedy ? field(alert.remedy, REMEDY_CAP) : "(none stated)";
  return (
    `${OPS_ALERT_MARKER} ${field(alert.key, SUBJECT_CAP)}: ${field(alert.condition, CONDITION_CAP)} on ${field(host, HOST_CAP)} — ` +
    `${field(alert.subject, SUBJECT_CAP)}. No agent on this host can fix or acknowledge this; it needs a human. ` +
    `reason: ${field(alert.reason, REASON_CAP, true)} remedy: ${remedy}`
  );
}

/** The recovery line: deliberately short. */
export function opsRecoveryLine(recovery: OpsRecovery, host: string): string {
  return `${OPS_ALERT_MARKER} ${field(recovery.key, SUBJECT_CAP)}: ${field(recovery.condition, CONDITION_CAP)} cleared on ${field(host, HOST_CAP)} — ${field(recovery.subject, SUBJECT_CAP)}. ${field(recovery.note, NOTE_CAP, true)}`;
}

export function createOpsAlertRouter(deps: OpsAlertRouterDeps): OpsAlertRouter {
  const windowMs = deps.dedupWindowMs ?? HOUR_MS;
  // RateCap(1, window): "at most one line per condition per hour", keyed
  // per alert key. The caps are KEPT, one per window length — not rebuilt
  // per call (PR #631 manager review): a `RateCap` holds the timestamps that
  // ARE the dedup state, so a cap built on the fly for an alert that
  // overrides its window would dedup nothing. Keyed by window LENGTH, so
  // every alert naming the same number shares one instance, and `RateCap`'s
  // own per-key bookkeeping keeps distinct alert keys independent inside it.
  const alertCaps = new Map<number, RateCap>();
  const recoveryCaps = new Map<number, RateCap>();
  function capFor(caps: Map<number, RateCap>, window: number): RateCap {
    let cap = caps.get(window);
    if (!cap) { cap = new RateCap(1, window); caps.set(window, cap); }
    return cap;
  }
  // Keys whose alert line was logged and whose recovery has not been — the
  // gate on `recover` logging anything at all.
  const raised = new Set<string>();

  /** Logs `line` unless `capKey` already logged inside `window`; a duplicate is dropped silently (the detector's own marker line stays the complete record). */
  function emit(capKey: string, caps: Map<number, RateCap>, window: number, line: () => string, onLogged: () => void): void {
    const cap = capFor(caps, window);
    const now = deps.now();
    if (!cap.allow(capKey, now)) return;
    cap.record(capKey, now);
    onLogged();
    deps.log(line());
  }

  return {
    raise(alert: OpsAlert): void {
      // A caller that overrides the window is expected to do so consistently
      // for a given key: the window is part of how that key's own cap is
      // looked up.
      emit(alert.key, alertCaps, alert.dedupWindowMs ?? windowMs, () => opsAlertLine(alert, deps.host), () => { raised.add(alert.key); });
    },
    recover(recovery: OpsRecovery): void {
      if (!raised.has(recovery.key)) return;
      emit(`${recovery.key}:recovered`, recoveryCaps, recovery.dedupWindowMs ?? windowMs, () => opsRecoveryLine(recovery, deps.host), () => { raised.delete(recovery.key); });
    },
  };
}
