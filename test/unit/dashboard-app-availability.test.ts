import { describe, expect, test } from "bun:test";
import { availabilityText, couldNotCheck, isCouldNotCheck, isKnown, isNotApplicable, known, matchAvailability, notApplicable } from "../../dashboard-app/src/view-model/availability.js";

describe("Availability (pure) — FACTORY-614", () => {
  test("known/couldNotCheck/notApplicable build distinct, correctly-discriminated shapes", () => {
    expect(known(42)).toEqual({ kind: "known", value: 42 });
    expect(couldNotCheck("read failed")).toEqual({ kind: "could-not-check", reason: "read failed" });
    expect(notApplicable("no agent")).toEqual({ kind: "not-applicable", reason: "no agent" });
  });

  test("couldNotCheck/notApplicable omit `reason` entirely when not given, never `reason: undefined`", () => {
    expect(couldNotCheck()).toEqual({ kind: "could-not-check" });
    expect("reason" in couldNotCheck()).toBe(false);
    expect(notApplicable()).toEqual({ kind: "not-applicable" });
    expect("reason" in notApplicable()).toBe(false);
  });

  test("isKnown/isCouldNotCheck/isNotApplicable never conflate the three — each is true for exactly one kind", () => {
    const k = known("v");
    const c = couldNotCheck("r");
    const n = notApplicable("r");
    expect([isKnown(k), isCouldNotCheck(k), isNotApplicable(k)]).toEqual([true, false, false]);
    expect([isKnown(c), isCouldNotCheck(c), isNotApplicable(c)]).toEqual([false, true, false]);
    expect([isKnown(n), isCouldNotCheck(n), isNotApplicable(n)]).toEqual([false, false, true]);
  });

  test("matchAvailability dispatches to the matching branch, carrying the value/reason through", () => {
    const render = (a: ReturnType<typeof known<number>> | ReturnType<typeof couldNotCheck<number>> | ReturnType<typeof notApplicable<number>>) =>
      matchAvailability(a, {
        known: (v) => `known:${v}`,
        couldNotCheck: (r) => `cnc:${r ?? "?"}`,
        notApplicable: (r) => `na:${r ?? "?"}`,
      });
    expect(render(known(7))).toBe("known:7");
    expect(render(couldNotCheck("declined"))).toBe("cnc:declined");
    expect(render(notApplicable("withheld"))).toBe("na:withheld");
  });

  test("availabilityText renders the fixed could-not-check/not-applicable wording and formats KNOWN via the caller", () => {
    expect(availabilityText(known(3), (n) => `${n} row(s)`)).toBe("3 row(s)");
    expect(availabilityText(couldNotCheck<number>("x"), (n) => `${n} row(s)`)).toBe("could not check");
    expect(availabilityText(notApplicable<number>("x"), (n) => `${n} row(s)`)).toBe("n/a");
  });
});
