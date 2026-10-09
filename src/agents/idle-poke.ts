import { RateCap, HOUR_MS, type CommentRow } from "./escalation-helper.js";

/**
 * FACTORY-845 — the per-rule-configurable idle poke, EXTENDING the existing
 * mechanism (src/agents/stalled.ts's `StalledTracker` + src/agents/
 * stall-remediation.ts) rather than duplicating its detection from scratch,
 * while remaining a SEPARATE thin module from `stall-remediation.ts` itself.
 * That split is a deliberate, argued design decision (acceptance 8), not an
 * oversight:
 *
 * `stall-remediation.ts`'s `check` gates on `agent:stalled` as the APPLIED
 * Jira label — a label that is itself written only once the GLOBAL,
 * daemon-wide `stalledMinutes` threshold (not any per-rule override) has
 * held for two confirming polls (src/labels/sync.ts's `AgentLabelStabilizer`
 * + `stalled.ts`'s own single global-threshold instance). A per-rule
 * `idlePokeMinutes` can be SHORTER than the global default (an urgent rule
 * wanting a 5-minute nudge) or LONGER (a relaxed rule wanting 2 hours) —
 * either way, gating a per-rule poke on a label that only ever reflects the
 * GLOBAL threshold would either delay a shorter override until the global
 * default caught up, or fire a longer override's poke too early, riding on
 * a label meant for a different number entirely. Retiming
 * `stall-remediation.ts` itself to read a per-rule threshold would also mean
 * retiming `agent:stalled` (the LABEL, a separately-consumed dashboard/
 * `/health` signal) to the same per-rule number, which is a second,
 * unrelated behaviour change this story was explicitly told NOT to make
 * ("do not retime or disable the live stall detector... retiming happens
 * once, in your story, with the guards in place" refers to the EFFECTIVE
 * THRESHOLD an agent experiences, not to repurposing the label itself).
 *
 * So this module depends on, rather than extends:
 *  - `StalledTracker`'s own streak, via `StalledCheck.streakStart` (added by
 *    this same story, stalled.ts) — the exact "idle episode" the brief's
 *    guard 1 asks for, reused wholesale rather than a second tracker with
 *    its own floor. A `working`/`blocked` observation resets it exactly as
 *    it always has; this module adds no second notion of "episode".
 *  - the SAME own-identity comment convention `src/agents/silent-stop.ts`
 *    already implements (`body.startsWith(`[${issue}] `)`) as the negative
 *    gate for guards 3 and 6 (see `accountedForSince` below). No exported
 *    helper exists for this one-line predicate (verified — silent-stop.ts
 *    inlines it, stall-remediation.ts's ask-check uses the SAME shape for a
 *    different key), so it is reproduced here byte-for-byte rather than
 *    loosened; silent-stop.ts itself is untouched (module boundary —
 *    FACTORY-845's own ticket text).
 *  - `escalation-helper.ts`'s `RateCap`/`HOUR_MS`, the same backstop every
 *    sibling detector (`parked.ts`, `frozen-asleep.ts`, `stall-remediation.ts`,
 *    `pinned-active.ts`) already uses.
 *
 * `stalled.ts` and `stall-remediation.ts` are otherwise BYTE-FOR-BYTE
 * untouched by this story (one additive, optional member added to
 * `StalledCheck` — see that file's own comment) — the live global stall
 * wake keeps firing exactly as it does today, on its own clock, through its
 * own comment-only path. This module is a second, independent consumer of
 * the SAME underlying streak, not a replacement for anything.
 *
 * EPISODE / GUARD 1: identified by `StalledTracker`'s own `streakStart`
 * instant. A poke latches `pokedAt` for that exact `streakStart`; a later
 * poll with a DIFFERENT `streakStart` (the streak broke and restarted —
 * i.e. the agent took a turn) is a new episode and may poke again. In-memory
 * only, matching every sibling tracker in this codebase: a daemon restart
 * loses this latch, but it ALSO resets `StalledTracker`'s own floor (same
 * process, same instance) — so a restart can only ever DELAY a poke to a
 * freshly-measured streak, never duplicate one across the restart boundary.
 *
 * GUARD 2 (permission dialog) IS SATISFIED BY CONSTRUCTION, not by a check
 * in this file: `StalledTracker.observe` only ever runs its streak while the
 * observed label is `"idle"` (`src/labels/plan.ts`'s `mapAgentStatus`
 * collapses herdr's `done` into `"idle"` too) — an agent `"blocked"` on a
 * permission dialog resets `idleSince` to `null` on every single poll it
 * stays blocked (see stalled.ts's own `observe`), so `streakStart` is never
 * non-null for a dialog-blocked agent and this module never even reaches
 * its own threshold check for one. Reusing the SAME streak that already
 * encodes "blocked breaks the streak" is what gives this guard for free —
 * named here so a reader does not go looking for a dedicated check that
 * does not exist.
 *
 * GUARD 3 (In Review waiting on a human) is a direct status check — the
 * ticket's OWN current status, read fresh every poll by the caller
 * (src/labels/sync.ts already has `issue.status` in hand for every ticket
 * it processes; no second Jira read).
 *
 * GUARD 6 (idle because blocked on an unanswered human decision) is the
 * own-identity NEGATIVE GATE this ticket's own description recommends: do
 * not poke an issue whose own-identity comment (`[${issue}] ` prefix —
 * `tagComment`'s convention, src/tools/relationship.ts) postdates the start
 * of the current idle episode. This ALSO strengthens guard 3 (a ticket that
 * is not literally "In Review" but has just posted a complete status and
 * correctly parked is caught the same way) — see this story's own PR body
 * for the FACTORY-836 (23:28 status, poked 11 minutes later) fixture this
 * gate is built to suppress.
 *
 * GUARD 4 (restart/herdr-reconnect suppression) and THE 90-SECOND TRAP:
 * this module keeps its OWN `lastInvokedAt`/`lastDiscontinuityAt` pair,
 * independently of silent-stop.ts's (module boundary: do not share mutable
 * state across the two, and do not import silent-stop.ts's internals,
 * which are not exported). The SAME precondition applies: this only reads a
 * gap between its own consecutive invocations correctly when `check()` is
 * called EVERY poll for every active issue, never on a slower timer — see
 * this module's own `check` doc comment and test/unit/idle-poke.test.ts's
 * "evaluated every poll" vs "evaluated on a slow cadence" pair, which is
 * this story's required acceptance-7 test.
 *
 * GUARD 5 (`enabled: false`) and THE FIRST-ENABLE BURST (a fleet-wide
 * per-poll cap, `maxPokesPerPoll`) and DRY-RUN are all handled in `check`
 * below — see each guard's own inline comment for the reasoning, and this
 * story's PR body for the sizing argument against the admission-cap figure
 * (FACTORY-845's ticket comment 32xxx) and the dry-run-default argument.
 */

export const MARKER = "[butchr:idle-poke]";

/** Mirrors every sibling detector's per-target hourly backstop (parked.ts, frozen-asleep.ts, stall-remediation.ts, pinned-active.ts). The per-episode latch is the primary (and normally sole) debounce; this only guards against a pathological case (e.g. a flapping streak) where many "new episodes" land in one hour. */
const MAX_PER_HOUR = 3;

export interface IdlePokeRuleConfig {
  /** Per-rule override, minutes. Absent (or every matching rule leaving it absent) means "use the global `stalledMinutes` default" — NEVER 30; see this module's own top comment and FACTORY-845's ticket comment 32163 for why an absent override must not silently become the epic's 30. */
  idlePokeMinutes?: number;
  /** Per-rule override of the nudge/comment text. Absent means the engine's own configured default (DEFAULT_IDLE_POKE_MESSAGE). */
  idlePokeMessage?: string;
  /** Resolved boolean — the caller applies `?? true` (mirrors `Rule.idlePokeEnabled`'s own always-resolved-by-parseRules convention). `false` pokes nothing for this issue at all. */
  idlePokeEnabled: boolean;
}

export type IdlePokeOutcome =
  | { kind: "poked"; issue: string; via: "channel" | "prompt" }
  | { kind: "skipped"; issue: string; reason: string }
  | { kind: "suppressed"; issue: string; reason: string }
  | { kind: "not-a-candidate"; issue: string };

export interface IdlePokeDeliverResult {
  via: "channel" | "prompt";
}

export interface IdlePokeDeps {
  now: () => number;
  /**
   * DRY-RUN is the chosen default for the MERGED code (see this module's
   * top comment / this story's PR body for the justification: FACTORY-738
   * shipped the same default for the same reason — a mass-wake-up hazard
   * nobody has measured yet against THIS fleet). `true` evaluates every
   * guard and logs every outcome but calls neither `addComment` nor
   * `deliver` — ever. Flipped to `false` only by the daemon operator
   * (`BUTCHR_IDLE_POKE_MODE=live`), never by this module itself.
   */
  dryRun: boolean;
  /** Fallback threshold (minutes) when a ticket's rule(s) leave `idlePokeMinutes` unset — `config.stalledMinutes`, NEVER a hardcoded 30. */
  globalMinutes: number;
  /** Fallback nudge/comment text when a ticket's rule(s) leave `idlePokeMessage` unset — `DEFAULT_IDLE_POKE_MESSAGE` (src/rules/rules.ts). */
  defaultMessage: string;
  /** Restart/herdr-reconnect suppression window, minutes — see this module's own top comment on the 90-second trap for why this is safe ONLY because `check()` is invoked every ~15s poll, never on a slower cadence. */
  suppressMinutes: number;
  /**
   * Fleet-wide cap on ACTUAL pokes (not dry-run log lines) in a single
   * poll — the first-enable-burst guard. Chosen over "baseline on first
   * observation" for simplicity and because it also bounds every OTHER
   * unpredicted burst (not just a cold start), at the cost of delaying some
   * legitimate pokes when the cap is hit — see this story's PR body for
   * the full trade argument and the sizing against the measured ~23-of-24
   * admission-cap resident population.
   */
  maxPokesPerPoll: number;
  comments: (issue: string) => Promise<readonly CommentRow[]>;
  /** The observational `[butchr:idle-poke]` Jira comment — persists as a record (FACTORY-836's own argued position, which FACTORY-868 accepted: "it does not own whether the poke also posts a Jira comment"). Posted through the daemon's single comment-writing seam (`ops.addComment`), same as every other daemon-side write. */
  addComment: (issue: string, text: string) => Promise<void>;
  /**
   * The channel half — a caller-supplied closure that itself routes
   * through the shared `deliverNotice`/`renderNotifyDelivery` gate
   * (src/notify/deliver.ts), copying one of the seven existing seams
   * exactly (acceptance 9). This module never calls `herd.nudge` or a
   * channel push directly, and never re-implements the gate's
   * channel-unavailable-falls-back-to-prompt asymmetry — it only consults
   * the `via` the shared gate already decided.
   */
  deliver: (issue: string, text: string) => Promise<IdlePokeDeliverResult>;
  log?: (line: string) => void;
}

/**
 * The named render function this story's acceptance 5 requires — so a test
 * can assert the RENDERED string, same pattern as `change-nudge.ts`'s
 * `changeNudge`/`prReviewStateNudge`. The configured text (or
 * `DEFAULT_IDLE_POKE_MESSAGE`) is already a complete, self-contained
 * instruction ("You've been idle 30 min: post your ticket comment..."), so
 * there is no ticket-identity wrapping to add here (unlike `changeNudge`'s
 * "Ticket X ..." framing, which exists because that family of nudges has no
 * single complete sentence of its own) — this function exists so the
 * identity mapping is still named, tested, and a single place to change if
 * that ever stops being true.
 */
export function renderIdlePokeNudge(messageText: string): string {
  return messageText;
}

/**
 * The observational `[butchr:idle-poke]` comment — deliberately NOT the
 * same wording family as `stall-remediation.ts`'s `wakeComment`
 * (DEFAULT_TAIL / correctlyWaitingTail): this module's comment SITS BESIDE
 * that one (a ticket can receive both, from two independent mechanisms on
 * two independent clocks), never replaces or suppresses it — see this
 * module's own top comment for why the two are deliberately independent,
 * and acceptance 5's own question, answered in this story's PR body.
 */
export function idlePokeComment(issue: string, text: string, elapsedMinutes: number): string {
  return [
    `${MARKER} ${issue} has been idle past its configured idle-poke interval, continuously for ${elapsedMinutes} minute(s): ${text}`,
    "",
    `fingerprint: ${issue}`,
    "",
    // A line AFTER the fingerprint, deliberately — see
    // stall-remediation.ts's `wakeComment` doc comment for why a bare
    // trailing `fingerprint: ${issue}` with nothing after it would let
    // `findMarked`'s substring match cross-adopt between prefix-related
    // keys (`"fingerprint: KAN-1"` is a substring of `"fingerprint:
    // KAN-19"`). This module does not currently dedupe by re-reading Jira
    // comments (its latch is in-memory, keyed off `StalledTracker`'s own
    // streakStart — see this module's top comment), but the delimiter is
    // kept anyway so a future adoption path is safe by default rather
    // than by someone remembering to add it later.
    "This comment is informational — it does not gate anything in this engine.",
  ].join("\n");
}

interface Entry {
  streakStart: number;
  pokedAt?: number;
}

export interface IdlePokeCheckInput {
  /** `StalledCheck.streakStart(issue)` — the exact instant the current idle/done streak began, or `null` when no streak is running right now (see this module's own top comment on guard 2 for why `null` already covers "blocked on a dialog"). */
  streakStart: number | null;
  /** The ticket's own current Jira status, read fresh this poll (guard 3). */
  status: string;
  /** This issue's resolved idle-poke config for this poll — `undefined` when no enabled rule carries one (the caller applies `idlePokeEnabled ?? true`, `idlePokeMinutes`/`idlePokeMessage` left absent). */
  ruleConfig?: IdlePokeRuleConfig;
}

export interface IdlePokeEngine {
  /** Reset the fleet-wide per-poll poke counter — call ONCE at the start of every poll, before any `check` call for that poll. */
  beginPoll(): void;
  /**
   * One poll's worth of idle-poke evaluation for one ticket. MUST be called
   * for EVERY active ticket, EVERY poll — including one whose `streakStart`
   * is `null` — so the restart/herdr-reconnect gap (guard 4) is measured
   * against this module's OWN consecutive-invocation cadence, not skipped
   * for some tickets and not others. See this module's own top comment on
   * the 90-second trap.
   */
  check(issue: string, input: IdlePokeCheckInput): Promise<IdlePokeOutcome>;
  /** Drop tracking for a ticket leaving the active set — mirrors every sibling tracker's `forget`. */
  forget(issue: string): void;
}

export function createIdlePokeEngine(deps: IdlePokeDeps): IdlePokeEngine {
  const entries = new Map<string, Entry>();
  const rateCap = new RateCap(MAX_PER_HOUR, HOUR_MS);
  let lastInvokedAt: number | null = null;
  let lastDiscontinuityAt = deps.now(); // daemon start, same convention as silent-stop.ts's own top comment.
  let pokesThisPoll = 0;
  const loggedCapHit = new Set<string>();
  const log = (line: string) => deps.log?.(line);

  async function check(issue: string, input: IdlePokeCheckInput): Promise<IdlePokeOutcome> {
    const nowMs = deps.now();
    // GUARD 4 / THE 90-SECOND TRAP: measured on EVERY call, unconditionally,
    // before any early return below — exactly silent-stop.ts's own
    // discipline, and for the identical reason (see this module's top
    // comment).
    if (lastInvokedAt != null && nowMs - lastInvokedAt > deps.suppressMinutes * 60_000) {
      lastDiscontinuityAt = nowMs;
    }
    lastInvokedAt = nowMs;

    if (input.streakStart == null) {
      entries.delete(issue);
      return { kind: "not-a-candidate", issue };
    }

    let e = entries.get(issue);
    if (!e || e.streakStart !== input.streakStart) {
      // Either never seen, or the streak broke and restarted since we last
      // saw it (a different `streakStart`) — a NEW episode, free to poke
      // again.
      e = { streakStart: input.streakStart };
      entries.set(issue, e);
    }

    // GUARD 5
    const enabled = input.ruleConfig?.idlePokeEnabled ?? true;
    if (!enabled) {
      return { kind: "skipped", issue, reason: "idlePokeEnabled=false for this rule" };
    }

    const minutes = input.ruleConfig?.idlePokeMinutes ?? deps.globalMinutes;
    const elapsedMs = nowMs - input.streakStart;
    const elapsedMinutes = Math.round(elapsedMs / 60_000);
    if (elapsedMs < minutes * 60_000) {
      return { kind: "not-a-candidate", issue };
    }

    // GUARD 1 (once per episode)
    if (e.pokedAt !== undefined) {
      return { kind: "suppressed", issue, reason: `already poked this episode at ${new Date(e.pokedAt).toISOString()}` };
    }

    // GUARD 3
    if (input.status === "In Review") {
      return { kind: "skipped", issue, reason: "status is In Review — idle is correct, waiting on a human" };
    }

    // GUARD 4 (the suppression window itself, now that we have a candidate)
    if (nowMs - lastDiscontinuityAt <= deps.suppressMinutes * 60_000) {
      log(`[idle-poke] ${issue} poke suppressed: within ${deps.suppressMinutes}m of a daemon start/herdr-reconnect (at ${new Date(lastDiscontinuityAt).toISOString()})`);
      return { kind: "suppressed", issue, reason: `within ${deps.suppressMinutes}m of a daemon start/herdr-reconnect` };
    }

    // GUARD 6 — own-identity negative gate. Byte-for-byte the same
    // predicate silent-stop.ts uses (`[${issue}] ` prefix, an unparseable
    // `created` fails toward "accounted for" — the safe direction for a
    // dry-run-first feature, same reasoning as stalled.ts/silent-stop.ts's
    // own `catch`/`NaN` handling).
    let rows: readonly CommentRow[];
    try {
      rows = await deps.comments(issue);
    } catch (err) {
      log(`WARNING: [idle-poke] ${issue} comments fetch failed: ${(err as Error)?.message ?? err} — not poking this poll`);
      return { kind: "suppressed", issue, reason: "comments fetch failed — could not verify own-identity gate" };
    }
    const selfTag = `[${issue}] `;
    const streakStart = input.streakStart;
    const accountedFor = rows.some((c) => {
      if (!c.body.startsWith(selfTag)) return false;
      const createdAt = Date.parse(c.created);
      return Number.isNaN(createdAt) || createdAt >= streakStart;
    });
    if (accountedFor) {
      return { kind: "skipped", issue, reason: "own-identity comment postdates the start of this idle episode — correctly waiting, not silent" };
    }

    // FIRST-ENABLE BURST / fleet-wide per-poll cap — checked after every
    // cheap guard above, so a capped poll still pays for comments() at most
    // once per genuinely-eligible candidate, same cost discipline as
    // stall-remediation.ts's rate cap placement.
    if (pokesThisPoll >= deps.maxPokesPerPoll) {
      if (!loggedCapHit.has(issue)) {
        loggedCapHit.add(issue);
        log(`WARNING: [idle-poke] fleet-wide cap (${deps.maxPokesPerPoll}/poll) reached — ${issue} deferred to a later poll`);
      }
      return { kind: "suppressed", issue, reason: `fleet-wide poke cap (${deps.maxPokesPerPoll}/poll) reached this poll` };
    }
    loggedCapHit.delete(issue);

    if (!rateCap.allow(issue, nowMs)) {
      return { kind: "suppressed", issue, reason: `rate cap reached (${MAX_PER_HOUR}/hour)` };
    }

    const text = input.ruleConfig?.idlePokeMessage ?? deps.defaultMessage;

    if (deps.dryRun) {
      log(`[idle-poke] would poke ${issue} (idle ${elapsedMinutes}m, threshold ${minutes}m)`);
      return { kind: "suppressed", issue, reason: "dry-run" };
    }

    pokesThisPoll++;
    rateCap.record(issue, nowMs);
    e.pokedAt = nowMs;

    const nudgeText = renderIdlePokeNudge(text);
    let delivery: IdlePokeDeliverResult;
    try {
      delivery = await deps.deliver(issue, nudgeText);
    } catch (err) {
      log(`WARNING: [idle-poke] ${issue} channel delivery threw unexpectedly: ${(err as Error)?.message ?? err} — treating as prompt fallback`);
      delivery = { via: "prompt" };
    }
    await deps.addComment(issue, idlePokeComment(issue, text, elapsedMinutes)).catch((err) => {
      log(`WARNING: [idle-poke] ${issue} comment write failed: ${(err as Error)?.message ?? err}`);
    });
    log(`[idle-poke] poked ${issue} (idle ${elapsedMinutes}m, threshold ${minutes}m) via ${delivery.via}`);
    return { kind: "poked", issue, via: delivery.via };
  }

  return {
    beginPoll() { pokesThisPoll = 0; },
    check,
    forget(issue: string) { entries.delete(issue); },
  };
}
