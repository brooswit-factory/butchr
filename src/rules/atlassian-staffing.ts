/**
 * FACTORY-66 — the `{run, rules, reason}` staffing shape `githubIssueStaffing`
 * (src/rules/github-issue-type.ts), `githubPrStaffing` (src/rules/github-pr-type.ts)
 * and `zendeskTicketStaffing` (src/rules/zendesk-ticket-type.ts) already
 * established, generalized across the four Atlassian-backed
 * `RESOURCE_PROVIDERS` (src/rules/agent-key.ts): `jira-work`, `jira-idea`,
 * `jira-project` and `confluence-page`. They all share ONE credential
 * (`Config.atlassian`), so one function computes all four decisions rather
 * than four near-identical copies.
 *
 * Pulled out of `src/daemon/index.ts` (which has no unit test importing it —
 * see that file's own header) into this small, directly-testable module, the
 * same way the three staffing functions above already live in their own
 * `src/rules/*.ts` files rather than inline in the daemon entrypoint.
 *
 * Two outcomes:
 *  - `run: false, rules: [], reason: null` — no enabled rules of this
 *    provider at all; nothing to report (matches the other staffing
 *    functions' own `reason: null` convention for "nothing to say").
 *  - `run: false, rules: enabled, reason: <string>` — enabled rules exist
 *    but Atlassian itself is off (disabled/unconfigured/misconfigured —
 *    `atlassianDisabledReason`, from `Config.atlassianDisabledReason`,
 *    names which), naming the affected rule ids.
 *  - `run: true, rules: enabled, reason: null` — staffed normally.
 */
import type { ResourceProvider } from "./agent-key.js";
import type { Rule } from "./rules.js";

export type AtlassianProviderStaffing =
  | { run: true; rules: Rule[]; reason: null }
  | { run: false; rules: Rule[]; reason: string | null };

export function atlassianProviderStaffing(
  provider: ResourceProvider,
  rules: readonly Rule[],
  atlassianConfigured: boolean,
  atlassianDisabledReason: string | undefined,
): AtlassianProviderStaffing {
  const enabled = rules.filter((r) => r.enabled && r.resourceProvider === provider);
  if (!enabled.length) return { run: false, rules: [], reason: null };
  if (!atlassianConfigured) {
    const ids = enabled.map((r) => r.id).join(", ");
    return { run: false, rules: enabled, reason: `${provider} rules not staffed (${ids}): ${atlassianDisabledReason ?? "Atlassian is not configured"}` };
  }
  return { run: true, rules: enabled, reason: null };
}
