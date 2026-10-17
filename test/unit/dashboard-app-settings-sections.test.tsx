/**
 * local/ui — the Settings page's grouped daemon settings: which card each
 * setting lands in, read-only versus editable, saving (with the daemon's
 * confirm), and the one restart banner naming what changed.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { withDom } from "../setup/happy-dom.js";
import { SettingsRoute } from "../../dashboard-app/src/routes/SettingsRoute.js";
import { createFixturesSettingsApi, localUiSettingsFixture, SettingsWriteRefusedError, type SettingsApi } from "../../dashboard-app/src/api/settings.js";
import { createFixturesSetupApi } from "../../dashboard-app/src/api/setup.js";
import { changeName, groupSettings, sourceText } from "../../dashboard-app/src/view-model/settings-groups.js";
import { settingRowView } from "../../dashboard-app/src/view-model/settings-view.js";

withDom();
afterEach(cleanup);

function setText(input: HTMLElement, value: string) {
  fireEvent.input(input, { target: { value } });
  fireEvent.change(input, { target: { value } });
}

function mount(opts: { nextWriteError?: SettingsWriteRefusedError } = {}) {
  const base = createFixturesSettingsApi({ response: localUiSettingsFixture(), ...opts });
  const writes: unknown[][] = [];
  const api: SettingsApi = { ...base, writeSetting: async (key, value, confirm) => { writes.push([key, value, confirm]); return base.writeSetting(key, value, confirm); } };
  const view = render(<SettingsRoute api={api} setupApi={createFixturesSetupApi({ status: { configured: true } })} />);
  return { view, writes };
}

describe("Settings: grouped daemon settings", () => {
  test("each setting sits in its group with its name in words, its key and where its value comes from; nothing is repeated from Providers", async () => {
    const { view } = mount();
    const sections = within(await view.findByTestId("settings-sections"));
    const agents = within(sections.getByTestId("sg-group-agents"));
    const provider = within(agents.getByTestId("sg-row-BUTCHR_AGENT_PROVIDER"));
    expect(provider.getByText("Default harness")).toBeTruthy();
    expect(provider.getByText("claude")).toBeTruthy();
    // Set in butchr's environment, so it's shown, not edited, even though the key is on the allowlist.
    expect(provider.queryByRole("textbox")).toBeNull();
    expect(provider.getByText(/set in butchr's environment/)).toBeTruthy();
    expect(within(agents.getByTestId("sg-row-BUTCHR_MAX_AGENTS")).getByRole("textbox")).toBeTruthy();
    const daemon = within(sections.getByTestId("sg-group-daemon"));
    expect((daemon.getByTestId("sg-input-BUTCHR_POLL_STALE_MS") as HTMLInputElement).value).toBe("60000");
    expect(daemon.getByText(/saved from this page/)).toBeTruthy();
    expect(sections.queryByTestId("sg-row-ATLASSIAN_SITE")).toBeNull();
    expect(view.queryByTestId("daemon-restart-control")).toBeNull();
  });

  test("saving a setting writes just that key, says it applies after a restart, and the restart banner names it", async () => {
    const { view, writes } = mount();
    const input = await view.findByTestId("sg-input-BUTCHR_MAX_AGENTS");
    const save = view.getByTestId("sg-save-BUTCHR_MAX_AGENTS") as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    setText(input, " 12 ");
    await waitFor(() => expect(save.disabled).toBe(false));
    fireEvent.click(save);
    await waitFor(() => expect(view.getByTestId("sg-result-BUTCHR_MAX_AGENTS").textContent).toBe("Saved. butchr uses it after a restart."));
    expect(writes).toEqual([["BUTCHR_MAX_AGENTS", "12", false]]);
    expect(view.getByTestId("cr-restart-banner").textContent).toContain("You changed the agent cap.");
  });

  test("after a save, putting the old value back can be saved too (the daemon still reports its startup value until a restart)", async () => {
    const { view, writes } = mount();
    const input = await view.findByTestId("sg-input-BUTCHR_POLL_STALE_MS");
    const save = view.getByTestId("sg-save-BUTCHR_POLL_STALE_MS") as HTMLButtonElement;
    setText(input, "70000");
    await waitFor(() => expect(save.disabled).toBe(false));
    fireEvent.click(save);
    await waitFor(() => expect(view.getByTestId("sg-result-BUTCHR_POLL_STALE_MS").textContent).toContain("Saved."));
    await waitFor(() => expect(save.disabled).toBe(true)); // 70000 is now the saved value
    setText(input, "60000");
    await waitFor(() => expect(save.disabled).toBe(false));
    fireEvent.click(save);
    await waitFor(() => expect(writes).toEqual([["BUTCHR_POLL_STALE_MS", "70000", false], ["BUTCHR_POLL_STALE_MS", "60000", false]]));
  });

  test("a value past the daemon's safety ceiling asks to save anyway, then saves with the confirm", async () => {
    const { view, writes } = mount({ nextWriteError: new SettingsWriteRefusedError("BUTCHR_MAX_AGENTS above 32 needs a confirm", true) });
    setText(await view.findByTestId("sg-input-BUTCHR_MAX_AGENTS"), "40");
    fireEvent.click(view.getByTestId("sg-save-BUTCHR_MAX_AGENTS"));
    const confirm = within(await view.findByTestId("sg-confirm-BUTCHR_MAX_AGENTS"));
    expect(confirm.getByText("BUTCHR_MAX_AGENTS above 32 needs a confirm")).toBeTruthy();
    fireEvent.click(confirm.getByTestId("sg-confirm-button-BUTCHR_MAX_AGENTS"));
    await waitFor(() => expect(view.getByTestId("sg-result-BUTCHR_MAX_AGENTS").textContent).toContain("Saved."));
    expect(writes).toEqual([["BUTCHR_MAX_AGENTS", "40", false], ["BUTCHR_MAX_AGENTS", "40", true]]);
  });

  test("Rule types: each provider switch is named like Add rule names it, an environment value is shown, not switched, and flipping one saves it straight away", async () => {
    const { view, writes } = mount();
    const group = within(await view.findByTestId("sg-group-rule-types"));
    expect(group.getByText("Rule types")).toBeTruthy();
    const jira = within(group.getByTestId("sg-row-BUTCHR_PROVIDER_JIRA_WORK_ENABLED"));
    expect(jira.getByText("Jira tickets")).toBeTruthy();
    const jiraSwitch = jira.getByRole("switch") as HTMLInputElement;
    expect(jiraSwitch.checked).toBe(true); // butchr's default is on
    const prs = within(group.getByTestId("sg-row-BUTCHR_PROVIDER_GITHUB_PR_ENABLED"));
    expect(prs.getByText("GitHub pull requests")).toBeTruthy();
    expect((prs.getByRole("switch") as HTMLInputElement).checked).toBe(false); // saved off
    const trello = within(group.getByTestId("sg-row-BUTCHR_PROVIDER_TRELLO_CARD_ENABLED"));
    expect(trello.queryByRole("switch")).toBeNull();
    expect(trello.getByText("Off")).toBeTruthy();
    expect(trello.getByText(/set in butchr's environment/)).toBeTruthy();
    const atlassian = within(group.getByTestId("sg-row-BUTCHR_ATLASSIAN_ENABLED"));
    expect(atlassian.queryByRole("switch")).toBeNull();
    expect(atlassian.getByText("On (butchr's default)")).toBeTruthy();

    fireEvent.click(jiraSwitch);
    await waitFor(() => expect(view.getByTestId("sg-result-BUTCHR_PROVIDER_JIRA_WORK_ENABLED").textContent).toBe("Saved. butchr uses it after a restart."));
    expect(writes).toEqual([["BUTCHR_PROVIDER_JIRA_WORK_ENABLED", "false", false]]);
    expect(view.getByTestId("cr-restart-banner").textContent).toContain("You changed the Jira tickets switch.");
  });

  test("a switch the daemon refuses goes back to where it was and says why", async () => {
    const { view } = mount({ nextWriteError: new SettingsWriteRefusedError("BUTCHR_PROVIDER_JIRA_WORK_ENABLED must be \"true\" or \"false\"", false) });
    const row = within(await view.findByTestId("sg-row-BUTCHR_PROVIDER_JIRA_WORK_ENABLED"));
    const sw = row.getByRole("switch") as HTMLInputElement;
    fireEvent.click(sw);
    await waitFor(() => expect(view.getByTestId("sg-result-BUTCHR_PROVIDER_JIRA_WORK_ENABLED").textContent).toContain("must be"));
    expect(sw.checked).toBe(true);
  });

  test("groups keep their order, skip what isn't there, and put a setting they don't know under Other", () => {
    const rows = [
      { key: "BUTCHR_PORT", value: "7717", source: "environment" as const, restartNeeded: true as const, secret: false as const, editable: false, description: "port" },
      { key: "BUTCHR_SHINY_NEW", value: null, source: "default" as const, restartNeeded: true as const, secret: false as const, editable: false, description: "new upstream" },
      { key: "BUTCHR_MAX_AGENTS", value: null, source: "default" as const, restartNeeded: true as const, secret: false as const, editable: true, description: "cap" },
    ].map(settingRowView);
    const groups = groupSettings(rows);
    expect(groups.map((g) => [g.id, g.items.map((i) => i.label)])).toEqual([["agents", ["Agent cap"]], ["daemon", ["Port"]], ["other", ["BUTCHR_SHINY_NEW"]]]);
    expect(groups[2]!.items[0]!.help).toBe("new upstream");
    expect([sourceText({ source: "environment", editable: false }), sourceText({ source: "default", editable: true }), sourceText({ source: "file", editable: true })]).toEqual(["set in butchr's environment", "default; can be changed here", "saved from this page"]);
    expect([changeName(groups[0]!.items[0]!), changeName(groups[2]!.items[0]!)]).toEqual(["the agent cap", "BUTCHR_SHINY_NEW"]);
  });
});
