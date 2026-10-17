/**
 * local/ui — `POST /api/settings/github/test`'s own logic, the GitHub twin of
 * `./jira-connection-test.ts`: calls GitHub with the token butchr's own
 * config names (never anything from the request), `GET /user` for the login
 * and `GET /orgs/{org}` for each configured org. Returns only fixed strings,
 * the login, and status classes: never the token, a response body, or a
 * thrown error's message.
 *
 * It tests what the next start would load (`githubTestInputs`), not what
 * this daemon started with, so the result matches the org list the
 * Settings page shows right after a save.
 */
import { readFileSync } from "node:fs";
import type { HttpStatusClass } from "./jira-connection-test.js";
import { GITHUB_API, githubHeaders } from "../setup/github-token-write.js";
import { expandHomePath } from "../config/home-path.js";

export interface GithubOrgTestResult {
  org: string;
  ok: boolean;
  httpStatusClass: HttpStatusClass;
}

export interface GithubTestResult {
  ok: boolean;
  login?: string;
  httpStatusClass: HttpStatusClass;
  error?: string;
  orgs: GithubOrgTestResult[];
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

const TIMEOUT_MS = 10_000;
const MAX_ORGS = 20;

function classify(status: number): HttpStatusClass {
  if (status >= 200 && status < 300) return "2xx";
  if (status === 401 || status === 403) return "401/403";
  return "other";
}

async function call(url: string, token: string, fetchFn: FetchLike): Promise<{ httpStatusClass: HttpStatusClass; res?: Response }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchFn(url, { method: "GET", headers: githubHeaders(token), redirect: "manual", signal: controller.signal });
    return { httpStatusClass: classify(res.status), res };
  } catch {
    return { httpStatusClass: "network" };
  } finally {
    clearTimeout(timer);
  }
}

function fixedErrorFor(httpStatusClass: HttpStatusClass): string {
  switch (httpStatusClass) {
    case "401/403": return "GitHub rejected this token (401/403).";
    case "network": return "could not reach GitHub (network error or timeout).";
    default: return "GitHub returned an unexpected response.";
  }
}

/**
 * The token and orgs a start with this env would load: `GITHUB_TOKEN_FILE`'s
 * contents (read now; `~/` expanded like `loadConfig` does) and
 * `BUTCHR_GITHUB_ORGS`. A missing or unreadable file is just "no token".
 */
export function githubTestInputs(env: Readonly<Record<string, string | undefined>>, readFile: (path: string) => string = (p) => readFileSync(p, "utf8")): { token: string | undefined; orgs: string[] } {
  const orgs = (env.BUTCHR_GITHUB_ORGS ?? "").split(",").map((o) => o.trim()).filter(Boolean);
  const file = env.GITHUB_TOKEN_FILE?.trim();
  if (!file) return { token: undefined, orgs };
  try {
    return { token: readFile(expandHomePath(file, env)).trim() || undefined, orgs };
  } catch {
    return { token: undefined, orgs };
  }
}

export async function testGithubConnection(token: string | undefined, orgs: readonly string[], fetchFn: FetchLike = fetch): Promise<GithubTestResult> {
  if (!token) return { ok: false, httpStatusClass: "other", error: "No GitHub token is set.", orgs: [] };
  const user = await call(`${GITHUB_API}/user`, token, fetchFn);
  if (user.httpStatusClass !== "2xx" || !user.res) return { ok: false, httpStatusClass: user.httpStatusClass, error: fixedErrorFor(user.httpStatusClass), orgs: [] };
  let login: unknown;
  try {
    const body: unknown = await user.res.json();
    login = body && typeof body === "object" ? (body as Record<string, unknown>).login : undefined;
  } catch { /* checked just below */ }
  if (typeof login !== "string" || !login) return { ok: false, httpStatusClass: "2xx", error: "GitHub answered without a login, so this doesn't look like a GitHub token.", orgs: [] };
  const orgResults: GithubOrgTestResult[] = [];
  for (const org of orgs.slice(0, MAX_ORGS)) {
    const result = await call(`${GITHUB_API}/orgs/${encodeURIComponent(org)}`, token, fetchFn);
    orgResults.push({ org, ok: result.httpStatusClass === "2xx", httpStatusClass: result.httpStatusClass });
  }
  const failedOrgs = orgResults.filter((o) => !o.ok).map((o) => o.org);
  return {
    ok: failedOrgs.length === 0,
    login,
    httpStatusClass: "2xx",
    ...(failedOrgs.length ? { error: `This token can't see ${failedOrgs.join(", ")}.` } : {}),
    orgs: orgResults,
  };
}
