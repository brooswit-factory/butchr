/**
 * FACTORY-667 — the write-rules.ts (FACTORY-658) write core, generalized
 * from ONE fixed file (`rulesPath(env)`) to an arbitrary `path` an operator
 * might pick at request time (one JSON file among many, e.g. a session
 * definition under `sessionDefinitionsPath()`). Every safety property is
 * carried over UNCHANGED, not re-derived: validate-before-lock, a
 * cross-process `O_EXCL` lock (`acquireNamedLock`, `../rules/write-rules.js`
 * — the SAME live/stale/corrupt-holder refusal logic `.rules.lock` already
 * uses, just under a caller-chosen basename so two subsystems never
 * contend on each other's lock), a backup taken before every write (pruned
 * to the newest `MAX_BACKUPS`, hand-made backups never touched),
 * `assertOnlyChanged` (`../rules/write-rules.js`, already generic over any
 * JSON document) for a server-side field allowlist, symlink refusal, and
 * atomic temp-file-then-rename (fsynced, directory fsynced).
 *
 * `validate(nextText, path)` is the ONE thing every caller supplies that
 * `loadRules` was for `rules.json` — it must throw (with every problem
 * collected, same multi-line discipline) on an invalid document and return
 * normally on a valid one. Called BEFORE any lock/IO (so a doomed call
 * never contends for the lock) and is NOT re-run inside the lock: unlike
 * `rules.json` (one document every reader shares), a session-definition
 * file's own content can only ever be raced by another writer through this
 * SAME lock, so the pre-lock validation and the lock's own current-text
 * read are never more than one (serialized) write apart in practice. A
 * caller deriving `nextText` from a prior read (every real caller here)
 * MUST use `updateJsonFile`, not `writeJsonFile` directly, for the same
 * lost-update reason `write-rules.ts`'s own header documents.
 */
import { chmodSync, closeSync, constants as fsConstants, copyFileSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { acquireNamedLock } from "../rules/write-rules.js";
import { assertOnlyChanged } from "../rules/write-rules.js";

export { assertOnlyChanged };

const DEFAULT_MODE = 0o600;
const MAX_BACKUPS = 20;
const BACKUP_ID_PATTERN = String.raw`\d{8}T\d{6}Z(?:-\d{1,6})?`;
const BACKUP_ID_RE = new RegExp(`^${BACKUP_ID_PATTERN}$`);
const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

export interface WriteJsonFileResult {
  path: string;
  /** `null` only when the file did not exist before this write (nothing to back up). */
  backupPath: string | null;
  backupId: string | null;
  /** sha256 hex of the written text. */
  etag: string;
}

export interface WriteJsonFileOptions {
  /** sha256 of the content the caller last read; refuses (no mutation) if the live file's current etag differs. Not accepted by `updateJsonFile` (the read happens inside the same lock there). */
  ifMatch?: string;
  /** Restricted to these dot-separated paths via `assertOnlyChanged`, checked against the real current/next text inside the lock. Absent: unrestricted. */
  allowedPaths?: readonly string[];
}

/** Same seams `WriteRulesIo` (`../rules/write-rules.ts`) exposes, generalized to any `path`/`dir` rather than one fixed rules file. */
export interface WriteJsonFileIo {
  readFile: (path: string) => string | undefined;
  copyFile: (src: string, dest: string) => void;
  writeTempExclusive: (path: string, text: string, mode: number) => void;
  rename: (tempPath: string, path: string) => void;
  removeQuiet: (path: string) => void;
  modeOf: (path: string) => number | undefined;
  chmod: (path: string, mode: number) => void;
  listDir: (dir: string) => string[];
  isSymlink: (path: string) => boolean;
  mkdir: (dir: string) => void;
  fsyncDir: (dir: string) => void;
  acquireLock: (dir: string, lockBasename: string) => () => void;
  now: () => Date;
}

export function defaultWriteJsonFileIo(): WriteJsonFileIo {
  return {
    readFile: (path) => {
      try {
        return readFileSync(path, "utf8");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw e;
      }
    },
    copyFile: (src, dest) => copyFileSync(src, dest),
    writeTempExclusive: (path, text, mode) => {
      const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0);
      const fd = openSync(path, flags, mode);
      try {
        writeSync(fd, text);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    },
    rename: (tempPath, path) => renameSync(tempPath, path),
    removeQuiet: (path) => {
      try { unlinkSync(path); } catch { /* best-effort cleanup */ }
    },
    modeOf: (path) => {
      try { return statSync(path).mode & 0o777; } catch { return undefined; }
    },
    chmod: (path, mode) => {
      try { chmodSync(path, mode); } catch { /* best-effort */ }
    },
    listDir: (dir) => {
      try { return readdirSync(dir); } catch { return []; }
    },
    isSymlink: (path) => {
      try { return lstatSync(path).isSymbolicLink(); } catch { return false; }
    },
    mkdir: (dir) => mkdirSync(dir, { recursive: true }),
    fsyncDir: (dir) => {
      try {
        const fd = openSync(dir, "r");
        try { fsyncSync(fd); } finally { closeSync(fd); }
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === "EINVAL" || code === "ENOTSUP") return;
        throw e;
      }
    },
    acquireLock: (dir, lockBasename) => acquireNamedLock(dir, lockBasename),
    now: () => new Date(),
  };
}

function utcStamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function uniqueBackupId(dir: string, baseName: string, io: WriteJsonFileIo): string {
  const base = utcStamp(io.now());
  const existing = new Set(io.listDir(dir));
  if (!existing.has(`${baseName}.bak-${base}`)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!existing.has(`${baseName}.bak-${candidate}`)) return candidate;
  }
}

function refuseSymlink(path: string, io: WriteJsonFileIo): void {
  if (io.isSymlink(path)) {
    throw new Error(`${path} is a symlink — refusing to read, back up, or write through a symlinked file`);
  }
}

function pruneBackups(dir: string, baseName: string, io: WriteJsonFileIo): void {
  const re = new RegExp(`^${escapeRegExp(baseName)}\\.bak-${BACKUP_ID_PATTERN}$`);
  const names = io.listDir(dir).filter((n) => re.test(n)).sort();
  const excess = names.length - MAX_BACKUPS;
  for (let i = 0; i < excess; i++) io.removeQuiet(join(dir, names[i]!));
}

const activeWriters = new Set<string>();

function withWriteLock<T>(path: string, dir: string, lockBasename: string, io: WriteJsonFileIo, fn: () => T): T {
  if (activeWriters.has(path)) {
    throw new Error(`${path}: already being written by this same process (reentrant writeJsonFile/updateJsonFile/restoreJsonFileBackup call) — refusing`);
  }
  activeWriters.add(path);
  let release: (() => void) | undefined;
  try {
    io.mkdir(dir);
    release = io.acquireLock(dir, lockBasename);
    return fn();
  } finally {
    release?.();
    activeWriters.delete(path);
  }
}

function commitWrite(path: string, dir: string, baseName: string, io: WriteJsonFileIo, currentText: string | undefined, nextText: string, allowedPaths: readonly string[] | undefined): WriteJsonFileResult {
  if (allowedPaths) {
    assertOnlyChanged(currentText ?? "{}", nextText, allowedPaths);
  }

  let backupPath: string | null = null;
  let backupId: string | null = null;
  if (currentText !== undefined) {
    backupId = uniqueBackupId(dir, baseName, io);
    backupPath = join(dir, `${baseName}.bak-${backupId}`);
    const existingMode = io.modeOf(path) ?? DEFAULT_MODE;
    io.copyFile(path, backupPath);
    io.chmod(backupPath, existingMode);
    io.fsyncDir(dir);
    pruneBackups(dir, baseName, io);
  }

  const mode = io.modeOf(path) ?? DEFAULT_MODE;
  const tmp = join(dir, `.${baseName}.tmp-${process.pid}-${process.hrtime.bigint()}-${Math.random().toString(36).slice(2)}`);
  try {
    io.writeTempExclusive(tmp, nextText, mode);
    io.chmod(tmp, mode);
    io.rename(tmp, path);
    io.fsyncDir(dir);
  } catch (e) {
    io.removeQuiet(tmp);
    throw e;
  }

  return { path, backupPath, backupId, etag: sha256(nextText) };
}

/** Direct write of a whole next document. Safe to call directly only when `nextText` was NOT derived from a prior read of this same path (see this module's own header) — use `updateJsonFile` otherwise. */
export function writeJsonFile(path: string, nextText: string, validate: (text: string, path: string) => void, lockBasename: string, io: WriteJsonFileIo = defaultWriteJsonFileIo(), opts: WriteJsonFileOptions = {}): WriteJsonFileResult {
  validate(nextText, path); // fast, lock-free rejection of syntactically-doomed input
  const dir = dirname(path);
  const baseName = basename(path);
  return withWriteLock(path, dir, lockBasename, io, () => {
    refuseSymlink(path, io);
    const currentText = io.readFile(path);
    if (opts.ifMatch !== undefined) {
      const currentEtag = sha256(currentText ?? "");
      if (opts.ifMatch !== currentEtag) {
        throw new Error(`${path}: etag mismatch — expected ${opts.ifMatch}, found ${currentEtag}; the file changed since it was read, reload and retry`);
      }
    }
    return commitWrite(path, dir, baseName, io, currentText, nextText, opts.allowedPaths);
  });
}

/** The safe read-modify-write entry point: `mutator` runs INSIDE the same lock this function's own write takes, so there is no read/write race window. `mutator` itself must validate via `validate` (it is NOT re-run here before the lock, since there is no "next text" yet to pre-check) — every caller in this codebase runs `validate` on its own returned text before returning from `mutator`. */
export function updateJsonFile(path: string, mutator: (currentText: string | undefined) => string, validate: (text: string, path: string) => void, lockBasename: string, io: WriteJsonFileIo = defaultWriteJsonFileIo(), opts: Pick<WriteJsonFileOptions, "allowedPaths"> = {}): WriteJsonFileResult {
  const dir = dirname(path);
  const baseName = basename(path);
  return withWriteLock(path, dir, lockBasename, io, () => {
    refuseSymlink(path, io);
    const currentText = io.readFile(path);
    const nextText = mutator(currentText);
    validate(nextText, path);
    return commitWrite(path, dir, baseName, io, currentText, nextText, opts.allowedPaths);
  });
}

/** Restores `path` to a previous backup's content, through the exact same validated/atomic path as `writeJsonFile` (a thin wrapper, not a second write path) — the restored file is byte-identical to the backup. `backupId` is validated against the one shape this module ever produces BEFORE any path is built from it, and the resulting path's directory is re-checked against `dir`. */
export function restoreJsonFileBackup(path: string, backupId: string, validate: (text: string, path: string) => void, lockBasename: string, io: WriteJsonFileIo = defaultWriteJsonFileIo()): WriteJsonFileResult {
  if (!BACKUP_ID_RE.test(backupId)) {
    throw new Error(`invalid backup id ${JSON.stringify(backupId)} — expected the exact shape a backup id is ever produced in (e.g. "20261005T180000Z" or "20261005T180000Z-2")`);
  }
  const dir = dirname(path);
  const baseName = basename(path);
  const backupPath = join(dir, `${baseName}.bak-${backupId}`);
  if (dirname(backupPath) !== dir) {
    throw new Error(`backup path ${backupPath} does not resolve inside ${dir} — refusing`);
  }
  refuseSymlink(backupPath, io);
  const text = io.readFile(backupPath);
  if (text === undefined) throw new Error(`no backup ${JSON.stringify(backupId)} found for ${path} (expected ${backupPath})`);
  return writeJsonFile(path, text, validate, lockBasename, io);
}

/** The CURRENT file's etag (sha256 hex; sha256 of `""` if the file does not exist). */
export function jsonFileEtag(path: string, io: WriteJsonFileIo = defaultWriteJsonFileIo()): string {
  return sha256(io.readFile(path) ?? "");
}
