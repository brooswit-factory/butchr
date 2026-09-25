/**
 * BUTCHR-454 — `list`/`show`/`create` cores for `butchr session`, kept apart
 * from `session-freeze.ts` (freeze/unfreeze) because these three have no
 * MCP-tool future to design around; they exist to be thin CLI operations
 * over the SAME validator and directory-listing machinery the daemon's own
 * `searchSessionDefinitions` (`src/rules/session-definition-type.ts`) uses,
 * never a forked copy of either.
 *
 * `listSessionDefinitions` deliberately does NOT reuse
 * `searchSessionDefinitions` itself: that function's whole job is to drop
 * invalid/frozen definitions from the ELIGIBLE set it returns (logging them,
 * never surfacing them to a caller) — exactly the opposite of this command's
 * own requirement ("Invalid manifests must be listed with their problems,
 * not hidden"). Both instead share the same lower-level pieces
 * (`builtinManagedSessionsRule`'s query, `parseSessionDefinitionFile`,
 * `isFilesystemResourceId`), so "what counts as a candidate file" and "what
 * counts as a validation problem" can never drift between the daemon and
 * this CLI.
 */
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentRole, ExecutionMode } from "../rules/rules.js";
import { builtinManagedSessionsRule } from "../rules/session-definition-type.js";
import {
  parseSessionDefinition, parseSessionDefinitionFile, sessionDefinitionProblems,
  type SessionDefinitionVendor, type SessionTier,
} from "./session-definition.js";
import { isFilesystemResourceId, MAX_ENCODED_SEGMENT_BYTES } from "./filesystem-ref.js";
import { isMissingRootError, listFilesystemResources, type FilesystemResource } from "./filesystem.js";
import type { FilesystemQuery } from "./filesystem-query.js";
import { parseFilesystemQuery } from "./filesystem-query.js";
import { readStoreFrozen, sessionAgentKey, type SessionFreezeStore } from "./session-freeze.js";
import { writeFileAtomic } from "./atomic-write.js";

export interface SessionDefinitionListEntry {
  /** File basename, e.g. `foo.json` — what `create <name>`/`show <name>`/`freeze <name>` all key on. */
  name: string;
  path: string;
  /**
   * `undefined` ONLY for an oversized path (`encodeAgentKey`/`sessionAgentKey`
   * itself refuses to build a key over the encoded-length limit — the SAME
   * refusal `searchSessionDefinitions` sidesteps by checking
   * `isFilesystemResourceId` first and never reaching that codec at all) —
   * such a definition has no agent, hence no freeze STORE key either, so
   * `storeFrozen` is `undefined` alongside it. This is a DIFFERENT "unknown"
   * than an invalid definition's `manifestFrozen: undefined` (which has a
   * perfectly good agent key; only its manifest content is untrustworthy).
   */
  agentKey?: string;
  valid: boolean;
  /** `[]` when `valid`. Every problem `sessionDefinitionProblems` (or the oversized-path check) collected, never just the first. */
  problems: readonly string[];
  vendor?: SessionDefinitionVendor;
  tier?: SessionTier;
  role?: AgentRole;
  execution?: ExecutionMode;
  /** `undefined` for an invalid definition — the raw `frozen` field cannot be trusted to mean anything once the document itself doesn't validate. */
  manifestFrozen?: boolean;
  /** Known whenever `agentKey` is (the store key is derived from the PATH alone, independent of the file's own content) — `undefined` only for the oversized-path case, which has no agent key to derive one from. */
  storeFrozen?: boolean;
}

export interface SessionDefinitionListDeps {
  dir: string;
  /** Injectable so tests use an in-memory map; defaults to real disk. */
  list?: (query: FilesystemQuery) => Promise<FilesystemResource[]>;
  read?: (path: string) => Promise<string>;
  store: Pick<SessionFreezeStore, "read">;
  /**
   * BUTCHR-455 — when set, `agentKey`/`storeFrozen` are computed against
   * `join(identityDir, resource.name)` instead of the resource's own
   * (actual, on-disk) path. Used for `butchr session list --archived`:
   * an archived definition physically lives under the archive directory,
   * but its freeze-store key (and so its "would it be staffed frozen or
   * not" answer) is derived from the path it will have once RESTORED to
   * the active directory (see `session-freeze.ts`'s own doc comment on why
   * the store key is path-derived) — `dir` still names where the file
   * currently lives, for listing/reading, and stays what `entry.path`
   * reports. Omitted (the default), `dir` is used for identity too —
   * unchanged behaviour for `list`/`show`/`create`'s active-directory case.
   */
  identityDir?: string;
}

const defaultRead = (path: string): Promise<string> => readFile(path, "utf8");

/** Every definition file in `deps.dir` (a missing directory is `[]`, never an error — same "absent means empty" discipline `searchSessionDefinitions` already documents), valid or not, each with both freeze gates. */
export async function listSessionDefinitions(deps: SessionDefinitionListDeps): Promise<SessionDefinitionListEntry[]> {
  const rule = builtinManagedSessionsRule(deps.dir);
  const query = parseFilesystemQuery(rule.query);
  const list = deps.list ?? listFilesystemResources;
  const read = deps.read ?? defaultRead;
  let resources: FilesystemResource[];
  try {
    resources = await list(query);
  } catch (e) {
    if (isMissingRootError(e)) return [];
    throw e;
  }
  const out: SessionDefinitionListEntry[] = [];
  const seen = new Set<string>();
  for (const resource of resources) {
    if (seen.has(resource.path)) continue;
    seen.add(resource.path);
    const identityPath = deps.identityDir !== undefined ? join(deps.identityDir, resource.name) : resource.path;
    if (!isFilesystemResourceId(identityPath)) {
      // Too long to ever become an agent key (`sessionAgentKey`/`encodeAgentKey`
      // would throw) — same check `searchSessionDefinitions` runs BEFORE ever
      // building one, never after.
      out.push({
        name: resource.name, path: resource.path, valid: false,
        problems: [`its percent-encoded id would exceed the workspace directory-name limit (${MAX_ENCODED_SEGMENT_BYTES} bytes)`],
      });
      continue;
    }
    const agentKey = sessionAgentKey(identityPath);
    const storeFrozen = await readStoreFrozen(deps.store, identityPath);
    try {
      const definition = parseSessionDefinitionFile(await read(resource.path), resource.path);
      out.push({
        name: resource.name, path: resource.path, agentKey, valid: true, problems: [],
        vendor: definition.vendor, tier: definition.tier, role: definition.role, execution: definition.execution,
        manifestFrozen: definition.frozen, storeFrozen,
      });
    } catch (e) {
      out.push({ name: resource.name, path: resource.path, agentKey, valid: false, problems: (e as Error).message.split("\n"), storeFrozen });
    }
  }
  return out;
}

export type SessionDefinitionShowResult = { found: false } | { found: true; entry: SessionDefinitionListEntry };

/** `name` matches either the exact file basename, or that name with `.json` appended — same convenience `create` extends the other way. */
export async function showSessionDefinition(deps: SessionDefinitionListDeps, name: string): Promise<SessionDefinitionShowResult> {
  const entries = await listSessionDefinitions(deps);
  const entry = entries.find((e) => e.name === name) ?? entries.find((e) => e.name === `${name}.json`);
  return entry ? { found: true, entry } : { found: false };
}

export interface CreateSessionDefinitionInput {
  workingDirectory: string;
  brief: string;
  vendor: string;
  tier: string;
  permissionMode: string;
  execution?: string;
  account?: string;
  role?: string;
  frozen?: boolean;
  mcpServers?: unknown;
}

export type CreateSessionDefinitionResult = { ok: true; path: string } | { ok: false; error: string };

export interface CreateSessionDefinitionDeps {
  dir: string;
  /**
   * BUTCHR-455 — when given, `create` also refuses if a definition of the
   * same name already exists in THIS directory (the archive dir). Omitted,
   * `create` checks the active directory only — same as before this ticket
   * (a caller with no archive concept at all, e.g. an old test, keeps its
   * old behaviour unchanged).
   */
  archiveDir?: string;
  /** Injectable existence check so tests never touch real disk. */
  exists?: (path: string) => Promise<boolean>;
  write?: (path: string, contents: string) => Promise<void>;
}

const defaultExists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

/**
 * Validates `input` through `sessionDefinitionProblems` — the EXACT function
 * `parseSessionDefinitionFile` (and so the daemon's own poll) runs a
 * manifest through, never a forked copy — then writes the RAW input object
 * (not the parsed/defaulted `SessionDefinition`): a `workingDirectory` of
 * `"~/repo"` is written back as `"~/repo"`, not the daemon's own expanded
 * absolute path, and an omitted optional field stays omitted rather than
 * being materialized to its default. `parseSessionDefinition` is still
 * called (its result discarded) purely so a validator bug that lets
 * `sessionDefinitionProblems` pass something `parseSessionDefinition` itself
 * would throw on is caught here, at create time, rather than shipping a file
 * the daemon's own poll then logs as invalid.
 *
 * Refuses to overwrite an existing definition of the same name, in EITHER
 * the active directory or (when `deps.archiveDir` is given) the archive
 * directory — BUTCHR-455 closes the gap BUTCHR-454 flagged: without this,
 * `create`-ing a name that matches an archived definition would succeed,
 * and a later `unarchive` of that name would then collide with the new
 * active file it never knew about.
 */
export async function createSessionDefinition(deps: CreateSessionDefinitionDeps, name: string, input: CreateSessionDefinitionInput): Promise<CreateSessionDefinitionResult> {
  const fileName = name.endsWith(".json") ? name : `${name}.json`;
  const path = join(deps.dir, fileName);
  const exists = deps.exists ?? defaultExists;
  const write = deps.write ?? writeFileAtomic;

  if (await exists(path)) return { ok: false, error: `${path} already exists — refusing to overwrite` };
  if (deps.archiveDir !== undefined) {
    const archivedPath = join(deps.archiveDir, fileName);
    if (await exists(archivedPath)) return { ok: false, error: `${archivedPath} already exists — an archived definition of this name already exists; unarchive it or choose a different name` };
  }

  const rawDoc: Record<string, unknown> = {
    workingDirectory: input.workingDirectory,
    brief: input.brief,
    vendor: input.vendor,
    tier: input.tier,
    permissionMode: input.permissionMode,
    ...(input.execution !== undefined ? { execution: input.execution } : {}),
    ...(input.account !== undefined ? { account: input.account } : {}),
    ...(input.role !== undefined ? { role: input.role } : {}),
    ...(input.frozen !== undefined ? { frozen: input.frozen } : {}),
    ...(input.mcpServers !== undefined ? { mcpServers: input.mcpServers } : {}),
  };
  const problems = sessionDefinitionProblems(rawDoc, fileName);
  if (problems.length) return { ok: false, error: problems.join("\n") };
  parseSessionDefinition(rawDoc, fileName); // must not throw once sessionDefinitionProblems([]) — see doc comment above.

  await write(path, `${JSON.stringify(rawDoc, null, 2)}\n`);
  return { ok: true, path };
}
