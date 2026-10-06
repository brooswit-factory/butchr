/**
 * FACTORY-658 (FACTORY-643 slice 2, GH #616) — the one library function every
 * later rules.json writer (the web write path, FACTORY-663) goes through:
 * `writeRulesFile`. Validates `nextText` through the SAME entry point the
 * daemon's own startup uses (`loadRules`, fed `nextText` via an in-memory
 * `ReadRulesFile` seam rather than disk — not a second validator) BEFORE
 * touching disk, backs up the current file, then writes atomically (temp
 * file in the same directory + fsync + rename, directory fsynced too).
 * `updateRulesFile` is the safe READ-modify-write entry point (see FACTORY
 * SAFETY REVIEW below, F1). `restoreBackup` restores a previous backup
 * through this exact same validated/atomic path, for an UI "Undo". No HTTP
 * route or UI lives in THIS ticket — this module is a plain library with no
 * CLI of its own (a scope correction on FACTORY-658 removed the `butchr
 * rules enable|disable|add` commands this module originally grew alongside;
 * `butchr rules check` is unaffected and unrelated).
 *
 * SERIALIZATION: an in-process reentrancy guard plus a cross-process
 * `O_EXCL` lock file (`.rules.lock`) are held across the
 * read-validate-backup-rename span, so two writers — in this process or
 * another — never interleave: the second fails fast with a clear error
 * (never corrupts, never silently loses the first writer's change) if it
 * contends with a LIVE holder. See `acquireRulesLock`'s own doc comment: a lock left
 * by a dead holder is never reclaimed automatically (FACTORY-673).
 *
 * OPTIMISTIC CONCURRENCY / LOST UPDATES (round-3 finding F1): a plain
 * `writeRulesFile(nextText, ...)` call is still last-writer-wins UNLESS the
 * caller passes `opts.ifMatch` — fine for a caller that already has the
 * WHOLE next document in hand with no read in between (e.g. `restoreBackup`,
 * or an operator pasting a complete file). Any caller that reads the
 * CURRENT file, computes an edit from it, and writes back MUST instead use
 * `updateRulesFile(mutator, ...)`, which reads the current text and calls
 * `mutator` on it INSIDE the same lock acquisition `writeRulesFile` itself
 * takes — there is no window between the read and the write for a
 * concurrent writer to land in, so there is no lost-update race to guard
 * against with an etag at all. FACTORY-662/663's web writers MUST use
 * `updateRulesFile` (or a freshly-read `ifMatch`) for any edit derived from
 * a prior read.
 *
 * SCOPE ENFORCEMENT (round-3 finding F2): `assertOnlyChanged(prevText,
 * nextText, allowedPaths)` deep-diffs two rules documents and throws if any
 * changed path falls outside `allowedPaths` — including an added/removed
 * rule, which is reported at the whole `"rules"` array's own path. Passed as
 * `opts.allowedPaths` to `writeRulesFile`/`updateRulesFile`, it runs INSIDE
 * the same lock, against the actual current/next text about to be written —
 * not a separate, racy check a caller could run against stale data. A
 * narrowly-scoped endpoint (e.g. a future "toggle this one rule's enabled
 * field" route) passes `["rules.*.enabled"]`; a broader one passes `["rules"]`
 * or omits the option entirely (today's unrestricted default).
 *
 * SYMLINK REFUSAL (round-3 finding F4): the rules file — and every backup
 * entry — must be a plain regular file; ANY symlink there is refused
 * outright (v1 has no safe story for a symlinked rules file: the atomic
 * rename this module relies on REPLACES whatever sits at the destination,
 * silently turning an operator's intentional `rules.json -> rules.real.json`
 * symlink into a plain file on the very first write). The temp file's own
 * open additionally passes `O_NOFOLLOW` where the platform defines it,
 * opportunistic defense-in-depth against a symlink planted at the temp path
 * between name generation and open (the name itself is unique per call —
 * pid + hrtime + random — so this is belt-and-suspenders, not the primary
 * defense).
 */
import { chmodSync, closeSync, constants as fsConstants, copyFileSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { loadRules, parseRules, rulesPath, type ReadRulesFile, type Rule, type RulesEnv } from "./rules.js";

/** Kept 0600 (the ticket's own default) when the file does not exist yet; an EXISTING file's own mode always wins. */
const DEFAULT_MODE = 0o600;
const MAX_BACKUPS = 20;
/** What an empty/absent rules document is treated as for diffing purposes (`changedRuleIds`, `assertOnlyChanged`'s `prevText` when there is no current file). */
const EMPTY_RULES_DOC_TEXT = '{"rules":[]}';

export interface WriteRulesResult {
  path: string;
  /** `null` only when the file did not exist before this write (nothing to back up). */
  backupPath: string | null;
  /** The UTC timestamp suffix of `backupPath` (e.g. `20261005T180000Z`, possibly `-2`/`-3`/... suffixed on a same-second collision) — what `restoreBackup` takes. `null` exactly when `backupPath` is. */
  backupId: string | null;
  /** Rule ids added, removed, or whose content differs from the previous file. Every id when the previous file was absent or unreadable as rules (nothing to diff against). */
  changedIds: string[];
  /** sha256 hex of the written text — pass to a later `writeRulesFile`'s `opts.ifMatch` to detect whether the file changed since. */
  etag: string;
}

/** Optional behaviour for `writeRulesFile`/`updateRulesFile`, independent of their required positional args. */
export interface WriteRulesOptions {
  /**
   * sha256 hex of the content the caller last read (sha256 of `""` if the
   * caller read "no file exists yet") — `rulesEtag` computes it the same
   * way. When set, the write is refused with NO mutation at all if the live
   * file's current etag does not match: the file changed since the caller
   * read it. Absent (the default): no check, last-writer-wins — safe ONLY
   * when the caller did not derive `nextText` from a prior read (see this
   * file's header, F1); a read-derived edit should use `updateRulesFile`
   * instead, which needs neither this option nor its race window. Not
   * accepted by `updateRulesFile` (there, the read happens under the SAME
   * lock as the write, so there is nothing to guard with an etag).
   */
  ifMatch?: string;
  /**
   * Restricts the write to changing only these paths (see `assertOnlyChanged`
   * below) — checked against the actual current/next text, INSIDE the same
   * lock. Absent (the default): unrestricted, today's behaviour exactly.
   */
  allowedPaths?: readonly string[];
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
  /**
   * FACTORY-669: hard-links `existingPath` (a just-written, fully-fsynced
   * temp file) onto `newPath`. Throws `EEXIST` if `newPath` already exists —
   * unlike `rename`, which would silently REPLACE it — the no-clobber
   * primitive `createRulesFileExclusive` below uses instead of `rename` for
   * exactly that reason.
   */
  link: (existingPath: string, newPath: string) => void;
  /** Best-effort cleanup of a leftover temp file; never throws. */
  removeQuiet: (path: string) => void;
  /** An existing file's own mode (masked to permission bits), or `undefined` if absent. */
  modeOf: (path: string) => number | undefined;
  /** Forces `path`'s mode; best-effort (e.g. a no-op where the platform has no POSIX mode bits). */
  chmod: (path: string, mode: number) => void;
  /** Directory entries, or `[]` if the directory does not exist. */
  listDir: (dir: string) => string[];
  isSymlink: (path: string) => boolean;
  mkdir: (dir: string) => void;
  /**
   * fsyncs the directory itself (durability for the rename/backup entries
   * just created in it). A platform that genuinely cannot fsync a directory
   * handle at all (`EINVAL`/`ENOTSUP`) degrades to best-effort silently;
   * every OTHER error (notably `EIO` — a real, surfaced disk failure) is
   * rethrown rather than swallowed (round-3 finding F5: a host with flaky
   * power/disk must learn about a failed fsync, not silently proceed as if
   * durable).
   */
  fsyncDir: (dir: string) => void;
  /** Acquires the cross-process write lock for `dir`, throwing (never sleeping/retrying, never reclaiming) if a lock file already exists; returns a release function. See `acquireRulesLock`'s own doc comment: a live holder, a dead holder, and corrupt content each refuse with their own message. */
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

/** `<pid>:<token>` content format for `.rules.lock` — `lockHolderPid` below extracts just the pid half, tolerating a plain-pid-only legacy value with no colon too. */
function lockHolderPid(content: string): number | null {
  const pidPart = content.split(":")[0] ?? "";
  const n = Number(pidPart);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * `O_EXCL` lock file named `.rules.lock` in the rules file's own directory,
 * holding `<pid>:<token>`. The common case — no contention — is a plain
 * exclusive create. Finding it already present, this ALWAYS REFUSES (FACTORY-673,
 * replacing round 3's rename-based stale-lock reclaim, which two racing reclaimers
 * could both win):
 *
 * 1. recorded holder pid ALIVE: "locked by another writer" (age is only
 *    reported, never a reason to take the lock — round-3 finding F6).
 * 2. content unparseable: refuses, cannot verify anything about the holder.
 * 3. recorded holder pid DEAD (a crashed writer): refuses with an actionable
 *    message naming the lock file and when it is safe to remove it. There is
 *    NO automatic cross-process reclaim: the daemon is the only writer, a
 *    crashed holder is rare, and any reclaim protocol that lets two waiters
 *    each "take over" can hand the lock to both. Failing closed is the
 *    safe default; the operator removes the file once no writer runs.
 *
 * The release function only unlinks the lock if it still holds this call's own
 * token, so it can never delete a lock someone else created after an operator
 * removed ours.
 */
export function acquireRulesLock(dir: string): () => void {
  const lockPath = join(dir, ".rules.lock");
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
    throw new Error(`rules file lock at ${lockPath} changed while being inspected — another writer is active or just finished; try again`);
  }
  const heldPid = lockHolderPid(currentContent);
  if (heldPid === null) {
    throw new Error(`rules file lock at ${lockPath} has unreadable/corrupt content (${JSON.stringify(currentContent)}) — refusing to guess whether it is live or abandoned; remove it by hand once you've confirmed no writer holds it`);
  }
  if (isPidAlive(heldPid)) {
    const ageMs = (() => { try { return Date.now() - statSync(lockPath).mtimeMs; } catch { return 0; } })();
    throw new Error(`rules file is locked by another writer (pid ${heldPid}, held ${Math.round(ageMs / 1000)}s) at ${lockPath} — refusing to write concurrently`);
  }
  throw new Error(`rules file lock at ${lockPath} was left behind by pid ${heldPid}, which is no longer running (a crashed writer); butchr never reclaims a stale lock automatically. If no butchr daemon or other rules writer is running (check: systemctl --user is-active butchr.service), remove it with: rm ${lockPath} — then retry`);
}

/** The real filesystem implementation `writeRulesFile`/`updateRulesFile`/`restoreBackup`/`rulesEtag` default to. Exported for tests that need to override a single seam (e.g. `now`) while keeping every other operation real. */
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
    link: (existingPath, newPath) => linkSync(existingPath, newPath),
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
    mkdir: (dir) => mkdirSync(dir, { recursive: true }),
    fsyncDir: (dir) => {
      try {
        const fd = openSync(dir, "r");
        try { fsyncSync(fd); } finally { closeSync(fd); }
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        // The platform genuinely cannot fsync a directory handle at all (e.g. some Windows
        // configurations) — not a real durability failure, degrade to best-effort silently.
        // Anything else (notably EIO — an actual disk failure) must propagate: see this
        // interface's own doc comment (round-3 finding F5).
        if (code === "EINVAL" || code === "ENOTSUP") return;
        throw e;
      }
    },
    acquireLock: (dir) => acquireRulesLock(dir),
    now: () => new Date(),
  };
}

/** `rules.json.bak-20261005T180000Z` — the same naming the operator uses by hand (no milliseconds). */
function utcStamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/** sha256 hex — the one hash this module uses for both `etag`/`ifMatch` and, incidentally, nowhere else (changed-id diffing uses structural `JSON.stringify` equality instead, since it needs to name WHICH rule changed, not just whether anything did). */
const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** The exact shape a backup id is ever produced in: `utcStamp`'s `YYYYMMDDTHHMMSSZ`, optionally followed by a `-N` same-second-collision suffix. A single source of truth for both generating one (`uniqueBackupId`) and validating one (`restoreBackup`, `pruneBackups`). */
const BACKUP_ID_PATTERN = String.raw`\d{8}T\d{6}Z(?:-\d{1,6})?`;
const BACKUP_ID_RE = new RegExp(`^${BACKUP_ID_PATTERN}$`);

/** Escapes `s` for safe interpolation into a `RegExp` source string. */
const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

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

/**
 * Refuses ANY symlink at `path` outright — v1 has no safe story for a
 * symlinked rules file or backup entry (round-3 finding F4; see this file's
 * own header). Applies equally to the live rules file and to a `.bak-`
 * entry `restoreBackup` is about to read.
 */
function refuseSymlink(path: string, io: WriteRulesIo): void {
  if (io.isSymlink(path)) {
    throw new Error(`${path} is a symlink — refusing to read, back up, or write through a symlinked rules file (v1 requires a plain regular file; see this module's own header)`);
  }
}

/** Only names matching `BACKUP_ID_RE` after the `<baseName>.bak-` prefix — a hand-made backup (any other name, even one sharing the same prefix) is never pruned (round-3 finding F3). */
function pruneBackups(dir: string, baseName: string, io: WriteRulesIo): void {
  const re = new RegExp(`^${escapeRegExp(baseName)}\\.bak-${BACKUP_ID_PATTERN}$`);
  // The timestamp format sorts lexically in chronological order, so a plain string sort puts the oldest first.
  const names = io.listDir(dir).filter((n) => re.test(n)).sort();
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

// ---------------------------------------------------------------------------
// assertOnlyChanged — round-3 finding F2: a deep-diff scope gate.
// ---------------------------------------------------------------------------

type PathSeg = string | number;
const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Every path (as a segment array) whose value differs between `prev` and
 * `next`. An array length change (an element added or removed) is reported
 * at the ARRAY'S OWN path, not per-element — enumerating which index an
 * insertion "shifted" everything to is not a meaningful diff; callers that
 * need to allow additions/removals allow the array's own path instead (see
 * `assertOnlyChanged`). A changed primitive, or a value whose shallow TYPE
 * differs (object vs array vs primitive), is reported at ITS OWN path —
 * diffing stops there rather than descending further.
 */
function diffPaths(prev: unknown, next: unknown, path: PathSeg[] = []): PathSeg[][] {
  if (prev === next) return [];
  if (Array.isArray(prev) && Array.isArray(next)) {
    if (prev.length !== next.length) return [path];
    const diffs: PathSeg[][] = [];
    for (let i = 0; i < prev.length; i++) diffs.push(...diffPaths(prev[i], next[i], [...path, i]));
    return diffs;
  }
  if (isPlainObject(prev) && isPlainObject(next)) {
    const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
    const diffs: PathSeg[][] = [];
    for (const k of keys) {
      if (!(k in prev) || !(k in next)) { diffs.push([...path, k]); continue; }
      diffs.push(...diffPaths(prev[k], next[k], [...path, k]));
    }
    return diffs;
  }
  if (Array.isArray(prev) !== Array.isArray(next)) return [path];
  if (isPlainObject(prev) !== isPlainObject(next)) return [path];
  return [path]; // both primitives (or one/both null), and prev !== next
}

/** Parses an allowlist entry (`"rules.*.enabled"`) into segments (`["rules", "*", "enabled"]`); `*` matches exactly one segment, of either type. */
const parsePathPattern = (pattern: string): string[] => pattern.split(".");

/** `pattern` matches `path` as a PREFIX (so an allowed subtree permits any change under it, not only at its exact depth) — `*` matches any one segment. */
function pathMatchesPattern(path: PathSeg[], pattern: string[]): boolean {
  if (path.length < pattern.length) return false;
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] !== "*" && pattern[i] !== String(path[i])) return false;
  }
  return true;
}

const formatPath = (path: PathSeg[]): string => path.map((s) => (typeof s === "number" ? `[${s}]` : s)).join(".").replace(/\.\[/g, "[");

/**
 * Deep-structurally diffs two rules-document JSON texts and throws if any
 * changed path falls outside `allowedPaths` (round-3 finding F2). An
 * added/removed rule is reported at `"rules"` itself (see `diffPaths`), so
 * an allowlist entry of `"rules"` permits that whole class of change without
 * needing to enumerate the new rule's own fields; `"rules.*.enabled"`
 * permits only an existing rule's `enabled` field to flip, in place, for
 * every rule. Pure — parses `prevText`/`nextText` itself, throws on
 * malformed JSON in either (callers only ever pass validated text in
 * practice, since `writeRulesFile`/`updateRulesFile` run this AFTER
 * `loadRules` already accepted `nextText`).
 */
export function assertOnlyChanged(prevText: string, nextText: string, allowedPaths: readonly string[]): void {
  const prev: unknown = JSON.parse(prevText);
  const next: unknown = JSON.parse(nextText);
  const patterns = allowedPaths.map(parsePathPattern);
  for (const diff of diffPaths(prev, next)) {
    if (!patterns.some((p) => pathMatchesPattern(diff, p))) {
      throw new Error(`change at "${formatPath(diff)}" is not in the allowed set (${allowedPaths.join(", ")})`);
    }
  }
}

/** Rules files currently being written BY THIS PROCESS — the in-process half of the reentrancy guard (see `withWriteLock`). */
const activeWriters = new Set<string>();

/**
 * Holds BOTH locks (in-process reentrancy guard, then the cross-process
 * `.rules.lock` file) across `fn`, released in reverse order even if `fn`
 * throws. A reentrant call on the SAME path from the SAME process (a bug —
 * e.g. something calling `writeRulesFile` recursively from inside a
 * mutator) fails fast with a clear error instead of deadlocking on a lock
 * file this same process already holds.
 */
function withWriteLock<T>(path: string, dir: string, io: WriteRulesIo, fn: () => T): T {
  if (activeWriters.has(path)) {
    throw new Error(`${path}: already being written by this same process (reentrant writeRulesFile/updateRulesFile/restoreBackup call) — refusing`);
  }
  activeWriters.add(path);
  let release: (() => void) | undefined;
  try {
    io.mkdir(dir); // the lock file needs its directory to exist
    release = io.acquireLock(dir); // may throw (live/stale/corrupt lock): the guard entry must still be cleared below
    return fn();
  } finally {
    release?.();
    activeWriters.delete(path);
  }
}

/**
 * The shared tail of every write: validates `nextText` through `loadRules`
 * (the same entry point startup uses), optionally enforces `allowedPaths`
 * (`assertOnlyChanged`, against the REAL current/next text, inside the
 * lock), computes the changed-id diff, backs up the current file (if any)
 * to `<path>.bak-<UTC timestamp>` (fsynced, pruned to the newest 20 —
 * hand-made backups excluded, F3), then writes `nextText` atomically (temp
 * file in the same directory, `O_EXCL`+`O_NOFOLLOW`, fsync, rename,
 * directory fsync), preserving the current file's mode (0600 for a
 * brand-new file). Must be called from inside `withWriteLock`.
 */
function commitWrite(path: string, dir: string, baseName: string, io: WriteRulesIo, env: RulesEnv, currentText: string | undefined, nextText: string, allowedPaths: readonly string[] | undefined): WriteRulesResult {
  const fakeRead: ReadRulesFile = (p) => (p === path ? nextText : undefined);
  const { rules: nextRules } = loadRules(env, fakeRead);

  if (allowedPaths) {
    assertOnlyChanged(currentText ?? EMPTY_RULES_DOC_TEXT, nextText, allowedPaths);
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
}

/**
 * Validates `nextText` through the SAME entry point the daemon's own startup
 * uses BEFORE touching disk or acquiring any lock, so a doomed-to-fail call
 * never contends for the lock or creates the rules directory — on any
 * validation problem, throws with every problem (same multi-line
 * `Error#message` shape `loadRules` throws) and writes NOTHING: no temp
 * file, no backup, no mutation of the existing file, no lock ever taken.
 *
 * On success: acquires the read-validate-backup-rename lock, optionally
 * refuses on an `opts.ifMatch` mismatch or an `opts.allowedPaths` violation
 * (no mutation at all either way), then commits via `commitWrite`.
 *
 * `nextText` here is the WHOLE next document, already decided by the
 * caller — safe to call directly only when the caller did NOT derive it
 * from reading the current file first (see this module's header, F1); a
 * read-derived edit should use `updateRulesFile` instead.
 */
export function writeRulesFile(nextText: string, env: RulesEnv = process.env, io: WriteRulesIo = defaultIo(), opts: WriteRulesOptions = {}): WriteRulesResult {
  const path = rulesPath(env);
  const dir = dirname(path);
  const baseName = basename(path);

  // Fast, lock-free rejection of syntactically-doomed input — same entry point `commitWrite` (and
  // `src/daemon/index.ts` at startup) uses; the real validation happens again inside the lock via
  // `commitWrite`, this call's result is discarded, kept purely for the "no IO on invalid input" guarantee.
  const fakeRead: ReadRulesFile = (p) => (p === path ? nextText : undefined);
  loadRules(env, fakeRead);

  return withWriteLock(path, dir, io, () => {
    refuseSymlink(path, io);
    const currentText = io.readFile(path);
    if (opts.ifMatch !== undefined) {
      const currentEtag = sha256(currentText ?? "");
      if (opts.ifMatch !== currentEtag) {
        throw new Error(`${path}: etag mismatch — expected ${opts.ifMatch}, found ${currentEtag}; the file changed since it was read, reload and retry`);
      }
    }
    return commitWrite(path, dir, baseName, io, env, currentText, nextText, opts.allowedPaths);
  });
}

/**
 * THE safe read-modify-write entry point (round-3 finding F1): `mutator`
 * receives the CURRENT text (or `undefined` if no file exists yet) and
 * returns the next text — entirely INSIDE the same lock acquisition
 * `writeRulesFile` itself takes, so there is no window between the read and
 * the write for a concurrent writer to land in. No `ifMatch` option exists
 * here (nor is one needed): the read happens under the very lock that
 * serializes every writer, so there is nothing for an etag to guard against.
 * FACTORY-662/663's web writers MUST use this (or an explicit, freshly-read
 * `ifMatch` on `writeRulesFile`) for any edit derived from a prior read.
 */
export function updateRulesFile(mutator: (currentText: string | undefined) => string, env: RulesEnv = process.env, io: WriteRulesIo = defaultIo(), opts: Pick<WriteRulesOptions, "allowedPaths"> = {}): WriteRulesResult {
  const path = rulesPath(env);
  const dir = dirname(path);
  const baseName = basename(path);
  return withWriteLock(path, dir, io, () => {
    refuseSymlink(path, io);
    const currentText = io.readFile(path);
    const nextText = mutator(currentText);
    return commitWrite(path, dir, baseName, io, env, currentText, nextText, opts.allowedPaths);
  });
}

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
 * from it (round-2 finding — `backupId` is planned to arrive straight from
 * an HTTP path segment, `POST /api/undo/:backupId`, FACTORY-662), the
 * resulting path's own directory is re-checked against `dir` as a second,
 * belt-and-braces layer, and the backup file itself goes through the same
 * `refuseSymlink` check the live rules file does. Exists for an UI "Undo" on
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
  refuseSymlink(backupPath, io);
  const text = io.readFile(backupPath);
  if (text === undefined) throw new Error(`no backup ${JSON.stringify(backupId)} found for ${path} (expected ${backupPath})`);
  return writeRulesFile(text, env, io);
}

/** The CURRENT rules file's etag (sha256 hex; sha256 of `""` if the file does not exist) — what a GET handler hands back for a later `writeRulesFile`'s `opts.ifMatch`. */
export function rulesEtag(env: RulesEnv = process.env, io: WriteRulesIo = defaultIo()): string {
  const path = rulesPath(env);
  return sha256(io.readFile(path) ?? "");
}

/**
 * FACTORY-669 — true no-clobber publish of a BRAND-NEW rules file, for
 * `../rules/seed-first-run.ts`'s daemon-startup seed and nothing else.
 *
 * `writeRulesFile`/`commitWrite` above publish via `rename`, which is safe
 * there only because the cross-process `.rules.lock` already serializes
 * every OTHER writer of this module — nothing else can place a file at
 * `path` between that call's own `readFile` and its `rename`. This function
 * runs at daemon startup, OUTSIDE that lock, specifically to create a file
 * that is NOT supposed to exist yet, so its no-clobber guarantee has to come
 * from the filesystem itself rather than from serialization: `io.link`
 * hard-links a fully-written, fsynced temp file onto `path` and fails
 * atomically with `EEXIST` if anything is already there (a real file, an
 * empty one, an invalid one — `link` does not care what, only that an entry
 * exists), so there is no window, however narrow, in which this could
 * overwrite one. A pre-existing symlink at `path` is refused outright before
 * any of that (round-3 finding F4's same rule, reused here).
 *
 * `text` is validated through `loadRules` — the exact entry point the
 * daemon's own startup and `writeRulesFile` both use — BEFORE anything
 * touches disk, with an empty `RulesEnv` (`path` is irrelevant to that
 * validation; only the document's own content is being checked). `path`'s
 * directory is created at mode 0700 ONLY when this call itself creates it
 * (FACTORY-685, L2) — an EXISTING directory's permissions are never
 * touched, in either direction: a pre-existing `0755` dir is never silently
 * narrowed to `0700` (the bug this fixes — the previous unconditional
 * `io.chmod(dir, 0o700)` did exactly that), and a pre-existing `0500` dir is
 * never widened to `0700` either. When an existing dir is already wider
 * than `0700` (carries any permission bit outside it — group/other
 * read/write/execute), `onWarn` (when given) is called with a message
 * naming the dir and its mode; this function still proceeds (the seed
 * itself is not refused over a pre-existing dir's own permissions, which
 * predate and are outside this call's control) — logging/alerting on that
 * warning is the caller's job, same discipline `seed-first-run.ts`'s own
 * header documents for its typed outcomes. The published file is mode
 * 0600; both the file and (when created) the directory are fsynced, same
 * discipline every other write in this module follows.
 *
 * Deliberately does NOT take `.rules.lock`: that lock protects concurrent
 * WRITES to an already-established file, a different hazard from this
 * function's own "does anything already exist here" race, which `link`'s
 * own atomicity already closes without it. Throws (never partially writes)
 * on invalid input, an existing/symlinked destination, or any filesystem
 * failure; the temp file is always cleaned up.
 */
export function createRulesFileExclusive(path: string, text: string, io: WriteRulesIo = defaultIo(), opts: { onWarn?: (message: string) => void } = {}): void {
  loadRules({}, () => text); // throws on invalid input; nothing below runs

  const dir = dirname(path);
  const dirModeBefore = io.modeOf(dir);
  io.mkdir(dir);
  if (dirModeBefore === undefined) {
    io.chmod(dir, 0o700);
  } else if ((dirModeBefore & ~0o700) !== 0) {
    opts.onWarn?.(`${dir} already existed at mode ${(dirModeBefore & 0o777).toString(8)}, wider than 0700 — the first-run seed never narrows an existing directory's permissions, left as-is`);
  }

  if (io.isSymlink(path) || io.readFile(path) !== undefined) {
    throw new Error(`${path} already exists — refusing to replace it (first-run seed is no-clobber)`);
  }

  const tmp = join(dir, `.${basename(path)}.seed-tmp-${process.pid}-${process.hrtime.bigint()}-${Math.random().toString(36).slice(2)}`);
  try {
    io.writeTempExclusive(tmp, text, 0o600);
    io.chmod(tmp, 0o600); // belt-and-suspenders against umask narrowing the requested mode, same as commitWrite's own tmp chmod
    try {
      io.link(tmp, path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(`${path} was created concurrently — refusing to replace it (first-run seed is no-clobber)`);
      }
      throw e;
    }
  } finally {
    io.removeQuiet(tmp);
  }
  io.fsyncDir(dir);
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
 *
 * Round-3 finding F2's own text flagged this hand-written scanner as an
 * unverified splice; a caller using it is expected to pass
 * `nextText` through `assertOnlyChanged(text, nextText, ["rules.*.enabled"])`
 * (directly, or via `opts.allowedPaths` on `updateRulesFile`) before
 * trusting the result — this function itself stays a pure string
 * transform with no disk access, so it cannot enforce that on its own.
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
