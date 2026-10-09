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
import { useEffect, useState } from "react";
import { Alert, AlertText, Button, EmptyState, Heading, Text } from "@launchpad-ui/components";
import { rulesApi, type RuleDto, type RulePlanResponse, type RulesApi } from "../api/rules.js";
import { useRules } from "../hooks/use-rules.js";
import { PollStatusView } from "../components/PollStatusView.js";
import { RulesTable } from "../components/RulesTable.js";
import { RulePreviewDialog } from "../components/RulePreviewDialog.js";
import { RuleToggleConfirmDialog } from "../components/RuleToggleConfirmDialog.js";
import { RuleEditDialog } from "../components/RuleEditDialog.js";
import { FirstRuleSetup } from "../components/FirstRuleSetup.js";
import { buildRulesViewModel, type RuleRowView } from "../view-model/rules-view.js";
import "../components/RulesView.css";

export interface RulesRouteProps {
  api?: RulesApi;
}

interface PendingToggle {
  rule: RuleDto;
  nextEnabled: boolean;
  plan: RulePlanResponse;
  /** FACTORY-685 (item 3): the first page of ticket keys this enable would staff, when known — only ever fetched/shown for a `confirmReason` naming a swarm enable or the scope ceiling (both staff real tickets); `undefined` otherwise, or if the preview call itself failed (the dialog still shows, just without the key list). */
  ticketKeys?: string[];
}

export function RulesRoute({ api = rulesApi }: RulesRouteProps) {
  const state = useRules(api);
  const [previewRuleId, setPreviewRuleId] = useState<string | null>(null);
  const [previewProvider, setPreviewProvider] = useState<string | null>(null);
  const [pendingToggle, setPendingToggle] = useState<PendingToggle | null>(null);
  const [toggleError, setToggleError] = useState<string | null>(null);
  /** FACTORY-730 — the rule currently open in `RuleEditDialog`, or `null` when no edit dialog is open. */
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null);
  // FACTORY-663: the real `realRulesApi` starts with `capabilities.write ===
  // false` (no network call has happened yet) — probing `GET /api/session`
  // once on mount is what flips it `true` against a daemon that actually
  // has PR #647 merged, while leaving it `false` (writes stay disabled) on
  // today's main, where that route 404s. Re-rendered via this counter
  // rather than reading `api.capabilities.write` directly in the JSX below,
  // since mutating a field on an existing object doesn't itself trigger React
  // to re-render.
  const [, forceRerenderAfterCapabilityCheck] = useState(0);
  useEffect(() => {
    let cancelled = false;
    void api.refreshCapabilities().then(() => {
      if (!cancelled) forceRerenderAfterCapabilityCheck((n) => n + 1);
    });
    return () => {
      cancelled = true;
    };
  }, [api]);

  // The ONLY value any write's `ifMatch` may ever carry — `sourceEtag`,
  // never `fileEtag` (ticket item 5) — read off the LAST SUCCESSFULLY
  // POLLED data regardless of whether this very poll tick is `loaded` or
  // `stale` (a `stale` transport state still carries the last good data;
  // see `poll-state.ts`'s own doc comment). Empty only before the first
  // poll resolves, which every write control is disabled until anyway.
  const currentSourceEtag = state.kind === "loaded" || state.kind === "stale" ? state.data.sourceEtag : "";

  async function startToggle(row: RuleRowView) {
    setToggleError(null);
    const nextEnabled = !row.rule.enabled;
    try {
      const plan = await api.planRule(row.rule.id, { enabled: nextEnabled }, false);
      // FACTORY-685 (item 2/3): trust the server's own `requiresConfirm`
      // verdict rather than re-deriving it from `stopped`/`restarted` —
      // it already folds in every gate the server enforces (the scope
      // ceiling, a stop/restart, an unmeasurable scope, and now ANY swarm
      // enable), so this client never drifts from a gate added server-side.
      if (plan.requiresConfirm) {
        let ticketKeys: string[] | undefined;
        // FACTORY-685 (item 3): "This will staff up to N tickets: <first 10
        // keys>" needs the actual keys, which `planRule` itself never
        // returns (only a count) — fetch the SAME dry-run preview the
        // Preview button already uses. Best-effort: a failed preview still
        // shows the confirm dialog, just without the key list.
        if (nextEnabled && (plan.confirmReason === "swarm-enable" || plan.confirmReason === "scope-ceiling")) {
          try {
            const preview = await api.previewRule(row.rule.id);
            ticketKeys = preview.tickets.slice(0, 10).map((t) => t.key);
          } catch {
            ticketKeys = undefined;
          }
        }
        setPendingToggle({ rule: row.rule, nextEnabled, plan, ...(ticketKeys ? { ticketKeys } : {}) });
      } else {
        await api.setEnabled(row.rule.id, nextEnabled, currentSourceEtag, plan.planHash, false);
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
      await api.setEnabled(rule.id, nextEnabled, currentSourceEtag, plan.planHash, true);
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
              {/* FACTORY-663: the "Set up your first rule" flow — always
                  shown (whether or not the template has been seeded yet),
                  independent of `emptyState`/the generic table below, which
                  this ticket never repurposes into a create-a-rule UI.
                  `onChanged` is a no-op: `useRules`'s own poll (every
                  `DASHBOARD_POLL_INTERVAL_MS`) picks up a successful
                  write's new `enabled`/`query`/`sourceEtag` on its own next
                  tick, same as the table's own toggle already relies on —
                  there is no separate manual-refetch escape hatch on
                  `usePolling` to call instead. */}
              <FirstRuleSetup api={api} rule={vm.firstRule} sourceEtag={vm.sourceEtag} stale={vm.stale} canWrite={api.capabilities.write} onChanged={() => undefined} />
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
                  canWrite={api.capabilities.write && !vm.stale}
                  onPreview={(ruleId) => {
                    const row = vm.rows.find((r) => r.rule.id === ruleId);
                    setPreviewProvider(row ? row.rule.resourceProvider : null);
                    setPreviewRuleId(ruleId);
                  }}
                  onToggle={startToggle}
                  onEdit={(row) => setEditingRuleId(row.rule.id)}
                />
              )}
              {/* FACTORY-730 — rendered inside this render-prop (not alongside the
                  other dialogs below) so it always reads the LATEST polled rule
                  (`vm.rows`)/`vm.sourceEtag`/`vm.stale`, same reactivity
                  `FirstRuleSetup` above already relies on; `onChanged` is a
                  no-op for the same reason that one's own is — `useRules`'s own
                  poll picks up a successful write's new fields on its next tick. */}
              {editingRuleId !== null &&
                (() => {
                  const row = vm.rows.find((r) => r.rule.id === editingRuleId);
                  if (!row) return null;
                  return (
                    <RuleEditDialog
                      api={api}
                      rule={row.rule}
                      sourceEtag={vm.sourceEtag}
                      stale={vm.stale}
                      canWrite={api.capabilities.write}
                      onChanged={() => undefined}
                      onClose={() => setEditingRuleId(null)}
                    />
                  );
                })()}
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
          {...(pendingToggle.ticketKeys ? { ticketKeys: pendingToggle.ticketKeys } : {})}
          onConfirm={confirmToggle}
          onCancel={() => setPendingToggle(null)}
        />
      )}
    </section>
  );
}
