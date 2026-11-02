/**
 * FACTORY-664 (epic FACTORY-659, slice S1, READ-ONLY) — the Settings route:
 * a read-only table of daemon settings (secrets redacted) plus a Jira
 * connection card with a Test connection action. Accepts an optional `api`
 * override so a test can hand this a `createFixturesSettingsApi({...})`
 * built for exactly the scenario it wants, same pattern as `RulesRoute`.
 */
import { useState } from "react";
import { Heading, Text } from "@launchpad-ui/components";
import { settingsApi, type SettingsApi } from "../api/settings.js";
import { setupApi as defaultSetupApi, type SetupApi } from "../api/setup.js";
import { useSettings } from "../hooks/use-settings.js";
import { PollStatusView } from "../components/PollStatusView.js";
import { SettingsTable } from "../components/SettingsTable.js";
import { JiraConnectionCard } from "../components/JiraConnectionCard.js";
import { DaemonRestartControl } from "../components/DaemonRestartControl.js";
import { buildSettingsViewModel } from "../view-model/settings-view.js";
import { CredentialsSection } from "../components/settings-credentials/CredentialsSection.js";
import { SettingsSections } from "../components/settings/SettingsSections.js";

/** local/ui — keys the Credentials section shows (and edits), so the table below doesn't repeat them. */
const CREDENTIAL_KEYS = new Set([
  "ATLASSIAN_SITE",
  "ATLASSIAN_EMAIL",
  "ATLASSIAN_TOKEN",
  "GITHUB_TOKEN_FILE",
  "BUTCHR_GITHUB_ORGS",
  "ZENDESK_SUBDOMAIN",
  "ZENDESK_OAUTH_TOKEN_FILE",
  "BUTCHR_ZENDESK_ACCEPT_SHELL_CREDENTIAL_RISK",
  "TRELLO_BOARD_ID",
  "TRELLO_API_KEY_FILE",
  "TRELLO_TOKEN_FILE",
  "BUTCHR_TRELLO_ACCEPT_SHELL_CREDENTIAL_RISK",
]);

export interface SettingsRouteProps {
  api?: SettingsApi;
  /** FACTORY-665 (PR-2): powers the Jira connection card's token-rotation control. */
  setupApi?: SetupApi;
}

export function SettingsRoute({ api = settingsApi, setupApi = defaultSetupApi }: SettingsRouteProps) {
  const state = useSettings(api);
  // local/ui: what the daemon-settings sections saved since the last restart, for the one restart banner (in Providers).
  const [settingChanges, setSettingChanges] = useState<string[]>([]);

  // Simple backoff poll of /api/settings — the ticket's own "expect a dropped
  // connection; the UI waits and reconnects" requirement. Gives up after ~30s,
  // which the restart controls surface as their own error state (never a
  // silent hang).
  // local/ui: given the start time of the daemon being restarted, an answer
  // from that same process (it lingers a moment after the restart request)
  // doesn't count as "back".
  async function waitUntilBackUp(previousStartedAt?: string) {
    const delaysMs = [500, 1000, 2000, 2000, 4000, 4000, 8000, 8000];
    for (const delayMs of delaysMs) {
      await new Promise((r) => setTimeout(r, delayMs));
      try {
        const response = await api.listSettings();
        if (previousStartedAt !== undefined && response.credentials?.restart.startedAt === previousStartedAt) continue;
        return;
      } catch { /* not back up yet — keep polling */ }
    }
    throw new Error("timed out waiting for the daemon to come back up");
  }

  return (
    <section aria-labelledby="settings-heading">
      <Heading id="settings-heading" size="small">
        Settings
      </Heading>
      <PollStatusView state={state} label="/api/settings">
        {(data) => {
          const vm = buildSettingsViewModel(data);
          // local/ui: a butchr that sends `credentials` gets the Credentials section at the top instead of the Jira card.
          const rows = data.credentials ? vm.rows.filter((r) => !CREDENTIAL_KEYS.has(r.key)) : vm.rows;
          // local/ui: a butchr with the Providers section gets the grouped settings below it, and its restart
          // banner covers both; the restart button at the bottom moved to the Status page.
          if (data.credentials) {
            const credentials = data.credentials;
            return (
              <>
                <CredentialsSection
                  credentials={credentials}
                  api={api}
                  setupApi={setupApi}
                  restartAndWait={async () => {
                    await api.restartDaemon();
                    await waitUntilBackUp(credentials.restart.startedAt);
                  }}
                  otherChanges={settingChanges}
                  onRestarted={() => setSettingChanges([])}
                />
                <SettingsSections
                  rows={rows}
                  onSaveSetting={(key, value, confirm) => api.writeSetting(key, value, confirm).then(() => undefined)}
                  onChanged={(what) => setSettingChanges((prev) => (prev.includes(what) ? prev : [...prev, what]))}
                />
                {vm.unitHintText !== null && (
                  <Text elementType="p" size="small" className="sg-muted" data-testid="settings-unit-hint">
                    environment source: {vm.unitHintText}
                  </Text>
                )}
              </>
            );
          }
          return (
            <>
              <SettingsTable
                rows={rows}
                onSaveSetting={(key, value, confirm) => api.writeSetting(key, value, confirm).then(() => undefined)}
              />
              <JiraConnectionCard api={api} site={vm.jiraSite} email={vm.jiraEmail} tokenFile={vm.tokenFile} setupApi={setupApi} />
              {vm.unitHintText !== null && (
                <p data-testid="settings-unit-hint" style={{ marginTop: "1rem", fontSize: "0.8rem", opacity: 0.8 }}>
                  environment source: {vm.unitHintText}
                </p>
              )}
              <DaemonRestartControl restart={() => api.restartDaemon()} waitUntilBackUp={waitUntilBackUp} />
            </>
          );
        }}
      </PollStatusView>
    </section>
  );
}
