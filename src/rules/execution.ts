/**
 * BUTCHR-398 — the shared, provider-neutral half of `execution` mode
 * reconciliation: turning a provider's flat per-resource matches (what
 * `search*Rules` in each `*-type.ts` already produces, for EVERY execution
 * mode — this module does not change that) into the PRIMARY items a
 * `ResourceType.discovery.search()` actually reports, and the RELATED
 * entries that deliver scope-wide events to a `singleton`/`persistent`
 * rule's one query-level agent.
 *
 * The identity this builds on is Task 1's (BUTCHR-397,
 * `encodeQueryAgentKey`/`decodeAnyAgentKey`, src/rules/agent-key.ts) — see
 * docs/execution-modes.md for the full codec/workspace-layout story. This
 * module is the reconciliation half that identity was built for.
 *
 * DESIGN: a `singleton`/`persistent` rule's query-level agent is NEVER
 * itself a diffable "primary" item — it has no single resource to diff. Its
 * scope (every resource its query currently matches) is instead expressed as
 * a RELATED entry per matched resource, watcher = the query agent's own key,
 * reusing exactly the same per-provider event-rules diff logic (status,
 * comments, …) every provider already runs for its swarm agents. This is why
 * `groupExecutionUnits` and `scopeRelated` below are two independent, pure
 * functions rather than one: the PRIMARY/RELATED split IS the mechanism —
 * `runResourceLoop` (src/daemon/loop.ts) already knows how to reconcile a
 * primary item (spawn/stop/respawn) and deliver a related change to its
 * watcher(s) (dedup via its own `sent` set, own-write echo suppression via
 * `deps.suppress`), so nothing in the generic loop needs to change at all.
 */
import { encodeQueryAgentKey, type ResourceProvider } from "./agent-key.js";
import type { Rule } from "./rules.js";
import type { RelatedResource } from "../resources/types.js";

/** The minimal shape every provider's own per-resource match already has. */
export interface AgentMatch {
  agentKey: string;
  rule: Rule;
}

/**
 * A `ResourceType.discovery.search()` PRIMARY item, generic over a provider's
 * own per-resource match shape `M`: either one matched resource (`swarm`,
 * unchanged from before this ticket — same `M`, same agent key) or the ONE
 * marker for a `singleton`/`persistent` rule's query-level agent (no single
 * resource, hence no `M`).
 */
export type ExecutionUnit<M extends AgentMatch> =
  | { kind: "resource"; match: M }
  | { kind: "query"; agentKey: string; rule: Rule };

/** `ExecutionUnit.agentKey` regardless of kind — the one thing `discovery.idOf` ever needs. */
export const unitAgentKey = <M extends AgentMatch>(u: ExecutionUnit<M>): string => (u.kind === "resource" ? u.match.agentKey : u.agentKey);

/** The `"resource"`-kind units' own matches, in order — what a provider's swarm-only event-rules diff (unchanged from before this ticket) actually runs over. A `"query"` unit carries no diffable resource, so it is simply absent here, never a crash or a placeholder. */
export const resourceMatches = <M extends AgentMatch>(units: readonly ExecutionUnit<M>[]): M[] => units.filter((u): u is { kind: "resource"; match: M } => u.kind === "resource").map((u) => u.match);

/**
 * A (prev, next) diff over a flat `M[]` (a provider's own per-resource match
 * shape), keyed by `agentKey` — the one comparison every simple (non-Jira-
 * suppression-stack) provider's event rules already perform, for its PRIMARY
 * set today and, as of this ticket, for a `singleton`/`persistent` rule's
 * RELATED (scope) set too: same comparison, same `observed()` projection,
 * only the input list differs. `observed` is the provider's own "which
 * fields matter" projection (e.g. a JSON tuple of title/state/…) — this
 * function does not interpret it, only compares it for equality.
 */
export interface MatchDiff<M> {
  /** Agent keys whose `observed(from) !== observed(to)` this poll. */
  changed: readonly string[];
  /** The (from, to) pair for a changed key, or `undefined` for anything unchanged/unseen. */
  pairFor(agentKey: string): { from: M; to: M } | undefined;
}

export function diffMatches<M extends AgentMatch>(prev: readonly M[], next: readonly M[], observed: (m: M) => string): MatchDiff<M> {
  const before = new Map(prev.map((m) => [m.agentKey, m]));
  const pairs = new Map<string, { from: M; to: M }>();
  for (const m of next) {
    const from = before.get(m.agentKey);
    if (from && observed(from) !== observed(m)) pairs.set(m.agentKey, { from, to: m });
  }
  return { changed: [...pairs.keys()], pairFor: (key) => pairs.get(key) };
}

/**
 * Groups `matches` (every enabled rule's current per-resource matches, for
 * EVERY execution mode — exactly what `search*Rules` already returns, byte
 * for byte, unmodified by this function) into this poll's PRIMARY items:
 *
 * - `swarm` (default): each match becomes its own `"resource"` unit — BYTE-
 *   FOR-BYTE today's behaviour (same agent keys, same count, same order
 *   modulo the caller's own sort), since this is a pure relabelling of the
 *   exact same matches with no filtering or merging.
 * - `singleton`: one `"query"` unit when the rule has >= 1 match this poll,
 *   none when it has zero — mirroring exactly how a swarm resource's own
 *   unit disappears the moment it leaves the query (no special "stop" path
 *   needed; `planReconcile`'s ordinary `running - desired` already covers
 *   it).
 * - `persistent`: one `"query"` unit always, even at zero matches — the one
 *   difference from `singleton`. An explicit freeze (`rule.enabled: false`)
 *   still stops it, for a reason that needs no special case here either:
 *   `allEnabledRules` already excludes a disabled rule, so it produces no
 *   unit at all the moment it is disabled, the same way any other rule's
 *   agents disappear.
 *
 * `allEnabledRules` (not merely the rules `matches` happens to mention) is
 * required so a `persistent` rule with a zero-match poll — which contributes
 * NOTHING to `matches` — still gets its query unit: this function cannot
 * discover that rule any other way.
 */
export function groupExecutionUnits<M extends AgentMatch>(allEnabledRules: readonly Rule[], matches: readonly M[]): ExecutionUnit<M>[] {
  const byRule = new Map<string, M[]>();
  for (const m of matches) {
    const list = byRule.get(m.rule.id);
    if (list) list.push(m);
    else byRule.set(m.rule.id, [m]);
  }
  const out: ExecutionUnit<M>[] = [];
  for (const rule of allEnabledRules) {
    const mine = byRule.get(rule.id) ?? [];
    if (rule.execution === "swarm") {
      for (const m of mine) out.push({ kind: "resource", match: m });
    } else if (rule.execution === "persistent" || mine.length > 0) {
      out.push({ kind: "query", agentKey: encodeQueryAgentKey({ resourceProvider: rule.resourceProvider, ruleId: rule.id }), rule });
    }
  }
  return out;
}

/** One resource watched by its owning `singleton`/`persistent` rule's query agent — see `scopeRelated`. */
export interface ScopeRelatedEntry<M extends AgentMatch> {
  match: M;
  /** Always exactly one watcher: that resource's own rule's query agent key. A caller merging this with another related source unions watcher sets per resource, same as `relatedForRules` (src/rules/resource-type.ts) already does for the Implements/Relates chain. */
  watcher: string;
}

/**
 * The scope-ownership related set: every `singleton`/`persistent` rule's
 * CURRENTLY matched resources, each watched by that rule's own query agent
 * key — the mechanism that delivers "the relevant events across the query's
 * scope" (creates, status changes, comments where the adapter supports them)
 * to the ONE query-level agent, by routing them through the exact same
 * related-watcher delivery `runResourceLoop` already has (dedup, own-write
 * echo suppression, per-provider event rules) rather than a second
 * mechanism. A `swarm` rule's matches are excluded: its own agents ARE the
 * primary items that hear their own changes directly — they need no watcher
 * relationship to themselves.
 *
 * "A resource entering the query" (BUTCHR-398's DoD "creates") is not a
 * special case here either: a resource that only just started matching
 * simply has no `before` entry when the provider's own event rules diff this
 * related set's (prev, next) pair, which every existing event-rules
 * implementation already reports as `{ appeared: true }` — the same
 * mechanism a boss already gets for a freshly-Implements-linked ticket.
 */
export function scopeRelated<M extends AgentMatch>(matches: readonly M[]): ScopeRelatedEntry<M>[] {
  const out: ScopeRelatedEntry<M>[] = [];
  for (const m of matches) {
    if (m.rule.execution === "swarm") continue;
    out.push({ match: m, watcher: encodeQueryAgentKey({ resourceProvider: m.rule.resourceProvider, ruleId: m.rule.id }) });
  }
  return out;
}

/**
 * `scopeRelated`'s entries, ALREADY `"resource"`-kind `ExecutionUnit`-wrapped
 * — the shape every provider's `discovery.related` actually returns (`T` is
 * `ExecutionUnit<M>` there, never bare `M` — see `groupExecutionUnits`'s own
 * doc comment for why PRIMARY needs the same wrapping). One entry per
 * watched resource, one watcher (its owning rule's query agent).
 */
export function scopeRelatedResources<M extends AgentMatch>(matches: readonly M[]): RelatedResource<ExecutionUnit<M>>[] {
  return scopeRelated(matches).map(({ match, watcher }) => ({ issue: { kind: "resource" as const, match }, watchers: [watcher] }));
}

/**
 * Unions two `RelatedResource<M>` lists that key their entries by the SAME
 * id (`idOf`, e.g. a Jira issue key) into one — a resource named by both
 * sources (e.g. a ticket both scoped into a `singleton` rule's own query AND
 * linked to a boss via `Implements`) is watched by the UNION of both
 * sources' watchers, never just one arbitrarily picked. Mirrors the
 * watcher-merge `relatedForRules` (src/rules/resource-type.ts) already does
 * internally for the Implements/Relates chain — this is the same operation,
 * generalized so a second, independent related source (scope-ownership) can
 * be combined with it without either implementation knowing about the
 * other.
 */
export function mergeRelated<M>(idOf: (m: M) => string, ...sources: readonly (readonly RelatedResource<M>[])[]): RelatedResource<M>[] {
  const out = new Map<string, { issue: M; watchers: Set<string> }>();
  for (const list of sources) {
    for (const entry of list) {
      const id = idOf(entry.issue);
      const e = out.get(id);
      if (!e) out.set(id, { issue: entry.issue, watchers: new Set(entry.watchers) });
      else for (const w of entry.watchers) e.watchers.add(w);
    }
  }
  return [...out.values()].map((e) => ({ issue: e.issue, watchers: [...e.watchers].sort() }));
}

/**
 * BUTCHR-370-class rename-safety, applied to a rule's own `execution` field:
 * a running agent's SHAPE (per-resource key vs. query-level key) must match
 * its rule's CURRENT `execution` mode, or reconciliation is about to retire
 * one agent and spawn a replacement of the other shape this very poll — a
 * deliberate, desired-set-driven transition (never a bug), but one that must
 * be LOUD, not a silent line buried in ordinary spawn/stop churn.
 *
 * `runningForProvider` is this provider's OWN running ids (already scoped —
 * a caller passes `herd.runningIssues()` filtered by its own `ownsXAgent`),
 * `rules` is every rule (enabled or not: a rule DISABLED this poll — the
 * other freeze path — produces no unit at all, which is its own, equally
 * loud story `planReconcile`'s ordinary stop already tells; this function's
 * job is only the swarm<->singleton/persistent axis). Returns nothing and
 * changes nothing — same "observe and speak, never gate" contract as
 * `ReconcileOptions.checkCrashLoop`/`checkPinnedActive` (src/daemon/loop.ts)
 * — logging IS the deliverable.
 */
export function logExecutionModeSwitches(
  provider: ResourceProvider,
  rules: readonly Rule[],
  runningForProvider: readonly string[],
  decodeAny: (id: string) => { kind: "resource" | "query"; ruleId: string } | null,
  log: ((line: string) => void) | undefined,
): void {
  if (!log) return;
  const byId = new Map(rules.map((r) => [r.id, r]));
  for (const id of runningForProvider) {
    const decoded = decodeAny(id);
    if (!decoded) continue;
    const rule = byId.get(decoded.ruleId);
    if (!rule) continue; // a removed rule id is its own, separately-logged story (legacy/unowned handling) — not a mode switch
    if (decoded.kind === "resource" && rule.execution !== "swarm") {
      log(`WARNING: [execution-mode] ${provider} rule "${rule.id}" switched away from swarm to "${rule.execution}" — per-resource agent ${id} is no longer desired and will be stopped this poll (not respawned); a single query-level agent will run in its place`);
    } else if (decoded.kind === "query" && rule.execution === "swarm") {
      log(`WARNING: [execution-mode] ${provider} rule "${rule.id}" switched to swarm — query-level agent ${id} is no longer desired and will be stopped this poll; a per-resource agent will spawn for each currently matching resource instead`);
    }
  }
}
