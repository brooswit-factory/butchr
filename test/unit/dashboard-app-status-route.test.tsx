/**
 * local/ui — the Status page (health, the log tail, Reload and Restart) and
 * the Agents page it links to, against fixtures; plus the shell's handling of
 * links to the daemon's own pages.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { withDom } from "../setup/happy-dom.js";
import { MemoryRouter } from "react-router";
import { StatusRoute } from "../../dashboard-app/src/routes/StatusRoute.js";
import { AgentsRoute } from "../../dashboard-app/src/routes/AgentsRoute.js";
import { App } from "../../dashboard-app/src/App.js";
import { RulesTargetingRoute } from "../../dashboard-app/src/routes/RulesTargetingRoute.js";
import { createFixturesRulesApi } from "../../dashboard-app/src/api/rules.js";
import { createFixturesSetupApi } from "../../dashboard-app/src/api/setup.js";
import { createFixturesDaemonApi } from "../../dashboard-app/src/api/daemon.js";
import { createFixturesSettingsApi, type SettingsApi } from "../../dashboard-app/src/api/settings.js";
import type { AgentsApi, AgentSnapshot } from "../../dashboard-app/src/api/agents.js";
import { jiraTicketOf } from "../../dashboard-app/src/components/agents/AgentActions.js";
import { agentsText, buildText, durationText, loopSummary, upstreamText, uptimeText } from "../../dashboard-app/src/view-model/status-view.js";
import { logSourceText } from "../../dashboard-app/src/components/status/LogsCard.js";
import type { HealthStatus } from "../../src/daemon/health.js";

withDom();
afterEach(cleanup);

const STARTED = "2026-10-16T15:00:00.000Z";
const BASE = { ref: "refs/remotes/origin/main", sha: "b".repeat(40), changedAt: null, changedAtUnknownReason: null, fetchedAt: null } as never;

const HEALTH: HealthStatus = {
  ok: true,
  components: [{ name: "pollLoop", ok: true, state: "ok", lastSuccessAt: STARTED, staleForMs: 0 }],
  build: { sha: "60f638c98545cf84ef3ccc91a4eb99a321c50dcf", shaProvenance: "git-at-start", shaDirty: false, shaUnknownReason: null, version: "4.1.0+43", versionProvenance: "package-json", versionUnknownReason: null, startedAt: STARTED, pid: 80749, unit: "com.example.butchr", journalctl: 'tail -n 200 -f "/Users/you/Library/Logs/butchr.log"' },
  currency: { checkedAt: STARTED, verdict: { status: "stale", commitsBehind: 0, commitsAhead: 43, base: BASE, dirtyUndeterminable: false } },
  admission: { cap: 8, residency: 1, sentinels: 0, longestWait: null },
  resourceLoops: [
    { name: "trello-card", ok: true, state: "ok", lastSuccessAt: STARTED, staleForMs: 0, enabled: true, consecutiveFailures: 0, lastError: null },
    { name: "zendesk-ticket", ok: true, state: "ok", lastSuccessAt: STARTED, staleForMs: 0, enabled: false, disabledReason: "no enabled zendesk-ticket rules", consecutiveFailures: 0, lastError: null },
  ],
};

const DASHBOARD = {
  checked: true,
  confirmedAt: STARTED,
  rows: [{ kind: "agent", resourceKey: "jira-work:ui-first-rule:KAN-3020", tier: { kind: "issue", issuetype: { checked: true, value: "Task" } }, agentStatus: "idle", pane: "wF:p1", timeInStatus: { sinceMs: 0, since: STARTED, humanDuration: "17m", exact: true }, confirmedAt: STARTED }],
  admission: { cap: 8, residency: 1, sentinels: 0, sources: [{ source: "issue", census: { checked: true, confirmedAt: STARTED } }] },
};

function serve() {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = url === "/health" ? HEALTH : url === "/dashboard" ? DASHBOARD : null;
    if (!body) throw new Error(`unexpected fetch: ${url}`);
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

const AGENT = "jira-work:ui-first-rule:KAN-3020";

/** An agents API that records every call; `boss` is what each ticket's snapshot says its boss is. */
function recordingAgents(boss: string | null = null) {
  const calls: unknown[][] = [];
  const snapshot = (key: string): AgentSnapshot => ({ key, status: "To Do", summary: "Fix login", labels: [], boss, running: false, pane: null });
  const api: AgentsApi = {
    getSnapshot: async (issue) => { calls.push(["snapshot", issue]); return snapshot(issue); },
    start: async (issue) => { calls.push(["start", issue]); return { ok: true }; },
    stop: async (issue, confirm) => {
      calls.push(["stop", issue, confirm]);
      return confirm ? { key: issue, stoppedPane: "wF:p1", note: "it may be respawned" } : { requiresConfirm: true, confirmReason: "agent-stop", preview: { key: issue, pane: "wF:p1", note: "closes the pane only" } };
    },
    adopt: async (issue, input) => { calls.push(["adopt", issue, input]); return { ok: true }; },
    prioritize: async (issue, priority) => { calls.push(["prioritize", issue, priority]); return { ok: true }; },
  };
  return { api, calls };
}
const idleAgents = recordingAgents().api;

function setText(input: HTMLElement, value: string) {
  fireEvent.input(input, { target: { value } });
  fireEvent.change(input, { target: { value } });
}

describe("Status page", () => {
  test("butchr's health and build, how many agents run (linking to the Agents page), and its log", async () => {
    serve();
    const view = render(<StatusRoute daemonApi={createFixturesDaemonApi()} settingsApi={createFixturesSettingsApi()} />);
    const health = within(await view.findByTestId("status-health"));
    expect(health.getByRole("heading", { level: 2 }).textContent).toBe("Healthy");
    expect(health.getByTestId("status-build").textContent).toContain("60f638c9");
    expect(health.getByTestId("status-upstream").textContent).toBe("43 commits ahead of origin/main");
    expect(health.getByTestId("status-components").textContent).toContain("Ticket poll");
    expect(health.getByTestId("status-components").textContent).toContain("trello-card rules");
    expect(health.getByTestId("status-loops-off").textContent).toContain("zendesk-ticket: no enabled zendesk-ticket rules");
    expect(health.getByTestId("status-agent-count").textContent).toBe("1 of 8 slots in use · View agents");
    expect(health.getByRole("link", { name: "View agents" }).getAttribute("href")).toBe("/agents");
    await waitFor(() => expect(view.getByTestId("daemon-logs-lines")).toBeTruthy());
    expect(view.queryByTestId("status-agents")).toBeNull();
  });

  test("Reload rules says what changed", async () => {
    serve();
    const daemonApi = createFixturesDaemonApi({ nextReloadResult: { ok: true, path: "/x/rules.json", added: ["new-rule"], removed: [], changed: ["ui-first-rule"], problems: [] } });
    const view = render(<StatusRoute daemonApi={daemonApi} settingsApi={createFixturesSettingsApi()} />);
    fireEvent.click(view.getByTestId("daemon-reload-button"));
    await waitFor(() => expect(view.getByTestId("status-action-result").textContent).toBe("Rules reloaded: added new-rule; changed ui-first-rule."));
  });

  test("Restart butchr asks first, then waits for a new process, not the one it asked", async () => {
    serve();
    let restarts = 0;
    const base = createFixturesSettingsApi();
    const settingsApi: SettingsApi = { ...base, restartDaemon: async () => { restarts++; } };
    const started = [STARTED, STARTED, "2026-10-16T16:00:00.000Z"];
    const view = render(
      <StatusRoute daemonApi={createFixturesDaemonApi()} settingsApi={settingsApi} readStartedAt={async () => started.shift()} restartPollDelaysMs={[0, 0, 0, 0]} />,
    );
    fireEvent.click(view.getByTestId("daemon-restart-button"));
    expect(restarts).toBe(0);
    fireEvent.click(await view.findByTestId("daemon-restart-confirm"));
    await waitFor(() => expect(view.getByTestId("status-action-result").textContent).toBe("butchr restarted."));
    expect([restarts, started]).toEqual([1, []]);
  });
});

describe("Agents page", () => {
  test("every agent with its status, links and actions, and the capacity line; no separate agent control panel", async () => {
    serve();
    const view = render(<AgentsRoute agentsApi={idleAgents} />);
    const agents = within(await view.findByTestId("status-agents"));
    expect(agents.getByTestId("status-agents-summary").textContent).toBe("1 running · cap 8");
    expect(agents.getByTestId("agent-row").textContent).toContain("KAN-3020");
    expect(agents.getByTestId("status-admission").textContent).toContain("1 of 8 worker slots in use");
    expect(agents.getByTestId("agent-stop-button")).toBeTruthy();
    expect(agents.getByTestId("agent-more-button")).toBeTruthy();
    expect(view.getByTestId("agent-start-open")).toBeTruthy();
    expect(view.queryByTestId("agent-control-panel")).toBeNull();
  });

  test("Stop shows what it closes, then stops the agent by its own key and says so", async () => {
    serve();
    const { api, calls } = recordingAgents();
    const view = render(<AgentsRoute agentsApi={api} />);
    fireEvent.click(await view.findByTestId("agent-stop-button"));
    const dialog = within(await view.findByTestId("agent-stop-dialog"));
    await waitFor(() => expect(dialog.getByText("This closes its pane, wF:p1.")).toBeTruthy());
    expect(dialog.getByText("closes the pane only")).toBeTruthy();
    fireEvent.click(dialog.getByTestId("agent-stop-confirm"));
    await waitFor(() => expect(view.getByTestId("agent-action-result").textContent).toBe("Stopped KAN-3020. it may be respawned"));
    expect(calls).toEqual([["stop", AGENT, false], ["stop", AGENT, true]]);
  });

  test("Start a ticket looks the ticket up, starts it when it has a boss, and offers a boss first when it doesn't", async () => {
    serve();
    const withBoss = recordingAgents("PROJ-1");
    const view = render(<AgentsRoute agentsApi={withBoss.api} />);
    fireEvent.click(view.getByTestId("agent-start-open"));
    const dialog = within(await view.findByTestId("agent-start-dialog"));
    setText(dialog.getByTestId("agent-start-key"), "proj-7");
    fireEvent.click(dialog.getByTestId("agent-start-lookup"));
    await waitFor(() => expect(dialog.getByTestId("agent-start-snapshot").textContent).toBe("PROJ-7: Fix login · To Do · boss PROJ-1"));
    fireEvent.click(dialog.getByTestId("agent-start-confirm"));
    await waitFor(() => expect(view.getByTestId("agent-action-result").textContent).toContain("Started PROJ-7"));
    expect(withBoss.calls).toEqual([["snapshot", "PROJ-7"], ["start", "PROJ-7"]]);
    cleanup();

    const noBoss = recordingAgents(null);
    const again = render(<AgentsRoute agentsApi={noBoss.api} />);
    fireEvent.click(again.getByTestId("agent-start-open"));
    const d2 = within(await again.findByTestId("agent-start-dialog"));
    setText(d2.getByTestId("agent-start-key"), "PROJ-8");
    fireEvent.click(d2.getByTestId("agent-start-lookup"));
    await waitFor(() => expect(d2.getByTestId("agent-needs-boss")).toBeTruthy());
    setText(d2.getByTestId("agent-boss-input"), "PROJ-1");
    fireEvent.click(d2.getByTestId("agent-boss-save"));
    await waitFor(() => expect(again.getByTestId("agent-action-result").textContent).toContain("Put PROJ-8 under PROJ-1 and started it"));
    expect(noBoss.calls).toEqual([["snapshot", "PROJ-8"], ["adopt", "PROJ-8", { bossKey: "PROJ-1", disposition: "start" }]]);
  });

  test("the Jira-ticket actions only apply to a Jira ticket's agent", () => {
    expect([jiraTicketOf(AGENT), jiraTicketOf("BUTCHR-12"), jiraTicketOf("github-issue:triage:owner%2Frepo%2312"), jiraTicketOf("jira-idea:ideas:IDEA-1")]).toEqual(["KAN-3020", "BUTCHR-12", null, null]);
  });

  test("under the /dashboard-app basename, an agent's terminal and resource links stay the daemon's own paths; dashboard links get the prefix", async () => {
    serve();
    const view = render(
      <MemoryRouter basename="/dashboard-app" initialEntries={["/dashboard-app/agents"]}>
        <App setupApi={createFixturesSetupApi({ status: { configured: true } })} />
      </MemoryRouter>,
    );
    const row = within(await view.findByTestId("agent-row"));
    expect(row.getByRole("link", { name: "open terminal" }).getAttribute("href")).toBe("/agents/pane/wF%3Ap1/attach");
    expect(row.getByRole("link", { name: "resource" }).getAttribute("href")).toBe("/resource/jira-work%3Aui-first-rule%3AKAN-3020/open");
    expect(row.getByRole("link", { name: "config" }).getAttribute("href")).toBe("/dashboard-app/rules#rule-jira-work--ui-first-rule");
    expect(view.getByRole("link", { name: "Agents" }).getAttribute("aria-current")).toBe("page");
  });
});

describe("Rules page anchors (what an agent row's config link opens)", () => {
  test("each saved rule's card carries its anchor id, and the one the URL names is scrolled to and highlighted", async () => {
    const api = createFixturesRulesApi({ latencyMs: 0 });
    window.location.hash = "#rule-jira-work--factory-triage";
    try {
      const view = render(<RulesTargetingRoute api={api} />);
      await waitFor(() => expect(view.container.querySelector("#rule-jira-work--factory-triage")).toBeTruthy());
      const target = view.container.querySelector("#rule-jira-work--factory-triage")!;
      expect(target.className).toContain("rt-card--target");
      expect([...view.container.querySelectorAll(".rt-card--target")]).toHaveLength(1);
    } finally {
      window.location.hash = "";
    }
  });
});

describe("Status page wording", () => {
  test("durations, uptime and the build", () => {
    expect([durationText(20_000), durationText(12 * 60_000), durationText(185 * 60_000), durationText(50 * 3_600_000)]).toEqual(["under a minute", "12 min", "3 h 5 min", "2 days 2 h"]);
    expect(uptimeText(STARTED, Date.parse(STARTED) + 90 * 60_000)).toBe("up 1 h 30 min");
    expect(uptimeText("nope", 0)).toBeNull();
    expect(buildText({ sha: "abcdef0123456789", shaDirty: true, shaUnknownReason: null })).toBe("abcdef01, with uncommitted changes");
    expect(buildText({ sha: null, shaDirty: null, shaUnknownReason: "no git" })).toBe("unknown (no git)");
  });

  test("upstream: behind only when ahead by exactly 0, ahead, both, current, unknown", () => {
    const stale = (commitsBehind: number | null, commitsAhead: number | null) => upstreamText({ checkedAt: null, verdict: { status: "stale", commitsBehind, commitsAhead, base: BASE, dirtyUndeterminable: false } });
    expect([stale(2, 0), stale(0, 1), stale(2, 3), stale(null, 3)]).toEqual(["2 commits behind origin/main", "1 commit ahead of origin/main", "3 commits ahead of and 2 commits behind origin/main", "differs from origin/main"]);
    expect(upstreamText({ checkedAt: null, verdict: { status: "current", base: BASE, dirtyUndeterminable: false } })).toBe("up to date with origin/main");
    expect(upstreamText({ checkedAt: null, verdict: { status: "unknown", reason: "no remote" } })).toBe("can't compare with upstream: no remote");
    expect(upstreamText(undefined)).toBeNull();
  });

  test("rule loops: running ones with how they're doing, the rest with why they're off", () => {
    const failing = { name: "github-pr", ok: false, state: "stale" as const, lastSuccessAt: null, staleForMs: 600_000, enabled: true, consecutiveFailures: 3, lastError: { at: STARTED, message: "HTTP 502" } };
    expect(loopSummary([...HEALTH.resourceLoops!, failing])).toEqual({
      running: [{ name: "trello-card", ok: true, text: "ok" }, { name: "github-pr", ok: false, text: "failing (3 in a row): HTTP 502" }],
      off: [{ name: "zendesk-ticket", reason: "no enabled zendesk-ticket rules" }],
    });
    expect(logSourceText('tail -n 200 -f "/Users/you/Library/Logs/butchr.log"')).toBe("/Users/you/Library/Logs/butchr.log");
    expect([agentsText({ cap: 8, residency: 1, sentinels: 0 }), agentsText({ cap: 8, residency: 2, sentinels: 1 }), agentsText({ cap: 8, residency: null, sentinels: null })]).toEqual(["1 of 8 slots in use", "2 of 8 slots in use, plus 1 sentinel", "not counted yet, cap 8"]);
    expect(logSourceText("journalctl --user -u butchr.service")).toBe("journalctl --user -u butchr.service");
  });
});
