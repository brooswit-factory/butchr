import type { JiraIssue } from "../atlassian/types.js";
import { isActive } from "../reconcile/plan.js";
import { AGENT_PREFIX, isDaemonLabel, isPrLabel, PR_PREFIX } from "../labels/plan.js";
import { DAEMON_CHATTER_PREFIX } from "../agents/stalled.js";

/** Keys of issues currently in an active status. */
export const activeKeys = (issues: readonly JiraIssue[]): string[] =>
  issues.filter((i) => isActive(i.status)).map((i) => i.key);

/**
 * Which issues meaningfully changed between two polls — a new key, a gone key,
 * or a field that agents care about (status/summary/updated). Pure; drives
 * which agents get a "your ticket changed" nudge.
 */
export function changedKeys(prev: readonly JiraIssue[], next: readonly JiraIssue[]): string[] {
  const before = new Map(prev.map((i) => [i.key, i]));
  const changed = new Set<string>();
  for (const i of next) {
    const b = before.get(i.key);
    if (!b || b.status !== i.status || b.summary !== i.summary || b.updated !== i.updated) changed.add(i.key);
    before.delete(i.key);
  }
  for (const goneKey of before.keys()) changed.add(goneKey); // disappeared from the feed
  return [...changed].sort();
}

/**
 * Whether `before` -> `after` (same ticket) changed ONLY daemon-namespaced
 * labels (agent:*, pr:* — see src/labels/plan.ts) — status and summary
 * unchanged, and every added/removed label is daemon-owned. Only a daemon
 * ever writes those labels, so a diff confined to them can be treated as a
 * daemon write from ANY daemon — the cross-daemon echo case own-writes.ts's
 * caller uses this for (a local per-daemon write ledger can't know about a
 * write another daemon made). False whenever there is no label change at
 * all: that case belongs to the exact-`updated`-match ledger, not this rule.
 */
export function isDaemonLabelOnlyDiff(before: JiraIssue, after: JiraIssue): boolean {
  if (before.status !== after.status || before.summary !== after.summary) return false;
  const b = new Set(before.labels), a = new Set(after.labels);
  const changedLabels = [...b].filter((l) => !a.has(l)).concat([...a].filter((l) => !b.has(l)));
  return changedLabels.length > 0 && changedLabels.every(isDaemonLabel);
}

/**
 * Whether `before` -> `after` (same ticket) changed AT LEAST ONE daemon-owned
 * label (agent:*, pr:* — see isDaemonLabel, src/labels/plan.ts), added or
 * removed. Unlike isDaemonLabelOnlyDiff, this does NOT gate on status/summary
 * equality and does NOT require every changed label to be daemon-owned — a
 * daemon label write nested inside a larger diff (a status change alongside
 * it, or a human label touched in the same write) still counts. Used by
 * src/daemon/loop.ts to scope the DAEMON_WRITER ledger-hit comment-cursor
 * check (KAN-828) to writes that could plausibly be a daemon LABEL write —
 * the ledger's AGENT-writer arm (an agent's own comment) never changes
 * daemon labels, so this gate is what keeps that arm's behaviour untouched.
 * False whenever there is no label change at all — e.g. a pure comment bump.
 * Pure.
 */
export function daemonLabelsChanged(before: JiraIssue, after: JiraIssue): boolean {
  const b = new Set(before.labels), a = new Set(after.labels);
  const changedLabels = [...b].filter((l) => !a.has(l)).concat([...a].filter((l) => !b.has(l)));
  return changedLabels.some(isDaemonLabel);
}

/**
 * The ticket's single pr:* label value (the suffix after "pr:"), or null when
 * it carries none. Two pr:* labels shouldn't happen — `desiredLabels`
 * (src/labels/plan.ts) emits at most one — but if it ever did, the
 * sorted-first is used deterministically rather than guessing intent.
 */
function prLabelValue(issue: JiraIssue): string | null {
  const values = issue.labels.filter(isPrLabel).sort();
  return values.length ? values[0]!.slice(PR_PREFIX.length) : null;
}

/**
 * The ticket's single agent:* label value (the suffix after "agent:"), or
 * null when it carries none. Same sorted-first tie-break as `prLabelValue`
 * for the same reason: `desiredLabels` (src/labels/plan.ts) emits at most
 * one, but this does not trust that invariant blindly.
 */
function agentLabelValue(issue: JiraIssue): string | null {
  const values = issue.labels.filter((l) => l.startsWith(AGENT_PREFIX)).sort();
  return values.length ? values[0]!.slice(AGENT_PREFIX.length) : null;
}

/**
 * FACTORY-949 (implementing story FACTORY-948): true exactly when the
 * ticket's `agent:*` label moved TO `blocked` from anything else (none,
 * `working`, `idle`, `stalled`) between `before` -> `after`. A label that
 * was ALREADY `blocked` on both sides (no edge — the ordinary "still
 * blocked" case between two polls) or that leaves `blocked` for something
 * else is deliberately NOT a transition here — this predicate names only
 * the ONE edge FACTORY-948's behaviour spec wakes anyone for. Pure, like
 * every other predicate in this file.
 */
export function blockedTransition(before: JiraIssue, after: JiraIssue): boolean {
  return agentLabelValue(before) !== "blocked" && agentLabelValue(after) === "blocked";
}

/** Which daemon-owned namespace changed in a `daemonLabelTransition`, and its from/to values (either side may be null: no label in that namespace on that side). */
export interface DaemonLabelTransition {
  prefix: "agent" | "pr";
  from: string | null;
  to: string | null;
}

/**
 * BUTCHR-87: names WHICH daemon-owned label value (agent:* or pr:*) changed
 * between before -> after, and its from/to — for NAMING a notify reason, a
 * different job from `isDaemonLabelOnlyDiff`/`daemonLabelsChanged` (which
 * only ever answer "did a daemon label change", for suppression). Relies on
 * the same single-value-per-namespace invariant `prTransition` already
 * relies on (`desiredLabels` emits at most one agent:* and one pr:* label);
 * unlike `prTransition`, a pr:* value moving to null (a pure removal) DOES
 * count here — this function is naming what changed, not deciding whether
 * an author's outstanding review just resolved.
 *
 * Deterministic precedence when BOTH namespaces changed in the same diff:
 * pr:* wins, agent:* is not reported. Rationale: pr:* is materially rarer
 * and, per the self-path pr:* exemption in createIssueEventRules, already
 * the class this codebase treats as most worth an agent's attention — this
 * mirrors that same judgement for the general (non-self, or self-but-not-a-
 * transition) case rather than inventing a second, competing ranking.
 * Returns null when NEITHER namespace's value actually differs (including
 * "no daemon label of either kind on either side").
 */
export function daemonLabelTransition(before: JiraIssue, after: JiraIssue): DaemonLabelTransition | null {
  const prBefore = prLabelValue(before), prAfter = prLabelValue(after);
  if (prBefore !== prAfter) return { prefix: "pr", from: prBefore, to: prAfter };
  const agentBefore = agentLabelValue(before), agentAfter = agentLabelValue(after);
  if (agentBefore !== agentAfter) return { prefix: "agent", from: agentBefore, to: agentAfter };
  return null;
}

/**
 * Whether `before` -> `after` (same ticket) is a pr:* TRANSITION: the
 * ticket's pr:* label after the poll differs from before, AND there IS a
 * pr:* label after. Counts none->open, open->approved, open->changes-requested,
 * changes-requested->approved, approved->merged, etc. A pure REMOVAL (pr:x ->
 * no pr:* label at all — a PR closed unmerged, or the KAN-814 restart
 * artefact) is deliberately NOT a transition and returns null — it never
 * wakes anyone. Status/summary changes are irrelevant to this rule: a pr:*
 * transition nested inside a larger diff (status changed too) still counts —
 * unlike isDaemonLabelOnlyDiff, this never gates on status/summary equality.
 * Pure.
 */
export function prTransition(before: JiraIssue, after: JiraIssue): { from: string | null; to: string } | null {
  const to = prLabelValue(after);
  if (to === null) return null;
  const from = prLabelValue(before);
  if (from === to) return null;
  return { from, to };
}

/**
 * FACTORY-865: butchr's own `[butchr:...]` markers (DAEMON_CHATTER_PREFIX)
 * whose comment is addressed to an agent and MUST keep moving the notify
 * comment cursor and MUST keep being able to wake a watcher, even though it
 * is daemon-authored chatter by the `DAEMON_CHATTER_PREFIX` convention.
 * Every other `[butchr:` comment is bare bookkeeping — the daemon narrating
 * an observation for the ticket's own record (a human reader, or a
 * multi-stage escalation ladder that a human ultimately resolves), never a
 * message whose OWN delivery this specific comment is the reason for.
 *
 * Justification per marker, from what the code actually does with it (see
 * this ticket's PR description for the full per-file citations):
 * - `[butchr:blocked]` (escalate.ts): a frozen child's escalation to its
 *   boss, posted while genuinely waiting on an ANSWER — non-negotiable.
 * - `[butchr:respawn]` (respawn.ts): posted only when the session was LOST
 *   (a fresh Claude session with no memory) and explicitly instructs
 *   "re-read your ticket" — the opposite of `[butchr:resume]` below, whose
 *   own doc comment says it deliberately never gives that instruction.
 * - `[butchr:stall]` (stall-remediation.ts): literally the wake comment for
 *   a stalled agent — its entire purpose is to end the stall.
 * - `[butchr:unresponsive]` (escalation-loop.ts): a blocked-pane escalation
 *   that, like `[butchr:blocked]`, waits on an ANSWER reply.
 *
 * Every other current marker (`[butchr:reconcile]`, `[butchr:crashloop]`,
 * `[butchr:parked]`, `[butchr:abandoned]`, `[butchr:pinned]`,
 * `[butchr:frozen]`, `[butchr:yieldloop]`, `[butchr:resume]`,
 * `[butchr:restored-degraded]`) is bookkeeping: an observational log line
 * for a human reader (even parked.ts's/abandoned.ts's boss-escalation
 * stages are phrased as information, resolved by a human or a later
 * `shelve_worker`/`finish_worker` call, never by an agent replying to THIS
 * comment with an ANSWER) — none of these is swallowed by this change
 * either, since a bookkeeping comment landing alone (no coinciding daemon
 * label flip) still bumps `updated` and still delivers via the existing
 * "could not attribute this diff" fallback (createIssueEventRules' own
 * §3D path, out of scope for this ticket — see its own doc comment).
 * `[butchr:credential-dead]`/`[butchr:ops-alert]` are deliberately absent
 * from both buckets: grepped at this ticket's base commit, neither marker
 * is ever written into a Jira comment body (`addComment`) — both are
 * journal-only (`deps.log`) or Rocket.Chat-only — so neither can ever reach
 * this predicate's input in the first place.
 */
export const WAKE_MARKERS: ReadonlySet<string> = new Set([
  "[butchr:blocked]",
  "[butchr:respawn]",
  "[butchr:stall]",
  "[butchr:unresponsive]",
]);

/**
 * Whether `body` is one of butchr's own daemon-chatter comments
 * (DAEMON_CHATTER_PREFIX) that must be treated as bare bookkeeping — EXCLUDED
 * from the notify comment cursor so it can never defeat daemon-label-only
 * suppression (FACTORY-865/FACTORY-864). `false` for a non-chatter comment
 * (an agent's own report, a human's comment — never starts with
 * DAEMON_CHATTER_PREFIX, see that constant's own doc comment) AND for any
 * chatter comment whose marker is in WAKE_MARKERS. Pure; no I/O.
 */
export function isBookkeepingComment(body: string): boolean {
  if (!body.startsWith(DAEMON_CHATTER_PREFIX)) return false;
  for (const marker of WAKE_MARKERS) if (body.startsWith(marker)) return false;
  return true;
}

/**
 * Filters `comments` (any shape carrying a `body`, e.g. JiraComment) down to
 * the ones the notify comment cursor must actually track — drops bookkeeping
 * chatter (see isBookkeepingComment), keeps everything else (a real
 * comment, or an allowlisted WAKE_MARKERS comment) in its original order.
 * This is the one shared place both notify-suppression call sites
 * (src/resources/issue.ts, src/jira-watch/linked-eventing.ts) must build
 * their {newest, ids}/commentCursor from — never deps.comments()'s raw
 * result directly.
 */
export function excludeBookkeepingComments<T extends { body: string }>(comments: readonly T[]): readonly T[] {
  return comments.filter((c) => !isBookkeepingComment(c.body));
}
