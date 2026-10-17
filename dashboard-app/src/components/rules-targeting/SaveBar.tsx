/**
 * local/ui — the Rules page footer: static and
 * quiet while the draft is clean, sticky with Undo changes / Review and save
 * once anything is changed. When saving isn't possible yet the reason is
 * spelled out next to the button (published LaunchPad can't show a tooltip
 * on a disabled button).
 */
import { Button, Text } from "@launchpad-ui/components";
import type { DraftSummary } from "../../view-model/rules-draft.js";

export interface SaveBarProps {
  summary: DraftSummary;
  /** Why Review and save is unavailable, or `null` when it can be pressed. */
  blockedReason: string | null;
  busy: boolean;
  onUndo: () => void;
  onReview: () => void;
}

export function describeDraft(summary: Pick<DraftSummary, "added" | "edited" | "deleted">): string {
  const parts: string[] = [];
  if (summary.added) parts.push(`${summary.added} new`);
  if (summary.edited) parts.push(`${summary.edited} edited`);
  if (summary.deleted) parts.push(`${summary.deleted} to delete`);
  const total = summary.added + summary.edited + summary.deleted;
  return `${total} rule${total === 1 ? "" : "s"} with unsaved changes (${parts.join(", ")})`;
}

export function SaveBar({ summary, blockedReason, busy, onUndo, onReview }: SaveBarProps) {
  return (
    <footer className={summary.dirty ? "rt-savebar rt-savebar--dirty" : "rt-savebar"} data-testid="rules-save-bar">
      <div className="rt-savebar__summary">
        <Text size="small">{summary.dirty ? describeDraft(summary) : "No unsaved changes"}</Text>
        {summary.dirty && blockedReason && (
          <Text size="small" className="rt-savebar__blocked" data-testid="rules-save-blocked">
            {blockedReason}
          </Text>
        )}
      </div>
      <div className="rt-savebar__actions">
        {summary.dirty && (
          <Button onPress={onUndo} isDisabled={busy} data-testid="rules-undo-all">
            Undo changes
          </Button>
        )}
        <Button variant="primary" isDisabled={blockedReason !== null || busy} onPress={onReview} data-testid="rules-review-save">
          Review and save
        </Button>
      </div>
    </footer>
  );
}
