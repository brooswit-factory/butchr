/**
 * FACTORY-615 (task 3 of the LaunchPad switch, epic FACTORY-427): the REAL
 * main dashboard at `/dashboard-app/` — replaces FACTORY-614's placeholder.
 * Polls `/dashboard` (`useDashboard`, existing hook, unchanged cadence) and
 * `/health` (`useHealth`, new — `/dashboard`'s own response carries no
 * build/currency fields; see that hook's own header) and feeds both into
 * `buildDashboardViewModel` (`view-model/dashboard-view.ts`), which does
 * every actual rendering decision; this route only wires the two polls
 * together and hands the result to `DashboardView`.
 *
 * `PollStatusView` (unchanged, from Task 2) already satisfies "an initial
 * failure must show an error, never an empty healthy-looking page" (its
 * `error` branch) and "a refresh failure must keep the last good data on
 * screen marked STALE" (its `stale` branch renders a warning Alert ABOVE the
 * last-good `children(data)`) — that is a DIFFERENT staleness axis from
 * `DashboardResponse.checked` (the daemon's own agent-list poll, which
 * `buildDashboardViewModel`'s own page banner reads): our own `/dashboard`
 * fetch can fail independently of whether the daemon's last successful poll
 * was itself checked or declined. Both are shown; neither substitutes for
 * the other.
 */
import { Heading } from "@launchpad-ui/components";
import { useDashboard } from "../hooks/use-dashboard.js";
import { useHealth } from "../hooks/use-health.js";
import { PollStatusView } from "../components/PollStatusView.js";
import { DashboardView } from "../components/DashboardView.js";
import { AgentControlPanel } from "../components/AgentControlPanel.js";
import { realAgentsApi } from "../api/agents.js";
import { buildDashboardViewModel, type DashboardHeaderInfo } from "../view-model/dashboard-view.js";
import type { PollState } from "../view-model/poll-state.js";
import type { HealthStatus } from "../../../src/daemon/health.js";

/**
 * `/health` itself is a SEPARATE poll from `/dashboard` — its own transport
 * state (loading/error) never blocks the dashboard body from rendering;
 * header info is simply omitted (falls back to "build sha unknown") until
 * `/health` has returned at least once. See `useHealth`'s own header for why
 * a `503` here still carries a usable body.
 */
function headerFromHealth(state: PollState<HealthStatus>): DashboardHeaderInfo {
  if (state.kind !== "loaded" && state.kind !== "stale") return { build: null };
  const { build, currency } = state.data;
  return { build: build ?? null, ...(currency !== undefined ? { currency } : {}) };
}

export function DashboardRoute() {
  const dashboardState = useDashboard();
  const header = headerFromHealth(useHealth());

  return (
    <section aria-labelledby="dashboard-heading">
      <Heading id="dashboard-heading" size="small">
        Dashboard
      </Heading>
      <PollStatusView state={dashboardState} label="/dashboard">
        {(data) => {
          const vm = buildDashboardViewModel(data, {
            now: Date.now(),
            header,
            terminalLinkHref: (pane) => `/agents/pane/${encodeURIComponent(pane)}/attach`,
            resourceLinkHref: (key) => `/resource/${encodeURIComponent(key)}/open`,
            configLinkHref: (anchor) => `/configurations#${anchor}`,
          });
          return <DashboardView vm={vm} />;
        }}
      </PollStatusView>
      <AgentControlPanel api={realAgentsApi} canWrite />
    </section>
  );
}
