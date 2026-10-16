import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { encodeAgentKey, decodeAgentKey, decodeAnyAgentKey } from "../../src/rules/agent-key.js";
import { ownsJiraComponentAgent, jiraComponentShortDisplayId } from "../../src/rules/jira-component-type.js";

const KEY = encodeAgentKey({ resourceProvider: "jira-component", ruleId: "managers", resourceId: "BUTCHR:10000" });

describe("ownsJiraComponentAgent", () => {
  test("true for a jira-component agent key", () => {
    expect(ownsJiraComponentAgent(KEY)).toBe(true);
  });

  test("false for other providers' agent keys, and for garbage", () => {
    expect(ownsJiraComponentAgent(encodeAgentKey({ resourceProvider: "jira-project", ruleId: "managers", resourceId: "BUTCHR" }))).toBe(false);
    expect(ownsJiraComponentAgent(encodeAgentKey({ resourceProvider: "jira-work", ruleId: "triage", resourceId: "BUTCHR-1" }))).toBe(false);
    expect(ownsJiraComponentAgent("not a key at all")).toBe(false);
  });
});

describe("jiraComponentShortDisplayId", () => {
  test("is the identity function — the native `<PROJECT>:<id>` id is already the short form", () => {
    expect(jiraComponentShortDisplayId("BUTCHR:10000")).toBe("BUTCHR:10000");
  });
});

/**
 * FACTORY-986 scope item (c): resident-agent identity (workspace dir, agent
 * key) for `jira-component` carries the SAME shape every other provider's
 * does — derived generically from `ref` via `encodeAgentKey`/`decodeAgentKey`,
 * never a bespoke mechanism (see jira-component.ts's own header).
 */
describe("resident-agent identity shape parity with other providers", () => {
  test("encodeAgentKey/decodeAgentKey round-trip a jira-component resource id exactly like every other provider", () => {
    const parts = { resourceProvider: "jira-component" as const, ruleId: "managers", resourceId: "BUTCHR:10000" };
    const key = encodeAgentKey(parts);
    expect(key).toBe(KEY);
    expect(decodeAgentKey(key)).toEqual(parts);
    expect(decodeAnyAgentKey(key)).toEqual({ kind: "resource", ...parts });
  });

  test("rejects a malformed jira-component resource id the same way every other provider's bad id is rejected", () => {
    expect(() => encodeAgentKey({ resourceProvider: "jira-component", ruleId: "managers", resourceId: "not-a-component-ref" })).toThrow();
    expect(decodeAgentKey("jira-component:managers:not-a-component-ref")).toBeNull();
  });
});

/**
 * FACTORY-986 scope item (d)/(e): registering `jira-component` in
 * `RESOURCE_PROVIDERS` must not, by itself, make any agent spawnable — this
 * story adds no `ResourceType<T>`, no discovery/selector, and no
 * `runResourceLoop` wiring. Proven by grepping the one place spawn wiring
 * would have to live (`src/daemon/`) for any mention of the provider at
 * all — the same kind of structural, can't-be-faked-by-a-stub proof
 * `jira-component-type.ts`'s own header promises.
 */
describe("no agent spawns from the jira-component provider (inert scaffolding only)", () => {
  function allDaemonSource(): string {
    const dir = join(import.meta.dir, "../../src/daemon");
    return readdirSync(dir, { recursive: true } as any)
      .filter((f): f is string => typeof f === "string" && f.endsWith(".ts"))
      .map((f) => readFileSync(join(dir, f), "utf8"))
      .join("\n");
  }

  test("no file under src/daemon/ references the jira-component provider", () => {
    expect(allDaemonSource()).not.toContain("jira-component");
  });

  test("no rules.json change is required to register the provider: RESOURCE_PROVIDERS membership alone does not make a rule referencing it load any resource type or spawn config", () => {
    // jira-component-type.ts exports exactly its two identity helpers —
    // no ResourceType/spawnConfig/discovery export exists to wire up.
    const mod: Record<string, unknown> = require("../../src/rules/jira-component-type.js");
    const exportNames = Object.keys(mod).sort();
    expect(exportNames).toEqual(["jiraComponentShortDisplayId", "ownsJiraComponentAgent"]);
  });
});
