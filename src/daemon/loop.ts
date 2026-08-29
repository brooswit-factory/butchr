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
  intervalMs: number;
  onError?: (error: unknown) => void;
}

/** Bring the herd in line with the desired active set: spawn the missing, stop the rest. */
export async function reconcileNow(herd: Herd, desired: ReadonlyMap<string, SpawnSpec>): Promise<void> {
  const plan = planReconcile(desired.keys(), await herd.runningIssues());
  for (const issue of plan.spawn) await herd.spawn(desired.get(issue)!);
  for (const issue of plan.stop) await herd.stop(issue);
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

  const issueOf = (list: readonly JiraIssue[], key: string) => list.find((i) => i.key === key);
  const relatedIssueOf = (list: readonly RelatedIssue[], key: string) => list.find((r) => r.issue.key === key)?.issue;

  return watch<Snapshot>(
    async () => {
      const issues = await deps.search();
      const desired = desiredFrom(issues);
      await reconcileNow(deps.herd, desired);
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
      // comments() call per key, however many watchers consult it.
      const crossDaemonCache = new Map<string, Promise<boolean>>();
      const crossDaemonSuppressed = (key: string, before: JiraIssue | undefined, after: JiraIssue | undefined): Promise<boolean> => {
        let p = crossDaemonCache.get(key);
        if (!p) {
          p = (async () => {
            if (!before || !after || !isDaemonLabelOnlyDiff(before, after)) return false;
            if (!deps.comments) return false;
            const comments = await deps.comments(key);
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

      // Assigned issues: notify the issue's own agent only. Parent is membership
      // only (not an event to listen for) — a boss hears change only through
      // the Implements chain below, via routes.ts.
      for (const key of changedKeys(prev.issues, next.issues)) {
        const before = issueOf(prev.issues, key);
        const after = issueOf(next.issues, key);
        const updated = after?.updated ?? before?.updated ?? "";
        if (deps.suppress?.(key, updated, key)) continue;
        if (await crossDaemonSuppressed(key, before, after)) continue;
        await send(key, key);
      }
      // Related work (the Implements chain): notify every watcher of what changed.
      const watchersOf = (k: string) =>
        next.related.find((r) => r.issue.key === k)?.watchers ?? prev.related.find((r) => r.issue.key === k)?.watchers ?? [];
      for (const key of changedKeys(prev.related.map((r) => r.issue), next.related.map((r) => r.issue))) {
        const before = relatedIssueOf(prev.related, key);
        const after = relatedIssueOf(next.related, key);
        const updated = after?.updated ?? before?.updated ?? "";
        const suppressedCrossDaemon = await crossDaemonSuppressed(key, before, after);
        for (const w of watchersOf(key)) {
          if (deps.suppress?.(key, updated, w)) continue;
          if (suppressedCrossDaemon) continue;
          await send(w, key);
        }
      }
    },
    deps.intervalMs,
    deps.onError ? { onError: deps.onError } : {},
  );
}
