/**
 * FACTORY-667 (epic FACTORY-659, slice D1) — the session-definitions web
 * write path: ties `./session-definitions-write-apply.ts` (patch
 * application + field allowlist), `./write-json-file.ts` (FACTORY-658's
 * write core, generalized) and `./session-freeze.ts` (the two freeze
 * gates) together into the operations this slice ships — editing
 * `modelPower`/`effort`/`permissionMode`/`lizardMode`, and freeze/unfreeze.
 * `src/web/view.ts` wires these to HTTP; nothing here knows about Elysia,
 * Origin headers, or CSRF — those are `../web/write-guard.ts`'s job,
 * already run before any of these are called, same discipline as
 * `../rules/rules-write.ts`.
 *
 * RISKY FIELDS (`permissionMode: "bypassPermissions" | "auto"`,
 * `lizardMode: true`) get a SERVER-side confirm gate, but a DIFFERENT shape
 * than `../rules/rules-write.ts`'s own `WriteRefusedError` (409, text
 * message): this ticket's own acceptance criteria require the preview
 * (old -> new value, consequence) to arrive as a STRUCTURED field on a 200,
 * never as text in an error, and an unconfirmed preview-only request must
 * NOT be audited as a rejected write — mirroring `POST /api/rules/plan`'s
 * own "no audit call" shape (a report-only read, not a write attempt),
 * never the rules write routes' own mandatory-confirm 409.
 *
 * UNDO (B2, same scoping `../rules/rules-write.ts` documents): restores
 * ONLY the backup this SAME process's last successful UI write produced —
 * across every session-definition PATH, not just one (`LastUiWriteRef`
 * below carries the path, unlike the rules file's single fixed path) — and
 * ONLY while that file's etag is still that write's own resulting etag.
 */
import { dirname, join } from "node:path";
import { isDefinitionJsonFile, isHiddenDefinitionFile, sessionDefinitionProblems } from "./session-definition.js";
import { sessionFreezeStoreKey, type SessionFreezeStore } from "./session-freeze.js";
import { applySessionDefinitionFieldPatch, buildSessionDefinitionFieldsAllowedPaths, disallowedPatchFields, EDITABLE_SESSION_DEFINITION_FIELDS, readSessionDefinitionDoc, SessionDefinitionWriteApplyError, type SessionDefinitionFieldPatch } from "./session-definitions-write-apply.js";
import { defaultWriteJsonFileIo, jsonFileEtag, restoreJsonFileBackup, sha256, updateJsonFile, type WriteJsonFileIo } from "./write-json-file.js";

export const SESSION_DEFINITIONS_LOCK_BASENAME = ".session-definitions.lock";

/** `permissionMode`/`lizardMode` values that are NEVER a default — same vocabulary (and the same two string values) as `../rules/rules-write-registry.ts`'s own `RISKY_PERMISSION_MODES`, kept as an independent literal here rather than importing that `Rule`-typed `Set` (a `SessionPermissionMode` and a rule's own permission-mode type are separately validated enums that merely happen to share these two string values — see `session-definition.ts`'s own `SESSION_PERMISSION_MODES` doc comment). */
const RISKY_SESSION_PERMISSION_MODES = new Set(["bypassPermissions", "auto"]);

export type SessionDefinitionConfirmReason = "risky-permission";

export interface SessionDefinitionFieldPreviewEntry {
  field: EditablePreviewField;
  oldValue: unknown;
  newValue: unknown;
  consequence: string;
}
type EditablePreviewField = "permissionMode" | "lizardMode";

function isRiskyPatch(patch: SessionDefinitionFieldPatch): boolean {
  return (patch.permissionMode !== undefined && RISKY_SESSION_PERMISSION_MODES.has(patch.permissionMode)) || patch.lizardMode === true;
}

function buildRiskyPreview(current: Record<string, unknown>, patch: SessionDefinitionFieldPatch): SessionDefinitionFieldPreviewEntry[] {
  const entries: SessionDefinitionFieldPreviewEntry[] = [];
  if (patch.permissionMode !== undefined && RISKY_SESSION_PERMISSION_MODES.has(patch.permissionMode)) {
    entries.push({
      field: "permissionMode",
      oldValue: current.permissionMode ?? null,
      newValue: patch.permissionMode,
      consequence: `agents launched under this definition will run with NO per-tool permission prompts (permissionMode: ${JSON.stringify(patch.permissionMode)}); only NEW agents are affected — an already-running agent must be restarted to pick this up`,
    });
  }
  if (patch.lizardMode === true) {
    entries.push({
      field: "lizardMode",
      oldValue: current.lizardMode ?? null,
      newValue: true,
      consequence: "the daemon will auto-answer this agent's tool-permission prompts unattended, on the next permission-answer tick — no agent restart needed, takes effect live",
    });
  }
  return entries;
}

export class SessionDefinitionWriteRefusedError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export interface LastUiWriteRef {
  value: { path: string; backupId: string; resultingEtag: string } | null;
}

export interface SessionDefinitionsWriteDeps {
  /** `sessionDefinitionsPath(env)` — read fresh per call (never cached), same "configurable at runtime" discipline every other env-derived path in this codebase follows. */
  dir: () => string;
  io?: WriteJsonFileIo;
  store: Pick<SessionFreezeStore, "read" | "set">;
  /** See `LastUiWriteRef`'s own doc comment — the SAME object must be passed to every call for undo to see a prior write; a caller that wants undo disabled passes a fresh one (or none) each time. */
  lastUiWrite?: LastUiWriteRef;
}

export type SessionDefinitionsWriteOutcome =
  | { ok: true; requiresConfirm: false; backupId: string | null; etag: string }
  | { ok: true; requiresConfirm: true; confirmReason: SessionDefinitionConfirmReason; preview: SessionDefinitionFieldPreviewEntry[] }
  | { ok: false; status: number; error: string };

const sessionDefinitionValidate = (text: string, path: string): void => {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    throw new Error(`${path}: invalid JSON: ${(e as Error).message}`);
  }
  const problems = sessionDefinitionProblems(doc, path);
  if (problems.length) throw new Error(problems.join("\n"));
};

/**
 * `name` (a raw, untrusted HTTP path segment) resolved to a file inside
 * `dir`: must be exactly a `.json`-suffixed basename with no path
 * separator, NUL byte, or dot-prefix — the SAME positive-allowlist/hidden-
 * file discipline `isDefinitionJsonFile`/`isHiddenDefinitionFile`
 * (`./session-definition.ts`) already apply to a LISTED file, applied here
 * to an OPERATOR-SUPPLIED name before it ever reaches `join()`, so a
 * `../../etc/passwd.json`-shaped name can never resolve outside `dir` in
 * the first place (an extra `dirname(...) !== dir` check after `join`
 * would be redundant once this gate holds, but costs nothing — kept as
 * belt-and-suspenders, same discipline `restoreJsonFileBackup` already
 * applies to a backup id).
 */
export function resolveSessionDefinitionPath(dir: string, name: string): { ok: true; path: string } | { ok: false; error: string } {
  if (name.includes("/") || name.includes("\\") || name.includes("\0")) return { ok: false, error: `${JSON.stringify(name)} is not a valid session definition name (must be a bare file name)` };
  if (isHiddenDefinitionFile(name)) return { ok: false, error: `${JSON.stringify(name)} is not a valid session definition name (must not start with ".")` };
  if (!isDefinitionJsonFile(name)) return { ok: false, error: `${JSON.stringify(name)} is not a valid session definition name (must end in ".json")` };
  const path = join(dir, name);
  if (dirname(path) !== dir) return { ok: false, error: `${JSON.stringify(name)} does not resolve inside ${dir} — refusing` };
  return { ok: true, path };
}

function checkIfMatch(currentText: string | undefined, ifMatch: string): void {
  const currentEtag = sha256(currentText ?? "");
  if (ifMatch !== currentEtag) {
    throw new SessionDefinitionWriteRefusedError(`etag mismatch — expected ${ifMatch}, this definition is currently at ${currentEtag}; reload and retry`, 409);
  }
}

function refusalToOutcome(e: unknown): SessionDefinitionsWriteOutcome {
  if (e instanceof SessionDefinitionWriteRefusedError) return { ok: false, status: e.status, error: e.message };
  if (e instanceof SessionDefinitionWriteApplyError) return { ok: false, status: 400, error: e.message };
  const message = (e as Error)?.message ?? String(e);
  if (message.includes("is not in the allowed set")) return { ok: false, status: 403, error: message };
  if (message.includes("etag mismatch")) return { ok: false, status: 409, error: message };
  if (message.includes(SESSION_DEFINITIONS_LOCK_BASENAME) || message.includes("was left behind by pid") || message.includes("locked by another writer")) {
    return { ok: false, status: 503, error: message };
  }
  return { ok: false, status: 400, error: message };
}

function recordLastUiWrite(deps: SessionDefinitionsWriteDeps, path: string, backupId: string | null, resultingEtag: string): void {
  if (backupId === null) return; // no prior file existed — nothing to ever undo TO
  if (!deps.lastUiWrite) deps.lastUiWrite = { value: null };
  deps.lastUiWrite.value = { path, backupId, resultingEtag };
}

/**
 * `POST /api/session-definitions/:name/fields`'s own write. Refuses (400,
 * writes nothing): any patch key outside `EDITABLE_SESSION_DEFINITION_FIELDS`
 * — server-side, independent of whatever the dashboard UI happens to show
 * — an unknown definition name (404), a stale `ifMatch` (409), and (via
 * `sessionDefinitionValidate`, inside the lock) any resulting document
 * `sessionDefinitionProblems` itself would reject (e.g. a `tier`-based
 * definition can only ever set `modelPower`/`effort` TOGETHER, by design —
 * see that validator's own "mutually exclusive" rule; a tier-based
 * definition cannot be migrated to the new scheme through this route alone
 * since `tier` itself is not editable here).
 *
 * A patch touching a risky field (`isRiskyPatch`) WITHOUT `confirm: true`
 * returns the structured preview on a 200 and writes NOTHING — never
 * audited as a rejected write (see this module's own header). `confirm:
 * true` is otherwise a plain pass-through: it does not bypass the
 * allowlist or the etag check.
 */
export async function writeSessionDefinitionFields(deps: SessionDefinitionsWriteDeps, name: string, rawPatch: Record<string, unknown>, ifMatch: string, confirm: boolean): Promise<SessionDefinitionsWriteOutcome> {
  const bad = disallowedPatchFields(rawPatch);
  if (bad.length > 0) {
    return { ok: false, status: 403, error: `field(s) ${bad.map((f) => JSON.stringify(f)).join(", ")} are not editable via the dashboard — only ${EDITABLE_SESSION_DEFINITION_FIELDS.join(", ")} may be patched this way` };
  }
  const patch = rawPatch as SessionDefinitionFieldPatch;
  const resolved = resolveSessionDefinitionPath(deps.dir(), name);
  if (!resolved.ok) return { ok: false, status: 400, error: resolved.error };
  const { path } = resolved;
  const io = deps.io ?? defaultWriteJsonFileIo();

  const currentText = io.readFile(path);
  if (currentText === undefined) return { ok: false, status: 404, error: `no session definition named ${JSON.stringify(name)}` };
  let current: Record<string, unknown>;
  try {
    current = readSessionDefinitionDoc(currentText, path);
  } catch (e) {
    return { ok: false, status: 400, error: (e as Error).message };
  }

  if (isRiskyPatch(patch) && confirm !== true) {
    return { ok: true, requiresConfirm: true, confirmReason: "risky-permission", preview: buildRiskyPreview(current, patch) };
  }

  try {
    const result = updateJsonFile(
      path,
      (text) => {
        checkIfMatch(text, ifMatch);
        return applySessionDefinitionFieldPatch(text, path, patch);
      },
      sessionDefinitionValidate,
      SESSION_DEFINITIONS_LOCK_BASENAME,
      io,
      { allowedPaths: buildSessionDefinitionFieldsAllowedPaths(patch) },
    );
    recordLastUiWrite(deps, path, result.backupId, result.etag);
    return { ok: true, requiresConfirm: false, backupId: result.backupId, etag: result.etag };
  } catch (e) {
    return refusalToOutcome(e);
  }
}

/**
 * `POST /api/session-definitions/:name/frozen`'s own write — the two
 * freeze gates (`./session-freeze.ts`'s own header), but through THIS
 * write contract (backed-up, locked, allowlisted, undoable) rather than
 * `freezeSessionDefinition`/`unfreezeSessionDefinition`'s own plain
 * `writeFileAtomic` (no backup/lock/undo — fine for the CLI's single-
 * operator-at-a-time use, not enough for a web write). ORDER MATTERS, same
 * as that module's own freeze/unfreeze: freezing sets the STORE first,
 * then the manifest; unfreezing clears the manifest first, then the
 * store — a crash between the two always fails toward "still frozen".
 * Low-risk: no confirm gate (freezing/unfreezing a definition is always
 * reversible and never risk-classified by this ticket).
 */
export async function writeSessionDefinitionFrozen(deps: SessionDefinitionsWriteDeps, name: string, frozen: boolean, ifMatch: string): Promise<SessionDefinitionsWriteOutcome> {
  const resolved = resolveSessionDefinitionPath(deps.dir(), name);
  if (!resolved.ok) return { ok: false, status: 400, error: resolved.error };
  const { path } = resolved;
  const io = deps.io ?? defaultWriteJsonFileIo();
  const storeKey = sessionFreezeStoreKey(path);

  // Existence checked BEFORE either gate is touched — an unknown definition
  // must never leave the STORE gate mutated as a side effect of a 404 (the
  // store has no "undo" of its own the way the manifest write does).
  if (io.readFile(path) === undefined) return { ok: false, status: 404, error: `no session definition named ${JSON.stringify(name)}` };

  try {
    if (frozen) await deps.store.set(storeKey, true);
    const result = updateJsonFile(
      path,
      (text) => {
        checkIfMatch(text, ifMatch);
        const doc = readSessionDefinitionDoc(text, path);
        return `${JSON.stringify({ ...doc, frozen }, null, 2)}\n`;
      },
      sessionDefinitionValidate,
      SESSION_DEFINITIONS_LOCK_BASENAME,
      io,
      { allowedPaths: ["frozen"] },
    );
    if (!frozen) await deps.store.set(storeKey, false);
    recordLastUiWrite(deps, path, result.backupId, result.etag);
    return { ok: true, requiresConfirm: false, backupId: result.backupId, etag: result.etag };
  } catch (e) {
    return refusalToOutcome(e);
  }
}

/**
 * `POST /api/session-definitions/undo/:backupId` — B2 scoping (see this
 * module's own header): restores ONLY this process's last successful UI
 * write, at ONLY the path that write touched, ONLY while that file's etag
 * is still that write's own resulting etag. One-shot: a second undo call
 * for the same `backupId` is refused (the ref is cleared on success) —
 * same "undo a backup, not replay it" discipline `../rules/rules-write.ts`'s
 * own `writeUndo` documents.
 */
export function writeSessionDefinitionUndo(deps: SessionDefinitionsWriteDeps, backupId: string): SessionDefinitionsWriteOutcome {
  const last = deps.lastUiWrite?.value;
  if (!last || last.backupId !== backupId) {
    return { ok: false, status: 409, error: `backup ${JSON.stringify(backupId)} is not this process's most recent UI write for any session definition — refusing to undo` };
  }
  const io = deps.io ?? defaultWriteJsonFileIo();
  const currentEtag = jsonFileEtag(last.path, io);
  if (currentEtag !== last.resultingEtag) {
    return { ok: false, status: 409, error: `${last.path} changed since that write (now at ${currentEtag}, expected ${last.resultingEtag}) — refusing to undo over an unrelated, later change` };
  }
  try {
    const result = restoreJsonFileBackup(last.path, backupId, sessionDefinitionValidate, SESSION_DEFINITIONS_LOCK_BASENAME, io);
    deps.lastUiWrite!.value = null;
    return { ok: true, requiresConfirm: false, backupId: result.backupId, etag: result.etag };
  } catch (e) {
    return refusalToOutcome(e);
  }
}
