import type { JiraIssue, IssueLink } from "../atlassian/types.js";
import type { RelatedIssue } from "../daemon/loop.js";
import { findMarked, RateCap, HOUR_MS, type CommentRow } from "./escalation-helper.js";

/**
 * BUTCHR-24 — the parked-ticket detector. A boss agent (an epic or a story)
 * can file a child, assign it, and never move it out of To Do; an
 * unassigned/To Do ticket is never staffed, so the boss waits forever on
 * events from an agent that does not exist, and nothing notices (this
 * already happened in production — BUTCHR-13). This module detects that
 * PARKED state and escalates it, in three stages, all the way up to a
 * human-owned ticket if the boss never acts.
 *
 * SCOPE, DELIBERATELY NARROW: this rule covers ONLY a child stuck in To Do
 * under a live (In Progress) boss. To Do under a live boss is *never*
 * legitimate — that's what makes a short threshold safe. A different stale
 * state (e.g. a task left In Review after its story approved and merged its
 * PR, per BUTCHR-18) is a LEGITIMATELY long-lived state in general (a
 * reviewer may be mid-task or asleep) and needs a different signal (PR state
 * from PrTracker, src/labels/pr.ts) and its own threshold — out of scope
 * here, and deliberately not stubbed out as dead configuration.
 */

/** Marker every escalation comment this module writes starts with. */
export const MARKER = "[butchr:parked]";

/**
 * A ticket carrying this label is never reported parked, at any stage — the
 * exemption for a deliberately-parked backlog item under a live boss (the
 * one real false positive; KAN-839 is the live example). Read-only for the
 * daemon: see the guarding comment next to `isDaemonLabel` in
 * src/labels/plan.ts, and the pinned test in test/unit/labels-plan.test.ts.
 */
export const EXEMPT_LABEL = "butchr:parked-ok";

/** Mirrors escalation-loop.ts's per-pane budget: at most this many escalation comments per boss ticket per hour. */
const MAX_PER_HOUR = 3;

export interface ParkedCandidate {
  child: JiraIssue;
  /** The active issue key watching `child` via the Implements chain, whose status is "In Progress". */
  boss: string;
}

/**
 * The five-part PARKED predicate, pure and total over one poll's
 * already-fetched (issues, related) snapshot — costs ZERO extra Jira calls.
 * `related` is built (src/daemon/index.ts's `related()` adapter, routed by
 * src/jira-watch/routes.ts's `watchedKeys`) from Implements-outward links
 * off the active set, hydrated with full issue fields — which gives
 * conditions 1 (assignee), 2 (has an Implements link to a boss — implicit in
 * simply appearing here) and 4 (own status) for free. `issues` is the active
 * set this poll fetched, giving condition 3 (boss status) for free too.
 * Condition 5 (the threshold) is NOT decided here — it needs a clock and
 * memory across polls; see `ParkedTracker` / `createParkedDetector` below.
 *
 * A child can in principle be watched by more than one active boss; each
 * (child, boss) pair whose boss is "In Progress" is its own candidate.
 *
 * KNOWN LIMITATION, stated rather than silently accepted: a boss staffed by
 * a DIFFERENT credential (a different daemon/machine) never appears in THIS
 * daemon's own `issues` (the per-credential assigned-issues search), so a
 * child parked under it is invisible here. Each daemon polices only its own
 * bosses — acceptable, but worth knowing.
 */
export function parkedCandidates(issues: readonly JiraIssue[], related: readonly RelatedIssue[]): ParkedCandidate[] {
  const bossStatus = new Map(issues.map((i) => [i.key, i.status]));
  const out: ParkedCandidate[] = [];
  for (const r of related) {
    const child = r.issue;
    if (!child.assignee) continue;
    if (child.status !== "To Do") continue;
    if (child.labels.includes(EXEMPT_LABEL)) continue;
    for (const boss of r.watchers) {
      if (bossStatus.get(boss) === "In Progress") out.push({ child, boss });
    }
  }
  return out;
}

interface Entry {
  boss: string;
  /**
   * Daemon's first observation of `child` in the parked-eligible state — the
   * same reasoning as StalledTracker (src/agents/stalled.ts), copied
   * verbatim: a conservative floor that can only ever DELAY the parked
   * signal (e.g. across a daemon restart, which starts a fresh floor), never
   * fabricate one. Never persisted to disk.
   */
  firstObservedAt: number;
  stage1At?: number;
  stage2At?: number;
  stage3At?: number;
}

/**
 * Per-child in-memory floor + stage bookkeeping. `observe` starts (or
 * restarts, if the watching boss changed) the floor the first time a child
 * is seen as a candidate; `forgetMissing` drops tracking for anything that
 * stopped being a candidate, so a LATER re-park (the child leaves To Do and
 * comes back) starts a fresh floor rather than carrying a stale one.
 */
export class ParkedTracker {
  private readonly entries = new Map<string, Entry>();
  constructor(private readonly now: () => number) {}

  /** Drop tracking for every key not in `stillCandidates` this poll. */
  forgetMissing(stillCandidates: ReadonlySet<string>): void {
    for (const key of [...this.entries.keys()]) if (!stillCandidates.has(key)) this.entries.delete(key);
  }

  /** This poll's observation for a currently-PARKED `childKey` watched by `boss`. */
  observe(childKey: string, boss: string): Entry {
    const existing = this.entries.get(childKey);
    if (existing && existing.boss === boss) return existing;
    const fresh: Entry = { boss, firstObservedAt: this.now() };
    this.entries.set(childKey, fresh);
    return fresh;
  }
}

function stage1Comment(child: string): string {
  return [
    `${MARKER} ${child} is assigned but sitting in To Do — no agent is running for it.`,
    "",
    `Transition ${child} to In Progress (or close it) to activate it.`,
    `If this parking is deliberate, add the \`${EXEMPT_LABEL}\` label to ${child} and this will stop.`,
    "",
    `fingerprint: ${child}`,
    "stage: 1",
  ].join("\n");
}

function stage2Comment(child: string): string {
  return [
    `${MARKER} ${child} is STILL sitting in To Do, unactivated — this is a follow-up.`,
    "",
    `Transition ${child} to In Progress (or close it) to activate it.`,
    `If this parking is deliberate, add the \`${EXEMPT_LABEL}\` label to ${child} and this will stop.`,
    "",
    `fingerprint: ${child}`,
    "stage: 2",
  ].join("\n");
}

function stage3EscalatedComment(child: string, boss: string): string {
  return [
    `${MARKER} ${child} is still parked in To Do, assigned but unactivated, under ${boss} — which has not acted on two prior notices there.`,
    "",
    `Prompt ${boss} to transition ${child} to In Progress (or close it).`,
    `If this parking is deliberate, add the \`${EXEMPT_LABEL}\` label to ${child} and this will stop.`,
    "",
    `fingerprint: ${child}`,
    "stage: 3",
  ].join("\n");
}

function stage3TerminalComment(child: string): string {
  return [
    `${MARKER} ${child} is still parked in To Do after three notices, and this ticket has no boss of its own to escalate to further.`,
    "",
    `Transition ${child} to In Progress (or close it) to activate it.`,
    `If this parking is deliberate, add the \`${EXEMPT_LABEL}\` label to ${child} and this will stop.`,
    "",
    `fingerprint: ${child}`,
    "stage: 3",
  ].join("\n");
}

export interface ParkedDetectorDeps {
  now: () => number;
  /** BUTCHR_PARKED_MINUTES — minutes a child must sit in the parked-eligible state, continuously, before stage 1 fires; also the interval between each subsequent stage. */
  minutes: number;
  /** Post through the daemon's single existing comment-writing seam (the same `addComment` dependency createEscalator uses) — never a second Atlassian writer. */
  addComment: (issue: string, text: string) => Promise<void>;
  /** Recent comments on a ticket, newest-first is fine — used for the dedupe/adoption check (see findMarked). */
  comments: (issue: string) => Promise<readonly CommentRow[]>;
  /** A ticket's issue links — called ONLY at stage 3, to resolve the boss's own boss (inward Implements). The one extra Jira call in this whole feature. */
  links: (issue: string) => Promise<readonly IssueLink[]>;
  log?: (line: string) => void;
}

export interface ParkedDetector {
  /** Run one poll's worth of detection over this poll's (issues, related) snapshot. Never throws — every failure is caught and logged, so a Jira hiccup here can never take the poll loop down with it. */
  check: (issues: readonly JiraIssue[], related: readonly RelatedIssue[]) => Promise<void>;
}

/**
 * Builds the parked-ticket detector wired into src/daemon/loop.ts (via
 * src/daemon/index.ts). See src/daemon/loop.ts's `LoopDeps.checkParked` doc
 * comment for WHY this must be called from the poll's observe function and
 * never from `watch()`'s onChange callback.
 */
export function createParkedDetector(deps: ParkedDetectorDeps): ParkedDetector {
  const tracker = new ParkedTracker(deps.now);
  const rateCap = new RateCap(MAX_PER_HOUR, HOUR_MS);
  const minutesMs = deps.minutes * 60_000;
  const log = (line: string) => deps.log?.(line);

  /**
   * Post (or adopt an already-posted) comment for one stage. Dedupe/adoption
   * first: scan `target`'s recent comments for MARKER + the stable
   * fingerprint (`child`) + this stage's tag — exactly `escalate()`'s
   * technique in src/agents/escalation-loop.ts, generalised via
   * `findMarked` — so a daemon restart (fresh in-memory floor and stage
   * state) adopts its own prior comment instead of re-posting it. A failed
   * comments() fetch fails CLOSED here (returns null, posts nothing this
   * poll): unlike the notify-loop's suppression checks, which must fail
   * open toward DELIVERING a real change, here failing open would risk
   * posting a genuine duplicate the very next successful poll can't tell
   * apart from — at worst this delays one stage by one poll, which is
   * exactly the same "delay, never fabricate" guarantee the floor itself
   * relies on.
   */
  async function postStage(target: string, stageTag: "1" | "2" | "3", child: string, body: string, capKey: string): Promise<number | null> {
    const rows = await deps.comments(target).catch((e) => {
      log(`WARNING: [parked] comments fetch failed for ${target}: ${(e as Error)?.message ?? e}`);
      return null;
    });
    if (rows === null) return null;
    const need = [`fingerprint: ${child}`, `stage: ${stageTag}`];
    const existing = findMarked(rows, MARKER, need);
    if (existing) {
      const adoptedAt = Date.parse(existing.created) || deps.now();
      log(`[parked] adopted existing stage ${stageTag} escalation for ${child} on ${target} from comment ${existing.id} (daemon restart)`);
      return adoptedAt;
    }
    if (!rateCap.allow(capKey, deps.now())) {
      log(`WARNING: [parked] rate cap reached (${MAX_PER_HOUR}/hour) for ${capKey} — ${child} stage ${stageTag} logged only, not posted`);
      return null;
    }
    await deps.addComment(target, body);
    rateCap.record(capKey, deps.now());
    const postedAt = deps.now();
    log(`[parked] ${child} stage ${stageTag} posted on ${target}`);
    return postedAt;
  }

  async function check(issues: readonly JiraIssue[], related: readonly RelatedIssue[]): Promise<void> {
    try {
      const candidates = parkedCandidates(issues, related);
      tracker.forgetMissing(new Set(candidates.map((c) => c.child.key)));

      for (const { child, boss } of candidates) {
        const e = tracker.observe(child.key, boss);
        const now = deps.now();

        if (e.stage1At === undefined) {
          if (now - e.firstObservedAt < minutesMs) continue;
          const at = await postStage(boss, "1", child.key, stage1Comment(child.key), boss);
          if (at !== null) e.stage1At = at;
          continue;
        }

        if (e.stage2At === undefined) {
          if (now - e.stage1At < minutesMs) continue;
          const at = await postStage(boss, "2", child.key, stage2Comment(child.key), boss);
          if (at !== null) e.stage2At = at;
          continue;
        }

        if (e.stage3At === undefined) {
          if (now - e.stage2At < minutesMs) continue;
          // The one extra Jira call in this whole feature: only reached once
          // a boss has already ignored two prior comments. A failed fetch
          // fails CLOSED (posts nothing this poll, retried next time) rather
          // than falling through to the terminal case: treating "couldn't
          // look" the same as "genuinely no grandboss" would, on a real
          // grandboss, permanently misroute stage 3 onto the boss itself the
          // moment stage3At got set from that fallback post.
          const links = await deps.links(boss).catch((err) => {
            log(`WARNING: [parked] links fetch failed for ${boss}: ${(err as Error)?.message ?? err}`);
            return null;
          });
          if (links === null) continue;
          // On an implementer, the boss appears as inwardIssue (see the doc
          // comment on IssueLink, src/atlassian/types.ts) — so the boss's
          // OWN boss, from the boss's own links, is the "inward" end.
          const grandBoss = links.find((l) => l.type === "Implements" && l.otherEnd === "inward")?.key ?? null;
          if (grandBoss) {
            const at = await postStage(grandBoss, "3", child.key, stage3EscalatedComment(child.key, boss), boss);
            if (at !== null) e.stage3At = at;
          } else {
            // Terminal case: the Implements chain in this fleet is
            // task -> story -> epic, and epics are the human's tickets
            // (docs/agent-model.md) — so a boss with no inward Implements
            // link (an epic, or an unlinked ticket) is, by construction, a
            // human-owned ticket already. There is no separate human
            // channel and none is needed: re-post on the boss's own ticket
            // and log a WARNING an operator's `journalctl | grep WARNING`
            // will actually surface.
            log(`WARNING: [parked] ${child.key} parked under ${boss}, which has no boss of its own to escalate to — re-posting on ${boss}`);
            const at = await postStage(boss, "3", child.key, stage3TerminalComment(child.key), boss);
            if (at !== null) e.stage3At = at;
          }
        }
        // stage3At already set: three stages is the whole escalation — nothing further to do.
      }
    } catch (e) {
      log(`WARNING: [parked] detector error: ${(e as Error)?.message ?? e}`);
    }
  }

  return { check };
}
