/**
 * FACTORY-661 — agentsafety review 2026-10-05 item (c): a change that would
 * stop or restart running agents must show the server's REPORT-ONLY plan
 * ("N spawned, M stopped, K restarted") and require an explicit confirm.
 * FACTORY-685 (item 2/3): the caller (`RulesRoute.tsx`) renders this dialog
 * whenever the server's own `plan.requiresConfirm` is `true` — which now
 * also covers ANY enable of a swarm rule, not only a stop/restart or a
 * scope above the ceiling — this component does not re-check that
 * decision, only renders it. For a `confirmReason` of `"swarm-enable"` or
 * `"scope-ceiling"` (both stage real tickets), the message leads with the
 * ticket-staffing wording the ticket asks for ("This will staff up to N
 * tickets: <first 10 keys>"); every other reason keeps the original
 * spawned/stopped/restarted summary.
 */
import { Button, Dialog, Modal, ModalOverlay } from "@launchpad-ui/components";
import type { RulePlanResponse } from "../api/rules.js";
import "./RulesView.css";

export interface RuleToggleConfirmDialogProps {
  ruleId: string;
  nextEnabled: boolean;
  plan: RulePlanResponse;
  /** The first page of ticket keys this enable would staff (FACTORY-685, item 3) — only ever populated for `confirmReason` `"swarm-enable"`/`"scope-ceiling"`; absent for every other reason, or when the preview fetch itself failed. */
  ticketKeys?: string[];
  onConfirm: () => void;
  onCancel: () => void;
}

export function RuleToggleConfirmDialog({ ruleId, nextEnabled, plan, ticketKeys, onConfirm, onCancel }: RuleToggleConfirmDialogProps) {
  const isStaffingTickets = nextEnabled && (plan.confirmReason === "swarm-enable" || plan.confirmReason === "scope-ceiling");
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
          {isStaffingTickets ? (
            <p className="rules-view__cnc" data-testid="rule-plan-summary">
              This will staff up to {plan.scopeCount ?? plan.spawned} ticket{(plan.scopeCount ?? plan.spawned) === 1 ? "" : "s"}
              {ticketKeys && ticketKeys.length > 0 ? `: ${ticketKeys.join(", ")}` : ""}
              {ticketKeys && ticketKeys.length === 10 ? ", ..." : ""}
            </p>
          ) : (
            <p className="rules-view__cnc" data-testid="rule-plan-summary">
              this would start {plan.spawned} agent{plan.spawned === 1 ? "" : "s"} on real tickets, stop {plan.stopped}, and restart {plan.restarted}
            </p>
          )}
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
