/**
 * local/ui — the Status page at `/`: what used to be the Daemon page, plus
 * the Dashboard page's build and health header. butchr's own health
 * (`/health`) beside its log tail (`/api/daemon/logs`), and the Reload rules
 * and Restart butchr actions. Its agents have their own page (`/agents`,
 * `AgentsRoute`). `/daemon` redirects here (App.tsx).
 */
import { useRef } from "react";
import { Heading } from "@launchpad-ui/components";
import { realDaemonApi, type DaemonApi } from "../api/daemon.js";
import { realSettingsApi, type SettingsApi } from "../api/settings.js";
import { useHealth } from "../hooks/use-health.js";
import { useDaemonLogs } from "../hooks/use-daemon-logs.js";
import { PollStatusView } from "../components/PollStatusView.js";
import { HealthCard } from "../components/status/HealthCard.js";
import { LogsCard } from "../components/status/LogsCard.js";
import { DaemonActions } from "../components/status/DaemonActions.js";
import "../components/status/Status.css";

export interface StatusRouteProps {
  daemonApi?: DaemonApi;
  settingsApi?: SettingsApi;
  /** Reads `/health`'s `build.startedAt`, to tell a restarted butchr from the one that was asked to restart. */
  readStartedAt?: () => Promise<string | undefined>;
  /** The waits between "is it back yet?" checks after a restart. */
  restartPollDelaysMs?: readonly number[];
}

async function fetchStartedAt(): Promise<string | undefined> {
  const res = await fetch("/health");
  const body = (await res.json()) as { build?: { startedAt?: string } };
  return body.build?.startedAt;
}

export function StatusRoute({
  daemonApi = realDaemonApi,
  settingsApi = realSettingsApi,
  readStartedAt = fetchStartedAt,
  restartPollDelaysMs = [500, 1000, 2000, 2000, 4000, 4000, 8000, 8000],
}: StatusRouteProps) {
  const health = useHealth();
  const logs = useDaemonLogs(daemonApi);
  const startedBefore = useRef<string | undefined>(undefined);

  async function restart() {
    startedBefore.current = await readStartedAt().catch(() => undefined);
    await settingsApi.restartDaemon();
  }

  async function waitUntilBackUp() {
    for (const delayMs of restartPollDelaysMs) {
      await new Promise((r) => setTimeout(r, delayMs));
      try {
        const startedAt = await readStartedAt();
        // The old process can still answer for a moment after it's asked to restart.
        if (startedAt !== undefined && startedAt !== startedBefore.current) return;
      } catch { /* not back yet */ }
    }
    throw new Error("timed out waiting for butchr to come back");
  }

  return (
    <section aria-labelledby="status-heading" className="st-page">
      <div className="st-page__header">
        <Heading id="status-heading" size="small">
          Status
        </Heading>
        <DaemonActions reload={() => daemonApi.reload()} restart={restart} waitUntilBackUp={waitUntilBackUp} />
      </div>
      <div className="st-grid">
        <div className="st-grid__side">
          <PollStatusView state={health} label="/health">
            {(data) => <HealthCard health={data} now={Date.now()} />}
          </PollStatusView>
        </div>
        <div className="st-grid__main">
          <LogsCard state={logs} tall />
        </div>
      </div>
    </section>
  );
}
