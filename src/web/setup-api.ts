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
import { writeJiraIdentity, jiraIdentityFilePath, type JiraIdentityFileIo } from "../setup/jira-identity-file.js";
import type { SetupCodeManager } from "../setup/setup-code.js";

export interface SetupStatusResponse {
  configured: boolean;
}

export function buildSetupStatus(configured: boolean): SetupStatusResponse {
  return { configured };
}

export type JiraWriteRequestOutcome =
  | { ok: true; status: 200; body: { ok: true; accountId: string; displayName: string; rotated: boolean; restartNeeded: true; restarting?: true; identityPersisted: boolean; identityError?: string } }
  | { ok: false; status: 400; body: { error: string } }
  | { ok: false; status: 409; body: { error: "provided by environment" } }
  | { ok: false; status: 429; body: { error: string }; retryAfterSeconds: number };

/** Called by `handleJiraTokenWrite` only AFTER the setup code has verified, so a mistyped code can never spend rate-limit budget (director 2026-10-06, item 5). */
export type RateGate = () => { ok: true } | { ok: false; error: string; retryAfterSeconds: number };

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
  /** `../setup/jira-identity-file.ts`'s own IO — overridable for tests, same discipline as `io` above. */
  identityIo?: JiraIdentityFileIo;
  identityPath?: string;
}

/**
 * Persists `{site, email}` to the durable identity file so a RESTART after
 * setup actually leaves setup mode (`../config/effective-env.ts`'s
 * `resolveEffectiveJiraEnv` is what later reads this back) — called only
 * on a successful INITIAL setup (`opts.requireEnvCheck === false`), never
 * on a rotation, since site/email cannot change there. Never throws: a
 * failure here does not unwind the token write that already succeeded
 * (that would leave the secret on disk with no way to report it worked);
 * instead it's reported alongside the success body as `identityPersisted:
 * false` + `identityError`, so the UI can warn the operator rather than
 * silently claiming a complete setup that will NOT survive a restart.
 */
function persistIdentity(input: { site: string; email: string }, deps: JiraWriteDeps): { persisted: boolean; error?: string } {
  try {
    writeJiraIdentity({ site: input.site, email: input.email }, deps.identityPath ?? jiraIdentityFilePath(deps.env), deps.identityIo);
    return { persisted: true };
  } catch (e) {
    return { persisted: false, error: (e as Error).message };
  }
}

function outcomeToResponse(outcome: JiraTokenWriteOutcome, identity?: { persisted: boolean; error?: string }): JiraWriteRequestOutcome {
  if (outcome.ok) {
    return { ok: true, status: 200, body: { ok: true, accountId: outcome.accountId, displayName: outcome.displayName, rotated: outcome.rotated, restartNeeded: true, identityPersisted: identity?.persisted ?? true, ...(identity?.error ? { identityError: identity.error } : {}) } };
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
  opts: { requireEnvCheck: boolean; rateGate?: RateGate },
): Promise<JiraWriteRequestOutcome> {
  if (opts.requireEnvCheck && isTokenProvidedByEnvironment(deps.env ?? {})) {
    return { ok: false, status: 409, body: { error: "provided by environment" } };
  }

  const codeCheck = deps.setupCode.check(input.setupCode);
  if (!codeCheck.ok) {
    return { ok: false, status: 400, body: { error: `setup code: ${codeCheck.reason}` } };
  }
  const gate = opts.rateGate?.();
  if (gate && !gate.ok) return { ok: false, status: 429, body: { error: gate.error }, retryAfterSeconds: gate.retryAfterSeconds };

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
  if (!outcome.ok) return outcomeToResponse(outcome);

  // Rotation (`requireEnvCheck: true`) never touches site/email — only
  // the INITIAL setup call persists the identity that makes a later
  // restart actually leave setup mode (see `persistIdentity`'s own doc
  // comment for why a failure here doesn't unwind the token write).
  const identity = opts.requireEnvCheck ? undefined : persistIdentity({ site: input.site, email: input.email }, deps);
  return outcomeToResponse(outcome, identity);
}
