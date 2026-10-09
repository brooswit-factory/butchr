/**
 * FACTORY-660 — `GET /api/rules`'s response shape and builder: the validated
 * rules file state, per rule, for the rules page's UI slice (built in
 * parallel against this module's own types + `rules-api.fixture.json`
 * below, per the ticket's own requirement). REUSE, NOT RE-DERIVATION: every
 * per-rule field except `briefExcerpt` is copied straight off
 * `RuleInventoryEntry` (`../agents/query-agent-inventory.js`) — the exact
 * entry `/configurations` already computes (`buildQueryAgentInventory`),
 * never a second staffing decision.
 *
 * SPEC CHANGE (a), agentsafety review 2026-10-05: no `title`/`maxAgents`
 * field — neither exists on `Rule`. The real fields are `execution`,
 * `account`, `role`, `agentPreferences`, `linkedEventing`, `mcpServerNames`
 * — copied verbatim from `RuleInventoryEntry`, never invented.
 *
 * BRIEF HANDLING: the ticket's own instruction — never the full `brief`
 * (briefs are instructions; the write allowlist excludes them in v1), only
 * a 200-char excerpt. `RuleInventoryEntry` itself carries no `brief` field
 * at all (by the SAME discipline, extended from `/configurations`), so this
 * module reads it off the raw `Rule` list `loadRulesFileState` already
 * produced, keyed by `resourceProvider:id` (`Rule.id` is only unique WITHIN
 * one resource provider — see `Rule.id`'s own doc comment, `../rules/rules.ts`).
 */
import type { RuleInventoryEntry, RulesFileState } from "../agents/query-agent-inventory.js";
import type { Rule, RulePermissionMode } from "../rules/rules.js";

export const BRIEF_EXCERPT_MAX = 200;

/** First `max` characters of `brief` — never the whole thing, per this ticket's own "do NOT return full brief text" instruction. */
export function briefExcerpt(brief: string, max: number = BRIEF_EXCERPT_MAX): string {
  return brief.length > max ? brief.slice(0, max) : brief;
}

/**
 * Defensive redaction, applied to the WHOLE response just before it's
 * returned: any object key matching `token|secret|password|authorization`
 * (case-insensitive) is replaced with `"[redacted]"`, recursively. Nothing
 * on `Rule` or `RuleInventoryEntry` matches this today (this ticket's own
 * "rules hold none" observation) — this exists so that stays true by
 * construction rather than by review, if a future field ever does.
 */
const SECRET_KEY_RE = /token|secret|password|authorization/i;

function redactSecretLike<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => redactSecretLike(v)) as unknown as T;
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY_RE.test(k) ? "[redacted]" : redactSecretLike(v);
    }
    return out as T;
  }
  return value;
}

export interface RulesApiRuleEntry {
  id: string;
  resourceProvider: RuleInventoryEntry["resourceProvider"];
  query: string;
  enabled: boolean;
  execution: RuleInventoryEntry["execution"];
  account: RuleInventoryEntry["account"];
  role: RuleInventoryEntry["role"];
  agentPreferences: RuleInventoryEntry["agentPreferences"];
  linkedEventing: boolean;
  mcpServerNames: string[];
  /**
   * FACTORY-729: like `briefExcerpt` below, read off the raw `Rule` list
   * `loadRulesFileState` already produced (keyed the SAME way,
   * `resourceProvider:id`) rather than added to `RuleInventoryEntry` — that
   * type is consumed far beyond this one route (`/configurations`, the
   * dashboard), and neither field is relevant there. `null` when absent on
   * the rule (butchr's own launch default applies) or the rule could not be
   * matched (defensive, never thrown).
   */
  permissionMode: RulePermissionMode | null;
  /** FACTORY-729: see `permissionMode` immediately above for why this is read the same way. `null` when absent (today's "eligible for scanning" default — see `Rule.lizardMode`'s own doc comment, `../rules/rules.ts` — not necessarily `false`). */
  lizardMode: boolean | null;
  /** FACTORY-851: read the same way as `permissionMode`/`lizardMode` above. `null` when absent — means ON, no tri-state (see `Rule.resumeOnRespawn`'s own doc comment, `../rules/rules.ts`), never necessarily `false`. */
  resumeOnRespawn: boolean | null;
  /** FACTORY-851: read the same way as `permissionMode`/`lizardMode` above. `null` when absent — means `DEFAULT_RESUME_CONTEXT_CUTOFF` applies (see `Rule.resumeContextCutoff`'s own doc comment, `../rules/rules.ts`). */
  resumeContextCutoff: number | null;
  /** First 200 chars of `Rule.brief` — never the full text. `""` if this rule's own brief could not be matched (should not happen for a rule `loadRulesFileState` itself produced; defensive, never thrown). */
  briefExcerpt: string;
  /** Verbatim `RuleInventoryEntry.staffed` — see that field's own doc comment for the full tri-state contract. */
  staffed: boolean | null;
  /** Verbatim `RuleInventoryEntry.reason`, renamed for this surface. */
  whyUnstaffed: string | null;
}

export interface RulesApiResponse {
  path: string;
  /** ISO 8601, or `null` when the file could not be stat'd (e.g. missing, or a race between reading it and the stat). */
  mtime: string | null;
  /**
   * PR #642 review round 2 (G1): the etag of the TEXT this process's
   * currently-RUNNING `rules` (and so this very response's `rules` array)
   * came from — a daemon-startup-time snapshot until FACTORY-657's rules
   * holder lands (`getSourceEtag()`; see the TODO on this value's producer
   * in `src/daemon/index.ts`). Pairing this with a FRESH `fileEtag` below
   * is what `stale` exists to catch: returning a fresh file etag alongside
   * STALE startup `rules` would let the UI write (FACTORY-662) against a
   * state it never actually saw.
   */
  sourceEtag: string;
  /** FACTORY-662's F7 requirement ("daemon reports its rules path + etag"): `rulesEtag()` (`../rules/write-rules.js`, FACTORY-658) of the file's CURRENT on-disk bytes, read fresh this request — for a later write's `ifMatch`. */
  fileEtag: string;
  /** `sourceEtag !== fileEtag` — true when the on-disk file has changed since the running `rules` were loaded. The UI shows "reload pending" and refuses writes while this is true (FACTORY-661/FACTORY-662). */
  stale: boolean;
  /** `rulesFile.error === null`. */
  valid: boolean;
  /** `[]` when `valid`; the validation error's message, one problem per line, when not. */
  problems: string[];
  rules: RulesApiRuleEntry[];
}

const briefKey = (resourceProvider: string, id: string): string => `${resourceProvider}:${id}`;

export interface BuildRulesApiResponseArgs {
  rulesFile: Pick<RulesFileState, "path" | "rules" | "error">;
  mtime: string | null;
  sourceEtag: string;
  fileEtag: string;
  /** The SAME `QueryAgentInventory.rules` `/configurations` already computed this request — never recomputed here. */
  ruleInventory: readonly RuleInventoryEntry[];
}

export function buildRulesApiResponse(args: BuildRulesApiResponseArgs): RulesApiResponse {
  const briefs = new Map<string, string>();
  const rawRules = new Map<string, Rule>();
  for (const r of args.rulesFile.rules as readonly Rule[]) {
    briefs.set(briefKey(r.resourceProvider, r.id), r.brief);
    rawRules.set(briefKey(r.resourceProvider, r.id), r);
  }

  const rules: RulesApiRuleEntry[] = args.ruleInventory.map((entry) => {
    const raw = rawRules.get(briefKey(entry.resourceProvider, entry.id));
    return {
      id: entry.id,
      resourceProvider: entry.resourceProvider,
      query: entry.query,
      enabled: entry.enabled,
      execution: entry.execution,
      account: entry.account,
      role: entry.role,
      agentPreferences: entry.agentPreferences,
      linkedEventing: entry.linkedEventing,
      mcpServerNames: entry.mcpServerNames,
      permissionMode: raw?.permissionMode ?? null,
      lizardMode: raw?.lizardMode ?? null,
      resumeOnRespawn: raw?.resumeOnRespawn ?? null,
      resumeContextCutoff: raw?.resumeContextCutoff ?? null,
      briefExcerpt: briefExcerpt(briefs.get(briefKey(entry.resourceProvider, entry.id)) ?? ""),
      staffed: entry.staffed,
      whyUnstaffed: entry.reason,
    };
  });

  return redactSecretLike({
    path: args.rulesFile.path,
    mtime: args.mtime,
    sourceEtag: args.sourceEtag,
    fileEtag: args.fileEtag,
    stale: args.sourceEtag !== args.fileEtag,
    valid: args.rulesFile.error === null,
    problems: args.rulesFile.error ? args.rulesFile.error.message.split("\n") : [],
    rules,
  });
}
