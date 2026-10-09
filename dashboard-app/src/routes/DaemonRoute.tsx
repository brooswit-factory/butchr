/**
 * FACTORY-668 (epic FACTORY-659, slices C1 read / C2 write) — the daemon
 * health/logs page: `/health`'s own fields (liveness, build/version) via
 * the EXISTING `useHealth` hook (`../hooks/use-health.js`, no new server
 * API for this part), `GET /api/daemon/logs`'s bounded/redacted tail via
 * the new `useDaemonLogs`, a Reload control (`POST /api/daemon/reload`,
 * FACTORY-657's reload-in-place, newly exposed over HTTP), and the
 * EXISTING `DaemonRestartControl`/`SettingsApi.restartDaemon` reused
 * verbatim here rather than a second restart implementation, per this
 * ticket's own "reuse it, don't build another" instruction.
 */
import { Heading, Text } from "@launchpad-ui/components";
import { realDaemonApi, type DaemonApi } from "../api/daemon.js";
import { realSettingsApi, type SettingsApi } from "../api/settings.js";
import { useHealth } from "../hooks/use-health.js";
import { useDaemonLogs } from "../hooks/use-daemon-logs.js";
import { PollStatusView } from "../components/PollStatusView.js";
import { DaemonLogsView } from "../components/DaemonLogsView.js";
import { DaemonReloadControl } from "../components/DaemonReloadControl.js";
import { DaemonRestartControl } from "../components/DaemonRestartControl.js";

export interface DaemonRouteProps {
  api?: DaemonApi;
  settingsApi?: SettingsApi;
}

export function DaemonRoute({ api = realDaemonApi, settingsApi = realSettingsApi }: DaemonRouteProps) {
  const health = useHealth();
  const logs = useDaemonLogs(api);

  return (
    <section aria-labelledby="daemon-heading">
      <Heading id="daemon-heading" size="small">
        Daemon
      </Heading>
      <PollStatusView state={health} label="/health">
        {(data) => (
          <section data-testid="daemon-health-summary">
            <Text elementType="p" data-testid="daemon-health-ok">
              {data.ok ? "healthy" : "unhealthy"}
            </Text>
            {data.build && (
              <Text elementType="p" size="small" data-testid="daemon-build-info">
                version {data.build.version} · sha {data.build.sha ?? "unknown"} · pid {data.build.pid} · unit {data.build.unit}
              </Text>
            )}
            <ul data-testid="daemon-components">
              {data.components.map((c) => (
                <li key={c.name}>
                  {c.name}: {c.state}
                </li>
              ))}
            </ul>
          </section>
        )}
      </PollStatusView>

      <DaemonReloadControl reload={() => api.reload()} />
      <DaemonRestartControl
        restart={() => settingsApi.restartDaemon()}
        waitUntilBackUp={async () => {
          const delaysMs = [500, 1000, 2000, 2000, 4000, 4000, 8000, 8000];
          for (const delayMs of delaysMs) {
            await new Promise((r) => setTimeout(r, delayMs));
            try {
              await settingsApi.listSettings();
              return;
            } catch { /* not back up yet — keep polling */ }
          }
          throw new Error("timed out waiting for the daemon to come back up");
        }}
      />

      <Heading size="small">Logs</Heading>
      <PollStatusView state={logs} label="/api/daemon/logs">
        {(data) => <DaemonLogsView data={data} />}
      </PollStatusView>
    </section>
  );
}
