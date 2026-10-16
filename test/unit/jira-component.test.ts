import { describe, expect, test } from "bun:test";
import { mapJiraComponent } from "../../src/resources/jira-component.js";
import { formatJiraComponentRef } from "../../src/resources/jira-component-ref.js";

describe("mapJiraComponent", () => {
  test("maps a raw API item into a JiraComponent carrying ref/id/project/name/url", () => {
    const resource = mapJiraComponent({ id: "10000", name: "Backend" }, "butchr", "https://butchr.example/components/10000");
    expect(resource).toEqual({
      ref: "BUTCHR:10000",
      id: "10000",
      project: "BUTCHR",
      name: "Backend",
      url: "https://butchr.example/components/10000",
    });
  });

  test("uppercases the project in the resource even though the ref already canonicalizes it", () => {
    const resource = mapJiraComponent({ id: "1", name: "x" }, "factory", "https://x");
    expect(resource.project).toBe("FACTORY");
    expect(resource.ref).toBe(formatJiraComponentRef({ project: "factory", id: "1" }));
  });

  test("throws when id is missing or malformed", () => {
    expect(() => mapJiraComponent({ name: "Backend" }, "BUTCHR", "https://x")).toThrow();
    expect(() => mapJiraComponent({ id: 10000, name: "Backend" }, "BUTCHR", "https://x")).toThrow();
    expect(() => mapJiraComponent({ id: "", name: "Backend" }, "BUTCHR", "https://x")).toThrow();
  });

  test("throws when name is missing or malformed", () => {
    expect(() => mapJiraComponent({ id: "10000" }, "BUTCHR", "https://x")).toThrow();
    expect(() => mapJiraComponent({ id: "10000", name: 5 }, "BUTCHR", "https://x")).toThrow();
  });

  /**
   * FACTORY-986 scope item (b), proven at the resource-mapping level too (see
   * jira-component-ref.test.ts for the ref-level proof): mapping the SAME
   * fake Jira component before and after a rename (same `id`, different
   * `name`) produces the same `ref`/`id`, only `name` changes.
   */
  test("id stability under rename (fake Jira): re-mapping a renamed component keeps ref/id identical, only name changes", () => {
    const before = mapJiraComponent({ id: "10000", name: "Backend" }, "BUTCHR", "https://butchr.example/components/10000");
    const after = mapJiraComponent({ id: "10000", name: "Backend Services" }, "BUTCHR", "https://butchr.example/components/10000");
    expect(after.ref).toBe(before.ref);
    expect(after.id).toBe(before.id);
    expect(after.name).not.toBe(before.name);
  });
});
