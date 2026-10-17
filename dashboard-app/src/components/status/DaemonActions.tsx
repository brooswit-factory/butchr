/**
 * local/ui — the Status page's two actions: Reload rules (re-read rules.json
 * in place, `POST /api/daemon/reload`) and Restart butchr (after a confirm,
 * `POST /api/settings/daemon/restart`, then wait for a new process to answer).
 */
import { useState } from "react";
import { Button, ButtonGroup, Dialog, Heading, Modal, ModalOverlay, Text } from "@launchpad-ui/components";
import { Icon } from "@launchpad-ui/icons";
import { DaemonReloadFailedError, type DaemonReloadResult } from "../../api/daemon.js";
import { DaemonRestartUnavailableError, RateLimitError } from "../../api/settings.js";

export interface DaemonActionsProps {
  reload: () => Promise<DaemonReloadResult>;
  restart: () => Promise<void>;
  /** Resolves once a new butchr process answers; rejects when none does in time. */
  waitUntilBackUp: () => Promise<void>;
}

type Status = { tone: "muted" | "ok" | "error"; text: string } | null;

export function reloadResultText(r: DaemonReloadResult): string {
  if (!r.added.length && !r.removed.length && !r.changed.length) return "Rules reloaded. Nothing changed.";
  const parts = [
    r.added.length ? `added ${r.added.join(", ")}` : null,
    r.removed.length ? `removed ${r.removed.join(", ")}` : null,
    r.changed.length ? `changed ${r.changed.join(", ")}` : null,
  ].filter(Boolean);
  return `Rules reloaded: ${parts.join("; ")}.`;
}

function errorText(e: unknown): string {
  if (e instanceof DaemonReloadFailedError) return `Reload failed: ${e.message}`;
  if (e instanceof RateLimitError) return `${e.message}${e.retryAfterSeconds !== undefined ? ` Try again in ${e.retryAfterSeconds}s.` : ""}`;
  if (e instanceof DaemonRestartUnavailableError) return e.message;
  return e instanceof Error ? e.message : String(e);
}

export function DaemonActions({ reload, restart, waitUntilBackUp }: DaemonActionsProps) {
  const [busy, setBusy] = useState<"reload" | "restart" | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [status, setStatus] = useState<Status>(null);

  async function doReload() {
    setBusy("reload");
    setStatus(null);
    try {
      setStatus({ tone: "ok", text: reloadResultText(await reload()) });
    } catch (e) {
      setStatus({ tone: "error", text: errorText(e) });
    } finally {
      setBusy(null);
    }
  }

  async function doRestart() {
    setConfirming(false);
    setBusy("restart");
    setStatus({ tone: "muted", text: "Restarting…" });
    try {
      await restart();
    } catch (e) {
      setStatus({ tone: "error", text: errorText(e) });
      setBusy(null);
      return;
    }
    setStatus({ tone: "muted", text: "Restarting. Waiting for butchr to come back…" });
    try {
      await waitUntilBackUp();
      setStatus({ tone: "ok", text: "butchr restarted." });
    } catch {
      setStatus({ tone: "error", text: "butchr didn't come back. Check it in a terminal." });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="st-actions" data-testid="status-actions">
      {status && (
        <Text size="small" className={status.tone === "error" ? "st-error" : status.tone === "ok" ? "st-ok" : "st-muted"} role="status" data-testid="status-action-result">
          {status.text}
        </Text>
      )}
      <ButtonGroup>
        <Button size="small" isPending={busy === "reload"} isDisabled={busy !== null} onPress={() => void doReload()} data-testid="daemon-reload-button">
          <Icon name="sync" size="small" />
          Reload rules
        </Button>
        <Button size="small" isPending={busy === "restart"} isDisabled={busy !== null} onPress={() => setConfirming(true)} data-testid="daemon-restart-button">
          Restart butchr
        </Button>
      </ButtonGroup>
      <ModalOverlay isOpen={confirming} isDismissable onOpenChange={(open) => { if (!open) setConfirming(false); }}>
        <Modal size="small">
          <Dialog aria-label="Restart butchr" data-testid="status-restart-dialog">
            <div slot="header">
              <Heading slot="title">Restart butchr?</Heading>
              <Text slot="subtitle">The dashboard and agents' butchr connection drop for a few seconds. Running agents keep running.</Text>
            </div>
            <div slot="footer">
              <Button onPress={() => setConfirming(false)} data-testid="daemon-restart-cancel">
                Cancel
              </Button>
              <Button variant="primary" onPress={() => void doRestart()} data-testid="daemon-restart-confirm">
                Restart now
              </Button>
            </div>
          </Dialog>
        </Modal>
      </ModalOverlay>
    </div>
  );
}
