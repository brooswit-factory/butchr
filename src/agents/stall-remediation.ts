import { findMarked, RateCap, HOUR_MS, type CommentRow } from "./escalation-helper.js";
import { staffingFromWorkerLabels, ASK_MARKER } from "../tools/relationship.js";

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
 *
 * BUTCHR-353 — THE WAKE PROSE GETS A THIRD BRANCH: the two paragraphs above
 * are about WHEN this module speaks; this addendum is about WHAT it says.
 * Until this ticket, `wakeComment` below modelled only *done* and *stuck*,
 * and offered exactly two pieces of advice (close/transition the ticket, or
 * act on it now) — both actively harmful to a THIRD state this module had no
 * vocabulary for: a boss correctly waiting on one of its own workers (a
 * worker withheld at the fleet-wide admission cap, one sitting In Review
 * awaiting this ticket's own review, or one that asked this ticket a
 * question with no reply yet). `gatherWorkerSignals` below reads the stalled
 * ticket's own non-Done workers (free — `WorkerLink`, from data
 * src/labels/sync.ts already fetched this poll — plus, ONLY on the one poll
 * that is actually about to post, one label read and one comment read per
 * non-Done worker) and reuses BUTCHR-352's own label-path rule
 * (`staffingFromWorkerLabels`, src/tools/relationship.ts) rather than
 * inventing a second "marker means waiting" test — see that function's own
 * doc comment for why a probe was deliberately NOT added here instead.
 */

export const MARKER = "[butchr:stall]";

/** Mirrors parked.ts/frozen-asleep.ts's per-target escalation budget — a backstop here, since the spokenAt latch below is the primary (and normally sole) debounce. */
const MAX_PER_HOUR = 3;

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
function correctlyWaitingTail(callerKey: string, s: WorkerSignals): string {
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
    "Saying what you are waiting on (this comment counts) is what actually clears agent:stalled; if none of the above is what you are ACTUALLY waiting on, say so and act."
  );
}

function wakeComment(issue: string, elapsedMinutes: number, signals: WorkerSignals = NO_SIGNALS): string {
  return [
    `${MARKER} ${issue} has read agent:stalled, continuously, for ${elapsedMinutes} minute(s): idle or done since it last stopped working, with no non-daemon-chatter comment landing during that streak.`,
    "",
    `fingerprint: ${issue}`,
    "",
    hasAnySignal(signals) ? correctlyWaitingTail(issue, signals) : DEFAULT_TAIL,
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
 * THE PRECISE, CORRECTED CLAIM ABOUT `null` (a prior version of this comment
 * overstated it, caught in review): a `null` poll (`stalled.check()` could
 * not verify) never GATES the act/suppress decision, is never collapsed
 * into "not stalled" or "confirmed stalled", and never causes a post ON ITS
 * OWN — the APPLIED label does. That is narrower than "a null poll never
 * posts". When `labelApplied` is false, a `null` `stalledPollResult` is its
 * own distinct SUPPRESSED reason (see `check`'s own doc comment) — it is
 * never folded into "not-a-candidate" (confirmed not stalled) or treated as
 * if it were `true`. But when `labelApplied` is ALREADY true, this module
 * proceeds to adopt/rate-cap/post EXACTLY as it would for a `true` or even
 * an omitted `stalledPollResult` — `stalledPollResult` is not consulted at
 * all on that path. THIS IS DELIBERATE, not an oversight: once the label
 * is durably applied (read back from Jira, not merely this poll's own
 * candidate), gating the wake on ALSO getting a fresh non-null verification
 * THIS poll would mean a persistently failing comments() endpoint silently
 * disables the deadlock-breaker during exactly the degraded conditions
 * where a becalming is most likely — fail-into-silence, this story's own
 * failure mode, traded for a different failure mode than the one AC6 names.
 * Pinned by test/unit/stall-remediation.test.ts's
 * "labelApplied=true with a null stalledPollResult still acts" test.
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
   * "could not verify" outcome), threaded through UNCOLLAPSED and used only
   * to distinguish, for logging, "genuinely nothing going on" from
   * "something's brewing but the label isn't applied yet" from "could not
   * verify this poll" — it never gates whether this module acts (that is
   * `labelApplied` alone). `realElapsedMinutes`, when supplied (src/labels/
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
  check: (issue: string, labelApplied: boolean, stalledPollResult: boolean | null, realElapsedMinutes?: number | null, workers?: readonly WorkerLink[]) => Promise<StallOutcome>;
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
 * requirement): a `deps.labels`/`deps.comments` rejection for a given
 * worker is caught, logged, and that worker is simply DROPPED from every
 * signal for this poll — never defaulted into "withheld" or "unanswered".
 * The worst case is under-reporting (falls through toward `NO_SIGNALS`,
 * i.e. today's existing wake text) rather than a false "you are correctly
 * waiting" — the asymmetry this whole ticket exists to enforce.
 *
 * THE ASK RULE, STATED: the newest comment on a worker's own ticket that
 * starts with `[<workerKey>] [ask]` (askBoss's own identity-tag + ASK_MARKER
 * shape, relationship.ts) is "answered" if any comment ABOVE it (more
 * recent, since `comments` is newest-first) starts with `[<stalledKey>] `
 * (tellWorker's own identity-tag shape) — a reply from THIS boss,
 * specifically. FAILURE MODE, STATED (per this ticket's own requirement): a
 * worker that itself moves past its own question without this boss ever
 * replying (e.g. it found another way forward) still reads as "unanswered"
 * here — a false positive. Accepted deliberately: naming a stale question is
 * redundant at worst, never the harmful direction (a false "you are done or
 * stuck" or a false "you are correctly waiting") this ticket exists to stop.
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
  // Issues currently believed quota-blocked, per the LAST poll this module
  // logged the transition for — same log-flood discipline as
  // `cappedLogged`/`loggedFailure` above: a quota-blocked ticket re-enters
  // this branch every ~15s for hours (this module's own steady-state flood
  // guard applies here too), so log entering AND leaving the state exactly
  // once each, never every poll in between.
  const quotaLogged = new Set<string>();
  const log = (line: string) => deps.log?.(line);

  async function check(issue: string, labelApplied: boolean, stalledPollResult: boolean | null, realElapsedMinutes?: number | null, workers?: readonly WorkerLink[]): Promise<StallOutcome> {
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
      // CRITERION 10 — checked before touching Jira at all, and before the
      // rate cap / adoption bookkeeping below: a quota-blocked target cannot
      // read a wake comment, and posting into it burns the very quota whose
      // return ends the outage, so this is cheaper AND safer to check first,
      // not merely first for cost's sake. Deliberately does NOT call
      // tracker.markSpoken — a quota-blocked poll is not remediated, so a
      // later poll (quota recovered, still stalled) must still be free to
      // act, not find itself already latched as spoken-for.
      if (deps.quotaBlocked?.(issue)) {
        if (!quotaLogged.has(issue)) {
          quotaLogged.add(issue);
          log(`[stall] ${issue} quota-blocked — suppressing wake comment (target cannot read it while blocked, and posting would burn the quota whose return ends the outage)`);
        }
        return { kind: "suppressed", issue, reason: "quota-blocked" };
      }
      if (quotaLogged.delete(issue)) {
        log(`[stall] ${issue} no longer quota-blocked — wake comment eligible again`);
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

      // BUTCHR-353: paid ONLY here — past every earlier short-circuit
      // (already-remediated, quota-blocked, adopted-existing, rate-capped)
      // — so worker reads happen at most ONCE per stalled episode, on
      // exactly the poll that is about to actually post, never on every
      // poll of a becalming (see gatherWorkerSignals's own doc comment for
      // the per-call bound).
      const signals = await gatherWorkerSignals(deps, issue, workers, log);

      try {
        await deps.addComment(issue, wakeComment(issue, elapsedMinutes, signals));
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
