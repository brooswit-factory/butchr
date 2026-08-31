import { describe, expect, test } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { briefFor, interpolate, modelFor, effortFor, buildWorkspace } from "../../src/agents/workspace.js";

describe("briefFor / modelFor", () => {
  test("each type gets its brief; unknown gets default", () => {
    expect(briefFor("Epic")).toContain("You own one outcome");
    expect(briefFor("Story")).toContain("one increment of value");
    expect(briefFor("Task")).toContain("one unit of work");
    expect(briefFor("Bug")).toContain("Read your ticket");
  });
  test("models: epic=opus story=opus task=sonnet, default sonnet", () => {
    expect(modelFor("Epic")).toBe("opus");
    expect(modelFor("Story")).toBe("opus");
    expect(modelFor("Task")).toBe("sonnet");
    expect(modelFor("Whatever")).toBe("sonnet");
  });
  test("effort: epic/story/task all high, unknown type also defaults to high without throwing", () => {
    expect(effortFor("Epic")).toBe("high");
    expect(effortFor("Story")).toBe("high");
    expect(effortFor("Task")).toBe("high");
    expect(() => effortFor("Whatever")).not.toThrow();
    expect(effortFor("Whatever")).toBe("high");
    expect(effortFor("EPIC")).toBe("high");
    expect(effortFor("Story")).toBe("high");
  });
  test("reviewer briefs carry the [review] verdict-line instruction", () => {
    expect(briefFor("Epic")).toContain("[review] APPROVED");
    expect(briefFor("Story")).toContain("[review] APPROVED");
  });
  test("epic and story briefs carry the staffing-activation instruction", () => {
    expect(briefFor("Epic")).toContain("In Progress");
    expect(briefFor("Epic")).toContain("never staffed");
    expect(briefFor("Story")).toContain("In Progress");
    expect(briefFor("Story")).toContain("never staffed");
  });
  test("author briefs carry the two-signal reviewDecision+headRefOid check", () => {
    expect(briefFor("Story")).toContain("reviewDecision,headRefOid");
    expect(briefFor("Task")).toContain("reviewDecision,headRefOid");
  });
  // BUTCHR-38: the relationship-verb rewrite. Guards below protect the
  // load-bearing new instructions so the next rewrite can't silently drop
  // them, the same way the guards above protect the ones before them.
  test("every brief teaches set_doc's replace-not-append semantic", () => {
    for (const t of ["Epic", "Story", "Task", "Bug"]) {
      expect(briefFor(t)).toContain("FULL-BODY REPLACE");
      expect(briefFor(t)).toContain("not an append");
    }
  });
  test("reviewing tiers' checklists reject on doc staleness", () => {
    expect(briefFor("Epic")).toContain("doc actually reflects");
    expect(briefFor("Story")).toContain("doc actually reflects");
  });
  test("the captain's-log convention is fully gone — no title format, no convention link, in any brief", () => {
    for (const t of ["Epic", "Story", "Task", "Bug"]) {
      const brief = briefFor(t);
      expect(brief).not.toContain("Log — ");
      expect(brief.toLowerCase()).not.toContain("captain's log");
      expect(brief).not.toContain("10715137");
    }
  });
  test("epic and story briefs teach the boss-side relationship verbs", () => {
    for (const t of ["Epic", "Story"]) {
      const brief = briefFor(t);
      for (const verb of ["new_worker", "shelve_worker", "adopt_worker", "finish_worker", "prioritize_worker", "tell_worker"]) {
        expect(brief).toContain(verb);
      }
    }
  });
  test("story and task briefs teach the worker-side relationship verbs", () => {
    for (const t of ["Story", "Task"]) {
      const brief = briefFor(t);
      for (const verb of ["report_to_boss", "ask_boss", "submit_to_boss"]) {
        expect(brief).toContain(verb);
      }
    }
  });
  test("every brief points at the ASSIST space", () => {
    for (const t of ["Epic", "Story", "Task", "Bug"]) {
      expect(briefFor(t)).toContain("wiki/spaces/ASSIST");
    }
  });
});
describe("interpolate", () => {
  test("fills key, summary, type, parent; parent-less says so", () => {
    const out = interpolate("k={{KEY}} s={{SUMMARY}} t={{TYPE}} p={{PARENT}}", { key: "K-1", issuetype: "Task", summary: "do it", parent: "K-0" });
    expect(out).toBe("k=K-1 s=do it t=Task p=K-0");
    expect(interpolate("{{PARENT}}", { key: "K", issuetype: "Epic", summary: "s", parent: null })).toContain("top-level");
  });
});
describe("buildWorkspace", () => {
  test("writes CLAUDE.md, interpolated brief.md, and mcp.json with x-issue", () => {
    const root = mkdtempSync(join(tmpdir(), "bw-"));
    process.env.BUTCHR_WORKSPACES = root;
    try {
      const dir = buildWorkspace({ key: "KAN-9", issuetype: "Story", summary: "ship it", parent: "KAN-1" }, "http://x/mcp");
      expect(dir).toBe(join(root, "KAN-9"));
      expect(readFileSync(join(dir, "CLAUDE.md"), "utf8")).toContain("brief.md");
      const brief = readFileSync(join(dir, "brief.md"), "utf8");
      expect(brief).toContain("KAN-9"); expect(brief).toContain("ship it"); expect(brief).toContain("KAN-1");
      const mcp = JSON.parse(readFileSync(join(dir, "mcp.json"), "utf8"));
      expect(mcp.mcpServers.butchr.headers["x-issue"]).toBe("KAN-9");
      expect(mcp.mcpServers.butchr.url).toBe("http://x/mcp");
    } finally { delete process.env.BUTCHR_WORKSPACES; }
  });

  test("writes ENVIRONMENT.md, and CLAUDE.md is interpolated with the same ground truth", () => {
    const root = mkdtempSync(join(tmpdir(), "bw-"));
    process.env.BUTCHR_WORKSPACES = root;
    try {
      const dir = buildWorkspace({ key: "KAN-10", issuetype: "Task", summary: "ship it", parent: "KAN-1" }, "http://localhost:7719/mcp");
      expect(existsSync(join(dir, "ENVIRONMENT.md"))).toBe(true);
      const environment = readFileSync(join(dir, "ENVIRONMENT.md"), "utf8");
      expect(environment).toContain(hostname());
      expect(environment).toContain("journalctl");
      expect(environment).toContain("7719");
      const claudeMd = readFileSync(join(dir, "CLAUDE.md"), "utf8");
      expect(claudeMd).toContain(hostname());
      expect(claudeMd).toContain("journalctl");
      expect(claudeMd).not.toContain("{{GROUND_TRUTH}}");
    } finally { delete process.env.BUTCHR_WORKSPACES; }
  });
});
