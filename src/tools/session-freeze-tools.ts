/**
 * BUTCHR-456 (BUTCHR-394 T3, CNDLX-45) — `freeze_session`/`unfreeze_session`,
 * the MCP tools that let ONE managed-session agent flip the freeze gates of
 * ANOTHER, scoped to an explicit, per-definition grant the operator writes
 * (`freezeControllers`/`unfreezeControllers`, src/resources/session-
 * definition.ts). A CLI or a same-Unix-user agent editing files directly
 * cannot be bounded by anything, so this scoping lives at the butchr MCP
 * TOOL boundary instead — an HONEST TOOL-BOUNDARY GUARANTEE, NOT AN
 * OS-LEVEL ONE: any process that can write the definitions directory
 * directly still can, unchanged. See docs/managed-sessions.md's "Delegated
 * freeze/unfreeze" section for the full design.
 *
 * On a granted call, this calls straight into `freezeSessionDefinition`/
 * `unfreezeSessionDefinition` (src/resources/session-freeze.ts) UNCHANGED —
 * those two gates (the `instanceFreezeStore` write and the manifest
 * rewrite, in their decided order) are exactly what `butchr session
 * freeze`/`unfreeze` already calls; this module adds authorization and
 * name resolution on top, never a second implementation of the gates
 * themselves.
 *
 * REFUSAL SHAPE (the ticket's own requirement): an unknown target name, an
 * invalid/unparseable target, a caller with no grant, and a caller that
 * isn't a managed-session agent at all (jira-work, another provider, no
 * identity) ALL throw the exact same `Refusal` message — never a
 * distinguishable one — so a probing caller learns nothing about which
 * definitions exist or who controls them. Resolved by reading which
 * gate is affected only far enough to log, never to shape the thrown text.
 *
 * NAME RESOLUTION IS INHERENTLY PATH-SAFE, not merely checked to be:
 * `name` is matched against `SessionDefinitionListEntry.name` — the
 * `FilesystemResource.name` `listFilesystemResources` reports for a real
 * DIRECT CHILD of the definitions directory (`{root, kind: "file",
 * maxDepth: 1}`), which is always a bare basename with no path separator,
 * and which NEVER includes a symlink (`listFilesystemResources`'s own walk
 * skips every `isSymbolicLink()` entry outright — src/resources/
 * filesystem.ts). A `name` containing `/`, `..`, a NUL byte, or naming a
 * symlink therefore cannot equal ANY real entry's `name` and simply fails
 * to resolve — refused with the same generic message as an unknown name,
 * not a special-cased rejection. This is also why the resolved `path` this
 * module hands to `freezeSessionDefinition`/`unfreezeSessionDefinition` is
 * BYTE-IDENTICAL to what the daemon's own `searchSessionDefinitions` would
 * report for the same file: both come from the same `listFilesystemResources`
 * walk over the same built-in query, so the freeze-store key
 * (`sessionAgentKey`, derived from that path) can never diverge from the
 * key the running daemon's own `HerdrHerd.frozen()` reads.
 */
import { z, type ToolDef } from "@brooswit/thatch";
import { callerIdentity, type CallerIdentity } from "../mcp/identity.js";
import { MANAGED_SESSIONS_RULE_ID } from "../rules/session-definition-type.js";
import { freezeSessionDefinition, unfreezeSessionDefinition, type FreezeGates, type SessionFreezeIo } from "../resources/session-freeze.js";
import { listSessionDefinitions, type SessionDefinitionListDeps, type SessionDefinitionListEntry } from "../resources/session-definition-manage.js";
import { Refusal, withOutcomeRecording } from "./outcome.js";

type ManagedSessionCaller = Extract<CallerIdentity, { provider: "filesystem" }>;

/**
 * `null` for anyone who isn't a managed-session (built-in `managed-sessions`
 * rule, `filesystem` provider) agent — a plain `filesystem`/BUTCHR-407
 * resource agent included, deliberately: that rule id is reserved to
 * `builtinManagedSessionsRule` alone (session-definition-type.ts's own doc
 * comment), so this is never confused with an ordinary file/directory
 * watcher. `"query" in who` is excluded first (BUTCHR-398 precedent,
 * src/tools/github-issue.ts's own `requireGithubCaller`): a query-level
 * caller's `provider` field is typed as EVERY `ResourceProvider` including
 * `"filesystem"`, so `who.provider === "filesystem"` alone cannot
 * discriminate it from a genuine per-resource filesystem caller — and a
 * query-level caller has no single resource for these tools to name a
 * target relative to regardless.
 */
function managedSessionCaller(headers: Readonly<Record<string, string>>): ManagedSessionCaller | null {
  const who = callerIdentity(headers);
  if (!who || who.provider !== "filesystem" || "query" in who) return null;
  return who.ruleId === MANAGED_SESSIONS_RULE_ID ? who : null;
}

/** One opaque refusal for every failure shape (unknown name, invalid target, no grant, non-managed caller) — see this module's own top comment for why. */
function refusal(verb: "freeze_session" | "unfreeze_session"): Refusal {
  return new Refusal(`${verb}: refused — the target must be a valid managed-session definition that names YOUR definition in its ${verb === "freeze_session" ? "freezeControllers" : "unfreezeControllers"} grant; this message does not distinguish an unknown name, an invalid target, a missing grant, or a non-managed-session caller, so calling it never confirms or denies which definitions exist`);
}

/** `entries.find` by exact name, falling back to `${name}.json` — the SAME with-or-without-extension convenience `showSessionDefinition`/`butchr session freeze` already extend to a caller-supplied name. */
function findEntry(entries: readonly SessionDefinitionListEntry[], name: string): SessionDefinitionListEntry | undefined {
  return entries.find((e) => e.name === name) ?? entries.find((e) => e.name === `${name}.json`);
}

/** True iff some name in `grant` resolves (in `entries`) to an agent key equal to `callerAgentKey` — the exact codec `sessionAgentKey` builds from a path, compared as opaque strings, never re-derived by hand here. An ungranted/empty list, or a name that resolves to nothing (typo, not-yet-created controller), is simply not a match — never an error. */
function grantIncludesCaller(grant: readonly string[] | undefined, entries: readonly SessionDefinitionListEntry[], callerAgentKey: string): boolean {
  if (!grant?.length) return false;
  return grant.some((name) => findEntry(entries, name)?.agentKey === callerAgentKey);
}

export interface SessionFreezeToolDeps {
  dir: string;
  /** Injectable so tests use an in-memory map; defaults are wired by the daemon exactly like `session-definition-manage.ts`'s own callers. */
  list?: SessionDefinitionListDeps["list"];
  read?: SessionDefinitionListDeps["read"];
  freeze: SessionFreezeIo;
  log?: (line: string) => void;
}

async function authorizedTarget(
  deps: SessionFreezeToolDeps,
  caller: ManagedSessionCaller,
  targetName: string,
  grantField: "freezeControllers" | "unfreezeControllers",
): Promise<SessionDefinitionListEntry | null> {
  const listDeps: SessionDefinitionListDeps = {
    dir: deps.dir,
    ...(deps.list !== undefined ? { list: deps.list } : {}),
    ...(deps.read !== undefined ? { read: deps.read } : {}),
    store: deps.freeze.store,
  };
  const entries = await listSessionDefinitions(listDeps);
  const target = findEntry(entries, targetName);
  if (!target || !target.valid || !target.agentKey) return null;
  return grantIncludesCaller(target[grantField], entries, caller.agent) ? target : null;
}

function makeHandler(verb: "freeze_session" | "unfreeze_session", deps: SessionFreezeToolDeps) {
  const grantField = verb === "freeze_session" ? "freezeControllers" : "unfreezeControllers";
  const log = deps.log ?? console.error;
  return async (a: unknown, c: { headers: Readonly<Record<string, string>> }): Promise<{ ok: true; name: string; gates: FreezeGates }> => {
    const { name } = a as { name: string };
    const caller = managedSessionCaller(c.headers);
    const target = caller ? await authorizedTarget(deps, caller, name, grantField) : null;
    if (!caller || !target) {
      log(`  [tools] ${c.headers["x-butchr-agent"] ?? "?"} → refused ${verb} ${name}`);
      throw refusal(verb);
    }
    const gates = verb === "freeze_session" ? await freezeSessionDefinition(deps.freeze, target.path) : await unfreezeSessionDefinition(deps.freeze, target.path);
    log(`  [tools] ${caller.agent} → ${verb} ${target.name} (${target.agentKey})`);
    return { ok: true, name: target.name, gates };
  };
}

/**
 * `deps.list`/`deps.read`/`deps.freeze.store` are the same seams
 * `session-definition-manage.ts`/`session-freeze.ts` already define —
 * injectable so a test never touches real disk or the real freeze store
 * singleton (this ticket's own hard constraint), and so production wires
 * the SAME `sessionDefinitionsPath()`/`listFilesystemResources`/
 * `defaultSessionFreezeIo()` the daemon's own poll and `butchr session`
 * CLI already use — never a second, drifting resolution of "where
 * definitions live."
 */
export function sessionFreezeTools(deps: SessionFreezeToolDeps): Record<string, ToolDef<any>> {
  const log = deps.log ?? console.error;
  const tools: Record<string, ToolDef<any>> = {
    freeze_session: {
      description:
        "Freeze ANOTHER managed-session definition — the two freeze gates `butchr session freeze` sets, unchanged. Argument `name` is the TARGET definition's file name (with or without \".json\"), never a path. Authorized ONLY when the caller is itself a managed-session agent that the target definition's own `freezeControllers` grant names by file name — never from any argument you supply. Every refusal (unknown name, invalid target, no grant, non-managed-session caller) reads identically, by design: it never confirms or denies which definitions exist or who controls them. This tool can only flip the freeze gates — it can never create, archive, delete, or edit a grant.",
      input: { name: z.string() },
      handler: makeHandler("freeze_session", deps),
    },
    unfreeze_session: {
      description:
        "Unfreeze ANOTHER managed-session definition — the two freeze gates `butchr session unfreeze` clears, unchanged. Same argument, resolution and refusal shape as `freeze_session`, gated on the TARGET's `unfreezeControllers` grant instead — listing a controller in `freezeControllers` gives it nothing here, and vice versa; the two grants are independent by design. This tool can only flip the freeze gates — it can never create, archive, delete, or edit a grant.",
      input: { name: z.string() },
      handler: makeHandler("unfreeze_session", deps),
    },
  };
  return withOutcomeRecording(tools, log);
}
