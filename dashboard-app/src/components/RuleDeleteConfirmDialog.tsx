/**
 * FACTORY-731 — the mandatory confirm step for `DELETE /api/rules/:id`.
 * Deletion is the most destructive op on this path (undo, via the server's
 * own "undo last write" route, is the only way back) — this dialog NAMES
 * the rule's id and query, never a bare "are you sure" (the ticket's own
 * requirement), mirroring `RuleToggleConfirmDialog.tsx`'s shape for the
 * enable/disable flow. The server enforces this confirm step independently
 * (`writeRuleDelete`'s own `confirmReason: "rule-delete"` gate) — this
 * dialog is the UI surface for it, never the only thing standing in the way.
 */
import { Button, Dialog, Modal, ModalOverlay } from "@launchpad-ui/components";
import "./RulesView.css";

export interface RuleDeleteConfirmDialogProps {
  ruleId: string;
  query: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function RuleDeleteConfirmDialog({ ruleId, query, onConfirm, onCancel }: RuleDeleteConfirmDialogProps) {
  return (
    <ModalOverlay
      isOpen
      isDismissable
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <Modal>
        <Dialog aria-label={`confirm deleting rule ${ruleId}`} data-testid="rule-delete-confirm-dialog">
          <h3>Delete "{ruleId}"?</h3>
          <p className="rules-view__cnc" data-testid="rule-delete-summary">
            query: {query}
          </p>
          <p>This cannot be undone from the Rules page after you leave it — the server keeps one backup you can undo immediately after deleting.</p>
          <div className="rules-view__dialog-actions">
            <Button variant="default" onPress={onCancel}>
              cancel
            </Button>
            <Button variant="primary" onPress={onConfirm}>
              delete
            </Button>
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
