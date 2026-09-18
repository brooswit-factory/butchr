import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { missingRulesPreflight } from "../../src/daemon/missing-rules-preflight.js";

const root = "/ws";
const list = (agents: { pane_id?: string; cwd?: string }[]) => async () => agents;

describe("missingRulesPreflight", () => {
  test("no rules file and no rule agents running: start as before (zero rules, nothing staffed)", async () => {
    expect(await missingRulesPreflight("/x/butchr/rules.json", list([]), root)).toEqual({ ok: true });
    // a legacy flat workspace and an unrelated pane are not rule agents
    expect(await missingRulesPreflight("/x/butchr/rules.json", list([{ pane_id: "w1:p1", cwd: join(root, "BUTCHR-1") }, { pane_id: "w2:p1", cwd: "/home/me/code" }]), root)).toEqual({ ok: true });
  });

  test("no rules file while rule agents run: refuse, naming each agent and the missing path, instead of stopping the fleet", async () => {
    const r = await missingRulesPreflight("/x/butchr/rules.json", list([
      { pane_id: "w1:p1", cwd: join(root, "jira-work", "tasks", "BUTCHR-7") },
      { pane_id: "w2:p1", cwd: join(root, "github-issue", "gh", "o%2Fr%233") },
      { pane_id: "w3:p1", cwd: join(root, "BUTCHR-1") },
    ]), root);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain("no rules file at /x/butchr/rules.json, but 2 rule agent(s) are running. Refusing to start.");
    expect(r.message).toContain("jira-work:tasks:BUTCHR-7: pane w1:p1");
    expect(r.message).toContain("pane w2:p1");
    expect(r.message).not.toContain("BUTCHR-1:");
  });

  test("a failed herdr list fails closed: could not check is not none running", async () => {
    const r = await missingRulesPreflight("/x/butchr/rules.json", async () => { throw new Error("socket gone"); }, root);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("could not list herdr agents to check for live rule agents: socket gone");
  });
});
