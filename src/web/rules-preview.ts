/**
 * FACTORY-660 — `GET /api/rules/:id/preview`'s read-only dry-run: "what
 * tickets would this rule staff right now", for exactly one rule, without
 * starting anything. REUSE, NOT RE-DERIVATION: the actual Jira query goes
 * through `searchRules`/`searchJiraIdeaRules` (`../rules/resource-type.js` /
 * `../rules/jira-idea-type.js`) — the exact functions `butchr rules check`
 * (`../cli/rules-cli.ts`) and the daemon's own poll loops already call —
 * fed a single-rule list so no rule-matching logic is reimplemented here.
 *
 * SPEC CHANGE (b), agentsafety review 2026-10-05: the response carries
 * COUNTS AND TICKET KEYS ONLY — no summary/status text, which `rules-cli.ts`
 * does print but this HTTP endpoint deliberately drops. A Jira failure never
 * reaches the caller as Jira's own error body or a stack trace: it's mapped
 * to one fixed message. Capped at `cap` (default 50) returned keys; `total`
 * is the real, uncapped match count, so the cap is visible as a cap rather
 * than silently read as "the whole answer". Rate-limited to one request per
 * rule per `rateLimitMs` (default 2s) and bounded to `timeoutMs` (default
 * 15s) — this is a GET that does a real outbound network call, so both
 * exist to keep it from being a free way to hammer this daemon's own Jira
 * credentials.
 */
import type { JiraIssue } from "../atlassian/types.js";
import type { Rule } from "../rules/rules.js";
import { searchRules } from "../rules/resource-type.js";
import { searchJiraIdeaRules } from "../rules/jira-idea-type.js";

const JIRA_BACKED_PROVIDERS = new Set(["jira-work", "jira-idea"]);

export const DEFAULT_PREVIEW_CAP = 50;
export const DEFAULT_PREVIEW_TIMEOUT_MS = 15_000;
export const DEFAULT_PREVIEW_RATE_LIMIT_MS = 2_000;

export type RulesPreviewResult =
  | { ok: true; keys: string[]; total: number; cap: number; warning: string | null }
  | { ok: false; status: number; error: string };

export interface RulesPreviewDeps {
  /**
   * FACTORY-657/review round 2, R2: the daemon's own LIVE rules —
   * `RulesHolder.getRules()` (`../rules/rules.js`), read FRESH on every
   * call, never a startup-only snapshot. Passed as a function (not a plain
   * array) so a reload (SIGHUP, or FACTORY-663's in-process
   * `reloadRules()`) takes effect on the very next preview with no second
   * wiring path to keep in sync.
   */
  rules: () => readonly Rule[];
  /** `AtlassianClient#searchAll`, bound — the ONLY Jira capability this module ever calls (a GET search), same discipline as `rules-cli.ts`'s own `RulesCheckJiraEnv`. */
  search: (jql: string) => Promise<JiraIssue[]>;
  maxAgents: number;
  now?: () => number;
  cap?: number;
  timeoutMs?: number;
  rateLimitMs?: number;
}

/** Same discipline as `../jira-watch/external-poll.ts`'s own `withTimeout` — kept as a small local copy rather than exported/shared, since this module's only network-shaped await is the one call below. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/** Dry-runs exactly one rule, through the SAME provider-specific matcher the daemon's own poll loop for that provider calls. */
async function searchForRule(rule: Rule, search: (jql: string) => Promise<JiraIssue[]>): Promise<JiraIssue[]> {
  if (rule.resourceProvider === "jira-work") {
    return (await searchRules({ rules: [rule], search })).map((m) => m.issue);
  }
  return (await searchJiraIdeaRules({ rules: [rule], search })).map((m) => m.issue);
}

/**
 * Builds the previewer closure — one instance shared across every request,
 * so the per-rule rate-limit map actually accumulates across calls (a fresh
 * closure per request would reset it every time, defeating the limit
 * entirely).
 */
export function createRulesPreviewer(deps: RulesPreviewDeps): (id: string) => Promise<RulesPreviewResult> {
  const now = deps.now ?? (() => Date.now());
  const cap = deps.cap ?? DEFAULT_PREVIEW_CAP;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_PREVIEW_TIMEOUT_MS;
  const rateLimitMs = deps.rateLimitMs ?? DEFAULT_PREVIEW_RATE_LIMIT_MS;
  const lastCallAt = new Map<string, number>();

  return async function preview(id: string): Promise<RulesPreviewResult> {
    const rule = deps.rules().find((r) => r.id === id);
    if (!rule) return { ok: false, status: 404, error: "rule not found" };
    if (!JIRA_BACKED_PROVIDERS.has(rule.resourceProvider)) {
      return { ok: false, status: 400, error: `rule "${id}" is not previewable: "${rule.resourceProvider}" is not a Jira-backed provider` };
    }

    const t = now();
    const last = lastCallAt.get(id);
    if (last !== undefined && t - last < rateLimitMs) {
      return { ok: false, status: 429, error: `rate limited: at most one preview per rule every ${rateLimitMs}ms` };
    }
    lastCallAt.set(id, t);

    let issues: JiraIssue[];
    try {
      issues = await withTimeout(searchForRule(rule, deps.search), timeoutMs);
    } catch (e) {
      const timedOut = (e as Error)?.message?.startsWith("timed out after");
      // Never the real Jira error body/stack here (SPEC CHANGE (b)) — a
      // fixed, safe message regardless of what actually failed.
      return { ok: false, status: timedOut ? 504 : 502, error: timedOut ? "preview timed out" : "preview failed: could not query Jira" };
    }

    const total = issues.length;
    const keys = issues.slice(0, cap).map((i) => i.key);
    const warning = total > deps.maxAgents
      ? `this rule would staff ${total} real ticket(s), exceeding maxAgents=${deps.maxAgents} — only ${deps.maxAgents} would run across the whole fleet this poll`
      : null;
    return { ok: true, keys, total, cap, warning };
  };
}
