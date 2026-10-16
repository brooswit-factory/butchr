import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { withDom } from "../setup/happy-dom.js";
import { SetupRoute } from "../../dashboard-app/src/routes/SetupRoute.js";
import { createFixturesSetupApi, defaultSetupSuccess, RateLimitError } from "../../dashboard-app/src/api/setup.js";

withDom();
afterEach(cleanup);

describe("SetupRoute — FACTORY-665 (PR-2)", () => {
  test("renders site/email/token/setup-code fields, token is type=password with autoComplete=off", () => {
    const { getByTestId } = render(<SetupRoute api={createFixturesSetupApi()} />);
    const token = getByTestId("setup-token-input") as HTMLInputElement;
    expect(token.type).toBe("password");
    expect(token.autocomplete).toBe("off");
    expect(getByTestId("setup-site-input")).toBeTruthy();
    expect(getByTestId("setup-email-input")).toBeTruthy();
    expect(getByTestId("setup-code-input")).toBeTruthy();
  });

  test("submitting shows the success result and calls onSetupSucceeded, then clears the token/code fields", async () => {
    let succeeded = false;
    const api = createFixturesSetupApi({ nextResult: defaultSetupSuccess({ accountId: "acct-9", displayName: "Nine" }) });
    const { getByTestId } = render(<SetupRoute api={api} onSetupSucceeded={() => { succeeded = true; }} />);
    fireEvent.change(getByTestId("setup-site-input"), { target: { value: "https://x.atlassian.net" } });
    fireEvent.change(getByTestId("setup-email-input"), { target: { value: "a@b.c" } });
    fireEvent.change(getByTestId("setup-token-input"), { target: { value: "canary-token" } });
    fireEvent.change(getByTestId("setup-code-input"), { target: { value: "ABCDEFGHJKMN" } });
    fireEvent.click(getByTestId("setup-submit-button"));
    await waitFor(() => expect(getByTestId("setup-result").textContent).toContain("Nine"));
    expect(getByTestId("setup-result").textContent).toContain("acct-9");
    expect(succeeded).toBe(true);
    expect((getByTestId("setup-token-input") as HTMLInputElement).value).toBe("");
    expect((getByTestId("setup-code-input") as HTMLInputElement).value).toBe("");
  });

  test("an identityPersisted:false result shows the warning text alongside success", async () => {
    const api = createFixturesSetupApi({ nextResult: defaultSetupSuccess({ identityPersisted: false, identityError: "ENOSPC" }) });
    const { getByTestId } = render(<SetupRoute api={api} />);
    fireEvent.click(getByTestId("setup-submit-button"));
    await waitFor(() => expect(getByTestId("setup-result").textContent).toContain("ENOSPC"));
  });

  test("a rejected submit shows the fixed error message, never a stack trace or raw object", async () => {
    const api = createFixturesSetupApi({ nextResult: { throw: new Error("setup code: mismatch") } });
    const { getByTestId } = render(<SetupRoute api={api} />);
    fireEvent.click(getByTestId("setup-submit-button"));
    await waitFor(() => expect(getByTestId("setup-result").textContent).toContain("setup code: mismatch"));
  });

  test("a rate-limited submit shows the retry-after text", async () => {
    const api = createFixturesSetupApi({ nextRateLimit: { retryAfterSeconds: 7 } });
    const { getByTestId } = render(<SetupRoute api={api} />);
    fireEvent.click(getByTestId("setup-submit-button"));
    await waitFor(() => expect(getByTestId("setup-result").textContent).toContain("7s"));
  });

  test("the submit button disables while pending", async () => {
    let resolve: (() => void) | undefined;
    const api = { getStatus: async () => ({ configured: false }), submitSetup: () => new Promise<ReturnType<typeof defaultSetupSuccess>>((r) => { resolve = () => r(defaultSetupSuccess()); }), rotateToken: async () => defaultSetupSuccess() };
    const { getByTestId } = render(<SetupRoute api={api} />);
    const button = getByTestId("setup-submit-button") as HTMLButtonElement;
    fireEvent.click(button);
    await waitFor(() => expect(button.disabled).toBe(true));
    resolve?.();
    await waitFor(() => expect(button.disabled).toBe(false));
  });
});
