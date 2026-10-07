import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reportPersistedAgentSessions, AGENT_SESSION_REPORT_SOURCE, type ReportAgentSessionsHerdr } from "../../src/agents/report-agent-sessions.js";
import { ensureWorkspaceDir, persistDiscoveredSessionId } from "../../src/agents/workspace.js";
import { encodeAgentKey } from "../../src/rules/agent-key.js";
import type { params, results } from "@brooswit/drovr";

/** A real butchr workspace dir, under a temp root, with a real persisted session id — same shape `.butchr-session-id.json` would be in production. */
function realWorkspaceWithSessionId(root: string, resourceId: string, sessionId: string): string {
  const key = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "managed-sessions", resourceId });
  const dir = ensureWorkspaceDir(key, root);
  persistDiscoveredSessionId(dir, sessionId);
  return dir;
}

const agent = (over: Partial<results.AgentInfo>): results.AgentInfo => ({
  agent: "claude",
  agent_status: "idle",
  focused: false,
  pane_id: "p1",
  revision: 1,
  tab_id: "t1",
  terminal_id: "term1",
  workspace_id: "w1",
  ...over,
});

function fakeHerdr(agents: results.AgentInfo[]): ReportAgentSessionsHerdr & { reports: params.PaneReportAgentSessionParams[] } {
  const reports: params.PaneReportAgentSessionParams[] = [];
  return {
    reports,
    agent: { async list() { return { agents }; } },
    pane: { async reportAgentSession(p) { reports.push(p); return {}; } },
  };
}

describe("reportPersistedAgentSessions (FACTORY-714/FACTORY-713/FACTORY-704 re-aimed)", () => {
  test("a pane with a real persisted session id and no agent_session yet is reported, with the exact herdr:claude shape", async () => {
    const root = mkdtempSync(join(tmpdir(), "report-agent-sessions-"));
    try {
      const dir = realWorkspaceWithSessionId(root, "/defs/buddy.json", "session-buddy-1");
      const herdr = fakeHerdr([agent({ pane_id: "p-buddy", cwd: dir, agent: "claude" })]);

      const result = await reportPersistedAgentSessions({ herdr });

      expect(herdr.reports).toEqual([{ pane_id: "p-buddy", agent: "claude", agent_session_id: "session-buddy-1", source: AGENT_SESSION_REPORT_SOURCE }]);
      expect(result).toEqual({ reported: 1, alreadyRegistered: 0, noPersistedId: 0 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a pane that already carries agent_session is never re-reported", async () => {
    const root = mkdtempSync(join(tmpdir(), "report-agent-sessions-"));
    try {
      const dir = realWorkspaceWithSessionId(root, "/defs/genius.json", "session-genius-1");
      const herdr = fakeHerdr([agent({ pane_id: "p-genius", cwd: dir, agent_session: { agent: "claude", kind: "id", source: "herdr:claude", value: "session-genius-1" } })]);

      const result = await reportPersistedAgentSessions({ herdr });

      expect(herdr.reports).toEqual([]);
      expect(result).toEqual({ reported: 0, alreadyRegistered: 1, noPersistedId: 0 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a pane with no persisted session id (discovery never succeeded) is skipped, counted honestly", async () => {
    const root = mkdtempSync(join(tmpdir(), "report-agent-sessions-"));
    try {
      const key = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "managed-sessions", resourceId: "/defs/plain.json" });
      const dir = ensureWorkspaceDir(key, root); // no persistDiscoveredSessionId call — no .butchr-session-id.json
      const herdr = fakeHerdr([agent({ pane_id: "p-plain", cwd: dir })]);

      const result = await reportPersistedAgentSessions({ herdr });

      expect(herdr.reports).toEqual([]);
      expect(result).toEqual({ reported: 0, alreadyRegistered: 0, noPersistedId: 1 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a pane with no cwd at all is skipped, counted as no-persisted-id (nothing to read)", async () => {
    const herdr = fakeHerdr([agent({ pane_id: "p-nocwd" })]);
    const result = await reportPersistedAgentSessions({ herdr });
    expect(herdr.reports).toEqual([]);
    expect(result).toEqual({ reported: 0, alreadyRegistered: 0, noPersistedId: 1 });
  });

  // FACTORY-491's own launch_pending discriminator — see this module's doc
  // comment for why a still-launching pane must never be reported: its
  // persisted id (if any) could be a stale leftover from a previous
  // occupant of the same workspace, not yet corrected by this launch's own
  // discovery.
  test("a still-launching pane (launch_pending) is skipped entirely, not counted at all", async () => {
    const root = mkdtempSync(join(tmpdir(), "report-agent-sessions-"));
    try {
      const dir = realWorkspaceWithSessionId(root, "/defs/pending.json", "stale-session-id");
      const herdr = fakeHerdr([agent({ pane_id: "p-pending", cwd: dir, launch_pending: true })]);

      const result = await reportPersistedAgentSessions({ herdr });

      expect(herdr.reports).toEqual([]);
      expect(result).toEqual({ reported: 0, alreadyRegistered: 0, noPersistedId: 0 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a per-pane report failure is swallowed and logged, never thrown, and never blocks a later pane's report", async () => {
    const root = mkdtempSync(join(tmpdir(), "report-agent-sessions-"));
    try {
      const dirA = realWorkspaceWithSessionId(root, "/defs/fails.json", "session-fails");
      const dirB = realWorkspaceWithSessionId(root, "/defs/succeeds.json", "session-succeeds");
      const reports: params.PaneReportAgentSessionParams[] = [];
      const herdr: ReportAgentSessionsHerdr = {
        agent: { async list() { return { agents: [agent({ pane_id: "p-fails", cwd: dirA }), agent({ pane_id: "p-succeeds", cwd: dirB })] }; } },
        pane: {
          async reportAgentSession(p) {
            if (p.pane_id === "p-fails") throw new Error("herdr socket hiccup");
            reports.push(p);
            return {};
          },
        },
      };
      const logs: string[] = [];

      const result = await expect(reportPersistedAgentSessions({ herdr, log: (l) => logs.push(l) })).resolves.toEqual({ reported: 1, alreadyRegistered: 0, noPersistedId: 0 });
      void result;

      expect(reports).toEqual([{ pane_id: "p-succeeds", agent: "claude", agent_session_id: "session-succeeds", source: AGENT_SESSION_REPORT_SOURCE }]);
      expect(logs.some((l) => l.includes("WARNING") && l.includes("p-fails") && l.includes("herdr socket hiccup"))).toBe(true);
      expect(logs).toContain("[agent-session-report] 1 reported, 0 already registered, 0 with no persisted id");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // PR #676 review round 1 (BLOCKING): `herdr.agent.list()` rejecting used
  // to be an unhandled promise rejection — this function is called `void`
  // fire-and-forget at daemon startup (src/daemon/index.ts) specifically
  // because it is documented to never throw, and startup is exactly when
  // herdr is least likely to be fully ready yet.
  test("herdr.agent.list() rejecting is caught, logged, and returns the zeroed result — never throws", async () => {
    const herdr: ReportAgentSessionsHerdr = {
      agent: { async list() { throw new Error("herdr not ready yet"); } },
      pane: { async reportAgentSession() { return {}; } },
    };
    const logs: string[] = [];

    const result = await reportPersistedAgentSessions({ herdr, log: (l) => logs.push(l) });

    expect(result).toEqual({ reported: 0, alreadyRegistered: 0, noPersistedId: 0 });
    expect(logs.some((l) => l.includes("WARNING") && l.includes("herdr not ready yet"))).toBe(true);
  });

  test("a mix of all shapes in one sweep produces the truthful summary log line", async () => {
    const root = mkdtempSync(join(tmpdir(), "report-agent-sessions-"));
    try {
      const reportedDir = realWorkspaceWithSessionId(root, "/defs/a.json", "sid-a");
      const registeredDir = realWorkspaceWithSessionId(root, "/defs/b.json", "sid-b");
      const noIdKey = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "managed-sessions", resourceId: "/defs/c.json" });
      const noIdDir = ensureWorkspaceDir(noIdKey, root);
      const herdr = fakeHerdr([
        agent({ pane_id: "p-a", cwd: reportedDir }),
        agent({ pane_id: "p-b", cwd: registeredDir, agent_session: { agent: "claude", kind: "id", source: "herdr:claude", value: "sid-b" } }),
        agent({ pane_id: "p-c", cwd: noIdDir }),
      ]);
      const logs: string[] = [];

      const result = await reportPersistedAgentSessions({ herdr, log: (l) => logs.push(l) });

      expect(result).toEqual({ reported: 1, alreadyRegistered: 1, noPersistedId: 1 });
      expect(logs).toContain("[agent-session-report] 1 reported, 1 already registered, 1 with no persisted id");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
