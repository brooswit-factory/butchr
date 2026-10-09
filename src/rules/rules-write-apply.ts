/**
 * FACTORY-662 — builds the NEXT rules-document text for a web-UI edit, from
 * the CURRENT text plus a validated `RuleFieldPatch` (`./rules-write-
 * registry.ts`). Deliberately a full `JSON.parse` / rebuild / `JSON.stringify`
 * round-trip rather than a text splice (contrast `write-rules.ts`'s own
 * `setRuleEnabled`, which preserves exact byte formatting because it edits a
 * file a human may also hand-edit): this ticket's own "rebuild objects, no
 * deep merge" instruction is about the RULE OBJECT's shape, not the file's
 * bytes, and `assertOnlyChanged` (the gate that actually matters for safety)
 * diffs PARSED values, never text — a reformatted-but-semantically-identical
 * document reports zero diffs there regardless.
 *
 * Only the TARGET rule's own object is ever touched; every other rule in
 * the array survives a plain value copy, untouched — which is also what
 * keeps `assertOnlyChanged`'s allowlist (scoped to "any rule", in the
 * abstract) from actually reaching any rule but this one in practice.
 */
import { EDITABLE_AGENT_PREFERENCE_LEAVES, EDITABLE_TOP_LEVEL_FIELDS, type RuleFieldPatch } from "./rules-write-registry.js";

export class RuleWriteApplyError extends Error {}

function findRuleIndex(rules: unknown[], id: string): number {
  return rules.findIndex((r) => r !== null && typeof r === "object" && (r as Record<string, unknown>).id === id);
}

function parseRulesDoc(currentText: string | undefined): { doc: unknown; rules: unknown[] } {
  const doc: unknown = JSON.parse(currentText && currentText.length > 0 ? currentText : '{"rules":[]}');
  if (!doc || typeof doc !== "object" || !Array.isArray((doc as Record<string, unknown>).rules)) {
    throw new RuleWriteApplyError(`expected an object with a "rules" array`);
  }
  return { doc, rules: (doc as { rules: unknown[] }).rules };
}

/**
 * The target rule's own ARRAY INDEX in `currentText`'s `rules` array — the
 * agentsafety re-check's own finding (2026-10-05 17:0x PDT comment on
 * FACTORY-662): `assertOnlyChanged`'s allowlist patterns are ARRAY-INDEX
 * based, and `*` matches ANY index — so an allowlist built once, statically,
 * as `"rules.*.enabled"` permits a write to ANY rule's `enabled`, not just
 * the one targeted by id. The fix is
 * this function: read the index fresh, from the SAME locked `currentText`
 * the mutator already has in hand, and build an allowlist that names that
 * literal index — never a wildcard. Throws if `id` is not found.
 */
export function ruleIndexById(currentText: string | undefined, id: string): number {
  const { rules } = parseRulesDoc(currentText);
  const idx = findRuleIndex(rules, id);
  if (idx === -1) throw new RuleWriteApplyError(`no rule with id ${JSON.stringify(id)}`);
  return idx;
}

/** `rules.<idx>.enabled` for the ONE rule `id` resolves to, by its CURRENT index — fed to `assertOnlyChanged` for `POST /api/rules/:id/enabled`. */
export function buildEnabledAllowedPaths(currentText: string | undefined, id: string): string[] {
  return [`rules.${ruleIndexById(currentText, id)}.enabled`];
}

/**
 * The allowed paths for a `PUT /api/rules/:id` patch, scoped to this ONE
 * rule's CURRENT index and (for `agentPreferences`) its CURRENT per-element
 * indices — never a wildcard, and never the array's own path (so an
 * element COUNT change, which `diffPaths` reports at the array's own path,
 * matches no pattern here and is refused exactly as `rules-write-
 * registry.ts`'s own header already documents). Top-level leaves come from
 * `EDITABLE_TOP_LEVEL_FIELDS` (FACTORY-729: `query`/`permissionMode`/
 * `lizardMode`), only for whichever of those names is actually PRESENT in
 * `patch` — an absent field in the patch never earns an allowed path for
 * itself. `agentPreferences` leaves (`EDITABLE_AGENT_PREFERENCE_LEAVES`,
 * which now includes `harness` — FACTORY-729, see that constant's own doc
 * comment) stay LEAF paths only, never `rules.<idx>.agentPreferences.<m>`
 * bare — a PREFIX match on that bare path would also permit adding or
 * removing a key on the element itself.
 */
export function buildFieldsAllowedPaths(currentText: string | undefined, id: string, patch: RuleFieldPatch): string[] {
  const idx = ruleIndexById(currentText, id);
  const paths: string[] = [];
  const patchRecord = patch as unknown as Record<string, unknown>;
  for (const field of EDITABLE_TOP_LEVEL_FIELDS) {
    if (patchRecord[field] !== undefined) paths.push(`rules.${idx}.${field}`);
  }
  if (patch.agentPreferences !== undefined) {
    const rule = readRuleById(currentText, id);
    const currentPrefs = Array.isArray(rule.agentPreferences) ? rule.agentPreferences : [];
    for (let m = 0; m < currentPrefs.length; m++) {
      for (const leaf of EDITABLE_AGENT_PREFERENCE_LEAVES) paths.push(`rules.${idx}.agentPreferences.${m}.${leaf}`);
    }
  }
  return paths;
}

/** Reads the current rules document and returns the target rule's own raw parsed object (never a copy) — for building a plan/diff preview without writing anything. Throws if the document is malformed or the id is not found. */
export function readRuleById(currentText: string | undefined, id: string): Record<string, unknown> {
  const { rules } = parseRulesDoc(currentText);
  const idx = findRuleIndex(rules, id);
  if (idx === -1) throw new RuleWriteApplyError(`no rule with id ${JSON.stringify(id)}`);
  return rules[idx] as Record<string, unknown>;
}

/** FACTORY-927 — whether `id` already names a rule in `currentText`, for `createRule`'s own collision check (`./rules-write.ts`). `true` for a malformed/absent document too (reading it as "no, go ahead" would be wrong — but a malformed document can never actually reach this call in practice, since `createRule` runs this under the same lock `loadRules` has already validated the CURRENT file through at daemon startup; kept as a cheap, honest `false` rather than throwing, since "does this id exist" has a clear answer — no — even for an empty/absent file). */
export function ruleIdExists(currentText: string | undefined, id: string): boolean {
  try {
    const { rules } = parseRulesDoc(currentText);
    return findRuleIndex(rules, id) !== -1;
  } catch {
    return false;
  }
}

/**
 * FACTORY-927 — appends a brand-new rule object to `currentText`'s `rules`
 * array and returns the whole next document's text, same full
 * `JSON.parse`/rebuild/`JSON.stringify` round-trip `applyRuleFieldPatch`
 * uses immediately below (see this file's own header for why that's the
 * right discipline here too). Every OTHER rule survives a plain value copy,
 * untouched. Does NOT validate `newRule`'s own shape — that's `loadRules`'s
 * job, run by `commitWrite` (`./write-rules.ts`) BEFORE anything is written,
 * exactly like every other write in this codebase relies on for the same
 * reason (see `rules-write-registry.ts`'s own `validateRuleCreateInput` doc
 * comment).
 */
export function appendRule(currentText: string | undefined, newRule: Record<string, unknown>): string {
  const { doc, rules } = parseRulesDoc(currentText);
  rules.push(newRule);
  return JSON.stringify(doc, null, 2) + "\n";
}

/**
 * Applies `patch` to rule `id` in `currentText`, returning the whole next
 * document's text. Throws `RuleWriteApplyError` (never a generic `Error`,
 * so callers can map it to a 400 without guessing) on: malformed current
 * document, unknown id, or an `agentPreferences` patch whose length does
 * not match the rule's CURRENT `agentPreferences` length (no addition or
 * removal is ever permitted — see `rules-write-registry.ts`'s own header).
 */
export function applyRuleFieldPatch(currentText: string | undefined, id: string, patch: RuleFieldPatch): string {
  const { doc, rules } = parseRulesDoc(currentText);
  const idx = findRuleIndex(rules, id);
  if (idx === -1) throw new RuleWriteApplyError(`no rule with id ${JSON.stringify(id)}`);
  const current = rules[idx] as Record<string, unknown>;
  const next: Record<string, unknown> = { ...current };

  if (patch.enabled !== undefined) next.enabled = patch.enabled;
  if (patch.query !== undefined) next.query = patch.query;
  if (patch.permissionMode !== undefined) next.permissionMode = patch.permissionMode;
  if (patch.lizardMode !== undefined) next.lizardMode = patch.lizardMode;
  if (patch.role !== undefined) next.role = patch.role;
  if (patch.agentPreferences !== undefined) {
    const currentPrefs = Array.isArray(current.agentPreferences) ? (current.agentPreferences as Record<string, unknown>[]) : [];
    if (patch.agentPreferences.length !== currentPrefs.length) {
      throw new RuleWriteApplyError(`agentPreferences must have exactly ${currentPrefs.length} entries (adding or removing a preference is not permitted in this slice), got ${patch.agentPreferences.length}`);
    }
    next.agentPreferences = currentPrefs.map((cur, i) => ({ ...cur, ...patch.agentPreferences![i] }));
  }

  rules[idx] = next;
  return JSON.stringify(doc, null, 2) + "\n";
}
