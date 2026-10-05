/**
 * FACTORY-658 (FACTORY-643 slice 2, GH #616) — the one library function every
 * later rules.json writer (the web write path, FACTORY-663) goes through:
 * `writeRulesFile`. Validates `nextText` through the SAME entry point the
 * daemon's own startup uses (`loadRules`, fed `nextText` via an in-memory
 * `ReadRulesFile` seam rather than disk — not a second validator) BEFORE
 * touching disk, backs up the current file, then writes atomically (temp
 * file in the same directory + fsync + rename, directory fsynced too).
 * `restoreBackup` restores a previous backup through this exact same
 * validated/atomic path, for an UI "Undo". No HTTP route or UI lives in
 * THIS ticket — this module is a plain library with no CLI of its own (a
 * scope correction on FACTORY-658 removed the `butchr rules enable|disable|
 * add` commands this module originally grew alongside; `butchr rules check`
 * is unaffected and unrelated).
 *
 * SERIALIZATION (review round 2): an in-process reentrancy guard plus a
 * cross-process `O_EXCL` lock file (`.rules.lock`, pid + mtime staleness
 * detection) are held across the read-validate-backup-rename span, so two
 * writers — in this process or another — never interleave: the second
 * blocks (or fails fast on a live lock) until the first fully finishes. This
 * still does not MERGE two concurrent edits — the second writer's call still
 * simply fails if it holds a now-stale `ifMatch` etag (see below) — it only
 * guarantees no corruption and a clear error instead of a silent lost
 * update. `restoreBackup`'s own temp/backup files therefore can never
 * collide with a concurrent `writeRulesFile` either, same lock.
 *
 * OPTIMISTIC CONCURRENCY: an optional `opts.ifMatch` (sha256 hex of the
 * content the caller last read; sha256 of `""` for "I read no file yet")
 * refuses the write untouched if the live file no longer matches — the
 * lost-update guard a web PUT's `If-Match` header needs. Every successful
 * write returns the new content's own `etag`; `rulesEtag` reads the CURRENT
 * etag for a GET handler to hand back.
 *
 * SYMLINK REFUSAL: a rules file that is itself a symlink pointing outside
 * its own directory is refused before any read, backup, or write touches
 * it — otherwise `copyFileSync`/`readFileSync` would silently follow the
 * link and back up or report the mode of whatever it points to (e.g. a
 * crafted symlink pointing at an unrelated file elsewhere on disk). The
 * temp file's own open additionally passes `O_NOFOLLOW` where the platform
 * defines it, opportunistic defense-in-depth against a symlink planted at
 * the temp path between name generation and open (the name itself is
 * unique per call — pid + hrtime + random — so this is belt-and-suspenders,
 * not the primary defense).
 */
import { chmodSync, closeSync, constants as fsConstants, copyFileSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { loadRules, parseRules, rulesPath, type ReadRulesFile, type Rule, type RulesEnv } from "./rules.js";

/** Kept 0600 (the ticket's own default) when the file does not exist yet; an EXISTING file's own mode always wins. */
const DEFAULT_MODE = 0o600;
const MAX_BACKUPS = 20;
/** A lock file older than this, or whose recorded pid is no longer alive, is treated as abandoned (e.g. a crashed writer) rather than a live holder. */
const LOCK_STALE_MS = 30_000;

export interface WriteRulesResult {
  path: string;
  /** `null` only when the file did not exist before this write (nothing to back up). */
  backupPath: string | null;
  /** The UTC timestamp suffix of `backupPath` (e.g. `20261005T180000Z`, possibly `-2`/`-3`/... suffixed on a same-second collision) — what `restoreBackup` takes. `null` exactly when `backupPath` is. */
  backupId: string | null;
  /** Rule ids added, removed, or whose content differs from the previous file. Every id when the previous file was absent or unreadable as rules (nothing to diff against). */
  changedIds: string[];
  /** sha256 hex of `nextText` as written — pass to a later `writeRulesFile`'s `opts.ifMatch` to detect whether the file changed since. */
  etag: string;
}

/** Optional behaviour for `writeRulesFile`, independent of the required `nextText`/`env`/`io` positional args. */
export interface WriteRulesOptions {
  /**
   * sha256 hex of the content the caller last read (sha256 of `""` if the
   * caller read "no file exists yet") — `rulesEtag` computes it the same
   * way. When set, the write is refused with NO mutation at all if the live
   * file's current etag does not match: the file changed since the caller
   * read it. Absent (the default): no check, last-writer-wins, same as
   * before this option existed.
   */
  ifMatch?: string;
}

/**
 * Every filesystem primitive this module touches, injectable for tests
 * (simulating a failed rename, a pre-seeded set of old backups, a fixed
 * clock for deterministic backup timestamps, a held or stale lock file)
 * exactly as `loadRules`'s own `read: ReadRulesFile` seam already allows
 * for reads.
 */
export interface WriteRulesIo {
  /** Same seam `loadRules` uses: the file's text, or `undefined` if absent. */
  readFile: ReadRulesFile;
  copyFile: (src: string, dest: string) => void;
  /** Opens `path` EXCLUSIVELY (fails if it already exists), writes `text`, fsyncs, and closes it. */
  writeTempExclusive: (path: string, text: string, mode: number) => void;
  rename: (tempPath: string, path: string) => void;
  /** Best-effort cleanup of a leftover temp file; never throws. */
  removeQuiet: (path: string) => void;
  /** An existing file's own mode (masked to permission bits), or `undefined` if absent. */
  modeOf: (path: string) => number | undefined;
  /** Forces `path`'s mode; best-effort (e.g. a no-op where the platform has no POSIX mode bits). */
  chmod: (path: string, mode: number) => void;
  /** Directory entries, or `[]` if the directory does not exist. */
  listDir: (dir: string) => string[];
  isSymlink: (path: string) => boolean;
  /** Resolves a path's real, symlink-free location. */
  realpath: (path: string) => string;
  mkdir: (dir: string) => void;
  /** fsyncs the directory itself (durability for the rename/backup entries just created in it); best-effort — some platforms (Windows) cannot fsync a directory handle at all. */
  fsyncDir: (dir: string) => void;
  /** Acquires the cross-process write lock for `dir`, blocking-by-throwing (never sleeping) if another live writer holds it; returns a release function. Throws a clear error if the lock is held and not stale. */
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

/**
 * `O_EXCL` lock file named `.rules.lock` in the rules file's own directory,
 * holding the locking process's pid. A second acquirer finding the lock
 * present checks staleness (holder pid dead, or lock older than
 * `LOCK_STALE_MS`) before concluding another writer is genuinely active —
 * an abandoned lock from a crashed process must never wedge every future
 * write permanently.
 */
function acquireLockDefault(dir: string): () => void {
  const lockPath = join(dir, ".rules.lock");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, "wx");
      try { writeSync(fd, String(process.pid)); } finally { closeSync(fd); }
      return () => { try { unlinkSync(lockPath); } catch { /* best-effort cleanup */ } };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    let heldPid: number | null = null;
    let ageMs = Infinity;
    try {
      heldPid = Number(readFileSync(lockPath, "utf8").trim()) || null;
      ageMs = Date.now() - statSync(lockPath).mtimeMs;
    } catch {
      continue; // the lock vanished between our EEXIST and this read — just retry creating it
    }
    if (!(heldPid !== null && isPidAlive(heldPid)) || ageMs > LOCK_STALE_MS) {
      try { unlinkSync(lockPath); } catch { /* another racer may have cleared it first; ignore */ }
      continue;
    }
    throw new Error(`rules file is locked by another writer (pid ${heldPid}, held ${Math.round(ageMs / 1000)}s) at ${lockPath} — refusing to write concurrently`);
  }
  throw new Error(`could not acquire the rules write lock at ${lockPath} after clearing a stale lock — try again`);
}

/** The real filesystem implementation `writeRulesFile`/`restoreBackup`/`rulesEtag` default to. Exported for tests that need to override a single seam (e.g. `now`) while keeping every other operation real. */
export function defaultIo(): WriteRulesIo {
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
      // O_NOFOLLOW is opportunistic defense-in-depth (see this file's header); fall back to 0 (no-op flag) where the platform doesn't define it.
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
      try { chmodSync(path, mode); } catch { /* best-effort — e.g. a platform with no POSIX mode bits */ }
    },
    listDir: (dir) => {
      try { return readdirSync(dir); } catch { return []; }
    },
    isSymlink: (path) => {
      try { return lstatSync(path).isSymbolicLink(); } catch { return false; }
    },
    realpath: (path) => realpathSync(path),
    mkdir: (dir) => mkdirSync(dir, { recursive: true }),
    fsyncDir: (dir) => {
      try {
        const fd = openSync(dir, "r");
        try { fsyncSync(fd); } finally { closeSync(fd); }
      } catch {
        // Not every platform can open/fsync a directory handle (notably Windows) — durability
        // of the rename across a host crash is then best-effort; never fail the write over it.
      }
    },
    acquireLock: (dir) => acquireLockDefault(dir),
    now: () => new Date(),
  };
}

/** `rules.json.bak-20261005T180000Z` — the same naming the operator uses by hand (no milliseconds). */
function utcStamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/** sha256 hex — the one hash this module uses for both `etag`/`ifMatch` and, incidentally, nowhere else (changed-id diffing uses structural `JSON.stringify` equality instead, since it needs to name WHICH rule changed, not just whether anything did). */
const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/**
 * A UTC-timestamp-based id, unique within `dir`: the plain timestamp, or
 * (on a same-second collision with an existing backup) the first `-N` suffix
 * not already taken. Two writes landing in the same wall-clock second — a
 * realistic case, not a hypothetical one, since this is timer-resolution,
 * not RNG — must never overwrite each other's backup.
 */
function uniqueBackupId(dir: string, baseName: string, io: WriteRulesIo): string {
  const base = utcStamp(io.now());
  const existing = new Set(io.listDir(dir));
  if (!existing.has(`${baseName}.bak-${base}`)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!existing.has(`${baseName}.bak-${candidate}`)) return candidate;
  }
}

function refuseEscapingSymlink(path: string, dir: string, io: WriteRulesIo): void {
  if (!io.isSymlink(path)) return;
  let real: string;
  try {
    real = io.realpath(path);
  } catch (e) {
    throw new Error(`${path} is a symlink to a target that cannot be resolved: ${(e as Error).message}`);
  }
  const realDir = io.realpath(dir);
  if (dirname(real) !== realDir) {
    throw new Error(`${path} is a symlink pointing outside its own directory (${dir}) — refusing to read, back up, or write through it`);
  }
}

function pruneBackups(dir: string, baseName: string, io: WriteRulesIo): void {
  const prefix = `${baseName}.bak-`;
  // The timestamp format sorts lexically in chronological order, so a plain string sort puts the oldest first.
  const names = io.listDir(dir).filter((n) => n.startsWith(prefix)).sort();
  const excess = names.length - MAX_BACKUPS;
  for (let i = 0; i < excess; i++) io.removeQuiet(join(dir, names[i]!));
}

/**
 * Ids added, removed, or changed between the previous file and `nextRules`.
 * A previous file that is absent, or that fails to parse as a valid rules
 * document, cannot be diffed against — every id in `nextRules` is reported
 * as changed in that case, never a crash.
 */
function changedRuleIds(currentText: string | undefined, nextRules: readonly Rule[], path: string): string[] {
  const nextById = new Map(nextRules.map((r) => [r.id, r] as const));
  if (currentText === undefined) return [...nextById.keys()];
  let prevRules: Rule[];
  try {
    prevRules = parseRules(JSON.parse(currentText), path);
  } catch {
    return [...nextById.keys()];
  }
  const prevById = new Map(prevRules.map((r) => [r.id, r] as const));
  const changed = new Set<string>();
  for (const [id, rule] of nextById) {
    const prev = prevById.get(id);
    if (!prev || JSON.stringify(prev) !== JSON.stringify(rule)) changed.add(id);
  }
  for (const id of prevById.keys()) if (!nextById.has(id)) changed.add(id);
  return [...changed];
}

/** Rules files currently being written BY THIS PROCESS — the in-process half of the reentrancy guard (see `withWriteLock`). */
const activeWriters = new Set<string>();

/**
 * Holds BOTH locks (in-process reentrancy guard, then the cross-process
 * `.rules.lock` file) across `fn`, released in reverse order even if `fn`
 * throws. A reentrant call on the SAME path from the SAME process (a bug —
 * e.g. `restoreBackup` calling `writeRulesFile` recursively some other way
 * than it does today) fails fast with a clear error instead of deadlocking
 * on a lock file this same process already holds.
 */
function withWriteLock<T>(path: string, dir: string, io: WriteRulesIo, fn: () => T): T {
  if (activeWriters.has(path)) {
    throw new Error(`${path}: already being written by this same process (reentrant writeRulesFile/restoreBackup call) — refusing`);
  }
  activeWriters.add(path);
  io.mkdir(dir); // the lock file needs its directory to exist
  const release = io.acquireLock(dir);
  try {
    return fn();
  } finally {
    release();
    activeWriters.delete(path);
  }
}

/**
 * Validates `nextText` through the SAME entry point the daemon's own startup
 * uses (`loadRules`, given `nextText` via an in-memory `ReadRulesFile` that
 * returns it for this exact path — not a second parser) BEFORE touching
 * disk or acquiring any lock, so a doomed-to-fail call never contends for
 * the lock or creates the rules directory. On success: acquires the
 * read-validate-backup-rename lock (in-process + cross-process, see this
 * file's header), optionally refuses on an `opts.ifMatch` mismatch (no
 * mutation at all), backs up the current file (if any) to
 * `<path>.bak-<UTC timestamp>` (fsynced, pruned to the newest 20 backups),
 * then writes `nextText` atomically (temp file in the same directory,
 * `O_EXCL`, fsync, rename, directory fsync), preserving the current file's
 * mode (0600 for a brand-new file). On any validation problem, throws with
 * every problem (same multi-line `Error#message` shape `loadRules` throws)
 * and writes NOTHING — no temp file, no backup, no mutation of the existing
 * file, no lock ever taken.
 */
export function writeRulesFile(nextText: string, env: RulesEnv = process.env, io: WriteRulesIo = defaultIo(), opts: WriteRulesOptions = {}): WriteRulesResult {
  const path = rulesPath(env);
  const dir = dirname(path);
  const baseName = basename(path);

  // Same entry point `src/daemon/index.ts` calls at startup — `nextText` stands in for the
  // on-disk file via this one-shot `ReadRulesFile`, so `loadRules`'s own JSON.parse + `parseRules`
  // run completely unmodified; this is not a parallel/second validator.
  const fakeRead: ReadRulesFile = (p) => (p === path ? nextText : undefined);
  const { rules: nextRules } = loadRules(env, fakeRead);

  return withWriteLock(path, dir, io, () => {
    refuseEscapingSymlink(path, dir, io);

    const currentText = io.readFile(path);
    if (opts.ifMatch !== undefined) {
      const currentEtag = sha256(currentText ?? "");
      if (opts.ifMatch !== currentEtag) {
        throw new Error(`${path}: etag mismatch — expected ${opts.ifMatch}, found ${currentEtag}; the file changed since it was read, reload and retry`);
      }
    }
    const changedIds = changedRuleIds(currentText, nextRules, path);

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
      io.chmod(tmp, mode); // belt-and-suspenders against umask narrowing the requested mode unexpectedly
      io.rename(tmp, path);
      io.fsyncDir(dir);
    } catch (e) {
      io.removeQuiet(tmp);
      throw e;
    }

    return { path, backupPath, backupId, changedIds, etag: sha256(nextText) };
  });
}

/**
 * The exact shape `uniqueBackupId` ever produces: the plain `utcStamp`
 * (`YYYYMMDDTHHMMSSZ`), optionally followed by a `-N` same-second-collision
 * suffix. Anchored on both ends — `restoreBackup` refuses anything else
 * BEFORE building a path from it, since `backupId` is attacker-reachable
 * (FACTORY-662's planned `POST /api/undo/:backupId`): a bare `/`, `\`, `..`,
 * a NUL byte, an absolute path, or simply an overly long string must never
 * reach `join()`.
 */
const BACKUP_ID_RE = /^\d{8}T\d{6}Z(?:-\d{1,6})?$/;

/**
 * Restores the rules file to a previous backup's content, through the exact
 * same validated/atomic path as `writeRulesFile` (itself, in fact — this is
 * a thin wrapper, not a second write path): reads `<path>.bak-<backupId>`
 * and writes its text back via `writeRulesFile`, which means a restore is
 * validated, is itself backed up first (under a freshly unique id — see
 * `uniqueBackupId` — so it can never collide with or destroy the backup
 * it's restoring FROM, even within the same second), is written atomically,
 * and takes the same write lock, same as any other write. The restored
 * file's bytes are therefore byte-identical to the backup's own bytes
 * (`writeRulesFile` writes `text` verbatim).
 *
 * `backupId` is validated against `BACKUP_ID_RE` BEFORE any path is built
 * from it (review round 2 finding — `backupId` is planned to arrive straight
 * from an HTTP path segment, `POST /api/undo/:backupId`, FACTORY-662), the
 * resulting path's own directory is re-checked against `dir` as a second,
 * belt-and-braces layer, and the backup file itself goes through the same
 * `refuseEscapingSymlink` check `writeRulesFile` applies to the live rules
 * file — a `.bak-<validId>` entry that is itself a symlink pointing outside
 * `dir` is refused rather than silently followed. Exists for an UI "Undo" on
 * a change just made. Throws a clear error if the named backup does not
 * exist (or `backupId` is not in the one shape this module ever produces).
 */
export function restoreBackup(backupId: string, env: RulesEnv = process.env, io: WriteRulesIo = defaultIo()): WriteRulesResult {
  if (!BACKUP_ID_RE.test(backupId)) {
    throw new Error(`invalid backup id ${JSON.stringify(backupId)} — expected the exact shape a backup id is ever produced in (e.g. "20261005T180000Z" or "20261005T180000Z-2")`);
  }
  const path = rulesPath(env);
  const dir = dirname(path);
  const baseName = basename(path);
  const backupPath = join(dir, `${baseName}.bak-${backupId}`);
  if (dirname(backupPath) !== dir) {
    throw new Error(`backup path ${backupPath} does not resolve inside ${dir} — refusing`);
  }
  refuseEscapingSymlink(backupPath, dir, io);
  const text = io.readFile(backupPath);
  if (text === undefined) throw new Error(`no backup ${JSON.stringify(backupId)} found for ${path} (expected ${backupPath})`);
  return writeRulesFile(text, env, io);
}

/** The CURRENT rules file's etag (sha256 hex; sha256 of `""` if the file does not exist) — what a GET handler hands back for a later `writeRulesFile`'s `opts.ifMatch`. */
export function rulesEtag(env: RulesEnv = process.env, io: WriteRulesIo = defaultIo()): string {
  const path = rulesPath(env);
  return sha256(io.readFile(path) ?? "");
}

// ---------------------------------------------------------------------------
// setRuleEnabled — a pure text-level editor for ONE rule's "enabled" field.
// ---------------------------------------------------------------------------

interface MemberSpan {
  keyStart: number;
  keyEnd: number;
  valueStart: number;
  valueEnd: number;
}

/** `text[i]`, or `""` past the end — every scanner below already bounds its loops with `i < length`; this just keeps `noUncheckedIndexedAccess` quiet without a wall of `!` assertions. */
const at = (text: string, i: number): string => text[i] ?? "";

/** `text[start] === '"'`. Returns the decoded-ish key text (escapes kept raw; fine for the plain ASCII keys this module ever looks up) and the index just after the closing quote. */
function readJsonString(text: string, start: number): { value: string; end: number } {
  let i = start + 1;
  let value = "";
  while (i < text.length) {
    const c = at(text, i);
    if (c === "\\") { value += c + at(text, i + 1); i += 2; continue; }
    if (c === '"') { i++; break; }
    value += c;
    i++;
  }
  return { value, end: i };
}

/** Returns the index just past the JSON value starting at `start` (a string, object, array, number, boolean, or null). */
function skipJsonValue(text: string, start: number): number {
  const c = at(text, start);
  if (c === '"') return readJsonString(text, start).end;
  if (c === "{" || c === "[") {
    const open = c;
    const close = c === "{" ? "}" : "]";
    let depth = 0;
    let inStr = false;
    let i = start;
    for (; i < text.length; i++) {
      const ch = at(text, i);
      if (inStr) {
        if (ch === "\\") { i++; continue; }
        if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') { inStr = true; continue; }
      if (ch === open) depth++;
      else if (ch === close) { depth--; if (depth === 0) { i++; break; } }
    }
    return i;
  }
  let i = start;
  while (i < text.length && !",}] \t\n\r".includes(at(text, i))) i++;
  return i;
}

/** Scans a `{...}` object's raw text (depth 1 only — nested objects/arrays are skipped whole) for its direct members. `objStart` points at `{`, `objEnd` just past the matching `}`. */
function scanObjectMembers(text: string, objStart: number, objEnd: number): Map<string, MemberSpan> {
  const members = new Map<string, MemberSpan>();
  let i = objStart + 1;
  while (i < objEnd) {
    while (i < objEnd && /[\s,]/.test(at(text, i))) i++;
    if (i >= objEnd || at(text, i) === "}") break;
    const keyStart = i;
    const key = readJsonString(text, i);
    i = key.end;
    const keyEnd = i;
    while (i < objEnd && /\s/.test(at(text, i))) i++;
    if (at(text, i) !== ":") throw new Error(`malformed object near index ${i}: expected ":"`);
    i++;
    while (i < objEnd && /\s/.test(at(text, i))) i++;
    const valueStart = i;
    i = skipJsonValue(text, i);
    members.set(key.value, { keyStart, keyEnd, valueStart, valueEnd: i });
  }
  return members;
}

/** Scans a `[...]` array's raw text for its top-level elements' spans. `arrStart` points at `[`, `arrEnd` just past the matching `]`. */
function scanArrayElements(text: string, arrStart: number, arrEnd: number): Array<{ start: number; end: number }> {
  const elems: Array<{ start: number; end: number }> = [];
  let i = arrStart + 1;
  while (i < arrEnd) {
    while (i < arrEnd && /[\s,]/.test(at(text, i))) i++;
    if (i >= arrEnd || at(text, i) === "]") break;
    const start = i;
    i = skipJsonValue(text, i);
    elems.push({ start, end: i });
  }
  return elems;
}

function findRulesArraySpan(text: string): { start: number; end: number } {
  const docStart = text.indexOf("{");
  const docEnd = skipJsonValue(text, docStart);
  const members = scanObjectMembers(text, docStart, docEnd);
  const rules = members.get("rules");
  if (!rules) throw new Error(`expected a top-level "rules" array`);
  return { start: rules.valueStart, end: rules.valueEnd };
}

function detectIndent(text: string, pos: number): string {
  const lineStart = text.lastIndexOf("\n", pos) + 1;
  let i = lineStart;
  while (i < pos && (at(text, i) === " " || at(text, i) === "\t")) i++;
  return text.slice(lineStart, i);
}

/**
 * Edits ONE rule's `enabled` field in `text` (already-validated rules-file
 * JSON) and returns the whole document's text back, byte-identical outside
 * the one field touched: every other rule, every other field, every brace,
 * comma and bit of whitespace is left exactly as it was — this is a
 * surgical text edit, not a parse-and-reserialize, specifically so a hand
 * edited file's own formatting (indent width, key order) survives an
 * `enable`/`disable` untouched. Throws a clear error for an unknown `id`.
 */
export function setRuleEnabled(text: string, id: string, enabled: boolean): string {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    throw new Error(`invalid JSON: ${(e as Error).message}`);
  }
  if (!doc || typeof doc !== "object" || !Array.isArray((doc as Record<string, unknown>).rules)) {
    throw new Error(`expected an object with a "rules" array`);
  }
  const rules = (doc as { rules: unknown[] }).rules;
  const idx = rules.findIndex((r) => r !== null && typeof r === "object" && (r as Record<string, unknown>).id === id);
  if (idx === -1) throw new Error(`no rule with id ${JSON.stringify(id)}`);

  const arraySpan = findRulesArraySpan(text);
  const elems = scanArrayElements(text, arraySpan.start, arraySpan.end);
  const obj = elems[idx];
  if (!obj) throw new Error(`rule ${JSON.stringify(id)} was found by JSON.parse but not by the text scanner — this should be unreachable; the rules file may use a JSON feature (e.g. a duplicate key) this scanner doesn't expect`);
  const members = scanObjectMembers(text, obj.start, obj.end);

  const value = String(enabled);
  const enabledMember = members.get("enabled");
  if (enabledMember) {
    return text.slice(0, enabledMember.valueStart) + value + text.slice(enabledMember.valueEnd);
  }

  const idMember = members.get("id");
  if (!idMember) throw new Error(`rule ${JSON.stringify(id)} has no "id" field to anchor the new "enabled" field onto`);
  const indent = detectIndent(text, idMember.keyStart);
  const insertion = `,\n${indent}"enabled": ${value}`;
  return text.slice(0, idMember.valueEnd) + insertion + text.slice(idMember.valueEnd);
}
