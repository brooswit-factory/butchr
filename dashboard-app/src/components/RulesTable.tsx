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
import type { RuleRowView } from "../view-model/rules-view.js";
import "./RulesView.css";

export interface RulesTableProps {
  rows: RuleRowView[];
  /**
   * `api.capabilities.write` AND `!stale` — governs whether the toggle is
   * interactive at all. NOTE (FACTORY-663): the real server only ever
   * accepts a write for a `ui-`-prefixed rule id (`isUiEditableRuleId`,
   * `../api/rules.js`) — a non-`ui-` row left enabled here still fails at
   * the server with a 403, surfaced through the SAME `rule-toggle-error`
   * banner as any other write refusal. This table does not pre-filter rows
   * by id itself: the dedicated `ui-first-rule` flow this ticket builds
   * (`FirstRuleSetup.tsx`) is the one actually exercised against a real
   * daemon; this generic per-row toggle predates that contract (FACTORY-661)
   * and is kept read-compatible rather than narrowed further here.
   */
  canWrite: boolean;
  onPreview: (ruleId: string) => void;
  onToggle: (row: RuleRowView) => void;
}

export function RulesTable({ rows, canWrite, onPreview, onToggle }: RulesTableProps) {
  return (
    <div className="rules-table" role="table" aria-label="rules">
      {rows.map((row) => {
        const writable = canWrite;
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
              <span className="rules-table__toggle" title={writable ? undefined : "needs the write API"}>
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
