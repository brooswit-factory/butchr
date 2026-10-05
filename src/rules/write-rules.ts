/**
 * FACTORY-658 (FACTORY-643 slice 2, GH #616) — the one library function every
 * later rules.json writer (the CLI today, a web endpoint in slice 3) goes
 * through: `writeRulesFile`. Validates `nextText` with the SAME parser
 * `loadRules` uses (`parseRules`, reused verbatim, never re-implemented)
 * BEFORE touching disk, backs up the current file, then writes atomically
 * (temp file in the same directory + fsync + rename). No HTTP route reads
 * this in this slice — see the ticket for scope.
 *
 * CONCURRENT WRITERS: each temp file name is unique per call (pid + hrtime +
 * random) and opened with O_EXCL (the `"wx"` flag), so two concurrent
 * writers never share one temp file or interleave bytes into it. The final
 * `rename` is a single atomic syscall, so a reader always sees either the
 * OLD complete file or a NEW complete file, never a mix of the two. This
 * does NOT serialize a read-modify-write race — the last writer to `rename`
 * wins and the other caller's change is simply lost (never merged, never
 * corrupted) — the same documented limitation `src/resources/link-store.ts`
 * already carries for its own atomic write. A real cross-process lock that
 * SERIALIZES updates is out of scope for this slice.
 *
 * SYMLINK REFUSAL: a rules file that is itself a symlink pointing outside
 * its own directory is refused before any read, backup, or write touches
 * it — otherwise `copyFileSync`/`readFileSync` would silently follow the
 * link and back up or report the mode of whatever it points to (e.g. a
 * crafted symlink pointing at an unrelated file elsewhere on disk).
 */
import { closeSync, copyFileSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parseRules, rulesPath, type ReadRulesFile, type Rule, type RulesEnv } from "./rules.js";

/** Kept 0600 (the ticket's own default) when the file does not exist yet; an EXISTING file's own mode always wins. */
const DEFAULT_MODE = 0o600;
const MAX_BACKUPS = 20;

export interface WriteRulesResult {
  path: string;
  /** `null` only when the file did not exist before this write (nothing to back up). */
  backupPath: string | null;
  /** Rule ids added, removed, or whose content differs from the previous file. Every id when the previous file was absent or unreadable as rules (nothing to diff against). */
  changedIds: string[];
}

/**
 * Every filesystem primitive this module touches, injectable for tests
 * (simulating a failed rename, a pre-seeded set of old backups, a fixed
 * clock for deterministic backup timestamps) exactly as `loadRules`'s own
 * `read: ReadRulesFile` seam already allows for reads.
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
  /** Directory entries, or `[]` if the directory does not exist. */
  listDir: (dir: string) => string[];
  isSymlink: (path: string) => boolean;
  /** Resolves a path's real, symlink-free location. */
  realpath: (path: string) => string;
  mkdir: (dir: string) => void;
  now: () => Date;
}

function defaultIo(): WriteRulesIo {
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
      const fd = openSync(path, "wx", mode);
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
    listDir: (dir) => {
      try { return readdirSync(dir); } catch { return []; }
    },
    isSymlink: (path) => {
      try { return lstatSync(path).isSymbolicLink(); } catch { return false; }
    },
    realpath: (path) => realpathSync(path),
    mkdir: (dir) => mkdirSync(dir, { recursive: true }),
    now: () => new Date(),
  };
}

/** `rules.json.bak-20261005T180000Z` — the same naming the operator uses by hand (no milliseconds). */
function utcStamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
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

/**
 * Validates `nextText` with `parseRules` (same path `loadRules` uses) BEFORE
 * touching disk. On success: backs up the current file (if any) to
 * `<path>.bak-<UTC timestamp>`, pruning to the newest 20 backups, then writes
 * `nextText` atomically (temp file in the same directory, `O_EXCL`, fsync,
 * rename), preserving the current file's mode (0600 for a brand-new file).
 * On any validation problem, throws with every problem (same multi-line
 * `Error#message` shape `loadRules` throws) and writes NOTHING — no temp
 * file, no backup, no mutation of the existing file.
 */
export function writeRulesFile(nextText: string, env: RulesEnv = process.env, io: WriteRulesIo = defaultIo()): WriteRulesResult {
  const path = rulesPath(env);
  const dir = dirname(path);
  const baseName = basename(path);

  let doc: unknown;
  try {
    doc = JSON.parse(nextText);
  } catch (e) {
    throw new Error(`${path}: invalid JSON: ${(e as Error).message}`);
  }
  const nextRules = parseRules(doc, path);

  refuseEscapingSymlink(path, dir, io);

  const currentText = io.readFile(path);
  const changedIds = changedRuleIds(currentText, nextRules, path);

  io.mkdir(dir);

  let backupPath: string | null = null;
  if (currentText !== undefined) {
    backupPath = join(dir, `${baseName}.bak-${utcStamp(io.now())}`);
    io.copyFile(path, backupPath);
    pruneBackups(dir, baseName, io);
  }

  const mode = io.modeOf(path) ?? DEFAULT_MODE;
  const tmp = join(dir, `.${baseName}.tmp-${process.pid}-${process.hrtime.bigint()}-${Math.random().toString(36).slice(2)}`);
  try {
    io.writeTempExclusive(tmp, nextText, mode);
    io.rename(tmp, path);
  } catch (e) {
    io.removeQuiet(tmp);
    throw e;
  }

  return { path, backupPath, changedIds };
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
