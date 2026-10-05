/**
 * FACTORY-661 — "Preview" for one rule: `GET /api/rules/:id/preview`'s
 * total and ticket KEYS ONLY, each linked (agentsafety review 2026-10-05
 * item (b): no summary field at all). Each key links through the same
 * `/resource/:key/open` redirect a live dashboard row already uses
 * (`encodeResourceKey`, `view-model/rules-view.ts`) — it works whether or
 * not this ticket currently has a running agent.
 */
import { useEffect, useState } from "react";
import { Button, Dialog, Link, Modal, ModalOverlay } from "@launchpad-ui/components";
import type { RulesApi } from "../api/rules.js";
import { encodeResourceKey } from "../view-model/rules-view.js";
import "./RulesView.css";

export interface RulePreviewDialogProps {
  ruleId: string;
  resourceProvider: string;
  api: RulesApi;
  onClose: () => void;
}

type PreviewLoadState =
  | { kind: "loading" }
  | { kind: "loaded"; total: number; tickets: { key: string }[] }
  | { kind: "error"; error: string };

export function RulePreviewDialog({ ruleId, resourceProvider, api, onClose }: RulePreviewDialogProps) {
  const [state, setState] = useState<PreviewLoadState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    setState({ kind: "loading" });
    api
      .previewRule(ruleId, controller.signal)
      .then((data) => {
        if (!cancelled) setState({ kind: "loaded", total: data.total, tickets: data.tickets });
      })
      .catch((e: unknown) => {
        if (!cancelled) setState({ kind: "error", error: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [ruleId, api]);

  return (
    <ModalOverlay
      isOpen
      isDismissable
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Modal>
        <Dialog aria-label={`preview for rule ${ruleId}`} data-testid="rule-preview-dialog">
          <h3>Preview: {ruleId}</h3>
          {state.kind === "loading" && <p>loading preview…</p>}
          {state.kind === "error" && <p className="rules-view__cnc">could not load preview — {state.error}</p>}
          {state.kind === "loaded" && (
            <>
              <p data-testid="rule-preview-total">
                {state.total} matching ticket{state.total === 1 ? "" : "s"}
              </p>
              <ul className="rules-view__preview-list" data-testid="rule-preview-tickets">
                {state.tickets.map((t) => (
                  <li key={t.key}>
                    <Link href={`/resource/${encodeURIComponent(encodeResourceKey(resourceProvider, ruleId, t.key))}/open`}>{t.key}</Link>
                  </li>
                ))}
              </ul>
            </>
          )}
          <Button onPress={onClose}>close</Button>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
