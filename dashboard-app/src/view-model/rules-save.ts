/**
 * local/ui — Review and save for the Rules page.
 *
 * `reviewChanges` asks the server what each step would do, WITHOUT writing:
 * `planRule(…, confirm: false)` for updates and on/off switches (the same
 * dry run `RuleEditDialog` and the classic table use), and the create
 * route's own unconfirmed dry run for new rules. The review modal shows
 * those answers; pressing Save is the confirmation.
 *
 * `saveChanges` then performs the steps in order. Each step plans again
 * right before writing — the previous step changed the file, so an earlier
 * `planHash` would be stale — and stops if the server now asks for a
 * confirmation the person didn't see in the review, or reports a bigger
 * blast radius than the review did. Every write sends the etag the previous
 * write returned (the first sends the draft's base etag, so a file changed
 * by someone else since the page loaded is refused, not overwritten).
 */
import { RateLimitError, type RuleCreatePlanResult, type RulePlanResponse, type RuleWriteResult, type RulesApi } from "../api/rules.js";
import { DEFAULT_BRIEF, type RuleChange } from "./rules-draft.js";

export interface ReviewedChange {
  change: RuleChange;
  /** The dry run for an update or an on/off switch. */
  plan?: RulePlanResponse;
  /** The dry run for a new rule. */
  createPlan?: RuleCreatePlanResult;
  /** First ticket keys an enable would staff, when the server's confirm reason is about staffing. */
  ticketKeys?: string[];
  /** The server refused even the dry run; saving would fail the same way. */
  error?: string;
}

export function describeError(e: unknown): string {
  if (e instanceof RateLimitError && e.retryAfterSeconds !== undefined) return `Too many changes. Try again in ${e.retryAfterSeconds}s.`;
  return e instanceof Error ? e.message : String(e);
}

async function staffingKeys(api: RulesApi, ruleId: string, plan: RulePlanResponse, queryOverride?: string): Promise<string[] | undefined> {
  if (plan.confirmReason !== "swarm-enable" && plan.confirmReason !== "scope-ceiling") return undefined;
  try {
    const preview = await api.previewRule(ruleId, undefined, queryOverride);
    return preview.tickets.slice(0, 10).map((t) => t.key);
  } catch {
    return undefined;
  }
}

/** Sequential on purpose: these are cheap, and it keeps the rate limiter out of the way. */
export async function reviewChanges(api: RulesApi, changes: readonly RuleChange[], signal?: AbortSignal): Promise<ReviewedChange[]> {
  const reviewed: ReviewedChange[] = [];
  // An enable is saved after the same rule's field update, so it's reviewed
  // against the rule as that update leaves it (its new query, above all), not
  // the file as it is now. That's also what the enable's own plan sees at save
  // time, so the review and the save agree.
  const pendingPatch = new Map(changes.flatMap((c) => (c.kind === "update" ? [[c.ruleId, c.patch] as const] : [])));
  for (const change of changes) {
    if (signal?.aborted) break;
    try {
      switch (change.kind) {
        case "update": {
          // A rule turned off in the same draft is saved off first, so its field update is reviewed against the rule as it will be then.
          const disabledFirst = changes.some((c) => c.kind === "disable" && c.ruleId === change.ruleId);
          const plan = await api.planRule(change.ruleId, change.patch, false, signal, disabledFirst ? { assumeDisabled: true } : undefined);
          // An edit that switches an enabled rule to swarm staffs every match, like turning a swarm rule on.
          const ticketKeys = await staffingKeys(api, change.ruleId, plan, change.patch.query);
          reviewed.push({ change, plan, ...(ticketKeys ? { ticketKeys } : {}) });
          break;
        }
        case "enable":
        case "disable": {
          const pending = change.kind === "enable" ? pendingPatch.get(change.ruleId) : undefined;
          const plan = await api.planRule(change.ruleId, { ...pending, enabled: change.kind === "enable" }, false, signal);
          const ticketKeys = change.kind === "enable" ? await staffingKeys(api, change.ruleId, plan, pending?.query) : undefined;
          reviewed.push({ change, plan, ...(ticketKeys ? { ticketKeys } : {}) });
          break;
        }
        case "create": {
          const outcome = await api.createRule(change.draft, false, signal);
          if (outcome.kind === "needs-confirm") reviewed.push({ change, createPlan: outcome.plan });
          else if (outcome.kind === "refused") reviewed.push({ change, error: outcome.error });
          // A create never completes without `confirm: true`; treat anything else as a refusal rather than guess.
          else reviewed.push({ change, error: "the server answered the dry run with a completed create, which this page doesn't expect — reload before saving" });
          break;
        }
        case "delete":
          reviewed.push({ change });
          break;
      }
    } catch (e) {
      reviewed.push({ change, error: describeError(e) });
    }
  }
  return reviewed;
}

/** Why a fresh plan no longer matches what the person reviewed, or `null` when it still does. */
export function planDrift(reviewed: RulePlanResponse | undefined, fresh: RulePlanResponse): string | null {
  if (!reviewed) return fresh.requiresConfirm ? "it now needs a confirmation the review didn't show" : null;
  if (fresh.requiresConfirm && (!reviewed.requiresConfirm || fresh.confirmReason !== reviewed.confirmReason)) {
    return `it now needs a confirmation the review didn't show (${fresh.confirmReason ?? "unknown reason"})`;
  }
  const grew = (a: number | undefined, b: number | undefined) => (a ?? 0) > (b ?? 0);
  if (grew(fresh.spawned, reviewed.spawned) || grew(fresh.stopped, reviewed.stopped) || grew(fresh.restarted, reviewed.restarted) || grew(fresh.scopeCount, reviewed.scopeCount)) {
    return "it would now start, stop or match more than the review showed";
  }
  return null;
}

export type SaveStepStatus = "saved" | "failed" | "skipped";

export interface SaveStep {
  change: RuleChange;
  status: SaveStepStatus;
  error?: string;
  result?: RuleWriteResult;
}

export interface SaveOutcome {
  steps: SaveStep[];
  /** The etag after the last successful write (or the starting etag if nothing was written). */
  etag: string;
  /** Draft key → created rule id, for `rulesDraftReducer`'s `rebase`. */
  created: Record<string, string>;
  allSaved: boolean;
}

class DriftError extends Error {}

export async function saveChanges(api: RulesApi, reviewed: readonly ReviewedChange[], startEtag: string): Promise<SaveOutcome> {
  let etag = startEtag;
  const steps: SaveStep[] = [];
  const created: Record<string, string> = {};
  let stopped = false;
  for (const item of reviewed) {
    const { change } = item;
    if (stopped) {
      steps.push({ change, status: "skipped" });
      continue;
    }
    try {
      let result: RuleWriteResult;
      switch (change.kind) {
        case "update": {
          const plan = await api.planRule(change.ruleId, change.patch, false);
          const drift = planDrift(item.plan, plan);
          if (drift) throw new DriftError(drift);
          result = await api.updateFields(change.ruleId, change.patch, etag, plan.planHash, plan.requiresConfirm);
          break;
        }
        case "enable":
        case "disable": {
          const enabled = change.kind === "enable";
          const plan = await api.planRule(change.ruleId, { enabled }, false);
          const drift = planDrift(item.plan, plan);
          if (drift) throw new DriftError(drift);
          result = await api.setEnabled(change.ruleId, enabled, etag, plan.planHash, plan.requiresConfirm);
          break;
        }
        case "delete":
          result = await api.deleteRule(change.ruleId, etag, true);
          break;
        case "create": {
          const outcome = await api.createRule(change.draft, true);
          if (outcome.kind !== "created") throw new Error(outcome.kind === "refused" ? outcome.error : `the server still wants confirmation (${outcome.plan.confirmReason ?? "unknown reason"})`);
          result = outcome.result;
          created[change.key] = change.draft.id;
          break;
        }
      }
      etag = result.etag;
      steps.push({ change, status: "saved", result });
    } catch (e) {
      steps.push({ change, status: "failed", error: e instanceof DriftError ? `Stopped before saving: ${e.message}. Review again.` : describeError(e) });
      stopped = true;
    }
  }
  return { steps, etag, created, allSaved: steps.every((s) => s.status === "saved") };
}

/** One line per change for the review list and the result banner. */
export function changeTitle(change: RuleChange): string {
  switch (change.kind) {
    case "create":
      return `Create ${change.ruleId || "new rule"}`;
    case "update":
      return `Update ${change.ruleId}`;
    case "enable":
      return `Turn on ${change.ruleId}`;
    case "disable":
      return `Turn off ${change.ruleId}`;
    case "delete":
      return `Delete ${change.ruleId}`;
  }
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** What a reviewed change will do, in plain words, or `null` when there's nothing notable. */
export function impactText(item: ReviewedChange): string | null {
  if (item.error) return null;
  const { change } = item;
  if (change.kind === "create") {
    const plan = item.createPlan;
    if (!plan) return null;
    if (plan.scopeUnmeasurable) return "butchr couldn't measure what this query matches right now. The rule is saved off either way.";
    return `Its query matches ${plural(plan.scope ?? 0, "ticket")} right now. New rules are saved off, so nothing starts yet.`;
  }
  if (change.kind === "delete") return "Removes the rule from rules.json. butchr keeps a backup of the file.";
  const plan = item.plan;
  if (!plan) return null;
  const parts: string[] = [];
  switch (plan.confirmReason) {
    case "query-change":
      parts.push(`The new query matches ${plural(plan.scopeCount ?? 0, "ticket")}.`);
      break;
    case "swarm-enable":
    case "scope-ceiling": {
      const n = plan.scopeCount ?? plan.spawned;
      const keys = item.ticketKeys && item.ticketKeys.length > 0 ? `: ${item.ticketKeys.join(", ")}${item.ticketKeys.length === 10 ? ", …" : ""}` : "";
      parts.push(`Staffs up to ${plural(n, "ticket")}${keys}.`);
      break;
    }
    case "risky-permission":
      parts.push("Uses a permission mode that skips the agent's own permission prompts.");
      break;
    case "capacity-sentinel":
      parts.push("This rule's agents will no longer count toward the fleet's agent cap.");
      break;
    case "unmeasurable-scope":
      parts.push("butchr couldn't measure how many tickets this affects.");
      break;
    default:
      break;
  }
  const counts: string[] = [];
  if (plan.spawned > 0 && plan.confirmReason !== "swarm-enable" && plan.confirmReason !== "scope-ceiling") counts.push(`starts ${plural(plan.spawned, "agent")}`);
  if (plan.stopped > 0) counts.push(`stops ${plural(plan.stopped, "agent")}`);
  if (plan.restarted > 0) counts.push(`restarts ${plural(plan.restarted, "agent")}`);
  if (counts.length > 0) parts.push(`${counts.join(", ").replace(/^./, (c) => c.toUpperCase())}.`);
  return parts.length > 0 ? parts.join(" ") : null;
}

/** Whether the server flagged this change as one that needs explicit confirmation (shown as a warning in the review). */
export function needsAttention(item: ReviewedChange): boolean {
  return item.plan?.requiresConfirm === true || (item.change.kind === "create" && item.createPlan?.scopeUnmeasurable === true);
}

/** Briefs a save actually wrote, by rule id — they become the draft's new base briefs without a reload. */
export function savedBriefs(outcome: Pick<SaveOutcome, "steps">): Record<string, string> {
  const out: Record<string, string> = {};
  for (const step of outcome.steps) {
    if (step.status !== "saved") continue;
    if (step.change.kind === "update" && step.change.patch.brief !== undefined) out[step.change.ruleId] = step.change.patch.brief;
    if (step.change.kind === "create") out[step.change.ruleId] = step.change.draft.brief ?? DEFAULT_BRIEF;
  }
  return out;
}
