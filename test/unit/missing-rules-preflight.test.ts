import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { missingRulesPreflight } from "../../src/daemon/missing-rules-preflight.js";
import { ensureWorkspaceDir } from "../../src/agents/workspace.js";
import { encodeAgentKey } from "../../src/rules/agent-key.js";

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

  // FACTORY-118 Addendum A5 / the story's own explicit ask (a caller this
  // ticket's own list of `ruleAgentIdOfWorkspacePath` callers had initially
  // missed): a rule agent already migrated to its new SHORT-leaf directory
  // must be recognised here exactly like an old-layout one — a fail-OPEN
  // regression (this preflight wrongly reporting "no live rule agents")
  // would let the daemon start and then stop/respawn EVERY rule agent on
  // the very first poll, the FACTORY-47 class of bug in a new place.
  test("a rule agent already migrated to its new short-leaf directory is still recognised as live (Addendum A5 fail-open guard)", async () => {
    const root = mkdtempSync(join(tmpdir(), "missing-rules-shortleaf-"));
    try {
      // github-issue's short id (owner dropped) makes this a REAL rename,
      // unlike an identity-short-id provider (jira-work/jira-idea/jira-project).
      const key = encodeAgentKey({ resourceProvider: "github-issue", ruleId: "bugs", resourceId: "acme/widgets#12" });
      const cwd = ensureWorkspaceDir(key, root); // real, stamped claim — matches a genuinely running agent
      expect(cwd.endsWith("/github-issue/bugs/widgets#12")).toBe(true);
      const r = await missingRulesPreflight("/x/butchr/rules.json", list([{ pane_id: "w1:p1", cwd }]), root);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.message).toContain("1 rule agent(s) are running");
      expect(r.message).toContain(`${key}: pane w1:p1`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a failed herdr list fails closed: could not check is not none running", async () => {
    const r = await missingRulesPreflight("/x/butchr/rules.json", async () => { throw new Error("socket gone"); }, root);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("could not list herdr agents to check for live rule agents: socket gone");
  });
});
