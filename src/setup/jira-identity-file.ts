/**
 * FACTORY-665 (PR-2) — durable, NON-SECRET persistence for the Atlassian
 * `site`/`email` a successful `POST /api/setup/jira` captured, so a restart
 * after setup actually leaves setup mode rather than reverting to it (the
 * gap flagged in review: writing the token file alone is not enough —
 * `loadConfig` still needs a site/email from SOMEWHERE on the next
 * startup). `~/.config/butchr/jira-identity.json`, same XDG resolution
 * every other file under that directory uses (`rulesPath`, `settingsFilePath`).
 *
 * Deliberately a SEPARATE file from `settings.json` (PR-1, a different
 * branch off the same base): that module's own header is explicit that it
 * never reads/writes anything Jira-identity-shaped, and this module
 * returns the favor — neither one touches the other's file, so landing
 * both PRs introduces no shared-file write race between them.
 *
 * Same safe-write discipline `../setup/jira-token-write.ts` uses for the
 * secret file (this data isn't secret, but the write path doesn't need a
 * second design): atomic temp+rename+fsync, 0600, symlink refusal at the
 * destination, parent dir created at 0700 only if absent. No backup/`.prev`
 * — this file is simple enough that `settings.json`'s backup+undo
 * machinery would be overkill for two string fields, and it's never
 * directly operator-edited (it exists purely as this daemon's own
 * record of what the setup/rotation routes last wrote).
 */
import { chmodSync, closeSync, constants as fsConstants, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type JiraIdentityEnv = Record<string, string | undefined> & { XDG_CONFIG_HOME?: string | undefined; HOME?: string | undefined; BUTCHR_JIRA_IDENTITY_FILE?: string | undefined };

export function jiraIdentityFilePath(env: JiraIdentityEnv = process.env): string {
  if (env.BUTCHR_JIRA_IDENTITY_FILE?.trim()) return env.BUTCHR_JIRA_IDENTITY_FILE.trim();
  const xdg = env.XDG_CONFIG_HOME?.trim() || join(env.HOME?.trim() || homedir(), ".config");
  return join(xdg, "butchr", "jira-identity.json");
}

export interface JiraIdentity {
  site: string;
  email: string;
}

export interface JiraIdentityFileIo {
  readFile: (path: string) => string | undefined;
  mkdir: (dir: string) => void;
  modeOf: (path: string) => number | undefined;
  isSymlink: (path: string) => boolean;
  writeTempExclusive: (path: string, text: string, mode: number) => void;
  rename: (tempPath: string, path: string) => void;
  removeQuiet: (path: string) => void;
}

export function defaultJiraIdentityFileIo(): JiraIdentityFileIo {
  return {
    readFile: (path) => {
      try { return readFileSync(path, "utf8"); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw e; }
    },
    mkdir: (dir) => mkdirSync(dir, { recursive: true }),
    modeOf: (path) => { try { return statSync(path).mode & 0o777; } catch { return undefined; } },
    isSymlink: (path) => { try { return lstatSync(path).isSymbolicLink(); } catch { return false; } },
    writeTempExclusive: (path, text, mode) => {
      const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0);
      const fd = openSync(path, flags, mode);
      try { writeSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
    },
    rename: (tempPath, path) => {
      renameSync(tempPath, path);
      // fsync the directory so the rename itself is durable (best-effort: not every filesystem allows opening a directory).
      try { const dfd = openSync(dirname(path), fsConstants.O_RDONLY); try { fsyncSync(dfd); } finally { closeSync(dfd); } } catch { /* best-effort */ }
    },
    removeQuiet: (path) => { try { unlinkSync(path); } catch { /* best-effort */ } },
  };
}

/**
 * `undefined` on anything that isn't a clean, valid identity: absent,
 * unreadable, malformed JSON, a symlink, or missing/blank fields — NEVER
 * thrown, and never a reason to crash `loadConfig`'s own startup (the one
 * case this exists to FIX is "no identity at all", so every other failure
 * mode degrades to the exact same "treat as absent" outcome, not a new,
 * different crash). `onWarn`, when given, is called with a human-readable
 * reason for exactly the cases that are NOT plain absence (a real file
 * that failed to parse, or a symlink) — plain absence (first run, or
 * genuinely unconfigured) never warns.
 */
export function readJiraIdentity(path: string, io: JiraIdentityFileIo = defaultJiraIdentityFileIo(), onWarn?: (message: string) => void): JiraIdentity | undefined {
  if (io.isSymlink(path)) {
    onWarn?.(`${path} is a symlink — refusing to read it, treating the Atlassian site/email as unset`);
    return undefined;
  }
  const text = io.readFile(path);
  if (text === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    onWarn?.(`${path} is not valid JSON — treating the Atlassian site/email as unset`);
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    onWarn?.(`${path} is not a JSON object — treating the Atlassian site/email as unset`);
    return undefined;
  }
  const site = (parsed as Record<string, unknown>).site;
  const email = (parsed as Record<string, unknown>).email;
  if (typeof site !== "string" || !site.trim() || typeof email !== "string" || !email.trim()) {
    onWarn?.(`${path} is missing a non-empty "site" or "email" field — treating the Atlassian site/email as unset`);
    return undefined;
  }
  return { site: site.trim(), email: email.trim() };
}

/**
 * Atomic write: refuses a symlinked destination outright, creates the
 * parent dir at 0700 only if it did not already exist (never chmods an
 * existing one — same discipline `jira-token-write.ts`/`write-rules.ts`
 * both already follow), then a `O_EXCL|O_NOFOLLOW` 0600 temp file +
 * rename. Throws on a genuine filesystem failure (caller decides how to
 * surface it) — unlike `readJiraIdentity`, a WRITE failure is never
 * silently swallowed, since the caller (a just-succeeded token write) must
 * know if the identity half failed to persist.
 */
export function writeJiraIdentity(identity: JiraIdentity, path: string, io: JiraIdentityFileIo = defaultJiraIdentityFileIo()): void {
  if (io.isSymlink(path)) {
    throw new Error(`${path} is a symlink — refusing to write the Atlassian site/email through it`);
  }
  const dir = dirname(path);
  const dirExisted = io.modeOf(dir) !== undefined;
  io.mkdir(dir);
  if (!dirExisted) { try { chmodSync(dir, 0o700); } catch { /* best-effort, e.g. no POSIX mode bits */ } }

  const text = JSON.stringify({ site: identity.site, email: identity.email }, null, 2) + "\n";
  const tmp = join(dir, `.jira-identity.tmp-${process.pid}-${process.hrtime.bigint()}-${Math.random().toString(36).slice(2)}`);
  try {
    io.writeTempExclusive(tmp, text, 0o600);
    io.rename(tmp, path);
  } catch (e) {
    io.removeQuiet(tmp);
    throw e;
  }
}
