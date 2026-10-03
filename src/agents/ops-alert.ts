/**
 * FACTORY-630: the ops-alert route — a PUSH destination for daemon
 * conditions that no agent can fix and no agent can even be told about.
 *
 * THE DEFECT THIS EXISTS FOR. butchr's `credential-dead` alert
 * (`./login-expired-alert.ts`, FACTORY-363/FACTORY-397) fired at 18:37Z on
 * 2026-10-02 and nobody saw it. Nothing about the detector was broken: it
 * wrote its `[butchr:credential-dead]` journal line and populated
 * `/health`'s `credentialDeathAlert` field exactly as designed. But BOTH of
 * those channels are PULL-only — they require a human to already be looking,
 * at the right host, with the right `journalctl --user -u <unit>` (or a
 * `curl` of `/health`). FACTORY-397 chose non-agent-mediated delivery
 * deliberately and correctly, since every agent-mediated lever butchr has
 * shares its single point of failure with the dead credential (waking an
 * agent means resuming a Claude session, which cannot make an API call
 * either while the credential is dead) — but at the time it shipped there
 * was no PUSH channel independent of Claude's OAuth to use. There is one
 * now: FACTORY-369/609/611's Rocket.Chat poster, authenticated by an RC
 * user-id/token pair from a token file, which has nothing to do with the
 * Claude credential this condition kills and therefore survives the exact
 * outage. This module is the connection between the two, and nothing more.
 *
 * WHY IT IS GENERIC RATHER THAN CREDENTIAL-SPECIFIC (the director's item 4;
 * FACTORY-625's own note on this ticket asked the same question). The entry
 * point is a typed ops alert — a `key`, a `condition`, a `subject`, a
 * `reason`, and a dedup window — with NO credential concept anywhere in it.
 * `credential-dead` is its first caller and, in this change, its only one.
 * Two more are already known and can become callers without touching this
 * file: FACTORY-622's crash-loop detector (`./crash-loop.ts`) and
 * FACTORY-625's PreToolUse hook's fail-open/block counter. That last one is
 * why generic is not speculative generality: FACTORY-625's hook runs in a
 * per-Bash-call hot path and can do no network of its own, so its blocks
 * reach a person only through an audit file plus whatever alert route
 * exists — if this one were credential-shaped it would have to invent a
 * parallel path, which is the duplication both tickets exist to avoid.
 *
 * WHAT THIS MODULE DELIBERATELY IS NOT. It is not a second Rocket.Chat
 * client (it takes the EXISTING poster's narrow `(room, text)` seam as an
 * injected dep — the same seam `EscalatorDeps.teamAdminNotify` is wired
 * behind in `src/daemon/index.ts`, built from `createRocketChatPoster`), and
 * it is not a second text-hardening pipeline (it imports FACTORY-611's own,
 * `./rocketchat-text.ts`). It is also not a REPLACEMENT for the journal
 * line or `/health`: those stay exactly as they are and remain the channels
 * that survive when Rocket.Chat itself is unreachable. This route is
 * strictly additive, and it FAILS OPEN — every failure mode below degrades
 * to a journal line and never throws back into the detector that raised the
 * alert, because a detector that crashes on a posting failure would lose the
 * one channel that was already working.
 */
import { RateCap, HOUR_MS } from "./escalation-helper.js";
import { quoteField, quotedBlock, sanitizeForJournal, QUOTE_FIELD_CHAR_CAP } from "./rocketchat-text.js";

/** Greppable prefix for every journal line this module writes — distinct from `[butchr:credential-dead]` (the CONDITION's own line, written by the detector) and from `[managed-escalation]` (the tiered managed-session path). A human grepping for why a room post did or did not happen looks for this; a human grepping for the condition itself looks for the detector's own marker. */
export const OPS_ALERT_MARKER = "[butchr:ops-alert]";

/**
 * One raised ops condition. Every field is required except `remedy`,
 * because a post that omits any of them is not useful on its own — and
 * useful-on-its-own is a hard requirement here, not a nicety: the room this
 * posts to is one the manager account can POST to but cannot READ, so
 * nobody can ask a follow-up question about a terse alert.
 */
export interface OpsAlert {
  /**
   * The dedup identity. At most one post per key per window (see
   * `OpsAlertRouterDeps.dedupWindowMs`), so this must be stable across
   * repeated raises of the SAME ongoing condition and distinct between
   * conditions that a human would want to hear about separately. The
   * credential-death caller uses `credential-dead:<host>` — per condition,
   * per daemon, which is the granularity the director's "one deduplicated
   * post per condition per hour" names.
   */
  key: string;
  /** The condition's own short name, e.g. `credential-dead` — what the post leads with, and what a later recovery post refers back to. */
  condition: string;
  /** WHAT is affected, in a human's terms: the account, session, pane or host. Quoted and neutralised; may be agent-derived. */
  subject: string;
  /** WHY, free text — the only field expected to carry live, possibly attacker-reachable text (a quoted error string), so it is redacted and neutralised like a dialog's question is. */
  reason: string;
  /** What a human should actually DO. Omitted only when there is genuinely nothing to say. */
  remedy?: string;
  /** Overrides the router's default window for this key alone. The credential-death caller does not set it — the director's one-per-hour default is the right window for it. */
  dedupWindowMs?: number;
}

/** A condition clearing. Posted at most once per key per window, and ONLY when an alert post for that same key actually succeeded first — see `recover`. */
export interface OpsRecovery {
  key: string;
  condition: string;
  subject: string;
  /** Short free text: what closed it, and anything a human needs to know about the gap. Quoted and neutralised exactly like `OpsAlert.reason`. */
  note: string;
  /** Overrides the router's default window for this recovery, on the same terms as `OpsAlert.dedupWindowMs` — a caller running a short alert window wants its recovery on the same clock. The credential-death caller does not set it. */
  dedupWindowMs?: number;
}

export interface OpsAlertRouterDeps {
  /**
   * The EXISTING Rocket.Chat poster's narrow seam — `undefined` when no
   * posting credential is configured, which is the ordinary state of a
   * daemon that has not been granted one. Absent: every raise logs ONE
   * journal line saying so and nothing else (never a throw, never a repeat
   * warning per key — see `postingUnconfiguredWarned`).
   */
  post?: (room: string, text: string) => Promise<void>;
  /** The room every ops alert goes to. Defaults, in config, to `team-admin`. */
  room: string;
  /** Prepended to the post so a human is actually pinged — the entire defect here is that a correct alert reached nobody. Pass an empty string to post with no mention at all. */
  mention: string;
  /** This daemon's own hostname, named in every post: an alert that does not say WHICH daemon is affected is not actionable, and the room collects more than one. */
  host: string;
  now: () => number;
  log: (line: string) => void;
  /** Default dedup window for every key. Defaults to one hour (`HOUR_MS`) — the director's own figure. */
  dedupWindowMs?: number;
}

export interface OpsAlertRouter {
  /**
   * Raise `alert`. SYNCHRONOUS and never throws: the post is dispatched
   * fire-and-forget and every outcome (sent, deduplicated, unconfigured,
   * failed) resolves into a journal line. Safe to call on EVERY poll that
   * observes the condition — the dedup window, not the caller, decides what
   * actually posts, which is also what makes a transient posting failure
   * retry on the next raise.
   */
  raise(alert: OpsAlert): void;
  /**
   * Note that `key`'s condition has cleared. Posts at most one short
   * "recovered" line, and ONLY if an alert post for that key actually
   * SUCCEEDED since the last recovery: a lone "X recovered" in a room that
   * never heard X was broken is worse than silence, because it reads as a
   * condition someone else already handled. Never throws, same as `raise`.
   */
  recover(recovery: OpsRecovery): void;
}

/**
 * Per-field caps. `reason` gets the full per-field ceiling
 * (`QUOTE_FIELD_CHAR_CAP`) because it is the one field that carries live,
 * unbounded text — a quoted error string from drovr, a quoted command from
 * FACTORY-625's hook. `subject` and `remedy` are tighter because they are
 * short by construction (a host plus a pane list; one sentence of
 * instruction), and because `subject` appears TWICE in the composed message
 * (the header and the block), so it costs double.
 *
 * These are chosen so the WORST CASE — every field at its cap — provably
 * fits `WHOLE_MESSAGE_BUDGET` with room to spare. That is asserted directly
 * in `test/unit/ops-alert.test.ts`, which is what makes it safe for this
 * module to have no whole-message shrink pass of its own (the escalation
 * path needs one, `fitWholeMessageBudget` in `./escalation-loop.ts`, because
 * its options list is unbounded in COUNT as well as length; an ops alert has
 * no such list). If a later field is added here, or a cap raised, that test
 * fails rather than a post being silently refused by Rocket.Chat for
 * exceeding `Message_MaxAllowedSize`.
 */
const CONDITION_CAP = 80;
/** A legal DNS hostname cannot exceed 253 characters, so this never truncates a real one. */
const HOST_CAP = 253;
const SUBJECT_CAP = 300;
const REMEDY_CAP = 400;
const NOTE_CAP = 600;

/**
 * Compose the post: ONE fenced block of labelled fields plus a leading
 * header, the shape FACTORY-611 hardened. Every interpolated value goes
 * through `quoteField`, so an adversarial `reason` cannot forge a labelled
 * line, open or close the fence, ping a human, or autolink.
 *
 * Exported for the tests, which assert the hardened properties on the exact
 * text that would be posted rather than on a re-implementation of it.
 */
export function opsAlertMessage(alert: OpsAlert, host: string, mention: string): string {
  const subject = quoteField(alert.subject, { cap: SUBJECT_CAP });
  const condition = quoteField(alert.condition, { cap: CONDITION_CAP });
  const header =
    `${mention ? `${mention} ` : ""}**ops alert: ${condition}** on **${quoteField(host, { cap: HOST_CAP })}** — ` +
    `${subject}. No agent on this host can fix or acknowledge this; it needs a human.`;
  const lines = [
    `condition: ${condition}`,
    `host: ${quoteField(host, { cap: HOST_CAP })}`,
    `subject: ${subject}`,
    // The only field expected to carry live, possibly attacker-reachable
    // text, so the only one redacted — `redact()` runs BEFORE truncation
    // inside `quoteField`, so a secret can never straddle the cut.
    `reason: ${quoteField(alert.reason, { redactSecrets: true })}`,
    `remedy: ${alert.remedy ? quoteField(alert.remedy, { cap: REMEDY_CAP }) : "(none stated)"}`,
  ];
  return [header, "", quotedBlock(lines)].join("\n");
}

/** The recovery post: deliberately SHORT (the director's "one short recovered post"), same hardening and the same provable bound. */
export function opsRecoveryMessage(recovery: OpsRecovery, host: string, mention: string): string {
  const condition = quoteField(recovery.condition, { cap: CONDITION_CAP });
  const subject = quoteField(recovery.subject, { cap: SUBJECT_CAP });
  const header = `${mention ? `${mention} ` : ""}**ops alert cleared: ${condition}** on **${quoteField(host, { cap: HOST_CAP })}** — ${subject}.`;
  const block = quotedBlock([`condition: ${condition}`, `host: ${quoteField(host, { cap: HOST_CAP })}`, `subject: ${subject}`, `note: ${quoteField(recovery.note, { cap: NOTE_CAP, redactSecrets: true })}`]);
  return [header, "", block].join("\n");
}

export function createOpsAlertRouter(deps: OpsAlertRouterDeps): OpsAlertRouter {
  const windowMs = deps.dedupWindowMs ?? HOUR_MS;
  // RateCap(1, window): "at most one post per condition per hour", the
  // director's own figure, keyed per alert key. NOTE the deliberate
  // asymmetry with `./login-expired-alert.ts`, whose own doc comment
  // explains why it does NOT use a time window for its JOURNAL line: a
  // window can swallow a legitimately NEW episode's first line if that
  // episode opens inside the window following a previous one's close, so
  // the journal collapses on EPISODE boundaries instead. Both are right,
  // for different channels. The journal line is the complete, un-rate-
  // limited record and always has been — it keeps episode semantics
  // untouched by this change. The ROOM is a place real people read, where
  // the director asked for an hourly cap precisely so a flapping credential
  // cannot spam it, and a flap is exactly "an episode closes and reopens".
  // The cost is real and stated rather than hidden: a genuinely new episode
  // opening within an hour of the last post is NOT posted again. It is also
  // never silent — the suppression writes its own journal line naming when
  // the next post for that key becomes possible, so the pull channel keeps
  // full fidelity and a human can always reconstruct what the room did not
  // say.
  //
  // THE CAPS ARE KEPT, ONE PER WINDOW LENGTH — not rebuilt per call (PR #631
  // manager review). A `RateCap` holds the post timestamps that ARE the
  // dedup state, so constructing one on the fly for an alert that overrides
  // its window hands `allow()` an empty cap every time, and that alert then
  // posts on EVERY raise: dedup silently off for exactly the callers that
  // asked for a different window. `credential-dead` does not override, so
  // no current caller or test reached it — but FACTORY-625's hook was
  // already told (FACTORY-630 comment 29112) to pass `dedupWindowMs` for its
  // shorter window, which would have hit it on its first raise. Keyed by
  // window LENGTH rather than per alert key, so the router's own default
  // window shares one instance with every alert that names the same number,
  // and `RateCap`'s own per-key bookkeeping still keeps distinct alert keys
  // independent inside it.
  const alertCaps = new Map<number, RateCap>();
  const recoveryCaps = new Map<number, RateCap>();
  function capFor(caps: Map<number, RateCap>, window: number): RateCap {
    let cap = caps.get(window);
    if (!cap) { cap = new RateCap(1, window); caps.set(window, cap); }
    return cap;
  }
  // Keys whose ALERT post actually succeeded and whose recovery has not yet
  // been posted — the gate on `recover` posting anything at all.
  const posted = new Set<string>();
  // One "posting is not configured" line per key, not one per raise: this
  // is the ordinary state of an ungranted daemon and must not become its
  // own log flood. Grepping the condition's own marker still shows every
  // occurrence of the condition.
  const postingUnconfiguredWarned = new Set<string>();
  // A post is awaited, and a raise can be called on every 5-second poll —
  // without this, a slow or hanging post would be dispatched repeatedly.
  const inFlight = new Set<string>();

  /**
   * The one place a post is actually attempted. `cap`/`capKey` carry the
   * dedup decision, which is made BEFORE dispatch and recorded only on
   * SUCCESS — a failed post leaves the window unconsumed so the next raise
   * genuinely retries, mirroring `attemptTierNotify`'s own
   * failure-is-not-latched discipline in `./escalation-loop.ts`.
   */
  function dispatch(capKey: string, cap: RateCap, window: number, kind: "alert" | "recovery", key: string, text: string, onSuccess: () => void): void {
    const post = deps.post;
    if (!post) {
      if (!postingUnconfiguredWarned.has(key)) {
        postingUnconfiguredWarned.add(key);
        deps.log(
          `${OPS_ALERT_MARKER} ${key}: Rocket.Chat posting is not configured (no BUTCHR_TEAM_ADMIN_ROCKETCHAT_* credential) — this ${kind} reached the journal and /health only. ` +
            `Configure the poster to make conditions like this one visible without someone already watching this log.`,
        );
      }
      return;
    }
    const now = deps.now();
    if (!cap.allow(capKey, now)) {
      deps.log(`${OPS_ALERT_MARKER} ${key}: ${kind} post suppressed as a duplicate inside the ${Math.round(window / 60_000)}m dedup window — the condition is unchanged and still recorded here and in /health.`);
      return;
    }
    if (inFlight.has(capKey)) return;
    inFlight.add(capKey);
    // `post(...)` is wrapped because a poster that throws SYNCHRONOUSLY
    // (rather than returning a rejected promise) would otherwise escape a
    // bare `void post(...).catch()` and reach the detector that raised the
    // alert — the one failure shape `.catch()` alone does not cover, and the
    // one this route must never let through. `Promise.resolve().then(...)`
    // turns both shapes into the same rejection.
    void Promise.resolve()
      .then(() => post(deps.room, text))
      .then(() => {
        cap.record(capKey, deps.now());
        onSuccess();
        deps.log(`${OPS_ALERT_MARKER} ${key}: ${kind} posted to #${deps.room}`);
      })
      .catch((e: unknown) => {
        // FAILS OPEN, and deliberately does NOT consume the dedup window:
        // the next raise for this key retries. Never rethrown — this is a
        // floating promise by design, and a rejection reaching the detector
        // would take down the channel that was already working.
        deps.log(`WARNING: ${OPS_ALERT_MARKER} ${key}: ${kind} post to #${deps.room} FAILED, will retry on the next raise: ${(e as Error)?.message ?? e}`);
      })
      .finally(() => { inFlight.delete(capKey); });
  }

  return {
    raise(alert: OpsAlert): void {
      // A caller that overrides the window is expected to do so consistently
      // for a given key: the window is part of how that key's own cap is
      // looked up, so alternating windows for one key would consult two
      // different caps and dedup neither properly. The credential-death
      // caller does not override at all.
      const window = alert.dedupWindowMs ?? windowMs;
      dispatch(alert.key, capFor(alertCaps, window), window, "alert", alert.key, opsAlertMessage(alert, deps.host, deps.mention), () => { posted.add(alert.key); });
    },
    recover(recovery: OpsRecovery): void {
      if (!posted.has(recovery.key)) {
        // Nothing was ever successfully posted for this key, so there is
        // nothing in the room to clear. Journal it and stop — see
        // `OpsAlertRouter.recover`'s own doc comment for why a lone
        // "recovered" post is worse than silence.
        deps.log(`${OPS_ALERT_MARKER} ${recovery.key}: cleared, but no ${recovery.condition} alert had been posted to #${deps.room} for it — nothing to clear there. ${sanitizeForJournal(recovery.note)}`);
        return;
      }
      // Overridable on the same terms as `raise`, and through the same
      // kept-instance map: a caller running a short alert window wants its
      // recovery on the same clock, not silently on the router's hour.
      const window = recovery.dedupWindowMs ?? windowMs;
      dispatch(`${recovery.key}:recovered`, capFor(recoveryCaps, window), window, "recovery", recovery.key, opsRecoveryMessage(recovery, deps.host, deps.mention), () => { posted.delete(recovery.key); });
    },
  };
}
