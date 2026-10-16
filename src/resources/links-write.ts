/**
 * FACTORY-962 (epic FACTORY-659, slice D1 follow-up: links) — the web write
 * path for the butchr-managed link collection (`./link-store.ts`). Ties
 * `./write-json-file.ts` (FACTORY-658's write core, generalized, same core
 * FACTORY-667's `./session-definitions-write.ts` already runs through) to
 * the SAME `addLink`/`removeLink` validation and idempotency semantics
 * `./link-store.ts` already defines — this module does not reimplement that
 * logic, it adds the backup/lock/undo machinery a web write needs that the
 * CLI/MCP's plain `writeFileSync` never did.
 *
 * SCOPE: this write path only ever touches the FILE-backed store
 * (`defaultLinksStorePath()`). A `jira-project:` owner's links live in a
 * Jira REST project property instead (`./jira-project-link-store.ts`,
 * FACTORY-5) — not a local file, so there is nothing for this module's
 * backup/lock/undo contract to attach to. Refused server-side (403), not
 * silently dropped: `butchr link add/remove jira-project:...` (CLI) still
 * works exactly as before; only the dashboard's generic write route does
 * not reach that store.
 *
 * `src/web/view.ts` wires these to HTTP; nothing here knows about Elysia,
 * Origin headers, or CSRF — those are `../web/write-guard.ts`'s job.
 */
import { canonicalKey, parseResourceRef, type ResourceRef } from "./resource-ref.js";
import { emptyLinksFile, parseLinksFileText, type LinksFile } from "./link-store.js";
import { defaultWriteJsonFileIo, jsonFileEtag, restoreJsonFileBackup, updateJsonFile, type WriteJsonFileIo } from "./write-json-file.js";

export const LINKS_LOCK_BASENAME = ".links.lock";

export class LinksWriteRefusedError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

/** Thrown from inside `updateJsonFile`'s mutator to abort a no-op add/remove WITHOUT taking a backup or writing anything — mirrors `./link-store.ts`'s own `addLink`/`removeLink`, which never call their store's `writeFile` for a no-op either. */
class LinksNoopError extends Error {
  constructor(readonly outcome: LinksWriteOutcome) { super("links-noop"); }
}

export interface LastLinksUiWrite {
  value: { backupId: string; resultingEtag: string } | null;
}

export interface LinksWriteDeps {
  /** `defaultLinksStorePath()` — read fresh per call, same "configurable at runtime" discipline every other env-derived path in this codebase follows. */
  path: () => string;
  io?: WriteJsonFileIo;
  /** See `LastLinksUiWrite`'s own doc comment — the SAME object must be passed to every call for undo to see a prior write. */
  lastUiWrite?: LastLinksUiWrite;
}

export type LinksWriteOutcome =
  | { ok: true; added: true; backupId: string | null; etag: string }
  | { ok: true; added: false; reason: "already-present" }
  | { ok: true; removed: true; backupId: string | null; etag: string }
  | { ok: true; removed: false; reason: "not-present" }
  | { ok: true; undone: true; backupId: string | null; etag: string }
  | { ok: false; status: number; error: string };

const linksFileValidate = (text: string, path: string): void => {
  parseLinksFileText(text, path); // throws on malformed input; result itself unused — a throw is all `write-json-file.ts` needs
};

function parseRefOrThrow(input: string, argName: string): ResourceRef {
  try {
    return parseResourceRef(input);
  } catch (e) {
    throw new LinksWriteRefusedError(`invalid ${argName}: ${(e as Error).message}`, 400);
  }
}

function refuseJiraProjectOwner(ownerKey: string): void {
  if (ownerKey.startsWith("jira-project:")) {
    throw new LinksWriteRefusedError(
      `${ownerKey} is a jira-project-owned resource — its links live in a Jira project property, not this file, and are not editable from the dashboard in v1; use "butchr link" on the CLI instead`,
      403,
    );
  }
}

function refusalToOutcome(e: unknown): LinksWriteOutcome {
  if (e instanceof LinksWriteRefusedError) return { ok: false, status: e.status, error: e.message };
  const message = (e as Error)?.message ?? String(e);
  if (message.includes("is not in the allowed set")) return { ok: false, status: 403, error: message };
  if (message.includes(LINKS_LOCK_BASENAME) || message.includes("was left behind by pid") || message.includes("locked by another writer")) {
    return { ok: false, status: 503, error: message };
  }
  return { ok: false, status: 400, error: message };
}

function recordLastUiWrite(deps: LinksWriteDeps, backupId: string | null, resultingEtag: string): void {
  if (backupId === null) return; // no prior file existed — nothing to ever undo TO
  if (!deps.lastUiWrite) deps.lastUiWrite = { value: null };
  deps.lastUiWrite.value = { backupId, resultingEtag };
}

function serializeLinksFile(file: LinksFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}

/**
 * `POST /api/links/add` — adds `target` to `resource`'s managed link list.
 * Refuses (400, writes nothing): either reference fails `parseResourceRef`,
 * or `resource === target` (a resource cannot link to itself, same rule
 * `./link-store.ts`'s own `addLink` enforces). Refuses a `jira-project:`
 * resource (403; see this module's own header). Idempotent: an
 * already-present link is reported `added: false` and nothing is written —
 * no backup taken, no etag advanced, same as `./link-store.ts`'s own
 * `addLink`.
 */
export async function writeLinkAdd(deps: LinksWriteDeps, resourceInput: string, targetInput: string): Promise<LinksWriteOutcome> {
  try {
    const resource = parseRefOrThrow(resourceInput, "resource");
    const target = parseRefOrThrow(targetInput, "target");
    const ownerKey = canonicalKey(resource);
    const targetKey = canonicalKey(target);
    if (ownerKey === targetKey) throw new LinksWriteRefusedError(`a resource cannot link to itself (${ownerKey})`, 400);
    refuseJiraProjectOwner(ownerKey);

    const path = deps.path();
    const io = deps.io ?? defaultWriteJsonFileIo();
    try {
      const result = updateJsonFile(
        path,
        (text) => {
          const file = text === undefined ? emptyLinksFile() : parseLinksFileText(text, path);
          const existing = file.links[ownerKey] ?? [];
          if (existing.includes(targetKey)) throw new LinksNoopError({ ok: true, added: false, reason: "already-present" });
          return serializeLinksFile({ ...file, links: { ...file.links, [ownerKey]: [...existing, targetKey] } });
        },
        linksFileValidate,
        LINKS_LOCK_BASENAME,
        io,
        { allowedPaths: ["v", "links"] },
      );
      recordLastUiWrite(deps, result.backupId, result.etag);
      return { ok: true, added: true, backupId: result.backupId, etag: result.etag };
    } catch (e) {
      if (e instanceof LinksNoopError) return e.outcome;
      throw e;
    }
  } catch (e) {
    return refusalToOutcome(e);
  }
}

/**
 * `POST /api/links/remove` — removes `target` from `resource`'s managed
 * link list. Same reference validation and `jira-project:` refusal as
 * `writeLinkAdd`. Idempotent: removing an absent link is reported
 * `removed: false` and nothing is written.
 */
export async function writeLinkRemove(deps: LinksWriteDeps, resourceInput: string, targetInput: string): Promise<LinksWriteOutcome> {
  try {
    const resource = parseRefOrThrow(resourceInput, "resource");
    const target = parseRefOrThrow(targetInput, "target");
    const ownerKey = canonicalKey(resource);
    const targetKey = canonicalKey(target);
    refuseJiraProjectOwner(ownerKey);

    const path = deps.path();
    const io = deps.io ?? defaultWriteJsonFileIo();
    try {
      const result = updateJsonFile(
        path,
        (text) => {
          const file = text === undefined ? emptyLinksFile() : parseLinksFileText(text, path);
          const existing = file.links[ownerKey] ?? [];
          if (!existing.includes(targetKey)) throw new LinksNoopError({ ok: true, removed: false, reason: "not-present" });
          const next = existing.filter((t) => t !== targetKey);
          const links = { ...file.links };
          if (next.length) links[ownerKey] = next;
          else delete links[ownerKey];
          return serializeLinksFile({ ...file, links });
        },
        linksFileValidate,
        LINKS_LOCK_BASENAME,
        io,
        { allowedPaths: ["v", "links"] },
      );
      recordLastUiWrite(deps, result.backupId, result.etag);
      return { ok: true, removed: true, backupId: result.backupId, etag: result.etag };
    } catch (e) {
      if (e instanceof LinksNoopError) return e.outcome;
      throw e;
    }
  } catch (e) {
    return refusalToOutcome(e);
  }
}

/**
 * `POST /api/links/undo/:backupId` — B2 scoping, same discipline
 * `../resources/session-definitions-write.ts`'s own `writeSessionDefinitionUndo`
 * documents: restores ONLY this process's last successful UI write to the
 * links file, ONLY while the file's etag is still that write's own
 * resulting etag. One-shot: cleared on success.
 */
export function writeLinkUndo(deps: LinksWriteDeps, backupId: string): LinksWriteOutcome {
  const last = deps.lastUiWrite?.value;
  if (!last || last.backupId !== backupId) {
    return { ok: false, status: 409, error: `backup ${JSON.stringify(backupId)} is not this process's most recent UI write to the links file — refusing to undo` };
  }
  const path = deps.path();
  const io = deps.io ?? defaultWriteJsonFileIo();
  const currentEtag = jsonFileEtag(path, io);
  if (currentEtag !== last.resultingEtag) {
    return { ok: false, status: 409, error: `${path} changed since that write (now at ${currentEtag}, expected ${last.resultingEtag}) — refusing to undo over an unrelated, later change` };
  }
  try {
    const result = restoreJsonFileBackup(path, backupId, linksFileValidate, LINKS_LOCK_BASENAME, io);
    deps.lastUiWrite!.value = null;
    return { ok: true, undone: true, backupId: result.backupId, etag: result.etag };
  } catch (e) {
    return refusalToOutcome(e);
  }
}
