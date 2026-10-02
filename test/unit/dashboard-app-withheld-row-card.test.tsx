import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { withDom } from "../setup/happy-dom.js";
import { WithheldRowCard } from "../../dashboard-app/src/components/WithheldRowCard.js";
import type { WithheldRowView } from "../../dashboard-app/src/view-model/dashboard-view.js";

withDom();
afterEach(cleanup);

function row(overrides: Partial<WithheldRowView> = {}): WithheldRowView {
  return {
    kind: "withheld",
    resourceKey: "jira-work:rule1:FACTORY-99",
    tier: { text: "Story", cnc: false },
    floor: { text: "2m", exact: true, title: "withheld since 2026-01-01T00:00:00.000Z", inexactNote: null },
    freshness: { text: "observed 8s ago", stale: false, title: "2026-01-01T00:09:52.000Z" },
    notApplicableReason: "no agent: withheld by the admission cap",
    resourceHref: "/resource/jira-work:rule1:FACTORY-99/open",
    source: "issue-tier",
    ...overrides,
  };
}

describe("WithheldRowCard — FACTORY-615", () => {
  test("renders the full resourceKey verbatim (never displayResourceKey-decoded, same as dashboard-page.ts)", () => {
    const { getByText } = render(<WithheldRowCard row={row()} />);
    expect(getByText("jira-work:rule1:FACTORY-99")).toBeTruthy();
  });

  test("renders the 'waiting for a slot' pill, never an agentStatus value", () => {
    const { getByText } = render(<WithheldRowCard row={row()} />);
    expect(getByText("waiting for a slot")).toBeTruthy();
  });

  test("carries its own not-applicable marker with its own reason as the title — never the could-not-check styling", () => {
    const { getByText, container } = render(<WithheldRowCard row={row()} />);
    const na = getByText("no agent — n/a");
    expect(na).toBeTruthy();
    expect(na.getAttribute("title")).toBe("no agent: withheld by the admission cap");
    expect(container.querySelector(".dashboard-row__tier--cnc")).toBeFalsy();
  });

  test("mutation 2: a withheld row can carry BOTH a cnc tier AND its own not-applicable marker, distinctly", () => {
    const { getByText, container } = render(<WithheldRowCard row={row({ tier: { text: "could not check", cnc: true } })} />);
    expect(getByText("COULD NOT CHECK")).toBeTruthy();
    expect(getByText("no agent — n/a")).toBeTruthy();
    expect(container.querySelector(".dashboard-row__tier--cnc")).toBeTruthy();
  });

  test("carries no terminal link and no pane — a withheld row has no agent", () => {
    const { queryByText, container } = render(<WithheldRowCard row={row()} />);
    expect(queryByText("open terminal")).toBeNull();
    expect(container.innerHTML).not.toContain("/attach");
  });

  test("carries no config back-link — requirement 3 speaks of the running agent row only", () => {
    const { queryByText } = render(<WithheldRowCard row={row()} />);
    expect(queryByText("config")).toBeNull();
  });

  test("the resource link points at exactly the href the view-model built", () => {
    const { getByText } = render(<WithheldRowCard row={row()} />);
    expect(getByText("resource").closest("a")?.getAttribute("href")).toBe("/resource/jira-work:rule1:FACTORY-99/open");
  });

  test("its own freshness badge carries data-source, scoped to its own census source (review gap #2)", () => {
    const { getByText } = render(<WithheldRowCard row={row({ source: "project-tier" })} />);
    expect(getByText("observed 8s ago").getAttribute("data-source")).toBe("project-tier");
  });

  test("a stale (declined-source) freshness badge is styled distinctly from a fresh one", () => {
    const { container } = render(<WithheldRowCard row={row({ freshness: { text: "STALE — at least 1m old, as of X", stale: true, title: "X" } })} />);
    expect(container.querySelector(".dashboard-row__freshness--stale")).toBeTruthy();
  });
});
