/**
 * FACTORY-75 (story FACTORY-74, epic FACTORY-73) — two independent 0-100
 * integer axes replacing the old 5-point `tier` scale, for BOTH
 * managed-session definitions (src/resources/session-definition.ts's
 * `modelPower`/`effort` fields) and rule-launched agents
 * (src/rules/rules.ts's `AgentPreference.modelPower`/`effortPower` fields):
 *
 *   - "model power" (0-100): which MODEL launches, resolved through a
 *     per-vendor table of ranges -> model alias. Named `modelPower` on both
 *     consumers' own field, never `capability` — this codebase already uses
 *     "capability" for a distinct, unrelated concept
 *     (src/resources/capabilities.ts's per-provider capability
 *     declarations); reusing that word here would read as related when it
 *     isn't, so this ticket's own naming suggestion is deliberately not
 *     followed verbatim (see this ticket's PR description for the same
 *     note to its reviewer).
 *   - "effort" (0-100): how hard that model thinks, resolved through ONE
 *     shared table of ranges -> `AgentEffort` (the same 5-level scale
 *     `--effort` already accepts for Claude, src/agents/argv.ts), then
 *     translated per vendor at the point a launch is actually built
 *     (`codexReasoningEffortFlag` below) — Codex's own CLI/config surface
 *     distinguishes fewer levels than Claude's, so the shared 0-100 axis
 *     stays one mental model across vendors even though the two don't
 *     resolve to the same NUMBER of distinct real outcomes.
 *
 * `AgentEffort`/`AGENT_EFFORTS` moved here from src/rules/rules.ts (which
 * re-exports them unchanged for every existing importer) so this module can
 * define the effort table without importing back from rules.ts:
 * session-definition.ts already depends on rules.ts and now ALSO depends on
 * this module, and rules.ts now depends on this module too (for the new
 * `AgentPreference` fields' validation) — rules.ts must therefore not
 * depend on session-definition.ts, and this module must not depend on
 * rules.ts, or the two new dependency edges would form a cycle. Living here
 * (a leaf, no imports from either) is what keeps both edges one-directional.
 *
 * Deliberately NOT a factory-level resolver — no SessionDefinition/Rule
 * knowledge here, just pure data + pure functions, reused identically by
 * both consumers. See `effectiveAgent` (session-definition.ts) for where a
 * definition's own shape (the deprecated `tier` field included) meets this
 * table, and `resolvePreferencePower` (rules.ts) for the rules-path
 * equivalent.
 */

export const AGENT_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type AgentEffort = (typeof AGENT_EFFORTS)[number];

/** Both axes share this same 0-100 integer range. */
export const POWER_SCALE_MIN = 0;
export const POWER_SCALE_MAX = 100;

export type PowerVendor = "claude" | "codex";
export const POWER_VENDORS: readonly PowerVendor[] = ["claude", "codex"];

export interface ModelPowerBand { min: number; max: number; model: string }
export interface EffortBand { min: number; max: number; effort: AgentEffort }

/**
 * 0 = Haiku, 100 = Fable — the director's own framing (FACTORY-73 comment,
 * [director], ~18:16Z), ordered by capability/cost. Four equal 25-wide
 * bands cover 0-100 with no gaps or overlaps by construction (swept in
 * power-scale.test.ts). Model strings here are the same short aliases the
 * pre-existing `tierToModel` (src/resources/session-definition.ts) already
 * used ("sonnet"/"opus"), not full model ids, so a resolved value reaches
 * `--model` exactly like a hand-written alias would.
 */
export const CLAUDE_MODEL_POWER_TABLE: readonly ModelPowerBand[] = [
  { min: 0, max: 24, model: "haiku" },
  { min: 25, max: 49, model: "sonnet" },
  { min: 50, max: 74, model: "opus" },
  { min: 75, max: 100, model: "fable" },
];

/**
 * Same 4-way, 25-wide shape as Claude's table, over Codex's own 4 model
 * tiers — the same ascending models the pre-existing `tierToModel`
 * (src/resources/session-definition.ts) already named for
 * tier1/tier2/tier3/tier4-5 (gpt-5.6-luna / gpt-5.6-terra / gpt-5.6-sol /
 * gpt-6-astra), in the same order.
 */
export const CODEX_MODEL_POWER_TABLE: readonly ModelPowerBand[] = [
  { min: 0, max: 24, model: "gpt-5.6-luna" },
  { min: 25, max: 49, model: "gpt-5.6-terra" },
  { min: 50, max: 74, model: "gpt-5.6-sol" },
  { min: 75, max: 100, model: "gpt-6-astra" },
];

export const MODEL_POWER_TABLES: Readonly<Record<PowerVendor, readonly ModelPowerBand[]>> = {
  claude: CLAUDE_MODEL_POWER_TABLE,
  codex: CODEX_MODEL_POWER_TABLE,
};

/**
 * ONE shared effort table for every vendor — 5 bands (four 20-wide, one
 * 21-wide to absorb the 101st integer) covering the SAME `AgentEffort`
 * scale `--effort` already exposes for Claude (src/agents/argv.ts). Codex
 * has no 5-level equivalent (see `codexReasoningEffortFlag` below) — its
 * own launch clamps down at EMISSION time, never here, so the 0-100 axis
 * stays one shared mental model across vendors even though what Codex's
 * CLI actually receives is coarser.
 */
export const EFFORT_TABLE: readonly EffortBand[] = [
  { min: 0, max: 19, effort: "low" },
  { min: 20, max: 39, effort: "medium" },
  { min: 40, max: 59, effort: "high" },
  { min: 60, max: 79, effort: "xhigh" },
  { min: 80, max: 100, effort: "max" },
];

/**
 * Mine to pick, per FACTORY-73 [director]'s ask for ONE documented "Sonnet
 * at medium effort" pair that admin-assembly can apply everywhere post-deploy
 * — the start of each band, so it reads as the obvious canonical point
 * rather than an arbitrary mid-band number. Used by nothing in the launch
 * path itself (admin-assembly applies it by hand, later, outside this
 * ticket's scope) — only by docs/tests, which assert it actually resolves
 * to Sonnet/medium.
 */
export const CANONICAL_SONNET_MODEL_POWER = 25;
export const CANONICAL_MEDIUM_EFFORT = 20;

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
const inScale = (v: number): boolean => v >= POWER_SCALE_MIN && v <= POWER_SCALE_MAX;

/** Why a `modelPower`/`effort`/`effortPower` value is unusable, or `[]`. Same "collect, never touch anything else" shape every other definition-field validator in this codebase already follows. */
export function powerValueProblems(raw: unknown, at: string): string[] {
  if (!isInt(raw)) return [`${at} must be an integer`];
  if (!inScale(raw)) return [`${at} must be between ${POWER_SCALE_MIN} and ${POWER_SCALE_MAX}`];
  return [];
}

function findBand<T extends { min: number; max: number }>(table: readonly T[], value: number): T {
  const band = table.find((b) => value >= b.min && value <= b.max);
  if (!band) throw new Error(`power-scale.ts: no band covers ${value} — table coverage bug, see power-scale.test.ts`);
  return band;
}

/** `modelPower` (0-100, validated by `powerValueProblems` at load time) -> the model this vendor's table names for that point. */
export function resolveModelPower(vendor: PowerVendor, modelPower: number): string {
  return findBand(MODEL_POWER_TABLES[vendor], modelPower).model;
}

/** `effort`/`effortPower` (0-100, validated by `powerValueProblems` at load time) -> the shared `AgentEffort` scale point — vendor-independent; see `codexReasoningEffortFlag` for where a vendor's own narrower CLI surface is applied. */
export function resolveEffortPower(effortPower: number): AgentEffort {
  return findBand(EFFORT_TABLE, effortPower).effort;
}

/**
 * Codex's `model_reasoning_effort` config key — LIVE-VERIFIED in this
 * checkout's own environment (`codex-cli` 0.145.0, model `gpt-5.6-sol`,
 * 2026-09-26): running `codex exec` with an invalid value
 * (`model_reasoning_effort = "minimal"`, OpenAI's public GPT-5-class
 * reasoning-effort naming, which this function ORIGINALLY assumed) returned
 * a real API error naming the actual accepted set verbatim: `"Unsupported
 * value: 'minimal' is not supported with the 'gpt-5.6-sol' model. Supported
 * values are: 'none', 'low', 'medium', 'high', 'xhigh', and 'max'."` — SIX
 * values, five of which (`low`/`medium`/`high`/`xhigh`/`max`) are spelled
 * IDENTICALLY to `AgentEffort` itself. Confirmed the value is not merely
 * accepted but ACTUALLY ENGAGED: the same hard reasoning prompt run once
 * with `model_reasoning_effort = "none"` reported `reasoning_output_tokens:
 * 0` in codex's own `turn.completed` usage event, and once with `"max"`
 * reported `reasoning_output_tokens: 60` — both landed on the same correct
 * answer, so effort visibly changed HOW the model got there, not just
 * whether it did.
 *
 * Because the two scales are spelled identically, this is now a plain
 * passthrough — no clamp, no translation. (An earlier version of this
 * function assumed OpenAI's public 4-level GPT-5 naming — `minimal`/`low`/
 * `medium`/`high` — and clamped `xhigh`/`max` down to `high`; that was
 * wrong for this model, per the live verification above, and has been
 * corrected. `codex`'s own 6th value, `"none"`, has no `AgentEffort`
 * equivalent and is simply never produced by `resolveEffortPower`.)
 */
export function codexReasoningEffortFlag(effort: AgentEffort): AgentEffort {
  return effort;
}
