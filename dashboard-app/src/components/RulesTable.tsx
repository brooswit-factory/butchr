/**
 * FACTORY-661 — the Rules list: one row per rule (id, enabled badge,
 * provider, query, `execution` — display-only this slice, see
 * `api/rules.ts`'s own `RuleDto.execution` doc comment — why-unstaffed, a
 * Preview button, and (FACTORY-730) an Edit button opening `RuleEditDialog.tsx`
 * for that row's rule). FACTORY-851 adds a display-only `resume: on/off
 * (cutoff: ...)` cell, worded by `view-model/rules-view.ts`'s own
 * `resumeText` — same "every rendering decision lives in the view-model"
 * discipline `execution`'s own cell already follows. Plain token-styled markup, same "no dedicated
 * Card/Badge component in @launchpad-ui/components@0.25.0" discipline
 * `AgentRowCard.tsx`/`StatusPill.tsx` already settled on.
 *
 * CSP / escaping (agentsafety review 2026-10-05 item (d)): every rule field
 * below is rendered as plain JSX text content — React escapes it by
 * default, no `dangerouslySetInnerHTML` anywhere in this file — so a rule's
 * `id`/`query`/preference values can carry arbitrary text (including a
 * `<script>` or `"><img onerror>` payload) and it is never parsed as
 * markup; `dashboard-app-rules-route.test.tsx` proves this against exactly
 * those two payloads.
 */
import { Button, Switch, Text } from "@launchpad-ui/components";
import type { RuleRowView } from "../view-model/rules-view.js";
import "./RulesView.css";

export interface RulesTableProps {
  rows: RuleRowView[];
  /**
   * `api.capabilities.write` AND `!stale` — governs whether the toggle AND
   * the per-row Edit button are interactive AT ALL. FACTORY-730: the real
   * server's route-level `ui-`-prefix gate is retired — every existing rule
   * is writable through this table now, so there is no longer a per-row
   * `uiEditable` disablement on top of this flag (contrast the FACTORY-663
   * review follow-up this comment used to describe).
   */
  canWrite: boolean;
  onPreview: (ruleId: string) => void;
  onToggle: (row: RuleRowView) => void;
  /** FACTORY-730 — opens the generic edit dialog (`RuleEditDialog.tsx`) for this row's rule. */
  onEdit: (row: RuleRowView) => void;
}

export function RulesTable({ rows, canWrite, onPreview, onToggle, onEdit }: RulesTableProps) {
  return (
    <div className="rules-table" role="table" aria-label="rules">
      {rows.map((row) => {
        const toggleTitle = !canWrite ? "needs the write API" : undefined;
        return (
          <div className="rules-table__row" data-testid="rule-row" data-rule-id={row.rule.id} role="row" key={row.rule.id}>
            <div className="rules-table__cell rules-table__cell--id" role="cell">
              <Text elementType="span" bold>
                {row.rule.id}
              </Text>
              <Text elementType="span" size="small" className={row.rule.enabled ? "rules-table__badge rules-table__badge--enabled" : "rules-table__badge rules-table__badge--disabled"}>
                {row.rule.enabled ? "enabled" : "disabled"}
              </Text>
            </div>
            <Text elementType="span" size="small" role="cell" className="rules-table__cell">
              {row.rule.resourceProvider}
            </Text>
            <Text elementType="span" size="small" role="cell" className="rules-table__cell rules-table__cell--query">
              {row.rule.query}
            </Text>
            <Text elementType="span" size="small" role="cell" className="rules-table__cell">
              execution: {row.rule.execution}
            </Text>
            <Text elementType="span" size="small" role="cell" className="rules-table__cell">
              {row.preferencesText}
            </Text>
            <Text elementType="span" size="small" role="cell" className="rules-table__cell">
              {row.resumeText}
            </Text>
            <Text elementType="span" size="small" role="cell" data-testid="rule-staffed" className={row.staffed.cls === "known" ? "rules-table__known" : "rules-table__cnc"}>
              {row.staffed.text}
            </Text>
            <div className="rules-table__cell rules-table__cell--actions" role="cell">
              <Button size="small" variant="minimal" onPress={() => onPreview(row.rule.id)}>
                Preview
              </Button>
              <span title={!canWrite ? "needs the write API" : undefined}>
                <Button size="small" variant="minimal" isDisabled={!canWrite} onPress={() => onEdit(row)}>
                  Edit
                </Button>
              </span>
              <span className="rules-table__toggle" title={toggleTitle}>
                <Switch
                  isSelected={row.rule.enabled}
                  isDisabled={!canWrite}
                  switchLabels={false}
                  aria-label={`${row.rule.enabled ? "disable" : "enable"} rule ${row.rule.id}`}
                  onChange={() => onToggle(row)}
                />
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
