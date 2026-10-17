/**
 * local/ui — the orchestration behind `PUT /api/settings/github/token`, held
 * to the same order and rules as `./setup-api.ts`'s `handleJiraTokenWrite`:
 * configuration refusals first (a read-only target, an unsafe destination),
 * then the one-time setup code, then the shared secret-write rate limit,
 * then the token test and the write (`../setup/github-token-write.ts`).
 * Nothing here ever logs, audits, or returns the token or the code. Also
 * builds the credentials summary `GET /api/settings` carries (below).
 */
import type { SetupCodeManager } from "../setup/setup-code.js";
import type { FetchLike, JiraTokenWriteIo } from "../setup/jira-token-write.js";
import { writeGithubToken, type GithubTokenWriteOutcome } from "../setup/github-token-write.js";
import { providerTestError, testTrelloBoard, testTrelloCredentials, testZendeskToken, writeVerifiedSecrets, type IdentityTest, type ProviderName, type VerifiedWriteOutcome } from "../setup/provider-secrets.js";
import { isZendeskSubdomain } from "../resources/zendesk-ticket-ref.js";
import { loadZendeskAuth } from "../resources/zendesk-ticket.js";
import { loadTrelloAuth } from "../resources/trello-card.js";
import { ZENDESK_RISK_ACK_ENV, ZENDESK_RISK_ACK_VALUE } from "../rules/zendesk-ticket-type.js";
import { TRELLO_RISK_ACK_ENV, TRELLO_RISK_ACK_VALUE } from "../rules/trello-card-type.js";
import { checkSecretDestination, resolveCredentialTarget, type CredentialSource, type CredentialTarget, type SecretDestinationIo } from "../setup/secret-target.js";
import type { RateGate } from "./setup-api.js";
import { isModeTooOpen, redactUrlUserinfo, statTokenFile, type StatResult } from "./settings-api.js";
import type { LaunchdJob } from "./daemon-restart.js";

export type GithubTokenWriteRequestOutcome =
  | { ok: true; status: 200; body: { ok: true; login: string; rotated: boolean; restartNeeded: true } }
  | { ok: false; status: 400; body: { error: string } }
  | { ok: false; status: 429; body: { error: string }; retryAfterSeconds: number };

export interface GithubWriteDeps {
  setupCode: SetupCodeManager;
  /** Where the token goes (`resolveCredentialTarget("github", process.env)`), resolved per request so an env change is never cached. */
  target: CredentialTarget;
  io?: JiraTokenWriteIo;
  fetchFn?: FetchLike;
  destinationIo?: SecretDestinationIo;
}

/** Printable, single line, no spaces: classic (`ghp_…`) and fine-grained (`github_pat_…`) tokens both fit. */
const TOKEN_RE = /^[\x21-\x7e]{1,255}$/;

function outcomeToResponse(outcome: GithubTokenWriteOutcome): GithubTokenWriteRequestOutcome {
  if (outcome.ok) return { ok: true, status: 200, body: { ok: true, login: outcome.login, rotated: outcome.rotated, restartNeeded: true } };
  switch (outcome.reason) {
    case "test-failed": return { ok: false, status: 400, body: { error: outcome.error } };
    case "write-failed": return { ok: false, status: 400, body: { error: outcome.error } };
    case "destination-symlink": return { ok: false, status: 400, body: { error: "the token file's destination path is a symlink — refusing to write through it" } };
    case "current-token-unverifiable": return { ok: false, status: 400, body: { error: `couldn't check the current GitHub token, so it wasn't replaced: ${outcome.error}` } };
    case "login-mismatch": return { ok: false, status: 400, body: { error: `the new token belongs to a different GitHub account (${outcome.candidateLogin}) than the current one (${outcome.currentLogin}) — refusing` } };
  }
}

export async function handleGithubTokenWrite(input: { token: string; setupCode: string }, deps: GithubWriteDeps, opts: { rateGate?: RateGate } = {}): Promise<GithubTokenWriteRequestOutcome> {
  const { target } = deps;
  if (target.readOnlyReason !== null || target.path === null) return { ok: false, status: 400, body: { error: target.readOnlyReason ?? "this token can't be set from here" } };
  const destination = checkSecretDestination(target.path, { managed: target.managed }, deps.destinationIo);
  if (!destination.ok) return { ok: false, status: 400, body: { error: destination.error } };

  const codeCheck = deps.setupCode.check(input.setupCode);
  if (!codeCheck.ok) return { ok: false, status: 400, body: { error: `setup code: ${codeCheck.reason}` } };
  const gate = opts.rateGate?.();
  if (gate && !gate.ok) return { ok: false, status: 429, body: { error: gate.error }, retryAfterSeconds: gate.retryAfterSeconds };

  const token = input.token.trim();
  if (!token) return { ok: false, status: 400, body: { error: "token is required" } };
  if (!TOKEN_RE.test(token)) return { ok: false, status: 400, body: { error: "the token must be one line with no spaces, at most 255 characters" } };

  return outcomeToResponse(await writeGithubToken(token, target.path, { createDir: target.managed }, deps.io, deps.fetchFn));
}

// ---------------------------------------------------------------------------
// local/ui — `PUT /api/settings/zendesk/token` and `PUT
// /api/settings/trello/credentials`: the GitHub route's order exactly
// (configuration refusals, then the setup code, then the rate limit, then
// the shape check, then test + write via `../setup/provider-secrets.ts`).
// ---------------------------------------------------------------------------

export type ProviderSecretWriteRequestOutcome =
  | { ok: true; status: 200; body: { ok: true; account: string; rotated: boolean; restartNeeded: true } }
  | { ok: false; status: 400; body: { error: string } }
  | { ok: false; status: 429; body: { error: string }; retryAfterSeconds: number };

export interface ProviderSecretWriteDeps {
  setupCode: SetupCodeManager;
  /** Where each value goes, in the order the handler receives them, resolved per request. */
  targets: readonly CredentialTarget[];
  io?: JiraTokenWriteIo;
  fetchFn?: FetchLike;
  destinationIo?: SecretDestinationIo;
}

function verifiedOutcomeToResponse(outcome: VerifiedWriteOutcome, provider: ProviderName): ProviderSecretWriteRequestOutcome {
  if (outcome.ok) return { ok: true, status: 200, body: { ok: true, account: outcome.label, rotated: outcome.rotated, restartNeeded: true } };
  switch (outcome.reason) {
    case "test-failed":
    case "write-failed": return { ok: false, status: 400, body: { error: outcome.error } };
    case "current-unverifiable": return { ok: false, status: 400, body: { error: `couldn't check the current ${provider} credentials, so they weren't replaced: ${outcome.error}` } };
    case "destination-symlink": return { ok: false, status: 400, body: { error: `${outcome.path} is a symlink — refusing to write through it` } };
    case "identity-mismatch": return { ok: false, status: 400, body: { error: `the new ${provider} credentials belong to a different account (${outcome.candidateLabel}) than the current ones (${outcome.currentLabel}) — refusing` } };
  }
}

async function handleProviderSecretWrite(
  provider: ProviderName,
  values: readonly string[],
  setupCode: string,
  test: (values: readonly string[]) => Promise<IdentityTest>,
  deps: ProviderSecretWriteDeps,
  opts: { rateGate?: RateGate; preflightError?: string | null },
): Promise<ProviderSecretWriteRequestOutcome> {
  for (const target of deps.targets) {
    if (target.readOnlyReason !== null || target.path === null) return { ok: false, status: 400, body: { error: target.readOnlyReason ?? "this credential can't be set from here" } };
    const destination = checkSecretDestination(target.path, { managed: target.managed }, deps.destinationIo);
    if (!destination.ok) return { ok: false, status: 400, body: { error: destination.error } };
  }
  if (opts.preflightError) return { ok: false, status: 400, body: { error: opts.preflightError } };

  const codeCheck = deps.setupCode.check(setupCode);
  if (!codeCheck.ok) return { ok: false, status: 400, body: { error: `setup code: ${codeCheck.reason}` } };
  const gate = opts.rateGate?.();
  if (gate && !gate.ok) return { ok: false, status: 429, body: { error: gate.error }, retryAfterSeconds: gate.retryAfterSeconds };

  const trimmed = values.map((v) => v.trim());
  if (trimmed.some((v) => !v)) return { ok: false, status: 400, body: { error: "every field is required" } };
  if (trimmed.some((v) => !TOKEN_RE.test(v))) return { ok: false, status: 400, body: { error: "each value must be one line with no spaces, at most 255 characters" } };

  const files = deps.targets.map((target, i) => ({ path: target.path!, value: trimmed[i]!, createDir: target.managed }));
  return verifiedOutcomeToResponse(await writeVerifiedSecrets(files, test, { provider }, deps.io), provider);
}

/** `subdomain` is what the token is tested against: the env's `ZENDESK_SUBDOMAIN`, else settings.json's. It's validated before anything is sent, since it becomes the request's host. */
export async function handleZendeskTokenWrite(input: { token: string; setupCode: string }, deps: ProviderSecretWriteDeps & { subdomain: string | null }, opts: { rateGate?: RateGate } = {}): Promise<ProviderSecretWriteRequestOutcome> {
  const subdomain = deps.subdomain?.trim() ?? "";
  const preflightError = !subdomain
    ? "set and save the Zendesk subdomain first, then set the token"
    : !isZendeskSubdomain(subdomain) ? `ZENDESK_SUBDOMAIN ${JSON.stringify(subdomain)} isn't a valid subdomain` : null;
  return handleProviderSecretWrite("Zendesk", [input.token], input.setupCode, ([token]) => testZendeskToken(subdomain, token!, deps.fetchFn), deps, { ...opts, preflightError });
}

/** Both values are tested together (Trello takes the key and token as a pair) and written together. */
export async function handleTrelloCredentialsWrite(input: { apiKey: string; token: string; setupCode: string }, deps: ProviderSecretWriteDeps, opts: { rateGate?: RateGate } = {}): Promise<ProviderSecretWriteRequestOutcome> {
  return handleProviderSecretWrite("Trello", [input.apiKey, input.token], input.setupCode, ([apiKey, token]) => testTrelloCredentials(apiKey!, token!, deps.fetchFn), deps, opts);
}

export type ProviderConnectionTestResult = { ok: true; account: string; board?: string } | { ok: false; error: string };

/** Tests the credentials the running daemon loaded (its startup env), never a request body. */
export async function testZendeskConnection(env: Record<string, string | undefined>, fetchFn: FetchLike = fetch): Promise<ProviderConnectionTestResult> {
  const auth = loadZendeskAuth(env);
  if (!auth.ok) return { ok: false, error: auth.reason };
  const result = await testZendeskToken(auth.subdomain, auth.token, fetchFn);
  return result.ok ? { ok: true, account: result.label } : { ok: false, error: providerTestError("Zendesk", result.reason) };
}

export async function testTrelloConnection(env: Record<string, string | undefined>, fetchFn: FetchLike = fetch): Promise<ProviderConnectionTestResult> {
  const auth = loadTrelloAuth(env);
  if (!auth.ok) return { ok: false, error: auth.reason };
  const member = await testTrelloCredentials(auth.apiKey, auth.token, fetchFn);
  if (!member.ok) return { ok: false, error: providerTestError("Trello", member.reason) };
  const board = await testTrelloBoard(auth.boardId, auth.apiKey, auth.token, fetchFn);
  if (!board.ok) return { ok: false, error: board.reason === "not-found" ? `these credentials (${member.label}) can't see board ${auth.boardId}` : providerTestError("Trello", board.reason) };
  return { ok: true, account: member.label, board: board.name };
}

// ---------------------------------------------------------------------------
// local/ui — the credentials summary `GET /api/settings` carries for the
// Settings page's credential cards. Paths, file health, sources and fixed
// instructions only: this never reads a token file's contents, so no token
// value can ever appear in it.
// ---------------------------------------------------------------------------

export interface TokenStatus {
  source: CredentialSource;
  /** The env var that names the token file (or would). */
  fileEnvKey: string;
  /** Where the token is, or where setting one will write it. `null` only for an env literal. */
  path: string | null;
  exists: boolean;
  readable: boolean;
  mode: number | null;
  tooOpen: boolean | null;
  /** `null` when the web can set this token; otherwise why not. */
  readOnlyReason: string | null;
}

export interface CredentialsSummary {
  atlassian: { site: string | null; email: string | null; token: TokenStatus };
  github: {
    token: TokenStatus;
    /** What the next start will use: the env's value, else settings.json's. */
    orgs: string[];
    orgsSource: "environment" | "file" | "default";
    orgsEditable: boolean;
    /** Whether the RUNNING daemon has the GitHub integration on (it needs a token and orgs at start). */
    active: boolean;
    /** The orgs this daemon started with, which it keeps using until a restart. */
    runningOrgs: string[];
  };
  zendesk: {
    subdomain: LayeredValue;
    token: TokenStatus;
    /** `BUTCHR_ZENDESK_ACCEPT_SHELL_CREDENTIAL_RISK` holds the opt-in value. Set in the environment only, never from the page. */
    riskAccepted: boolean;
  };
  trello: {
    boardId: LayeredValue;
    apiKey: TokenStatus;
    token: TokenStatus;
    /** `BUTCHR_TRELLO_ACCEPT_SHELL_CREDENTIAL_RISK` holds the opt-in value trello-card rules need. Set in the environment only, never from the page. */
    riskAccepted: boolean;
  };
  /** How to mint the one-time setup code every token write needs, for this daemon's supervisor. */
  setupCode: { command: string; findCommand: string | null; where: string };
  /** `startedAt`: when this daemon started (`/health`'s), so the page can tell a restarted daemon's answers from this one's. */
  restart: { supported: boolean; supervisor: "launchd" | "systemd" | "none"; startedAt: string };
}

/** A non-secret setting the env can set (and then wins) or settings.json can: what the next start uses, and whether the page can change it. */
export interface LayeredValue {
  value: string | null;
  source: "environment" | "file" | "default";
  editable: boolean;
  /** The value this daemon started with, which it keeps using until a restart. */
  running: string | null;
}

function layered(key: string, env: Readonly<Record<string, string | undefined>>, fileValues: Readonly<Record<string, string>>, running: string | null): LayeredValue {
  const fromEnv = env[key]?.trim();
  if (fromEnv) return { value: fromEnv, source: "environment", editable: false, running };
  const fromFile = fileValues[key]?.trim();
  return fromFile ? { value: fromFile, source: "file", editable: true, running } : { value: null, source: "default", editable: true, running };
}

export type SupervisorInfo = { kind: "launchd"; job: LaunchdJob } | { kind: "systemd" } | { kind: "none" };

export interface CredentialsSummaryInput {
  /** `process.env`, unmerged. */
  rawEnv: Readonly<Record<string, string | undefined>>;
  /** settings.json's current values (re-read, so a just-saved org list shows). */
  settingsFileValues: Readonly<Record<string, string>>;
  /** The Atlassian identity the running daemon loaded. */
  atlassian: { site: string | null; email: string | null };
  githubActive: boolean;
  /** What this daemon started with, for the settings the cards edit. */
  running: { githubOrgs: readonly string[]; zendeskSubdomain: string | null; trelloBoardId: string | null };
  startedAt: string;
  supervisor: SupervisorInfo;
  ownPid: number;
}

/** Single-quotes a path for a copy-paste command unless it's plainly safe. */
function shellPath(path: string): string {
  return /^[A-Za-z0-9_./~-]+$/.test(path) ? path : `'${path.replace(/'/g, `'\\''`)}'`;
}

export function setupCodeInstructions(supervisor: SupervisorInfo, ownPid: number): CredentialsSummary["setupCode"] {
  switch (supervisor.kind) {
    case "launchd": {
      const log = supervisor.job.stderrPath;
      return {
        command: `launchctl kill SIGUSR2 gui/$(id -u)/${supervisor.job.label}`,
        findCommand: log ? `grep 'setup code' ${shellPath(log)} | tail -1` : null,
        where: log ? `butchr's log (${log})` : "butchr's log",
      };
    }
    case "systemd":
      return {
        command: "systemctl --user kill -s SIGUSR2 butchr.service",
        findCommand: "journalctl --user -u butchr.service -n 100 | grep 'setup code' | tail -1",
        where: "butchr's journal",
      };
    default:
      return { command: `kill -USR2 ${ownPid}`, findCommand: null, where: "butchr's own output (stderr)" };
  }
}

async function tokenStatus(target: CredentialTarget, statFn: (path: string) => Promise<StatResult>): Promise<TokenStatus> {
  const base = { source: target.source, fileEnvKey: target.fileEnvKey, readOnlyReason: target.readOnlyReason };
  if (target.path === null) return { ...base, path: null, exists: false, readable: false, mode: null, tooOpen: null };
  const st = await statFn(target.path);
  return { ...base, path: target.path, exists: st.exists, readable: st.readable, mode: st.mode, tooOpen: st.mode === null ? null : isModeTooOpen(st.mode) };
}

export async function buildCredentialsSummary(input: CredentialsSummaryInput, statFn: (path: string) => Promise<StatResult> = statTokenFile, isFile?: (path: string) => boolean): Promise<CredentialsSummary> {
  const env = input.rawEnv as Record<string, string | undefined>;
  const [atlassianToken, githubToken, zendeskToken, trelloKey, trelloToken] = await Promise.all([
    tokenStatus(resolveCredentialTarget("atlassian", env, isFile), statFn),
    tokenStatus(resolveCredentialTarget("github", env, isFile), statFn),
    tokenStatus(resolveCredentialTarget("zendesk", env, isFile), statFn),
    tokenStatus(resolveCredentialTarget("trello-key", env, isFile), statFn),
    tokenStatus(resolveCredentialTarget("trello-token", env, isFile), statFn),
  ]);
  const envOrgs = env.BUTCHR_GITHUB_ORGS?.trim();
  const fileOrgs = input.settingsFileValues.BUTCHR_GITHUB_ORGS;
  const orgsSource = envOrgs ? "environment" : fileOrgs !== undefined ? "file" : "default";
  const orgs = (envOrgs || fileOrgs || "").split(",").map((o) => o.trim()).filter(Boolean);
  return {
    atlassian: { site: input.atlassian.site === null ? null : redactUrlUserinfo(input.atlassian.site), email: input.atlassian.email, token: atlassianToken },
    github: { token: githubToken, orgs, orgsSource, orgsEditable: orgsSource !== "environment", active: input.githubActive, runningOrgs: [...input.running.githubOrgs] },
    zendesk: {
      subdomain: layered("ZENDESK_SUBDOMAIN", env, input.settingsFileValues, input.running.zendeskSubdomain),
      token: zendeskToken,
      riskAccepted: env[ZENDESK_RISK_ACK_ENV]?.trim() === ZENDESK_RISK_ACK_VALUE,
    },
    trello: {
      boardId: layered("TRELLO_BOARD_ID", env, input.settingsFileValues, input.running.trelloBoardId),
      apiKey: trelloKey,
      token: trelloToken,
      riskAccepted: env[TRELLO_RISK_ACK_ENV]?.trim() === TRELLO_RISK_ACK_VALUE,
    },
    setupCode: setupCodeInstructions(input.supervisor, input.ownPid),
    restart: { supported: input.supervisor.kind !== "none", supervisor: input.supervisor.kind, startedAt: input.startedAt },
  };
}
