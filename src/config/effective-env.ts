/**
 * FACTORY-665 (PR-2) — closes the gap flagged in review: writing the
 * Atlassian token file alone does not make a restart leave setup mode,
 * because `loadConfig`/`isAtlassianConfigured` only ever looked at
 * `process.env` — nothing re-reads this daemon's own persisted setup
 * state. `resolveEffectiveJiraEnv` builds the env `index.ts` actually
 * passes to both of those, PER-FIELD: an env var, when set, always wins
 * (same "env wins" discipline `settings.json`, PR-1, documents for its own
 * allowlist); a field the env leaves unset falls back to what the setup
 * route last persisted — `../setup/jira-identity-file.ts` for
 * site/email, `../setup/jira-token-write.ts`'s own managed path for the
 * token file.
 *
 * Deliberately NOT a change to `loadConfig`/`isAtlassianConfigured`
 * themselves — both keep reading `ConfigEnv` exactly as before (so every
 * existing test/call site against a real env is unaffected); this is a
 * step BEFORE either of those, done once at startup in `index.ts`.
 */
import { statSync } from "node:fs";
import type { ConfigEnv } from "./config.js";
import { readJiraIdentity, jiraIdentityFilePath, type JiraIdentityFileIo } from "../setup/jira-identity-file.js";
import { jiraTokenFilePath } from "../setup/jira-token-write.js";
import { githubTokenFilePath } from "../setup/github-token-write.js";
import { managedSecretPath, TRELLO_KEY_FILE_NAME, TRELLO_TOKEN_FILE_NAME, ZENDESK_TOKEN_FILE_NAME } from "../setup/provider-secrets.js";

export interface ResolveEffectiveJiraEnvDeps {
  identityIo?: JiraIdentityFileIo;
  /** `true` iff a regular, readable file exists at the managed token path — injectable for tests; defaults to a real `fs.existsSync`-equivalent check. */
  managedTokenFileExists?: (path: string) => boolean;
  onWarn?: (message: string) => void;
}

function defaultManagedTokenFileExists(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Returns a NEW env object — never mutates `env`. Every field env already
 * supplies passes through completely unchanged; only `ATLASSIAN_SITE`/
 * `ATLASSIAN_EMAIL`/`ATLASSIAN_TOKEN_FILE` are ever filled in, and only
 * when their own env var is unset AND an env-provided token
 * (`ATLASSIAN_TOKEN`) isn't already covering the token half (filling in
 * `ATLASSIAN_TOKEN_FILE` alongside an already-set `ATLASSIAN_TOKEN` would
 * make `loadConfig` prefer the FILE over the env var it already had,
 * silently reversing today's "env var wins" behavior for that one field —
 * see `loadConfig`'s own token branch, which checks `ATLASSIAN_TOKEN_FILE`
 * first).
 */
export function resolveEffectiveJiraEnv(env: ConfigEnv & Record<string, string | undefined>, deps: ResolveEffectiveJiraEnvDeps = {}): ConfigEnv & Record<string, string | undefined> {
  const managedTokenFileExists = deps.managedTokenFileExists ?? defaultManagedTokenFileExists;
  const identity = env.ATLASSIAN_SITE?.trim() && env.ATLASSIAN_EMAIL?.trim()
    ? undefined // both already env-provided: never even read the identity file
    : readJiraIdentity(jiraIdentityFilePath(env), deps.identityIo, deps.onWarn);

  const result: ConfigEnv & Record<string, string | undefined> = { ...env };
  if (!result.ATLASSIAN_SITE?.trim() && identity?.site) result.ATLASSIAN_SITE = identity.site;
  if (!result.ATLASSIAN_EMAIL?.trim() && identity?.email) result.ATLASSIAN_EMAIL = identity.email;
  if (!result.ATLASSIAN_TOKEN_FILE?.trim() && !result.ATLASSIAN_TOKEN?.trim()) {
    const managedPath = jiraTokenFilePath(env);
    if (managedTokenFileExists(managedPath)) result.ATLASSIAN_TOKEN_FILE = managedPath;
  }
  return result;
}

/**
 * local/ui — the GitHub twin of `resolveEffectiveJiraEnv`: when
 * `GITHUB_TOKEN_FILE` is unset and the Settings page has written the managed
 * `secrets/github-token`, point `GITHUB_TOKEN_FILE` at it. An env-set
 * `GITHUB_TOKEN_FILE` always wins. `BUTCHR_GITHUB_ORGS` needs nothing here:
 * it comes through `settings.json` (`effectiveSettingsEnv`). Returns a new
 * object; never mutates `env`.
 */
export function resolveEffectiveGithubEnv<T extends Record<string, string | undefined>>(env: T, deps: Pick<ResolveEffectiveJiraEnvDeps, "managedTokenFileExists"> = {}): T {
  const managedTokenFileExists = deps.managedTokenFileExists ?? defaultManagedTokenFileExists;
  if (env.GITHUB_TOKEN_FILE?.trim()) return { ...env };
  const managedPath = githubTokenFilePath(env);
  return managedTokenFileExists(managedPath) ? { ...env, GITHUB_TOKEN_FILE: managedPath } : { ...env };
}

/**
 * local/ui — the same fill-in for the Zendesk OAuth token and the Trello
 * key/token files (`../setup/provider-secrets.ts`): each env var that's
 * unset is pointed at its managed `secrets/` file when that file exists. An
 * env-set path always wins. `ZENDESK_SUBDOMAIN`/`TRELLO_BOARD_ID` come
 * through `settings.json` (`effectiveSettingsEnv`). Returns a new object.
 */
export function resolveEffectiveProviderSecretsEnv<T extends Record<string, string | undefined>>(env: T, deps: Pick<ResolveEffectiveJiraEnvDeps, "managedTokenFileExists"> = {}): T {
  const managedTokenFileExists = deps.managedTokenFileExists ?? defaultManagedTokenFileExists;
  const result: Record<string, string | undefined> = { ...env };
  for (const [key, fileName] of [
    ["ZENDESK_OAUTH_TOKEN_FILE", ZENDESK_TOKEN_FILE_NAME],
    ["TRELLO_API_KEY_FILE", TRELLO_KEY_FILE_NAME],
    ["TRELLO_TOKEN_FILE", TRELLO_TOKEN_FILE_NAME],
  ] as const) {
    if (result[key]?.trim()) continue;
    const managedPath = managedSecretPath(fileName, env);
    if (managedTokenFileExists(managedPath)) result[key] = managedPath;
  }
  return result as T;
}
