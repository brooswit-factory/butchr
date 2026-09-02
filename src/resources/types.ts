/**
 * The ResourceType interface (BUTCHR-64/BUTCHR-69): what "a thing butchr
 * staffs" must declare, and NOTHING else. Four members — discovery,
 * activation, event rules, spawn config — already load-bearing for the issue
 * tier (src/resources/issue.ts, its one instance today). A second resource
 * type (e.g. the project tier, BUTCHR-67) writes its own module exporting a
 * ResourceType<ItsShape> and hands it to src/daemon/loop.ts's
 * runResourceLoop — nothing here, and nothing in the loop, needs to change
 * for that to work.
 *
 * Everything NOT named here (spawn, argv, panes, escalation, labels, docs)
 * stays SHARED across every resource type — see src/agents/workspace.ts,
 * src/agents/argv.ts, src/agents/herd.ts, src/agents/parked.ts, src/labels/*.
 * A resource type's spawnConfig member only ever produces the
 * (already-shared) SpawnSpec those consume; it never re-implements them.
 *
 * OPAQUE SNAPSHOT, per the epic's ruling on BUTCHR-69: the loop never diffs a
 * resource's own fields. Discovery returns a plain array of `T`; event rules
 * alone decide what "changed" means for `T` (see `EventRules.poll` below) —
 * the loop only ever sees the string ids that come back out. This is what
 * lets a completely different notion of "changed" (e.g. a Confluence page
 * version moving, or a separately-polled comment arriving — the project
 * tier's shape, BUTCHR-67) share this same interface without editing it.
 */
import type { SpawnSpec } from "../agents/workspace.js";

/**
 * A resource `T` watched on behalf of the active set, plus which active ids
 * should hear when it changes. Field name `issue` is historical (this type
 * predates genericity, back when `T` was always `JiraIssue`) and is kept
 * as-is rather than renamed — see src/daemon/loop.ts's `RelatedIssue` alias,
 * which is this same type under the name and default type param existing
 * callers (e.g. src/agents/parked.ts) already depend on.
 */
export interface RelatedResource<T> {
  issue: T;
  watchers: readonly string[];
}

export interface Discovery<T> {
  /** This resource's opaque id — the string carried in the x-issue header. */
  idOf(resource: T): string;
  /** Enumerate this resource type's candidates. Already scoped to the one user butchr is configured as. */
  search(): Promise<T[]>;
  /**
   * Resources related to the active set that an active resource should also
   * watch (e.g. an issue's Implements chain) — fed the active id set,
   * returns each related resource plus which active ids watch it. Optional:
   * a type with nothing analogous simply omits it (today, only the issue
   * tier has one).
   */
  related?(active: readonly string[]): Promise<RelatedResource<T>[]>;
}

export interface Activation<T> {
  /** Whether `resource` currently deserves a live agent. */
  isActive(resource: T): boolean;
}

/**
 * Why an agent is being nudged, when it is more than "your ticket changed".
 * Concretely issue-shaped (every member below names an issue-tier concept —
 * a status, a daemon label, a summary, a comment) because only the issue
 * tier's event rules produce one today; a future type's event rules are
 * free to never populate `reason` at all, or to define their own union —
 * this one is not shared. Extending THIS union for a second producer would
 * be that type's own event-rules design, out of scope here (the project
 * type's event rules are BUTCHR-67, not this ticket).
 *
 * BUTCHR-87 widened this from the one-member `{ pr }` union to every class
 * `createIssueEventRules` (src/resources/issue.ts) can honestly establish
 * from one poll's (before, after) `JiraIssue` pair without an extra Jira
 * call — see that module's `decide()` for the precedence order among them
 * and src/jira-watch/diff.ts's `daemonLabelTransition` for the label member.
 * `pr` keeps its own historical shape (rather than folding into `label`)
 * because it alone drives `prReviewStateNudge` (src/agents/pr-nudge.ts), a
 * separately-guarded rendering (test/unit/merge-check-guard.test.ts) that
 * this ticket does not touch — every other member is rendered by
 * src/agents/change-nudge.ts instead. `appeared`/`disappeared` cover a key
 * entering or leaving a poll's snapshot (no `before` or no `after` to diff
 * at all); `comment` is populated only where the suppression stack
 * (issue.ts) already learned the ticket's newest comment id moved while
 * deciding whether to suppress — never from a call made just to answer this
 * question, per the ticket's no-new-Jira-call constraint. A delivery this
 * taxonomy cannot explain (every field identical but `updated`, or a class
 * whose only signal came from a Jira call the poll didn't already make —
 * e.g. a genuinely new comment nothing else touched) carries no `reason` at
 * all; the renderer says so honestly rather than guessing (see
 * change-nudge.ts's fallback text).
 */
export type NotifyReason =
  | { pr: { from: string | null; to: string } }
  | { appeared: true }
  | { disappeared: true }
  | { status: { from: string; to: string } }
  | { label: { prefix: "agent" | "pr"; from: string | null; to: string | null } }
  | { summary: true }
  | { comment: true };

export type EventVerdict = { deliver: false } | { deliver: true; reason?: NotifyReason };

/** One poll's opaque snapshot, exactly as the loop hands it to a resource type — nothing inside `T` is ever inspected by the loop itself. */
export interface PollSnapshot<T> {
  primary: readonly T[];
  related: readonly RelatedResource<T>[];
}

/**
 * A resource type's per-poll verdict, built by `EventRules.poll` from one
 * poll's opaque (prev, next) snapshots.
 */
export interface EventPoll {
  /** Ids of primary (assigned) resources that changed this poll — new, gone, or materially different, by this type's OWN definition of "changed". */
  changedPrimary: readonly string[];
  /** Ids of related resources that changed this poll, by the same definition. */
  changedRelated: readonly string[];
  /**
   * Decide whether/how to notify `watcher` about `key`'s change. `space`
   * says which snapshot `key` belongs to — a resource can in principle
   * appear in both (e.g. an implementer that is itself also directly
   * staffed) — and `watcher === key` (only meaningful when
   * `space === "primary"`, since a resource is only ever its OWN watcher
   * through the primary/self path) marks the resource's own agent, the only
   * case a type-specific override (e.g. a pr:* transition) may apply.
   * Consulted once per (key, watcher) pair the loop derives from
   * `changedPrimary`/`changedRelated` plus its own watcher bookkeeping.
   */
  decide(key: string, watcher: string, space: "primary" | "related"): Promise<EventVerdict>;
}

export interface EventRules<T> {
  /**
   * Start one poll's worth of event-rule decisions over this poll's opaque
   * (prev, next) snapshots. Called once per poll (the loop never calls it
   * more than once per snapshot pair); the returned `EventPoll` is then
   * consulted once per (key, watcher) pair it names.
   */
  poll(prev: PollSnapshot<T>, next: PollSnapshot<T>): Promise<EventPoll>;
}

export interface SpawnConfig<T> {
  /**
   * The SpawnSpec for `resource` — the one thing spawn config produces.
   * Everything downstream of it (model/effort/brief selection, workspace and
   * argv construction) stays the existing SHARED machinery
   * (src/agents/workspace.ts, src/agents/argv.ts), keyed off
   * `SpawnSpec.issuetype` exactly as today — a resource type's spawnConfig
   * never re-implements or forks that selection, only feeds it.
   */
  specFor(resource: T): SpawnSpec;
}

/** A resource type: exactly these four members, nothing else. */
export interface ResourceType<T> {
  discovery: Discovery<T>;
  activation: Activation<T>;
  eventRules: EventRules<T>;
  spawnConfig: SpawnConfig<T>;
}
