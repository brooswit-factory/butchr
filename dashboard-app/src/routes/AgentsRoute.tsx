/**
 * local/ui — the Agents page at `/agents`: every agent butchr runs (and any
 * waiting for a slot), from `/dashboard`. Each agent's row has Stop, and a
 * Jira ticket's agent a menu with Set priority and Put under a boss; Start a
 * ticket is in the header. Those replace upstream's separate agent control
 * panel, which the user asked to fold in (`components/agents/AgentActions`).
 */
import { useState } from "react";
import { Heading, Text } from "@launchpad-ui/components";
import { realAgentsApi, type AgentsApi } from "../api/agents.js";
import { useDashboard } from "../hooks/use-dashboard.js";
import { PollStatusView } from "../components/PollStatusView.js";
import { AgentsCard } from "../components/status/AgentsCard.js";
import { AgentRowActions, StartTicketButton } from "../components/agents/AgentActions.js";
import { buildDashboardViewModel } from "../view-model/dashboard-view.js";
import "../components/status/Status.css";
import "../components/agents/AgentActions.css";

export interface AgentsRouteProps {
  agentsApi?: AgentsApi;
}

export function AgentsRoute({ agentsApi = realAgentsApi }: AgentsRouteProps) {
  const dashboard = useDashboard();
  const [result, setResult] = useState<string | null>(null);
  return (
    <section aria-labelledby="agents-heading" className="st-page">
      <div className="st-page__header">
        <Heading id="agents-heading" size="small">
          Agents
        </Heading>
        <div className="st-actions">
          {result && (
            <Text size="small" className="st-ok" role="status" data-testid="agent-action-result">
              {result}
            </Text>
          )}
          <StartTicketButton api={agentsApi} onResult={setResult} />
        </div>
      </div>
      <PollStatusView state={dashboard} label="/dashboard">
        {(data) => (
          <AgentsCard
            vm={buildDashboardViewModel(data, {
              now: Date.now(),
              header: { build: null },
              terminalLinkHref: (pane) => `/agents/pane/${encodeURIComponent(pane)}/attach`,
              resourceLinkHref: (key) => `/resource/${encodeURIComponent(key)}/open`,
              // The rule's card on the Rules page (Configurations is gone; Rules shows the same and more).
              configLinkHref: (anchor) => `/rules#${anchor}`,
            })}
            actions={(row) => <AgentRowActions row={row} api={agentsApi} onResult={setResult} />}
          />
        )}
      </PollStatusView>
    </section>
  );
}
