import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { withDom } from "../setup/happy-dom.js";
import { AgentRowCard } from "../../dashboard-app/src/components/AgentRowCard.js";
import type { AgentRowView } from "../../dashboard-app/src/view-model/dashboard-view.js";

withDom();
afterEach(cleanup);

function row(overrides: Partial<AgentRowView> = {}): AgentRowView {
  return {
    kind: "agent",
    anchorId: "agent-jira-work--rule1--FACTORY-68",
    displayKey: "FACTORY-68",
    resourceKey: "jira-work:rule1:FACTORY-68",
    tier: { text: "Task", cnc: false },
    statusClass: "working",
    agentStatus: "working",
    pane: "pane-1",
    floor: { text: "6m", exact: true, title: 'in status "working" since 2026-01-01T00:00:00.000Z', inexactNote: null },
    freshness: { text: "confirmed 3s ago", stale: false, title: "2026-01-01T00:09:57.000Z" },
    terminalHref: "/agents/pane/pane-1/attach",
    resourceHref: "/resource/jira-work:rule1:FACTORY-68/open",
    configHref: "/configurations#rule-jira-work--rule1",
    ...overrides,
  };
}

describe("AgentRowCard — FACTORY-615", () => {
  test("carries the anchor id a Configurations back-link points at (agentRowAnchorId, FACTORY-81)", () => {
    const { container } = render(<AgentRowCard row={row()} />);
    expect(container.querySelector("#agent-jira-work--rule1--FACTORY-68")).toBeTruthy();
  });

  test("renders the display key, tier, status, and pane as visible text", () => {
    const { getByText } = render(<AgentRowCard row={row()} />);
    expect(getByText("FACTORY-68")).toBeTruthy();
    expect(getByText("Task")).toBeTruthy();
    expect(getByText("working")).toBeTruthy();
    expect(getByText("pane-1")).toBeTruthy();
  });

  test("a cnc tier renders the literal 'COULD NOT CHECK', never the raw text, styled distinctly", () => {
    const { getByText, container } = render(<AgentRowCard row={row({ tier: { text: "could not check", cnc: true } })} />);
    expect(getByText("COULD NOT CHECK")).toBeTruthy();
    expect(container.querySelector(".dashboard-row__tier--cnc")).toBeTruthy();
  });

  test("the terminal-attach link and resource link point at exactly the hrefs the view-model built (BUTCHR-267/339 contract)", () => {
    const { getByText } = render(<AgentRowCard row={row()} />);
    expect(getByText("open terminal").closest("a")?.getAttribute("href")).toBe("/agents/pane/pane-1/attach");
    expect(getByText("resource").closest("a")?.getAttribute("href")).toBe("/resource/jira-work:rule1:FACTORY-68/open");
  });

  test("the config back-link renders when configHref is present, pointing at exactly that href", () => {
    const { getByText } = render(<AgentRowCard row={row()} />);
    expect(getByText("config").closest("a")?.getAttribute("href")).toBe("/configurations#rule-jira-work--rule1");
  });

  test("no config link renders at all when configHref is null — never a broken href", () => {
    const { queryByText } = render(<AgentRowCard row={row({ configHref: null })} />);
    expect(queryByText("config")).toBeNull();
  });

  test("an inexact floor shows its 'at least' text and the inexact note; an exact one shows neither extra wording nor the note", () => {
    const inexact = render(<AgentRowCard row={row({ floor: { text: "at least 6m", exact: false, title: "t", inexactNote: "(since daemon start — this tracker never witnessed the true start)" } })} />);
    expect(inexact.getByText("at least 6m")).toBeTruthy();
    expect(inexact.getByText(/since daemon start/)).toBeTruthy();
    cleanup();
    const exact = render(<AgentRowCard row={row()} />);
    expect(exact.queryByText(/since daemon start/)).toBeNull();
  });

  test("a stale freshness badge is styled distinctly from a fresh one — never the same class", () => {
    const stale = render(<AgentRowCard row={row({ freshness: { text: "STALE — at least 3s old, as of X", stale: true, title: "X" } })} />);
    expect(stale.container.querySelector(".dashboard-row__freshness--stale")).toBeTruthy();
    cleanup();
    const fresh = render(<AgentRowCard row={row()} />);
    expect(fresh.container.querySelector(".dashboard-row__freshness--stale")).toBeFalsy();
  });

  test("never renders a not-applicable marker — nothing about an agent row is inapplicable", () => {
    const { container } = render(<AgentRowCard row={row()} />);
    expect(container.querySelector(".dashboard-row__na")).toBeFalsy();
  });
});
