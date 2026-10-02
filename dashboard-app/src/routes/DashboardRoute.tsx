/**
 * FACTORY-614 (task 2 of the LaunchPad switch): a placeholder ONLY — it
 * proves the data layer end to end (real fetch, real poll, real response
 * shape) by showing the live row count from `useDashboard()`. The REAL
 * dashboard UI (the agent rows, the admission panel, the build header) is
 * Task 3's job; this component must stay small so it is obviously not
 * mistaken for that.
 */
import { Heading, Text } from "@launchpad-ui/components";
import { useDashboard } from "../hooks/use-dashboard.js";
import { dashboardRowCount } from "../view-model/dashboard-availability.js";
import { availabilityText } from "../view-model/availability.js";
import { PollStatusView } from "../components/PollStatusView.js";

export function DashboardRoute() {
  const state = useDashboard();
  return (
    <section aria-labelledby="dashboard-heading">
      <Heading id="dashboard-heading" size="small">
        Dashboard
      </Heading>
      <Text elementType="p" size="small">
        Placeholder — proves the `/dashboard` data layer. The real dashboard view lands in Task 3.
      </Text>
      <PollStatusView state={state} label="/dashboard">
        {(data) => (
          <Text elementType="p" data-testid="dashboard-row-count">
            {availabilityText(dashboardRowCount(data), (n) => `${n} row(s)`)}
          </Text>
        )}
      </PollStatusView>
    </section>
  );
}
