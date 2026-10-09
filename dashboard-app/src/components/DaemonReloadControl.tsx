/**
 * FACTORY-668 (C2, write) — the Reload control: fires `POST
 * /api/daemon/reload` (re-reads rules.json in-process, FACTORY-657's own
 * path) and reports what changed. Unlike `DaemonRestartControl`, this is
 * NOT behind a confirm dialog — the server route itself isn't
 * confirm-gated (a reload never takes the daemon down or interrupts a
 * running agent mid-ticket; see `src/web/view.ts`'s own comment on `POST
 * /api/daemon/reload`), so there is nothing here for a confirm step to
 * protect against.
 */
import { useState } from "react";
import { Button, Text } from "@launchpad-ui/components";
import { DaemonReloadFailedError, RateLimitError, type DaemonReloadResult } from "../api/daemon.js";

export interface DaemonReloadControlProps {
  reload: () => Promise<DaemonReloadResult>;
}

type ReloadState = { kind: "idle" } | { kind: "reloading" } | { kind: "done"; result: DaemonReloadResult } | { kind: "error"; message: string };

function summarize(result: DaemonReloadResult): string {
  if (!result.added.length && !result.removed.length && !result.changed.length) return "reloaded — no change";
  const parts: string[] = [];
  if (result.added.length) parts.push(`added: ${result.added.join(", ")}`);
  if (result.removed.length) parts.push(`removed: ${result.removed.join(", ")}`);
  if (result.changed.length) parts.push(`changed: ${result.changed.join(", ")}`);
  return `reloaded — ${parts.join("; ")}`;
}

export function DaemonReloadControl({ reload }: DaemonReloadControlProps) {
  const [state, setState] = useState<ReloadState>({ kind: "idle" });

  async function doReload() {
    setState({ kind: "reloading" });
    try {
      const result = await reload();
      setState({ kind: "done", result });
    } catch (e) {
      const message = e instanceof DaemonReloadFailedError ? `reload failed: ${e.message}`
        : e instanceof RateLimitError ? `${e.message}${e.retryAfterSeconds !== undefined ? ` (retry in ${e.retryAfterSeconds}s)` : ""}`
        : e instanceof Error ? e.message : String(e);
      setState({ kind: "error", message });
    }
  }

  return (
    <section data-testid="daemon-reload-control">
      <Button onPress={() => void doReload()} isDisabled={state.kind === "reloading"} data-testid="daemon-reload-button">
        Reload rules
      </Button>
      {state.kind === "reloading" && <Text elementType="span" size="small" data-testid="daemon-reload-status">reloading…</Text>}
      {state.kind === "done" && <Text elementType="span" size="small" data-testid="daemon-reload-status">{summarize(state.result)}</Text>}
      {state.kind === "error" && <Text elementType="span" size="small" className="settings-jira-card__warning" data-testid="daemon-reload-status">{state.message}</Text>}
    </section>
  );
}
