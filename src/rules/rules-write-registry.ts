/**
 * FACTORY-662 — the field-allowlist REGISTRY (director's decision,
 * 2026-10-05 12:30 PDT comment): one table, route -> editable fields ->
 * validators, so a later write slice (FACTORY-665/666/667/668) adds a row
 * here rather than an ad-hoc handler. This file holds the RULES v1 row only.
 *
 * TWO INDEPENDENT GATES, both required, for a different reason each:
 *   1. A per-write, PER-INDEX `assertOnlyChanged` allowlist (FACTORY-658) —
 *      a DEFAULT-DENY diff check: any changed path NOT matched here throws,
 *      which is what makes the fixed template fields (`execution`,
 *      `account`, `role`, `mcpServers`, `mcpConfigFile`, `brief`,
 *      `permissionMode`, `lizardMode`) refused FOR FREE — they are refused
 *      because they are simply never in this list, not because of a second,
 *      separate "is this a fixed field" check that could drift from the
 *      first. Built by `../rules/rules-write-apply.ts`'s
 *      `buildEnabledAllowedPaths`/`buildFieldsAllowedPaths`, from the
 *      LOCKED read, naming the target rule's CURRENT array index literally
 *      (`"rules.3.enabled"`, never `"rules.*.enabled"`) — a static,
 *      wildcarded allowlist was agentsafety's own 2026-10-05 17:0x PDT
 *      re-check finding: `*` matches ANY index, so it would permit a write
 *      to ANY rule's `enabled`/`query`, not just the one this route already
 *      checked `isUiEditableRuleId` against. `EDITABLE_TOP_LEVEL_FIELDS`/
 *      `EDITABLE_AGENT_PREFERENCE_LEAVES` below are the VOCABULARY those
 *      builders use — never consulted directly by `assertOnlyChanged`.
 *   2. `isUiEditableRuleId` — a route-level check, BEFORE any diff is even
 *      computed: a write to a rule whose id does not carry the reserved
 *      `ui-` prefix is refused outright, even for a change that would
 *      otherwise be entirely inside the allowlist. The web UI never creates
 *      or touches an unmarked rule (e.g. `managers`) — see this ticket's
 *      "DECISION ADDED" comment.
 */

/** The reserved id prefix FACTORY-669 seeds its one template rule under (`ui-first-rule`). Only a rule whose id starts with this may ever be written by a web-UI route. */
export const UI_EDITABLE_ID_PREFIX = "ui-";

export function isUiEditableRuleId(id: string): boolean {
  return id.startsWith(UI_EDITABLE_ID_PREFIX);
}

/** The id FACTORY-669's daemon-startup seed writes its one template rule under — see `../rules/seed-first-run.ts`. Carries the reserved `ui-` prefix above, so the web write path may edit and enable it like any other `ui-` rule. */
export const FIRST_RULE_ID = "ui-first-rule";

/**
 * The editable LEAVES of one `agentPreferences` element — never `harness`
 * (a prefix match on the bare `agentPreferences.<m>` path would also let
 * `harness` through; agentsafety's finding (ii)), and never the whole
 * element object (which would permit adding/removing keys). Consumed by
 * `../rules/rules-write-apply.ts`'s `buildFieldsAllowedPaths`, which
 * appends the target rule's own CURRENT index and each existing
 * preference's own index ahead of these leaf names.
 */
export const EDITABLE_AGENT_PREFERENCE_LEAVES: readonly string[] = ["model", "effort", "modelPower", "effortPower"];

/**
 * FACTORY-669: re-exported from `./rules.ts`, which owns the canonical
 * definition (`./seed-first-run.ts`, the actual seeder, needs it too and
 * must not depend on this write-only module — see that constant's own doc
 * comment). Kept re-exported here, under this module's own name, so every
 * existing importer of `PLACEHOLDER_QUERY` from `rules-write-registry.js`
 * (this module's own consumers, `./rules-write.ts` among them) needs no
 * change.
 */
export { PLACEHOLDER_QUERY } from "./rules.js";

/** Enabling a rule whose dry-run scope exceeds this many tickets is refused unless the caller passes an explicit confirm flag. One constant, one place (director's decision). */
export const ENABLE_SCOPE_CEILING = 25;

export interface AgentPreferencePatch {
  model?: string;
  effort?: string;
  modelPower?: number;
  effortPower?: number;
}

/** The only shape a PUT body's `agentPreferences` element may take — any OTHER key (`harness` included) fails validation before any diff is even computed, so a caller gets a clear 400 rather than a confusing `assertOnlyChanged` throw. */
const AGENT_PREFERENCE_PATCH_KEYS = new Set(["model", "effort", "modelPower", "effortPower"]);

export function validateAgentPreferencePatch(value: unknown): value is AgentPreferencePatch {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.keys(value as object).every((k) => AGENT_PREFERENCE_PATCH_KEYS.has(k));
}

export interface RuleFieldPatch {
  enabled?: boolean;
  query?: string;
  /** Must be the SAME LENGTH as the rule's current `agentPreferences` (see `RULES_V1_ALLOWED_PATHS`'s own doc comment on why an array-length change is never permitted) — one entry per existing preference, in order. */
  agentPreferences?: AgentPreferencePatch[];
}

/** `patch`'s own shape, independent of what the CURRENT rule looks like (that comparison — e.g. the length match above — happens where the current rule is in hand, in `./write-rules.ts`'s caller). `__proto__`/prototype-pollution bodies are rejected here: a `JSON.parse`'d `__proto__` key never becomes an OWN enumerable property, so `Object.keys`/`in` checks below never see it either way, but every value is read by EXPLICIT key name below, never spread or `Object.assign`-merged onto a trusted object, which is what actually matters for this module's own output never carrying one. */
export function validateRuleFieldPatch(body: unknown): { ok: true; patch: RuleFieldPatch } | { ok: false; error: string } {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "body must be a JSON object" };
  const b = body as Record<string, unknown>;
  const patch: RuleFieldPatch = {};
  if ("enabled" in b) {
    if (typeof b.enabled !== "boolean") return { ok: false, error: "enabled must be a boolean" };
    patch.enabled = b.enabled;
  }
  if ("query" in b) {
    if (typeof b.query !== "string" || b.query.length === 0 || b.query.length > 10_000) return { ok: false, error: "query must be a non-empty string, at most 10000 characters" };
    patch.query = b.query;
  }
  if ("agentPreferences" in b) {
    if (!Array.isArray(b.agentPreferences)) return { ok: false, error: "agentPreferences must be an array" };
    for (const entry of b.agentPreferences) {
      if (!validateAgentPreferencePatch(entry)) return { ok: false, error: `agentPreferences entries may only contain ${[...AGENT_PREFERENCE_PATCH_KEYS].join("/")}` };
    }
    patch.agentPreferences = b.agentPreferences as AgentPreferencePatch[];
  }
  const allowedKeys = new Set(["enabled", "query", "agentPreferences", "ifMatch", "confirm", "planHash"]);
  for (const k of Object.keys(b)) {
    if (!allowedKeys.has(k)) return { ok: false, error: `unknown field "${k}" is not editable` };
  }
  return { ok: true, patch };
}
