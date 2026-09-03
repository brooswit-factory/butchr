import type { JiraIssue, IssueLink } from "../atlassian/types.js";
import { findMarked, RateCap, HOUR_MS, type CommentRow } from "./escalation-helper.js";

/**
 * BUTCHR-200 — the abandoned-worker detector. A boss (an epic or a story)
 * can tell a worker "merge it, then I'll close you out", have the worker
 * merge, and then reach Done itself without ever discharging that worker —
 * this already happened in production (BUTCHR-127 → BUTCHR-159, repaired by
 * hand, 2h15m later, only because a person happened to remember). The link
 * is intact, so `adopt_worker`'s orphan machinery correctly refuses to touch
 * it (it still has a boss); the boss will never call `finish_worker` on it,
 * never answer it, never `start_worker` it again. Nothing else in this
 * system notices. This module detects that ABANDONED state and escalates
 * it, in three stages, all the way up to a human-owned ticket if nobody
 * acts.
 *
 * THIS EXISTS BECAUSE THE GUARD THAT PREVENTS THE STATE IS BYPASSABLE:
 * `jira_transition` (src/tools/defs.ts) is a live, unguarded verb — a bare
 * passthrough to `ops.transition(key, status)` with no ownership check, no
 * status check, no downward check (its "deprecated" status is a string in
 * its own description, not an enforced refusal). Any agent can move a boss
 * to Done over an open worker without going near the guarded relationship
 * verbs; a human editing status by hand in the Jira UI bypasses them
 * identically. A sibling ticket (BUTCHR-193) is adding refusals to the three
 * closing verbs, but those refusals bind only from the moment they deploy
 * and do nothing about `jira_transition` itself (out of scope here — see
 * this module's own PR).
 *
 * WHY THIS IS A DIFFERENT SHAPE FROM `parked.ts`: that detector's boss is
 * live *by definition* (it requires `status === "In Progress"`), so it can
 * resolve the boss's status out of the daemon's own already-fetched active
 * `issues` set at zero extra cost, and it escalates by posting on the LIVE
 * boss's own ticket — the boss has a running agent, so that is the cheapest
 * channel likely to be read. Here the boss is Done *by definition* — never
 * in the active `issues` set (`ISSUE_JQL`: `status IN ("In Progress", "In
 * Review")`), and `related` (src/jira-watch/routes.ts's `watchedKeys`, an
 * Implements-outward walk off the active set) holds workers, never bosses.
 * Both of `parked.ts`'s cheap tricks are closed here — see `IssueLink`'s own
 * doc comment (src/atlassian/types.ts) for how this module still gets the
 * boss's status at zero extra Jira calls anyway (BUTCHR-200 stopped
 * `parseIssueLinks` from discarding it).
 *
 * THE ESCALATION TARGET IS THEREFORE FLIPPED FROM `parked.ts`'s: the WORKER
 * here is the live party (it is, by construction, one of `issues` — In
 * Progress or In Review, staffed by this daemon's own credential), while
 * its boss is dead. Posting stage 1/2 on the dead boss's ticket would post
 * into the void — nobody is running there to read it. So stage 1/2 post on
 * the WORKER's own ticket instead (the live reader), and only stage 3 walks
 * up the Implements chain to a party that is NOT the worker — the boss's
 * own boss (a "grandboss"), or, when there is none, back on the boss itself
 * (which — having no inward Implements link of its own — is by construction
 * an Epic, a human's own ticket, exactly `parked.ts`'s own terminal-case
 * reasoning).
 */

/** Marker every escalation comment this module writes starts with. Distinct from `[butchr:parked]` on purpose — see the module-level note on markers in this ticket's PR body: a shared marker would make a future "show me every X" grep silently wrong (the same reasoning `ORPHAN_LABEL`'s doc comment, src/tools/relationship.ts, already gives for keeping that label distinct from `EXEMPT_LABEL`). Named for the STATE ("this worker has been abandoned"), not the detector, so it reads correctly to someone who has never heard of this module. */
export const MARKER = "[butchr:abandoned]";

/**
 * `butchr:shelved` (`EXEMPT_LABEL` in `parked.ts`) is DELIBERATELY NOT
 * CHECKED HERE — the opposite of `parked.ts`'s decision, which exempts it.
 *
 * `parked.ts` exempts it because a boss can legitimately decide "not yet"
 * about a To Do child it still owns — the label is reversible, and only its
 * own (live) boss can reverse it. Here, the boss is Done. A shelved worker
 * can only be reactivated by its own boss calling `start_worker`
 * (src/tools/relationship.ts's `assertOwnWorker`, which refuses any caller
 * that is not the worker's own Implements-linked boss — verified in this
 * tree) — so a worker left shelved under a Done boss can NEVER be
 * reactivated, by anyone. It is not less abandoned than an unshelved one; it
 * is MORE so, because it carries a label asserting a decision is in force
 * that nothing can ever reverse again. Exempting it would silence this
 * detector on precisely its worst case.
 *
 * This is NOT in tension with the sibling guard (BUTCHR-193/BUTCHR-191),
 * which deliberately lets a boss `shelve_worker` an open worker and then
 * close over it — rejecting the alternative (refusing to close over a
 * shelved worker too) because that reproduces the BUTCHR-92 circle: a boss
 * with a worker it can neither finish (the work isn't done) nor shelve (now
 * refused) has no exit at all. The design both tickets converge on: PERMIT
 * it at the door (the guard), MAKE THE CONSEQUENCE AUDIBLE AFTERWARDS (this
 * module) — enforce where there is an exit, make audible where there is
 * not. This module is the audible half.
 *
 * In practice this rarely bites on the label itself: `IssueLink`'s hydrated
 * field set (`issuetype, priority, status, summary` — MEASURED, BUTCHR-192)
 * never includes `labels`, so this predicate could not see `butchr:shelved`
 * on the boss even if it wanted to. It reads the WORKER's own labels (which
 * `issues` already carries in full), not the boss's — but a shelved worker
 * is, by `shelve_worker`'s own contract, moved to To Do, which is outside
 * `ISSUE_JQL` and therefore outside this detector's candidate set entirely
 * (see the `KNOWN LIMITATION` on `abandonedCandidates` below). The no-
 * exemption decision is recorded and tested here anyway, deliberately,
 * for the anomalous case a worker reaches this detector's candidate set
 * (In Progress/In Review) while still carrying a stale `butchr:shelved`
 * label — e.g. a labelling bug, or a hand-added label that was never
 * withdrawn — so a future reader does not have to re-derive the decision
 * from first principles, and so a future change to `shelve_worker`'s own
 * status contract does not silently resurrect the exemption question.
 */

export interface AbandonedCandidate {
  worker: JiraIssue;
  /** The Done boss's key, read off the worker's own inward `Implements` stub. */
  boss: string;
}

/**
 * The ABANDONED predicate, pure and total over one poll's already-fetched
 * `issues` snapshot — costs ZERO extra Jira calls. Unlike `parked.ts`'s
 * `parkedCandidates`, this needs no `related` walk at all: every candidate
 * IS one of `issues` (a worker already staffed by this daemon), and its
 * boss's status arrives pre-hydrated on the worker's own `issuelinks` (see
 * `IssueLink`'s doc comment, src/atlassian/types.ts, and BUTCHR-192's
 * measurement cited in this ticket's PR body).
 *
 * FAIL CLOSED: a worker whose inward `Implements` stub carries no `status`
 * at all (`undefined`) is UNKNOWN, never treated as Done and never treated
 * as not-Done — this predicate stays silent on it. Never conflate "the boss
 * key is absent from the active set" with "the boss is Done" — this
 * predicate never even looks at the active set; it reads the boss's status
 * directly off the stub, which is the whole point of BUTCHR-200's change.
 *
 * A worker can in principle carry more than one inward `Implements` stub
 * (`jira_link_issues` adds a link rather than moving one — the same
 * reachable double-link scenario `parked.ts`'s own `pairKey` doc comment
 * names) — each (worker, boss) pair is evaluated, and therefore reported,
 * independently: a worker with one Done boss-link and one live boss-link
 * IS a candidate for the Done one, regardless of the live one.
 *
 * FORMER KNOWN LIMITATION, closed by BUTCHR-240 at the INPUT layer, not
 * here: `ISSUE_JQL` (`status IN ("In Progress", "In Review")`, `assignee =
 * currentUser()`) means a To Do worker under a Done boss is invisible to
 * `issues` alone — it is in neither `issues` nor (since `related` is not
 * even consulted) anywhere else this predicate looks. `parked.ts` cannot see
 * it either (it requires the boss to be In Progress), and the orphan
 * machinery cannot see it (the link is intact). "Inert" — nothing burning,
 * nothing complaining — is why this was WORSE than the covered (In
 * Progress/In Review) population, not better: a live worker at least has a
 * running agent and a pane a person can notice; a To Do one is silent
 * forever. BUTCHR-13 exists because BUTCHR-1 closed leaving four stories
 * stranded exactly this way.
 *
 * This predicate itself needed NO widening to close the gap — it was already
 * total over "any To Do worker with a Done inward Implements stub", proven
 * by the tests below carrying a `"To Do"` worker status. The blindness was
 * entirely that a To Do worker never reached this function's `issues`
 * argument in the first place (`ISSUE_JQL` never returns one, and widening
 * `ISSUE_JQL` itself is deliberately out of scope — it is the fleet's ACTIVE
 * SET, read by spawning/stall detection/labels/reconcile, not just this
 * detector). `createAbandonedDetector`'s optional `todoWorkers` dep (below)
 * is what actually closes it: a second, narrower JQL search
 * (`TODO_WORKER_JQL`, src/resources/issue.ts), concatenated with `issues`
 * BEFORE this pure predicate ever runs — so the predicate stays exactly as
 * total and I/O-free as it always was, and the network call lives entirely
 * outside it.
 *
 * SECOND KNOWN LIMITATION, same class as `parked.ts`'s own: a worker
 * staffed by a DIFFERENT credential (a different daemon/machine) never
 * appears in THIS daemon's own `issues` (`assignee = currentUser()`), so an
 * abandoned worker under a different credential is invisible to this daemon
 * too. Each daemon polices only its own workers — acceptable, but worth
 * knowing, exactly as `parked.ts` already documents for its own candidates.
 */
export function abandonedCandidates(issues: readonly JiraIssue[]): AbandonedCandidate[] {
  const out: AbandonedCandidate[] = [];
  for (const worker of issues) {
    // Defensive, not load-bearing under the real ISSUE_JQL (which never
    // returns a Done issue) — kept explicit, matching parkedCandidates's own
    // style, because this function is pure and total over ANY `issues` array
    // a caller hands it, not only the one the real poll happens to produce;
    // exercised directly by the "Done worker under a Done boss" test.
    if (worker.status === "Done") continue;
    for (const link of worker.issuelinks ?? []) {
      if (link.type !== "Implements" || link.otherEnd !== "inward") continue;
      // FAIL CLOSED, one condition: only a CONFIRMED "Done" status is
      // abandoned. `undefined` (unknown — no status on the stub) and any
      // other known status (a live boss) both fall through identically —
      // deliberately one branch, not two: `undefined !== "Done"` is already
      // `true`, so a separate `=== undefined` check ahead of this one would
      // be unreachable-in-effect (same output either way) and untestable as
      // its own branch. "Unknown-status fails closed" is this condition
      // itself, not a second one — see the test of that name.
      if (link.status !== "Done") continue;
      out.push({ worker, boss: link.key });
    }
  }
  return out;
}

interface Entry {
  boss: string;
  /**
   * Daemon's first observation of this (worker, boss) pair in the
   * abandoned-eligible state — a conservative floor that can only ever
   * DELAY the signal (e.g. across a daemon restart, which starts a fresh
   * floor), never fabricate one. Never persisted to disk. Same reasoning as
   * `parked.ts`'s `ParkedTracker` / `StalledTracker`, copied verbatim.
   */
  firstObservedAt: number;
  stage1At?: number;
  stage2At?: number;
  stage3At?: number;
}

/**
 * Tracking key for one (worker, boss) PAIR, not the worker alone — same
 * reasoning as `parked.ts`'s `pairKey`: a worker with two inward Implements
 * stubs (one stale, one current — reachable via `jira_link_issues` adding
 * rather than moving a link) must not have `observe(worker, bossA)`
 * immediately overwritten by `observe(worker, bossB)` on the very next poll
 * and back again, which would mean the floor never matures and NOTHING is
 * ever posted for either pair.
 */
const pairKey = (workerKey: string, boss: string): string => `${workerKey}|${boss}`;

/** Per-(worker, boss)-pair in-memory floor + stage bookkeeping. See `parked.ts`'s `ParkedTracker` for the full reasoning; this is the same shape. */
export class AbandonedTracker {
  private readonly entries = new Map<string, Entry>();
  constructor(private readonly now: () => number) {}

  /** Drop tracking for every (worker, boss) pair-key not in `stillCandidates` this poll. */
  forgetMissing(stillCandidates: ReadonlySet<string>): void {
    for (const key of [...this.entries.keys()]) if (!stillCandidates.has(key)) this.entries.delete(key);
  }

  /** This poll's observation for a currently-ABANDONED `workerKey` under `boss`. */
  observe(workerKey: string, boss: string): Entry {
    const key = pairKey(workerKey, boss);
    const existing = this.entries.get(key);
    if (existing) return existing;
    const fresh: Entry = { boss, firstObservedAt: this.now() };
    this.entries.set(key, fresh);
    return fresh;
  }
}

/**
 * OBSERVATIONAL, not accusatory — same discipline as `parked.ts`: the
 * daemon can see state (linked, Done, for how long) but not intent, and a
 * boss that closed moments before discharging its last worker is
 * byte-identical in Jira to one that broke a promise. Report what was
 * MEASURED — including the actual elapsed time — and let the reader draw
 * the conclusion. Every stage says "observed Done", never "reached Done":
 * `elapsedMinutes` is the age of THIS DAEMON'S OWN first observation of the
 * pair (`firstObservedAt`), not of the real Jira transition — those
 * coincide only when the daemon happened to be watching at the moment the
 * boss closed, and `firstObservedAt` can start arbitrarily later (a daemon
 * restart, or the worker only just entering In Progress/In Review). Every
 * action named is a HUMAN or BOSS action (§2: this module signals, it
 * never repairs) — never something this daemon will do itself.
 *
 * Every stage body also carries an explicit `boss: ${boss}` line, in
 * addition to `fingerprint: ${worker}` — REQUIRED, not decorative: a worker
 * can carry two Done inward Implements stubs (see `abandonedCandidates`'s
 * own doc comment on the reachable double-link case), producing two
 * DISTINCT (worker, boss) pairs that would otherwise share the exact same
 * `postStage` dedupe identity (`fingerprint: ${worker}`, `stage: N`) and
 * the SAME target at stages 1/2 (the worker's own ticket) — and can share
 * the same target at stage 3 too, if both bosses resolve to the same
 * grandboss. Without `boss` in the identity, the second pair's escalation
 * silently `findMarked`s the first pair's comment and "adopts" it instead
 * of posting its own — the second abandonment is detected, tracked, and
 * never spoken, which is exactly this module's own worst failure mode
 * (§2). `boss` in `need` (see `postStage` below) closes this.
 */

function stage1Comment(worker: string, boss: string, elapsedMinutes: number): string {
  return [
    `${MARKER} this ticket's Implements boss, ${boss}, was observed Done ${elapsedMinutes} minutes ago while ${worker} is still open. ${boss} will never call finish_worker on ${worker}, answer it, or start it again.`,
    "",
    `If the work here is actually finished, ask a human or ${boss}'s own boss to review and close ${worker} — a worker cannot close itself (finish_worker is not ${worker}'s to call on itself). If it is not finished, this may be a broken promise: surface it to a human rather than waiting further.`,
    "",
    `fingerprint: ${worker}`,
    `boss: ${boss}`,
    "stage: 1",
  ].join("\n");
}

function stage2Comment(worker: string, boss: string, elapsedMinutes: number): string {
  return [
    `${MARKER} ${worker} is still open, ${elapsedMinutes} minutes after its boss ${boss} was observed Done. This is a follow-up.`,
    "",
    `If the work here is actually finished, ask a human or ${boss}'s own boss to review and close ${worker}. If it is not finished, surface it to a human.`,
    "",
    `fingerprint: ${worker}`,
    `boss: ${boss}`,
    "stage: 2",
  ].join("\n");
}

function stage3EscalatedComment(worker: string, boss: string, grandBoss: string, elapsedMinutes: number): string {
  return [
    `${MARKER} ${worker} is still open, ${elapsedMinutes} minutes after its boss ${boss} was observed Done, under ${grandBoss} — which has not acted on two prior notices on ${worker}.`,
    "",
    `Prompt ${grandBoss} to review ${worker} and either have it closed (if the work is finished) or given a new boss.`,
    "",
    `fingerprint: ${worker}`,
    `boss: ${boss}`,
    "stage: 3",
  ].join("\n");
}

function stage3TerminalComment(worker: string, boss: string, elapsedMinutes: number): string {
  return [
    `${MARKER} ${worker} is still open, ${elapsedMinutes} minutes after its boss ${boss} was observed Done, and ${boss} has no boss of its own to escalate to further.`,
    "",
    `${boss} is a human-owned ticket (it has no Implements boss of its own) — a human should review ${worker} directly and either close it (if the work is finished) or give it a new boss.`,
    "",
    `fingerprint: ${worker}`,
    `boss: ${boss}`,
    "stage: 3",
  ].join("\n");
}

export interface AbandonedDetectorDeps {
  now: () => number;
  /** BUTCHR_ABANDONED_MINUTES — minutes a worker must sit continuously abandoned (its boss observed Done) before stage 1 fires; also the interval between each subsequent stage. */
  minutes: number;
  /** Post through the daemon's single existing comment-writing seam — never a second Atlassian writer. */
  addComment: (issue: string, text: string) => Promise<void>;
  /**
   * Recent comments on a ticket, for the dedupe/adoption check. MUST be the
   * tier-aware reader (`createOwnChannelComments`, src/tools/speak.ts), NOT
   * a raw `atlassian.comments` call — unlike `parked.ts`, which still uses
   * the raw call because it predates the fix this ticket deliberately does
   * NOT copy. Every target this module posts to (a worker, a boss, a
   * grandboss) is always ISSUE-keyed — the Implements chain in this fleet is
   * task -> story -> epic, never a PROJECT — so `createOwnChannelComments`'s
   * project-routing branch is simply never taken here, but using it anyway
   * keeps this module correct if that ever changes and matches house
   * convention for every comment read in the daemon wiring.
   */
  comments: (issue: string) => Promise<readonly CommentRow[]>;
  /** A ticket's issue links — called ONLY at stage 3, to resolve the boss's own boss (inward Implements). The one extra Jira call in this whole feature, same as `parked.ts`. */
  links: (issue: string) => Promise<readonly IssueLink[]>;
  /**
   * BUTCHR-240: an extra fetch for To Do workers this daemon's credential
   * owns — see `abandonedCandidates`'s "FORMER KNOWN LIMITATION" doc comment
   * above for the gap this closes. Optional and OFF by default (omitted,
   * `check` runs exactly as it always did, over `issues` alone) so the
   * detector stays unit-testable without a live Jira and every existing
   * caller/test is unaffected. Wired in production from
   * `createTodoWorkersFetch` (src/resources/issue.ts), a single
   * `deps.search(TODO_WORKER_JQL)` call — the house pattern `createRelated`
   * (same file) already uses for a batched extra query.
   *
   * Deliberately a fetch SEAM, not a widening of `abandonedCandidates`
   * itself: the pure predicate must never gain a network call, so this
   * result is concatenated with `issues` here, in `check`, before the
   * predicate ever runs. Called once per poll, unconditionally when wired
   * (not merely once stage 1 is already reached) — the whole point is
   * making a to-do worker's abandonment observable from `firstObservedAt`
   * onward, the same as an In Progress/In Review one already is.
   *
   * FAIL OPEN: a rejection here must never take down the rest of this poll's
   * detection — `check` catches it itself (not this module's OUTER
   * try/catch, which would otherwise also skip the already-working In
   * Progress/In Review coverage over `issues`) and proceeds with `issues`
   * alone, logging a WARNING.
   */
  todoWorkers?: () => Promise<readonly JiraIssue[]>;
  log?: (line: string) => void;
}

export interface AbandonedDetector {
  /** Run one poll's worth of detection over this poll's `issues` snapshot. Never throws — every failure is caught and logged, so a Jira hiccup here can never take the poll loop down. */
  check: (issues: readonly JiraIssue[]) => Promise<void>;
}

/**
 * Builds the abandoned-worker detector wired into src/daemon/loop.ts (via
 * src/daemon/index.ts) alongside (never instead of) `parked.ts`'s. See
 * `LoopDeps.checkAbandoned`'s doc comment (src/daemon/loop.ts) for WHY this
 * must be called from the poll's observe function and never from
 * `watch()`'s onChange callback — the same reasoning `checkParked` already
 * documents there.
 *
 * §3g (this ticket): DO NOT size this module's rate cap for the day-one
 * zero. `MAX_PER_HOUR` matches `parked.ts`'s own cap (3/hour) — not because
 * this module's steady-state volume is expected to match `parked.ts`'s, but
 * because no measurement available today predicts what it actually will be
 * (the sibling guard, BUTCHR-193/BUTCHR-191, recommends `shelve_worker` as
 * its own discharge path, and every agent that follows that advice and then
 * closes is a candidate inflow this module did not create and cannot
 * control), and inventing a different number without evidence would be
 * exactly the "tuning for the zero" this ticket warns against. Revisit once
 * real volume is observed.
 */
export function createAbandonedDetector(deps: AbandonedDetectorDeps): AbandonedDetector {
  const tracker = new AbandonedTracker(deps.now);
  const MAX_PER_HOUR = 3;
  // Keyed by the actual comment TARGET (never the worker unconditionally) —
  // same reasoning as parked.ts's rateCap: stage 1/2 target the worker, so
  // the cap is per-worker there; stage 3 targets the grandboss (or the boss
  // itself, terminal case), so a post that lands there is counted against
  // ITS budget, not silently exempted — otherwise several workers abandoned
  // under siblings of one grandboss could exceed 3/hour on the grandboss
  // without any single worker's own cap ever appearing to.
  const rateCap = new RateCap(MAX_PER_HOUR, HOUR_MS);
  const cappedLogged = new Set<string>();
  const minutesMs = deps.minutes * 60_000;
  const log = (line: string) => deps.log?.(line);

  /**
   * Post (or adopt an already-posted) comment for one stage. Same dedupe/
   * adoption + fail-closed discipline as `parked.ts`'s `postStage` — see
   * that function's doc comment for the full reasoning; not repeated here.
   *
   * `need` includes `boss`, not just `fingerprint`/`stage` — REQUIRED (see
   * the doc comment above the stage-comment builders): a worker can carry
   * two Done inward Implements stubs, and without `boss` in the identity
   * the second pair's escalation would `findMarked` the first pair's
   * comment (same worker, same stage, same or overlapping target) and
   * silently adopt it instead of posting its own.
   */
  async function postStage(target: string, stageTag: "1" | "2" | "3", worker: string, boss: string, body: string): Promise<number | null> {
    const rows = await deps.comments(target).catch((e) => {
      log(`WARNING: [abandoned] comments fetch failed for ${target}: ${(e as Error)?.message ?? e}`);
      return null;
    });
    if (rows === null) return null;
    // Trailing "\n" on the two variable-bearing entries: findMarked matches
    // by bare substring (body.includes(...)), and this project's own key
    // shape makes prefix collisions the NORM, not an exotic case
    // (BUTCHR-1/BUTCHR-19/BUTCHR-192/BUTCHR-200) — "boss: BOSS-19".includes
    // ("boss: BOSS-1") is true, so without a delimiter a boss/worker key
    // that is a strict prefix of another silently collapses two distinct
    // (worker, boss) pairs' dedupe identities back into one, reproducing
    // exactly the finding the `boss:` line was added to fix. Every stage
    // body joins with "\n" and both lines are followed by one, so this is
    // sufficient. `stage:` needs no delimiter — its values ("1"/"2"/"3")
    // have no prefix relation to each other.
    const need = [`fingerprint: ${worker}\n`, `boss: ${boss}\n`, `stage: ${stageTag}`];
    const existing = findMarked(rows, MARKER, need);
    if (existing) {
      const adoptedAt = Date.parse(existing.created) || deps.now();
      log(`[abandoned] adopted existing stage ${stageTag} escalation for ${worker} on ${target} from comment ${existing.id} (daemon restart)`);
      return adoptedAt;
    }
    if (!rateCap.allow(target, deps.now())) {
      if (!cappedLogged.has(target)) {
        cappedLogged.add(target);
        log(`WARNING: [abandoned] rate cap reached (${MAX_PER_HOUR}/hour) for ${target} — ${worker} stage ${stageTag} logged only, not posted (further cap hits for ${target} are logged only once until it frees up)`);
      }
      return null;
    }
    await deps.addComment(target, body);
    rateCap.record(target, deps.now());
    cappedLogged.delete(target);
    const postedAt = deps.now();
    log(`[abandoned] ${worker} stage ${stageTag} posted on ${target}`);
    return postedAt;
  }

  async function check(issues: readonly JiraIssue[]): Promise<void> {
    try {
      // BUTCHR-240: fetch-stage failure handled HERE, deliberately not left
      // to the outer try/catch below — a rejection reaching that catch would
      // skip candidate detection over `issues` too, silently taking down the
      // In Progress/In Review coverage that already works over a mere
      // hiccup in this brand-new query. Fail OPEN on the query itself
      // (proceed with `issues` alone) — the opposite direction from, and not
      // in tension with, the detector's existing fail-CLOSED rule for an
      // unknown status on a link stub (see `abandonedCandidates`'s own doc
      // comment): one is "can't reach the query, so don't lose what already
      // works"; the other is "can't confirm Done, so don't claim it".
      let allIssues = issues;
      if (deps.todoWorkers) {
        const todo = await deps.todoWorkers().catch((e) => {
          log(`WARNING: [abandoned] todoWorkers fetch failed: ${(e as Error)?.message ?? e}`);
          return null;
        });
        if (todo !== null) allIssues = [...issues, ...todo];
      }
      const candidates = abandonedCandidates(allIssues);
      tracker.forgetMissing(new Set(candidates.map((c) => pairKey(c.worker.key, c.boss))));

      for (const { worker, boss } of candidates) {
        const e = tracker.observe(worker.key, boss);
        const now = deps.now();
        const elapsedMinutes = Math.round((now - e.firstObservedAt) / 60_000);

        if (e.stage1At === undefined) {
          if (now - e.firstObservedAt < minutesMs) continue;
          const at = await postStage(worker.key, "1", worker.key, boss, stage1Comment(worker.key, boss, elapsedMinutes));
          if (at !== null) e.stage1At = at;
          continue;
        }

        if (e.stage2At === undefined) {
          if (now - e.stage1At < minutesMs) continue;
          const at = await postStage(worker.key, "2", worker.key, boss, stage2Comment(worker.key, boss, elapsedMinutes));
          if (at !== null) e.stage2At = at;
          continue;
        }

        if (e.stage3At === undefined) {
          if (now - e.stage2At < minutesMs) continue;
          // The one extra Jira call in this whole feature: only reached once
          // a worker has already gone unaddressed through two prior stages.
          // A failed fetch fails CLOSED (posts nothing this poll, retried
          // next time) rather than falling through to the terminal case —
          // same reasoning as parked.ts: treating "couldn't look" as
          // "genuinely no grandboss" would, on a real grandboss, permanently
          // misroute stage 3 onto the boss itself the moment stage3At got
          // set from that fallback post.
          const links = await deps.links(boss).catch((err) => {
            log(`WARNING: [abandoned] links fetch failed for ${boss}: ${(err as Error)?.message ?? err}`);
            return null;
          });
          if (links === null) continue;
          const grandBoss = links.find((l) => l.type === "Implements" && l.otherEnd === "inward")?.key ?? null;
          if (grandBoss) {
            const at = await postStage(grandBoss, "3", worker.key, boss, stage3EscalatedComment(worker.key, boss, grandBoss, elapsedMinutes));
            if (at !== null) e.stage3At = at;
          } else {
            // Terminal case: a boss with no inward Implements link of its
            // own is, by construction, an Epic — a human's own ticket
            // (docs/agent-model.md) — even though it is Done. There is no
            // separate human channel and none is needed: post back on the
            // boss's own (Done) ticket and log a WARNING an operator's
            // `journalctl | grep WARNING` will actually surface.
            log(`WARNING: [abandoned] ${worker.key} abandoned under ${boss}, which has no boss of its own to escalate to — re-posting on ${boss}`);
            const at = await postStage(boss, "3", worker.key, boss, stage3TerminalComment(worker.key, boss, elapsedMinutes));
            if (at !== null) e.stage3At = at;
          }
        }
        // stage3At already set: three stages is the whole escalation — nothing further to do.
      }
    } catch (e) {
      log(`WARNING: [abandoned] detector error: ${(e as Error)?.message ?? e}`);
    }
  }

  return { check };
}
