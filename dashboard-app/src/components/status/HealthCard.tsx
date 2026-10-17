/**
 * local/ui — the Status page's butchr card: whether it's healthy, which build
 * it runs and for how long, and how each of its loops is doing (`/health`).
 */
import { Heading, Link, Text } from "@launchpad-ui/components";
import { StatusIcon } from "@launchpad-ui/icons";
import type { HealthStatus } from "../../../../src/daemon/health.js";
import { agentsText, buildText, componentLabel, componentStateText, loopSummary, upstreamText, uptimeText } from "../../view-model/status-view.js";

export function HealthCard({ health, now }: { health: HealthStatus; now: number }) {
  const { build } = health;
  const uptime = build ? uptimeText(build.startedAt, now) : null;
  const upstream = upstreamText(health.currency);
  const loops = loopSummary(health.resourceLoops);
  return (
    <section className="st-card" aria-labelledby="st-health-title" data-testid="status-health">
      <header className="st-card__header">
        <Heading level={2} id="st-health-title" className="st-card__title">
          <StatusIcon kind={health.ok ? "success" : "error"} size="small" className={health.ok ? "st-icon--ok" : "st-icon--bad"} />
          {health.ok ? "Healthy" : "Unhealthy"}
        </Heading>
        {uptime && (
          <Text size="small" className="st-muted" data-testid="status-uptime">
            {uptime}
          </Text>
        )}
      </header>
      <div className="st-card__body">
        {build && (
          <dl className="st-facts" data-testid="status-build">
            <div>
              <dt>Version</dt>
              <dd>{build.version}</dd>
            </div>
            <div>
              <dt>Build</dt>
              <dd>
                <code>{buildText(build)}</code>
              </dd>
            </div>
            {upstream && (
              <div>
                <dt>Upstream</dt>
                <dd data-testid="status-upstream">{upstream}</dd>
              </div>
            )}
            <div>
              <dt>Started</dt>
              <dd>{new Date(build.startedAt).toLocaleString()}</dd>
            </div>
            {health.admission && (
              <div>
                <dt>Agents</dt>
                <dd data-testid="status-agent-count">
                  {agentsText(health.admission)} · <Link href="/agents">View agents</Link>
                </dd>
              </div>
            )}
            <div>
              <dt>Process</dt>
              <dd>
                pid {build.pid}
                {build.unit && build.unit !== "(none)" ? ` · ${build.unit}` : ""}
              </dd>
            </div>
          </dl>
        )}
        <div className="st-group">
          <Text elementType="h3" size="small" className="st-group__title">
            Loops
          </Text>
          <ul className="st-chips" data-testid="status-components">
            {health.components.map((c) => (
              <li key={c.name} className={c.ok ? "st-chip st-chip--ok" : "st-chip st-chip--bad"}>
                <StatusIcon kind={c.ok ? "success" : "error"} size="small" className={c.ok ? "st-icon--ok" : "st-icon--bad"} />
                {componentLabel(c.name)}
                <span className="st-chip__state">{componentStateText(c)}</span>
              </li>
            ))}
            {loops.running.map((l) => (
              <li key={l.name} className={l.ok ? "st-chip st-chip--ok" : "st-chip st-chip--bad"}>
                <StatusIcon kind={l.ok ? "success" : "error"} size="small" className={l.ok ? "st-icon--ok" : "st-icon--bad"} />
                {l.name} rules
                <span className="st-chip__state">{l.text}</span>
              </li>
            ))}
          </ul>
          {loops.off.length > 0 && (
            <details className="st-details" data-testid="status-loops-off">
              <summary>
                {loops.off.length} rule type{loops.off.length === 1 ? "" : "s"} with nothing to run
              </summary>
              <ul className="st-plain-list">
                {loops.off.map((l) => (
                  <li key={l.name}>
                    <strong>{l.name}</strong>: {l.reason}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      </div>
    </section>
  );
}
