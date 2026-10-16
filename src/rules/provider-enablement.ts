/**
 * FACTORY-66 review round 2 (brooswit, PR #797, @ 46b4c7f) — a single
 * `BUTCHR_ATLASSIAN_ENABLED` flag disabled four distinct `RESOURCE_PROVIDERS`
 * (`jira-work`, `jira-idea`, `jira-project`, `confluence-page`) together,
 * which the reviewer correctly read as not meeting this ticket's own "EACH
 * registered provider" acceptance criterion: an operator could not keep
 * Atlassian credentials AND three sibling providers active while disabling
 * just one of the four. This module adds an independent, explicitly-named
 * switch per provider (`BUTCHR_PROVIDER_<PROVIDER>_ENABLED`) for ALL EIGHT
 * `RESOURCE_PROVIDERS` (`./agent-key.ts`) — not only the four Atlassian-
 * backed ones — so every registered provider has its own distinct
 * enable/disable surface, independent of BOTH `rule.enabled` (per-rule) and
 * credential presence (`github?`/zendesk's existing gate): a provider can
 * be individually switched off with its credentials, siblings and enabled
 * rules all otherwise untouched.
 *
 * `BUTCHR_ATLASSIAN_ENABLED` itself is UNCHANGED and still valid — it
 * remains a convenience "kill the whole Atlassian CREDENTIAL" lever
 * (`src/config/config.ts`'s `loadAtlassianConfig`), a DIFFERENT, coarser
 * concept than this per-provider switch. The two compose (either one being
 * "off" disables a provider) rather than replace each other: an operator
 * who only ever used `BUTCHR_ATLASSIAN_ENABLED=false` keeps working exactly
 * as before.
 *
 * Each switch is read through the SAME settings.json + `/api/settings`
 * surface every other butchr toggle already uses (`SETTINGS_ALLOWLIST`/
 * `SETTINGS_DEFINITIONS`, `src/settings/settings-file.ts`/
 * `src/web/settings-api.ts`) — never a new ad hoc mechanism — same "env var
 * wins over settings.json, settings.json wins over the hardcoded default
 * (true/enabled)" layering `BUTCHR_MAX_AGENTS`/`BUTCHR_AGENT_PROVIDER`
 * already have (`effectiveSettingsEnv`, `src/settings/settings-file.ts`).
 */
import type { ResourceProvider } from "./agent-key.js";
import type { Rule } from "./rules.js";

/** One explicitly-named env var per registered provider — the single source of truth for the name, reused by `src/config/config.ts` (parsing), `src/settings/settings-file.ts` (the allowlist) and `src/web/settings-api.ts` (the read-only catalogue), so the three can never drift apart on spelling. */
export const PROVIDER_ENABLED_ENV_VAR: Record<ResourceProvider, string> = {
  "jira-work": "BUTCHR_PROVIDER_JIRA_WORK_ENABLED",
  "jira-idea": "BUTCHR_PROVIDER_JIRA_IDEA_ENABLED",
  "jira-project": "BUTCHR_PROVIDER_JIRA_PROJECT_ENABLED",
  "confluence-page": "BUTCHR_PROVIDER_CONFLUENCE_PAGE_ENABLED",
  "github-issue": "BUTCHR_PROVIDER_GITHUB_ISSUE_ENABLED",
  "github-pr": "BUTCHR_PROVIDER_GITHUB_PR_ENABLED",
  "zendesk-ticket": "BUTCHR_PROVIDER_ZENDESK_TICKET_ENABLED",
  filesystem: "BUTCHR_PROVIDER_FILESYSTEM_ENABLED",
};

/**
 * Same case-insensitive falsy set `BUTCHR_ATLASSIAN_ENABLED` already
 * established (`loadAtlassianConfig`, `src/config/config.ts`) —
 * `"false"`/`"0"`/`"no"`/`"off"`; anything else (including unset) is
 * enabled. Kept lenient here (this is the raw-env/settings-value READ
 * path, not the stricter "true"/"false"-only write validation
 * `src/settings/settings-file.ts`'s `"boolean"` allowlist kind enforces
 * for a NEW value reaching settings.json) so a hand-set env var matches
 * the rest of this codebase's existing off-switch convention exactly.
 */
function isExplicitlyFalse(raw: string | undefined): boolean {
  const v = raw?.trim().toLowerCase();
  return v === "false" || v === "0" || v === "no" || v === "off";
}

/** Reads all eight switches from one env snapshot (already layered under settings.json by `effectiveSettingsEnv` by the time `loadConfig` sees it). Pure. Unset/anything-not-falsy is enabled — a host that sets none of these behaves byte-for-byte as before this ticket. */
export function parseProviderEnabledMap(env: Record<string, string | undefined>): Record<ResourceProvider, boolean> {
  const out = {} as Record<ResourceProvider, boolean>;
  for (const [provider, envVar] of Object.entries(PROVIDER_ENABLED_ENV_VAR) as [ResourceProvider, string][]) {
    out[provider] = !isExplicitlyFalse(env[envVar]);
  }
  return out;
}

/**
 * `reason` is optional, not merely nullable — `githubIssueStaffing`'s own
 * `{run: true; rules: Rule[]}` success branch (`src/rules/github-issue-type.ts`)
 * omits the field entirely rather than carrying `reason: null`, and this
 * wrapper accepts every existing staffing shape unchanged when its switch
 * is on (see `applyProviderSwitch`'s own doc comment).
 */
export type Staffing = { run: boolean; rules: Rule[]; reason?: string | null };

/** The disabled-branch shape every caller's `.reason` read can rely on without a cast — always has a non-null string `reason`, unlike `Staffing.reason` (optional/nullable, since a provider's OWN staffing success branch often omits it). */
export type DisabledStaffing = { run: false; rules: Rule[]; reason: string };

/**
 * Wraps an already-computed staffing/rules decision with this provider's
 * OWN independent switch — applied LAST, after credential/rule-level
 * staffing has already decided `run`/`rules`, so a provider that is BOTH
 * misconfigured (or simply has zero enabled rules) AND explicitly switched
 * off reports the switch — the explicit operator decision — rather than
 * silently falling back to the credential/rule-count reason. When the
 * switch is on (the default), the input is returned UNCHANGED (identity —
 * no new object, no behavior change for any existing caller that leaves
 * the new switch unset).
 *
 * Generic over the EXACT input staffing type (e.g. `ZendeskTicketStaffing`,
 * whose `run: true` branch carries extra `subdomain`/`token` fields no
 * other provider's staffing type has) so every existing caller keeps its
 * own richer type — and its own existing `.run`-discriminated narrowing —
 * unchanged. The return type is a plain union, `T | DisabledStaffing`,
 * deliberately NOT `T`: a disabled result is never actually a member of
 * `T` (e.g. it never carries `ZendeskTicketStaffing`'s `run: true`-only
 * `subdomain`/`token`), so claiming it as `T` would need an unsound cast.
 * Every existing caller's `if (x.run) { ...x.subdomain... }` still narrows
 * correctly either way: `x.run` true rules out `DisabledStaffing` (whose
 * `run` is the literal `false`), leaving exactly `T`'s own `run: true`
 * member.
 */
export function applyProviderSwitch<T extends Staffing>(provider: ResourceProvider, staffing: T, enabled: boolean): T | DisabledStaffing {
  if (enabled) return staffing;
  return { run: false, rules: staffing.rules, reason: `${provider} is disabled (${PROVIDER_ENABLED_ENV_VAR[provider]}=false)` };
}
