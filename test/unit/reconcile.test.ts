import { describe, expect, test } from "bun:test";
import { planReconcile, isActive, ACTIVE_STATUSES } from "../../src/reconcile/plan.js";

describe("planReconcile", () => {
  test("spawns desired-not-running, stops running-not-desired, leaves the intersection", () => {
    expect(planReconcile(["A", "B", "C"], ["B", "C", "D"])).toEqual({ spawn: ["A"], stop: ["D"] });
  });
  test("empty desired stops everything; empty running spawns everything", () => {
    expect(planReconcile([], ["X", "Y"])).toEqual({ spawn: [], stop: ["X", "Y"] });
    expect(planReconcile(["X"], [])).toEqual({ spawn: ["X"], stop: [] });
  });
  test("identical sets are a no-op; output is sorted", () => {
    expect(planReconcile(["B", "A"], ["A", "B"])).toEqual({ spawn: [], stop: [] });
  });
  test("isActive matches only In Progress / In Review", () => {
    expect(isActive("In Progress")).toBe(true); expect(isActive("In Review")).toBe(true);
    expect(isActive("To Do")).toBe(false); expect(isActive("Done")).toBe(false);
    expect([...ACTIVE_STATUSES].sort()).toEqual(["In Progress", "In Review"]);
  });
});
