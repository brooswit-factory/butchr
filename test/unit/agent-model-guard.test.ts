import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { modelFor } from "../../src/agents/workspace.js";

/**
 * BUTCHR-90: `docs/agent-model.md`'s agent-type table and `modelFor()` in
 * `src/agents/workspace.ts` are two independent places that each assert
 * which model an Epic agent runs on, and nothing compared them — the table
 * cell drifted to `fable` while the code (and the doc's own build-order
 * line, 100 lines further down the same file) moved to `opus` in commit
 * `ca38dd15`, and the mismatch survived three days with a fully green
 * suite. BUTCHR-89 measured this; see that ticket for the full channel
 * sweep. This guard closes the one gap that sweep found unguarded.
 *
 * SCOPE — bounded to this ONE pair on purpose, not a general facts-checker:
 * the doc's agent-type-table Epic row (`docs/agent-model.md`) against
 * `modelFor("Epic")` (`src/agents/workspace.ts`). It does not check Story,
 * Task or Project rows, the doc's build-order section, or any other
 * channel — `test/unit/merge-check-guard.test.ts` (BUTCHR-56/BUTCHR-74)
 * already owns a separate, differently-scoped drift guard over a different
 * fact (the merge-check instructions) across a wider channel set; this
 * file does not duplicate or extend that one.
 *
 * WHAT THIS FILE CANNOT PROVE: it asserts the doc and the code AGREE, never
 * that either is right. Agreement is necessary but not sufficient — both
 * sides could be updated to the same wrong value and this stays green. It
 * is also a text/string check: it says nothing about whether the value
 * `modelFor` returns is one `--model` actually accepts at spawn time.
 *
 * FORWARDING ADDRESS: every assertion below pins AGREEMENT, not the literal
 * string "opus" — nothing here hard-codes a model name. The current value
 * is a DEFAULT, not a human-stated decision — no one confirmed which model
 * Epics should run on when asked; `opus` is only the completion of the
 * recorded, reasoned change in commit `ca38dd15` / CHANGELOG.md's
 * `## [0.15.0]` entry, made because Fable capacity was exhausted
 * fleet-wide. That entry names an explicit revert condition: "revert the
 * map when Fable capacity returns." If that happens, both
 * `docs/agent-model.md`'s Epic row AND `modelFor`'s epic mapping must
 * change together — this test will go red the moment only one of them
 * does, and that red is correct: it means the two sides disagree again, not
 * that this test is broken. Do not delete this assertion to get green; fix
 * whichever side is now stale instead.
 */

const DOC_PATH = join(import.meta.dir, "..", "..", "docs", "agent-model.md");

// The agent-type table's header row names its own columns
// ("| type | owns | model | effort |"), so the "model" column's position is
// looked up from the header rather than assumed at a fixed index — a column
// reorder (header and cells moved together) still parses correctly, and a
// genuine drift (a row no longer lining up with the header it claims) falls
// out of this by construction instead of needing a separate hard-coded
// value allowlist to catch it.
function findColumnIndex(headerRow: string, columnName: string): number {
  const cells = headerRow.split("|").slice(1, -1).map((cell) => cell.trim());
  return cells.indexOf(columnName);
}

function parseDocEpicModel(docText: string): string {
  const lines = docText.split("\n");
  const headerRow = lines.find((line) => line.trim().startsWith("| type"));
  if (!headerRow) return "";
  const modelCol = findColumnIndex(headerRow, "model");
  if (modelCol === -1) return "";
  const epicRow = lines.find((line) => line.trim().startsWith("| **Epic**"));
  if (!epicRow) return "";
  const cells = epicRow.split("|").slice(1, -1).map((cell) => cell.trim());
  return cells[modelCol] ?? "";
}

describe("docs/agent-model.md Epic model cell vs modelFor (BUTCHR-90)", () => {
  test("non-vacuity: the doc's Epic row parses to a real, non-empty model cell", () => {
    const docText = readFileSync(DOC_PATH, "utf8");
    expect(parseDocEpicModel(docText).length).toBeGreaterThan(0);
  });

  test("the doc's Epic model cell agrees with modelFor(\"Epic\")", () => {
    const docText = readFileSync(DOC_PATH, "utf8");
    const docValue = parseDocEpicModel(docText);
    expect(docValue).toBe(modelFor("Epic"));
  });
});
