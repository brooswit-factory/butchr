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
