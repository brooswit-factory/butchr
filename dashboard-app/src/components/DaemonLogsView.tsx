/**
 * FACTORY-668 (C1, read) — renders `GET /api/daemon/logs`'s own data: where
 * the lines came from (`source`/`unit`), a truncation note when the byte
 * cap cut the tail short, and the (already server-redacted, already
 * bounded) lines themselves. Dumb presentation only — `PollStatusView`
 * (around this, in the route) already covers the loading/error/stale
 * states, including the operator-actionable "logs unavailable" message a
 * `DaemonLogsUnavailableError` carries.
 */
import { Text } from "@launchpad-ui/components";
import type { DaemonLogsResponse } from "../api/daemon.js";

export interface DaemonLogsViewProps {
  data: DaemonLogsResponse;
}

export function DaemonLogsView({ data }: DaemonLogsViewProps) {
  return (
    <section data-testid="daemon-logs-view">
      <Text elementType="p" size="small" data-testid="daemon-logs-source">
        source: {data.source} (unit: {data.unit})
      </Text>
      {data.truncated && (
        <Text elementType="p" size="small" data-testid="daemon-logs-truncated">
          truncated — more lines exist than fit the byte cap
        </Text>
      )}
      <pre data-testid="daemon-logs-lines" style={{ maxHeight: "24rem", overflow: "auto", fontSize: "0.8rem", padding: "0.5rem", background: "var(--lp-color-background-subtle, #1118270d)" }}>
        {data.lines.length > 0 ? data.lines.join("\n") : "(no log lines)"}
      </pre>
    </section>
  );
}
