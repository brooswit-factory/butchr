/**
 * Deterministic Rocket.Chat identity for a managed account (BUTCHR-395/S4):
 * one username per agent key, reversible enough to recognise "managed by
 * butchr" accounts so the account manager never touches a human's or a
 * legacy Bakr/Candlestix user (retiring those is S5, out of scope here).
 *
 * `RC_MANAGED_PREFIX` is the marker; a customField was considered instead
 * (or in addition) but rejected — a custom field requires the field to
 * already be defined in RC's own admin settings, an out-of-band dependency
 * this module cannot verify or provision, while a username prefix is
 * entirely self-contained and checkable with a string comparison alone. See
 * `docs/rocketchat-accounts.md` for the full write-up.
 */
import { createHash } from "node:crypto";

export const RC_MANAGED_PREFIX = "butchr_";

/**
 * Conservative, self-imposed bound — chosen to sit comfortably under every
 * Rocket.Chat version's own username ceiling (RC does not publish one that
 * this codebase can cite with confidence), not asserted as RC's own limit.
 */
export const RC_USERNAME_MAX = 60;

/** RC-safe username charset: letters, digits, `.`, `-`, `_`. Anything else collapses to `-`. */
const sanitize = (s: string): string => s.replace(/[^A-Za-z0-9._-]/g, "-").replace(/-{2,}/g, "-");

const HASH_LEN = 10;

/**
 * A deterministic, RC-safe, length-bounded username for `agentKey`
 * (`<provider>:<ruleId>:<resourceId>`, see `src/rules/agent-key.ts`).
 *
 * The hash suffix is UNCONDITIONAL, not just a truncation safeguard: agent
 * keys are `:`-separated and `sanitize` collapses both `:` and the `%` of a
 * percent-escaped component to the same `-`, so two DIFFERENT agent keys
 * under the length budget could otherwise sanitize to the identical string
 * (e.g. `jira-work:foo-bar:x` and `jira-work:foo:bar-x`) — the ticket's own
 * "collision-proof when truncating" ask is the truncated case; this closes
 * the untruncated one too, which is just as real.
 */
export function rcUsernameFor(agentKey: string): string {
  const hash = createHash("sha256").update(agentKey).digest("hex").slice(0, HASH_LEN);
  const budget = Math.max(RC_USERNAME_MAX - RC_MANAGED_PREFIX.length - 1 - hash.length, 1);
  const body = sanitize(agentKey).slice(0, budget);
  return `${RC_MANAGED_PREFIX}${body}_${hash}`;
}

/** Whether `username` carries butchr's own managed-account marker — the ONLY signal ever consulted before a destructive RC call. */
export const isManagedUsername = (username: string): boolean => username.startsWith(RC_MANAGED_PREFIX);
