import { describe, expect, test } from "bun:test";
import {
  AGENT_EFFORTS, CANONICAL_MEDIUM_EFFORT, CANONICAL_SONNET_MODEL_POWER,
  CLAUDE_MODEL_POWER_TABLE, CODEX_MODEL_POWER_TABLE, EFFORT_TABLE, POWER_SCALE_MAX, POWER_SCALE_MIN,
  codexReasoningEffortFlag, powerValueProblems, resolveEffortPower, resolveModelPower,
} from "../../src/resources/power-scale.js";

const sweepIntegers = (min: number, max: number): number[] => Array.from({ length: max - min + 1 }, (_, i) => min + i);

const assertFullCoverageNoGapsNoOverlaps = (table: readonly { min: number; max: number }[]) => {
  // Every integer 0-100 is covered by EXACTLY one band.
  for (const v of sweepIntegers(POWER_SCALE_MIN, POWER_SCALE_MAX)) {
    const matches = table.filter((b) => v >= b.min && v <= b.max);
    expect(matches.length).toBe(1);
  }
  // Bands themselves, sorted by min, are contiguous: band[i].max + 1 === band[i+1].min.
  const sorted = [...table].sort((a, b) => a.min - b.min);
  expect(sorted[0]!.min).toBe(POWER_SCALE_MIN);
  expect(sorted[sorted.length - 1]!.max).toBe(POWER_SCALE_MAX);
  for (let i = 0; i < sorted.length - 1; i++) expect(sorted[i]!.max + 1).toBe(sorted[i + 1]!.min);
};

describe("model power tables: full 0-100 coverage, no gaps, no overlaps", () => {
  test("claude", () => assertFullCoverageNoGapsNoOverlaps(CLAUDE_MODEL_POWER_TABLE));
  test("codex", () => assertFullCoverageNoGapsNoOverlaps(CODEX_MODEL_POWER_TABLE));
});

describe("effort table: full 0-100 coverage, no gaps, no overlaps (shared across vendors)", () => {
  test("effort table", () => assertFullCoverageNoGapsNoOverlaps(EFFORT_TABLE));
  test("every band's effort is a real AgentEffort", () => {
    for (const band of EFFORT_TABLE) expect(AGENT_EFFORTS).toContain(band.effort);
  });
});

describe("resolveModelPower", () => {
  test("claude: 0 = haiku, 100 = fable — the director's own framing", () => {
    expect(resolveModelPower("claude", 0)).toBe("haiku");
    expect(resolveModelPower("claude", 100)).toBe("fable");
  });
  test("claude: every band resolves to a distinct, non-empty model", () => {
    const models = new Set(CLAUDE_MODEL_POWER_TABLE.map((b) => b.model));
    expect(models.size).toBe(CLAUDE_MODEL_POWER_TABLE.length);
    for (const m of models) expect(m.length).toBeGreaterThan(0);
  });
  test("codex: ascending tiers, same 4-model shape as the pre-existing tierToModel table", () => {
    expect(resolveModelPower("codex", 0)).toBe("gpt-5.6-luna");
    expect(resolveModelPower("codex", 100)).toBe("gpt-6-astra");
  });
  test("resolves consistently across an entire band, not just its boundary", () => {
    for (const v of sweepIntegers(0, 100)) {
      const band = CLAUDE_MODEL_POWER_TABLE.find((b) => v >= b.min && v <= b.max)!;
      expect(resolveModelPower("claude", v)).toBe(band.model);
    }
  });
});

describe("resolveEffortPower", () => {
  test("0 = low, 100 = max", () => {
    expect(resolveEffortPower(0)).toBe("low");
    expect(resolveEffortPower(100)).toBe("max");
  });
  test("resolves consistently across an entire band", () => {
    for (const v of sweepIntegers(0, 100)) {
      const band = EFFORT_TABLE.find((b) => v >= b.min && v <= b.max)!;
      expect(resolveEffortPower(v)).toBe(band.effort);
    }
  });
});

describe("the four FACTORY-73/74/75 canonical target pairs resolve as documented", () => {
  test("admin-agentcost/admin-agentvelocity: modelPower=100, effort=70 -> Fable at a sub-max effort (xhigh)", () => {
    expect(resolveModelPower("claude", 100)).toBe("fable");
    expect(resolveEffortPower(70)).toBe("xhigh");
    expect(resolveEffortPower(70)).not.toBe("max");
  });
  test("canonical Sonnet/medium pair (mine to pick, documented): CANONICAL_SONNET_MODEL_POWER/CANONICAL_MEDIUM_EFFORT resolve to Sonnet at medium effort", () => {
    expect(resolveModelPower("claude", CANONICAL_SONNET_MODEL_POWER)).toBe("sonnet");
    expect(resolveEffortPower(CANONICAL_MEDIUM_EFFORT)).toBe("medium");
  });
  test("Servy Epic/Bug: modelPower=75, effort=90 -> Fable at max effort", () => {
    expect(resolveModelPower("claude", 75)).toBe("fable");
    expect(resolveEffortPower(90)).toBe("max");
  });
  test("Servy task-level: modelPower=<the Sonnet value>, effort=90 -> Sonnet at max effort", () => {
    expect(resolveModelPower("claude", CANONICAL_SONNET_MODEL_POWER)).toBe("sonnet");
    expect(resolveEffortPower(90)).toBe("max");
  });
});

describe("codexReasoningEffortFlag", () => {
  // Live-verified (see this function's own doc comment, power-scale.ts):
  // codex's real accepted `model_reasoning_effort` set is `none, low,
  // medium, high, xhigh, max` — the SAME spelling as AgentEffort for all 5
  // values butchr's own scale ever produces, so this is a plain passthrough.
  test("every AgentEffort passes through unchanged — no clamp, no translation", () => {
    for (const e of AGENT_EFFORTS) expect(codexReasoningEffortFlag(e)).toBe(e);
  });
});

describe("powerValueProblems", () => {
  test("a valid integer in range has no problems", () => {
    for (const v of [0, 1, 50, 99, 100]) expect(powerValueProblems(v, "def.modelPower")).toEqual([]);
  });
  test("out of range is rejected", () => {
    expect(powerValueProblems(-1, "def.modelPower")).toEqual(["def.modelPower must be between 0 and 100"]);
    expect(powerValueProblems(101, "def.modelPower")).toEqual(["def.modelPower must be between 0 and 100"]);
  });
  test("non-integer is rejected", () => {
    expect(powerValueProblems(50.5, "def.modelPower")).toEqual(["def.modelPower must be an integer"]);
    expect(powerValueProblems("50", "def.modelPower")).toEqual(["def.modelPower must be an integer"]);
    expect(powerValueProblems(null, "def.modelPower")).toEqual(["def.modelPower must be an integer"]);
    expect(powerValueProblems(undefined, "def.modelPower")).toEqual(["def.modelPower must be an integer"]);
  });
});
