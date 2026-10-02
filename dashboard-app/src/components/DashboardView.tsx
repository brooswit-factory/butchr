/**
 * FACTORY-615: the real main-dashboard body — `dashboard-page.ts`'s whole
 * render function (build header, page banner, admission panel, rows, hint),
 * ported to real `@launchpad-ui/components` over the `DashboardViewModel`
 * `view-model/dashboard-view.ts` already computed. This component makes NO
 * decisions of its own about wording, staleness, or which link exists — it
 * only arranges data the view-model already settled, same discipline
 * `AgentRowCard`/`WithheldRowCard` follow.
 *
 * ROW IDENTITY (requirement 1): keyed on `row.resourceKey` — stable across
 * polls for the same agent/withheld ticket, so React only re-renders a row
 * whose own props actually changed, never the whole list on every 5s poll.
 *
 * COMPONENT MAPPING (PR description keeps this table too):
 *   page banner (known)   -> Text
 *   page banner (cnc)     -> Alert status="warning" (there is no dedicated
 *                            full-width "banner" component in
 *                            @launchpad-ui/components@0.25.0 — Alert is the
 *                            closest semantic match: a loud, dismissable-
 *                            capable callout)
 *   admission stat block  -> plain token-styled Text rows (no StatBlock
 *                            component in this version)
 *   configurations link   -> Link
 */
import { Alert, AlertText, Link, Text } from "@launchpad-ui/components";
import type { DashboardViewModel } from "../view-model/dashboard-view.js";
import { AgentRowCard } from "./AgentRowCard.js";
import { WithheldRowCard } from "./WithheldRowCard.js";
import "./DashboardView.css";

export interface DashboardViewProps {
  vm: DashboardViewModel;
}

export function DashboardView({ vm }: DashboardViewProps) {
  const { buildHeader, banner, admission, rows, configurationsHref } = vm;
  return (
    <div className="dashboard-view">
      <Text elementType="div" size="small" className="dashboard-view__hdrline" data-testid="dashboard-build-header">
        {buildHeader.buildText}
        {buildHeader.currencyText !== null ? ` · ${buildHeader.currencyText}` : ""}
      </Text>

      {banner.checked ? (
        <>
          <Text elementType="div" size="small" className="dashboard-view__pagefresh" data-testid="dashboard-banner">
            {banner.text}
          </Text>
          {banner.emptyFindingText !== null && (
            <Text elementType="div" size="small" className="dashboard-view__empty">
              {banner.emptyFindingText}
            </Text>
          )}
        </>
      ) : (
        <Alert status="warning" className="dashboard-view__banner" data-testid="dashboard-banner">
          <AlertText>
            {banner.text} {banner.rowsCarriedNote}
          </AlertText>
        </Alert>
      )}

      <div className="dashboard-view__admission">
        <Text elementType="div" size="small">
          admission cap: {admission.cap} · residency(workers):{" "}
          <span className={admission.residencyKnown ? "dashboard-view__known" : "dashboard-view__cnc"}>{admission.residencyText}</span> · sentinels:{" "}
          <span className={admission.sentinelsKnown ? "dashboard-view__known" : "dashboard-view__cnc"}>{admission.sentinelsText}</span>
        </Text>
        {admission.sources.length === 0 ? (
          <Text elementType="div" size="small" className="dashboard-view__cnc-muted">
            no census sources declared
          </Text>
        ) : (
          admission.sources.map((s) => (
            <Text elementType="div" size="small" key={s.source} data-source={s.source} className={s.checked ? "dashboard-view__known" : "dashboard-view__cnc"}>
              {s.text}
            </Text>
          ))
        )}
      </div>

      <div id="rows">
        {rows.map((row) => (row.kind === "agent" ? <AgentRowCard key={row.resourceKey} row={row} /> : <WithheldRowCard key={row.resourceKey} row={row} />))}
      </div>

      <Text elementType="div" size="small" className="dashboard-view__hint">
        &ldquo;open terminal&rdquo; attaches a terminal to that agent (fire-and-forget — a launch is not a confirmation a window appeared) · &ldquo;resource&rdquo;
        opens its Jira issue or Confluence project doc · refreshes automatically · <Link href={configurationsHref}>configurations</Link>
      </Text>
    </div>
  );
}
