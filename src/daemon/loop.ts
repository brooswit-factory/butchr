import { watch, type Stop } from "@brooswit/sundry";
import type { JiraIssue, JiraComment } from "../atlassian/types.js";
import { planReconcile } from "../reconcile/plan.js";
import { activeKeys, changedKeys, daemonLabelsChanged, isDaemonLabelOnlyDiff, prTransition } from "../jira-watch/diff.js";
import type { Herd, SpawnSpec } from "../agents/herd.js";

/** A ticket watched on behalf of active issues via the Implements chain (see src/jira-watch/routes.ts). */
export interface RelatedIssue {
  issue: JiraIssue;
  /** Active issue keys whose agents should hear when this ticket changes. */
  watchers: readonly string[];
}

/**
 * Why an agent is being nudged, when it is more than "your ticket changed" —
 * currently only a pr:* transition on the ticket's OWN agent (see
 * `prTransition`, src/jira-watch/diff.ts). Omitted/undefined for every other
 * nudge, so existing callers and tests are unaffected.
 */
export type NotifyReason = { pr: { from: string | null; to: string } };

export interface LoopDeps {
  /** Fetch the assigned issues (active + recently changed) each poll. */
  search: () => Promise<JiraIssue[]>;
  /**
   * Fetch tickets related to the active set via the Implements chain (see
   * src/jira-watch/routes.ts), with the active keys that watch each. Related
   * tickets are watched regardless of assignee, so a hierarchy can span
   * credentials (and machines): a boss hears about its implementer's
   * progress even when another daemon staffs it.
   */
  related?: (active: readonly string[]) => Promise<RelatedIssue[]>;
  herd: Herd;
  /**
   * Nudge the agent working `issue`; `about` is the ticket that changed (not
   * always its own). `reason`, when present, names WHY beyond the default
   * "your ticket changed" — see `NotifyReason`.
   */
  notify: (issue: string, about: string, reason?: NotifyReason) => void | Promise<void>;
  /**
   * Called once per respawned agent, right after it's back up. Jira knowledge
   * (the [butchr:respawn] notice) lives OUTSIDE loop.ts — this is the seam
   * src/daemon/index.ts wires it through.
   */
  onRespawn?: (issue: string, reason: string, observedArgv: string[]) => void | Promise<void>;
  /** Reconcile daemon-owned (agent:*, pr:*) labels on this poll's `issues`. */
  syncLabels?: (issues: readonly JiraIssue[]) => Promise<ReadonlySet<string>>;
  /**
   * Whether a ping to `watcher` about `key` (now at `updated`) should be
   * swallowed as an echo of a write THIS daemon made — see the own-write
   * ledger, src/jira-watch/own-writes.ts. Consulted at both notify sites (an
   * issue's own agent, and each watcher of a related ticket), with the
   * notified agent passed as `watcher`. Default: suppress nothing, so
   * existing tests and other callers keep working.
   */
  suppress?: (key: string, updated: string, watcher: string) => boolean;
  /**
   * Recent comments on a ticket, newest first — used to check for a foreign
   * comment invisible to the status/summary/updated fields alone: on the
   * label-only daemon-namespaced diff branch (a cross-daemon label echo, see
   * isDaemonLabelOnlyDiff), on a DAEMON_WRITER ledger hit that also changed a
   * daemon label (see daemonLabelsChanged, KAN-828), and to seed a key's
   * comment-cursor baseline on its first sighting each poll. Optional;
   * omitted, none of those ever suppress (never guess without the ability to
   * look) and seeding never records a baseline.
   */
  comments?: (key: string) => Promise<readonly JiraComment[]>;
  /** Free-text daemon log line, e.g. the storm guard's suppression WARNING. Optional; omitted, that line is simply never emitted. */
  log?: (line: string) => void;
  intervalMs: number;
  onError?: (error: unknown) => void;
}

/** How many polls a just-respawned issue is shielded from a further respawn. */
const RESPAWN_SUPPRESS_POLLS = 5;

/**
 * Per-issue respawn cooldown, threaded explicitly through `ReconcileOptions`
 * (no module-level mutable state) — `startLoop` creates ONE instance that
 * persists across polls, while a direct `reconcileNow` call (existing tests
 * included) defaults to a fresh instance every time, i.e. never suppressed.
 *
 * Rule implemented: a respawn for `issue` at poll P starts a window running
 * through poll `P + RESPAWN_SUPPRESS_POLLS - 1`; `issue` found stale again at
 * any poll inside that window is suppressed (no stop, no spawn, no
 * `onRespawn`) rather than respawned again. This guarantees in particular
 * that two consecutive polls never both respawn the same issue — that's just
 * the P+1 case of the same window. A poll at `P + RESPAWN_SUPPRESS_POLLS` or
 * later is outside the window: a normal respawn, opening its own new window.
 */
export class RespawnGuard {
  private poll = 0;
  private lastRespawnAt = new Map<string, number>();

  /** Advance to the next poll and return its number — call ONCE per reconcileNow(). */
  nextPoll(): number {
    return ++this.poll;
  }

  /** Whether `issue`, found stale at `poll`, should actually be respawned now. Records the respawn (opening a fresh window) when true. */
  admit(issue: string, poll: number): boolean {
    const last = this.lastRespawnAt.get(issue);
    if (last !== undefined && poll - last < RESPAWN_SUPPRESS_POLLS) return false;
    this.lastRespawnAt.set(issue, poll);
    return true;
  }

  /** The poll at/after which `issue` is next eligible for a respawn — for the suppression WARNING's "until …". */
  eligibleAgainAt(issue: string): number {
    return (this.lastRespawnAt.get(issue) ?? 0) + RESPAWN_SUPPRESS_POLLS;
  }
}

export interface ReconcileOptions {
  onRespawn?: (issue: string, reason: string, observedArgv: string[]) => void | Promise<void>;
  /** Storm-guard state; see RespawnGuard. Defaults to a fresh (never-suppressing) instance. */
  guard?: RespawnGuard;
  /** Called, with the exact line to log, when the storm guard suppresses a would-be respawn. */
  onSuppressed?: (issue: string, message: string) => void;
}

/**
 * Bring the herd in line with the desired active set: spawn the missing, stop
 * the rest, and replace any stale agent (running, but its process argv lacks
 * butchr's spawn flags) with a fresh one — treated as stop-then-spawn, so
 * buildWorkspace rewrites its CLAUDE.md/brief.md/mcp.json exactly as a normal
 * spawn would. A repeat respawn of the same issue within RESPAWN_SUPPRESS_POLLS
 * polls is suppressed by `opts.guard` instead — see RespawnGuard.
 */
export async function reconcileNow(herd: Herd, desired: ReadonlyMap<string, SpawnSpec>, opts: ReconcileOptions = {}): Promise<void> {
  const guard = opts.guard ?? new RespawnGuard();
  const poll = guard.nextPoll();
  const stale = await herd.staleIssues();
  const staleByIssue = new Map(stale.map((s) => [s.issue, s]));
  const plan = planReconcile(desired.keys(), await herd.runningIssues(), staleByIssue.keys());
  // Concurrent, not serial (PR #68 review): HerdrHerd.spawn() now waits out
  // KICKOFF_VERIFY_MS (KAN-804/807) before returning, so a serial loop over a
  // burst of N new spawns (e.g. several stories activating in one poll)
  // would stall this ENTIRE poll — label sync and every ticket's
  // notifications included — for N times that wait. Each issue's spawn is
  // independent (its own workspace directory, its own pane), so nothing
  // requires them to run one after another.
  await Promise.all(plan.spawn.map((issue) => herd.spawn(desired.get(issue)!)));
  for (const issue of plan.stop) await herd.stop(issue);
  for (const issue of plan.respawn) {
    const info = staleByIssue.get(issue)!;
    if (!guard.admit(issue, poll)) {
      const until = guard.eligibleAgainAt(issue);
      opts.onSuppressed?.(
        issue,
        `WARNING: [reconcile] ${issue} respawned again within ${RESPAWN_SUPPRESS_POLLS} polls — suppressing further respawns until poll ${until}`,
      );
      continue;
    }
    await herd.stop(issue);
    await herd.spawn(desired.get(issue)!);
    if (opts.onRespawn) await opts.onRespawn(issue, info.reason, info.observedArgv);
  }
}

/** The desired active set as spawn specs, keyed by issue. */
export const desiredFrom = (issues: readonly JiraIssue[]): Map<string, SpawnSpec> =>
  new Map(issues.filter((i) => activeKeys([i]).length).map((i) => [i.key, { key: i.key, issuetype: i.issuetype, summary: i.summary, parent: i.parent }]));

interface Snapshot { issues: JiraIssue[]; related: RelatedIssue[] }

/**
 * The daemon's core loop. Every poll: fetch assigned issues, reconcile the herd
 * (idempotent — this is the periodic controller, correct after a restart), and
 * fetch the work related to what's active. On any change between polls: nudge
 * each affected agent, naming the ticket that changed — unless it is
 * suppressed as an echo of a write the daemon itself made (own-write ledger,
 * `deps.suppress`) or a cross-daemon label-only echo (`isDaemonLabelOnlyDiff`
 * + `deps.comments`) — EXCEPT a pr:* transition on a ticket's own agent
 * (`prTransition`), which is delivered past both suppressions and names the
 * transition in the third `notify` argument. A DAEMON_WRITER own-write-ledger
 * hit that also changed a daemon label (`daemonLabelsChanged`) is itself not
 * final either — see `ledgerHitSuppressed` below (KAN-828).
 */
export function startLoop(deps: LoopDeps): Stop {
  // Persists ACROSS polls (unlike `sent`, reset each poll below): the last
  // comment id observed per key — for the cross-daemon label-echo check, the
  // DAEMON_WRITER ledger-hit check (KAN-828), and first-sighting baseline
  // seeding (KAN-828). Absence of a key means "no baseline yet" — the
  // fail-safe case that always delivers rather than suppresses on an unknown
  // baseline; seeding is what keeps a ledger hit from ever meeting that case.
  const commentCursor = new Map<string, string | null>();
  // Also persists across polls: the respawn storm guard (see RespawnGuard).
  // One instance for the whole loop's lifetime — NOT module-level state — so
  // it survives across polls without leaking between independent startLoop
  // calls (e.g. separate tests).
  const respawnGuard = new RespawnGuard();

  const issueOf = (list: readonly JiraIssue[], key: string) => list.find((i) => i.key === key);
  const relatedIssueOf = (list: readonly RelatedIssue[], key: string) => list.find((r) => r.issue.key === key)?.issue;

  return watch<Snapshot>(
    async () => {
      const issues = await deps.search();
      const desired = desiredFrom(issues);
      await reconcileNow(deps.herd, desired, {
        ...(deps.onRespawn ? { onRespawn: deps.onRespawn } : {}),
        guard: respawnGuard,
        ...(deps.log ? { onSuppressed: (_issue: string, message: string) => deps.log!(message) } : {}),
      });
      const related = deps.related ? await deps.related([...desired.keys()]) : [];
      if (deps.syncLabels) await deps.syncLabels(issues);
      return { issues, related };
    },
    async (next, prev) => {
      const sent = new Set<string>();
      const send = async (issue: string, about: string, reason?: NotifyReason) => {
        const id = `${issue}|${about}`;
        if (sent.has(id)) return;
        sent.add(id);
        await deps.notify(issue, about, reason);
      };

      // ONE deps.comments(key) call per key, per poll — shared by baseline
      // seeding below, the DAEMON_WRITER ledger-hit comment-cursor check, and
      // the cross-daemon label-only echo check (KAN-828 item 4). Fails OPEN:
      // a rejected call (a transient network error — this is a live Jira
      // call), or `deps.comments` simply not being wired up, is never treated
      // as "no new comment" and never advances the cursor, so a failed poll
      // can never install a wrong baseline.
      const commentsCache = new Map<string, Promise<{ ok: true; newest: string | null } | { ok: false }>>();
      const fetchComments = (key: string): Promise<{ ok: true; newest: string | null } | { ok: false }> => {
        let p = commentsCache.get(key);
        if (!p) {
          p = (async () => {
            if (!deps.comments) return { ok: false as const };
            try {
              const comments = await deps.comments(key);
              return { ok: true as const, newest: comments[0]?.id ?? null };
            } catch {
              return { ok: false as const };
            }
          })();
          commentsCache.set(key, p);
        }
        return p;
      };

      // BASELINE SEEDING (KAN-828 item 3): every key sighted THIS poll with
      // no recorded comment-cursor entry yet gets one seeded now, from its
      // CURRENT newest comment id, so its first-ever ledger hit already has a
      // baseline to compare against — without this, the "unknown baseline"
      // fail-safe would turn every key's first daemon-label ledger hit into
      // a one-time echo nudge, noise this ticket must not add. Fail-open: a
      // rejected/unavailable call leaves the key unseeded, retried on a
      // later poll, never installing a baseline it did not observe. A key
      // that appears mid-run (a newly staffed ticket) is seeded right here,
      // on the poll it first appears — safe, because `suppressed()` already
      // delivers unconditionally on appear/disappear (no `before`), and a
      // ledger hit requires both `before` and `after`, so by the time a key
      // can ever hit the ledger it was necessarily present — and thus
      // seeded — on the previous poll. A ledger hit therefore always has a
      // baseline.
      const seenKeys = new Set<string>([...next.issues.map((i) => i.key), ...next.related.map((r) => r.issue.key)]);
      await Promise.all(
        [...seenKeys].map(async (key) => {
          if (commentCursor.has(key)) return;
          const result = await fetchComments(key);
          if (result.ok) commentCursor.set(key, result.newest);
        }),
      );

      // Memoized per key, per poll: the label-only branch makes at most one
      // comments() call per key, however many watchers consult it. Fails
      // OPEN: a rejected comments() call (a transient network error — this is
      // a live Jira call) must never suppress and must never write the
      // comment cursor, or a failed poll would install a wrong baseline and
      // could cause a LATER poll to wrongly suppress a real change.
      const crossDaemonCache = new Map<string, Promise<boolean>>();
      const crossDaemonSuppressed = (key: string, before: JiraIssue | undefined, after: JiraIssue | undefined): Promise<boolean> => {
        let p = crossDaemonCache.get(key);
        if (!p) {
          p = (async () => {
            if (!before || !after || !isDaemonLabelOnlyDiff(before, after)) return false;
            const result = await fetchComments(key);
            if (!result.ok) return false; // cannot look -> do not suppress; cursor left untouched
            const hadBaseline = commentCursor.has(key);
            const baseline = commentCursor.get(key) ?? null;
            commentCursor.set(key, result.newest);
            if (!hadBaseline) return false; // unknown baseline: never suppress
            return result.newest === baseline;
          })();
          crossDaemonCache.set(key, p);
        }
        return p;
      };

      // DAEMON_WRITER ledger-hit comment-cursor check (KAN-828). The own-write
      // ledger's exact-`updated`-match discriminator (own-writes.ts, not
      // modified here) treats a foreign write folded into our read-back the
      // same as a pure self-write, which swallows a reviewer/boss/human
      // comment landing in that round-trip (KAN-793/799/804). That guarantee
      // is corrected HERE, not in own-writes.ts (out of scope): a
      // DAEMON_WRITER hit is no longer the final verdict — it means "our
      // write bumped `updated` — was anything else folded in?", answered by
      // whether the ticket's newest comment id moved since the recorded
      // baseline.
      //
      // `daemonLabelsChanged` decides WHICH arm to run, not what the cursor
      // means (KAN-838 — a prior version of this comment claimed a moved
      // newest-comment-id on the DAEMON arm meant something foreign was
      // folded in, treating that as proof the cursor could only be checked,
      // never advanced, on the AGENT arm; that reasoning was false). The
      // cursor's real invariant is "the newest comment id this daemon has
      // OBSERVED for this key", not "the newest it has DELIVERED" — every
      // path that learns the newest id must advance it, including a
      // suppression. The AGENT arm (an agent's own write, typically its own
      // comment, changing no daemon label) still always suppresses — that
      // part of KAN-828's reasoning holds — but it must ALSO resolve and
      // record the newest comment id before returning, via the same
      // per-poll `fetchComments` memo the DAEMON arm uses, so a stale
      // baseline never survives past the write that actually moved it.
      // Skipping that step is exactly what caused the regression this
      // ticket fixes: the NEXT daemon label write (agent:working<->idle,
      // every turn) would see the agent's own already-suppressed comment as
      // "new" and wake the agent about it. Fail-open discipline is
      // unchanged either way: a rejected/unwired fetch leaves the cursor
      // untouched, never installing a baseline nothing this poll observed.
      //
      // Two residuals, carried forward rather than silently dropped (KAN-828
      // documented the first; this ticket must not let the rewrite lose it):
      //
      // Known residual, stated rather than hidden: a ledger hit whose
      // folded-in foreign event was a status change with NO comment is still
      // suppressed — outside this discriminator's reach, on the DAEMON arm,
      // unchanged since KAN-828.
      //
      // Second known residual (KAN-838): on the AGENT arm, a foreign comment
      // landing in the SAME fetch window as the agent's own write is folded
      // into the cursor advance below and is never delivered to the ticket's
      // own agent that poll (it still reaches any WATCHER via
      // crossDaemonSuppressed, which never consults this cursor for a pure
      // comment diff) — the arm's job is only to keep the cursor honest for
      // later polls, not to reconsider what it suppresses on its own poll.
      const ledgerHitCache = new Map<string, Promise<boolean>>();
      const ledgerHitSuppressed = (key: string, before: JiraIssue, after: JiraIssue): Promise<boolean> => {
        let p = ledgerHitCache.get(key);
        if (!p) {
          p = (async () => {
            if (!daemonLabelsChanged(before, after)) {
              // Agent-writer arm / pure comment path: always suppressed, but
              // the cursor must still learn the newest id it just observed
              // (KAN-838) — see the block comment above.
              const result = await fetchComments(key);
              if (result.ok) commentCursor.set(key, result.newest);
              return true;
            }
            const result = await fetchComments(key);
            if (!result.ok) return false; // fail open: deliver, cursor untouched
            const baseline = commentCursor.get(key) ?? null;
            if (result.newest === baseline) return true; // no new comment -> suppress
            commentCursor.set(key, result.newest);
            return false; // newest comment moved -> deliver
          })();
          ledgerHitCache.set(key, p);
        }
        return p;
      };

      // Both suppression checks require an ACTUAL before/after pair — a key
      // appearing or disappearing is still a real change (the old
      // isOwnLabelBump made this explicit; crossDaemonSuppressed already
      // requires both above). Consulting the ledger with a stale previous
      // `updated` for a now-gone key would check a value nothing this poll
      // actually observed, so appear/disappear always delivers, unchecked.
      const suppressed = async (key: string, before: JiraIssue | undefined, after: JiraIssue | undefined, watcher: string): Promise<boolean> => {
        if (!before || !after) return false;
        if (deps.suppress?.(key, after.updated, watcher)) return ledgerHitSuppressed(key, before, after);
        return crossDaemonSuppressed(key, before, after);
      };

      // Assigned issues: notify the issue's own agent only. Parent is membership
      // only (not an event to listen for) — a boss hears change only through
      // the Implements chain below, via routes.ts.
      for (const key of changedKeys(prev.issues, next.issues)) {
        const before = issueOf(prev.issues, key);
        const after = issueOf(next.issues, key);
        // A pr:* transition on the ticket's OWN agent is delivered BEFORE
        // either suppression is consulted (KAN-691/KAN-819/KAN-823): neither
        // the own-write ledger (writer "daemon" — a label sync write) nor
        // isDaemonLabelOnlyDiff may swallow it, because it's the one label
        // flip an approved/changes-requested author is actually waiting on.
        // This deliberately SKIPS crossDaemonSuppressed too, so the per-key
        // comment cursor does not advance this poll for this key when no
        // watcher also touches it. That is safe: the cursor is used only as
        // an EQUALITY check against a monotonically-growing newest-comment
        // id (see crossDaemonSuppressed below), so leaving it one poll stale
        // only ever biases a LATER comparison toward "not suppressed"
        // (delivered) — it can never manufacture a match that wrongly
        // suppresses a genuine later change. This mirrors the existing
        // tolerance in `suppressed()` itself: an own-write-ledger hit already
        // short-circuits before crossDaemonSuppressed ever runs.
        const transition = before && after ? prTransition(before, after) : null;
        if (transition) {
          await send(key, key, { pr: transition });
          continue;
        }
        if (await suppressed(key, before, after, key)) continue;
        await send(key, key);
      }
      // Related work (the Implements chain): notify every watcher of what changed.
      const watchersOf = (k: string) =>
        next.related.find((r) => r.issue.key === k)?.watchers ?? prev.related.find((r) => r.issue.key === k)?.watchers ?? [];
      for (const key of changedKeys(prev.related.map((r) => r.issue), next.related.map((r) => r.issue))) {
        const before = relatedIssueOf(prev.related, key);
        const after = relatedIssueOf(next.related, key);
        for (const w of watchersOf(key)) {
          if (await suppressed(key, before, after, w)) continue;
          await send(w, key);
        }
      }
    },
    deps.intervalMs,
    deps.onError ? { onError: deps.onError } : {},
  );
}
