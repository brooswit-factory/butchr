import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { withDom } from "../setup/happy-dom.js";
import { PollStatusView } from "../../dashboard-app/src/components/PollStatusView.js";
import type { PollState } from "../../dashboard-app/src/view-model/poll-state.js";

withDom();
afterEach(cleanup);

describe("PollStatusView — FACTORY-614", () => {
  test("loading: renders the loading copy, never the children", () => {
    const state: PollState<string> = { kind: "loading" };
    const { getByText, queryByTestId } = render(
      <PollStatusView state={state} label="/dashboard">
        {(data: string) => <span data-testid="data">{data}</span>}
      </PollStatusView>,
    );
    expect(getByText(/loading \/dashboard/)).toBeTruthy();
    expect(queryByTestId("data")).toBeNull();
  });

  test("error: renders could-not-check copy with the error text, never the children (no last-good data exists)", () => {
    const state: PollState<string> = { kind: "error", error: "boom" };
    const { getByText, queryByTestId } = render(
      <PollStatusView state={state} label="/dashboard">
        {(data: string) => <span data-testid="data">{data}</span>}
      </PollStatusView>,
    );
    expect(getByText(/could not check \/dashboard — boom/)).toBeTruthy();
    expect(queryByTestId("data")).toBeNull();
  });

  test("loaded: renders only the children, with stale: false, no could-not-check banner", () => {
    const state: PollState<string> = { kind: "loaded", data: "hello", confirmedAt: 1 };
    let sawStale: boolean | undefined;
    const { getByTestId, queryByText } = render(
      <PollStatusView state={state} label="/dashboard">
        {(data, meta) => {
          sawStale = meta.stale;
          return <span data-testid="data">{data}</span>;
        }}
      </PollStatusView>,
    );
    expect(getByTestId("data").textContent).toBe("hello");
    expect(sawStale).toBe(false);
    expect(queryByText(/could not check/)).toBeNull();
  });

  test("MUTATION CHECK: stale shows the LAST GOOD data alongside a could-not-check banner — never silently as fresh, and never withholding the data either", () => {
    const state: PollState<string> = { kind: "stale", data: "hello", confirmedAt: 1, error: "refresh failed" };
    let sawStale: boolean | undefined;
    const { getByTestId, getByText } = render(
      <PollStatusView state={state} label="/dashboard">
        {(data, meta) => {
          sawStale = meta.stale;
          return <span data-testid="data">{data}</span>;
        }}
      </PollStatusView>,
    );
    expect(getByTestId("data").textContent).toBe("hello");
    expect(sawStale).toBe(true);
    expect(getByText(/could not check \/dashboard — showing data as of a previous refresh: refresh failed/)).toBeTruthy();
  });
});
