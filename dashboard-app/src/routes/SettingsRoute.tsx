/**
 * FACTORY-664 (epic FACTORY-659, slice S1, READ-ONLY) — the Settings route:
 * a read-only table of daemon settings (secrets redacted) plus a Jira
 * connection card with a Test connection action. Accepts an optional `api`
 * override so a test can hand this a `createFixturesSettingsApi({...})`
 * built for exactly the scenario it wants, same pattern as `RulesRoute`.
 */
import { Heading } from "@launchpad-ui/components";
import { realSettingsApi, type SettingsApi } from "../api/settings.js";
import { realSetupApi, type SetupApi } from "../api/setup.js";
import { useSettings } from "../hooks/use-settings.js";
import { PollStatusView } from "../components/PollStatusView.js";
import { SettingsTable } from "../components/SettingsTable.js";
import { JiraConnectionCard } from "../components/JiraConnectionCard.js";
import { buildSettingsViewModel } from "../view-model/settings-view.js";

export interface SettingsRouteProps {
  api?: SettingsApi;
  /** FACTORY-665 (PR-2): powers the Jira connection card's token-rotation control. */
  setupApi?: SetupApi;
}

export function SettingsRoute({ api = realSettingsApi, setupApi = realSetupApi }: SettingsRouteProps) {
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
              <SettingsTable rows={vm.rows} />
              <JiraConnectionCard api={api} site={vm.jiraSite} email={vm.jiraEmail} tokenFile={vm.tokenFile} setupApi={setupApi} />
              {vm.unitHintText !== null && (
                <p data-testid="settings-unit-hint" style={{ marginTop: "1rem", fontSize: "0.8rem", opacity: 0.8 }}>
                  environment source: {vm.unitHintText}
                </p>
              )}
            </>
          );
        }}
      </PollStatusView>
    </section>
  );
}
