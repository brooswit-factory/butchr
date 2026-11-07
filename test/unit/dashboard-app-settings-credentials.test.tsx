/**
 * local/ui — the Settings page's Providers section against the fixture
 * API: what each card shows, setting a token (cleared afterwards), saving
 * GitHub orgs, the restart banner, and read-only cases.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { withDom } from "../setup/happy-dom.js";
import { SettingsRoute } from "../../dashboard-app/src/routes/SettingsRoute.js";
import { createFixturesSettingsApi, localUiSettingsFixture, type SettingsApi, type SettingsResponse } from "../../dashboard-app/src/api/settings.js";
import { createFixturesSetupApi, defaultSetupSuccess, type SetupApi } from "../../dashboard-app/src/api/setup.js";

withDom();
afterEach(cleanup);

function setText(input: HTMLElement, value: string) {
  fireEvent.input(input, { target: { value } });
  fireEvent.change(input, { target: { value } });
}

function recordingApi(response: SettingsResponse = localUiSettingsFixture()) {
  const base = createFixturesSettingsApi({ response });
  const calls = { githubToken: [] as unknown[], settings: [] as unknown[][], restarts: 0 };
  const api: SettingsApi = {
    ...base,
    writeGithubToken: async (input) => { calls.githubToken.push(input); return base.writeGithubToken(input); },
    writeSetting: async (key, value, confirm) => { calls.settings.push([key, value, confirm]); return base.writeSetting(key, value, confirm); },
    restartDaemon: async () => { calls.restarts++; return base.restartDaemon(); },
  };
  return { api, calls };
}

function mount(api: SettingsApi, setupApi: SetupApi = createFixturesSetupApi({ status: { configured: true } })) {
  return render(<SettingsRoute api={api} setupApi={setupApi} />);
}

/** The local/ui fixture with these orgs saved in settings.json, and butchr running with `runningOrgs` (the same ones unless a restart is due). */
function withOrgs(orgs: string[], runningOrgs: string[] = orgs): SettingsResponse {
  const fixture = localUiSettingsFixture();
  fixture.credentials = { ...fixture.credentials!, github: { ...fixture.credentials!.github, orgs, orgsSource: "file", orgsEditable: true, active: true, runningOrgs } };
  return fixture;
}

type Scope = ReturnType<typeof within>;
const saveButton = (github: Scope) => github.getByTestId("cr-github-orgs-save") as HTMLButtonElement;
const orgValues = (github: Scope) => github.queryAllByTestId(/^cr-github-org-\d+$/).map((el: HTMLElement) => (el as HTMLInputElement).value);

describe("Settings: Providers section", () => {
  test("shows both cards; the table and the old Jira card don't repeat them", async () => {
    const view = mount(recordingApi().api);
    const atlassian = within(await view.findByTestId("cr-atlassian"));
    expect(atlassian.getByText("https://example.atlassian.net")).toBeTruthy();
    expect(atlassian.getByTestId("cr-atlassian-token-status").textContent).toContain("Stored in /Users/you/.config/butchr/atlassian-token (named by ATLASSIAN_TOKEN_FILE).");
    const github = within(view.getByTestId("cr-github"));
    expect(github.getByTestId("cr-github-status").textContent).toContain("Off");
    expect(github.getByTestId("cr-github-token-status").textContent).toContain("Not set. Saving one writes /Users/you/.config/butchr/secrets/github-token.");
    expect(github.getByTestId("cr-github-open").textContent).toBe("Set token");
    expect(view.queryByTestId("jira-connection-card")).toBeNull();
    expect(view.queryByText("ATLASSIAN_SITE")).toBeNull();
    expect(view.queryByTestId("cr-restart-banner")).toBeNull();
  });

  test("the section is called Providers, and each card's name has its provider's logo, which screen readers skip", async () => {
    const view = mount(recordingApi().api);
    await view.findByTestId("cr-atlassian");
    expect(view.getByRole("heading", { level: 2, name: "Providers" })).toBeTruthy();
    for (const [provider, name] of [["atlassian", "Atlassian"], ["github", "GitHub"], ["zendesk", "Zendesk"], ["trello", "Trello"]] as const) {
      const heading = view.getByRole("heading", { level: 3, name });
      const icon = within(heading).getByTestId(`cr-${provider}-icon`);
      expect([icon.getAttribute("aria-hidden"), icon.getAttribute("class")]).toEqual(["true", `cr-provider-icon cr-provider-icon--${provider}`]);
      expect(icon.querySelector("path")?.getAttribute("d")?.length).toBeGreaterThan(100);
    }
  });

  test("setting the GitHub token sends exactly the token, clears the fields, and offers a restart", async () => {
    const { api, calls } = recordingApi();
    const view = mount(api);
    const github = within(await view.findByTestId("cr-github"));
    fireEvent.click(github.getByTestId("cr-github-open"));
    const tokenInput = github.getByTestId("cr-github-token") as HTMLInputElement;
    expect([tokenInput.type, tokenInput.autocomplete]).toEqual(["password", "off"]);
    setText(tokenInput, "ghp_secret");
    fireEvent.click(github.getByTestId("cr-github-save"));
    await waitFor(() => expect(github.getByTestId("cr-github-result").textContent).toBe("Saved. It belongs to octocat. Restart butchr to use it."));
    expect(calls.githubToken).toEqual([{ token: "ghp_secret" }]);
    expect(github.queryByTestId("cr-github-token")).toBeNull();
    expect(view.getByTestId("cr-restart-banner").textContent).toContain("You changed the GitHub token.");
    expect(view.container.innerHTML).not.toContain("ghp_secret");
  });

  test("each GitHub org gets its own row; + adds one and focuses it; Save writes them as one BUTCHR_GITHUB_ORGS value; a restart brings butchr back", async () => {
    const { api, calls } = recordingApi();
    const view = mount(api);
    const github = within(await view.findByTestId("cr-github"));
    expect(github.getByRole("group", { name: "Organizations" })).toBeTruthy();
    expect(saveButton(github).disabled).toBe(true);
    setText(github.getByTestId("cr-github-org-0"), "example-org");
    fireEvent.click(github.getByTestId("cr-github-orgs-add"));
    const second = await github.findByTestId("cr-github-org-1");
    await waitFor(() => expect(document.activeElement).toBe(second));
    setText(second, " another-org ");
    await waitFor(() => expect(saveButton(github).disabled).toBe(false));
    fireEvent.click(saveButton(github));
    await waitFor(() => expect(github.getByTestId("cr-github-orgs-result").textContent).toBe("Saved. Restart butchr to use them."));
    expect(calls.settings).toEqual([["BUTCHR_GITHUB_ORGS", "example-org,another-org", false]]);

    fireEvent.click(view.getByTestId("cr-restart-button"));
    fireEvent.click(await view.findByTestId("cr-restart-confirm"));
    await waitFor(() => expect(view.getByTestId("cr-restart-done").textContent).toContain("butchr is back"), { timeout: 4000 });
    expect(calls.restarts).toBe(1);
  });

  test("− removes an org and hands focus to the row that takes its place; an empty list can't be saved", async () => {
    const { api, calls } = recordingApi(withOrgs(["acme", "octocat"]));
    const view = mount(api);
    const github = within(await view.findByTestId("cr-github"));
    expect(orgValues(github)).toEqual(["acme", "octocat"]);
    expect(saveButton(github).disabled).toBe(true);
    expect(github.getByTestId("cr-github-org-0-remove").getAttribute("aria-label")).toBe("Remove acme");

    fireEvent.click(github.getByTestId("cr-github-org-0-remove"));
    await waitFor(() => expect(orgValues(github)).toEqual(["octocat"]));
    await waitFor(() => expect(document.activeElement).toBe(github.getByTestId("cr-github-org-0")));
    expect(saveButton(github).disabled).toBe(false);

    fireEvent.click(github.getByTestId("cr-github-org-0-remove"));
    await waitFor(() => expect(orgValues(github)).toEqual([]));
    await waitFor(() => expect(document.activeElement).toBe(github.getByTestId("cr-github-orgs-add")));
    expect(github.getByTestId("cr-github-orgs-empty").textContent).toBe("GitHub needs at least one organization. Add one to save.");
    expect(saveButton(github).disabled).toBe(true);

    fireEvent.click(github.getByTestId("cr-github-orgs-add"));
    setText(await github.findByTestId("cr-github-org-0"), "example-org");
    await waitFor(() => expect(saveButton(github).disabled).toBe(false));
    fireEvent.click(saveButton(github));
    await waitFor(() => expect(calls.settings).toEqual([["BUTCHR_GITHUB_ORGS", "example-org", false]]));
  });

  test("a name GitHub can't have, or one already listed, is flagged on its row and blocks Save; a blank row is just dropped", async () => {
    const view = mount(recordingApi(withOrgs(["acme"])).api);
    const github = within(await view.findByTestId("cr-github"));
    fireEvent.click(github.getByTestId("cr-github-orgs-add"));
    const second = await github.findByTestId("cr-github-org-1");

    setText(second, "Acme");
    await waitFor(() => expect(github.getByTestId("cr-github-org-1-error").textContent).toBe("Already in the list."));
    expect(second.getAttribute("aria-invalid")).toBe("true");
    expect(saveButton(github).disabled).toBe(true);

    setText(second, "has space");
    await waitFor(() => expect(github.getByTestId("cr-github-org-1-error").textContent).toBe("Use letters, digits and hyphens, up to 39 characters, starting with a letter or digit."));
    expect(saveButton(github).disabled).toBe(true);

    setText(second, "");
    await waitFor(() => expect(github.queryByTestId("cr-github-org-1-error")).toBeNull());
    expect(saveButton(github).disabled).toBe(true); // still just ["acme"]

    setText(second, "octocat");
    await waitFor(() => expect(saveButton(github).disabled).toBe(false));
  });

  test("orgs saved but not running yet: the card says what butchr still uses, and the banner offers the restart even after a reload", async () => {
    const { api, calls } = recordingApi(withOrgs(["example-org", "another-org"], ["acme"]));
    const view = mount(api);
    const github = within(await view.findByTestId("cr-github"));
    expect(github.getByTestId("cr-github-orgs-pending").textContent).toBe("butchr is still using acme until it restarts.");
    expect(view.getByTestId("cr-restart-banner").textContent).toContain("You changed the GitHub organizations.");
    // The test checks the saved list, the one on the card.
    fireEvent.click(github.getByTestId("cr-github-test-button"));
    await waitFor(() => expect(github.getByTestId("cr-github-test-result").textContent).toBe("Signed in as octocat. Can see example-org, another-org."));

    fireEvent.click(view.getByTestId("cr-restart-button"));
    fireEvent.click(await view.findByTestId("cr-restart-confirm"));
    await waitFor(() => expect(view.getByTestId("cr-restart-done").textContent).toContain("butchr is back"), { timeout: 4000 });
    expect(calls.restarts).toBe(1);
    expect(view.queryByTestId("cr-restart-banner")).toBeNull();
  });

  test("+ stops at 20 organizations, butchr's limit", async () => {
    const view = mount(recordingApi(withOrgs(Array.from({ length: 20 }, (_, i) => `org${i}`))).api);
    const github = within(await view.findByTestId("cr-github"));
    expect((github.getByTestId("cr-github-orgs-add") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(github.getByTestId("cr-github-org-19-remove"));
    await waitFor(() => expect((github.getByTestId("cr-github-orgs-add") as HTMLButtonElement).disabled).toBe(false));
  });

  test("replacing the Atlassian token goes through the rotation API and names the account", async () => {
    let received: unknown;
    const setupApi = createFixturesSetupApi({ status: { configured: true }, nextResult: defaultSetupSuccess({ rotated: true, displayName: "JW" }) });
    const view = mount(recordingApi().api, { ...setupApi, rotateToken: async (input) => { received = input; return setupApi.rotateToken(input); } });
    const atlassian = within(await view.findByTestId("cr-atlassian"));
    fireEvent.click(atlassian.getByTestId("cr-atlassian-open"));
    setText(atlassian.getByTestId("cr-atlassian-token"), "atl-new");
    fireEvent.click(atlassian.getByTestId("cr-atlassian-save"));
    await waitFor(() => expect(atlassian.getByTestId("cr-atlassian-result").textContent).toBe("Saved. It belongs to JW. Restart butchr to use it."));
    expect(received).toEqual({ token: "atl-new" });
  });

  test("a literal Atlassian token and env-set orgs are shown read-only", async () => {
    const fixture = localUiSettingsFixture();
    const credentials = fixture.credentials!;
    fixture.credentials = {
      ...credentials,
      atlassian: { ...credentials.atlassian, token: { ...credentials.atlassian.token, source: "env-literal", path: null, readOnlyReason: "ATLASSIAN_TOKEN is set directly in butchr's environment." } },
      github: { ...credentials.github, orgs: ["envorg"], orgsSource: "environment", orgsEditable: false },
    };
    const view = mount(recordingApi(fixture).api);
    expect((await view.findByTestId("cr-atlassian-readonly")).textContent).toContain("ATLASSIAN_TOKEN");
    expect(view.queryByTestId("cr-atlassian-open")).toBeNull();
    expect(view.getByTestId("cr-github-orgs-readonly").textContent).toBe("Organizations: envorg (set in butchr's environment, BUTCHR_GITHUB_ORGS).");
  });

  test("the GitHub test reports the login and which orgs the token can see", async () => {
    const api = createFixturesSettingsApi({ response: localUiSettingsFixture(), nextGithubTest: { ok: false, login: "octocat", httpStatusClass: "2xx", error: "x", orgs: [{ org: "acme", ok: true, httpStatusClass: "2xx" }, { org: "nope", ok: false, httpStatusClass: "other" }] } });
    const view = mount(api);
    const github = within(await view.findByTestId("cr-github"));
    fireEvent.click(github.getByTestId("cr-github-test-button"));
    await waitFor(() => expect(github.getByTestId("cr-github-test-result").textContent).toBe("Signed in as octocat. Can see acme. Can't see nope."));
  });
});

describe("Settings: Zendesk and Trello cards", () => {
  function providerApi(response: SettingsResponse = localUiSettingsFixture()) {
    const base = createFixturesSettingsApi({ response });
    const calls = { zendesk: [] as unknown[], trello: [] as unknown[], settings: [] as unknown[][] };
    const api: SettingsApi = {
      ...base,
      writeZendeskToken: async (input) => { calls.zendesk.push(input); return base.writeZendeskToken(input); },
      writeTrelloCredentials: async (input) => { calls.trello.push(input); return base.writeTrelloCredentials(input); },
      writeSetting: async (key, value, confirm) => { calls.settings.push([key, value, confirm]); return base.writeSetting(key, value, confirm); },
    };
    return { api, calls };
  }

  test("both cards show where their credentials go, and their .env-only opt-ins", async () => {
    const view = mount(providerApi().api);
    const zendesk = within(await view.findByTestId("cr-zendesk"));
    expect(zendesk.getByTestId("cr-zendesk-token-status").textContent).toContain("Not set. Saving one writes /Users/you/.config/butchr/secrets/zendesk-oauth-token.");
    expect(zendesk.getByTestId("cr-zendesk-risk").textContent).toContain("BUTCHR_ZENDESK_ACCEPT_SHELL_CREDENTIAL_RISK=agents-can-read-the-zendesk-token");
    const trello = within(view.getByTestId("cr-trello"));
    expect(trello.getByText("trello-card rules")).toBeTruthy();
    expect(trello.getByTestId("cr-trello-risk").textContent).toContain("BUTCHR_TRELLO_ACCEPT_SHELL_CREDENTIAL_RISK=agents-can-read-the-trello-credentials");
    expect(trello.getByTestId("cr-trello-key-status").textContent).toContain("secrets/trello-api-key");
    expect(trello.getByTestId("cr-trello-open").textContent).toBe("Set key and token");
    // The table below doesn't repeat what the cards show.
    expect(view.queryByText("ZENDESK_SUBDOMAIN")).toBeNull();
    expect(view.queryByText("TRELLO_TOKEN_FILE")).toBeNull();
  });

  test("saving the Zendesk subdomain writes ZENDESK_SUBDOMAIN, then the token form sends exactly the token", async () => {
    const { api, calls } = providerApi();
    const view = mount(api);
    const zendesk = within(await view.findByTestId("cr-zendesk"));
    setText(zendesk.getByTestId("cr-zendesk-subdomain"), " acme ");
    await waitFor(() => expect((zendesk.getByTestId("cr-zendesk-subdomain-save") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(zendesk.getByTestId("cr-zendesk-subdomain-save"));
    await waitFor(() => expect(zendesk.getByTestId("cr-zendesk-subdomain-result").textContent).toBe("Saved. Restart butchr to use it."));
    expect(calls.settings).toEqual([["ZENDESK_SUBDOMAIN", "acme", false]]);

    fireEvent.click(zendesk.getByTestId("cr-zendesk-open"));
    setText(zendesk.getByTestId("cr-zendesk-token"), "zd-secret");
    fireEvent.click(zendesk.getByTestId("cr-zendesk-save"));
    await waitFor(() => expect(zendesk.getByTestId("cr-zendesk-result").textContent).toBe("Saved. It belongs to agent@example.com. Restart butchr to use it."));
    expect(calls.zendesk).toEqual([{ token: "zd-secret" }]);
    expect(view.getByTestId("cr-restart-banner").textContent).toContain("the Zendesk subdomain and the Zendesk token");
    expect(view.container.innerHTML).not.toContain("zd-secret");
  });

  test("the Trello form needs both the key and the token, sends them together, and clears them", async () => {
    const { api, calls } = providerApi();
    const view = mount(api);
    const trello = within(await view.findByTestId("cr-trello"));
    fireEvent.click(trello.getByTestId("cr-trello-open"));
    const key = trello.getByTestId("cr-trello-key") as HTMLInputElement;
    expect(key.type).toBe("password");
    setText(key, "tr-key");
    expect((trello.getByTestId("cr-trello-save") as HTMLButtonElement).disabled).toBe(true);
    setText(trello.getByTestId("cr-trello-token"), "tr-token");
    await waitFor(() => expect((trello.getByTestId("cr-trello-save") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(trello.getByTestId("cr-trello-save"));
    await waitFor(() => expect(trello.getByTestId("cr-trello-result").textContent).toBe("Saved. They belong to butchr-bot. Restart butchr to use them."));
    expect(calls.trello).toEqual([{ apiKey: "tr-key", token: "tr-token" }]);
    expect(trello.queryByTestId("cr-trello-key")).toBeNull();
    expect(view.container.innerHTML).not.toContain("tr-token");
  });

  test("a saved Zendesk subdomain butchr isn't using yet says what it still uses, until this page saves another", async () => {
    const fixture = localUiSettingsFixture();
    fixture.credentials = { ...fixture.credentials!, zendesk: { ...fixture.credentials!.zendesk, subdomain: { value: "newco", source: "file", editable: true, running: "oldco" } } };
    const { api } = providerApi(fixture);
    const view = mount(api);
    const zendesk = within(await view.findByTestId("cr-zendesk"));
    expect(zendesk.getByTestId("cr-zendesk-subdomain-pending").textContent).toBe("butchr is still using oldco until it restarts.");
    expect(view.getByTestId("cr-restart-banner").textContent).toContain("You changed the Zendesk subdomain.");
    setText(zendesk.getByTestId("cr-zendesk-subdomain"), "thirdco");
    await waitFor(() => expect((zendesk.getByTestId("cr-zendesk-subdomain-save") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(zendesk.getByTestId("cr-zendesk-subdomain-save"));
    await waitFor(() => expect(zendesk.getByTestId("cr-zendesk-subdomain-result").textContent).toBe("Saved. Restart butchr to use it."));
    expect(zendesk.queryByTestId("cr-zendesk-subdomain-pending")).toBeNull();
  });

  test("the test buttons report the account, and Trello's board", async () => {
    const view = mount(providerApi().api);
    const trello = within(await view.findByTestId("cr-trello"));
    fireEvent.click(trello.getByTestId("cr-trello-test-button"));
    await waitFor(() => expect(trello.getByTestId("cr-trello-test-result").textContent).toBe('Signed in as butchr-bot. Can see the board "Support".'));
    const zendesk = within(view.getByTestId("cr-zendesk"));
    fireEvent.click(zendesk.getByTestId("cr-zendesk-test-button"));
    await waitFor(() => expect(zendesk.getByTestId("cr-zendesk-test-result").textContent).toBe("Signed in as agent@example.com."));
  });
});
