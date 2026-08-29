import { watch, type Stop } from "@brooswit/sundry";
import type { JiraIssue, JiraComment } from "../atlassian/types.js";
import { planReconcile } from "../reconcile/plan.js";
import { activeKeys, changedKeys, isDaemonLabelOnlyDiff } from "../jira-watch/diff.js";
import type { Herd, SpawnSpec } from "../agents/herd.js";

/** A ticket watched on behalf of active issues via the Implements chain (see src/jira-watch/routes.ts). */
export interface RelatedIssue {
  issue: JiraIssue;
  /** Active issue keys whose agents should hear when this ticket changes. */
  watchers: readonly string[];
}

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
  /** Nudge the agent working `issue`; `about` is the ticket that changed (not always its own). */
  notify: (issue: string, about: string) => void | Promise<void>;
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
   * Recent comments on a ticket, newest first — used ONLY on the label-only
   * daemon-namespaced diff branch (a cross-daemon label echo, see
   * isDaemonLabelOnlyDiff) to check for a foreign comment invisible to the
   * status/summary/updated fields alone. Optional; omitted, that branch
   * never suppresses (never guess without the ability to look).
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
  for (const issue of plan.spawn) await herd.spawn(desired.get(issue)!);
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
 * + `deps.comments`).
 */
export function startLoop(deps: LoopDeps): Stop {
  // Persists ACROSS polls (unlike `sent`, reset each poll below): the last
  // comment id observed per key, for the cross-daemon label-echo check.
  // Absence of a key means "no baseline yet" — the fail-safe case that
  // always delivers rather than suppresses on an unknown baseline.
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
      const send = async (issue: string, about: string) => {
        const id = `${issue}|${about}`;
        if (sent.has(id)) return;
        sent.add(id);
        await deps.notify(issue, about);
      };

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
            if (!deps.comments) return false;
            let comments: readonly JiraComment[];
            try {
              comments = await deps.comments(key);
            } catch {
              return false; // cannot look -> do not suppress; cursor left untouched
            }
            const newest = comments[0]?.id ?? null;
            const hadBaseline = commentCursor.has(key);
            const baseline = commentCursor.get(key) ?? null;
            commentCursor.set(key, newest);
            if (!hadBaseline) return false; // unknown baseline: never suppress
            return newest === baseline;
          })();
          crossDaemonCache.set(key, p);
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
        if (deps.suppress?.(key, after.updated, watcher)) return true;
        return crossDaemonSuppressed(key, before, after);
      };

      // Assigned issues: notify the issue's own agent only. Parent is membership
      // only (not an event to listen for) — a boss hears change only through
      // the Implements chain below, via routes.ts.
      for (const key of changedKeys(prev.issues, next.issues)) {
        const before = issueOf(prev.issues, key);
        const after = issueOf(next.issues, key);
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
