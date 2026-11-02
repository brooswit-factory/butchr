/**
 * FACTORY-661 — pure view-model for the Rules page. Plain TypeScript, no
 * React, no DOM, same discipline `view-model/dashboard-view.ts` already
 * follows: every rendering DECISION lives here, so `RulesTable.tsx` only
 * arranges already-settled values.
 */
import { FIRST_RULE_ID, type RuleDto, type RulesFileError, type RulesListResponse } from "../api/rules.js";

export interface StaffedView {
  text: string;
  /** `"known"` for a plain `staffed` fact, `"cnc"` for UNSTAFFED or COULD NOT CHECK alike — same visual-weight split `config-inventory-page.ts`'s own `renderStaffed` uses. */
  cls: "known" | "cnc";
}

/**
 * `rule.staffed`'s three states, rendered exhaustively — reused wording
 * verbatim from `config-inventory-page.ts`'s own `renderStaffed`
 * (`=== true` / `=== false` / `=== null`, never a truthiness test, which
 * would silently collapse `null` into `false`). React escapes `reason`
 * automatically as plain text content — no manual `esc()` needed here,
 * unlike the server-rendered HTML original.
 */
export function renderStaffed(rule: Pick<RuleDto, "staffed" | "reason">): StaffedView {
  if (rule.staffed === true) return { text: "staffed", cls: "known" };
  const reasonSuffix = rule.reason ? `: ${rule.reason}` : "";
  if (rule.staffed === false) return { text: `UNSTAFFED${reasonSuffix}`, cls: "cnc" };
  return { text: `COULD NOT CHECK${reasonSuffix}`, cls: "cnc" };
}

export interface RuleRowView {
  rule: RuleDto;
  staffed: StaffedView;
  preferencesText: string;
  /** FACTORY-851: `Rule.resumeOnRespawn`/`Rule.resumeContextCutoff`, rendered — see `resumeText` below for the exact wording rule. */
  resumeText: string;
}

/**
 * FACTORY-851 — `resumeOnRespawn`/`resumeContextCutoff`'s display wording:
 * `null` on either field means absent, which this ticket's own schema
 * defines as "resume on" / "the daemon's own default cutoff" respectively
 * (see `Rule.resumeOnRespawn`/`Rule.resumeContextCutoff`'s own doc comments,
 * `../../../src/rules/rules.js`) — never rendered as a literal number here,
 * since the actual default value lives server-side
 * (`DEFAULT_RESUME_CONTEXT_CUTOFF`) and this module must not hand-maintain a
 * second copy of it.
 */
export function resumeText(rule: Pick<RuleDto, "resumeOnRespawn" | "resumeContextCutoff">): string {
  const resume = rule.resumeOnRespawn === false ? "off" : "on";
  const cutoff = rule.resumeContextCutoff === null ? "default" : String(rule.resumeContextCutoff);
  return `resume: ${resume} (cutoff: ${cutoff})`;
}

export interface RulesPageViewModel {
  rows: RuleRowView[];
  fileErrors: RulesFileError[];
  /** No rules file (or an empty, valid one — indistinguishable from this response alone) and no load errors. */
  emptyState: boolean;
  /** FACTORY-663: passed through verbatim from `RulesListResponse.sourceEtag` — the ONLY value any write's `ifMatch` may ever carry. */
  sourceEtag: string;
  /** FACTORY-663: passed through verbatim from `RulesListResponse.stale` — true means "reload pending": every write control is disabled (ticket item 5). */
  stale: boolean;
  /** FACTORY-663: the seeded `ui-first-rule` template row, if present — `undefined` means the template is missing (the "Set up your first rule" flow then shows how to add it instead of a form). */
  firstRule: RuleDto | undefined;
}

/** One preference, labeled by its resolved value — same wording convention as `config-inventory-page.ts`'s own per-preference label. */
function preferenceText(pref: RuleDto["agentPreferences"][number]): string {
  const parts: string[] = [pref.harness];
  if (pref.model) parts.push(pref.model);
  if (pref.effort) parts.push(pref.effort);
  return parts.join("/");
}

export function buildRulesViewModel(data: RulesListResponse): RulesPageViewModel {
  const rows: RuleRowView[] = data.rules.map((rule) => ({
    rule,
    staffed: renderStaffed(rule),
    preferencesText: rule.agentPreferences.length === 0 ? "butchr's global agent config" : rule.agentPreferences.map(preferenceText).join(", "),
    resumeText: resumeText(rule),
  }));
  return {
    rows,
    fileErrors: data.errors,
    emptyState: data.rules.length === 0 && data.errors.length === 0,
    sourceEtag: data.sourceEtag,
    stale: data.stale,
    firstRule: data.rules.find((r) => r.id === FIRST_RULE_ID),
  };
}

/**
 * Same resource-key FORMAT `encodeAgentKey` (`../../../src/rules/
 * agent-key.ts`) produces — each segment percent-encoded, joined by a
 * literal `:` — built here from a preview ticket's bare key rather than
 * imported at runtime (that module reaches `node:path` VALUES through
 * `isResourceId`, which fails a browser build; see
 * `view-model/agent-key-display.ts`'s own header for the identical
 * constraint on the decode side). Lets a preview ticket link through the
 * SAME `/resource/:key/open` redirect a live dashboard row already uses,
 * even for a ticket with no running agent yet.
 */
export function encodeResourceKey(resourceProvider: string, ruleId: string, resourceId: string): string {
  return [resourceProvider, ruleId, resourceId].map(encodeURIComponent).join(":");
}
