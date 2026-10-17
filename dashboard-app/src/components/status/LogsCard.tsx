/**
 * local/ui — the Status page's log tail (`GET /api/daemon/logs`, already
 * bounded and redacted by the daemon). It stays scrolled to the newest line
 * unless you've scrolled up to read something.
 */
import { useEffect, useRef } from "react";
import { Heading, Text } from "@launchpad-ui/components";
import type { DaemonLogsResponse } from "../../api/daemon.js";
import type { PollState } from "../../view-model/poll-state.js";

/** The file a `tail -n 200 -f "<path>"` / `Get-Content -Path "<path>"` source reads, or the source itself. */
export function logSourceText(source: string): string {
  return /"([^"]+)"/.exec(source)?.[1] ?? source;
}

/** `tall`: the card has a column to itself, so the tail can use the window's height. */
export function LogsCard({ state, tall = false }: { state: PollState<DaemonLogsResponse>; tall?: boolean }) {
  const pre = useRef<HTMLPreElement>(null);
  const atBottom = useRef(true);
  const data = state.kind === "loaded" || state.kind === "stale" ? state.data : null;
  const lineCount = data?.lines.length ?? 0;
  const lastLine = data?.lines.at(-1);

  useEffect(() => {
    const el = pre.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [lineCount, lastLine]);

  return (
    <section className="st-card st-card--logs" aria-labelledby="st-logs-title" data-testid="status-logs">
      <header className="st-card__header">
        <Heading level={2} id="st-logs-title" className="st-card__title">
          Log
        </Heading>
        {data && (
          <Text size="small" className="st-muted" data-testid="daemon-logs-source">
            last {data.lines.length} lines of <code>{logSourceText(data.source)}</code>
            {data.truncated ? " (cut short to fit)" : ""}
          </Text>
        )}
      </header>
      <div className="st-card__body st-card__body--flush">
        {state.kind === "loading" && (
          <Text elementType="p" size="small" className="st-muted st-pad">
            Loading…
          </Text>
        )}
        {state.kind === "error" && (
          <Text elementType="p" size="small" className="st-warning st-pad" data-testid="status-logs-error">
            {state.error}
          </Text>
        )}
        {data && (
          <pre
            ref={pre}
            className={tall ? "st-log st-log--tall" : "st-log"}
            tabIndex={0}
            aria-label="butchr's log"
            data-testid="daemon-logs-lines"
            onScroll={(e) => {
              const el = e.currentTarget;
              atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
            }}
          >
            {data.lines.length > 0 ? data.lines.join("\n") : "(no log lines)"}
          </pre>
        )}
      </div>
    </section>
  );
}
