import { findMarked, type CommentRow } from "./escalation-helper.js";
import { staffingFromWorkerLabels, ASK_MARKER } from "../tools/relationship.js";

/** Post one visible comment per verified stalled episode. Ordinary comment
 * delivery wakes the ticket and its linked watchers. The notice never resets
 * the inactivity detector. Existing visible comment history supports adoption
 * after restart; observed real activity permits a later episode to speak. */

export const MARKER = "[butchr:stall]";


interface Entry {
  /**
   * This module's OWN first observation of `agent:stalled` as the APPLIED
   * label for this ticket — NOT the current-streak floor stalled.ts's own
   * StalledTracker keeps (anchored to when the agent last stopped working,
   * not to this module's own first sighting of the label; that is a longer,
   * earlier duration; already surfaced, without a number, by
   * src/labels/sync.ts's own unconditional "[labels] <key> stalled: ..."
   * line). Reported elapsed time is honest about what THIS module measured:
   * how long it has continuously observed the label applied, the same
   * relationship frozen-asleep.ts's own floor has to ITS candidate
   * condition.
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

  /** Drop local tracking; visible history still prevents duplicate adoption. */
  spokenAt(issue: string): number | undefined { return this.entries.get(issue)?.spokenAt; }

  forget(issue: string): void {
    this.entries.delete(issue);
  }
}

/**
 * Deliberately OBSERVATIONAL, not accusatory — same reasoning as parked.ts /
 * frozen-asleep.ts's comment functions: the daemon can see state (idle, for
 * how long, nobody attending — see stalled.ts's BUTCHR-289 kind×recency
 * rule) but not intent, so it reports what it measured and lets the reader
 * draw the conclusion.
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
/**
 * BUTCHR-353: what `gatherWorkerSignals` found among a stalled ticket's own
 * NON-DONE workers — three independent, non-exclusive observations (a given
 * poll can have any combination, including none). Every array holds worker
 * KEYS only, in the order `workers` was given; empty, never absent, so a
 * caller can test "any signal at all" with one `hasAnySignal` call instead
 * of three separate undefined-checks.
 */
interface WorkerSignals {
  /** Non-Done workers whose own `[ask]`-tagged comment (identity-tagged with THAT worker's own key) has no later reply tagged with THIS ticket's own key — see `gatherWorkerSignals` for the exact rule and its stated failure mode. */
  unansweredAsks: readonly string[];
  /** Non-Done workers currently `status === "In Review"` — (B2), free from `WorkerLink.status` alone, no labels read needed. */
  inReview: readonly string[];
  /** Non-Done, non-In-Review workers BUTCHR-352's own label-path rule (`staffingFromWorkerLabels`) confidently reads as `withheld` — never a stale or stranded marker (see that function's own doc comment: `could-not-look` and a stale non-`agent:none` label both fall through to nothing here, never a guessed "waiting"). */
  withheldAtCap: readonly string[];
}

const NO_SIGNALS: WorkerSignals = { unansweredAsks: [], inReview: [], withheldAtCap: [] };

function hasAnySignal(s: WorkerSignals): boolean {
  return s.unansweredAsks.length > 0 || s.inReview.length > 0 || s.withheldAtCap.length > 0;
}

/** Today's original wake advice — UNCHANGED, byte-for-byte, from before this ticket: the branch for a stall with none of BUTCHR-353's new signals (DoD: "a stall with none of these conditions still produces today's wake, unchanged"). Pinned by test/unit/stall-remediation.test.ts. */
const DEFAULT_TAIL = "This comment exists to wake this ticket's agent. If it is genuinely done, close or transition this ticket so agent:stalled clears. If it is stuck, act on this ticket now.";

/**
 * BUTCHR-353's new branch: built ONLY when `hasAnySignal` is true. Starts
 * with its OWN distinct tag (`[butchr:stall:waiting]`, never confused with
 * `DEFAULT_TAIL`'s plain prose by a reader skimming the comment, or by a
 * test asserting which shape a body is — see this ticket's own "keep
 * discontinuities legible" requirement) and DELIBERATELY never contains the
 * words "close or transition" or "act on this ticket now" as advice —
 * BUTCHR-207's own measurement is that both are actively harmful to a
 * ticket that is correctly waiting: closing/transitioning cancels a queued
 * spawn or abandons a live review hop, and "act now" means re-asserting a
 * disposition that is already correct. One physical line (house rule:
 * fields before free text, a multi-line value stays on one line) — clauses
 * joined with spaces, never embedded newlines, so `findMarked`'s own
 * marker-at-body-start check and this module's fingerprint delimiter are
 * both unaffected by which branch fired.
 */
function correctlyWaitingTail(s: WorkerSignals): string {
  const clauses: string[] = [];
  if (s.unansweredAsks.length) {
    clauses.push(`${s.unansweredAsks.join(", ")} asked you something (an [ask] comment on its own ticket) that has no reply from you yet — answer it there with tell_worker, that is what it is waiting on.`);
  }
  if (s.inReview.length) {
    clauses.push(`${s.inReview.join(", ")} is In Review, waiting on your own review of it — that review is what to act on, not this ticket.`);
  }
  if (s.withheldAtCap.length) {
    clauses.push(`${s.withheldAtCap.join(", ")} is withheld at the fleet-wide admission cap (admission:withheld) and will be admitted when a slot frees — nothing to do but wait.`);
  }
  return (
    `[butchr:stall:waiting] This looks like correct waiting, not done or stuck, based on your own worker(s): ${clauses.join(" ")} ` +
    "Do not close or transition this ticket over this, and there is nothing to re-assert — a disposition that is already correct only gets withheld again. " +
    "Saying what you are waiting on is what clears agent:stalled — a comment from you saying so counts; this one does not, since it starts with \"[butchr:\". If none of the above is what you are ACTUALLY waiting on, say so and act."
  );
}

function wakeComment(issue: string, elapsedMinutes: number, signals: WorkerSignals = NO_SIGNALS): string {
  return [
    `${MARKER} ${issue} has read agent:stalled, continuously, for ${elapsedMinutes} minute(s): idle or done since it last stopped working, with no non-daemon-chatter comment landing during that streak.`,
    "",
    `fingerprint: ${issue}`,
    "",
    hasAnySignal(signals) ? correctlyWaitingTail(signals) : DEFAULT_TAIL,
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
 * attempted-and-failed (always with the error) / not-a-candidate.
 *
 * Unknown observations suppress a new notice without closing the episode.
 */
export type StallOutcome =
  | { kind: "acted"; issue: string }
  | { kind: "suppressed"; issue: string; reason: string }
  | { kind: "failed"; issue: string; error: string }
  | { kind: "not-a-candidate"; issue: string };

/**
 * BUTCHR-353: one of a stalled ticket's own workers, as read off the SAME
 * search payload src/labels/sync.ts already fetches this poll to drive
 * everything else it does (`JiraIssue.issuelinks`, src/atlassian/client.ts's
 * `search()` — its `fields` param always includes `issuelinks`, and
 * `parseIssueLinks` hydrates each stub's `status`) — filtered to `Implements`
 * / `otherEnd: "outward"`, i.e. the stalled ticket's own children. ZERO extra
 * Jira calls to build this: it is a re-shaping of data sync.ts already has in
 * hand for the SAME issue this poll, not a second read. `status` is
 * `undefined` only when Jira's stub genuinely didn't hydrate it — treated the
 * same as "unknown", never "Done" (see `gatherWorkerSignals`'s own doc
 * comment for how that absence is handled).
 */
export interface WorkerLink {
  key: string;
  status?: string;
}

export interface StallRemediationDeps {
  now: () => number;
  /** Post through the daemon's single existing comment-writing seam for an issue — src/daemon/index.ts wires `ops.addComment` (the same seam parked.ts uses): syncLabels's stall path only ever targets an issue key (the project loop never wires syncLabels), so speakOnOwnChannel's project routing is not needed here. Never a second Atlassian writer. */
  addComment: (issue: string, text: string) => Promise<void>;
  /** Recent comments on the ticket, newest-first is fine — used for the dedupe/adoption check (see findMarked). Also reused, unchanged, against a stalled ticket's own WORKER keys (see `gatherWorkerSignals`) to find an unanswered `[ask]` — the SAME reader, never a second one, since both are "recent comments on some issue key", not two different facts. */
  comments: (issue: string) => Promise<readonly CommentRow[]>;
  /**
   * BUTCHR-353: a worker's own labels — used ONLY for a stalled ticket's
   * non-Done workers (see `gatherWorkerSignals`), to determine "withheld at
   * the admission cap" via BUTCHR-352's own LABEL-path rule
   * (`staffingFromWorkerLabels`, src/tools/relationship.ts). OPTIONAL:
   * omitted disables the "correctly waiting on admission" branch only — the
   * ask/In-Review branches (which don't need labels) still work, and every
   * existing caller/fixture that doesn't supply it is unaffected, same
   * convention as `quotaBlocked` above. Deliberately NOT a herd/live probe:
   * a boss's worker is staffed under a DIFFERENT account than the boss (by
   * this fleet's own tier->account split), so a probe wired here would be
   * structurally blind to every worker it could ever be asked about — see
   * `staffingFromAgentLabel`'s own doc comment (relationship.ts) for why
   * that makes the label path, not a probe, the only honest source here.
   * Paid at most once per non-Done worker, and ONLY on the poll that is
   * actually about to compose a wake comment (after the adoption/rate-cap
   * gate below) — never on a steady-state "already remediated" poll, and
   * never for a Done worker.
   */
  labels?: (key: string) => Promise<readonly string[]>;
  /**
   * BUTCHR-221 criterion 10 (2026-09-02's first-phase becalming: panes
   * parked at a Claude session-limit refusal). OPTIONAL — omitted disables
   * this gate entirely, exactly as `stalled`/`stallRemediation` are already
   * optional elsewhere, so every existing caller/fixture is unaffected.
   * SYNCHRONOUS by design: this is called from inside a per-issue poll and
   * must never itself do I/O. src/daemon/index.ts supplies it from
   * src/agents/quota-gate.ts, which tees the SAME pane reads
   * src/agents/session-limit-watch.ts already performs through the SAME
   * src/agents/session-limit.ts recogniser — no second banner parser, no
   * second detection path. A quota-blocked pane cannot read a wake comment,
   * and posting into it burns the very session quota whose return ends the
   * outage — the sharper of the two reasons this must be checked, and
   * checked BEFORE `comments()` below so a quota-blocked ticket costs no
   * Jira read per poll.
   */
  quotaBlocked?: (issue: string) => boolean;
  log?: (line: string) => void;
}

export interface StallRemediator {
  /**
   * One poll's worth of remediation for one ticket. `labelApplied` is
   * whether `agent:stalled` is the label this poll read as ALREADY applied
   * on the ticket (see this module's own top comment for why applied, never
   * this-poll's-just-stabilized value). `stalledPollResult` is this poll's
   * raw `stalled.check()` result (`true` / `false` / `null` — the three-state
   * "could not verify" outcome). A post requires both a verified current stall
   * and an already applied label. `realElapsedMinutes`, when supplied (src/labels/
   * sync.ts passes `stalled.elapsedMinutes(issue)`), is the GENUINE
   * current-streak duration stalled.ts's own tracker measured — reported
   * in the wake comment in place of this module's own floor, which (since
   * this module acts on the very first poll it is eligible to, by design —
   * see the "footing parity" reasoning above) would otherwise always read
   * as "0 minutes" the one time it matters. Falls back to this module's own
   * floor when null/omitted (stalled.ts's optional accessor, or a fresh
   * StalledTracker post-restart with no entry yet) — still honest, just a
   * smaller number, never fabricated upward. Never throws.
   *
   * `workers` (BUTCHR-353), when supplied, is the stalled ticket's OWN
   * workers (src/labels/sync.ts passes `issue.issuelinks` filtered to
   * outward `Implements` links — zero extra Jira calls, see `WorkerLink`'s
   * own doc comment) — used to decide whether this wake should name a
   * "correctly waiting" state (a worker withheld at the admission cap, or
   * In Review awaiting this ticket's own review) or an unanswered `[ask]`
   * from one of them, INSTEAD of the harmful default advice to close,
   * transition, or "act now". Omitted or empty falls back to exactly
   * today's wake text, unchanged (see `gatherWorkerSignals`'s own doc
   * comment for the full rule and its cost).
   */
  check: (issue: string, labelApplied: boolean, stalledPollResult: boolean | null, realElapsedMinutes?: number | null, workers?: readonly WorkerLink[], activityAt?: number | null) => Promise<StallOutcome>;
  /** Forget tracking for a ticket leaving the active/candidate set (mirrors StalledCheck.forget's call sites in src/labels/sync.ts). */
  forget: (issue: string) => void;
}

/**
 * BUTCHR-353: turns a stalled ticket's own `workers` into `WorkerSignals`.
 * Called at most once per stalled EPISODE (see the one call site's own
 * comment) — never per poll — so its cost is paid once, not repeatedly.
 *
 * SCOPE, PER WORKER: a Done worker is excluded from every check below —
 * finished work has nothing left to wait on, mirroring `openWorkers`'s own
 * non-Done filter (src/tools/relationship.ts) for the SAME reason. Every
 * other (non-Done) worker is checked for an unanswered `[ask]` regardless of
 * its own status; withheld-at-cap is checked ONLY when the worker is not
 * already In Review — status (read fresh this poll, off `WorkerLink`) is a
 * live observation and outranks a possibly-stale `admission:withheld`
 * marker sitting on a ticket that has since moved past admission entirely,
 * the same "a live read outranks a label" discipline `checkWorker` itself
 * applies (relationship.ts).
 *
 * COST BOUND, STATED (per this ticket's own requirement): for N non-Done
 * workers, at most N `deps.comments` calls (the ask check, every non-Done
 * worker) plus at most N `deps.labels` calls (the withheld check, only the
 * non-In-Review subset) — i.e. at most 2N extra Jira reads, bounded by the
 * stalled ticket's own child count (this fleet's admission cap already
 * bounds how many agents — hence how many live worker tickets — can exist
 * fleet-wide at once; no separate artificial cap is added here, matching
 * `openWorkers`'s own already-accepted unbounded-by-worker-count cost
 * profile). Neither dep is required: `labels` omitted simply never finds a
 * withheld worker (the ask/In-Review checks are unaffected); `workers`
 * omitted or empty short-circuits to zero calls and `NO_SIGNALS`.
 *
 * UNKNOWN NEVER BECOMES A CONFIDENT CLAIM (this ticket's central
 * requirement), CORRECTED (found at review — an earlier version of this
 * comment overstated it, and BUTCHR-311's own doc repeated the overstatement
 * upward): a `deps.labels`/`deps.comments` rejection for a given worker is
 * caught, logged, and drops ONLY the signal that read was for — NOT every
 * signal for that worker. `inReview` is read off `w.status` alone (no I/O,
 * see the loop below), so a failed `comments()` never touches it; a failed
 * `comments()` drops only that worker's `unansweredAsks` claim, and a failed
 * `labels()` drops only its `withheldAtCap` claim — the other signal(s) for
 * the SAME worker still post if they were themselves observed. Each signal
 * rests on its own observation, and a failed read removes only the claim
 * that rested on it; it never invents one. The worst case per signal is
 * under-reporting (that one claim falls through toward `NO_SIGNALS`, i.e.
 * today's existing wake text, if nothing else fired either) rather than a
 * false "you are correctly waiting" — the asymmetry this whole ticket exists
 * to enforce.
 *
 * THE ASK RULE, STATED: the newest comment on a worker's own ticket that
 * starts with `[<workerKey>] [ask]` (askBoss's own identity-tag + ASK_MARKER
 * shape, relationship.ts) is "answered" if any comment ABOVE it (more
 * recent, since `comments` is newest-first) starts with `[<stalledKey>] `
 * (tellWorker's own identity-tag shape) — a reply from THIS boss,
 * specifically. FAILURE MODE 1, STATED (per this ticket's own requirement): a
 * worker that itself moves past its own question without this boss ever
 * replying (e.g. it found another way forward) still reads as "unanswered"
 * here — a false positive. Accepted deliberately: naming a stale question is
 * redundant at worst, never the harmful direction (a false "you are done or
 * stuck" or a false "you are correctly waiting") this ticket exists to stop.
 *
 * FAILURE MODE 2, STATED (found at review — an undisclosed blind window a
 * green suite cannot see): `deps.comments` is wired to `AtlassianClient.
 * comments()` (src/atlassian/client.ts), whose `maxResults` DEFAULTS to 20
 * and is never overridden on this path (src/daemon/index.ts's wiring) — so
 * this only ever sees a worker's 20 NEWEST comments, never the full history.
 * An `[ask]` sitting behind 20 more recent comments on a busy worker ticket
 * is INVISIBLE here: `askIdx` never finds it, and the wake silently falls
 * back to today's default text — the exact founding shape scope (C) was
 * built to catch (BUTCHR-316/BUTCHR-341), missed by this same rule, if the
 * ask is old enough. STILL THE SAFE DIRECTION (under-reporting, never a
 * false "correctly waiting").
 *
 * WHY NOT FIXED HERE, CORRECTED (found at review — the reason this comment
 * previously gave does not survive measurement, and this ticket's own PR
 * body/doc, plus BUTCHR-311's own PR body/doc, both repeated the wrong
 * reason upward before it was caught): this is NOT a cost-bound tradeoff.
 * The withheld check below already pays for one `getIssue` per non-Done
 * worker, and that response's embedded `fields.comment` block would appear
 * to let the ask check reuse the SAME read — taking the bound from 2N to N
 * and REMOVING the window entirely, not disturbing anything.
 *
 * The real reason is a standing precedent this codebase already paid for,
 * the hard way: an earlier read (src/tools/defs.ts, in-review-epic comment
 * gathering — verify at your own commit) tried exactly this, serving from
 * `getIssue`'s embedded block instead of a paginating reader, and was found
 * at review to be ASCENDING/oldest-first with an unconfirmed cap — silently
 * disagreeing with discovery's own newest-first reader if ever truncated.
 * BUTCHR-311 independently confirmed this shape on five live `getIssue`
 * payloads (`returned == total == maxResults` on every one — 12, 6, 14, 18,
 * 8 — embedded list oldest-first, matching defs.ts's finding), with two
 * stated limits on that measurement: it went through an older daemon's
 * tooling, not this PR's own wiring, and the largest list seen was ~71, so
 * a cap above that remains unconfirmed. Verify both the defs.ts precedent
 * and BUTCHR-311's measurement yourself rather than trusting this citation.
 *
 * The rule above also needs newest-first order (it walks from the newest
 * comment down looking for the `[ask]`); the embedded block runs the other
 * way, so reusing it would need the walk direction inverted, and getting
 * that backwards fails quietly rather than loudly — a second, sharper
 * reason not to. Given that precedent, `deps.comments` (`AtlassianClient.
 * comments()`, paginating, newest-first) stays the ask check's only reader:
 * do NOT raise `maxResults`, add paging, or switch to the embedded block to
 * close this window. A reader debugging "the wake didn't name an ask I know
 * is there" should check the worker ticket's own comment count FIRST,
 * against this 20-comment window, before suspecting the rule above.
 */
async function gatherWorkerSignals(deps: StallRemediationDeps, stalledKey: string, workers: readonly WorkerLink[] | undefined, log: (line: string) => void): Promise<WorkerSignals> {
  const nonDone = (workers ?? []).filter((w) => w.status !== "Done");
  if (nonDone.length === 0) return NO_SIGNALS;

  const unansweredAsks: string[] = [];
  const inReview: string[] = [];
  const withheldAtCap: string[] = [];

  for (const w of nonDone) {
    if (w.status === "In Review") inReview.push(w.key);

    const rows = await deps.comments(w.key).catch((err) => {
      log(`WARNING: [stall] ${stalledKey}: comments fetch failed for its own worker ${w.key} while composing a wake comment: ${(err as Error)?.message ?? err} — not claiming an ask either way`);
      return null;
    });
    if (rows) {
      const askIdx = rows.findIndex((r) => r.body.startsWith(`[${w.key}] ${ASK_MARKER}`));
      if (askIdx !== -1) {
        const answered = rows.slice(0, askIdx).some((r) => r.body.startsWith(`[${stalledKey}] `));
        if (!answered) unansweredAsks.push(w.key);
      }
    }

    if (w.status !== "In Review" && deps.labels) {
      const labels = await deps.labels(w.key).catch((err) => {
        log(`WARNING: [stall] ${stalledKey}: labels fetch failed for its own worker ${w.key} while composing a wake comment: ${(err as Error)?.message ?? err} — not claiming withheld`);
        return null;
      });
      if (labels && staffingFromWorkerLabels(labels).staffing === "withheld") withheldAtCap.push(w.key);
    }
  }

  return { unansweredAsks, inReview, withheldAtCap };
}

/**
 * Builds the stall remediator wired into src/labels/sync.ts as an OPTIONAL
 * dependency (omitted = disabled, exactly as `stalled` itself is optional
 * there) via src/daemon/index.ts.
 */
export function createStallRemediator(deps: StallRemediationDeps): StallRemediator {
  const tracker = new StallRemediationTracker(deps.now);
  const closedBefore = new Map<string, number>();
  const pending = new Map<string, Promise<StallOutcome>>();
  const loggedFailure = new Map<string, string>();
  const quotaLogged = new Set<string>();
  const log = (line: string) => deps.log?.(line);

  async function evaluate(issue: string, labelApplied: boolean, stalledPollResult: boolean | null, realElapsedMinutes?: number | null, workers?: readonly WorkerLink[], activityAt?: number | null): Promise<StallOutcome> {
    try {
      if (stalledPollResult === false) {
        const spokenAt = tracker.spokenAt(issue);
        // Raising a configured timeout does not constitute real activity.
        if (activityAt === undefined || activityAt === null || spokenAt === undefined || activityAt > spokenAt) {
          if (spokenAt !== undefined) closedBefore.set(issue, Math.max(deps.now(), spokenAt));
          tracker.forget(issue);
        }
        return { kind: "not-a-candidate", issue };
      }
      if (stalledPollResult === null) return { kind: "suppressed", issue, reason: "stalled check could not verify this poll (comments fetch failed) - not treated as stalled or not-stalled" };
      if (!labelApplied) return { kind: "suppressed", issue, reason: "stabilizer has not confirmed yet" };
      const e = tracker.observe(issue);
      if (e.spokenAt !== undefined) return { kind: "suppressed", issue, reason: `already remediated at ${new Date(e.spokenAt).toISOString()}` };
      if (deps.quotaBlocked?.(issue)) {
        if (!quotaLogged.has(issue)) {
          quotaLogged.add(issue);
          log(`[stall] ${issue} quota-blocked - suppressing wake comment`);
        }
        return { kind: "suppressed", issue, reason: "quota-blocked" };
      }
      if (quotaLogged.delete(issue)) log(`[stall] ${issue} no longer quota-blocked - wake comment eligible again`);
      const rows = await deps.comments(issue).catch((err) => {
        log(`WARNING: [stall] comments fetch failed for ${issue}: ${(err as Error)?.message ?? err}`);
        return null;
      });
      if (rows === null) return { kind: "suppressed", issue, reason: "comments fetch failed - could not check for an existing wake comment, retrying next poll" };
      // Only real activity closes an episode. Daemon notices and label churn
      // cannot rearm it. No episode identifier or counter is written to Jira.
      const activity = rows.filter(r => !r.body.startsWith("[butchr:"));
      if (activity.some(r => !Number.isFinite(Date.parse(r.created)))) return { kind: "suppressed", issue, reason: "comment activity time could not be verified" };
      const floor = Math.max(closedBefore.get(issue) ?? -Infinity, ...activity.map(r => Date.parse(r.created)));
      const existing = findMarked(rows.filter(r => !Number.isFinite(Date.parse(r.created)) || Date.parse(r.created) > floor), MARKER, [fingerprintNeedle(issue)]);
      if (existing) {
        const createdAt = Date.parse(existing.created);
        tracker.markSpoken(issue, Number.isFinite(createdAt) ? createdAt : deps.now());
        log(`[stall] adopted existing wake comment for ${issue} from comment ${existing.id} (daemon restart)`);
        return { kind: "suppressed", issue, reason: `adopted existing comment ${existing.id} from ${existing.created}` };
      }
      const elapsedMinutes = realElapsedMinutes ?? Math.round((deps.now() - e.firstObservedAt) / 60_000);
      const signals = await gatherWorkerSignals(deps, issue, workers, log);
      try { await deps.addComment(issue, wakeComment(issue, elapsedMinutes, signals)); }
      catch (err) {
        const message = (err as Error)?.message ?? String(err);
        if (loggedFailure.get(issue) !== message) {
          loggedFailure.set(issue, message);
          log(`WARNING: [stall] wake comment write failed for ${issue}: ${message}`);
        }
        return { kind: "failed", issue, error: message };
      }
      loggedFailure.delete(issue);
      tracker.markSpoken(issue, deps.now());
      log(`[stall] ${issue} wake comment posted (agent:stalled applied, continuously observed for ${elapsedMinutes}m)`);
      return { kind: "acted", issue };
    } catch (err) {
      const message = (err as Error)?.message ?? String(err);
      log(`WARNING: [stall] detector error for ${issue}: ${message}`);
      return { kind: "failed", issue, error: message };
    }
  }
  // Serialize overlapping observations for the same ticket, including recovery.
  function check(issue: string, labelApplied: boolean, stalledPollResult: boolean | null, realElapsedMinutes?: number | null, workers?: readonly WorkerLink[], activityAt?: number | null): Promise<StallOutcome> {
    const previous = pending.get(issue) ?? Promise.resolve();
    const task = previous.then(() => evaluate(issue, labelApplied, stalledPollResult, realElapsedMinutes, workers, activityAt));
    pending.set(issue, task);
    void task.finally(() => { if (pending.get(issue) === task) pending.delete(issue); });
    return task;
  }
  return { check, forget: issue => tracker.forget(issue) };
}
