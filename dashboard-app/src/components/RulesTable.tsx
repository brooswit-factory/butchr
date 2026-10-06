/**
 * FACTORY-661 — the Rules list: one row per rule (id, enabled badge,
 * provider, query, `execution` — display-only this slice, see
 * `api/rules.ts`'s own `RuleDto.execution` doc comment — why-unstaffed, and
 * a Preview button). Plain token-styled markup, same "no dedicated
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
import { FIRST_RULE_ID } from "../api/rules.js";
import type { RuleRowView } from "../view-model/rules-view.js";
import "./RulesView.css";

export interface RulesTableProps {
  rows: RuleRowView[];
  /**
   * `api.capabilities.write` AND `!stale` — governs whether the toggle is
   * interactive AT ALL. NOTE (FACTORY-663 review follow-up): the real server
   * only ever accepts a write for a `ui-`-prefixed rule id
   * (`isUiEditableRuleId`, `../api/rules.js`) — a non-`ui-` row is now ALSO
   * disabled per-row, regardless of this flag, via each row's own
   * `uiEditable` (see `rules-view.ts`'s `RuleRowView`), so the table never
   * invites a click that the server is guaranteed to refuse with a 403. The
   * dedicated `ui-first-rule` flow this ticket builds (`FirstRuleSetup.tsx`)
   * remains the one actually exercised against a real daemon; this generic
   * per-row toggle predates that contract (FACTORY-661) and stays
   * read-compatible for every other rule, just no longer clickable for them.
   */
  canWrite: boolean;
  onPreview: (ruleId: string) => void;
  onToggle: (row: RuleRowView) => void;
}

export function RulesTable({ rows, canWrite, onPreview, onToggle }: RulesTableProps) {
  return (
    <div className="rules-table" role="table" aria-label="rules">
      {rows.map((row) => {
        const writable = canWrite && row.uiEditable;
        const toggleTitle = !canWrite ? "needs the write API" : !row.uiEditable ? `only ${FIRST_RULE_ID} can be edited from this page — edit rules.json directly for other rules` : undefined;
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
            <Text elementType="span" size="small" role="cell" data-testid="rule-staffed" className={row.staffed.cls === "known" ? "rules-table__known" : "rules-table__cnc"}>
              {row.staffed.text}
            </Text>
            <div className="rules-table__cell rules-table__cell--actions" role="cell">
              <Button size="small" variant="minimal" onPress={() => onPreview(row.rule.id)}>
                Preview
              </Button>
              <span className="rules-table__toggle" title={toggleTitle}>
                <Switch
                  isSelected={row.rule.enabled}
                  isDisabled={!writable}
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
