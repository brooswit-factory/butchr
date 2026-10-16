import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import { withDom } from "../setup/happy-dom.js";
import { DashboardRoute } from "../../dashboard-app/src/routes/DashboardRoute.js";
import { DashboardView } from "../../dashboard-app/src/components/DashboardView.js";
import { buildDashboardViewModel, type DashboardViewOpts } from "../../dashboard-app/src/view-model/dashboard-view.js";
import type { DashboardResponse } from "../../src/agents/dashboard.js";
import type { HealthStatus } from "../../src/daemon/health.js";

withDom();
afterEach(cleanup);

const ADMISSION: DashboardResponse["admission"] = { cap: 5, residency: 2, sentinels: 0, sources: [] };

const BASE_OPTS: DashboardViewOpts = {
  now: Date.parse("2026-01-01T00:10:00.000Z"),
  header: { build: null },
  terminalLinkHref: (pane) => `/agents/pane/${pane}/attach`,
  resourceLinkHref: (key) => `/resource/${key}/open`,
};

function neverResolves(): typeof fetch {
  return (() => new Promise<Response>(() => {})) as unknown as typeof fetch;
}

function routed(responses: Record<string, { body?: unknown; status?: number; reject?: boolean }>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    const r = responses[url];
    if (!r) throw new Error(`unexpected fetch: ${url}`);
    if (r.reject) throw new Error("network down");
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

describe("DashboardView — row identity and the daemon-level banner (FACTORY-615)", () => {
  test("requirement 1: a row's own DOM node is the SAME node across a re-render when its resourceKey is unchanged — no full-row replacement on an ordinary poll", () => {
    const response = (confirmedAt: string): DashboardResponse => ({
      checked: true,
      confirmedAt,
      rows: [
        {
          kind: "agent",
          resourceKey: "jira-work:rule1:FACTORY-68",
          tier: { kind: "issue", issuetype: { checked: true, value: "Task" } },
          agentStatus: "working",
          pane: "pane-1",
          timeInStatus: { since: "2026-01-01T00:00:00.000Z", sinceMs: BASE_OPTS.now - 60_000, humanDuration: "1m", exact: true },
          confirmedAt,
        },
      ],
      admission: ADMISSION,
    });

    const { container, rerender } = render(<DashboardView vm={buildDashboardViewModel(response("2026-01-01T00:09:00.000Z"), BASE_OPTS)} />);
    const firstNode = container.querySelector('[id="agent-jira-work%3Arule1%3AFACTORY-68"]');
    expect(firstNode).toBeTruthy();

    rerender(<DashboardView vm={buildDashboardViewModel(response("2026-01-01T00:09:55.000Z"), { ...BASE_OPTS, now: BASE_OPTS.now + 5000 })} />);
    const secondNode = container.querySelector('[id="agent-jira-work%3Arule1%3AFACTORY-68"]');
    expect(secondNode).toBe(firstNode);
  });

  test("a checked response renders the calm confirmed banner, never the loud could-not-check one", () => {
    const response: DashboardResponse = { checked: true, confirmedAt: "2026-01-01T00:09:55.000Z", rows: [], admission: ADMISSION };
    const { getByTestId, queryByText } = render(<DashboardView vm={buildDashboardViewModel(response, BASE_OPTS)} />);
    expect(getByTestId("dashboard-banner").textContent).toContain("confirmed");
    expect(queryByText(/COULD NOT CHECK/)).toBeNull();
  });

  test("a declined response renders the loud could-not-check banner, as an Alert", () => {
    const response: DashboardResponse = { checked: false, declinedAt: "2026-01-01T00:09:00.000Z", rows: [], admission: ADMISSION };
    const { getByTestId } = render(<DashboardView vm={buildDashboardViewModel(response, BASE_OPTS)} />);
    expect(getByTestId("dashboard-banner").textContent).toContain("COULD NOT CHECK");
  });

  test("a mixed response renders both an agent row and a withheld row, each with their own test id", () => {
    const response: DashboardResponse = {
      checked: true,
      confirmedAt: "2026-01-01T00:09:55.000Z",
      rows: [
        {
          kind: "agent",
          resourceKey: "jira-work:rule1:FACTORY-68",
          tier: { kind: "issue", issuetype: { checked: true, value: "Task" } },
          agentStatus: "working",
          pane: "pane-1",
          timeInStatus: { since: "2026-01-01T00:00:00.000Z", sinceMs: BASE_OPTS.now - 60_000, humanDuration: "1m", exact: true },
          confirmedAt: "2026-01-01T00:09:55.000Z",
        },
        {
          kind: "withheld",
          resourceKey: "jira-work:rule1:FACTORY-99",
          tier: { kind: "issue", issuetype: { checked: true, value: "Story" } },
          source: "issue-tier",
          waiting: { since: "2026-01-01T00:00:00.000Z", sinceMs: BASE_OPTS.now - 60_000, humanDuration: "1m", exact: true },
          confirmedAt: "2026-01-01T00:09:55.000Z",
          agentFields: { applicable: false, reason: "no agent: withheld by the admission cap" },
        },
      ],
      admission: ADMISSION,
    };
    const { getAllByTestId } = render(<DashboardView vm={buildDashboardViewModel(response, BASE_OPTS)} />);
    expect(getAllByTestId("agent-row")).toHaveLength(1);
    expect(getAllByTestId("withheld-row")).toHaveLength(1);
  });

  test("a stable link to /configurations is always present, even on an empty, declined response", () => {
    const response: DashboardResponse = { checked: false, declinedAt: "2026-01-01T00:09:00.000Z", rows: [], admission: ADMISSION };
    const { getByRole } = render(<DashboardView vm={buildDashboardViewModel(response, BASE_OPTS)} />);
    expect(getByRole("link", { name: "configurations" }).getAttribute("href")).toBe("/configurations");
  });

  test("per-source admission rows render independently: a checked source and a declined source each carry only their own state (mutation 3)", () => {
    const response: DashboardResponse = {
      checked: true,
      confirmedAt: "2026-01-01T00:09:55.000Z",
      rows: [],
      admission: {
        ...ADMISSION,
        sources: [
          { source: "issue-tier", census: { checked: true, confirmedAt: "2026-01-01T00:09:50.000Z" } },
          { source: "project-tier", census: { checked: false, declinedAt: "2026-01-01T00:09:50.000Z", reason: "untrusted" } },
        ],
      },
    };
    const { getByText } = render(<DashboardView vm={buildDashboardViewModel(response, BASE_OPTS)} />);
    const checkedLine = getByText(/issue-tier: checked/);
    const declinedLine = getByText(/project-tier: COULD NOT CHECK/);
    expect(checkedLine.getAttribute("data-source")).toBe("issue-tier");
    expect(checkedLine.textContent).not.toContain("untrusted");
    expect(declinedLine.getAttribute("data-source")).toBe("project-tier");
    expect(declinedLine.textContent).toContain("untrusted");
  });

  test("admission residency's could-not-check case never renders as a known number", () => {
    const response: DashboardResponse = { checked: true, confirmedAt: "2026-01-01T00:09:55.000Z", rows: [], admission: { ...ADMISSION, residency: null } };
    const { getByText } = render(<DashboardView vm={buildDashboardViewModel(response, BASE_OPTS)} />);
    expect(getByText(/could not check \(no trusted census yet\)/)).toBeTruthy();
  });
});

describe("DashboardRoute — FACTORY-615: the real main dashboard at /dashboard-app/", () => {
  test("an initial failure shows an error, never an empty healthy-looking page", async () => {
    globalThis.fetch = routed({ "/dashboard": { reject: true }, "/health": { reject: true } });
    const { getByText } = render(<DashboardRoute />);
    await waitFor(() => expect(getByText(/could not check \/dashboard/)).toBeTruthy());
  });

  test("while loading, shows a loading indicator rather than an empty page", () => {
    globalThis.fetch = neverResolves();
    const { getByText } = render(<DashboardRoute />);
    expect(getByText(/loading \/dashboard/)).toBeTruthy();
  });

  test("a loaded response renders the real dashboard body, with a row's own stable anchor id", async () => {
    const response: DashboardResponse = {
      checked: true,
      confirmedAt: "2026-01-01T00:09:55.000Z",
      rows: [
        {
          kind: "agent",
          resourceKey: "jira-work:rule1:FACTORY-68",
          tier: { kind: "issue", issuetype: { checked: true, value: "Task" } },
          agentStatus: "working",
          pane: "pane-1",
          timeInStatus: { since: "2026-01-01T00:00:00.000Z", sinceMs: Date.now() - 60_000, humanDuration: "1m", exact: true },
          confirmedAt: "2026-01-01T00:09:55.000Z",
        },
      ],
      admission: ADMISSION,
    };
    const health: HealthStatus = { ok: true, components: [], build: { sha: "abc123def456", shaProvenance: "baked", shaDirty: false, shaUnknownReason: null, version: "9.9.9", versionProvenance: "tag", versionUnknownReason: null, startedAt: "2026-01-01T00:00:00.000Z", pid: 1, unit: "butchr.service", journalctl: "journalctl --user -u butchr.service" } };
    globalThis.fetch = routed({ "/dashboard": { body: response }, "/health": { body: health } });
    const { getByTestId, container } = render(<DashboardRoute />);
    await waitFor(() => expect(container.querySelector('[id="agent-jira-work%3Arule1%3AFACTORY-68"]')).toBeTruthy());
    await waitFor(() => expect(getByTestId("dashboard-build-header").textContent).toContain("abc123de"));
  });

  test("a terminal-attach link, a resource link, and the agents/pane/:pane/attach + resource/:key/open routes are exactly what's rendered (link preservation)", async () => {
    const response: DashboardResponse = {
      checked: true,
      confirmedAt: "2026-01-01T00:09:55.000Z",
      rows: [
        {
          kind: "agent",
          resourceKey: "jira-work:rule1:FACTORY-68",
          tier: { kind: "issue", issuetype: { checked: true, value: "Task" } },
          agentStatus: "working",
          pane: "a pane/with special chars",
          timeInStatus: { since: "2026-01-01T00:00:00.000Z", sinceMs: Date.now() - 60_000, humanDuration: "1m", exact: true },
          confirmedAt: "2026-01-01T00:09:55.000Z",
        },
      ],
      admission: ADMISSION,
    };
    globalThis.fetch = routed({ "/dashboard": { body: response }, "/health": { reject: true } });
    const { getByText } = render(<DashboardRoute />);
    await waitFor(() => expect(getByText("open terminal")).toBeTruthy());
    expect(getByText("open terminal").closest("a")?.getAttribute("href")).toBe(`/agents/pane/${encodeURIComponent("a pane/with special chars")}/attach`);
    expect(getByText("resource").closest("a")?.getAttribute("href")).toBe(`/resource/${encodeURIComponent("jira-work:rule1:FACTORY-68")}/open`);
  });
});
