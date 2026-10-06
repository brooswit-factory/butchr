/**
 * FACTORY-665 (PR-2) — the write-only path for the Atlassian API token file
 * (`~/.config/butchr/secrets/atlassian-token`), shared by `POST
 * /api/setup/jira` (initial setup) and `PUT /api/settings/jira/token`
 * (rotation once already configured). Every MUST from advisor-agentsafety's
 * A2 review lives here, in ONE place, so both routes get it for free:
 *
 *  - the candidate token is tested BEFORE anything touches disk
 *    (`GET /rest/api/3/myself`, `redirect: "error"` — a 3xx throws rather
 *    than being followed, 10s timeout, fixed-string errors only, the
 *    upstream body is NEVER read into anything this module returns);
 *  - on ROTATION (a token file already exists), the new token's `myself`
 *    response must report the SAME accountId as the current token's own
 *    `myself` response — a different identity is refused outright, nothing
 *    written. There is no separate "last known good identity" file: the
 *    current token IS the last known good one, by construction (every
 *    write through this module already passed this same test), so it is
 *    read and tested fresh on every rotation attempt rather than cached;
 *  - the write itself is `~/.config/butchr/secrets/` (0700, created only if
 *    absent — an existing dir's mode is never touched), a temp file
 *    `O_EXCL|O_NOFOLLOW` mode 0600 + fsync + rename, symlink refusal at the
 *    destination, and deliberately NO backup/`.prev` copy ever (unlike
 *    `settings.json`'s own write path — a leftover copy of a secret is
 *    itself a leak surface the ticket explicitly forbids for this file);
 *  - the token's value never appears in this module's return types at all
 *    — every outcome is a fixed-shape, fixed-string result the caller can
 *    log/audit/alert on directly with no redaction step of its own to get
 *    right.
 */
import { chmodSync, closeSync, constants as fsConstants, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type JiraTokenEnv = Record<string, string | undefined> & { XDG_CONFIG_HOME?: string | undefined; HOME?: string | undefined; BUTCHR_SECRETS_DIR?: string | undefined };

/** Same XDG-dir resolution `rulesPath`/`settingsFilePath` already use — one `~/.config/butchr` tree, several files/dirs under it. */
export function jiraTokenFilePath(env: JiraTokenEnv = process.env): string {
  if (env.BUTCHR_SECRETS_DIR?.trim()) return join(env.BUTCHR_SECRETS_DIR.trim(), "atlassian-token");
  const xdg = env.XDG_CONFIG_HOME?.trim() || join(env.HOME?.trim() || homedir(), ".config");
  return join(xdg, "butchr", "secrets", "atlassian-token");
}

export type MyselfTestFailure = "unauthorized" | "redirect" | "network" | "other";
export type MyselfTestResult =
  | { ok: true; accountId: string; displayName: string }
  | { ok: false; reason: MyselfTestFailure };

const TIMEOUT_MS = 10_000;

/** The narrow slice of `fetch` this module calls — same discipline as `../web/jira-connection-test.ts`'s own `FetchLike`. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Calls `GET {site}/rest/api/3/myself` with the CANDIDATE credentials
 * (never the daemon's own already-loaded ones — this is testing a NEW
 * token, unlike `../web/jira-connection-test.ts`'s `testJiraConnection`,
 * which tests the daemon's current one). `redirect: "error"` — a 3xx
 * response makes `fetch` itself throw, never followed. Never returns or
 * logs the request's own Authorization header or the response body;
 * `accountId`/`displayName` are the only fields ever extracted from a
 * successful response, and only those two.
 */
export async function testCandidateJiraToken(creds: { site: string; email: string; token: string }, fetchFn: FetchLike = fetch): Promise<MyselfTestResult> {
  const url = `${creds.site.replace(/\/+$/, "")}/rest/api/3/myself`;
  const basic = Buffer.from(`${creds.email}:${creds.token}`).toString("base64");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchFn(url, {
      method: "GET",
      headers: { authorization: `Basic ${basic}`, accept: "application/json" },
      redirect: "error",
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) return { ok: false, reason: "unauthorized" };
    if (res.status < 200 || res.status >= 300) return { ok: false, reason: "other" };
    const body: unknown = await res.json();
    const accountId = body && typeof body === "object" ? (body as Record<string, unknown>).accountId : undefined;
    const displayName = body && typeof body === "object" ? (body as Record<string, unknown>).displayName : undefined;
    if (typeof accountId !== "string" || !accountId) return { ok: false, reason: "other" };
    return { ok: true, accountId, displayName: typeof displayName === "string" ? displayName : accountId };
  } catch (e) {
    // `fetch` throws on `redirect: "error"` hitting a 3xx, on a network
    // failure, AND on the abort timer — none of these may ever surface
    // the underlying error's own message (it can embed the URL/headers).
    const message = e instanceof Error ? e.message : String(e);
    if (/redirect/i.test(message)) return { ok: false, reason: "redirect" };
    return { ok: false, reason: "network" };
  } finally {
    clearTimeout(timer);
  }
}

export function fixedMyselfTestErrorFor(reason: MyselfTestFailure): string {
  switch (reason) {
    case "unauthorized": return "Jira rejected this token (401/403).";
    case "redirect": return "Jira responded with a redirect — refusing to follow it.";
    case "network": return "could not reach Jira (network error or timeout).";
    default: return "Jira returned an unexpected response.";
  }
}

export interface JiraTokenWriteIo {
  readFile: (path: string) => string | undefined;
  mkdir: (dir: string) => void;
  modeOf: (path: string) => number | undefined;
  isSymlink: (path: string) => boolean;
  writeTempExclusive: (path: string, text: string, mode: number) => void;
  rename: (tempPath: string, path: string) => void;
  removeQuiet: (path: string) => void;
}

export function defaultJiraTokenWriteIo(): JiraTokenWriteIo {
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

export type JiraTokenWriteOutcome =
  | { ok: true; accountId: string; displayName: string; rotated: boolean }
  | { ok: false; reason: "test-failed"; error: string }
  | { ok: false; reason: "account-mismatch"; currentAccountId: string; candidateAccountId: string }
  | { ok: false; reason: "destination-symlink" }
  | { ok: false; reason: "current-token-unreadable"; error: string }
  | { ok: false; reason: "write-failed"; error: string };

/**
 * Orchestrates the full write: tests the candidate, checks rotation
 * identity (only when a current file exists — see this module's own
 * header), then writes atomically with no backup. `path`'s directory is
 * created at 0700 only if it did not already exist (an existing dir's
 * permissions are never touched, in either direction — same discipline
 * `createRulesFileExclusive`, `../rules/write-rules.ts`, follows for its
 * own directory). Throws NOTHING — every outcome, including a filesystem
 * failure during the write itself, is surfaced as a typed result; the
 * caller decides what to log/audit/alert, this module never does.
 */
export async function writeJiraToken(
  candidate: { site: string; email: string; token: string },
  path: string,
  io: JiraTokenWriteIo = defaultJiraTokenWriteIo(),
  fetchFn: FetchLike = fetch,
): Promise<JiraTokenWriteOutcome> {
  const candidateTest = await testCandidateJiraToken(candidate, fetchFn);
  if (!candidateTest.ok) return { ok: false, reason: "test-failed", error: fixedMyselfTestErrorFor(candidateTest.reason) };

  if (io.isSymlink(path)) return { ok: false, reason: "destination-symlink" };

  let rotated = false;
  const currentToken = io.readFile(path);
  if (currentToken !== undefined) {
    rotated = true;
    const currentTest = await testCandidateJiraToken({ site: candidate.site, email: candidate.email, token: currentToken.trim() }, fetchFn);
    if (!currentTest.ok) {
      // The CURRENT token no longer works (expired/revoked) — agentsafety's
      // same-accountId rule exists to stop an attacker who can already
      // write this endpoint from silently swapping identities; it is not
      // meant to brick a legitimate rotation after the old token died.
      // Refuse loudly rather than guessing either way — an operator with a
      // dead current token re-runs setup (no current file) instead.
      return { ok: false, reason: "current-token-unreadable", error: fixedMyselfTestErrorFor(currentTest.reason) };
    }
    if (currentTest.accountId !== candidateTest.accountId) {
      return { ok: false, reason: "account-mismatch", currentAccountId: currentTest.accountId, candidateAccountId: candidateTest.accountId };
    }
  }

  const dir = dirname(path);
  const dirExisted = io.modeOf(dir) !== undefined;
  io.mkdir(dir);
  if (!dirExisted) { try { chmodSync(dir, 0o700); } catch { /* best-effort, e.g. no POSIX mode bits */ } }

  const tmp = join(dir, `.atlassian-token.tmp-${process.pid}-${process.hrtime.bigint()}-${Math.random().toString(36).slice(2)}`);
  try {
    io.writeTempExclusive(tmp, candidate.token, 0o600);
    io.rename(tmp, path);
  } catch (e) {
    io.removeQuiet(tmp);
    return { ok: false, reason: "write-failed", error: `could not write the token file: ${(e as Error).message}` };
  }

  return { ok: true, accountId: candidateTest.accountId, displayName: candidateTest.displayName, rotated };
}
