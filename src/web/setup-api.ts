/**
 * FACTORY-665 (PR-2) — the orchestration layer behind `GET /api/setup/status`,
 * `POST /api/setup/jira` (setup mode only), and `PUT /api/settings/jira/token`
 * (configured mode, rotation). Each HTTP route (`../web/view.ts`) is a thin
 * shell: write-guard chain, body shape, rate limit, THEN one call into this
 * module. This module owns: the setup-code check, the env-provided-token 409,
 * the site-shape validation, and delegating the actual test+write to
 * `../setup/jira-token-write.ts`'s `writeJiraToken` — never re-deriving any
 * of those.
 */
import { validateAtlassianSiteShape } from "../config/config.js";
import { writeJiraToken, jiraTokenFilePath, type JiraTokenWriteIo, type FetchLike, type JiraTokenWriteOutcome } from "../setup/jira-token-write.js";
import type { SetupCodeManager } from "../setup/setup-code.js";

export interface SetupStatusResponse {
  configured: boolean;
}

export function buildSetupStatus(configured: boolean): SetupStatusResponse {
  return { configured };
}

export type JiraWriteRequestOutcome =
  | { ok: true; status: 200; body: { ok: true; accountId: string; displayName: string; rotated: boolean; restartNeeded: true } }
  | { ok: false; status: 400; body: { error: string } }
  | { ok: false; status: 409; body: { error: "provided by environment" } };

/** True iff the daemon's OWN process env currently supplies the Atlassian token — never derived from the request body. */
export function isTokenProvidedByEnvironment(env: Record<string, string | undefined>): boolean {
  return !!env.ATLASSIAN_TOKEN?.trim() || !!env.ATLASSIAN_TOKEN_FILE?.trim();
}

export interface JiraWriteDeps {
  setupCode: SetupCodeManager;
  io?: JiraTokenWriteIo;
  fetchFn?: FetchLike;
  path?: string;
  /** The daemon's own process env — used ONLY for the env-provided-token 409 check (rotation route); the setup route's own caller never has an env to check this against in the first place (setup mode implies it's unset). */
  env?: Record<string, string | undefined>;
}

function outcomeToResponse(outcome: JiraTokenWriteOutcome): JiraWriteRequestOutcome {
  if (outcome.ok) {
    return { ok: true, status: 200, body: { ok: true, accountId: outcome.accountId, displayName: outcome.displayName, rotated: outcome.rotated, restartNeeded: true } };
  }
  switch (outcome.reason) {
    case "test-failed": return { ok: false, status: 400, body: { error: outcome.error } };
    case "write-failed": return { ok: false, status: 400, body: { error: outcome.error } };
    case "current-token-unreadable": return { ok: false, status: 400, body: { error: `current token test failed, refusing rotation: ${outcome.error}` } };
    case "destination-symlink": return { ok: false, status: 400, body: { error: "the token file's destination path is a symlink — refusing to write through it" } };
    case "account-mismatch": return { ok: false, status: 400, body: { error: `the new token belongs to a different Atlassian account (${outcome.candidateAccountId}) than the current one (${outcome.currentAccountId}) — refusing` } };
  }
}

/**
 * The ONE entry point both routes call. `requireEnvCheck: true` (rotation)
 * also refuses with 409 when the daemon's own process env already supplies
 * the token — not the request's concern to override. `requireEnvCheck:
 * false` (initial setup) skips that check entirely: setup mode exists
 * precisely because no env-provided token exists yet.
 */
export async function handleJiraTokenWrite(
  input: { site: string; email: string; token: string; setupCode: string },
  deps: JiraWriteDeps,
  opts: { requireEnvCheck: boolean },
): Promise<JiraWriteRequestOutcome> {
  if (opts.requireEnvCheck && isTokenProvidedByEnvironment(deps.env ?? {})) {
    return { ok: false, status: 409, body: { error: "provided by environment" } };
  }

  const codeCheck = deps.setupCode.check(input.setupCode);
  if (!codeCheck.ok) {
    return { ok: false, status: 400, body: { error: `setup code: ${codeCheck.reason}` } };
  }

  try {
    validateAtlassianSiteShape(input.site);
  } catch (e) {
    return { ok: false, status: 400, body: { error: (e as Error).message } };
  }
  if (!input.email.trim()) {
    return { ok: false, status: 400, body: { error: "email is required" } };
  }
  if (!input.token.trim()) {
    return { ok: false, status: 400, body: { error: "token is required" } };
  }

  const path = deps.path ?? jiraTokenFilePath();
  const outcome = await writeJiraToken({ site: input.site, email: input.email, token: input.token }, path, deps.io, deps.fetchFn);
  return outcomeToResponse(outcome);
}
