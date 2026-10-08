/**
 * FACTORY-729 — the single source of truth for the rule form's
 * harness/model/effort/permission-mode dropdowns and the lizard-mode
 * toggle: one catalog entry per `AgentHarness`, built from this codebase's
 * own EXISTING constants (`AGENT_HARNESSES`, `./rules.ts:59`; `AGENT_EFFORTS`,
 * `../resources/power-scale.ts:44`; `RULE_PERMISSION_MODES`, `./rules.ts:90`;
 * the model-power tables, `../resources/power-scale.ts`) — never a second,
 * hand-maintained list. `GET /api/rules/catalog` (`../web/view.ts`) serves
 * this verbatim; the write-path validator (`./rules-write-registry.ts`)
 * imports the SAME `CUSTOM_MODEL_PATTERN` this module exports, so a model
 * value the write path accepts is always shaped the way the UI's "Other…"
 * custom-model field promises.
 *
 * `models` is drawn from each vendor's own `ModelPowerBand` table
 * (`../resources/power-scale.ts`) — the short aliases a launch itself
 * accepts (`"sonnet"`, `"gpt-5.6-sol"`, …), in ascending power order,
 * de-duplicated (no table repeats a model today, but this stays correct if
 * the bands narrow further later). `agy` has no power table (`POWER_VENDORS`
 * is `claude`/`codex` only) and so ships `models: []` — `allowsCustomModel`
 * stays `true` for every harness regardless (the underlying
 * `AgentPreference.model` field is, and remains, a free string validated
 * only by `CUSTOM_MODEL_PATTERN` below), so a caller may always type a
 * custom id via "Other…".
 *
 * `efforts` is `AGENT_EFFORTS` for `claude`/`codex` (the same 0-100 axis
 * `effortPower` resolves through, `resolveEffortPower`) and `[]` for `agy`
 * (no effort concept at all — `agentLaunchConfig`'s Agy branch never reads
 * one, and `./rules.ts`'s own `parsePreferences` already rejects
 * `effort`/`effortPower` set for that harness).
 *
 * `permissionModes` is `RULE_PERMISSION_MODES` for every harness: the rule
 * validator itself accepts every value for every provider (`RulePermissionMode`'s
 * own doc comment, `./rules.ts`) — including `agy`, for which it is a
 * documented silent no-op, not a rejection — so the catalog mirrors that
 * acceptance rather than inventing a narrower UI-only subset. Codex's own
 * launch maps a set `permissionMode` onto `--dangerously-bypass-approvals-
 * and-sandbox` (`agentLaunchConfig`'s Codex branch, `../agents/argv.ts`) —
 * that mapping is a launch-time concern, not a catalog-time restriction.
 */
import { AGENT_HARNESSES, RULE_PERMISSION_MODES, type AgentHarness, type RulePermissionMode } from "./rules.js";
import { AGENT_EFFORTS, CLAUDE_MODEL_POWER_TABLE, CODEX_MODEL_POWER_TABLE, type AgentEffort, type ModelPowerBand } from "../resources/power-scale.js";

export interface RuleFormCatalogEntry {
  harness: AgentHarness;
  /** Shipped model aliases, ascending power order, de-duplicated. `[]` for a harness with no power table (`agy`). */
  models: readonly string[];
  /** Always `true` today — `AgentPreference.model` is a free string for every harness; kept as its own field (rather than implied) so a future harness that truly cannot take a custom model id has somewhere to say so without breaking every existing reader of this shape. */
  allowsCustomModel: boolean;
  /** `AGENT_EFFORTS` for a harness with an effort concept, `[]` otherwise (`agy`). */
  efforts: readonly AgentEffort[];
  /** `RULE_PERMISSION_MODES`, unconditionally — see this module's own header for why this is never narrowed per harness. */
  permissionModes: readonly RulePermissionMode[];
}

const MODEL_TABLES: Readonly<Partial<Record<AgentHarness, readonly ModelPowerBand[]>>> = {
  claude: CLAUDE_MODEL_POWER_TABLE,
  codex: CODEX_MODEL_POWER_TABLE,
};

const EFFORTS_BY_HARNESS: Readonly<Partial<Record<AgentHarness, readonly AgentEffort[]>>> = {
  claude: AGENT_EFFORTS,
  codex: AGENT_EFFORTS,
};

function modelsFor(harness: AgentHarness): readonly string[] {
  const table = MODEL_TABLES[harness];
  if (!table) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const band of table) {
    if (!seen.has(band.model)) {
      seen.add(band.model);
      out.push(band.model);
    }
  }
  return out;
}

/** One entry per `AGENT_HARNESSES` member, in that same order — built once at module load, from constants alone (no I/O). */
export const RULE_FORM_CATALOG: readonly RuleFormCatalogEntry[] = AGENT_HARNESSES.map((harness) => ({
  harness,
  models: modelsFor(harness),
  allowsCustomModel: true,
  efforts: EFFORTS_BY_HARNESS[harness] ?? [],
  permissionModes: RULE_PERMISSION_MODES,
}));

/** Looks up one harness's catalog entry. Throws only if `AGENT_HARNESSES` and `RULE_FORM_CATALOG` have drifted (they cannot, by construction above) — never reachable for a value already typed `AgentHarness`. */
export function ruleFormCatalogEntry(harness: AgentHarness): RuleFormCatalogEntry {
  const entry = RULE_FORM_CATALOG.find((e) => e.harness === harness);
  if (!entry) throw new Error(`rule-form-catalog.ts: no catalog entry for harness "${harness}" — AGENT_HARNESSES/RULE_FORM_CATALOG drifted`);
  return entry;
}

/**
 * The "Other…" custom-model pattern (FACTORY-729's own instruction):
 * alphanumeric-leading, then alphanumerics or `._:/-`, max 64 chars total —
 * no shell metacharacters and no flag-shaped string (`-x`, `--foo`, both of
 * which fail the alphanumeric-leading requirement) can ever reach a launch's
 * argv through this field. Every shipped model alias in `RULE_FORM_CATALOG`
 * already satisfies this pattern (checked by this module's own test), so
 * applying it uniformly to every submitted model value — shipped or custom
 * — needs no separate "is this one of the shipped ones" branch.
 *
 * Applied only at the web write path (`./rules-write-registry.ts`'s
 * `validateAgentPreferencePatch`) — the `rules.json` file-load path
 * (`./rules.ts`'s `parsePreferences`) is unchanged by this ticket; an
 * operator hand-editing the file directly is not this ticket's concern.
 */
export const CUSTOM_MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$/;

/** Why a model value is unusable for the web write path, or `[]`. Same "collect, never touch anything else" shape every other `*Problems` validator in this codebase follows (e.g. `powerValueProblems`, `../resources/power-scale.ts`). */
export function customModelProblems(model: unknown, at: string): string[] {
  if (typeof model !== "string" || model.trim() === "") return [`${at} must be a non-empty string`];
  if (!CUSTOM_MODEL_PATTERN.test(model)) {
    return [`${at} must match ${CUSTOM_MODEL_PATTERN} (letters, digits, "._:/-", starting with a letter or digit, max 64 chars)`];
  }
  return [];
}
