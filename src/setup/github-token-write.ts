/**
 * local/ui — the write-only path for the GitHub token file, the GitHub twin
 * of `./jira-token-write.ts` and held to the same rules:
 *
 *  - the candidate token is tested BEFORE anything touches disk (`GET
 *    https://api.github.com/user`, `redirect: "error"`, 10s timeout,
 *    fixed-string errors only; `login` is the one field ever read from the
 *    response);
 *  - when a token file already exists and its token still works, the new
 *    token must report the SAME login, so a write can't silently swap
 *    identities. A current token GitHub rejects outright (401/403) may be
 *    replaced by any working token, since fine-grained tokens expire and a
 *    dead one would otherwise brick every rotation. A current token that
 *    can't be checked at all (network, redirect, odd response) refuses;
 *  - the write is a temp file `O_EXCL|O_NOFOLLOW` mode 0600 in the
 *    destination's own directory, fsync, rename, no backup copy ever. The
 *    rename replaces the old file (and its mode), so the result is 0600
 *    whatever the old file's mode was;
 *  - the token value never appears in any return value.
 *
 * Destination policy (which path, whether it may be created) is decided by
 * the caller (`./secret-target.ts`, `./secret-destination.ts`); this module
 * only refuses a symlinked destination, same as the Jira writer.
 */
import { chmodSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { defaultJiraTokenWriteIo, type FetchLike, type JiraTokenWriteIo } from "./jira-token-write.js";

export type GithubTokenEnv = Record<string, string | undefined> & { XDG_CONFIG_HOME?: string | undefined; HOME?: string | undefined; BUTCHR_SECRETS_DIR?: string | undefined };

/** The managed default, beside `secrets/atlassian-token` (`jiraTokenFilePath`), resolved the same way. */
export function githubTokenFilePath(env: GithubTokenEnv = process.env): string {
  if (env.BUTCHR_SECRETS_DIR?.trim()) return join(env.BUTCHR_SECRETS_DIR.trim(), "github-token");
  const xdg = env.XDG_CONFIG_HOME?.trim() || join(env.HOME?.trim() || homedir(), ".config");
  return join(xdg, "butchr", "secrets", "github-token");
}

export const GITHUB_API = "https://api.github.com";
const TIMEOUT_MS = 10_000;

export type GithubCallFailure = "unauthorized" | "redirect" | "network" | "other";
export type GithubUserTestResult = { ok: true; login: string } | { ok: false; reason: GithubCallFailure };

export function githubHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "butchr" };
}

/** `GET /user` with the CANDIDATE token. Never returns or logs the request's Authorization header or the response body; `login` is the only field read. */
export async function testCandidateGithubToken(token: string, fetchFn: FetchLike = fetch): Promise<GithubUserTestResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchFn(`${GITHUB_API}/user`, { method: "GET", headers: githubHeaders(token), redirect: "error", signal: controller.signal });
    if (res.status === 401 || res.status === 403) return { ok: false, reason: "unauthorized" };
    if (res.status < 200 || res.status >= 300) return { ok: false, reason: "other" };
    const body: unknown = await res.json();
    const login = body && typeof body === "object" ? (body as Record<string, unknown>).login : undefined;
    if (typeof login !== "string" || !login) return { ok: false, reason: "other" };
    return { ok: true, login };
  } catch (e) {
    // Never surface the thrown error's own message: it can embed the URL/headers.
    const message = e instanceof Error ? e.message : String(e);
    if (/redirect/i.test(message)) return { ok: false, reason: "redirect" };
    return { ok: false, reason: "network" };
  } finally {
    clearTimeout(timer);
  }
}

export function fixedGithubTestErrorFor(reason: GithubCallFailure): string {
  switch (reason) {
    case "unauthorized": return "GitHub rejected this token (401/403).";
    case "redirect": return "GitHub responded with a redirect — refusing to follow it.";
    case "network": return "could not reach GitHub (network error or timeout).";
    default: return "GitHub returned an unexpected response.";
  }
}

export type GithubTokenWriteOutcome =
  | { ok: true; login: string; rotated: boolean }
  | { ok: false; reason: "test-failed"; error: string }
  | { ok: false; reason: "login-mismatch"; currentLogin: string; candidateLogin: string }
  | { ok: false; reason: "current-token-unverifiable"; error: string }
  | { ok: false; reason: "destination-symlink" }
  | { ok: false; reason: "write-failed"; error: string };

/**
 * Tests the candidate, applies the same-login rule against the current
 * file's token (when there is one), then writes atomically with no backup.
 * `opts.createDir` (the managed `secrets/` path only) creates a missing
 * directory at 0700; an existing directory's mode is never touched. Throws
 * nothing: every outcome is a typed result.
 */
export async function writeGithubToken(
  token: string,
  path: string,
  opts: { createDir: boolean },
  io: JiraTokenWriteIo = defaultJiraTokenWriteIo(),
  fetchFn: FetchLike = fetch,
): Promise<GithubTokenWriteOutcome> {
  const candidate = await testCandidateGithubToken(token, fetchFn);
  if (!candidate.ok) return { ok: false, reason: "test-failed", error: fixedGithubTestErrorFor(candidate.reason) };

  if (io.isSymlink(path)) return { ok: false, reason: "destination-symlink" };

  let rotated = false;
  const current = io.readFile(path)?.trim();
  if (current) {
    rotated = true;
    const currentTest = await testCandidateGithubToken(current, fetchFn);
    if (currentTest.ok && currentTest.login.toLowerCase() !== candidate.login.toLowerCase()) {
      return { ok: false, reason: "login-mismatch", currentLogin: currentTest.login, candidateLogin: candidate.login };
    }
    if (!currentTest.ok && currentTest.reason !== "unauthorized") {
      return { ok: false, reason: "current-token-unverifiable", error: fixedGithubTestErrorFor(currentTest.reason) };
    }
  }

  const dir = dirname(path);
  if (opts.createDir) {
    const dirExisted = io.modeOf(dir) !== undefined;
    io.mkdir(dir);
    if (!dirExisted) { try { chmodSync(dir, 0o700); } catch { /* best-effort, e.g. no POSIX mode bits */ } }
  }

  const tmp = join(dir, `.${basename(path)}.tmp-${process.pid}-${process.hrtime.bigint()}-${Math.random().toString(36).slice(2)}`);
  try {
    io.writeTempExclusive(tmp, token, 0o600);
    io.rename(tmp, path);
  } catch (e) {
    io.removeQuiet(tmp);
    return { ok: false, reason: "write-failed", error: `could not write the token file: ${(e as Error).message}` };
  }
  return { ok: true, login: candidate.login, rotated };
}
