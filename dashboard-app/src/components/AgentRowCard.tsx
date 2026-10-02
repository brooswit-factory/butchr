/**
 * FACTORY-615: one agent row — `dashboard-page.ts`'s `renderAgentRow`,
 * ported to real `@launchpad-ui/components` primitives over the plain
 * `AgentRowView` the view-model already computed (`view-model/dashboard-view.ts`).
 * Thin: every decision (tier wording, floor "at least" prefix, freshness
 * staleness, which links exist) was already made by the view-model: this
 * component only arranges it. React key stability for the "no visible
 * re-render on an unchanged row" requirement is the CALLER's job
 * (`DashboardView.tsx` keys the list on `resourceKey`), not this
 * component's.
 *
 * COMPONENT MAPPING (PR description keeps this table too):
 *   row card        -> plain token-styled <div> (no Card component in
 *                      @launchpad-ui/components@0.25.0 — see this file's
 *                      own CSS for the tokens used instead)
 *   status pill     -> ./StatusPill.tsx (same reason: no Badge/Lozenge)
 *   key / tier /
 *   pane / freshness -> Text
 *   links           -> LinkButton
 */
import { LinkButton, Text } from "@launchpad-ui/components";
import type { AgentRowView } from "../view-model/dashboard-view.js";
import { StatusPill } from "./StatusPill.js";
import "./DashboardRows.css";

export interface AgentRowCardProps {
  row: AgentRowView;
}

export function AgentRowCard({ row }: AgentRowCardProps) {
  return (
    <div className="dashboard-row dashboard-row--agent" id={row.anchorId} data-testid="agent-row">
      <Text elementType="span" bold className="dashboard-row__key">
        {row.displayKey}
      </Text>
      <Text elementType="span" size="small" className={row.tier.cnc ? "dashboard-row__tier dashboard-row__tier--cnc" : "dashboard-row__tier"}>
        {row.tier.cnc ? "COULD NOT CHECK" : row.tier.text}
      </Text>
      <StatusPill statusClass={row.statusClass} label={row.agentStatus} />
      <Text elementType="span" size="small" className="dashboard-row__pane">
        {row.pane}
      </Text>
      <div className="dashboard-row__floor" title={row.floor.title}>
        <span className="dashboard-row__floor-value">{row.floor.text}</span>
        {row.floor.inexactNote !== null && (
          <Text elementType="span" size="small" className="dashboard-row__inexact">
            {row.floor.inexactNote}
          </Text>
        )}
      </div>
      <Text
        elementType="span"
        size="small"
        title={row.freshness.title}
        className={row.freshness.stale ? "dashboard-row__freshness dashboard-row__freshness--stale" : "dashboard-row__freshness"}
      >
        {row.freshness.text}
      </Text>
      <LinkButton href={row.terminalHref} size="small" variant="minimal">
        open terminal
      </LinkButton>
      <LinkButton href={row.resourceHref} size="small" variant="minimal">
        resource
      </LinkButton>
      {row.configHref !== null && (
        <LinkButton href={row.configHref} size="small" variant="minimal">
          config
        </LinkButton>
      )}
    </div>
  );
}
