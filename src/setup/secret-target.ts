/**
 * local/ui — where each credential this daemon reads actually lives, and so
 * where a web write has to go for a restart to pick it up. Mirrors
 * `loadConfig`'s own precedence (`../config/config.ts`):
 *
 *  - Atlassian: `ATLASSIAN_TOKEN_FILE` wins over `ATLASSIAN_TOKEN`; with
 *    neither set, the managed `secrets/atlassian-token` that
 *    `resolveEffectiveJiraEnv` fills in.
 *  - GitHub: `GITHUB_TOKEN_FILE`; unset, the managed `secrets/github-token`
 *    that `resolveEffectiveGithubEnv` fills in.
 *  - Zendesk and Trello: `ZENDESK_OAUTH_TOKEN_FILE`, `TRELLO_API_KEY_FILE`
 *    and `TRELLO_TOKEN_FILE`; unset, the managed `secrets/` files
 *    (`./provider-secrets.ts`) that `resolveEffectiveProviderSecretsEnv`
 *    fills in.
 *
 * A token set as a literal in the environment can't be changed from the web
 * (the environment always wins). A token FILE the environment names is
 * written in place. `checkSecretDestination` is the pre-write safety check
 * for whichever path that is.
 */
import { lstatSync, statSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { expandHomePath } from "../config/home-path.js";
import { jiraTokenFilePath } from "./jira-token-write.js";
import { githubTokenFilePath } from "./github-token-write.js";
import { managedSecretPath, TRELLO_KEY_FILE_NAME, TRELLO_TOKEN_FILE_NAME, ZENDESK_TOKEN_FILE_NAME } from "./provider-secrets.js";

export type CredentialName = "atlassian" | "github" | "zendesk" | "trello-key" | "trello-token";
export type CredentialSource = "env-literal" | "env-file" | "secrets-file" | "unset";
export type CredentialFileEnvKey = "ATLASSIAN_TOKEN_FILE" | "GITHUB_TOKEN_FILE" | "ZENDESK_OAUTH_TOKEN_FILE" | "TRELLO_API_KEY_FILE" | "TRELLO_TOKEN_FILE";

const FILE_ENV_KEY: Record<CredentialName, CredentialFileEnvKey> = {
  atlassian: "ATLASSIAN_TOKEN_FILE",
  github: "GITHUB_TOKEN_FILE",
  zendesk: "ZENDESK_OAUTH_TOKEN_FILE",
  "trello-key": "TRELLO_API_KEY_FILE",
  "trello-token": "TRELLO_TOKEN_FILE",
};

/** The managed `secrets/` file each credential defaults to. */
export function managedCredentialPath(name: CredentialName, env: Record<string, string | undefined>): string {
  switch (name) {
    case "atlassian": return jiraTokenFilePath(env);
    case "github": return githubTokenFilePath(env);
    case "zendesk": return managedSecretPath(ZENDESK_TOKEN_FILE_NAME, env);
    case "trello-key": return managedSecretPath(TRELLO_KEY_FILE_NAME, env);
    case "trello-token": return managedSecretPath(TRELLO_TOKEN_FILE_NAME, env);
  }
}

export interface CredentialTarget {
  name: CredentialName;
  /** The env var that names the token file (or would). */
  fileEnvKey: CredentialFileEnvKey;
  source: CredentialSource;
  /** The file the token is read from, or would be written to. `null` only for `env-literal`. */
  path: string | null;
  /** Why the web can't write this credential, or `null` when it can. */
  readOnlyReason: string | null;
  /** The managed `secrets/` path: its directory may be created (0700) on the first write. An env-named file's directory must already exist. */
  managed: boolean;
}

function defaultIsFile(path: string): boolean {
  try { return statSync(path).isFile(); } catch { return false; }
}

export function resolveCredentialTarget(
  name: CredentialName,
  env: Record<string, string | undefined>,
  isFile: (path: string) => boolean = defaultIsFile,
): CredentialTarget {
  const fileEnvKey = FILE_ENV_KEY[name];
  const named = env[fileEnvKey]?.trim();
  if (named) {
    const path = expandHomePath(named, env);
    const readOnlyReason = isAbsolute(path) ? null : `${fileEnvKey} must be an absolute path for butchr to write it.`;
    return { name, fileEnvKey, source: "env-file", path, readOnlyReason, managed: false };
  }
  if (name === "atlassian" && env.ATLASSIAN_TOKEN?.trim()) {
    return {
      name,
      fileEnvKey,
      source: "env-literal",
      path: null,
      readOnlyReason: "ATLASSIAN_TOKEN is set directly in butchr's environment, which always wins. Move the token into a file named by ATLASSIAN_TOKEN_FILE to manage it from here.",
      managed: false,
    };
  }
  const path = managedCredentialPath(name, env);
  return { name, fileEnvKey, source: isFile(path) ? "secrets-file" : "unset", path, readOnlyReason: null, managed: true };
}

export interface SecretDestinationIo {
  /** `undefined` when nothing exists at `path` (never follows a symlink). */
  lstat: (path: string) => { isSymbolicLink: boolean; isFile: boolean; uid: number } | undefined;
  dirExists: (dir: string) => boolean;
  ownUid: () => number | undefined;
}

export function defaultSecretDestinationIo(): SecretDestinationIo {
  return {
    lstat: (path) => {
      try {
        const st = lstatSync(path);
        return { isSymbolicLink: st.isSymbolicLink(), isFile: st.isFile(), uid: st.uid };
      } catch {
        return undefined;
      }
    },
    dirExists: (dir) => { try { return statSync(dir).isDirectory(); } catch { return false; } },
    ownUid: () => process.getuid?.(),
  };
}

export type DestinationCheck = { ok: true } | { ok: false; error: string };

/**
 * Refuses a destination butchr shouldn't write a secret to: a relative
 * path, a symlink, anything that isn't a regular file, a file owned by
 * another uid, or (for an env-named path) a directory that doesn't exist.
 * An existing file's mode isn't a reason to refuse: the write replaces it
 * with a fresh 0600 file.
 */
export function checkSecretDestination(path: string, opts: { managed: boolean }, io: SecretDestinationIo = defaultSecretDestinationIo()): DestinationCheck {
  if (!isAbsolute(path)) return { ok: false, error: `${path} is not an absolute path — refusing to write a token there.` };
  const st = io.lstat(path);
  if (st) {
    if (st.isSymbolicLink) return { ok: false, error: `${path} is a symlink — refusing to write a token through it.` };
    if (!st.isFile) return { ok: false, error: `${path} is not a regular file — refusing to write a token there.` };
    const own = io.ownUid();
    if (own !== undefined && st.uid !== own) return { ok: false, error: `${path} is owned by uid ${st.uid}, not butchr's uid ${own} — refusing to write a token there.` };
    return { ok: true };
  }
  if (!opts.managed && !io.dirExists(dirname(path))) return { ok: false, error: `${dirname(path)} doesn't exist — create it first, then set the token again.` };
  return { ok: true };
}
