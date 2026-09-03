import { findMarked, RateCap, HOUR_MS, type CommentRow } from "./escalation-helper.js";

/**
 * BUTCHR-221/BUTCHR-210 — the missing half of the stall deadlock-breaker.
 * `agent:stalled` (src/agents/stalled.ts, consumed by src/labels/sync.ts) is
 * a VISIBILITY signal only — a label plus a log line — and nothing in the
 * codebase ever consumed it to actually wake the agent. This module is the
 * remediator: post ONE debounced, observational wake comment per continuous
 * stalled episode, built the same way as parked.ts / frozen-asleep.ts
 * (MARKER, fingerprint, adoption-dedupe, RateCap) so it reuses the house
 * mechanism instead of inventing a second one. Closer in shape to
 * frozen-asleep.ts than parked.ts: a single latched wake, not a multi-stage
 * escalation — "post a debounced wake comment" (singular), not a ladder.
 *
 * GATING, THE MOST IMPORTANT DESIGN DECISION HERE: `check` fires on whether
 * `agent:stalled` is the label ALREADY APPLIED to the ticket — i.e. the
 * label as freshly read from Jira at the START of this poll (src/labels/
 * sync.ts's `applied`) — never on this same poll's newly-stabilized
 * candidate (`label`/`stalled` in that file, computed AFTER `applied` and
 * written to Jira only this poll, if it changed). Two reasons this must be
 * "applied", not "just-stabilized-this-poll":
 *
 * 1. FOOTING PARITY (required by this ticket): `agent:stalled` itself is
 *    deliberately delayed by AgentLabelStabilizer (two consecutive
 *    confirming polls) before it is ever written — a remediation comment is
 *    LOUDER than the label, so it must never be cheaper to trigger. Gating
 *    on `applied` is strictly a superset of "stabilized this poll": it
 *    additionally requires the label to have actually been WRITTEN and then
 *    read back as Jira's own truth on a LATER poll — never more eager than
 *    the label, only ever equal or more conservative.
 *
 * 2. THE OWN-WRITE HAZARD (this ticket's own warning, empirically real —
 *    see test/unit/stall-remediation.test.ts's own-write race test):
 *    src/labels/sync.ts's `onWrite` (wired in src/daemon/index.ts to
 *    `recordOwnWrite`) fires an ASYNC read-back of the ticket's `updated`
 *    field, RIGHT AFTER a label write, and records it under writer
 *    "daemon" in the own-write ledger (src/jira-watch/own-writes.ts) — a
 *    record that suppresses the notify ping for EVERY watcher of that
 *    ticket, including its own agent (own-writes.ts's own header comment).
 *    If a wake comment posted on the SAME poll as the `agent:stalled`
 *    write, it could land before that read-back resolves; the read-back
 *    would then capture an `updated` value that already includes the wake
 *    comment, and the very next poll would swallow the wake it was meant to
 *    deliver — the deadlock-breaker firing and being silently eaten by the
 *    mechanism built to stop the daemon nudging agents about its own label
 *    churn. Gating on `applied` (necessarily at least one full poll behind
 *    the write, since `applied` is read at the TOP of a poll, before that
 *    poll's own writes happen) guarantees a full poll interval between the
 *    label write and any comment this module posts. That margin is not
 *    hopeful: own-writes.ts's own TTL comment states its window is sized
 *    for "one write + one read-back + one poll cycle" — this module simply
 *    never acts inside that window for the SAME state transition.
 *
 * This does NOT weaken the ledger (untouched) — it sequences the caller so
 * the write this module makes is never a candidate for being folded into
 * another write's read-back in the first place.
 */

export const MARKER = "[butchr:stall]";

/** Mirrors parked.ts/frozen-asleep.ts's per-target escalation budget — a backstop here, since the spokenAt latch below is the primary (and normally sole) debounce. */
const MAX_PER_HOUR = 3;

interface Entry {
  /**
   * This module's OWN first observation of `agent:stalled` as the APPLIED
   * label for this ticket — NOT the true idle-since-spawn floor
   * stalled.ts's own StalledTracker keeps (that is a longer, earlier
   * duration; already surfaced, without a number, by src/labels/sync.ts's
   * own unconditional "[labels] <key> stalled: ..." line). Reported elapsed
   * time is honest about what THIS module measured: how long it has
   * continuously observed the label applied, the same relationship
   * frozen-asleep.ts's own floor has to ITS candidate condition.
   */
  firstObservedAt: number;
  /** Set once a wake comment has been posted (or adopted) for this continuous episode — from then on this ticket is reported suppressed on every call, with no further I/O, until it drops out of the candidate set. */
  spokenAt?: number;
}

/** Per-issue in-memory floor + "already spoken" bookkeeping — same shape as FrozenAsleepTracker (src/agents/frozen-asleep.ts). */
export class StallRemediationTracker {
  private readonly entries = new Map<string, Entry>();
  constructor(private readonly now: () => number) {}

  /** This poll's observation for a currently-candidate `issue`. */
  observe(issue: string): Entry {
    const existing = this.entries.get(issue);
    if (existing) return existing;
    const fresh: Entry = { firstObservedAt: this.now() };
    this.entries.set(issue, fresh);
    return fresh;
  }

  /** Latch `issue` as spoken-for as of `at` — only ever called once a wake comment has actually posted or been adopted. */
  markSpoken(issue: string, at: number): void {
    this.entries.get(issue)!.spokenAt = at;
  }

  /**
   * Drop tracking for `issue` — it left the candidate set (recovered, went
   * inactive, or disappeared), so a LATER stall starts a fresh IN-MEMORY
   * floor rather than inheriting a stale one (e.g. for the elapsed-minutes
   * fallback). This is NOT what makes a later re-stall skip posting again —
   * that is `findMarked` re-discovering the fingerprint on the ticket's own
   * comment history (evidence-based, not memory-based), which `forget`
   * neither helps nor hinders: dedupe by Jira evidence outlives this
   * in-memory entry entirely, exactly like frozen-asleep.ts's own
   * single-fingerprint-per-id convention (`fingerprint: ${id}`, no episode
   * component). DELIBERATE, stated here because it is easy to expect the
   * opposite: this module posts AT MOST ONE wake comment per issue for the
   * ticket's LIFETIME (until that comment is deleted), not one per episode —
   * see test/unit/stall-remediation.test.ts's own re-stall tests for the
   * behaviour this produces.
   */
  forget(issue: string): void {
    this.entries.delete(issue);
  }
}

/**
 * Deliberately OBSERVATIONAL, not accusatory — same reasoning as parked.ts /
 * frozen-asleep.ts's comment functions: the daemon can see state (idle, for
 * how long, no comment from this account) but not intent, so it reports what
 * it measured and lets the reader draw the conclusion.
 *
 * THE FINGERPRINT IS NOT LAST, DELIBERATELY (BUTCHR-210's own late-arriving
 * finding, verified independently here — see the `need` array at this
 * module's adoption check for the other half): `findMarked`
 * (escalation-helper.ts) matches an identity string with a bare
 * `body.includes(...)`, and Jira keys are not prefix-free (`"fingerprint:
 * KAN-1"` is a substring of `"fingerprint: KAN-19"`). parked.ts is immune
 * to this ONLY because its bodies always have a `stage: N` line AFTER the
 * fingerprint, so its own adoption check can delimit on the newline that
 * necessarily follows; a remediator with no stages has nothing to put after
 * the fingerprint unless it deliberately arranges one. Putting the
 * fingerprint last (the natural choice with no stage to follow it) would
 * make a delimited need (`fingerprint: ${issue}\n`) NEVER match this
 * module's own prior comment — self-adoption would always fail, and this
 * module would re-post on every poll, exactly the flood AC2 forbids. This
 * body keeps a line after the fingerprint specifically so the delimiter is
 * always present. See test/unit/stall-remediation.test.ts's AC8 regression
 * test (prefix-related keys, longer key posted first) for both halves
 * proven together — this fix is scoped to THIS module's own call site only;
 * escalation-helper.ts and every other detector are untouched.
 */
function wakeComment(issue: string, elapsedMinutes: number): string {
  return [
    `${MARKER} ${issue} has read agent:stalled, continuously, for ${elapsedMinutes} minute(s): idle or done since first observed running, with no comment from this daemon's account in that window.`,
    "",
    `fingerprint: ${issue}`,
    "",
    "This comment exists to wake this ticket's agent. If it is genuinely done, close or transition this ticket so agent:stalled clears. If it is stuck, act on this ticket now.",
  ].join("\n");
}

/**
 * The delimited identity `findMarked` matches against — see `wakeComment`'s
 * own doc comment immediately above for why the trailing `\n` (not a bare
 * `fingerprint: ${issue}`) is what actually prevents the prefix collision.
 */
const fingerprintNeedle = (issue: string): string => `fingerprint: ${issue}\n`;

/**
 * The four mutually-exclusive per-poll outcomes this ticket's legibility
 * requirement names: acted / suppressed (always with a reason) /
 * attempted-and-failed (always with the error) / not-a-candidate. A `null`
 * poll (stalled.check() could not verify) is its own SUPPRESSED reason, never
 * folded into "not-a-candidate" (which would assert "confirmed not
 * stalled") or into "acted" (which would assert "confirmed stalled") — see
 * this module's own gating: it never even reaches that branch, since
 * `labelApplied` is computed from Jira's last-known-good label, independent
 * of this poll's verification outcome.
 */
export type StallOutcome =
  | { kind: "acted"; issue: string }
  | { kind: "suppressed"; issue: string; reason: string }
  | { kind: "failed"; issue: string; error: string }
  | { kind: "not-a-candidate"; issue: string };

export interface StallRemediationDeps {
  now: () => number;
  /** Post through the daemon's single existing comment-writing seam for an issue — src/daemon/index.ts wires `ops.addComment` (the same seam parked.ts uses): syncLabels's stall path only ever targets an issue key (the project loop never wires syncLabels), so speakOnOwnChannel's project routing is not needed here. Never a second Atlassian writer. */
  addComment: (issue: string, text: string) => Promise<void>;
  /** Recent comments on the ticket, newest-first is fine — used for the dedupe/adoption check (see findMarked). */
  comments: (issue: string) => Promise<readonly CommentRow[]>;
  log?: (line: string) => void;
}

export interface StallRemediator {
  /**
   * One poll's worth of remediation for one ticket. `labelApplied` is
   * whether `agent:stalled` is the label this poll read as ALREADY applied
   * on the ticket (see this module's own top comment for why applied, never
   * this-poll's-just-stabilized value). `stalledPollResult` is this poll's
   * raw `stalled.check()` result (`true` / `false` / `null` — the three-state
   * "could not verify" outcome), threaded through UNCOLLAPSED and used only
   * to distinguish, for logging, "genuinely nothing going on" from
   * "something's brewing but the label isn't applied yet" from "could not
   * verify this poll" — it never gates whether this module acts (that is
   * `labelApplied` alone). `realElapsedMinutes`, when supplied (src/labels/
   * sync.ts passes `stalled.elapsedMinutes(issue)`), is the GENUINE
   * idle-since-spawn duration stalled.ts's own tracker measured — reported
   * in the wake comment in place of this module's own floor, which (since
   * this module acts on the very first poll it is eligible to, by design —
   * see the "footing parity" reasoning above) would otherwise always read
   * as "0 minutes" the one time it matters. Falls back to this module's own
   * floor when null/omitted (stalled.ts's optional accessor, or a fresh
   * StalledTracker post-restart with no entry yet) — still honest, just a
   * smaller number, never fabricated upward. Never throws.
   */
  check: (issue: string, labelApplied: boolean, stalledPollResult: boolean | null, realElapsedMinutes?: number | null) => Promise<StallOutcome>;
  /** Forget tracking for a ticket leaving the active/candidate set (mirrors StalledCheck.forget's call sites in src/labels/sync.ts). */
  forget: (issue: string) => void;
}

/**
 * Builds the stall remediator wired into src/labels/sync.ts as an OPTIONAL
 * dependency (omitted = disabled, exactly as `stalled` itself is optional
 * there) via src/daemon/index.ts.
 */
export function createStallRemediator(deps: StallRemediationDeps): StallRemediator {
  const tracker = new StallRemediationTracker(deps.now);
  const rateCap = new RateCap(MAX_PER_HOUR, HOUR_MS);
  // One "rate cap reached" WARNING per issue until it frees up — mirrors
  // parked.ts's `cappedLogged` / frozen-asleep.ts's own copy of the same
  // pattern: without this a permanently capped issue would log once per
  // poll forever (this module's own steady-state flood guard).
  const cappedLogged = new Set<string>();
  // Last failure reason logged per issue, so a PERMANENT write failure logs
  // once instead of once per 15s poll — mirrors src/labels/sync.ts's own
  // `loggedFailure` map; a failure whose reason actually changes still gets
  // its own line.
  const loggedFailure = new Map<string, string>();
  const log = (line: string) => deps.log?.(line);

  async function check(issue: string, labelApplied: boolean, stalledPollResult: boolean | null, realElapsedMinutes?: number | null): Promise<StallOutcome> {
    try {
      if (!labelApplied) {
        // Reset on any poll where the label is not applied — whether that's
        // "never stalled", "recovered", or "still stabilizing" — so a LATER
        // stall starts a fresh episode rather than inheriting a stale
        // spokenAt from a previous one (mirrors frozen-asleep.ts's
        // forgetMissing reasoning, applied per-call instead of per-batch
        // since this module is invoked per-issue from sync.ts's existing
        // per-issue loop).
        tracker.forget(issue);
        if (stalledPollResult === null) {
          // COULD NOT VERIFY: a genuinely third outcome, never "not a
          // candidate" (which would assert confirmed-not-stalled) — src/
          // labels/sync.ts already emits its own dedicated WARNING for this
          // case ("stalled check could not verify"), so this module stays
          // silent here rather than duplicating it (composes with, per this
          // ticket's own instruction, instead of duplicating).
          return { kind: "suppressed", issue, reason: "stalled check could not verify this poll (comments fetch failed) — not treated as stalled or not-stalled" };
        }
        if (stalledPollResult === true) {
          // Something is brewing (raw stalled this poll) but agent:stalled
          // is not yet the applied label — either still accumulating the
          // stabilizer's two consecutive confirmations, or it was just
          // written THIS poll and `applied` (read at the top of the poll,
          // before any write) has not caught up yet. Low-volume by
          // construction (this window is at most a couple of polls per
          // episode), so logged every time rather than deduped.
          log(`[stall] ${issue} stabilizer has not confirmed yet (raw stalled this poll, agent:stalled not yet applied)`);
          return { kind: "suppressed", issue, reason: "stabilizer has not confirmed yet" };
        }
        return { kind: "not-a-candidate", issue };
      }

      const e = tracker.observe(issue);
      if (e.spokenAt !== undefined) {
        // Steady state: already remediated this episode. Silent — this is
        // exactly the branch a 457-detections-over-two-hours becalming
        // re-enters every ~15s; logging it every poll is the flood this
        // ticket explicitly calls out. The ORIGINAL "acted" (or "adopted")
        // line, still in the journal, is the legible record of why.
        return { kind: "suppressed", issue, reason: `already remediated at ${new Date(e.spokenAt).toISOString()}` };
      }
      const ownFloorMinutes = Math.round((deps.now() - e.firstObservedAt) / 60_000);
      const elapsedMinutes = realElapsedMinutes ?? ownFloorMinutes;

      const rows = await deps.comments(issue).catch((err) => {
        log(`WARNING: [stall] comments fetch failed for ${issue}: ${(err as Error)?.message ?? err}`);
        return null;
      });
      // COULD NOT CHECK for an existing wake comment: fails CLOSED (posts
      // nothing this poll, retries next poll) — never "nothing to adopt,
      // post a fresh one", which would spam the ticket on every transient
      // fetch failure. Mirrors parked.ts's postStage / frozen-asleep.ts's
      // postComplaint.
      if (rows === null) return { kind: "suppressed", issue, reason: "comments fetch failed — could not check for an existing wake comment, retrying next poll" };

      const existing = findMarked(rows, MARKER, [fingerprintNeedle(issue)]);
      if (existing) {
        const adoptedAt = Date.parse(existing.created) || deps.now();
        tracker.markSpoken(issue, adoptedAt);
        log(`[stall] adopted existing wake comment for ${issue} from comment ${existing.id} (daemon restart)`);
        return { kind: "suppressed", issue, reason: `adopted existing comment ${existing.id} from ${existing.created}` };
      }

      if (!rateCap.allow(issue, deps.now())) {
        if (!cappedLogged.has(issue)) {
          cappedLogged.add(issue);
          log(`WARNING: [stall] rate cap reached (${MAX_PER_HOUR}/hour) for ${issue} — wake comment logged only, not posted (further cap hits for ${issue} are logged only once until it frees up)`);
        }
        return { kind: "suppressed", issue, reason: `rate cap reached (${MAX_PER_HOUR}/hour)` };
      }

      try {
        await deps.addComment(issue, wakeComment(issue, elapsedMinutes));
      } catch (err) {
        const message = (err as Error)?.message ?? String(err);
        // Fail LOUDLY: no state recorded that would make the next poll
        // believe this succeeded — spokenAt is untouched, so the very next
        // poll retries exactly as if nothing had been attempted.
        if (loggedFailure.get(issue) !== message) {
          loggedFailure.set(issue, message);
          log(`WARNING: [stall] wake comment write failed for ${issue}: ${message}`);
        }
        return { kind: "failed", issue, error: message };
      }
      loggedFailure.delete(issue);
      rateCap.record(issue, deps.now());
      cappedLogged.delete(issue);
      const postedAt = deps.now();
      tracker.markSpoken(issue, postedAt);
      log(`[stall] ${issue} wake comment posted (agent:stalled applied, continuously observed for ${elapsedMinutes}m)`);
      return { kind: "acted", issue };
    } catch (e) {
      const message = (e as Error)?.message ?? String(e);
      log(`WARNING: [stall] detector error for ${issue}: ${message}`);
      return { kind: "failed", issue, error: message };
    }
  }

  return { check, forget: (issue) => tracker.forget(issue) };
}
