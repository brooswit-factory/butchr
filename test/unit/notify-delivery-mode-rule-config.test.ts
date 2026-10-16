import { expect, test } from "bun:test";
import { parseRules } from "../../src/rules/rules.js";
import { applyRuleFieldPatch } from "../../src/rules/rules-write-apply.js";
import { validateRuleFieldPatch } from "../../src/rules/rules-write-registry.js";

/**
 * FACTORY-1010 — low-level precedent test, same shape as
 * test/unit/stalled-rule-config.test.ts's own `stalledMinutes` round-trip:
 * `validateRuleFieldPatch` + `applyRuleFieldPatch` + `parseRules` exercised
 * directly, without going through the HTTP-shaped `writeRuleFields`/
 * `planRuleWrite` machinery (that integration-level round-trip, through a
 * real rules.json file and `loadRules`, is
 * test/unit/rules-write.test.ts's own "notifyDeliveryMode round-trips
 * default -> channel -> prompt -> default" test).
 *
 * Responds to the independent review's ticket comment: `null` must
 * actually REMOVE the stored key (never leave the field at whatever it was
 * before, and never write a literal `"notifyDeliveryMode": null`), so a
 * rule can really return to the omitted/default behaviour, not just
 * appear to from a PATCH body that omits the field (which `undefined`
 * already correctly treats as "leave it alone").
 */
const raw = { id: "custom-query", resourceProvider: "jira-work", query: "project = DEMO", brief: "do work" };
const rule = (extra: Record<string, unknown> = {}) => parseRules({ rules: [{ ...raw, ...extra }] })[0]!;

test("notifyDeliveryMode is optional, independent of every other field, and round-trips/removes through config patches", () => {
  expect(rule().notifyDeliveryMode).toBeUndefined();
  expect(rule({ notifyDeliveryMode: "channel" }).notifyDeliveryMode).toBe("channel");
  expect(rule({ notifyDeliveryMode: "prompt" }).notifyDeliveryMode).toBe("prompt");

  expect(validateRuleFieldPatch({ notifyDeliveryMode: "channel" })).toEqual({ ok: true, patch: { notifyDeliveryMode: "channel" } });

  const text = JSON.stringify({ rules: [raw, { ...raw, id: "other" }] });
  const toChannel = applyRuleFieldPatch(text, raw.id, { notifyDeliveryMode: "channel" });
  expect(parseRules(JSON.parse(toChannel))[0]!.notifyDeliveryMode).toBe("channel");
  expect(parseRules(JSON.parse(toChannel))[1]!.notifyDeliveryMode).toBeUndefined(); // the OTHER rule is untouched

  const toPrompt = applyRuleFieldPatch(toChannel, raw.id, { notifyDeliveryMode: "prompt" });
  expect(parseRules(JSON.parse(toPrompt))[0]!.notifyDeliveryMode).toBe("prompt");

  // explicit null — REMOVE, back to omitted/default
  expect(validateRuleFieldPatch({ notifyDeliveryMode: null }).ok).toBe(true);
  const reset = applyRuleFieldPatch(toPrompt, raw.id, { notifyDeliveryMode: null });
  const resetRaw = JSON.parse(reset).rules[0];
  expect(resetRaw).not.toHaveProperty("notifyDeliveryMode"); // never a literal `"notifyDeliveryMode": null` on disk
  expect(parseRules(JSON.parse(reset))[0]!.notifyDeliveryMode).toBeUndefined();
});

test.each(["both", "none", "Channel", "", 1, true])("invalid notifyDeliveryMode %j is rejected by both the file parser and the write-patch validator", (value) => {
  expect(() => rule({ notifyDeliveryMode: value })).toThrow("notifyDeliveryMode");
  expect(validateRuleFieldPatch({ notifyDeliveryMode: value }).ok).toBe(false);
});

test("an omitted patch field leaves a previously-set value untouched — only explicit null clears it", () => {
  const text = JSON.stringify({ rules: [{ ...raw, notifyDeliveryMode: "channel" }] });
  const untouched = applyRuleFieldPatch(text, raw.id, { query: "project = DEMO AND status = Done" });
  expect(parseRules(JSON.parse(untouched))[0]!.notifyDeliveryMode).toBe("channel");
});
