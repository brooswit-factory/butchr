/**
 * FACTORY-661 — agentsafety review 2026-10-05 item (c): a change that would
 * stop or restart running agents must show the server's REPORT-ONLY plan
 * ("N spawned, M stopped, K restarted") and require an explicit confirm
 * whenever `stopped > 0 || restarted > 0`. Built against FACTORY-662's own
 * plan contract (`RulePlanResponse`); the caller (`RulesRoute.tsx`) only
 * renders this dialog when that condition already holds — this component
 * does not re-check it.
 */
import { Button, Dialog, Modal, ModalOverlay } from "@launchpad-ui/components";
import type { RulePlanResponse } from "../api/rules.js";
import "./RulesView.css";

export interface RuleToggleConfirmDialogProps {
  ruleId: string;
  nextEnabled: boolean;
  plan: RulePlanResponse;
  onConfirm: () => void;
  onCancel: () => void;
}

export function RuleToggleConfirmDialog({ ruleId, nextEnabled, plan, onConfirm, onCancel }: RuleToggleConfirmDialogProps) {
  return (
    <ModalOverlay
      isOpen
      isDismissable
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <Modal>
        <Dialog aria-label={`confirm ${nextEnabled ? "enabling" : "disabling"} rule ${ruleId}`} data-testid="rule-toggle-confirm-dialog">
          <h3>
            {nextEnabled ? "Enable" : "Disable"} "{ruleId}"?
          </h3>
          <p className="rules-view__cnc" data-testid="rule-plan-summary">
            this would start {plan.spawned} agent{plan.spawned === 1 ? "" : "s"} on real tickets, stop {plan.stopped}, and restart {plan.restarted}
          </p>
          <div className="rules-view__dialog-actions">
            <Button variant="default" onPress={onCancel}>
              cancel
            </Button>
            <Button variant="primary" onPress={onConfirm}>
              confirm
            </Button>
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
