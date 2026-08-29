import { describe, expect, test } from "bun:test";
import { planReconcile, isActive, ACTIVE_STATUSES } from "../../src/reconcile/plan.js";

describe("planReconcile", () => {
  test("spawns desired-not-running, stops running-not-desired, leaves the intersection", () => {
    expect(planReconcile(["A", "B", "C"], ["B", "C", "D"])).toEqual({ spawn: ["A"], stop: ["D"], respawn: [] });
  });
  test("empty desired stops everything; empty running spawns everything", () => {
    expect(planReconcile([], ["X", "Y"])).toEqual({ spawn: [], stop: ["X", "Y"], respawn: [] });
    expect(planReconcile(["X"], [])).toEqual({ spawn: ["X"], stop: [], respawn: [] });
  });
  test("identical sets are a no-op; output is sorted", () => {
    expect(planReconcile(["B", "A"], ["A", "B"])).toEqual({ spawn: [], stop: [], respawn: [] });
  });
  test("isActive matches only In Progress / In Review", () => {
    expect(isActive("In Progress")).toBe(true); expect(isActive("In Review")).toBe(true);
    expect(isActive("To Do")).toBe(false); expect(isActive("Done")).toBe(false);
    expect([...ACTIVE_STATUSES].sort()).toEqual(["In Progress", "In Review"]);
  });
  describe("respawn", () => {
    test("a stale key that is both desired and running goes to respawn, not spawn or stop", () => {
      expect(planReconcile(["A", "B"], ["A", "B"], ["A"])).toEqual({ spawn: [], stop: [], respawn: ["A"] });
    });
    test("a stale key that is no longer desired is stopped, not respawned", () => {
      expect(planReconcile(["A"], ["A", "B"], ["B"])).toEqual({ spawn: [], stop: ["B"], respawn: [] });
    });
    test("a stale key that isn't running (already gone) is neither spawned as new nor respawned twice", () => {
      expect(planReconcile(["A"], [], ["A"])).toEqual({ spawn: ["A"], stop: [], respawn: [] });
    });
    test("defaults to no respawns when stale is omitted", () => {
      expect(planReconcile(["A"], ["A"])).toEqual({ spawn: [], stop: [], respawn: [] });
    });
  });
});
