/**
 * FACTORY-664 (epic FACTORY-659, slice S1, READ-ONLY) — `GET /api/settings`'s
 * response shape and builder: one entry per setting butchr reads out of
 * `../config/config.ts`'s `ConfigEnv`, reused verbatim (names and purpose),
 * never re-derived. This module does no I/O of its own except `statTokenFile`
 * (a single `fs.stat` on the one path named by `ATLASSIAN_TOKEN_FILE`) —
 * everything else is a pure function over an env snapshot.
 *
 * FACTORY-694 item 4: each definition below carries its OWN explicit
 * `secret: boolean`, set on purpose by a human reviewing that one key — NOT
 * derived from the key's name at runtime. `SECRET_KEY_RE` still exists (and
 * `test/unit/settings-api.test.ts` still cross-checks every definition
 * against it) as a regression guard, so a key whose NAME looks secret-like
 * can never be marked `secret: false` by accident — but the regex is no
 * longer what decides what `buildSettingEntries` actually hides: a future
 * key with a genuinely secret VALUE and a non-matching name is only ever
 * hidden because someone explicitly wrote `secret: true` for it here, the
 * same way `GITHUB_TOKEN_FILE` (a file path, not a secret value, but named
 * like one) is explicitly `secret: true` below even though nothing about its
 * actual value needs hiding — the explicit flag is reviewed per-key, not
 * inferred either direction.
 *
 * A `secret: true` definition NEVER reports a value — only `{set: boolean}`.
 * `ATLASSIAN_TOKEN_FILE` is the one deliberate exception, pulled out of the
 * generic list entirely: it names a FILE PATH, not a secret, so it is
 * reported as its own structure with the path plus `{exists, readable,
 * mode, tooOpen}` — never the file's contents.
 */
import { constants as fsConstants } from "node:fs";
import { stat } from "node:fs/promises";
import { effectiveSettingsEnv, isAllowlistedSettingsKey } from "../settings/settings-file.js";
import type { CredentialsSummary } from "./credentials-api.js";
import { PROVIDER_ENABLED_ENV_VAR } from "../rules/provider-enablement.js";

export const SECRET_KEY_RE = /token|secret|password|key/i;

/** Every env var butchr's `loadConfig` reads, in the order it's documented in `../config/config.ts`'s own `ConfigEnv` — the source of truth this list must never drift from. `ATLASSIAN_TOKEN_FILE` is deliberately excluded: it gets its own dedicated field (see `SettingsApiResponse.atlassianTokenFile`), never a generic entry. */
export const SETTINGS_DEFINITIONS: ReadonlyArray<{ key: string; description: string; secret: boolean }> = [
  { key: "BUTCHR_AGENT_PROVIDER", description: "Default agent provider (claude, codex, or agy) used when no per-role override is set.", secret: false },
  { key: "BUTCHR_AGENT_PROVIDERS", description: "Ordered fallback list of agent providers, overriding BUTCHR_AGENT_PROVIDER.", secret: false },
  { key: "BUTCHR_AGENT_PROVIDERS_PROJECT", description: "Ordered provider fallback list for project-tier agents.", secret: false },
  { key: "BUTCHR_AGENT_PROVIDERS_EPIC", description: "Ordered provider fallback list for epic-tier agents.", secret: false },
  { key: "BUTCHR_AGENT_PROVIDERS_STORY", description: "Ordered provider fallback list for story-tier agents.", secret: false },
  { key: "BUTCHR_AGENT_PROVIDERS_TASK", description: "Ordered provider fallback list for task-tier agents.", secret: false },
  { key: "BUTCHR_AGENT_MODEL", description: "Model name passed to the agent provider, when set.", secret: false },
  { key: "ATLASSIAN_SITE", description: "The Atlassian (Jira/Confluence) site base URL this daemon reads and writes.", secret: false },
  { key: "ATLASSIAN_EMAIL", description: "The Atlassian account email used for basic-auth API calls.", secret: false },
  { key: "ATLASSIAN_TOKEN", description: "The Atlassian API token, used directly (ATLASSIAN_TOKEN_FILE is the preferred alternative).", secret: true },
  { key: "BUTCHR_PORT", description: "The TCP port this daemon's MCP endpoint and dashboard listen on. Default 7717.", secret: false },
  { key: "HERDR_SOCKET", description: "Path to the herdr socket, when not herdr's own default.", secret: false },
  { key: "BUTCHR_TERMINAL", description: "Terminal-emulator command prefix for opening an agent shell; auto-detected when unset.", secret: false },
  { key: "GITHUB_TOKEN_FILE", description: "Path to a file holding the GitHub token used for pr:* discovery and the github-issue/github-pr rule providers.", secret: true },
  { key: "BUTCHR_GITHUB_ORGS", description: "Comma-separated GitHub organizations the GitHub integration is scoped to.", secret: false },
  // local/ui: the Zendesk and Trello credentials the Settings page's cards manage (read by their providers, not `loadConfig`).
  { key: "ZENDESK_SUBDOMAIN", description: "The Zendesk subdomain zendesk-ticket rules and the agents' Zendesk tools use (acme for acme.zendesk.com).", secret: false },
  { key: "ZENDESK_OAUTH_TOKEN_FILE", description: "Path to a file holding the Zendesk OAuth access token (owner-only, chmod 600).", secret: true },
  { key: "BUTCHR_ZENDESK_ACCEPT_SHELL_CREDENTIAL_RISK", description: "Must be agents-can-read-the-zendesk-token to turn Zendesk on: agents run shell commands as butchr's user, so they can read the token file.", secret: false },
  { key: "TRELLO_BOARD_ID", description: "The one Trello board trello-card resources are scoped to (24-character id).", secret: false },
  { key: "TRELLO_API_KEY_FILE", description: "Path to a file holding the Trello API key.", secret: true },
  { key: "TRELLO_TOKEN_FILE", description: "Path to a file holding the Trello API token.", secret: true },
  { key: "BUTCHR_TRELLO_ACCEPT_SHELL_CREDENTIAL_RISK", description: "Must be agents-can-read-the-trello-credentials to turn trello-card rules on: agents run shell commands as butchr's user, so they can read the key and token files.", secret: false },
  { key: "BUTCHR_OPS_ALERT_DEDUP_MINUTES", description: "Dedup window, in minutes: at most one [butchr:ops-alert] journal line per condition in this window.", secret: false },
  { key: "BUTCHR_STALLED_MINUTES", description: "Minutes an active ticket's agent must sit idle before it's surfaced as agent:stalled.", secret: false },
  { key: "BUTCHR_ABANDONED_MINUTES", description: "Minutes a worker sits ABANDONED before the abandoned-worker escalation fires.", secret: false },
  { key: "BUTCHR_ATREST_MINUTES", description: "Minutes a resource may read asleep-with-agent-running before the frozen-asleep detector fires.", secret: false },
  { key: "BUTCHR_CRASHLOOP_COUNT", description: "Spawns of the same resource within the crash-loop window before the crash-loop detector posts.", secret: false },
  { key: "BUTCHR_CRASHLOOP_WINDOW_MINUTES", description: "Rolling window, in minutes, BUTCHR_CRASHLOOP_COUNT is measured over.", secret: false },
  { key: "BUTCHR_STANDDOWN_MAX_MINUTES", description: "Maximum minutes an issue-tier agent may stay asleep before being force-woken as a lost-wake rescue.", secret: false },
  { key: "BUTCHR_YIELDLOOP_COUNT", description: "Edge-driven wakes of the same issue within the yield-loop window before the yield-loop detector posts.", secret: false },
  { key: "BUTCHR_YIELDLOOP_WINDOW_MINUTES", description: "Rolling window, in minutes, BUTCHR_YIELDLOOP_COUNT is measured over.", secret: false },
  { key: "BUTCHR_UNRESPONSIVE_MINUTES", description: "Minutes a pane must be blocked with unparseable text before the sustained-unresponsive alarm fires.", secret: false },
  { key: "BUTCHR_IDLE_DIALOG_MINUTES", description: "Minutes a pane must read idle/done before its text is checked for a missed end-of-pane dialog.", secret: false },
  { key: "BUTCHR_POLL_STALE_MS", description: "Milliseconds /health tolerates the poll loop going without a completed cycle before reporting stale.", secret: false },
  { key: "BUTCHR_HERDR_TIMEOUT_MS", description: "Client-side deadline, in milliseconds, on every call this daemon makes to herdr. A hung herdr socket rejects instead of hanging forever past this. Default 10000, maximum 300000 (5 minutes) — a value above the maximum is refused at startup.", secret: false },
  { key: "BUTCHR_ASSIGNEE_STORY", description: "Atlassian accountId staffed as the assignee for Story-type jira_create_issue calls.", secret: false },
  { key: "BUTCHR_ASSIGNEE_TASK", description: "Atlassian accountId staffed as the assignee for Task-type jira_create_issue calls.", secret: false },
  { key: "BUTCHR_ASSIGNEE_EPIC", description: "Atlassian accountId staffed as the assignee for Epic-type jira_create_issue calls.", secret: false },
  { key: "BUTCHR_CAPTURE_DIR", description: "Directory the session-limit watcher's evidence captures land in.", secret: false },
  { key: "BUTCHR_PERMISSION_AUDIT_PATH", description: "Path to the JSONL audit file for auto-answered permission prompts.", secret: false },
  { key: "BUTCHR_LIZARD_APPROVAL_SOUND", description: "When set to any non-empty value, plays a sound on auto-approve (lizard mode).", secret: false },
  { key: "BUTCHR_LIZARD_APPROVAL_SOUND_PATH", description: "Local file path override for the lizard-mode approval sound; defaults to drovr's bundled asset.", secret: false },
  { key: "BUTCHR_PERMISSION_ANSWER_CANARY_PANE", description: "When set, narrows permission-answer eligibility to exactly this one pane label.", secret: false },
  { key: "BUTCHR_PROJECT_ALLOWLIST", description: "Comma-separated Jira project keys the project tier is allowed to staff. Default empty (none staffed).", secret: false },
  { key: "BUTCHR_MAX_AGENTS", description: "Fixed cap on agents this daemon keeps resident at once.", secret: false },
  { key: "BUTCHR_RESTORED_RESUME", description: "Policy for which managed-session agents may resume after a restore: off, all, or a comma-separated list.", secret: false },
  { key: "BUTCHR_ATLASSIAN_ENABLED", description: "Explicit kill switch for the whole Atlassian credential (jira-work/jira-idea/jira-project/confluence-page together). Default enabled.", secret: false },
  // FACTORY-66 review round 2: one independent switch per registered
  // provider — see `PROVIDER_ENABLED_ENV_VAR`'s own doc comment
  // (`../rules/provider-enablement.ts`), the single source of truth for
  // these exact names.
  { key: PROVIDER_ENABLED_ENV_VAR["jira-work"], description: "Independent on/off switch for the jira-work rule provider. Default enabled.", secret: false },
  { key: PROVIDER_ENABLED_ENV_VAR["jira-idea"], description: "Independent on/off switch for the jira-idea rule provider. Default enabled.", secret: false },
  { key: PROVIDER_ENABLED_ENV_VAR["jira-project"], description: "Independent on/off switch for the jira-project rule provider. Default enabled.", secret: false },
  { key: PROVIDER_ENABLED_ENV_VAR["confluence-page"], description: "Independent on/off switch for the confluence-page rule provider. Default enabled.", secret: false },
  { key: PROVIDER_ENABLED_ENV_VAR["github-issue"], description: "Independent on/off switch for the github-issue rule provider. Default enabled.", secret: false },
  { key: PROVIDER_ENABLED_ENV_VAR["github-pr"], description: "Independent on/off switch for the github-pr rule provider. Default enabled.", secret: false },
  { key: PROVIDER_ENABLED_ENV_VAR["zendesk-ticket"], description: "Independent on/off switch for the zendesk-ticket rule provider. Default enabled.", secret: false },
  { key: PROVIDER_ENABLED_ENV_VAR.filesystem, description: "Independent on/off switch for the filesystem rule provider. Default enabled.", secret: false },
  // FACTORY-990: jira-component is inert scaffolding with no caller yet
  // (see `../rules/jira-component-type.ts`'s own header) — this entry
  // exists only to keep `SETTINGS_ALLOWLIST` in sync with
  // `PROVIDER_ENABLED_ENV_VAR`, which is total over `ResourceProvider`.
  { key: PROVIDER_ENABLED_ENV_VAR["jira-component"], description: "Independent on/off switch for the jira-component rule provider. Default enabled. Currently inert: no agent can be staffed by this provider yet.", secret: false },
  // local/ui: our trello-card rule type has the same switch.
  { key: PROVIDER_ENABLED_ENV_VAR["trello-card"], description: "Independent on/off switch for the trello-card rule provider. Default enabled.", secret: false },
];

/**
 * FACTORY-665: a THIRD source joins `"environment"`/`"default"` —
 * `"file"` means the value came from `settings.json` (an env var was NOT
 * set for this key; see `../settings/settings-file.ts`'s own
 * `effectiveSettingsEnv`, which this builder's caller runs BEFORE handing
 * it an env snapshot). `editable` is `true` exactly for the ticket's own
 * allowlist (`isAllowlistedSettingsKey`) — the Settings page uses it to
 * decide which rows get an edit control; nothing else changes about a
 * non-editable row.
 */
export interface SettingEntryPublic {
  key: string;
  value: string | null;
  source: "environment" | "file" | "default";
  restartNeeded: true;
  secret: false;
  editable: boolean;
  description: string;
}

export interface SettingEntrySecret {
  key: string;
  set: boolean;
  source: "environment" | "file" | "default";
  restartNeeded: true;
  secret: true;
  editable: boolean;
  description: string;
}

export type SettingEntry = SettingEntryPublic | SettingEntrySecret;

export interface AtlassianTokenFileStatus {
  key: "ATLASSIAN_TOKEN_FILE";
  /** The path itself — never secret, never the file's contents. `null` when unset. */
  path: string | null;
  source: "environment" | "default";
  restartNeeded: true;
  secret: false;
  description: string;
  exists: boolean;
  readable: boolean;
  /** Octal permission bits (e.g. 0o600), or `null` when the file could not be stat'd. */
  mode: number | null;
  /** `true` when `mode` grants any permission to group or other (wider than 0600). `null` when `mode` is `null`. */
  tooOpen: boolean | null;
}

/** Best-effort `systemctl --user show butchr.service -p DropInPaths -p EnvironmentFiles` — a FIXED, read-only command with no user input, never shelled out with interpolation. `undefined` on any failure (non-systemd host, no systemctl, timeout) — omitted from the response entirely rather than reported as an error. */
export interface UnitHint {
  dropInPaths: string[];
  environmentFiles: string[];
}

export interface SettingsApiResponse {
  settings: SettingEntry[];
  atlassianTokenFile: AtlassianTokenFileStatus;
  unitHint?: UnitHint;
  /** local/ui — the Settings page's credential cards (`./credentials-api.ts`); added by the daemon, never by `buildSettingsApiResponse`. */
  credentials?: CredentialsSummary;
}

/** FACTORY-694 item 4: a type alias for one `SETTINGS_DEFINITIONS` entry — exported so a test can build an injectable definitions list (see `buildSettingEntries`'s own `definitions` parameter) without duplicating the shape. */
export type SettingDefinition = (typeof SETTINGS_DEFINITIONS)[number];

/**
 * `rawEnv` is the UNMERGED `process.env` (before `effectiveSettingsEnv`
 * layered `settings.json` under it) — needed so this can tell "the env var
 * itself is set" (`"environment"`) apart from "nothing in the real
 * environment, but settings.json supplied a value" (`"file"`), which a
 * single already-merged env snapshot can no longer distinguish once
 * merged. `fileHasKey` answers that for one key.
 */
function sourceOf(rawEnvValue: string | undefined, fileHasKey: boolean): "environment" | "file" | "default" {
  if (rawEnvValue !== undefined && rawEnvValue.trim() !== "") return "environment";
  return fileHasKey ? "file" : "default";
}

/**
 * A non-secret setting's value can still be a URL carrying embedded
 * credentials (`scheme://user:pass@host`, e.g. `ATLASSIAN_SITE`) — those
 * are a secret in disguise, not covered by `SECRET_KEY_RE` (which matches
 * on the ENV VAR NAME, not the value's own shape). Applied to every
 * non-secret value this module ever returns, regardless of which key it
 * came from — never only `ATLASSIAN_SITE` by name, since the shape, not
 * the name, is the thing that leaks. Matches any `scheme://user:pass@`
 * (or `scheme://user@`) prefix, case-insensitively, and replaces the
 * userinfo with `[redacted]` — the host/path/query after `@` is untouched.
 */
const URL_USERINFO_RE = /(?<![A-Za-z0-9+.-])([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s/?#]*@/g; // greedy up to the LAST "@" of the authority: a password containing "@" (https://u:p@ss@host) must not leave "ss" visible

export function redactUrlUserinfo(value: string): string {
  return value.replace(URL_USERINFO_RE, "$1[redacted]@");
}

/**
 * Pure: builds every entry in `SETTINGS_DEFINITIONS` — no I/O.
 * `ATLASSIAN_TOKEN_FILE` is handled by `buildAtlassianTokenFileStatus`
 * instead, never duplicated here. `effectiveEnv` is what this daemon is
 * ACTUALLY running with (`settings.json` already layered under
 * `process.env` by the caller — see `../settings/settings-file.ts`'s
 * `effectiveSettingsEnv`), so `value`/`set` always reflect real behavior;
 * `rawEnv` (defaults to `effectiveEnv`, i.e. no settings.json layer, for
 * every pre-existing caller/test that passes only one env) is used
 * SOLELY to compute `source`/`editable` correctly — see `sourceOf`'s own
 * doc comment. `settingsFileValues` (default `{}`) is the exact map
 * `loadSettingsFile(...).values` produced. `definitions` (default
 * `SETTINGS_DEFINITIONS`, every production caller) is FACTORY-694 item 4's
 * own injection point: secrecy is decided ENTIRELY by each definition's own
 * explicit `secret` field below, never re-derived from the key's name — the
 * parameter exists so a test can prove that with a definition whose name
 * does not match `SECRET_KEY_RE` at all (see `test/unit/settings-api.test.ts`).
 */
export function buildSettingEntries(effectiveEnv: Readonly<Record<string, string | undefined>>, rawEnv: Readonly<Record<string, string | undefined>> = effectiveEnv, settingsFileValues: Readonly<Record<string, string>> = {}, definitions: ReadonlyArray<SettingDefinition> = SETTINGS_DEFINITIONS): SettingEntry[] {
  return definitions.map(({ key, description, secret }) => {
    const raw = effectiveEnv[key];
    const source = sourceOf(rawEnv[key], key in settingsFileValues);
    const editable = isAllowlistedSettingsKey(key) && source !== "environment"; // an env-set key always wins, so a write could never take effect (PUT also answers 409)
    if (secret) {
      return { key, set: raw !== undefined && raw.trim() !== "", source, restartNeeded: true as const, secret: true as const, editable, description };
    }
    const value = raw !== undefined && raw.trim() !== "" ? redactUrlUserinfo(raw) : null;
    return { key, value, source, restartNeeded: true as const, secret: false as const, editable, description };
  });
}

export interface StatResult {
  exists: boolean;
  readable: boolean;
  mode: number | null;
}

/** Real production stat: never throws — any failure (missing file, permission denied, non-POSIX host) reports `{exists: false, readable: false, mode: null}`. */
export async function statTokenFile(path: string): Promise<StatResult> {
  try {
    const st = await stat(path);
    const mode = st.mode & 0o777;
    let readable = false;
    try {
      const { access } = await import("node:fs/promises");
      await access(path, fsConstants.R_OK);
      readable = true;
    } catch {
      readable = false;
    }
    return { exists: true, readable, mode };
  } catch {
    return { exists: false, readable: false, mode: null };
  }
}

/** `mode` wider than 0600 means group or other has any bit set. */
export function isModeTooOpen(mode: number): boolean {
  return (mode & 0o077) !== 0;
}

export async function buildAtlassianTokenFileStatus(env: Readonly<Record<string, string | undefined>>, statFn: (path: string) => Promise<StatResult> = statTokenFile): Promise<AtlassianTokenFileStatus> {
  const path = env.ATLASSIAN_TOKEN_FILE?.trim() || null;
  const description = "Path to a file holding the Atlassian API token (preferred over ATLASSIAN_TOKEN).";
  const source = sourceOf(env.ATLASSIAN_TOKEN_FILE, false) === "environment" ? "environment" : "default"; // ATLASSIAN_TOKEN_FILE is never settings.json-backed, so "file" can never apply here
  if (path === null) {
    return { key: "ATLASSIAN_TOKEN_FILE", path: null, source, restartNeeded: true, secret: false, description, exists: false, readable: false, mode: null, tooOpen: null };
  }
  const st = await statFn(path);
  return {
    key: "ATLASSIAN_TOKEN_FILE",
    path,
    source,
    restartNeeded: true,
    secret: false,
    description,
    exists: st.exists,
    readable: st.readable,
    mode: st.mode,
    tooOpen: st.mode === null ? null : isModeTooOpen(st.mode),
  };
}

/**
 * `rawEnv` (default `env`, i.e. no settings.json layer — every pre-
 * existing caller/test keeps working unchanged) and `settingsFileValues`
 * (default `{}`) are FACTORY-665's additions — see `buildSettingEntries`'s
 * own doc comment for exactly what they're for. `env` itself is expected
 * to already be the EFFECTIVE env (settings.json layered under
 * `process.env`, `../settings/settings-file.ts`'s `effectiveSettingsEnv`)
 * when the caller has one; `src/daemon/index.ts` is the one production
 * caller that does.
 */
/**
 * local/ui — the response for settings.json as it is right now. Both
 * `GET /api/settings` and the reply to a `PUT` are built from it, so a value
 * saved from the Settings page reads back as saved (`source: "file"`) until
 * the restart that applies it, even after leaving the page or reloading.
 * Upstream's GET served the startup snapshot instead, so the page went back to
 * showing the old value.
 */
export async function buildCurrentSettingsApiResponse(
  rawEnv: Readonly<Record<string, string | undefined>>,
  readSettingsFile: () => { values: Readonly<Record<string, string>> },
  deps: { statFn?: (path: string) => Promise<StatResult>; unitHint?: () => Promise<UnitHint | undefined> } = {},
): Promise<SettingsApiResponse> {
  const values = readSettingsFile().values;
  return buildSettingsApiResponse(effectiveSettingsEnv(rawEnv as Record<string, string | undefined>, values as Record<string, string>), { ...deps, rawEnv, settingsFileValues: values });
}

export async function buildSettingsApiResponse(env: Readonly<Record<string, string | undefined>>, deps: { statFn?: (path: string) => Promise<StatResult>; unitHint?: () => Promise<UnitHint | undefined>; rawEnv?: Readonly<Record<string, string | undefined>>; settingsFileValues?: Readonly<Record<string, string>> } = {}): Promise<SettingsApiResponse> {
  const [atlassianTokenFile, unitHint] = await Promise.all([
    buildAtlassianTokenFileStatus(env, deps.statFn),
    deps.unitHint ? deps.unitHint() : Promise.resolve(undefined),
  ]);
  return {
    settings: buildSettingEntries(env, deps.rawEnv ?? env, deps.settingsFileValues ?? {}),
    atlassianTokenFile,
    ...(unitHint ? { unitHint } : {}),
  };
}
