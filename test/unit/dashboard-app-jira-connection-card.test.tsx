import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { withDom } from "../setup/happy-dom.js";
import { JiraConnectionCard } from "../../dashboard-app/src/components/JiraConnectionCard.js";
import { createFixturesSettingsApi } from "../../dashboard-app/src/api/settings.js";
import { createFixturesSetupApi, defaultSetupSuccess, ProvidedByEnvironmentError } from "../../dashboard-app/src/api/setup.js";

withDom();
afterEach(cleanup);

const tokenFile = { path: "/p", statusText: "ok", warning: false };

describe("JiraConnectionCard — rotation control (FACTORY-665, PR-2)", () => {
  test("without setupApi: no rotation control is rendered (unchanged A1 behavior)", () => {
    const { queryByTestId } = render(<JiraConnectionCard api={createFixturesSettingsApi()} site="s" email="e" tokenFile={tokenFile} />);
    expect(queryByTestId("jira-rotate-control")).toBeNull();
  });

  test("with setupApi: a Rotate token button is rendered; clicking it reveals token/code fields with the right input types", () => {
    const { getByTestId } = render(<JiraConnectionCard api={createFixturesSettingsApi()} site="s" email="e" tokenFile={tokenFile} setupApi={createFixturesSetupApi()} />);
    fireEvent.click(getByTestId("jira-rotate-start-button"));
    const token = getByTestId("jira-rotate-token-input") as HTMLInputElement;
    expect(token.type).toBe("password");
    expect(token.autocomplete).toBe("off");
    expect(getByTestId("jira-rotate-code-input")).toBeTruthy();
  });

  test("Cancel returns to the idle state without calling the API", () => {
    const { getByTestId, queryByTestId } = render(<JiraConnectionCard api={createFixturesSettingsApi()} site="s" email="e" tokenFile={tokenFile} setupApi={createFixturesSetupApi()} />);
    fireEvent.click(getByTestId("jira-rotate-start-button"));
    fireEvent.click(getByTestId("jira-rotate-cancel-button"));
    expect(queryByTestId("jira-rotate-token-input")).toBeNull();
    expect(getByTestId("jira-rotate-start-button")).toBeTruthy();
  });

  test("confirming rotation shows the success result naming the new identity", async () => {
    const setupApi = createFixturesSetupApi({ nextResult: defaultSetupSuccess({ rotated: true, accountId: "acct-rot", displayName: "Rotated" }) });
    const { getByTestId } = render(<JiraConnectionCard api={createFixturesSettingsApi()} site="s" email="e" tokenFile={tokenFile} setupApi={setupApi} />);
    fireEvent.click(getByTestId("jira-rotate-start-button"));
    fireEvent.click(getByTestId("jira-rotate-confirm-button"));
    await waitFor(() => expect(getByTestId("jira-rotate-result").textContent).toContain("Rotated"));
    expect(getByTestId("jira-rotate-result").textContent).toContain("acct-rot");
  });

  test("a 409 (provided by environment) rotation failure shows the fixed guidance text", async () => {
    const setupApi = createFixturesSetupApi({ nextResult: { throw: new ProvidedByEnvironmentError() } });
    const { getByTestId } = render(<JiraConnectionCard api={createFixturesSettingsApi()} site="s" email="e" tokenFile={tokenFile} setupApi={setupApi} />);
    fireEvent.click(getByTestId("jira-rotate-start-button"));
    fireEvent.click(getByTestId("jira-rotate-confirm-button"));
    await waitFor(() => expect(getByTestId("jira-rotate-result").textContent).toContain("unset ATLASSIAN_TOKEN"));
  });
});
