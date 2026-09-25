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
import { decodeAnyAgentKey, encodeAgentKey } from "./agent-key.js";
import { diffMatches, groupExecutionUnits, resourceMatches, unitAgentKey, type ExecutionUnit } from "./execution.js";
import type { Rule } from "./rules.js";
import type { SpawnSpec } from "../agents/workspace.js";
import { isFilesystemResourceId, MAX_ENCODED_SEGMENT_BYTES } from "../resources/filesystem-ref.js";
import { parseFilesystemQuery, type FilesystemQuery } from "../resources/filesystem-query.js";
import { listFilesystemResources, type FilesystemResource } from "../resources/filesystem.js";
import { parseSessionDefinitionFile, tierToModel, type SessionDefinition } from "../resources/session-definition.js";
import type { EventPoll, EventRules, PollSnapshot, ResourceType } from "../resources/types.js";
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

export interface SessionDefinitionSearchDeps {
  rule: Rule;
  /** Every filesystem resource the built-in query's root currently lists (src/resources/filesystem.ts, injectable for tests). */
  list: (query: FilesystemQuery) => Promise<FilesystemResource[]>;
  /** Reads one definition file's raw text; injectable so tests use an in-memory map, never real disk. */
  read: (path: string) => Promise<string>;
}

/**
 * Every eligible (valid, not frozen) definition this poll — the ONE place
 * "eligible" is decided. ANY listing failure (a missing root, a safety cap —
 * see `listFilesystemResources`) rejects the WHOLE poll, same "a partial
 * result must never read as a smaller true set" doctrine every provider's
 * own search function already follows; an individual file's OWN parse
 * failure costs only that one file (skipped, logged), never the others —
 * same distinction PR #388 review drew for an oversized path.
 */
export async function searchSessionDefinitions(
  deps: SessionDefinitionSearchDeps,
  onOversized?: OversizedResource,
  onInvalid?: InvalidDefinition,
  onFrozen?: FrozenDefinition,
): Promise<SessionDefinitionMatch[]> {
  const query = parseFilesystemQuery(deps.rule.query);
  const seen = new Set<string>();
  const out: SessionDefinitionMatch[] = [];
  for (const resource of await deps.list(query)) {
    if (seen.has(resource.path)) continue;
    seen.add(resource.path);
    if (!isFilesystemResourceId(resource.path)) { onOversized?.(deps.rule, resource.path); continue; }
    let definition: SessionDefinition;
    try {
      definition = parseSessionDefinitionFile(await deps.read(resource.path), resource.path);
    } catch (e) {
      onInvalid?.(resource.path, (e as Error)?.message ?? String(e));
      continue;
    }
    if (definition.frozen) { onFrozen?.(resource.path); continue; }
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
 * to the shared spawn machinery: `cwd` makes the definition's own
 * `workingDirectory` the spawned agent's real process directory (see that
 * field's own doc comment for the workspace-identity tradeoff), and
 * `permissionMode` carries the definition's permission mode straight to a
 * Claude launch (Codex has no such field — see that field's own doc
 * comment). `agents` names exactly one preference (the definition's own
 * vendor/tier) — `spec.agents`, not `rule.agentPreferences`, is what makes
 * this heterogeneous per file despite one shared `Rule`.
 */
export function specForSessionDefinition({ agentKey, resource, definition }: SessionDefinitionMatch): SpawnSpec {
  return {
    key: agentKey,
    resource: resource.path,
    issuetype: "managed-session",
    summary: `managed session (${definition.vendor}, ${definition.tier}) — ${resource.name}`,
    parent: null,
    brief: definition.brief,
    agents: [{ harness: definition.vendor, model: tierToModel(definition.tier) }],
    cwd: definition.workingDirectory,
    permissionMode: definition.permissionMode,
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
}

export function createManagedSessionResourceType(deps: ManagedSessionResourceDeps): ResourceType<ExecutionUnit<SessionDefinitionMatch>> {
  const onOversized = onceOversized(deps.log);
  const onInvalid = onceInvalidDefinition(deps.log);
  const onFrozen = onceFrozenDefinition(deps.log);
  return {
    discovery: {
      idOf: unitAgentKey,
      search: async () => groupExecutionUnits([deps.rule], await searchSessionDefinitions(deps, onOversized, onInvalid, onFrozen)),
    },
    activation: { verdictFor: () => "active" },
    eventRules: createSessionDefinitionEventRules(),
    spawnConfig: { specFor: specForSessionDefinitionUnit },
  };
}

/** The real read function `createManagedSessionResourceType` uses outside tests. */
export const readDefinitionFile = (path: string): Promise<string> => readFile(path, "utf8");

export { listFilesystemResources, MAX_ENCODED_SEGMENT_BYTES };
