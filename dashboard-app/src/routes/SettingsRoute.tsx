/**
 * FACTORY-664 (epic FACTORY-659, slice S1, READ-ONLY) — the Settings route:
 * a read-only table of daemon settings (secrets redacted) plus a Jira
 * connection card with a Test connection action. Accepts an optional `api`
 * override so a test can hand this a `createFixturesSettingsApi({...})`
 * built for exactly the scenario it wants, same pattern as `RulesRoute`.
 */
import { Heading } from "@launchpad-ui/components";
import { realSettingsApi, type SettingsApi } from "../api/settings.js";
import { useSettings } from "../hooks/use-settings.js";
import { PollStatusView } from "../components/PollStatusView.js";
import { SettingsTable } from "../components/SettingsTable.js";
import { JiraConnectionCard } from "../components/JiraConnectionCard.js";
import { DaemonRestartControl } from "../components/DaemonRestartControl.js";
import { buildSettingsViewModel } from "../view-model/settings-view.js";

export interface SettingsRouteProps {
  api?: SettingsApi;
}

export function SettingsRoute({ api = realSettingsApi }: SettingsRouteProps) {
  const state = useSettings(api);

  return (
    <section aria-labelledby="settings-heading">
      <Heading id="settings-heading" size="small">
        Settings
      </Heading>
      <PollStatusView state={state} label="/api/settings">
        {(data) => {
          const vm = buildSettingsViewModel(data);
          return (
            <>
              <SettingsTable
                rows={vm.rows}
                onSaveSetting={(key, value, confirm) => api.writeSetting(key, value, confirm).then(() => undefined)}
              />
              <JiraConnectionCard api={api} site={vm.jiraSite} email={vm.jiraEmail} tokenFile={vm.tokenFile} />
              {vm.unitHintText !== null && (
                <p data-testid="settings-unit-hint" style={{ marginTop: "1rem", fontSize: "0.8rem", opacity: 0.8 }}>
                  environment source: {vm.unitHintText}
                </p>
              )}
              <DaemonRestartControl
                restart={() => api.restartDaemon()}
                waitUntilBackUp={async () => {
                  // Simple backoff poll of /api/settings — the ticket's own
                  // "expect a dropped connection; the UI waits and
                  // reconnects" requirement. Gives up after ~30s, which the
                  // control surfaces as its own error state (never a silent
                  // hang).
                  const delaysMs = [500, 1000, 2000, 2000, 4000, 4000, 8000, 8000];
                  for (const delayMs of delaysMs) {
                    await new Promise((r) => setTimeout(r, delayMs));
                    try {
                      await api.listSettings();
                      return;
                    } catch { /* not back up yet — keep polling */ }
                  }
                  throw new Error("timed out waiting for the daemon to come back up");
                }}
              />
            </>
          );
        }}
      </PollStatusView>
    </section>
  );
}
