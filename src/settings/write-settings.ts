/**
 * FACTORY-665 — the write path for `settings.json`: validates ONE
 * allowlisted key's new value (`validateSettingValue`, `./settings-file.ts`)
 * BEFORE touching disk, then reads-modifies-writes the whole document
 * under a cross-process lock, atomically, with a backup of the previous
 * file. Deliberately mirrors `../rules/write-rules.ts`'s own proven
 * primitives (`O_EXCL`+`O_NOFOLLOW` temp + fsync + rename, directory
 * fsync, symlink refusal, a `.lock` file that ALWAYS REFUSES rather than
 * reclaims, backup pruning) rather than reinventing them — see that
 * module's own header for the reasoning behind each one; this file does
 * not repeat it.
 *
 * Unlike `write-rules.ts`, there is no `assertOnlyChanged` scope gate
 * here: EVERY key this module ever writes already passed
 * `validateSettingValue` against the SAME fixed allowlist `settings-file.ts`
 * reads back with, so there is no broader "which paths changed" question
 * to ask — the document's only shape is a flat `{ [allowlistedKey]: string
 * }` map, and a write that touched a non-allowlisted key would have been
 * refused before it got here.
 */
import { chmodSync, closeSync, constants as fsConstants, copyFileSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { isAllowlistedSettingsKey, settingsFilePath, validateSettingValue, type SettingsFileEnv } from "./settings-file.js";

const DEFAULT_MODE = 0o600;
const MAX_BACKUPS = 20;

export interface WriteSettingsIo {
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
  acquireLock: (dir: string) => () => void;
  now: () => Date;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** `.settings.lock` — the exact same "always refuses, never reclaims a stale lock" discipline as `../rules/write-rules.ts`'s `acquireRulesLock` (FACTORY-673), applied to settings.json's own directory instead. A SEPARATE lock file from `.rules.lock`: the two documents are written independently and must never serialize on each other. */
export function acquireSettingsLock(dir: string): () => void {
  const lockPath = join(dir, ".settings.lock");
  const token = `${process.pid}:${process.hrtime.bigint()}-${Math.random().toString(36).slice(2)}`;
  try {
    const fd = openSync(lockPath, "wx");
    try { writeSync(fd, token); } finally { closeSync(fd); }
    return () => {
      try {
        if (readFileSync(lockPath, "utf8") === token) unlinkSync(lockPath);
      } catch { /* best-effort cleanup */ }
    };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
  let currentContent: string;
  try {
    currentContent = readFileSync(lockPath, "utf8");
  } catch {
    throw new Error(`settings file lock at ${lockPath} changed while being inspected — another writer is active or just finished; try again`);
  }
  const heldPid = Number(currentContent.split(":")[0] ?? "");
  if (!Number.isInteger(heldPid) || heldPid <= 0) {
    throw new Error(`settings file lock at ${lockPath} has unreadable/corrupt content (${JSON.stringify(currentContent)}) — refusing to guess whether it is live or abandoned; remove it by hand once you've confirmed no writer holds it`);
  }
  if (isPidAlive(heldPid)) {
    throw new Error(`settings file is locked by another writer (pid ${heldPid}) at ${lockPath} — refusing to write concurrently`);
  }
  throw new Error(`settings file lock at ${lockPath} was left behind by pid ${heldPid}, which is no longer running (a crashed writer); butchr never reclaims a stale lock automatically. If no butchr daemon is running, remove it with: rm ${lockPath} — then retry`);
}

export function defaultSettingsIo(): WriteSettingsIo {
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
    removeQuiet: (path) => { try { unlinkSync(path); } catch { /* best-effort */ } },
    modeOf: (path) => { try { return statSync(path).mode & 0o777; } catch { return undefined; } },
    chmod: (path, mode) => { try { chmodSync(path, mode); } catch { /* best-effort */ } },
    listDir: (dir) => { try { return readdirSync(dir); } catch { return []; } },
    isSymlink: (path) => { try { return lstatSync(path).isSymbolicLink(); } catch { return false; } },
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
    acquireLock: (dir) => acquireSettingsLock(dir),
    now: () => new Date(),
  };
}

function utcStamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

const BACKUP_ID_RE = /^\d{8}T\d{6}Z(?:-\d{1,6})?$/;

function uniqueBackupId(dir: string, baseName: string, io: WriteSettingsIo): string {
  const base = utcStamp(io.now());
  const existing = new Set(io.listDir(dir));
  if (!existing.has(`${baseName}.bak-${base}`)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!existing.has(`${baseName}.bak-${candidate}`)) return candidate;
  }
}

function refuseSymlink(path: string, io: WriteSettingsIo): void {
  if (io.isSymlink(path)) {
    throw new Error(`${path} is a symlink — refusing to read, back up, or write through a symlinked settings file`);
  }
}

function pruneBackups(dir: string, baseName: string, io: WriteSettingsIo): void {
  const re = new RegExp(`^${baseName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.bak-\\d{8}T\\d{6}Z(?:-\\d{1,6})?$`);
  const names = io.listDir(dir).filter((n) => re.test(n)).sort();
  const excess = names.length - MAX_BACKUPS;
  for (let i = 0; i < excess; i++) io.removeQuiet(join(dir, names[i]!));
}

const activeWriters = new Set<string>();

/**
 * Same "0700 only when THIS call creates the directory, never chmod an
 * existing one" discipline `../rules/write-rules.ts`'s
 * `createRulesFileExclusive` already follows for `rules.json`'s own
 * directory (FACTORY-685, L2) — `settings.json` has no separate first-run
 * seed step to do this once, so the write path itself is where it has to
 * happen, exactly once, the first time anything is ever written here.
 */
function withWriteLock<T>(path: string, dir: string, io: WriteSettingsIo, fn: () => T): T {
  if (activeWriters.has(path)) {
    throw new Error(`${path}: already being written by this same process — refusing`);
  }
  activeWriters.add(path);
  let release: (() => void) | undefined;
  try {
    const dirExistedBefore = io.modeOf(dir) !== undefined;
    io.mkdir(dir);
    if (!dirExistedBefore) io.chmod(dir, 0o700);
    release = io.acquireLock(dir);
    return fn();
  } finally {
    release?.();
    activeWriters.delete(path);
  }
}

function parseDocument(text: string | undefined): Record<string, string> {
  if (text === undefined) return {};
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return {}; // a corrupt current file is treated as empty — the new write still succeeds and replaces it with a valid document
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(doc as Record<string, unknown>)) {
    if (isAllowlistedSettingsKey(k) && typeof v === "string") out[k] = v;
  }
  return out;
}

export class SettingsWriteRefusedError extends Error {
  readonly needsConfirm: boolean;
  constructor(message: string, needsConfirm = false) {
    super(message);
    this.name = "SettingsWriteRefusedError";
    this.needsConfirm = needsConfirm;
  }
}

export interface WriteSettingResult {
  path: string;
  backupPath: string | null;
  backupId: string | null;
  key: string;
  value: string;
}

/**
 * THE one write entry point: validates `key`/`rawValue` (format + range,
 * `confirm` as the ceiling/floor escape hatch) BEFORE acquiring the lock or
 * touching disk — a doomed-to-fail call never contends for the lock, never
 * creates the settings directory, never writes a backup. On success:
 * read-modify-write the WHOLE document under the lock (so there is no
 * window between reading the current file and writing the next one for a
 * concurrent writer to land in — same reasoning as `updateRulesFile`'s own
 * doc comment), back up the current file (if any), write atomically.
 */
export function writeSetting(key: string, rawValue: string, confirm: boolean, env: SettingsFileEnv = process.env, io: WriteSettingsIo = defaultSettingsIo()): WriteSettingResult {
  const result = validateSettingValue(key, rawValue, confirm);
  if (!result.ok) throw new SettingsWriteRefusedError(result.error, result.needsConfirm === true);

  const path = settingsFilePath(env);
  const dir = dirname(path);
  const baseName = basename(path);

  return withWriteLock(path, dir, io, () => {
    refuseSymlink(path, io);
    const currentText = io.readFile(path);
    const doc = parseDocument(currentText);
    doc[key] = result.normalized;
    const nextText = JSON.stringify(doc, null, 2) + "\n";

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

    return { path, backupPath, backupId, key, value: result.normalized };
  });
}

/**
 * Restores `settings.json` to a previous backup's content, through the
 * exact same locked/atomic path a normal write takes — the UI's "Undo" for
 * a settings change. `backupId` is validated against the one shape a
 * backup id is ever produced in BEFORE any path is built from it (same
 * discipline as `../rules/write-rules.ts`'s `restoreBackup`).
 */
export function restoreSettingsBackup(backupId: string, env: SettingsFileEnv = process.env, io: WriteSettingsIo = defaultSettingsIo()): void {
  if (!BACKUP_ID_RE.test(backupId)) {
    throw new Error(`invalid backup id ${JSON.stringify(backupId)}`);
  }
  const path = settingsFilePath(env);
  const dir = dirname(path);
  const baseName = basename(path);
  const backupPath = join(dir, `${baseName}.bak-${backupId}`);
  if (dirname(backupPath) !== dir) throw new Error(`backup path ${backupPath} does not resolve inside ${dir} — refusing`);
  refuseSymlink(backupPath, io);
  const text = io.readFile(backupPath);
  if (text === undefined) throw new Error(`no backup ${JSON.stringify(backupId)} found for ${path}`);

  withWriteLock(path, dir, io, () => {
    refuseSymlink(path, io);
    const currentText = io.readFile(path);
    let newBackupPath: string | null = null;
    if (currentText !== undefined) {
      const newBackupId = uniqueBackupId(dir, baseName, io);
      newBackupPath = join(dir, `${baseName}.bak-${newBackupId}`);
      const existingMode = io.modeOf(path) ?? DEFAULT_MODE;
      io.copyFile(path, newBackupPath);
      io.chmod(newBackupPath, existingMode);
      io.fsyncDir(dir);
      pruneBackups(dir, baseName, io);
    }
    const mode = io.modeOf(path) ?? DEFAULT_MODE;
    const tmp = join(dir, `.${baseName}.tmp-${process.pid}-${process.hrtime.bigint()}-${Math.random().toString(36).slice(2)}`);
    try {
      io.writeTempExclusive(tmp, text, mode);
      io.chmod(tmp, mode);
      io.rename(tmp, path);
      io.fsyncDir(dir);
    } catch (e) {
      io.removeQuiet(tmp);
      throw e;
    }
    return newBackupPath;
  });
}
