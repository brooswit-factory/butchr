/**
 * FACTORY-615: one withheld-ticket row — `dashboard-page.ts`'s
 * `renderWithheldRow`, ported the same way `AgentRowCard.tsx` ports the
 * agent row. Structurally distinct from `AgentRowCard` (dashed border,
 * "waiting for a slot" pill, the not-applicable marker, no terminal link,
 * no config back-link) per the three-absence contract the view-model
 * already enforces by TYPE — this component never has a `pane`/`agentStatus`/
 * `configHref` field to accidentally render.
 */
import { LinkButton, Text } from "@launchpad-ui/components";
import { NOT_APPLICABLE_LABEL, type WithheldRowView } from "../view-model/dashboard-view.js";
import { StatusPill } from "./StatusPill.js";
import "./DashboardRows.css";

export interface WithheldRowCardProps {
  row: WithheldRowView;
}

export function WithheldRowCard({ row }: WithheldRowCardProps) {
  return (
    <div className="dashboard-row dashboard-row--withheld" data-testid="withheld-row">
      <Text elementType="span" bold className="dashboard-row__key">
        {row.resourceKey}
      </Text>
      <Text elementType="span" size="small" className={row.tier.cnc ? "dashboard-row__tier dashboard-row__tier--cnc" : "dashboard-row__tier"}>
        {row.tier.cnc ? "COULD NOT CHECK" : row.tier.text}
      </Text>
      <StatusPill statusClass="waiting" label="waiting for a slot" />
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
        data-source={row.source}
      >
        {row.freshness.text}
      </Text>
      <Text elementType="span" size="small" title={row.notApplicableReason} className="dashboard-row__na">
        {NOT_APPLICABLE_LABEL}
      </Text>
      <LinkButton href={row.resourceHref} size="small" variant="minimal">
        resource
      </LinkButton>
    </div>
  );
}
