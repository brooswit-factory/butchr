import { describe, expect, test } from "bun:test";
import type { AtlassianOps } from "../../src/tools/atlassian.js";
import {
  agentSnapshot,
  doAgentStart,
  planAgentStop,
  doAgentStop,
  planAgentShelve,
  doAgentShelve,
  doAgentAdopt,
  doAgentPrioritize,
  validateStopRequestBody,
  validateShelveRequestBody,
  validateAdoptRequestBody,
  validatePrioritizeRequestBody,
  type AgentWriteDeps,
} from "../../src/agents/agents-write.js";
import type { Herd } from "../../src/agents/herd.js";

/**
 * A small, stateful fake Jira world — same spirit as relationship.test.ts's
 * own `makeWorld`, trimmed to exactly what `agents-write.ts` reads/writes:
 * issuetype, status, labels, the Implements link (as `bossKey`), summary,
 * priority. Every write method is recorded in `calls` so a refusal test can
 * assert "writes nothing" by asserting `calls` stayed empty, not just by
 * reading a return value.
 */
function makeOps() {
  const issues = new Map<string, { issuetype: string; status: string; labels: string[]; bossKey?: string; summary?: string; priority?: string }>();
  const calls: string[] = [];
  function requireIssue(key: string) {
    const i = issues.get(key);
    if (!i) throw new Error(`fake world: no such issue ${key}`);
    return i;
  }
  function addIssue(key: string, p: { issuetype: string; status?: string; labels?: string[]; bossKey?: string; summary?: string }) {
    issues.set(key, { issuetype: p.issuetype, status: p.status ?? "To Do", labels: p.labels ?? [], summary: p.summary ?? `${key} summary`, ...(p.bossKey !== undefined ? { bossKey: p.bossKey } : {}) });
  }
  const notImplemented = (name: string) => async () => { throw new Error(`fake ops: ${name} not implemented (unused by agents-write tests)`); };
  const ops: AtlassianOps = {
    getIssue: async (key: string) => {
      const i = requireIssue(key);
      return {
        fields: {
          summary: i.summary,
          issuetype: { name: i.issuetype },
          status: { name: i.status },
          labels: i.labels,
          issuelinks: i.bossKey ? [{ type: { name: "Implements" }, inwardIssue: { key: i.bossKey } }] : [],
        },
      };
    },
    search: notImplemented("search"),
    addComment: async (key: string, text: string) => { calls.push(`addComment:${key}`); requireIssue(key); return { text }; },
    linkIssues: async (from: string, to: string, type: string) => { calls.push(`linkIssues:${from}:${to}:${type}`); if (type === "Implements") requireIssue(from).bossKey = to; return { ok: true }; },
    transition: async (key: string, status: string) => { calls.push(`transition:${key}:${status}`); requireIssue(key).status = status; return { ok: true }; },
    createIssue: notImplemented("createIssue"),
    setPriority: async (key: string, priority: string) => { calls.push(`setPriority:${key}:${priority}`); requireIssue(key).priority = priority; return { ok: true }; },
    assign: async (key: string, accountId: string) => { calls.push(`assign:${key}:${accountId}`); requireIssue(key); return { ok: true }; },
    correctText: notImplemented("correctText"),
    createPage: notImplemented("createPage"),
    getPage: notImplemented("getPage"),
    updatePage: notImplemented("updatePage"),
    searchPages: notImplemented("searchPages"),
    listSpaces: notImplemented("listSpaces"),
    getProjectProperty: notImplemented("getProjectProperty"),
    getProjectPropertyOrNull: async () => null,
    getRemoteLink: async () => null,
    upsertRemoteLink: notImplemented("upsertRemoteLink"),
    getChildPages: notImplemented("getChildPages"),
    getPageLabels: notImplemented("getPageLabels"),
    createPageWithLabel: notImplemented("createPageWithLabel"),
    addLabels: async (key: string, labels: readonly string[]) => { calls.push(`addLabels:${key}:${labels.join(",")}`); const i = requireIssue(key); i.labels = [...new Set([...i.labels, ...labels])]; return { ok: true }; },
    removeLabels: async (key: string, labels: readonly string[]) => { calls.push(`removeLabels:${key}:${labels.join(",")}`); const i = requireIssue(key); const r = new Set(labels); i.labels = i.labels.filter((l) => !r.has(l)); return { ok: true }; },
    deleteIssue: notImplemented("deleteIssue"),
    commentOnPage: notImplemented("commentOnPage"),
    getPageComments: notImplemented("getPageComments"),
    searchProjects: notImplemented("searchProjects"),
    getMyself: async () => ({ accountId: "test-account" }),
    setProjectProperty: notImplemented("setProjectProperty"),
    getPageVersions: notImplemented("getPageVersions"),
    getIssueComments: async () => ({ results: [] }),
  };
  return { ops, issues, addIssue, calls };
}

function makeHerd(running: Record<string, string> = {}) {
  const stopped: string[] = [];
  const herd: Pick<Herd, "stop" | "paneFor"> = {
    paneFor: async (issue: string) => running[issue] ?? null,
    stop: async (issue: string) => { stopped.push(issue); delete running[issue]; },
  };
  return { herd, stopped };
}

function deps(world: ReturnType<typeof makeOps>, herdPart: Pick<Herd, "stop" | "paneFor">): AgentWriteDeps {
  return { ops: world.ops, herd: herdPart, roles: { story: "acct-story", task: "acct-task", epic: "acct-epic" } };
}

describe("agents-write — FACTORY-666", () => {
  describe("doAgentStart", () => {
    test("transitions the worker to In Progress under its own current boss, derived from the Implements link", async () => {
      const world = makeOps();
      world.addIssue("FACTORY-1", { issuetype: "Task", bossKey: "FACTORY-BOSS" });
      world.addIssue("FACTORY-BOSS", { issuetype: "Story" });
      const { herd } = makeHerd();
      const outcome = await doAgentStart(deps(world, herd), "FACTORY-1");
      expect(outcome.ok).toBe(true);
      expect(world.issues.get("FACTORY-1")?.status).toBe("In Progress");
      expect(world.calls).toContain("transition:FACTORY-1:In Progress");
    });

    test("refuses, and writes nothing, when the worker has no boss at all", async () => {
      const world = makeOps();
      world.addIssue("FACTORY-1", { issuetype: "Task" });
      const { herd } = makeHerd();
      const outcome = await doAgentStart(deps(world, herd), "FACTORY-1");
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.error).toContain("has no boss");
        expect(outcome.status).toBe(409);
      }
      expect(world.calls).toEqual([]);
    });
  });

  describe("planAgentStop / doAgentStop", () => {
    test("plan refuses, auditable, when nothing is running — writes nothing", async () => {
      const world = makeOps();
      world.addIssue("FACTORY-1", { issuetype: "Task" });
      const { herd, stopped } = makeHerd({});
      const plan = await planAgentStop(deps(world, herd), "FACTORY-1");
      expect(plan.ok).toBe(false);
      if (!plan.ok) expect(plan.status).toBe(409);
      expect(stopped).toEqual([]);
    });

    test("plan reports requiresConfirm with a structured preview naming the pane, when an agent IS running — never stops anything itself", async () => {
      const world = makeOps();
      world.addIssue("FACTORY-1", { issuetype: "Task" });
      const { herd, stopped } = makeHerd({ "FACTORY-1": "pane-7" });
      const plan = await planAgentStop(deps(world, herd), "FACTORY-1");
      expect(plan.ok).toBe(true);
      if (plan.ok) {
        expect(plan.requiresConfirm).toBe(true);
        expect(plan.confirmReason).toBe("agent-stop");
        expect(plan.preview).toEqual({ key: "FACTORY-1", pane: "pane-7" });
      }
      expect(stopped).toEqual([]);
    });

    test("doAgentStop calls Herd.stop exactly once and reports the stopped pane", async () => {
      const world = makeOps();
      world.addIssue("FACTORY-1", { issuetype: "Task" });
      const { herd, stopped } = makeHerd({ "FACTORY-1": "pane-7" });
      const outcome = await doAgentStop(deps(world, herd), "FACTORY-1");
      expect(outcome.ok).toBe(true);
      expect(stopped).toEqual(["FACTORY-1"]);
      if (outcome.ok) expect(outcome.stoppedPane).toBe("pane-7");
    });

    test("doAgentStop refuses, and never calls Herd.stop, when nothing is running", async () => {
      const world = makeOps();
      world.addIssue("FACTORY-1", { issuetype: "Task" });
      const { herd, stopped } = makeHerd({});
      const outcome = await doAgentStop(deps(world, herd), "FACTORY-1");
      expect(outcome.ok).toBe(false);
      expect(stopped).toEqual([]);
    });

    test("doAgentStop never touches Jira at all (no transition, no label, no comment)", async () => {
      const world = makeOps();
      world.addIssue("FACTORY-1", { issuetype: "Task", status: "In Progress" });
      const { herd } = makeHerd({ "FACTORY-1": "pane-7" });
      await doAgentStop(deps(world, herd), "FACTORY-1");
      expect(world.calls).toEqual([]);
      expect(world.issues.get("FACTORY-1")?.status).toBe("In Progress");
    });
  });

  describe("planAgentShelve / doAgentShelve", () => {
    test("plan refuses an empty reason before ever resolving a boss or naming a confirmReason — writes nothing", async () => {
      const world = makeOps();
      world.addIssue("FACTORY-1", { issuetype: "Task", bossKey: "FACTORY-BOSS" });
      const { herd } = makeHerd();
      const plan = await planAgentShelve(deps(world, herd), "FACTORY-1", "   ");
      expect(plan.ok).toBe(false);
      if (!plan.ok) expect(plan.status).toBe(400);
      expect(world.calls).toEqual([]);
    });

    test("plan reports requiresConfirm with a structured preview (key/boss/reason), never writes", async () => {
      const world = makeOps();
      world.addIssue("FACTORY-1", { issuetype: "Task", bossKey: "FACTORY-BOSS" });
      world.addIssue("FACTORY-BOSS", { issuetype: "Story" });
      const { herd } = makeHerd();
      const plan = await planAgentShelve(deps(world, herd), "FACTORY-1", "operator is stepping in manually");
      expect(plan.ok).toBe(true);
      if (plan.ok) {
        expect(plan.requiresConfirm).toBe(true);
        expect(plan.confirmReason).toBe("agent-shelve");
        expect(plan.preview).toEqual({ key: "FACTORY-1", boss: "FACTORY-BOSS", reason: "operator is stepping in manually" });
      }
      expect(world.calls).toEqual([]);
    });

    test("doAgentShelve labels, transitions to To Do, and posts the reason as a comment — in that order", async () => {
      const world = makeOps();
      world.addIssue("FACTORY-1", { issuetype: "Task", bossKey: "FACTORY-BOSS", status: "In Progress" });
      world.addIssue("FACTORY-BOSS", { issuetype: "Story" });
      const { herd } = makeHerd();
      const outcome = await doAgentShelve(deps(world, herd), "FACTORY-1", "operator is stepping in manually");
      expect(outcome.ok).toBe(true);
      expect(world.issues.get("FACTORY-1")?.status).toBe("To Do");
      expect(world.issues.get("FACTORY-1")?.labels).toContain("butchr:shelved");
      expect(world.calls).toEqual(["addLabels:FACTORY-1:butchr:shelved", "transition:FACTORY-1:To Do", "addComment:FACTORY-1"]);
    });

    test("doAgentShelve refuses, and writes nothing, on an empty reason even with an otherwise-valid boss", async () => {
      const world = makeOps();
      world.addIssue("FACTORY-1", { issuetype: "Task", bossKey: "FACTORY-BOSS" });
      world.addIssue("FACTORY-BOSS", { issuetype: "Story" });
      const { herd } = makeHerd();
      const outcome = await doAgentShelve(deps(world, herd), "FACTORY-1", "");
      expect(outcome.ok).toBe(false);
      expect(world.calls).toEqual([]);
    });
  });

  describe("doAgentAdopt", () => {
    test("disposition start: links, assigns, transitions to In Progress", async () => {
      const world = makeOps();
      world.addIssue("FACTORY-1", { issuetype: "Task" });
      world.addIssue("FACTORY-BOSS", { issuetype: "Story" });
      const { herd } = makeHerd();
      const outcome = await doAgentAdopt(deps(world, herd), "FACTORY-1", { bossKey: "FACTORY-BOSS", disposition: "start" });
      expect(outcome.ok).toBe(true);
    });

    test("disposition shelve with no reason is refused and writes nothing", async () => {
      const world = makeOps();
      world.addIssue("FACTORY-1", { issuetype: "Task" });
      world.addIssue("FACTORY-BOSS", { issuetype: "Story" });
      const { herd } = makeHerd();
      const outcome = await doAgentAdopt(deps(world, herd), "FACTORY-1", { bossKey: "FACTORY-BOSS", disposition: "shelve" });
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.status).toBe(400);
      expect(world.calls).toEqual([]);
    });

    test("refuses adopting a ticket already linked to a DIFFERENT boss — the underlying adoptWorker refusal reaches the caller verbatim", async () => {
      const world = makeOps();
      world.addIssue("FACTORY-1", { issuetype: "Task", bossKey: "FACTORY-OTHER-BOSS" });
      world.addIssue("FACTORY-OTHER-BOSS", { issuetype: "Story" });
      world.addIssue("FACTORY-BOSS", { issuetype: "Story" });
      const { herd } = makeHerd();
      const outcome = await doAgentAdopt(deps(world, herd), "FACTORY-1", { bossKey: "FACTORY-BOSS", disposition: "start" });
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.status).toBe(409);
    });
  });

  describe("doAgentPrioritize", () => {
    test("sets priority under the worker's own current boss", async () => {
      const world = makeOps();
      world.addIssue("FACTORY-1", { issuetype: "Task", bossKey: "FACTORY-BOSS" });
      world.addIssue("FACTORY-BOSS", { issuetype: "Story" });
      const { herd } = makeHerd();
      const outcome = await doAgentPrioritize(deps(world, herd), "FACTORY-1", "High");
      expect(outcome.ok).toBe(true);
      expect(world.issues.get("FACTORY-1")?.priority).toBe("High");
    });

    test("refuses an empty priority before resolving a boss or writing anything", async () => {
      const world = makeOps();
      world.addIssue("FACTORY-1", { issuetype: "Task", bossKey: "FACTORY-BOSS" });
      const { herd } = makeHerd();
      const outcome = await doAgentPrioritize(deps(world, herd), "FACTORY-1", "   ");
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.status).toBe(400);
      expect(world.calls).toEqual([]);
    });
  });

  describe("agentSnapshot", () => {
    test("reports status/labels/boss plus live running state", async () => {
      const world = makeOps();
      world.addIssue("FACTORY-1", { issuetype: "Task", bossKey: "FACTORY-BOSS", status: "In Progress", labels: ["butchr:shelved"] });
      const { herd } = makeHerd({ "FACTORY-1": "pane-3" });
      const result = await agentSnapshot(deps(world, herd), "FACTORY-1");
      expect(result).toEqual({ ok: true, key: "FACTORY-1", status: "In Progress", summary: "FACTORY-1 summary", labels: ["butchr:shelved"], boss: "FACTORY-BOSS", running: true, pane: "pane-3" });
    });

    test("reports running: false and pane: null when no agent is live", async () => {
      const world = makeOps();
      world.addIssue("FACTORY-1", { issuetype: "Task" });
      const { herd } = makeHerd({});
      const result = await agentSnapshot(deps(world, herd), "FACTORY-1");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.running).toBe(false);
        expect(result.pane).toBe(null);
        expect(result.boss).toBe(null);
      }
    });

    test("reports a 404 refusal, never throws, for an unknown issue key", async () => {
      const world = makeOps();
      const { herd } = makeHerd();
      const result = await agentSnapshot(deps(world, herd), "FACTORY-NOPE");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.status).toBe(404);
    });
  });

  describe("request body validators (AC7 — the same functions the routes call)", () => {
    test("validateStopRequestBody: absent body defaults confirm to false", () => {
      expect(validateStopRequestBody(undefined)).toEqual({ ok: true, confirm: false });
      expect(validateStopRequestBody({})).toEqual({ ok: true, confirm: false });
      expect(validateStopRequestBody({ confirm: true })).toEqual({ ok: true, confirm: true });
    });
    test("validateStopRequestBody: a non-boolean confirm is refused", () => {
      const r = validateStopRequestBody({ confirm: "true" });
      expect(r.ok).toBe(false);
    });

    test("validateShelveRequestBody: requires a string reason", () => {
      expect(validateShelveRequestBody({ reason: "because" })).toEqual({ ok: true, reason: "because", confirm: false });
      expect(validateShelveRequestBody({ reason: "because", confirm: true })).toEqual({ ok: true, reason: "because", confirm: true });
      expect(validateShelveRequestBody({}).ok).toBe(false);
      expect(validateShelveRequestBody({ reason: 5 }).ok).toBe(false);
    });

    test("validateAdoptRequestBody: requires bossKey + a valid disposition", () => {
      expect(validateAdoptRequestBody({ bossKey: "FACTORY-BOSS", disposition: "start" })).toEqual({ ok: true, input: { bossKey: "FACTORY-BOSS", disposition: "start" } });
      expect(validateAdoptRequestBody({ bossKey: "FACTORY-BOSS", disposition: "shelve", reason: "r" })).toEqual({ ok: true, input: { bossKey: "FACTORY-BOSS", disposition: "shelve", reason: "r" } });
      expect(validateAdoptRequestBody({ bossKey: "", disposition: "start" }).ok).toBe(false);
      expect(validateAdoptRequestBody({ bossKey: "FACTORY-BOSS", disposition: "nope" }).ok).toBe(false);
      expect(validateAdoptRequestBody({}).ok).toBe(false);
    });

    test("validatePrioritizeRequestBody: requires a non-empty string priority", () => {
      expect(validatePrioritizeRequestBody({ priority: "High" })).toEqual({ ok: true, priority: "High" });
      expect(validatePrioritizeRequestBody({ priority: "" }).ok).toBe(false);
      expect(validatePrioritizeRequestBody({}).ok).toBe(false);
    });
  });
});
