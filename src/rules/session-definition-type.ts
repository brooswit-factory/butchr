/**
 * BUTCHR-408 — the built-in managed-session query: a `Rule` butchr ships
 * itself (never read from `rules.json`, never user-editable), expressed as
 * an ordinary `filesystem` rule (BUTCHR-407) over the well-known
 * definitions directory (`sessionDefinitionsPath`, src/resources/session-definition.ts).
 * "Eligible = valid, not frozen" (the ticket's own words) is ONE filter
 * step in `searchSessionDefinitions`: a definition file that fails to parse
 * is skipped and logged (never staffed, never silently dropped — same
 * discipline as `onceOversized`, src/rules/filesystem-type.ts), and a
 * `frozen: true` definition is skipped and logged too, distinctly. Every
 * OTHER eligible definition gets exactly one agent — `swarm` execution,
 * the built-in rule's own fixed mode, one resource (one definition file) to
 * one agent, which is already "keeps exactly one agent per eligible
 * definition" (the ticket's DoD) with no singleton/persistent grouping
 * needed at the RULE level (a definition's OWN `execution` field is stored
 * or S1's reuse, not acted on by this query — see session-definition.ts's
 * own doc comment on that field).
 *
 * Deliberately its own module, not a fork of filesystem-type.ts: a
 * `FilesystemMatch` carries no file CONTENT (path/kind/name/size/mtimeMs
 * only — src/resources/filesystem.ts), but every definition file's manifest
 * is heterogeneous PER FILE (vendor, tier, working directory, ...) where a
 * `Rule`'s own fields are uniform per rule — so this type reads and
 * validates each matched file's content itself and builds a per-resource
 * `SpawnSpec` from it, something `specForFilesystem` structurally cannot do.
 */
import { readFile } from "node:fs/promises";
import type { JiraIssue } from "../atlassian/types.js";
import { decodeAnyAgentKey, encodeAgentKey } from "./agent-key.js";
import { diffMatches, groupExecutionUnits, resourceMatches, unitAgentKey, type ExecutionUnit } from "./execution.js";
import type { AccountPolicy, AgentEffort, AgentRole, Rule } from "./rules.js";
import type { SpawnSpec } from "../agents/workspace.js";
import { createLinkedEventingState, type LinkedEventingDeps, type ProjectLinkedEventingMatch } from "../jira-watch/linked-eventing.js";
import { isFilesystemResourceId, MAX_ENCODED_SEGMENT_BYTES } from "../resources/filesystem-ref.js";
import { parseFilesystemQuery, type FilesystemQuery } from "../resources/filesystem-query.js";
import { isMissingRootError, listFilesystemResources, type FilesystemResource } from "../resources/filesystem.js";
import { parseResourceRef } from "../resources/resource-ref.js";
import { isHiddenDefinitionFile, parseSessionDefinitionFile, effectiveAgent, type SessionDefinition } from "../resources/session-definition.js";
import type { EventPoll, EventRules, NotifyReason, PollSnapshot, RelatedResource, ResourceType } from "../resources/types.js";
import type { OversizedResource } from "./filesystem-type.js";
import { onceOversized } from "./filesystem-type.js";

/** The id butchr's own built-in rule always uses — reserved, never a valid user `rules.json` rule id can collide with intent here (it's a perfectly ordinary slug; the guarantee is that ONLY `builtinManagedSessionsRule` ever constructs a `Rule` carrying it inside the daemon). */
export const MANAGED_SESSIONS_RULE_ID = "managed-sessions";

/**
 * The built-in rule itself: `enabled`/`resourceProvider`/`query` make it an
 * ordinary `filesystem` rule (one file per direct child of `root`, no
 * recursion — a managed-session definition is never nested); `execution`/
 * `account`/`role` are fixed to their ordinary defaults (this RULE's own
 * capacity role — every managed-session AGENT's own `role`, from its own
 * manifest, is validated and stored but not yet wired into the fleet-cap
 * classifier, which is rule-level only; see docs/managed-sessions.md). Never
 * built from JSON / `parseRules` — constructed directly, so it needs no
 * `brief` a human ever reads (`specForSessionDefinition` always overrides it
 * per match from that match's own manifest).
 */
export function builtinManagedSessionsRule(root: string): Rule {
  return {
    id: MANAGED_SESSIONS_RULE_ID,
    enabled: true,
    resourceProvider: "filesystem",
    query: JSON.stringify({ root, kind: "file", maxDepth: 1 }),
    brief: "Built-in managed-session query (BUTCHR-408) — every matched definition supplies its own real brief.",
    execution: "swarm",
    account: "none",
    role: "worker",
  };
}

export interface SessionDefinitionMatch {
  agentKey: string;
  rule: Rule;
  resource: FilesystemResource;
  definition: SessionDefinition;
}

/** True for exactly the herd ids the managed-sessions built-in rule owns. */
export const ownsManagedSessionAgent = (id: string, ruleId: string = MANAGED_SESSIONS_RULE_ID): boolean => {
  const decoded = decodeAnyAgentKey(id);
  return decoded?.resourceProvider === "filesystem" && decoded.ruleId === ruleId;
};

/**
 * FACTORY-53/FACTORY-71 (epic FACTORY-51) — wires a managed-session
 * definition's `linkedEventingProjects` (src/resources/session-definition.ts)
 * into the SAME `jira-project` linked-eventing machinery
 * (`createLinkedEventingState`/`runTick`, src/jira-watch/linked-eventing.ts)
 * `createJiraProjectResourceType` already reuses for its own owners — never
 * a second watcher, never a separate rate cap (the ticket's own instruction).
 *
 * `MANAGED_SESSION_LINKED_EVENTING_RULE` is the one new seam this needed
 * INSIDE `runTick`: every `ProjectLinkedEventingMatch` is gated on
 * `m.rule.linkedEventing === true` (unchanged — see that gate's own doc
 * comment on why it was reused rather than generalised), but a managed
 * session has no `Rule` of its own to read that flag from. Naming a project
 * in `linkedEventingProjects` already IS the per-project opt-in, so this
 * fixed, shared, never-user-editable `Rule`-shaped value simply always
 * carries `linkedEventing: true` — there is no separate boolean to plumb
 * through, and every OTHER linked-eventing knob (`maxLinkedItems`,
 * `maxLinkedTurnsPerHour`, `linkedRemoteLinks`, `linkedDescriptionLinks`) is
 * left absent, the same "absent means uncapped/off" default an unconfigured
 * `jira-project` rule already has. `resourceProvider: "filesystem"` (rather
 * than "jira-project") is deliberate: this value never names a jira-project
 * RULE — it names the managed-sessions definition file that granted the
 * opt-in — but nothing reads its `resourceProvider`/`query` fields; they
 * exist only because `Rule` requires them.
 */
const MANAGED_SESSION_LINKED_EVENTING_RULE_ID = "managed-sessions-linked-eventing";
const MANAGED_SESSION_LINKED_EVENTING_RULE: Rule = {
  id: MANAGED_SESSION_LINKED_EVENTING_RULE_ID,
  enabled: true,
  resourceProvider: "filesystem",
  query: JSON.stringify({ root: "/", kind: "file", maxDepth: 0 }),
  brief: "Managed-session linked-eventing opt-in gate (FACTORY-53) — never a real rule; matches no resource of its own.",
  execution: "swarm",
  account: "none",
  role: "worker",
  linkedEventing: true,
};

/**
 * FACTORY-53/FACTORY-71: the STATE-OWNING key one (session, opted-in
 * project) pair uses inside `runTick`'s own `agentKey`-keyed maps — see
 * `ProjectLinkedEventingMatch.notifyAgentKey`'s own doc comment for why this
 * must differ from `sessionAgentKey` whenever a session names more than one
 * project (otherwise the second project's per-tick state would silently
 * overwrite the first's). `"\0"` (NUL) is the separator: every real agent
 * key already forbids a NUL byte (see e.g. `controllerListProblems`,
 * src/resources/session-definition.ts), so this can never collide with a
 * real agent key, and this string is never decoded — it is opaque, used only
 * as an internal Map key inside `createLinkedEventingState`.
 */
const managedSessionProjectWatchKey = (sessionAgentKey: string, projectRef: string): string => `${sessionAgentKey}\0linked:${projectRef}`;

/**
 * One eligible, opted-in definition's own `ProjectLinkedEventingMatch[]` —
 * one per entry in its `linkedEventingProjects` (already validated,
 * canonical `jira-project:<KEY>` refs — see `linkedEventingProjectsProblems`,
 * src/resources/session-definition.ts), `[]` for a definition that names
 * none (today's behaviour exactly: no extra state, no extra search — see
 * `runTick`'s own `if (!opted.length && !projectOpted.length) return;`).
 * Exported and kept pure (no I/O, no `isFrozen` check) so it is unit-testable
 * on its own, mirroring the existing BUTCHR-469 test style of asserting
 * directly against hand-built `ProjectLinkedEventingMatch` values rather
 * than only through the full resource-type wiring.
 */
export function sessionDefinitionProjectMatches(m: SessionDefinitionMatch): ProjectLinkedEventingMatch[] {
  const refs = m.definition.linkedEventingProjects;
  if (!refs?.length) return [];
  return refs.map((ref) => {
    const parsed = parseResourceRef(ref);
    // Unreachable in practice: `parseSessionDefinition` already validated
    // every entry is a `jira-project` reference at manifest-load time (see
    // `linkedEventingProjectsProblems`) — defensive, not a real branch.
    const projectKey = parsed.provider === "jira-project" ? parsed.key : ref;
    return {
      agentKey: managedSessionProjectWatchKey(m.agentKey, ref),
      rule: MANAGED_SESSION_LINKED_EVENTING_RULE,
      projectKey,
      notifyAgentKey: m.agentKey,
    };
  });
}

/** Told about a definition file that failed to parse/validate (`error` is the joined problem list) — never crashes the poll; see this module's own top comment. */
export type InvalidDefinition = (path: string, error: string) => void;
/** Told about a definition file that parsed fine but is `frozen: true` — excluded from the eligible set, distinctly from an invalid one. */
export type FrozenDefinition = (path: string) => void;

/** Logs an invalid definition once per (path, error) — a NEW problem on the same path (an edit that trades one validation error for another) logs again; the same problem persisting across polls does not spam. Mirrors `onceOversized`'s own dedup shape. */
export function onceInvalidDefinition(log: ((line: string) => void) | undefined): InvalidDefinition {
  const logged = new Set<string>();
  return (path, error) => {
    const id = `${path}\n${error}`;
    if (logged.has(id)) return;
    logged.add(id);
    log?.(`WARNING: [managed-sessions] ${path} is not a valid definition, never staffed: ${error}`);
  };
}

/** Logs a frozen definition once per path — never respammed while it stays frozen. */
export function onceFrozenDefinition(log: ((line: string) => void) | undefined): FrozenDefinition {
  const logged = new Set<string>();
  return (path) => {
    if (logged.has(path)) return;
    logged.add(path);
    log?.(`[managed-sessions] ${path} is frozen — no agent runs`);
  };
}

/** Told about a definition still using the deprecated `tier` field, distinctly from an invalid or frozen one — logged, never rejected (see `SessionDefinition.tier`'s own doc comment, src/resources/session-definition.ts). */
export type DeprecatedTierDefinition = (path: string) => void;

/** Logs a deprecated-`tier` definition once per path — never respammed while it keeps using `tier`. Same dedup shape as `onceFrozenDefinition`. */
export function onceDeprecatedTier(log: ((line: string) => void) | undefined): DeprecatedTierDefinition {
  const logged = new Set<string>();
  return (path) => {
    if (logged.has(path)) return;
    logged.add(path);
    log?.(`[managed-sessions] ${path} uses deprecated "tier" — migrate to "modelPower"/"effort" (docs/power-scale.md)`);
  };
}

export interface SessionDefinitionSearchDeps {
  rule: Rule;
  /** Every filesystem resource the built-in query's root currently lists (src/resources/filesystem.ts, injectable for tests). */
  list: (query: FilesystemQuery) => Promise<FilesystemResource[]>;
  /** Reads one definition file's raw text; injectable so tests use an in-memory map, never real disk. */
  read: (path: string) => Promise<string>;
}

/** Told once that the well-known definitions directory does not exist yet — NOT an error (see `searchSessionDefinitions`'s own doc comment), just an operator FYI. */
export type MissingRoot = () => void;

/** Logs the missing-root FYI once, never respammed while it stays missing — same dedup shape as `onceFrozenDefinition`. */
export function onceMissingRoot(log: ((line: string) => void) | undefined): MissingRoot {
  let logged = false;
  return () => {
    if (logged) return;
    logged = true;
    log?.(`[managed-sessions] definitions directory does not exist yet — 0 definitions, not an error`);
  };
}

/**
 * Every eligible (valid, not frozen) definition this poll — the ONE place
 * "eligible" is decided. A missing well-known directory is 0 definitions,
 * NEVER a poll error (PR #394 review fix 3): most daemons simply have no
 * managed-session definitions directory at all, the same "absent means
 * empty, not broken" discipline `sessionDefinitionsPath`'s own doc comment
 * already promises for it — before this fix, EVERY daemon without one
 * logged a loop error and failed /health every poll. `isMissingRootError`
 * (src/resources/filesystem.ts) is what tells "does not exist" (`ENOENT`)
 * apart from "exists but is unreadable, or is not a directory" (anything
 * else) — the latter (and every OTHER listing failure: a safety cap, see
 * `listFilesystemResources`) still rejects the WHOLE poll, same "a partial
 * result must never read as a smaller true set" doctrine every provider's
 * own search function already follows. An individual file's OWN parse
 * failure costs only that one file (skipped, logged), never the others —
 * same distinction PR #388 review drew for an oversized path.
 */
export async function searchSessionDefinitions(
  deps: SessionDefinitionSearchDeps,
  onOversized?: OversizedResource,
  onInvalid?: InvalidDefinition,
  onFrozen?: FrozenDefinition,
  onMissingRoot?: MissingRoot,
  onDeprecatedTier?: DeprecatedTierDefinition,
): Promise<SessionDefinitionMatch[]> {
  const query = parseFilesystemQuery(deps.rule.query);
  let resources: FilesystemResource[];
  try {
    resources = await deps.list(query);
  } catch (e) {
    if (isMissingRootError(e)) { onMissingRoot?.(); return []; }
    throw e;
  }
  const seen = new Set<string>();
  const out: SessionDefinitionMatch[] = [];
  for (const resource of resources) {
    if (seen.has(resource.path)) continue;
    seen.add(resource.path);
    if (isHiddenDefinitionFile(resource.name)) continue; // BUTCHR-455 review fix: never a candidate, never logged — see isHiddenDefinitionFile's own doc comment.
    if (!isFilesystemResourceId(resource.path)) { onOversized?.(deps.rule, resource.path); continue; }
    let definition: SessionDefinition;
    try {
      definition = parseSessionDefinitionFile(await deps.read(resource.path), resource.path);
    } catch (e) {
      onInvalid?.(resource.path, (e as Error)?.message ?? String(e));
      continue;
    }
    if (definition.frozen) { onFrozen?.(resource.path); continue; }
    if (definition.tier !== undefined) onDeprecatedTier?.(resource.path);
    out.push({
      agentKey: encodeAgentKey({ resourceProvider: "filesystem", ruleId: deps.rule.id, resourceId: resource.path }),
      rule: deps.rule, resource, definition,
    });
  }
  return out;
}

/**
 * The SpawnSpec for one eligible definition. `cwd`/`permissionMode`
 * (src/agents/workspace.ts, BUTCHR-408) are the two seams this ticket adds
 * to the shared spawn machinery: `cwd` carries the definition's own
 * `workingDirectory` through to the agent's own kickoff instructions — NOT
 * the launched process's OS cwd, which stays the ordinary bookkeeping
 * directory (see that field's own doc comment for why a literal process-cwd
 * override broke Drovr's spawn invariants) — and `permissionMode` carries
 * the definition's permission mode straight to a Claude launch (Codex has
 * no such field — see that field's own doc comment). `agents` names
 * exactly one preference (the definition's own vendor/tier) — `spec.agents`,
 * not `rule.agentPreferences`, is what makes this heterogeneous per file
 * despite one shared `Rule`.
 */
export function specForSessionDefinition({ agentKey, resource, definition }: SessionDefinitionMatch): SpawnSpec {
  return {
    key: agentKey,
    resource: resource.path,
    issuetype: "managed-session",
    summary: `managed session (${definition.vendor}, ${definition.tier}) — ${resource.name}`,
    parent: null,
    brief: definition.brief,
    agents: [{ harness: definition.vendor, ...effectiveAgent(definition) }],
    cwd: definition.workingDirectory,
    permissionMode: definition.permissionMode,
    ...(definition.strictMcpConfig !== undefined ? { strictMcpConfig: definition.strictMcpConfig } : {}),
    ...(definition.mcpServers ? { mcpServers: definition.mcpServers } : {}),
  };
}

export const specForSessionDefinitionUnit = (u: ExecutionUnit<SessionDefinitionMatch>): SpawnSpec => {
  if (u.kind === "resource") return specForSessionDefinition(u.match);
  // Never reached: builtinManagedSessionsRule always fixes execution to "swarm", so groupExecutionUnits
  // (src/rules/execution.ts) never produces a "query" unit for it — see this module's own top comment.
  throw new Error(`managed-sessions rule "${u.rule.id}" must always run swarm execution`);
};

/** What "changed" means for one already-matched definition, independent of appear/disappear (spawn/stop already say that — same precedent as `filesystem-type.ts`'s own PRIMARY diff): its underlying file's kind/size/mtime moved. */
const observed = (m: SessionDefinitionMatch): string => JSON.stringify([m.resource.size, m.resource.mtimeMs]);

export function createSessionDefinitionEventRules(): EventRules<ExecutionUnit<SessionDefinitionMatch>> {
  return {
    async poll(prev: PollSnapshot<ExecutionUnit<SessionDefinitionMatch>>, next: PollSnapshot<ExecutionUnit<SessionDefinitionMatch>>): Promise<EventPoll> {
      const primaryDiff = diffMatches(resourceMatches(prev.primary), resourceMatches(next.primary), observed);
      return {
        changedPrimary: primaryDiff.changed,
        changedRelated: [],
        async decide(key, watcher, space) {
          if (space !== "primary") return { deliver: false };
          const pair = primaryDiff.pairFor(key);
          return watcher === key && pair ? { deliver: true } : { deliver: false };
        },
      };
    },
  };
}

export interface ManagedSessionResourceDeps extends SessionDefinitionSearchDeps {
  log?: (line: string) => void;
  /**
   * PR #394 review fix: an agent's own manifest `role` was validated and
   * stored but never reached the fleet-capacity admission classifier
   * (`roleOfAgent`, src/daemon/index.ts) — every managed-session agent was
   * classified "worker" regardless of what its definition said, so a
   * `role: "sentinel"` definition (every Bakr/Candlestix definition in the
   * S5 mapping) was still capped and counted against the fleet limit.
   * When given, cleared and rebuilt every poll from THIS poll's eligible
   * matches, keyed identically to `discovery.idOf` — the daemon passes the
   * SAME map instance into `roleOfAgent`, which consults it for a
   * `managed-sessions` id before falling back to the (fixed, always
   * `"worker"`) built-in rule's own role. Deliberately rebuilt, never
   * merged, so a definition that goes ineligible (removed, edited invalid,
   * frozen) stops being sentinel-exempt on the SAME poll it drops out,
   * never lingering stale. Before this loop's first poll completes (e.g.
   * right after a daemon restart, before an already-running managed-session
   * agent's OWN definition has been read again), the map has no entry for
   * it yet, and `roleOfAgent` falls back to `"worker"` — the same
   * fail-safe default it already documents for "cannot be resolved".
   */
  roles?: Map<string, AgentRole>;
  /**
   * BUTCHR-460 — same seam as `roles` immediately above, one field over:
   * `accountPolicyOf` (src/daemon/index.ts) is RULE-level only, same reason
   * `roleOfAgent` was before BUTCHR-408's `roles` map — the built-in
   * managed-sessions rule is ONE shared `Rule` (fixed `account: "none"`) for
   * every heterogeneous definition file, so a per-file `account` policy
   * needs this same rebuilt-every-poll map, keyed identically. Before this
   * loop's first poll completes, an already-running managed-session agent
   * has no entry yet and `accountPolicyOf` falls back to its own existing
   * fail-safe `"none"` default — same brief, documented window `roles` has.
   */
  accountPolicies?: Map<string, AccountPolicy>;
  /**
   * FACTORY-75 — same rebuilt-every-poll seam as `roles`/`accountPolicies`
   * above, one field over: this poll's eligible definitions' resolved
   * `(model, effort)` pair (`effectiveAgent`, src/resources/session-definition.ts),
   * keyed identically. `HerdrHerd.staleIssues()`'s own `resolvedAgentOf`
   * seam (src/agents/herd.ts) consults this map for a managed-session id
   * to learn what the definition CURRENTLY resolves to — as opposed to
   * `workspaceModel`/`workspaceEffort` (src/agents/workspace.ts), which
   * read what a workspace was ACTUALLY spawned with — so an edit to a
   * definition's `modelPower`/`effort`/`tier` (or a table edit shipped in a
   * new daemon build) is exactly the mismatch that seam is built to catch.
   * Before this loop's first poll completes, an already-running
   * managed-session agent has no entry yet — `resolvedAgentOf` falls back
   * to treating it as unresolvable, i.e. no comparison, no false positive.
   */
  resolvedAgents?: Map<string, { model: string; effort?: AgentEffort }>;
  /**
   * DROVR-42/FACTORY-67 — same rebuilt-every-poll seam as `roles`/
   * `accountPolicies` immediately above, one field over: whether an eligible
   * definition opted into "lizard mode" (`SessionDefinition.lizardMode`).
   * The permission-answer timer (`src/agents/permission-answer-loop.ts`,
   * wired in `src/daemon/index.ts`) consults this map every tick to decide
   * which panes it may scan/answer at all — a definition absent from this
   * map (not yet observed this daemon's lifetime, or simply never setting
   * the field) is never touched, matching `lizardMode`'s own "absent means
   * today's behaviour exactly" contract. Deliberately live, not
   * persisted-at-spawn like `permissionMode`/`strictMcpConfig` (FACTORY-43)
   * — this field never reaches the launched process's argv, so there is
   * nothing for a stale-argv check to compare and no respawn-loop risk to
   * guard against; toggling it in the manifest takes effect on this loop's
   * very next poll, live, with no agent restart. Optional; omitted, no
   * lizard-mode information is surfaced (today's behaviour — every caller
   * before this ticket, and any direct call that does not opt in).
   */
  lizardModes?: Map<string, boolean>;
  /**
   * FACTORY-53/FACTORY-71 — the SAME `(jql) => Promise<JiraIssue[]>` seam
   * `CreateJiraProjectResourceTypeDeps.searchIssues` (src/rules/jira-project-type.ts)
   * already uses for linked-eventing's member-discovery watch and its shared
   * batched Jira-kind fetch. Optional; omitted (or `notify` below omitted),
   * linked-eventing never runs for managed-session agents — the same
   * "omitted dep ⇒ feature silently never runs" shape `jira-project`'s own
   * wiring already has, so every existing caller/test that doesn't wire this
   * is completely unaffected.
   */
  searchIssues?: (jql: string) => Promise<JiraIssue[]>;
  /** FACTORY-53/FACTORY-71 — delivers one poll tick's coalesced linked-change nudge; the SAME seam `CreateJiraProjectResourceTypeDeps.notify` already is. Both this AND `searchIssues` must be present for a linked-eventing tick to ever run (see `discovery.related` below). */
  notify?: (agentKey: string, about: string, reason: NotifyReason) => void | Promise<void>;
  /** FACTORY-53/FACTORY-71 — per-target comment-cursor support for a project's member/managed-link Jira targets, the SAME `LinkedEventingDeps.comments` shape. Optional; omitted, no comment event is ever detected. */
  comments?: LinkedEventingDeps["comments"];
  /** FACTORY-53/FACTORY-71 — the FACTORY-4/FACTORY-8 managed-link store, routed (`createRoutingLinkStore`) exactly as `CreateJiraProjectResourceTypeDeps.linkStore` already is, so a `jira-project:<KEY>` owner ref reaches the SAME `brooswit.butchr.links` project-property store a `jira-project` rule's own agent would. Optional; omitted, no managed link is ever reconciled into a session's watch. */
  linkStore?: LinkedEventingDeps["linkStore"];
  /**
   * FACTORY-53/FACTORY-71 — the SAME herd/store-level freeze check
   * `CreateJiraProjectResourceTypeDeps.isFrozen` already is (`herd.frozen`,
   * keyed by real agent id — see `session-freeze.ts`'s own
   * `instanceFreezeStore`), consulted in `discovery.related` below to
   * exclude an opted-in but currently-frozen session from even BUILDING a
   * `ProjectLinkedEventingMatch` this poll — belt-and-suspenders on top of
   * `herd.nudge`'s own `assertRunnable` freeze check, which already refuses
   * to deliver to a frozen agent regardless (the ONLY freeze enforcement
   * `jira-project`'s own owners get today; see that check's own doc comment
   * for why relying on it alone is already sufficient for correctness, but
   * checking `isFrozen` here too avoids doing a member-discovery search and
   * building state for an agent that cannot be nudged either way). Optional;
   * omitted, this extra check simply never runs (delivery is still refused
   * centrally by `herd.nudge`).
   */
  isFrozen?: (id: string) => Promise<boolean>;
  /** Injectable clock, for deterministic tests — threaded straight through to `LinkedEventingDeps.now`. */
  now?: () => number;
}

export function createManagedSessionResourceType(deps: ManagedSessionResourceDeps): ResourceType<ExecutionUnit<SessionDefinitionMatch>> {
  const onOversized = onceOversized(deps.log);
  const onInvalid = onceInvalidDefinition(deps.log);
  const onFrozen = onceFrozenDefinition(deps.log);
  const onMissingRoot = onceMissingRoot(deps.log);
  const onDeprecatedTier = onceDeprecatedTier(deps.log);
  // FACTORY-53/FACTORY-71: this poll's own matches, read by `related` below
  // — mirrors `createJiraProjectResourceType`'s own `let latest`
  // (src/rules/jira-project-type.ts).
  let latest: SessionDefinitionMatch[] = [];
  const linkedEventingState = createLinkedEventingState();
  return {
    discovery: {
      idOf: unitAgentKey,
      search: async () => {
        const matches = await searchSessionDefinitions(deps, onOversized, onInvalid, onFrozen, onMissingRoot, onDeprecatedTier);
        if (deps.roles) {
          deps.roles.clear();
          for (const m of matches) deps.roles.set(m.agentKey, m.definition.role);
        }
        if (deps.accountPolicies) {
          deps.accountPolicies.clear();
          for (const m of matches) deps.accountPolicies.set(m.agentKey, m.definition.account);
        }
        if (deps.resolvedAgents) {
          deps.resolvedAgents.clear();
          for (const m of matches) deps.resolvedAgents.set(m.agentKey, effectiveAgent(m.definition));
        }
        latest = matches;
        if (deps.lizardModes) {
          deps.lizardModes.clear();
          for (const m of matches) deps.lizardModes.set(m.agentKey, m.definition.lizardMode ?? false);
        }
        return groupExecutionUnits([deps.rule], matches);
      },
      // FACTORY-53/FACTORY-71: linked-change eventing for managed-session
      // agents that opt in via `linkedEventingProjects` — mirrors
      // `createJiraProjectResourceType`'s own `related` (src/rules/jira-project-type.ts)
      // almost verbatim; see this function's own deps doc comments for what
      // each seam is. Only runs when BOTH `deps.notify` and
      // `deps.searchIssues` are wired; either omitted, no tick ever runs
      // (every existing caller/test that wires neither is unaffected).
      related: async () => {
        if (deps.notify && deps.searchIssues) {
          const notify = deps.notify;
          const searchIssues = deps.searchIssues;
          const projectMatches: ProjectLinkedEventingMatch[] = [];
          for (const m of latest) {
            if (!m.definition.linkedEventingProjects?.length) continue;
            if (await deps.isFrozen?.(m.agentKey)) continue; // see `isFrozen`'s own doc comment — belt-and-suspenders, herd.nudge refuses delivery either way
            projectMatches.push(...sessionDefinitionProjectMatches(m));
          }
          try {
            await linkedEventingState.runTick([], {
              search: searchIssues,
              notify,
              ...(deps.log ? { log: deps.log } : {}),
              ...(deps.now ? { now: deps.now } : {}),
              ...(deps.linkStore ? { linkStore: deps.linkStore } : {}),
              ...(deps.comments ? { comments: deps.comments } : {}),
            }, projectMatches);
          } catch (e) {
            deps.log?.(`  WARNING: [linked-eventing] managed-session project tick threw: ${(e as Error)?.message ?? e}`);
          }
        }
        return [] as RelatedResource<ExecutionUnit<SessionDefinitionMatch>>[];
      },
    },
    activation: { verdictFor: () => "active" },
    eventRules: createSessionDefinitionEventRules(),
    spawnConfig: { specFor: specForSessionDefinitionUnit },
  };
}

/** The real read function `createManagedSessionResourceType` uses outside tests. */
export const readDefinitionFile = (path: string): Promise<string> => readFile(path, "utf8");

export { listFilesystemResources, MAX_ENCODED_SEGMENT_BYTES };
