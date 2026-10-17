/**
 * local/ui — the Status page's agents card: the old Dashboard page's rows
 * (upstream's `AgentRowCard`/`WithheldRowCard`, unchanged), with the
 * admission census reduced to one line plus a disclosure. Everything shown
 * comes from `buildDashboardViewModel`; this only arranges it.
 */
import type { ReactNode } from "react";
import { Alert, AlertText, Heading, Text } from "@launchpad-ui/components";
import type { AgentRowView, DashboardViewModel } from "../../view-model/dashboard-view.js";
import { AgentRowCard } from "../AgentRowCard.js";
import { WithheldRowCard } from "../WithheldRowCard.js";

/** `actions`: what goes at the end of each running agent's row (the Agents page's Stop and menu). */
export function AgentsCard({ vm, actions }: { vm: DashboardViewModel; actions?: (row: AgentRowView) => ReactNode }) {
  const { banner, admission, rows } = vm;
  const running = rows.filter((r) => r.kind === "agent").length;
  const waiting = rows.length - running;
  const uncheckedSources = admission.sources.filter((s) => !s.checked).length;
  return (
    <section className="st-card" aria-labelledby="st-agents-title" data-testid="status-agents">
      <header className="st-card__header">
        <Heading level={2} id="st-agents-title" className="st-card__title">
          Agents
        </Heading>
        <Text size="small" className="st-muted" data-testid="status-agents-summary">
          {running} running{waiting ? ` · ${waiting} waiting for a slot` : ""} · cap {admission.cap}
        </Text>
      </header>
      <div className="st-card__body">
        {banner.checked ? (
          <Text elementType="p" size="small" className="st-muted" data-testid="dashboard-banner">
            {banner.text}
          </Text>
        ) : (
          <Alert status="warning" variant="inline" data-testid="dashboard-banner">
            <AlertText>
              {banner.text} {banner.rowsCarriedNote}
            </AlertText>
          </Alert>
        )}
        {rows.length === 0 ? (
          <Text elementType="p" className="st-empty" data-testid="status-no-agents">
            {banner.emptyFindingText ?? "No agents are running."}
          </Text>
        ) : (
          <div id="rows" className="st-rows">
            {rows.map((row) =>
              row.kind === "agent" ? (
                actions ? (
                  <div key={row.resourceKey} className="ag-row">
                    <AgentRowCard row={row} />
                    {actions(row)}
                  </div>
                ) : (
                  <AgentRowCard key={row.resourceKey} row={row} />
                )
              ) : (
                <WithheldRowCard key={row.resourceKey} row={row} />
              ),
            )}
          </div>
        )}
        <details className="st-details" data-testid="status-admission">
          <summary>
            {admission.residencyKnown ? `Capacity: ${admission.residencyText} of ${admission.cap} worker slots in use` : `Capacity: running workers not counted yet (cap ${admission.cap})`}
            {admission.sentinelsKnown && admission.sentinelsText !== "0" ? `, plus ${admission.sentinelsText} sentinel${admission.sentinelsText === "1" ? "" : "s"}` : ""}
            {uncheckedSources ? ` · ${uncheckedSources} source${uncheckedSources === 1 ? "" : "s"} couldn't be checked` : ""}
          </summary>
          <ul className="st-plain-list">
            {admission.sources.length === 0 ? (
              <li>no census sources declared</li>
            ) : (
              admission.sources.map((s) => (
                <li key={s.source} data-source={s.source} className={s.checked ? undefined : "st-warning"}>
                  {s.text}
                </li>
              ))
            )}
          </ul>
        </details>
      </div>
    </section>
  );
}
