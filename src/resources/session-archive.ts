/**
 * BUTCHR-455 (BUTCHR-394 T2) — `archive`/`unarchive` cores for a
 * managed-session definition: move the file OUT of the active definitions
 * directory (`sessionDefinitionsPath()`) into a sibling archive directory,
 * and back, preserving its exact file name and byte-for-byte content.
 *
 * WHY THIS DROPS AN AGENT FROM THE ELIGIBLE SET WITH NO OTHER CHANGE:
 * `searchSessionDefinitions` (`src/rules/session-definition-type.ts`) builds
 * its candidate set from a plain directory listing of the active dir
 * (`{root, kind: "file", maxDepth: 1}`) — a file that is no longer a direct
 * child of that directory is no longer a candidate, so it drops out of
 * `desired` and the existing reconcile (`reconcileNow`, `src/daemon/loop.ts`)
 * stops its agent on the next poll, same as any other "definition removed"
 * case. This module never touches the daemon, the herd, or reconcile
 * itself — it only moves a file and (for archive) runs an injected hook.
 *
 * IDENTITY RULE (decided on BUTCHR-394, comment 24391/24394): an agent's key,
 * and so the freeze-store key `butchr:<agentKey>` (`src/resources/session-
 * freeze.ts`), is derived from the definition's FILE PATH. Restoring a
 * definition to the SAME path it was archived from is what makes it come
 * back as the SAME agent, with the SAME store-freeze state — the whole
 * reason `archive`/`unarchive` key on a plain basename (never a caller-
 * supplied destination path) and refuse rather than silently renaming on
 * collision. This module never clears or rewrites freeze-store state; a
 * frozen definition's manifest `frozen: true` field travels with the file
 * unconditionally (it's part of the file's own content, untouched by a
 * move), so it reads exactly as frozen at its new path as it did at its old
 * one, whichever direction it moved and regardless of the store gate, which
 * this module also leaves alone.
 */
import { access, copyFile as fsCopyFile, mkdir as fsMkdir, rename as fsRename, unlink as fsUnlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve, sep } from "node:path";
import { sessionAgentKey } from "./session-freeze.js";
import { sessionDefinitionsPath, type SessionDefinitionsEnv } from "./session-definition.js";

/**
 * Where archived definitions live: `BUTCHR_SESSION_ARCHIVE_DIR` when set,
 * else a sibling of the (resolved) definitions directory, named after it
 * with an `-archive` suffix — e.g. `.../butchr/session-definitions` resolves
 * a default archive dir of `.../butchr/session-definitions-archive`. This is
 * the ONE documented function every caller (CLI, and this ticket's hook seam
 * for a later MCP tool) must resolve the archive directory through — never a
 * second ad hoc computation.
 */
export function sessionArchiveDir(env: SessionDefinitionsEnv = process.env, definitionsDir: string = sessionDefinitionsPath(env)): string {
  const override = env.BUTCHR_SESSION_ARCHIVE_DIR?.trim();
  return override || `${definitionsDir}-archive`;
}

/**
 * Throws when `archiveDir` would equal or sit inside `definitionsDir` — the
 * active query (`{root: definitionsDir, kind: "file", maxDepth: 1}`) would
 * then still be able to see an "archived" file (directly, or as soon as it
 * moved one level down), defeating the entire point of archiving it.
 * Comparison resolves both paths (so `.`/`..` segments and a trailing slash
 * can't hide a real conflict) without changing what `sessionArchiveDir`
 * itself returns. Called once at the START of every command that touches
 * the archive directory (`archive`, `unarchive`, `list --archived`,
 * `create`'s collision check) — refusing before anything is moved, per this
 * ticket's own requirement.
 */
export function assertArchiveDirDisjoint(definitionsDir: string, archiveDir: string): void {
  const defs = resolve(definitionsDir);
  const arch = resolve(archiveDir);
  if (arch === defs || arch.startsWith(defs + sep)) {
    throw new Error(`session archive directory (${archiveDir}) must not equal or sit inside the definitions directory (${definitionsDir})`);
  }
}

/** Told about a definition that just moved from the active directory into the archive — see `SessionArchiveIo.onArchived`'s own doc comment for why this exists and what a failure here does and does not undo. */
export type OnArchived = (info: { agentKey: string; path: string }) => Promise<void>;

export interface SessionArchiveIo {
  /** The active definitions directory — same value `SessionCliIo.dir` already resolves. */
  activeDir: string;
  archiveDir: string;
  /** Injectable so a test can force `EXDEV` on the FIRST attempt without two real filesystems. Defaults to `node:fs/promises`' `rename`. */
  rename: (from: string, to: string) => Promise<void>;
  /** Only ever used for the cross-filesystem fallback (`rename` failing `EXDEV`) — copies into a temp name in the DESTINATION directory; the temp file is then renamed into place (atomic, same filesystem) before the source is unlinked. */
  copyFile: (from: string, to: string) => Promise<void>;
  unlink: (path: string) => Promise<void>;
  exists: (path: string) => Promise<boolean>;
  /** Creates a directory (and any missing parents) if it does not already exist; a no-op if it does. */
  mkdir: (path: string) => Promise<void>;
  /**
   * Run after a successful archive move, default no-op. S4 (BUTCHR-395)
   * owns Rocket.Chat account cleanup (`releaseAccount(agentKey, "archive")`,
   * `src/accounts/manager.ts` on the BUTCHR-395 story branch, not on `main`
   * yet) and will wire itself in here through a follow-up task — this
   * module imports nothing from that branch. A hook failure is reported
   * back to the caller (`ArchiveResult.hookError`) but NEVER undoes the
   * move: the definition is already out of the eligible set by the time
   * the hook runs, and rolling the move back on a hook failure would put it
   * back in the eligible set out from under an operator who asked for it to
   * be archived, for a reason (account cleanup) that has nothing to do with
   * whether the move itself was valid. Never called on a refusal (nothing
   * moved).
   */
  onArchived?: OnArchived;
}

export type ArchiveResult =
  | { ok: true; path: string; hookError?: string }
  | { ok: false; error: string };

/** Same shape as `session-definition-manage.ts`'s/`session-cli.ts`'s own `defaultExists`/`realExists` — a fresh copy rather than an import across layers, since resources must not depend on the CLI. */
const defaultExists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

/** The real, disk-touching `rename`/`copyFile`/`unlink`/`exists`/`mkdir` — everything BUT `activeDir`/`archiveDir`/`onArchived`, which the caller (the CLI's `defaultIo()`) supplies. */
export function defaultSessionArchiveIo(): Pick<SessionArchiveIo, "rename" | "copyFile" | "unlink" | "exists" | "mkdir"> {
  return {
    rename: (from, to) => fsRename(from, to),
    copyFile: (from, to) => fsCopyFile(from, to),
    unlink: (path) => fsUnlink(path),
    exists: defaultExists,
    mkdir: (path) => fsMkdir(path, { recursive: true }).then(() => undefined),
  };
}

/**
 * Moves `sourcePath` to `destPath`, atomically where the platform allows
 * (a same-filesystem `rename`), falling back — ONLY on `EXDEV` (cross-
 * filesystem) — to: copy into a temp name in `destPath`'s own directory,
 * `rename` that temp file into place (same filesystem as the destination,
 * so still atomic), then unlink the source. Never leaves a partial file
 * under `destPath`'s own final name in either case: the temp file is
 * unlinked (best-effort) if the second `rename` itself fails, and the
 * source is unlinked only AFTER the destination rename has already
 * succeeded.
 */
async function moveFileAtomic(io: Pick<SessionArchiveIo, "rename" | "copyFile" | "unlink">, sourcePath: string, destPath: string): Promise<void> {
  try {
    await io.rename(sourcePath, destPath);
    return;
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== "EXDEV") throw e;
  }
  const tmp = join(dirname(destPath), `.${randomUUID()}.tmp`);
  await io.copyFile(sourcePath, tmp);
  try {
    await io.rename(tmp, destPath);
  } catch (e) {
    await io.unlink(tmp).catch(() => {});
    throw e;
  }
  await io.unlink(sourcePath);
}

/**
 * Moves `fileName` (a basename, e.g. `foo.json`) from `io.activeDir` into
 * `io.archiveDir`, under the SAME name — never a caller-supplied
 * destination name, since the identity rule (this module's own top comment)
 * depends on restoring to the exact original path. Refuses, moving nothing,
 * when: the source does not exist; a file of that name already exists in
 * the archive; or the archive directory cannot be created. `agentKey` in
 * both the result-adjacent hook call and any future caller is computed from
 * the definition's ACTIVE path (`sourcePath`) — the identity it carried
 * while eligible, which is what a store-freeze gate (if any) was ever keyed
 * to.
 */
export async function archiveSessionDefinition(io: SessionArchiveIo, fileName: string): Promise<ArchiveResult> {
  const sourcePath = join(io.activeDir, fileName);
  const destPath = join(io.archiveDir, fileName);
  if (!(await io.exists(sourcePath))) return { ok: false, error: `${sourcePath} does not exist` };
  if (await io.exists(destPath)) return { ok: false, error: `${destPath} already exists — an archived definition of this name already exists, refusing to overwrite it` };
  try {
    await io.mkdir(io.archiveDir);
  } catch (e) {
    return { ok: false, error: `cannot create archive directory ${io.archiveDir}: ${(e as Error).message}` };
  }
  await moveFileAtomic(io, sourcePath, destPath);
  const result: ArchiveResult = { ok: true, path: destPath };
  if (io.onArchived) {
    try {
      await io.onArchived({ agentKey: sessionAgentKey(sourcePath), path: destPath });
    } catch (e) {
      result.hookError = (e as Error).message;
    }
  }
  return result;
}

/**
 * Moves `fileName` back from `io.archiveDir` to `io.activeDir`, under the
 * SAME name, making it eligible again on the daemon's next poll (subject to
 * its own validity and freeze gates, unaffected by this move — see this
 * module's own top comment). Refuses, moving nothing, when: the source
 * (in the archive) does not exist; a file of that name already exists in
 * the active directory; or the active directory cannot be created (it may
 * never have existed at all, e.g. every definition was ever only archived).
 * No hook — the post-archive hook seam is one-directional (S4's cleanup
 * runs on archive, never on restore).
 */
export async function unarchiveSessionDefinition(io: Pick<SessionArchiveIo, "activeDir" | "archiveDir" | "rename" | "copyFile" | "unlink" | "exists" | "mkdir">, fileName: string): Promise<ArchiveResult> {
  const sourcePath = join(io.archiveDir, fileName);
  const destPath = join(io.activeDir, fileName);
  if (!(await io.exists(sourcePath))) return { ok: false, error: `${sourcePath} does not exist` };
  if (await io.exists(destPath)) return { ok: false, error: `${destPath} already exists — an active definition of this name already exists, refusing to overwrite it` };
  try {
    await io.mkdir(io.activeDir);
  } catch (e) {
    return { ok: false, error: `cannot create definitions directory ${io.activeDir}: ${(e as Error).message}` };
  }
  await moveFileAtomic(io, sourcePath, destPath);
  return { ok: true, path: destPath };
}
