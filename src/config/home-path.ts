/**
 * local/ui — `~` expansion for operator-supplied token file paths
 * (`ATLASSIAN_TOKEN_FILE`, `GITHUB_TOKEN_FILE`, `ZENDESK_OAUTH_TOKEN_FILE`,
 * `TRELLO_API_KEY_FILE`, `TRELLO_TOKEN_FILE`), on both the read and the
 * write side (`resolveCredentialTarget`). Bun's `.env` loader passes
 * `~/...` through verbatim, so a token file named that way used to be
 * unreadable at startup. Anything not starting with `~/` (or equal to `~`)
 * is returned untouched, byte for byte.
 */
import { homedir } from "node:os";
import { join } from "node:path";

export function expandHomePath(path: string, env: Readonly<Record<string, string | undefined>> = process.env as Record<string, string | undefined>): string {
  if (path !== "~" && !path.startsWith("~/")) return path;
  const home = env["HOME"]?.trim() || homedir();
  return path === "~" ? home : join(home, path.slice(2));
}
