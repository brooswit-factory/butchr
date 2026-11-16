/**
 * FACTORY-729 — the single source of truth for the rule form's
 * harness/model/effort/permission-mode dropdowns and the lizard-mode
 * toggle: one catalog entry per `AgentHarness`, built from this codebase's
 * own EXISTING constants (`AGENT_HARNESSES`/`RULE_PERMISSION_MODES`,
 * `./agent-harness.ts` — re-exported unchanged from `./rules.ts` too, for
 * every importer that already used that path; `AGENT_EFFORTS` and the
 * model-power tables, `../resources/power-scale.ts`) — never a second,
 * hand-maintained list. Imports `AGENT_HARNESSES`/`RULE_PERMISSION_MODES`
 * from the LEAF module (`./agent-harness.ts`), never from `./rules.ts`
 * directly: `rules.ts` pulls in `node:fs`/`node:crypto` and several other
 * server-only modules, and a plain VALUE import (not `import type`, which
 * TypeScript erases) of anything named from it drags that whole graph into
 * whatever bundles it — this module is imported from browser-bundled code
 * (`dashboard-app/src/api/rules.ts`, `FirstRuleSetup.tsx`), where that was
 * observed to break the Vite build outright (see `./agent-harness.ts`'s own
 * top comment for the exact symptom). `GET /api/rules/catalog`
 * (`../web/view.ts`) serves this verbatim; the write-path validator
 * (`./rules-write-registry.ts`) imports the SAME `CUSTOM_MODEL_PATTERN`
 * this module exports, so a model value the write path accepts is always
 * shaped the way the UI's "Other…" custom-model field promises.
 *
 * `models` is drawn from each vendor's own `ModelPowerBand` table
 * (`../resources/power-scale.ts`) — the short aliases a launch itself
 * accepts (`"sonnet"`, `"gpt-5.6-sol"`, …), in ascending power order,
 * de-duplicated (no table repeats a model today, but this stays correct if
 * the bands narrow further later). `agy` has no power table (`POWER_VENDORS`
 * is `claude`/`codex` only) and so ships `models: []`; `allowsCustomModel`
 * stays `true` for every harness EXCEPT `ollama` (the underlying
 * `AgentPreference.model` field is, and remains, a free string validated
 * only by `CUSTOM_MODEL_PATTERN` below for every OTHER harness), so a
 * caller may type a custom id via "Other…" everywhere but there. FACTORY-
 * 1050: `ollama` ships `models: OLLAMA_CLAUDE_MODELS` (exactly three fixed
 * literal choices, no power table at all) and `allowsCustomModel: false` —
 * see `RuleFormCatalogEntry.allowsCustomModel`'s own doc comment for the
 * full reasoning and where the model is actually enforced.
 *
 * `efforts` is `AGENT_EFFORTS` for `claude`/`codex`/`ollama` (the same
 * 0-100 axis `effortPower` resolves through, `resolveEffortPower` — `ollama`
 * forwards `--effort` to the real Claude harness it wraps, so it shares the
 * table rather than inventing its own) and `[]` for `agy` (no effort
 * concept at all — `agentLaunchConfig`'s Agy branch never reads one, and
 * `./rules.ts`'s own `parsePreferences` already rejects `effort`/
 * `effortPower` set for that harness).
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
import { AGENT_HARNESSES, AGENT_ROLES, OLLAMA_CLAUDE_MODELS, RULE_PERMISSION_MODES, type AgentHarness, type AgentRole, type RulePermissionMode } from "./agent-harness.js";
import { AGENT_EFFORTS, CLAUDE_MODEL_POWER_TABLE, CODEX_MODEL_POWER_TABLE, type AgentEffort, type ModelPowerBand } from "../resources/power-scale.js";

/**
 * FACTORY-817 — the "Included in capacity" toggle's own catalog entry:
 * NOT per-harness (unlike `RULE_FORM_CATALOG` above) — `Rule.role` applies
 * uniformly across every harness/provider, so this is one global pair of
 * allowed values plus the engine's own default, re-exported from the SAME
 * leaf module (`./agent-harness.ts`) `AGENT_HARNESSES`/`RULE_PERMISSION_MODES`
 * already come from, for the identical bundle-safety reason (see that
 * module's own top comment). `GET /api/rules/catalog` (`../web/view.ts`)
 * serves this verbatim as `capacityRoles`; the write-path validator
 * (`./rules-write-registry.ts`'s `validateRuleFieldPatch`) checks a
 * submitted `role` against the SAME `AGENT_ROLES`, so a value the UI offers
 * is always one the server accepts.
 */
export const CAPACITY_ROLE_DEFAULT: AgentRole = "worker";
export { AGENT_ROLES, type AgentRole };

export interface RuleFormCatalogEntry {
  harness: AgentHarness;
  /** Shipped model aliases, ascending power order, de-duplicated. `[]` for a harness with no power table (`agy`). `ollama`'s three fixed literal choices (`OLLAMA_CLAUDE_MODELS`), in order — not a power table (no sliding scale of alternatives, just exactly three named models). */
  models: readonly string[];
  /**
   * `true` for every harness except `ollama`: `AgentPreference.model` is a
   * free string everywhere else, validated only by `CUSTOM_MODEL_PATTERN`
   * below, so a caller may always type a custom id via "Other…". FACTORY-
   * 1050: `ollama`'s dropdown offers EXACTLY its three authorized models,
   * nothing else — "the smallest coherent fourth launcher option", per the
   * ticket, not a general local-model picker. The write path's own
   * `customModelProblems` below is still shape-only (it has no `harness` to
   * check against here — see its own doc comment); the authoritative,
   * harness-aware rejection of a non-matching `ollama` model lives in
   * `rules.ts`'s `parsePreferences`, the one place `harness` and `model`
   * are already validated together for every write path.
   */
  allowsCustomModel: boolean;
  /** `AGENT_EFFORTS` for a harness with an effort concept, `[]` otherwise (`agy`). `ollama` forwards `--effort` to the real Claude harness it wraps, so it shares Claude/Codex's table. */
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
  ollama: AGENT_EFFORTS,
};

function modelsFor(harness: AgentHarness): readonly string[] {
  if (harness === "ollama") return OLLAMA_CLAUDE_MODELS;
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
  allowsCustomModel: harness !== "ollama",
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
