/**
 * FACTORY-662 — the field-allowlist REGISTRY (director's decision,
 * 2026-10-05 12:30 PDT comment): one table, route -> editable fields ->
 * validators, so a later write slice (FACTORY-665/666/667/668) adds a row
 * here rather than an ad-hoc handler. This file holds the RULES v1 row only.
 *
 * FACTORY-729 widens the row: `permissionMode`/`lizardMode` (top-level) and
 * `agentPreferences[i].harness` (previously refused on purpose — see that
 * leaf's own comment on `EDITABLE_AGENT_PREFERENCE_LEAVES` below for why it
 * is now deliberately allowed) join `query`/`agentPreferences[i].model/
 * effort/modelPower/effortPower` as editable. `execution`, `account`,
 * `role`, `mcpServers`, `mcpConfigFile`, `brief` remain fixed — still
 * refused for free, same mechanism, just a shorter list of what's fixed.
 *
 * FACTORY-730 retires the `UI_EDITABLE_ID_PREFIX`/`isUiEditableRuleId` route-
 * level gate this header used to describe as "gate 2": a write to ANY
 * existing rule id (an operator's real `epics`/`tasks`/`bugs` rule, not only
 * a seeded `ui-`-prefixed one) is now permitted through this write path —
 * the story's own decision (option (a)). The ONE remaining gate is the
 * per-write, PER-INDEX `assertOnlyChanged` allowlist below:
 *   A DEFAULT-DENY diff check: any changed path NOT matched here throws,
 *   which is what makes the fixed template fields (`execution`, `account`,
 *   `role`, `mcpServers`, `mcpConfigFile`, `brief`) refused FOR FREE — they
 *   are refused because they are simply never in this list, not because of
 *   a second, separate "is this a fixed field" check that could drift from
 *   the first. Built by `../rules/rules-write-apply.ts`'s
 *   `buildEnabledAllowedPaths`/`buildFieldsAllowedPaths`, from the LOCKED
 *   read, naming the target rule's CURRENT array index literally
 *   (`"rules.3.enabled"`, never `"rules.*.enabled"`) — a static, wildcarded
 *   allowlist was agentsafety's own 2026-10-05 17:0x PDT re-check finding:
 *   `*` matches ANY index, so it would permit a write to ANY rule's
 *   `enabled`/`query`, not just the one targeted by id. `EDITABLE_TOP_LEVEL_FIELDS`/
 *   `EDITABLE_AGENT_PREFERENCE_LEAVES` below are the VOCABULARY those
 *   builders use — never consulted directly by `assertOnlyChanged`.
 */
import { AGENT_HARNESSES, RULE_PERMISSION_MODES, type AgentHarness, type RulePermissionMode } from "./rules.js";
import { AGENT_EFFORTS, powerValueProblems, type AgentEffort } from "../resources/power-scale.js";
import { customModelProblems } from "./rule-form-catalog.js";

/** The id FACTORY-669's daemon-startup seed writes its one template rule under — see `../rules/seed-first-run.ts`. FACTORY-730: this id carries no special write-eligibility anymore (every rule is web-UI-writable now) — it is still the one id the "Set up your first rule" flow (`FirstRuleSetup.tsx`) looks for specifically. */
export const FIRST_RULE_ID = "ui-first-rule";

/**
 * The editable LEAVES of one `agentPreferences` element — never the whole
 * element object (which would permit adding/removing keys). Consumed by
 * `../rules/rules-write-apply.ts`'s `buildFieldsAllowedPaths`, which
 * appends the target rule's own CURRENT index and each existing
 * preference's own index ahead of these leaf names.
 *
 * FACTORY-729: `harness` is now included, deliberately reversing the
 * original FACTORY-662 design (agentsafety's finding (ii) there was about a
 * PREFIX match on the bare `agentPreferences.<m>` path letting `harness`
 * through BY ACCIDENT; this is an explicit, LEAF-listed addition, the same
 * discipline every other leaf here already has, not a reopening of that
 * hole) — the rule form's harness dropdown edits an existing preference's
 * harness in place; `validateAgentPreferencePatch` below validates the
 * value against `AGENT_HARNESSES` before it ever reaches this allowlist.
 */
export const EDITABLE_AGENT_PREFERENCE_LEAVES: readonly string[] = ["harness", "model", "effort", "modelPower", "effortPower"];

/**
 * FACTORY-729: the editable TOP-LEVEL `Rule` fields `PUT /api/rules/:id`
 * accepts, beyond `agentPreferences` (handled separately — see
 * `EDITABLE_AGENT_PREFERENCE_LEAVES` above) — consumed the same way, by
 * `../rules/rules-write-apply.ts`'s `buildFieldsAllowedPaths`, which
 * appends the target rule's own CURRENT index ahead of each name present in
 * the patch. `enabled` is deliberately absent (that field's own dedicated
 * route, `POST /api/rules/:id/enabled`, owns it — see `validateRuleFieldPatch`'s
 * own explicit rejection of it on this route).
 */
export const EDITABLE_TOP_LEVEL_FIELDS: readonly string[] = ["query", "permissionMode", "lizardMode"];

/**
 * FACTORY-729: `permissionMode` values that are never a default and always
 * require an explicit `confirm: true` on the write that sets them (see
 * `../rules/rules-write.ts`'s `requireConfirmForRiskyFields`) — unattended
 * dangerous-permission launches must be an opt-in a human visibly confirmed,
 * not a value that slipped in alongside an unrelated edit. `lizardMode: true`
 * carries the same requirement unconditionally (there is no "safe" value of
 * it to exempt).
 */
export const RISKY_PERMISSION_MODES: ReadonlySet<RulePermissionMode> = new Set(["bypassPermissions", "auto"]);

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
  /** FACTORY-729: see `EDITABLE_AGENT_PREFERENCE_LEAVES`'s own doc comment for why this leaf is now deliberately editable. Validated against `AGENT_HARNESSES` below. */
  harness?: AgentHarness;
  model?: string;
  effort?: AgentEffort;
  modelPower?: number;
  effortPower?: number;
}

/** The only shape a PUT body's `agentPreferences` element may take — any OTHER key fails validation before any diff is even computed, so a caller gets a clear 400 rather than a confusing `assertOnlyChanged` throw. */
const AGENT_PREFERENCE_PATCH_KEYS = new Set(["harness", "model", "effort", "modelPower", "effortPower"]);

/**
 * FACTORY-729: widened from a bare key-allowlist type guard to a real
 * per-value validator — every leaf's VALUE is now checked against the SAME
 * catalog (`./rule-form-catalog.js`'s `customModelProblems`, `AGENT_HARNESSES`,
 * `AGENT_EFFORTS`, `powerValueProblems`) the write path's own GET
 * `/api/rules/catalog` route serves, so a value this validator accepts is
 * always one the UI actually offered (or, for `model`, a custom id shaped
 * the way the UI's "Other…" field promises). `model`/`modelPower` and
 * `effort`/`effortPower` remain mutually exclusive, same as the file-load
 * path's own `parsePreferences` (`./rules.ts`) — ambiguous precedence is
 * refused, never silently resolved by picking one.
 */
export function validateAgentPreferencePatch(value: unknown): { ok: true; patch: AgentPreferencePatch } | { ok: false; error: string } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return { ok: false, error: "agentPreferences entries must be objects" };
  const v = value as Record<string, unknown>;
  for (const k of Object.keys(v)) {
    if (!AGENT_PREFERENCE_PATCH_KEYS.has(k)) return { ok: false, error: `agentPreferences entries may only contain ${[...AGENT_PREFERENCE_PATCH_KEYS].join("/")}` };
  }
  const patch: AgentPreferencePatch = {};
  if ("harness" in v) {
    if (typeof v.harness !== "string" || !(AGENT_HARNESSES as readonly string[]).includes(v.harness)) return { ok: false, error: `agentPreferences.harness must be one of ${AGENT_HARNESSES.join(", ")}` };
    patch.harness = v.harness as AgentHarness;
  }
  if ("model" in v) {
    const problems = customModelProblems(v.model, "agentPreferences.model");
    if (problems.length) return { ok: false, error: problems.join("; ") };
    patch.model = v.model as string;
  }
  if ("effort" in v) {
    if (typeof v.effort !== "string" || !(AGENT_EFFORTS as readonly string[]).includes(v.effort)) return { ok: false, error: `agentPreferences.effort must be one of ${AGENT_EFFORTS.join(", ")}` };
    patch.effort = v.effort as AgentEffort;
  }
  if ("modelPower" in v) {
    const problems = powerValueProblems(v.modelPower, "agentPreferences.modelPower");
    if (problems.length) return { ok: false, error: problems.join("; ") };
    patch.modelPower = v.modelPower as number;
  }
  if ("effortPower" in v) {
    const problems = powerValueProblems(v.effortPower, "agentPreferences.effortPower");
    if (problems.length) return { ok: false, error: problems.join("; ") };
    patch.effortPower = v.effortPower as number;
  }
  if (patch.model !== undefined && patch.modelPower !== undefined) return { ok: false, error: "agentPreferences entries must not set both model and modelPower" };
  if (patch.effort !== undefined && patch.effortPower !== undefined) return { ok: false, error: "agentPreferences entries must not set both effort and effortPower" };
  return { ok: true, patch };
}

export interface RuleFieldPatch {
  enabled?: boolean;
  query?: string;
  /** FACTORY-729 — see `EDITABLE_TOP_LEVEL_FIELDS`'s own doc comment. Validated against `RULE_PERMISSION_MODES` below; `"bypassPermissions"`/`"auto"` additionally require `confirm: true` on the write itself (`../rules/rules-write.ts`). */
  permissionMode?: RulePermissionMode;
  /** FACTORY-729 — see `EDITABLE_TOP_LEVEL_FIELDS`'s own doc comment. `true` additionally requires `confirm: true` on the write itself (`../rules/rules-write.ts`) — never a default. */
  lizardMode?: boolean;
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
  if ("permissionMode" in b) {
    if (typeof b.permissionMode !== "string" || !(RULE_PERMISSION_MODES as readonly string[]).includes(b.permissionMode)) return { ok: false, error: `permissionMode must be one of ${RULE_PERMISSION_MODES.join(", ")}` };
    patch.permissionMode = b.permissionMode as RulePermissionMode;
  }
  if ("lizardMode" in b) {
    if (typeof b.lizardMode !== "boolean") return { ok: false, error: "lizardMode must be a boolean" };
    patch.lizardMode = b.lizardMode;
  }
  if ("agentPreferences" in b) {
    if (!Array.isArray(b.agentPreferences)) return { ok: false, error: "agentPreferences must be an array" };
    const entries: AgentPreferencePatch[] = [];
    for (const entry of b.agentPreferences) {
      const parsed = validateAgentPreferencePatch(entry);
      if (!parsed.ok) return parsed;
      entries.push(parsed.patch);
    }
    patch.agentPreferences = entries;
  }
  const allowedKeys = new Set(["enabled", "query", "permissionMode", "lizardMode", "agentPreferences", "ifMatch", "confirm", "planHash"]);
  for (const k of Object.keys(b)) {
    if (!allowedKeys.has(k)) return { ok: false, error: `unknown field "${k}" is not editable` };
  }
  return { ok: true, patch };
}
