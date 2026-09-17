import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { legacyAgentPreflight, legacyAgents } from "../../src/daemon/legacy-preflight.js";
import { ownsRuleAgent } from "../../src/rules/resource-type.js";
import { ownsGithubIssueAgent } from "../../src/rules/github-issue-type.js";
import { ownsZendeskTicketAgent } from "../../src/rules/zendesk-ticket-type.js";

const ROOT = "/w";
const rule = { pane_id: "p1", cwd: "/w/jira-work/triage/BUTCHR-1" };
const zendesk = { pane_id: "p2", cwd: "/w/zendesk-ticket/support/acme%2342" };
const legacy = { pane_id: "p3", cwd: "/w/butchr-7" };
const outside = { pane_id: "p4", cwd: "/home/me/project" };

describe("legacyAgents", () => {
  test("only one-deep workspaces under the root are legacy", () => {
    expect(legacyAgents([rule, zendesk, legacy, outside, { pane_id: "p5", cwd: null }], ROOT)).toEqual([{ id: "BUTCHR-7", pane: "p3", cwd: "/w/butchr-7" }]);
  });
  test("no rule loop owns a legacy agent, which is why startup must refuse", () => {
    const id = legacyAgents([legacy], ROOT)[0]!.id;
    expect([ownsRuleAgent(id), ownsGithubIssueAgent(id), ownsZendeskTicketAgent(id)]).toEqual([false, false, false]);
  });
});

describe("legacyAgentPreflight", () => {
  test("passes with only rule-engine agents, or none", async () => {
    expect(await legacyAgentPreflight(async () => [rule, zendesk, outside], ROOT)).toEqual({ ok: true });
    expect(await legacyAgentPreflight(async () => [], ROOT)).toEqual({ ok: true });
  });

  test("a live legacy agent fails startup, naming it, its pane and the fix", async () => {
    const r = await legacyAgentPreflight(async () => [rule, legacy], ROOT);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain("1 agent(s) still running in legacy flat workspaces under /w. Refusing to start.");
    expect(r.message).toContain("BUTCHR-7: pane p3 in /w/butchr-7");
    expect(r.message).toContain("BUTCHR_MAX_AGENTS");
    expect(r.message).toContain("does not stop or adopt them");
    expect(r.message).toContain("kept on disk");
  });

  test("a failed agent list fails closed rather than reading as none running", async () => {
    const r = await legacyAgentPreflight(async () => { throw new Error("socket missing"); }, ROOT);
    expect(r.ok).toBe(false);
    const message = r.ok ? "" : r.message;
    expect(message).toContain("could not list herdr agents");
    expect(message).toContain("socket missing");
  });

  test("migration: only lists — no stop, no close, and legacy workspace files survive", async () => {
    const root = mkdtempSync(join(tmpdir(), "butchr-legacy-"));
    try {
      const dir = join(root, "BUTCHR-9");
      mkdirSync(dir);
      writeFileSync(join(dir, "brief.md"), "old brief");
      let lists = 0;
      // A herd-shaped stand-in: any call other than the list is a stop/close/spawn this preflight must never make.
      const forbidden = () => { throw new Error("preflight must not change agents"); };
      const herd = { list: async () => { lists++; return [{ pane_id: "p9", cwd: dir }]; }, stop: forbidden, close: forbidden, spawn: forbidden };
      const r = await legacyAgentPreflight(herd.list, root);
      expect(r.ok).toBe(false);
      expect(lists).toBe(1);
      expect(existsSync(join(dir, "brief.md"))).toBe(true);
      expect(readdirSync(root)).toEqual(["BUTCHR-9"]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
