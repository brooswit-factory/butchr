/**
 * local/ui — "Save changes", the review step. On open it asks the
 * server what every step would do (`reviewChanges`, dry runs only), then
 * lists the changes grouped by rule with that answer under each: what a
 * new query matches, what turning a rule on would staff, which agents would
 * stop or restart, risky permissions. Pressing Save is the confirmation;
 * `saveChanges` re-plans each step before writing and stops if anything
 * grew past what was shown here.
 */
import { useEffect, useState } from "react";
import { Alert, AlertText, Button, Dialog, Heading, IconButton, Modal, ModalOverlay, ProgressBar, Text } from "@launchpad-ui/components";
import { Icon } from "@launchpad-ui/icons";
import type { RulesApi } from "../../api/rules.js";
import type { RuleChange, RuleRowState } from "../../view-model/rules-draft.js";
import { changeTitle, describeError, impactText, needsAttention, reviewChanges, saveChanges, type ReviewedChange, type SaveOutcome } from "../../view-model/rules-save.js";
import { ChangeList } from "./ChangeList.js";
import { rowHeadline } from "./DiscardModal.js";

export interface ReviewSaveModalProps {
  api: RulesApi;
  /** Computed once when the modal opens. */
  changes: readonly RuleChange[];
  rows: readonly RuleRowState[];
  baseEtag: string;
  onSaved: (outcome: SaveOutcome) => void;
  onClose: () => void;
}

function kindIcon(row: RuleRowState) {
  if (row.draft.deleted) return "delete" as const;
  if (row.draft.isNew) return "add-circle-outline" as const;
  return "edit" as const;
}

export function ReviewSaveModal({ api, changes, rows, baseEtag, onSaved, onClose }: ReviewSaveModalProps) {
  const [reviewed, setReviewed] = useState<ReviewedChange[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    reviewChanges(api, changes, controller.signal)
      .then((r) => {
        if (!controller.signal.aborted) setReviewed(r);
      })
      .catch((e: unknown) => {
        if (!controller.signal.aborted) setError(describeError(e));
      });
    return () => controller.abort();
  }, [api, changes]);

  const blocked = reviewed?.some((r) => r.error !== undefined) ?? false;
  const ruleCount = rows.length;

  async function save() {
    if (!reviewed) return;
    setSaving(true);
    setError(null);
    try {
      onSaved(await saveChanges(api, reviewed, baseEtag));
    } catch (e) {
      setError(describeError(e));
      setSaving(false);
    }
  }

  return (
    <ModalOverlay
      isOpen
      isDismissable={!saving}
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <Modal size="medium">
        <Dialog aria-label="Save changes" className="rt-dialog" data-testid="rules-review-dialog">
          <div slot="header">
            <Heading slot="title">Save changes</Heading>
            <IconButton aria-label="close" icon="cancel" size="small" variant="minimal" isDisabled={saving} onPress={onClose} />
            <Text slot="subtitle">Written to rules.json one step at a time, with a backup before each write.</Text>
          </div>
          <div slot="body" className="rt-dialog__body">
            {error !== null && (
              <Alert status="error" className="rt-inline-alert">
                <AlertText>{error}</AlertText>
              </Alert>
            )}
            {reviewed === null ? (
              <div className="rt-review__loading" data-testid="rules-review-loading">
                <ProgressBar isIndeterminate aria-label="checking changes" />
                <p className="rt-muted">Checking what these changes will do…</p>
              </div>
            ) : (
              <ol className="rt-review">
                {rows.map((row) => {
                  const items = reviewed.filter((r) => r.change.key === row.draft.key);
                  return (
                    <li key={row.draft.key} className="rt-review__rule" data-testid="rules-review-rule">
                      <div className="rt-review__rule-title">
                        <Icon name={kindIcon(row)} size="small" />
                        {rowHeadline(row)}
                      </div>
                      {!row.draft.deleted && <ChangeList changes={row.changes} />}
                      {items.map((item) => {
                        const impact = impactText(item);
                        return (
                          <div key={`${item.change.kind}:${item.change.key}`} className="rt-review__step">
                            {item.error !== undefined && (
                              <Alert status="error" variant="inline" className="rt-inline-alert">
                                <AlertText>
                                  {changeTitle(item.change)}: {item.error}
                                </AlertText>
                              </Alert>
                            )}
                            {impact && (
                              <Alert status={needsAttention(item) ? "warning" : "info"} variant="inline" className="rt-inline-alert">
                                <AlertText>{impact}</AlertText>
                              </Alert>
                            )}
                          </div>
                        );
                      })}
                    </li>
                  );
                })}
              </ol>
            )}
            {blocked && (
              <p className="rt-field-error">butchr refused part of this in a dry run. Fix or undo the changes marked above, then review again.</p>
            )}
          </div>
          <div slot="footer">
            <Button onPress={onClose} isDisabled={saving}>
              Cancel
            </Button>
            <Button variant="primary" onPress={() => void save()} isPending={saving} isDisabled={reviewed === null || blocked} data-testid="rules-save-confirm">
              {ruleCount === 1 ? "Save change" : `Save ${ruleCount} changes`}
            </Button>
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
