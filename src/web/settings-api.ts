/**
 * FACTORY-664 (epic FACTORY-659, slice S1, READ-ONLY) — `GET /api/settings`'s
 * response shape and builder: one entry per setting butchr reads out of
 * `../config/config.ts`'s `ConfigEnv`, reused verbatim (names and purpose),
 * never re-derived. This module does no I/O of its own except `statTokenFile`
 * (a single `fs.stat` on the one path named by `ATLASSIAN_TOKEN_FILE`) —
 * everything else is a pure function over an env snapshot.
 *
 * SECRET-LIKE KEYS (name matches `TOKEN|SECRET|PASSWORD|KEY`, case-insensitive)
 * NEVER report a value — only `{set: boolean}`. `ATLASSIAN_TOKEN_FILE` is the
 * one deliberate exception, pulled out of the generic list entirely: it names
 * a FILE PATH, not a secret, so it is reported as its own structure with the
 * path plus `{exists, readable, mode, tooOpen}` — never the file's contents.
 */
import { constants as fsConstants } from "node:fs";
import { stat } from "node:fs/promises";
import { isAllowlistedSettingsKey } from "../settings/settings-file.js";

export const SECRET_KEY_RE = /token|secret|password|key/i;

/** Every env var butchr's `loadConfig` reads, in the order it's documented in `../config/config.ts`'s own `ConfigEnv` — the source of truth this list must never drift from. `ATLASSIAN_TOKEN_FILE` is deliberately excluded: it gets its own dedicated field (see `SettingsApiResponse.atlassianTokenFile`), never a generic entry. */
export const SETTINGS_DEFINITIONS: ReadonlyArray<{ key: string; description: string }> = [
  { key: "BUTCHR_AGENT_PROVIDER", description: "Default agent provider (claude, codex, or agy) used when no per-role override is set." },
  { key: "BUTCHR_AGENT_PROVIDERS", description: "Ordered fallback list of agent providers, overriding BUTCHR_AGENT_PROVIDER." },
  { key: "BUTCHR_AGENT_PROVIDERS_PROJECT", description: "Ordered provider fallback list for project-tier agents." },
  { key: "BUTCHR_AGENT_PROVIDERS_EPIC", description: "Ordered provider fallback list for epic-tier agents." },
  { key: "BUTCHR_AGENT_PROVIDERS_STORY", description: "Ordered provider fallback list for story-tier agents." },
  { key: "BUTCHR_AGENT_PROVIDERS_TASK", description: "Ordered provider fallback list for task-tier agents." },
  { key: "BUTCHR_AGENT_MODEL", description: "Model name passed to the agent provider, when set." },
  { key: "ATLASSIAN_SITE", description: "The Atlassian (Jira/Confluence) site base URL this daemon reads and writes." },
  { key: "ATLASSIAN_EMAIL", description: "The Atlassian account email used for basic-auth API calls." },
  { key: "ATLASSIAN_TOKEN", description: "The Atlassian API token, used directly (ATLASSIAN_TOKEN_FILE is the preferred alternative)." },
  { key: "BUTCHR_PORT", description: "The TCP port this daemon's MCP endpoint and dashboard listen on. Default 7717." },
  { key: "HERDR_SOCKET", description: "Path to the herdr socket, when not herdr's own default." },
  { key: "BUTCHR_TERMINAL", description: "Terminal-emulator command prefix for opening an agent shell; auto-detected when unset." },
  { key: "GITHUB_TOKEN_FILE", description: "Path to a file holding the GitHub token used for pr:* discovery and the github-issue/github-pr rule providers." },
  { key: "BUTCHR_GITHUB_ORGS", description: "Comma-separated GitHub organizations the GitHub integration is scoped to." },
  { key: "ROCKETCHAT_URL", description: "Rocket.Chat server URL for account-management (BUTCHR-395/S4)." },
  { key: "ROCKETCHAT_ADMIN_USER_ID", description: "Rocket.Chat admin user id for account-management calls." },
  { key: "ROCKETCHAT_ADMIN_TOKEN_FILE", description: "Path to a file holding the Rocket.Chat admin token for account-management." },
  { key: "ROCKETCHAT_USER_CAP_THRESHOLD", description: "Guardrail: refuse new Rocket.Chat accounts at/above this many total users. Default 45." },
  { key: "ROCKETCHAT_TEMPORARY_CAP_THRESHOLD", description: "Cap on concurrently-existing temporary Rocket.Chat accounts. Default 8." },
  { key: "ROCKETCHAT_TOKEN_DIR", description: "Directory each managed account's 0600 token file is written into." },
  { key: "ROCKETCHAT_NEXUS_MANIFEST_FILE", description: "Path the batched Nexus hand-off manifest is published to." },
  { key: "ROCKETCHAT_MANAGED_PREFIX", description: "Naming prefix override for Rocket.Chat managed accounts." },
  { key: "BUTCHR_TEAM_ADMIN_ROCKETCHAT_URL", description: "Rocket.Chat server URL for the managed-session escalation poster (separate identity from account-management)." },
  { key: "BUTCHR_TEAM_ADMIN_ROCKETCHAT_USER_ID", description: "Rocket.Chat user id for the managed-session escalation poster." },
  { key: "BUTCHR_TEAM_ADMIN_ROCKETCHAT_TOKEN_FILE", description: "Path to a file holding the Rocket.Chat token for the managed-session escalation poster." },
  { key: "BUTCHR_TEAM_ADMIN_ROOM", description: "Rocket.Chat room managed-session escalations (and ordinary tier 1/2 routing) post to. Default team-admin." },
  { key: "BUTCHR_MANAGED_ESCALATION_ANSWERER_MENTION", description: "Mention text used for a normal-tier managed-session escalation." },
  { key: "BUTCHR_MANAGED_ESCALATION_ASSEMBLY_MENTION", description: "Mention text used for an assembly-tier managed-session escalation." },
  { key: "BUTCHR_MANAGED_ESCALATION_ASSEMBLY_ROOM", description: "Rocket.Chat room an assembly-tier managed-session escalation posts to." },
  { key: "BUTCHR_MANAGED_ESCALATION_DIRECTOR_MENTION", description: "Mention text used for a director-tier managed-session escalation." },
  { key: "BUTCHR_MANAGED_ESCALATION_DIRECTOR_ROOM", description: "Rocket.Chat room a director-tier managed-session escalation posts to." },
  { key: "BUTCHR_MANAGED_ESCALATION_TIER2_MINUTES", description: "Minutes before a managed-session escalation advances to tier 2." },
  { key: "BUTCHR_MANAGED_ESCALATION_TIER3_MINUTES", description: "Minutes before a managed-session escalation advances to tier 3." },
  { key: "BUTCHR_OPS_ALERT_ROOM", description: "Rocket.Chat room generic ops-alert conditions (e.g. a dead credential) post to." },
  { key: "BUTCHR_OPS_ALERT_MENTION", description: "Mention prepended to an ops-alert post. Literal 'none' posts with no mention." },
  { key: "BUTCHR_OPS_ALERT_DEDUP_MINUTES", description: "Dedup window, in minutes: at most one ops-alert post per condition in this window." },
  { key: "BUTCHR_STALLED_MINUTES", description: "Minutes an active ticket's agent must sit idle before it's surfaced as agent:stalled." },
  { key: "BUTCHR_PARKED_MINUTES", description: "Minutes a staffed child sits in To Do under a live boss before the parked-ticket escalation fires." },
  { key: "BUTCHR_ABANDONED_MINUTES", description: "Minutes a worker sits ABANDONED before the abandoned-worker escalation fires." },
  { key: "BUTCHR_ATREST_MINUTES", description: "Minutes a resource may read asleep-with-agent-running before the frozen-asleep detector fires." },
  { key: "BUTCHR_CRASHLOOP_COUNT", description: "Spawns of the same resource within the crash-loop window before the crash-loop detector posts." },
  { key: "BUTCHR_CRASHLOOP_WINDOW_MINUTES", description: "Rolling window, in minutes, BUTCHR_CRASHLOOP_COUNT is measured over." },
  { key: "BUTCHR_STANDDOWN_MAX_MINUTES", description: "Maximum minutes an issue-tier agent may stay asleep before being force-woken as a lost-wake rescue." },
  { key: "BUTCHR_YIELDLOOP_COUNT", description: "Edge-driven wakes of the same issue within the yield-loop window before the yield-loop detector posts." },
  { key: "BUTCHR_YIELDLOOP_WINDOW_MINUTES", description: "Rolling window, in minutes, BUTCHR_YIELDLOOP_COUNT is measured over." },
  { key: "BUTCHR_UNRESPONSIVE_MINUTES", description: "Minutes a pane must be blocked with unparseable text before the sustained-unresponsive alarm fires." },
  { key: "BUTCHR_IDLE_DIALOG_MINUTES", description: "Minutes a pane must read idle/done before its text is checked for a missed end-of-pane dialog." },
  { key: "BUTCHR_POLL_STALE_MS", description: "Milliseconds /health tolerates the poll loop going without a completed cycle before reporting stale." },
  { key: "BUTCHR_ASSIGNEE_STORY", description: "Atlassian accountId staffed as the assignee for Story-type jira_create_issue calls." },
  { key: "BUTCHR_ASSIGNEE_TASK", description: "Atlassian accountId staffed as the assignee for Task-type jira_create_issue calls." },
  { key: "BUTCHR_ASSIGNEE_EPIC", description: "Atlassian accountId staffed as the assignee for Epic-type jira_create_issue calls." },
  { key: "BUTCHR_CAPTURE_DIR", description: "Directory the session-limit watcher's evidence captures land in." },
  { key: "BUTCHR_PERMISSION_AUDIT_PATH", description: "Path to the JSONL audit file for auto-answered permission prompts." },
  { key: "BUTCHR_LIZARD_APPROVAL_SOUND", description: "When set to any non-empty value, plays a sound on auto-approve (lizard mode)." },
  { key: "BUTCHR_LIZARD_APPROVAL_SOUND_PATH", description: "Local file path override for the lizard-mode approval sound; defaults to drovr's bundled asset." },
  { key: "BUTCHR_PERMISSION_ANSWER_CANARY_PANE", description: "When set, narrows permission-answer eligibility to exactly this one pane label." },
  { key: "BUTCHR_PROJECT_ALLOWLIST", description: "Comma-separated Jira project keys the project tier is allowed to staff. Default empty (none staffed)." },
  { key: "BUTCHR_MAX_AGENTS", description: "Fixed cap on agents this daemon keeps resident at once." },
  { key: "BUTCHR_RESTORED_RESUME", description: "Policy for which managed-session agents may resume after a restore: off, all, or a comma-separated list." },
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
}

function isSecretKey(key: string): boolean {
  return SECRET_KEY_RE.test(key);
}

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
 * credentials (`scheme://user:pass@host`, e.g. `ROCKETCHAT_URL`) — those
 * are a secret in disguise, not covered by `SECRET_KEY_RE` (which matches
 * on the ENV VAR NAME, not the value's own shape). Applied to every
 * non-secret value this module ever returns, regardless of which key it
 * came from — never only `ROCKETCHAT_URL` by name, since the shape, not
 * the name, is the thing that leaks. Matches any `scheme://user:pass@`
 * (or `scheme://user@`) prefix, case-insensitively, and replaces the
 * userinfo with `[redacted]` — the host/path/query after `@` is untouched.
 */
const URL_USERINFO_RE = /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^\s/?#@]+@/g;

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
 * `loadSettingsFile(...).values` produced.
 */
export function buildSettingEntries(effectiveEnv: Readonly<Record<string, string | undefined>>, rawEnv: Readonly<Record<string, string | undefined>> = effectiveEnv, settingsFileValues: Readonly<Record<string, string>> = {}): SettingEntry[] {
  return SETTINGS_DEFINITIONS.map(({ key, description }) => {
    const raw = effectiveEnv[key];
    const source = sourceOf(rawEnv[key], key in settingsFileValues);
    const editable = isAllowlistedSettingsKey(key);
    if (isSecretKey(key)) {
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
