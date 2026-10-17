/**
 * local/ui — the Zendesk and Trello credentials the Settings page can set,
 * held to the same rules as the GitHub token (`./github-token-write.ts`):
 *
 *  - every candidate is tested against the provider BEFORE anything touches
 *    disk (`redirect: "error"`, 10s timeout, fixed-string errors; a thrown
 *    error's own message is never surfaced, since Trello's URL carries the
 *    key and token);
 *  - replacing credentials that still work must keep the same account (the
 *    provider's own user/member id), so a swap to another identity is
 *    refused rather than silently applied;
 *  - each file is written atomically (temp file `O_EXCL|O_NOFOLLOW` 0600 in
 *    the same directory, rename), never through a symlink, never with a
 *    backup copy.
 *
 * Nothing here returns or logs a secret value. Destination policy (which
 * path, whether its directory may be created) is the caller's
 * (`./secret-target.ts`).
 */
import { chmodSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { defaultJiraTokenWriteIo, type FetchLike, type JiraTokenWriteIo } from "./jira-token-write.js";

export type SecretsEnv = Record<string, string | undefined> & { XDG_CONFIG_HOME?: string | undefined; HOME?: string | undefined; BUTCHR_SECRETS_DIR?: string | undefined };

export const ZENDESK_TOKEN_FILE_NAME = "zendesk-oauth-token";
export const TRELLO_KEY_FILE_NAME = "trello-api-key";
export const TRELLO_TOKEN_FILE_NAME = "trello-token";

/** `secrets/<fileName>`, resolved the same way as `jiraTokenFilePath`/`githubTokenFilePath`. */
export function managedSecretPath(fileName: string, env: SecretsEnv = process.env): string {
  if (env.BUTCHR_SECRETS_DIR?.trim()) return join(env.BUTCHR_SECRETS_DIR.trim(), fileName);
  const xdg = env.XDG_CONFIG_HOME?.trim() || join(env.HOME?.trim() || homedir(), ".config");
  return join(xdg, "butchr", "secrets", fileName);
}

const TIMEOUT_MS = 10_000;

export type ProviderName = "Zendesk" | "Trello";
export type ProviderCallFailure = "unauthorized" | "redirect" | "network" | "other";
/** `id` is the provider's own account id (compared on rotation); `label` is what the page shows (an email or username). */
export type IdentityTest = { ok: true; id: string; label: string } | { ok: false; reason: ProviderCallFailure };

async function getJson(url: string, headers: Record<string, string>, fetchFn: FetchLike): Promise<{ ok: true; body: unknown } | { ok: false; reason: ProviderCallFailure }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchFn(url, { method: "GET", headers, redirect: "error", signal: controller.signal });
    if (res.status === 401 || res.status === 403) return { ok: false, reason: "unauthorized" };
    if (res.status < 200 || res.status >= 300) return { ok: false, reason: "other" };
    return { ok: true, body: await res.json() };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: /redirect/i.test(message) ? "redirect" : "network" };
  } finally {
    clearTimeout(timer);
  }
}

function field(obj: unknown, key: string): unknown {
  return obj && typeof obj === "object" ? (obj as Record<string, unknown>)[key] : undefined;
}

/**
 * `GET https://<subdomain>.zendesk.com/api/v2/users/me.json` with the
 * candidate OAuth token. Zendesk answers a request it can't authenticate
 * with an anonymous user (`id: null`), which counts as unauthorized here.
 */
export async function testZendeskToken(subdomain: string, token: string, fetchFn: FetchLike = fetch): Promise<IdentityTest> {
  const result = await getJson(`https://${subdomain}.zendesk.com/api/v2/users/me.json`, { authorization: `Bearer ${token}`, accept: "application/json", "user-agent": "butchr" }, fetchFn);
  if (!result.ok) return result;
  const user = field(result.body, "user");
  const id = field(user, "id");
  if (typeof id !== "number" && (typeof id !== "string" || !id)) return { ok: false, reason: "unauthorized" };
  const email = field(user, "email");
  const name = field(user, "name");
  return { ok: true, id: String(id), label: typeof email === "string" && email ? email : typeof name === "string" && name ? name : String(id) };
}

/** `GET https://api.trello.com/1/members/me` with the candidate key and token (Trello takes both as query parameters). */
export async function testTrelloCredentials(apiKey: string, token: string, fetchFn: FetchLike = fetch): Promise<IdentityTest> {
  const query = new URLSearchParams({ key: apiKey, token, fields: "id,username" });
  const result = await getJson(`https://api.trello.com/1/members/me?${query}`, { accept: "application/json", "user-agent": "butchr" }, fetchFn);
  if (!result.ok) return result;
  const id = field(result.body, "id");
  if (typeof id !== "string" || !id) return { ok: false, reason: "other" };
  const username = field(result.body, "username");
  return { ok: true, id, label: typeof username === "string" && username ? username : id };
}

/** `GET https://api.trello.com/1/boards/<id>`: whether these credentials can see the configured board. Only its `name` is read. */
export async function testTrelloBoard(boardId: string, apiKey: string, token: string, fetchFn: FetchLike = fetch): Promise<{ ok: true; name: string } | { ok: false; reason: ProviderCallFailure | "not-found" }> {
  const query = new URLSearchParams({ key: apiKey, token, fields: "name" });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchFn(`https://api.trello.com/1/boards/${encodeURIComponent(boardId)}?${query}`, { method: "GET", headers: { accept: "application/json", "user-agent": "butchr" }, redirect: "error", signal: controller.signal });
    if (res.status === 404) return { ok: false, reason: "not-found" };
    if (res.status === 401 || res.status === 403) return { ok: false, reason: "unauthorized" };
    if (res.status < 200 || res.status >= 300) return { ok: false, reason: "other" };
    const name = field(await res.json(), "name");
    return { ok: true, name: typeof name === "string" ? name : boardId };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: /redirect/i.test(message) ? "redirect" : "network" };
  } finally {
    clearTimeout(timer);
  }
}

export function providerTestError(provider: ProviderName, reason: ProviderCallFailure): string {
  switch (reason) {
    case "unauthorized": return `${provider} rejected the credentials (401/403)`;
    case "redirect": return `${provider} answered with a redirect — not following it`;
    case "network": return `couldn't reach ${provider} (network error or timeout)`;
    default: return `${provider} gave an unexpected answer`;
  }
}

export interface SecretFile {
  path: string;
  value: string;
  /** Only a managed `secrets/` path may have its directory created (0700); an env-named file's directory must already exist. */
  createDir: boolean;
}

export type VerifiedWriteOutcome =
  | { ok: true; label: string; rotated: boolean }
  | { ok: false; reason: "test-failed"; error: string }
  | { ok: false; reason: "destination-symlink"; path: string }
  | { ok: false; reason: "current-unverifiable"; error: string }
  | { ok: false; reason: "identity-mismatch"; currentLabel: string; candidateLabel: string }
  | { ok: false; reason: "write-failed"; error: string };

/**
 * Tests the candidate values (`test`, given them in `files` order), refuses
 * a symlinked destination, and, when every file already holds a value and
 * those still work, refuses a candidate for a different account. Then writes
 * each file atomically, in order. A failure part-way leaves the earlier
 * files written; for Trello's key/token pair the next start re-tests the
 * pair and refuses a mismatched one loudly, and setting both again fixes it.
 */
export async function writeVerifiedSecrets(
  files: readonly SecretFile[],
  test: (values: readonly string[]) => Promise<IdentityTest>,
  opts: { provider: ProviderName },
  io: JiraTokenWriteIo = defaultJiraTokenWriteIo(),
): Promise<VerifiedWriteOutcome> {
  const candidate = await test(files.map((f) => f.value));
  if (!candidate.ok) return { ok: false, reason: "test-failed", error: providerTestError(opts.provider, candidate.reason) };
  for (const f of files) if (io.isSymlink(f.path)) return { ok: false, reason: "destination-symlink", path: f.path };

  const current = files.map((f) => io.readFile(f.path)?.trim() ?? "");
  const rotated = current.some(Boolean);
  if (current.every(Boolean)) {
    const currentTest = await test(current);
    if (currentTest.ok && currentTest.id !== candidate.id) return { ok: false, reason: "identity-mismatch", currentLabel: currentTest.label, candidateLabel: candidate.label };
    if (!currentTest.ok && currentTest.reason !== "unauthorized") return { ok: false, reason: "current-unverifiable", error: providerTestError(opts.provider, currentTest.reason) };
  }

  for (const f of files) {
    const dir = dirname(f.path);
    if (f.createDir) {
      const dirExisted = io.modeOf(dir) !== undefined;
      io.mkdir(dir);
      if (!dirExisted) { try { chmodSync(dir, 0o700); } catch { /* best-effort, e.g. no POSIX mode bits */ } }
    }
    const tmp = join(dir, `.${basename(f.path)}.tmp-${process.pid}-${process.hrtime.bigint()}-${Math.random().toString(36).slice(2)}`);
    try {
      io.writeTempExclusive(tmp, f.value, 0o600);
      io.rename(tmp, f.path);
    } catch (e) {
      io.removeQuiet(tmp);
      return { ok: false, reason: "write-failed", error: `could not write ${f.path}: ${(e as Error).message}` };
    }
  }
  return { ok: true, label: candidate.label, rotated };
}
