/**
 * FACTORY-665 — the Settings page's restart control: a button that opens an
 * explicit confirm dialog (the ticket's own "explicit confirm" requirement
 * for `POST /api/daemon/restart`) before firing, then shows a short
 * "restarting — reconnecting" status while a small backoff loop polls
 * `GET /api/settings` until the daemon answers again (the ticket's own
 * "UI waits and reconnects" expectation — a dropped connection right after
 * a successful restart call is the EXPECTED outcome, never shown as an
 * error).
 */
import { useState } from "react";
import { Button, Dialog, Modal, ModalOverlay, Text } from "@launchpad-ui/components";
import { DaemonRestartUnavailableError, RateLimitError } from "../api/settings.js";

export interface DaemonRestartControlProps {
  restart: () => Promise<void>;
  /** Polls until this resolves without throwing — the real impl re-calls `GET /api/settings`; a test fixture can resolve immediately. */
  waitUntilBackUp: () => Promise<void>;
}

type RestartState = { kind: "idle" } | { kind: "confirming" } | { kind: "restarting" } | { kind: "reconnecting" } | { kind: "back" } | { kind: "error"; message: string };

export function DaemonRestartControl({ restart, waitUntilBackUp }: DaemonRestartControlProps) {
  const [state, setState] = useState<RestartState>({ kind: "idle" });

  async function doRestart() {
    setState({ kind: "restarting" });
    try {
      await restart();
    } catch (e) {
      const message = e instanceof DaemonRestartUnavailableError ? e.message
        : e instanceof RateLimitError ? `${e.message}${e.retryAfterSeconds !== undefined ? ` (retry in ${e.retryAfterSeconds}s)` : ""}`
        : e instanceof Error ? e.message : String(e);
      setState({ kind: "error", message });
      return;
    }
    setState({ kind: "reconnecting" });
    try {
      await waitUntilBackUp();
      setState({ kind: "back" });
    } catch {
      setState({ kind: "error", message: "the daemon did not come back up — check it by hand" });
    }
  }

  return (
    <section className="settings-restart-control" data-testid="daemon-restart-control">
      <Button onPress={() => setState({ kind: "confirming" })} isDisabled={state.kind === "restarting" || state.kind === "reconnecting"} data-testid="daemon-restart-button">
        Restart butchr
      </Button>
      {state.kind === "restarting" && <Text elementType="span" size="small" data-testid="daemon-restart-status">restarting…</Text>}
      {state.kind === "reconnecting" && <Text elementType="span" size="small" data-testid="daemon-restart-status">restarting — reconnecting…</Text>}
      {state.kind === "back" && <Text elementType="span" size="small" data-testid="daemon-restart-status">back up</Text>}
      {state.kind === "error" && <Text elementType="span" size="small" className="settings-jira-card__warning" data-testid="daemon-restart-status">{state.message}</Text>}
      <ModalOverlay isOpen={state.kind === "confirming"} isDismissable onOpenChange={(open) => { if (!open) setState({ kind: "idle" }); }}>
        <Modal>
          <Dialog>
            <Text elementType="p">This restarts the butchr daemon now. Every connected agent and the dashboard itself will briefly disconnect. Continue?</Text>
            <Button onPress={() => setState({ kind: "idle" })} data-testid="daemon-restart-cancel">Cancel</Button>
            <Button onPress={() => void doRestart()} data-testid="daemon-restart-confirm">Restart now</Button>
          </Dialog>
        </Modal>
      </ModalOverlay>
    </section>
  );
}
