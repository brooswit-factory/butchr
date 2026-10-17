/**
 * local/ui — "Discard unsaved changes?", for one card's ✕ or the footer's
 * Undo changes. Lists exactly what would be thrown away.
 */
import { Button, Dialog, Heading, IconButton, Modal, ModalOverlay, Text } from "@launchpad-ui/components";
import type { RuleRowState } from "../../view-model/rules-draft.js";
import { ChangeList } from "./ChangeList.js";

export interface DiscardModalProps {
  title: string;
  rows: readonly RuleRowState[];
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function rowHeadline(row: RuleRowState): string {
  if (row.draft.deleted) return `Delete ${row.draft.id}`;
  if (row.draft.isNew) return `New rule ${row.draft.id || "(no id yet)"}`;
  return row.draft.id;
}

export function DiscardModal({ title, rows, confirmLabel, onConfirm, onCancel }: DiscardModalProps) {
  return (
    <ModalOverlay
      isOpen
      isDismissable
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <Modal size="small">
        <Dialog aria-label={title} className="rt-dialog" data-testid="rules-discard-dialog">
          <div slot="header">
            <Heading slot="title">{title}</Heading>
            <IconButton aria-label="close" icon="cancel" size="small" variant="minimal" onPress={onCancel} />
            <Text slot="subtitle">These changes haven't been saved and will be lost.</Text>
          </div>
          <div slot="body">
            <ul className="rt-review">
              {rows.map((row) => (
                <li key={row.draft.key} className="rt-review__rule">
                  <div className="rt-review__rule-title">{rowHeadline(row)}</div>
                  {!row.draft.isNew && <ChangeList changes={row.changes} />}
                </li>
              ))}
            </ul>
          </div>
          <div slot="footer">
            <Button onPress={onCancel}>Keep editing</Button>
            <Button variant="destructive" onPress={onConfirm} data-testid="rules-discard-confirm">
              {confirmLabel}
            </Button>
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
