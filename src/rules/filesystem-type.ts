/**
 * The rule engine's `ResourceType` for `filesystem` rules: one item per
 * (rule, path) match, keyed `filesystem:<rule>:<canonical-path>`, active
 * exactly while the rule's query matches the path.
 *
 * Kept apart from the other providers on purpose: it shares the generic loop,
 * agent keys and rule schema, and nothing else. A `filesystem` rule has no
 * relationships (src/rules/rules.ts) and no external credentials — its own
 * "search" is a local disk walk (src/resources/filesystem.ts).
 *
 * CHANGE EVENTS (BUTCHR-407 requirement 3): PRIMARY (swarm) and RELATED
 * (singleton/persistent scope) deliberately use TWO DIFFERENT diffs, not one
 * shared function:
 * - PRIMARY reuses `execution.ts`'s own `diffMatches`, exactly as
 *   zendesk-ticket-type.ts/github-issue-type.ts do: it only ever diffs a key
 *   present in the NEXT snapshot, so a resource entering or leaving a swarm
 *   rule's query produces no notify at all (spawn/stop already say that) —
 *   only a CONTENT change on a resource that stayed matched notifies its own
 *   agent. This is "what a change means" for swarm, chosen to match the two
 *   existing non-Jira providers' own precedent rather than jira-work's own
 *   (which does notify appear/disappear on primary, for JIRA-specific
 *   reasons `src/resources/issue.ts` states — not one that generalizes here).
 * - RELATED uses this module's own `matchDiff` below, which UNIONS the
 *   (prev, next) key sets — a resource entering or leaving a singleton/
 *   persistent rule's scope has no `before` or no `after` respectively, and
 *   is reported as `{appeared}`/`{disappeared}` exactly once (the poll where
 *   its own scope entry stops being produced by `scopeRelatedResources`).
 *   This is the explicit "create, modify, remove ... delivered to
 *   singleton/persistent agents" requirement; `execution.ts`'s own
 *   `diffMatches` cannot express it (it never sees a key that left `next`).
 */
import type { SpawnSpec } from "../agents/workspace.js";
import { isFilesystemResourceId, MAX_ENCODED_SEGMENT_BYTES } from "../resources/filesystem-ref.js";
import { parseFilesystemQuery, type FilesystemQuery } from "../resources/filesystem-query.js";
import type { FilesystemResource } from "../resources/filesystem.js";
import type { EventPoll, EventRules, EventVerdict, PollSnapshot, RelatedResource, ResourceType } from "../resources/types.js";
import { decodeAnyAgentKey, encodeAgentKey } from "./agent-key.js";
import { diffMatches, groupExecutionUnits, logExecutionModeSwitches, resourceMatches, scopeRelatedResources, unitAgentKey, type ExecutionUnit } from "./execution.js";
import type { Rule } from "./rules.js";

export interface FilesystemMatch {
  agentKey: string;
  rule: Rule;
  resource: FilesystemResource;
}

export interface FilesystemResourceDeps {
  /** Validated rules; only enabled `filesystem` rules are searched. */
  rules: readonly Rule[];
  /** Every resource one rule's query currently matches (src/resources/filesystem.ts, injectable for tests). */
  list: (query: FilesystemQuery) => Promise<FilesystemResource[]>;
  log?: (line: string) => void;
  /** BUTCHR-398: this provider's own running herd ids, for `logExecutionModeSwitches` — see `RuleResourceDeps.runningIds`'s own doc comment (src/rules/resource-type.ts). Optional; omitted, no mode-switch logging runs. */
  runningIds?: () => Promise<readonly string[]>;
}

/**
 * FACTORY-47: the literal `MANAGED_SESSIONS_RULE_ID` id
 * (`src/rules/session-definition-type.ts`) — duplicated here, not imported,
 * because that module already imports `onceOversized` from THIS one
 * (`session-definition-type.ts` -> `filesystem-type.ts`); importing it back
 * would be a cycle. The two must stay equal; `test/unit/filesystem.test.ts`'s
 * `ownsFilesystemAgent` suite builds a real managed-session key via
 * `encodeAgentKey`/`MANAGED_SESSIONS_RULE_ID` (the real one, from
 * session-definition-type.ts) and asserts this function rejects it, and
 * `test/unit/session-definition-type.test.ts` runs `startFilesystemLoop`
 * and `startManagedSessionsLoop` together against one herd, so a drift
 * between the two literals fails loudly in either place rather than
 * resurfacing silently as this exact bug.
 */
const MANAGED_SESSIONS_RULE_ID = "managed-sessions";

/**
 * True for exactly the herd ids this type owns: a `filesystem`-provider id
 * whose rule is an ORDINARY `filesystem` rule — never the built-in
 * `managed-sessions` one (BUTCHR-407/408), which reuses the same
 * `resourceProvider` for an unrelated resource shape but is owned
 * exclusively by `startManagedSessionsLoop`/`ownsManagedSessionAgent`
 * (session-definition-type.ts).
 *
 * FACTORY-47: before this exclusion, `ownsFilesystemAgent` returned `true`
 * for a managed-session id too, so a daemon with zero enabled `filesystem`
 * rules — this loop's own `startFilesystemLoop` doc comment already
 * promises "still stops filesystem agents left over from an earlier run…
 * never leaves them running with no loop to stop them" — treated every
 * running managed-session agent as exactly such a leftover and stopped it
 * on the very next poll. The managed-sessions loop then saw it gone and
 * spawned it again (never a respawn, since nothing was ever stale), and the
 * two loops repeated this every ~12-15s: the managed-session pane vanishing
 * and respawning with `[spawn] … origin=spawn` and nothing else logged,
 * exactly FACTORY-47's reported symptom. Never the `%2F` workspace-path
 * encoding, a duplicate Nexus, or the kickoff `cd` — all ruled out on codey
 * before this was found.
 */
export const ownsFilesystemAgent = (id: string): boolean => {
  const decoded = decodeAnyAgentKey(id);
  return decoded?.resourceProvider === "filesystem" && decoded.ruleId !== MANAGED_SESSIONS_RULE_ID;
};

/**
 * Told about a resource whose canonical path is otherwise a valid absolute
 * path but whose percent-encoded form would overflow the workspace
 * directory-name limit (`isFilesystemResourceId`'s own `MAX_ENCODED_SEGMENT_BYTES`
 * check, src/resources/filesystem-ref.ts) — deep trees (monorepos,
 * `node_modules`, nested project directories) reach this realistically, so
 * this is a real per-poll possibility, not a corner case to crash on.
 */
export type OversizedResource = (rule: Rule, path: string) => void;

/**
 * Every enabled `filesystem` rule's matches. Rules are searched in parallel;
 * ANY failure (a missing root, either safety cap crossed —
 * src/resources/filesystem.ts) rejects the WHOLE poll, never a partial result
 * — a partial result would read as "those resources left the query" and stop
 * healthy agents, same discipline as every other provider's `search*Rules`.
 *
 * REVIEW FINDING (PR #388 round 1): a resource whose `isFilesystemResourceId`
 * check fails on the encoded-length limit is SKIPPED here (never included,
 * `onOversized` told once) rather than handed to `encodeAgentKey` (which
 * would THROW and, by the paragraph above, reject every OTHER resource this
 * rule's poll found too) — a single oversized path must cost that one
 * resource, never the whole rule.
 */
export async function searchFilesystemRules(deps: Pick<FilesystemResourceDeps, "rules" | "list">, onOversized?: OversizedResource): Promise<FilesystemMatch[]> {
  const enabled = deps.rules.filter((r) => r.enabled && r.resourceProvider === "filesystem");
  const perRule = await Promise.all(enabled.map(async (rule) => {
    const query = parseFilesystemQuery(rule.query);
    const seen = new Set<string>();
    const out: FilesystemMatch[] = [];
    for (const resource of await deps.list(query)) {
      if (seen.has(resource.path)) continue;
      seen.add(resource.path);
      if (!isFilesystemResourceId(resource.path)) { onOversized?.(rule, resource.path); continue; }
      out.push({ agentKey: encodeAgentKey({ resourceProvider: "filesystem", ruleId: rule.id, resourceId: resource.path }), rule, resource });
    }
    return out;
  }));
  return perRule.flat();
}

/** Logs each oversized-resource skip once per resource-type instance, not once per poll — same "don't spam" discipline as `onceExcluded` (src/rules/resource-type.ts). */
export function onceOversized(log: ((line: string) => void) | undefined): OversizedResource {
  const logged = new Set<string>();
  return (rule, path) => {
    const id = `${rule.id}:${path}`;
    if (logged.has(id)) return;
    logged.add(id);
    log?.(`WARNING: [filesystem] rule ${rule.id} skips ${path}: its percent-encoded id would exceed the workspace directory-name limit (${MAX_ENCODED_SEGMENT_BYTES} bytes); narrow the rule's root or namePattern`);
  };
}

export function specForFilesystem({ agentKey, rule, resource }: FilesystemMatch): SpawnSpec {
  return {
    key: agentKey,
    resource: resource.path,
    issuetype: resource.kind,
    summary: `${resource.kind} ${resource.name}`,
    parent: null,
    brief: rule.brief,
    ...(rule.agentPreferences ? { agents: rule.agentPreferences } : {}),
  };
}

/**
 * BUTCHR-398: the SpawnSpec for a `singleton`/`persistent` rule's ONE
 * query-level agent — no single resource (`resource` omitted), so no path
 * tool can be misled into resolving it as a real file or directory.
 */
export function specForFilesystemQuery(rule: Rule, agentKey: string): SpawnSpec {
  return {
    key: agentKey,
    issuetype: "task",
    summary: `${rule.id} (query agent — every resource "${rule.query}" currently matches)`,
    parent: null,
    brief: rule.brief,
    ...(rule.agentPreferences ? { agents: rule.agentPreferences } : {}),
  };
}

export const specForFilesystemUnit = (u: ExecutionUnit<FilesystemMatch>): SpawnSpec =>
  u.kind === "resource" ? specForFilesystem(u.match) : specForFilesystemQuery(u.rule, u.agentKey);

/** What "changed" means for one resource, independent of appear/disappear: kind, size or mtime moved. */
const observed = (r: FilesystemResource): string => JSON.stringify([r.kind, r.size, r.mtimeMs]);

interface UnionDiff { changed: string[]; before(key: string): FilesystemResource | undefined; after(key: string): FilesystemResource | undefined }

/**
 * (prev, next) diff over a flat `FilesystemMatch[]`, keyed by agent key,
 * UNIONING both sides' keys — see this module's own top comment for why this
 * differs from `execution.ts`'s `diffMatches` and is used for RELATED only.
 */
function unionDiff(prev: readonly FilesystemMatch[], next: readonly FilesystemMatch[]): UnionDiff {
  const beforeMap = new Map(prev.map((m) => [m.agentKey, m.resource]));
  const afterMap = new Map(next.map((m) => [m.agentKey, m.resource]));
  const keys = new Set([...beforeMap.keys(), ...afterMap.keys()]);
  const changed: string[] = [];
  for (const k of keys) {
    const b = beforeMap.get(k), a = afterMap.get(k);
    if (!b || !a || observed(b) !== observed(a)) changed.push(k);
  }
  return { changed, before: (k) => beforeMap.get(k), after: (k) => afterMap.get(k) };
}

/** A removal is reported exactly once: the poll where the key first has no `after` — the NEXT poll it is absent from both sides, so it never enters `keys` (and hence `changed`) again. */
function decideFromUnion(diff: UnionDiff, key: string): EventVerdict {
  const before = diff.before(key), after = diff.after(key);
  if (!before) return { deliver: true, reason: { appeared: true } };
  if (!after) return { deliver: true, reason: { disappeared: true } };
  return { deliver: true }; // observed() differed — a modify; filesystem has no more specific NotifyReason member (see types.ts's own doc comment).
}

export function createFilesystemEventRules(): EventRules<ExecutionUnit<FilesystemMatch>> {
  return {
    async poll(prev: PollSnapshot<ExecutionUnit<FilesystemMatch>>, next: PollSnapshot<ExecutionUnit<FilesystemMatch>>): Promise<EventPoll> {
      const primaryDiff = diffMatches(resourceMatches(prev.primary), resourceMatches(next.primary), (m) => observed(m.resource));
      const relatedOf = (related: readonly RelatedResource<ExecutionUnit<FilesystemMatch>>[]) =>
        related.map((r) => r.issue).filter((u): u is { kind: "resource"; match: FilesystemMatch } => u.kind === "resource").map((u) => u.match);
      const relatedDiff = unionDiff(relatedOf(prev.related), relatedOf(next.related));
      const relatedEntry = (key: string) => next.related.find((r) => unitAgentKey(r.issue) === key) ?? prev.related.find((r) => unitAgentKey(r.issue) === key);
      return {
        changedPrimary: primaryDiff.changed,
        changedRelated: relatedDiff.changed,
        async decide(key, watcher, space): Promise<EventVerdict> {
          if (space === "primary") {
            const pair = primaryDiff.pairFor(key);
            return watcher === key && pair ? { deliver: true } : { deliver: false };
          }
          const entry = relatedEntry(key);
          if (!entry?.watchers.includes(watcher)) return { deliver: false };
          return decideFromUnion(relatedDiff, key);
        },
      };
    },
  };
}

export function createFilesystemResourceType(deps: FilesystemResourceDeps): ResourceType<ExecutionUnit<FilesystemMatch>> {
  let latest: FilesystemMatch[] = [];
  const onOversized = onceOversized(deps.log);
  return {
    discovery: {
      idOf: unitAgentKey,
      search: async () => {
        latest = await searchFilesystemRules(deps, onOversized);
        if (deps.runningIds) logExecutionModeSwitches("filesystem", deps.rules, await deps.runningIds(), decodeAnyAgentKey, deps.log);
        const enabled = deps.rules.filter((r) => r.enabled && r.resourceProvider === "filesystem");
        return groupExecutionUnits(enabled, latest);
      },
      related: async () => scopeRelatedResources(latest),
    },
    activation: { verdictFor: () => "active" },
    eventRules: createFilesystemEventRules(),
    spawnConfig: { specFor: specForFilesystemUnit },
  };
}
