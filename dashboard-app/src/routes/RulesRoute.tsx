/**
 * FACTORY-661 (epic FACTORY-659, slice U1) — the real Rules route, next to
 * Dashboard and Configurations. Wires `useRules` (polling `GET /api/rules`
 * through the one typed client module, `api/rules.ts`) to the pure
 * `buildRulesViewModel` and arranges the list, the per-rule Preview dialog,
 * and the enable/disable toggle's plan-then-confirm flow (agentsafety
 * review 2026-10-05 item (c)).
 *
 * Accepts an optional `api` override so a test can hand this a
 * `createFixturesRulesApi({...})` built for exactly the scenario it wants
 * (empty, invalid file, a forced failure, a plan that stops agents) without
 * stubbing `globalThis.fetch` — the default is `rulesApi`, the real
 * dev/build-flag-selected singleton (`api/rules.ts`'s own doc comment).
 */
import { useState } from "react";
import { Alert, AlertText, Button, EmptyState, Heading, Text } from "@launchpad-ui/components";
import { rulesApi, type RuleDto, type RulePlanResponse, type RulesApi } from "../api/rules.js";
import { useRules } from "../hooks/use-rules.js";
import { PollStatusView } from "../components/PollStatusView.js";
import { RulesTable } from "../components/RulesTable.js";
import { RulePreviewDialog } from "../components/RulePreviewDialog.js";
import { RuleToggleConfirmDialog } from "../components/RuleToggleConfirmDialog.js";
import { buildRulesViewModel, type RuleRowView } from "../view-model/rules-view.js";
import "../components/RulesView.css";

export interface RulesRouteProps {
  api?: RulesApi;
}

interface PendingToggle {
  rule: RuleDto;
  nextEnabled: boolean;
  plan: RulePlanResponse;
}

export function RulesRoute({ api = rulesApi }: RulesRouteProps) {
  const state = useRules(api);
  const [previewRuleId, setPreviewRuleId] = useState<string | null>(null);
  const [previewProvider, setPreviewProvider] = useState<string | null>(null);
  const [pendingToggle, setPendingToggle] = useState<PendingToggle | null>(null);
  const [toggleError, setToggleError] = useState<string | null>(null);

  async function startToggle(row: RuleRowView) {
    setToggleError(null);
    const nextEnabled = !row.rule.enabled;
    try {
      const plan = await api.planToggle(row.rule.id, nextEnabled);
      if (plan.stopped > 0 || plan.restarted > 0) {
        setPendingToggle({ rule: row.rule, nextEnabled, plan });
      } else {
        await api.applyToggle(row.rule.id, nextEnabled, plan);
      }
    } catch (e) {
      setToggleError(e instanceof Error ? e.message : String(e));
    }
  }

  async function confirmToggle() {
    if (!pendingToggle) return;
    const { rule, nextEnabled, plan } = pendingToggle;
    setPendingToggle(null);
    try {
      await api.applyToggle(rule.id, nextEnabled, plan);
    } catch (e) {
      setToggleError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <section aria-labelledby="rules-heading">
      <Heading id="rules-heading" size="small">
        Rules
      </Heading>
      {toggleError !== null && (
        <Alert status="error" data-testid="rule-toggle-error">
          <AlertText>could not change this rule — {toggleError}</AlertText>
        </Alert>
      )}
      <PollStatusView state={state} label="/api/rules">
        {(data) => {
          const vm = buildRulesViewModel(data);
          return (
            <>
              {vm.fileErrors.length > 0 && (
                <Alert status="error" className="rules-view__banner" data-testid="rules-file-errors">
                  <AlertText>
                    {vm.fileErrors.map((e) => (
                      <Text elementType="div" size="small" key={e.path}>
                        {e.path}: {e.message}
                      </Text>
                    ))}
                  </AlertText>
                </Alert>
              )}
              {vm.emptyState ? (
                <EmptyState className="rules-view__empty" data-testid="rules-empty-state">
                  <Heading size="small">No rules file yet</Heading>
                  <Text elementType="p">
                    Butchr found no rules file, so nothing is staffed right now. Create one to start matching tickets to agents.
                  </Text>
                  <span title="needs slice U2 (the create/edit form)">
                    <Button isDisabled>Add your first rule</Button>
                  </span>
                </EmptyState>
              ) : (
                <RulesTable
                  rows={vm.rows}
                  canWrite={api.capabilities.write}
                  onPreview={(ruleId) => {
                    const row = vm.rows.find((r) => r.rule.id === ruleId);
                    setPreviewProvider(row ? row.rule.resourceProvider : null);
                    setPreviewRuleId(ruleId);
                  }}
                  onToggle={startToggle}
                />
              )}
            </>
          );
        }}
      </PollStatusView>
      {previewRuleId !== null && previewProvider !== null && (
        <RulePreviewDialog
          ruleId={previewRuleId}
          resourceProvider={previewProvider}
          api={api}
          onClose={() => {
            setPreviewRuleId(null);
            setPreviewProvider(null);
          }}
        />
      )}
      {pendingToggle !== null && (
        <RuleToggleConfirmDialog
          ruleId={pendingToggle.rule.id}
          nextEnabled={pendingToggle.nextEnabled}
          plan={pendingToggle.plan}
          onConfirm={confirmToggle}
          onCancel={() => setPendingToggle(null)}
        />
      )}
    </section>
  );
}
