/**
 * FACTORY-730 — the generic "edit an existing rule" dialog: the Rules
 * table's per-row Edit button (`RulesTable.tsx`) opens this for ANY rule,
 * not only the one seeded `ui-first-rule` template `FirstRuleSetup.tsx`
 * exists for (the route-level `ui-`-prefix write gate is retired — see
 * `src/rules/rules-write-registry.ts`'s own header). Deliberately mirrors
 * that component's own write discipline rather than inventing a second one:
 * every write goes through `planRule` FIRST for a fresh `planHash` (the
 * SAME plan the real server computes, which already decides whether a
 * stop/restart/over-ceiling/risky-permission confirm is required —
 * `plan.requiresConfirm`, never re-derived here), `ifMatch` is ALWAYS
 * `sourceEtag` (never `fileEtag`), and the harness/model/effort/
 * permission-mode options come from `GET /api/rules/catalog`
 * (`api.getCatalog()`) — never a second, hand-maintained list.
 *
 * QUERY DRY-RUN (ticket item 3): whenever the draft query differs from the
 * rule's own saved query, a "check scope" button dry-runs the DRAFT text
 * through the SAME preview capability the Preview button already uses
 * (`api.previewRule(ruleId, signal, draftQuery)` — FACTORY-730's own
 * `queryOverride` param, `../api/rules.js`), so the operator sees what the
 * NEW query would match before ever saving it, independent of whether the
 * save itself also needs a confirm (an edit to a currently-disabled rule's
 * query never trips the stop/restart gate, but the scope is still worth
 * seeing before save).
 */
import { useEffect, useState } from "react";
import { Alert, AlertText, Button, Dialog, Modal, ModalOverlay, Switch, Text } from "@launchpad-ui/components";
import { AGENT_EFFORTS, type AgentEffort } from "../../../src/resources/power-scale.js";
// Imported from the LEAF module, never `../../../src/rules/rules.js` directly — see `FirstRuleSetup.tsx`'s own top comment for why a VALUE import from that module breaks the Vite client bundle.
import { AGENT_HARNESSES, RULE_PERMISSION_MODES, type AgentHarness, type RulePermissionMode } from "../../../src/rules/agent-harness.js";
import {
  PLACEHOLDER_QUERY,
  RateLimitError,
  type RuleAgentPreferencePatch,
  type RuleDto,
  type RuleFieldPatch,
  type RuleFormCatalogEntry,
  type RulePlanResponse,
  type RuleWriteResult,
  type RulesApi,
} from "../api/rules.js";
import "./RulesView.css";

export interface RuleEditDialogProps {
  api: RulesApi;
  rule: RuleDto;
  sourceEtag: string;
  stale: boolean;
  canWrite: boolean;
  /** Called after any successful write/undo so the caller can trigger a fresh `GET /api/rules` poll. */
  onChanged: () => void;
  onClose: () => void;
}

/** Same server constraint `FirstRuleSetup.tsx`'s own `canEditPreferences` documents: a PUT's `agentPreferences` patch must be the SAME LENGTH as the rule's current one — there is no way to grow it from empty through this endpoint. */
function canEditPreferences(rule: RuleDto): boolean {
  return rule.agentPreferences.length > 0;
}

/** Mirrors `FirstRuleSetup.tsx`'s own `describeWriteError` — a `RateLimitError` with a parsed `Retry-After` gets an actionable message; every other error (and every other rate limit) keeps the verbatim server `{error}` text. */
function describeWriteError(e: unknown): string {
  if (e instanceof RateLimitError && e.retryAfterSeconds !== undefined) {
    return `Too many changes — try again in ${e.retryAfterSeconds}s`;
  }
  return e instanceof Error ? e.message : String(e);
}

interface PendingAction {
  label: string;
  plan: RulePlanResponse;
  commit: (planHash: string, confirm: boolean) => Promise<RuleWriteResult>;
  ticketKeys?: string[];
}

type ScopePreviewState = { kind: "idle" } | { kind: "loading" } | { kind: "loaded"; total: number } | { kind: "error"; error: string };

export function RuleEditDialog({ api, rule, sourceEtag, stale, canWrite, onChanged, onClose }: RuleEditDialogProps) {
  const [draftQuery, setDraftQuery] = useState(rule.query);
  const [draftHarness, setDraftHarness] = useState<AgentHarness>(rule.agentPreferences[0]?.harness ?? AGENT_HARNESSES[0]);
  const [draftModel, setDraftModel] = useState(rule.agentPreferences[0]?.model ?? "");
  const [forceCustomModel, setForceCustomModel] = useState(false);
  const [draftEffort, setDraftEffort] = useState<AgentEffort | "">(rule.agentPreferences[0]?.effort ?? "");
  const [draftPermissionMode, setDraftPermissionMode] = useState<RulePermissionMode | "">(rule.permissionMode ?? "");
  const [draftLizardMode, setDraftLizardMode] = useState(rule.lizardMode ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastWrite, setLastWrite] = useState<RuleWriteResult | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [scopePreview, setScopePreview] = useState<ScopePreviewState>({ kind: "idle" });
  const [catalog, setCatalog] = useState<readonly RuleFormCatalogEntry[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api.getCatalog().then((c) => {
      if (!cancelled) setCatalog(c);
    });
    return () => {
      cancelled = true;
    };
  }, [api]);

  const catalogEntry = catalog?.find((e) => e.harness === draftHarness);
  const shippedModels = catalogEntry?.models ?? [];
  const modelInShippedList = draftModel !== "" && shippedModels.includes(draftModel);
  const showCustomModelInput = forceCustomModel || (draftModel !== "" && !modelInShippedList);
  const modelSelectValue = showCustomModelInput ? "__custom__" : draftModel;
  const effortOptions = catalogEntry?.efforts ?? AGENT_EFFORTS;
  const permissionModeOptions = catalogEntry?.permissionModes ?? RULE_PERMISSION_MODES;

  const disabled = stale || busy || !canWrite;
  const queryChanged = draftQuery !== rule.query;

  function checkQueryScope() {
    setScopePreview({ kind: "loading" });
    api
      .previewRule(rule.id, undefined, draftQuery)
      .then((preview) => setScopePreview({ kind: "loaded", total: preview.total }))
      .catch((e: unknown) => setScopePreview({ kind: "error", error: e instanceof Error ? e.message : String(e) }));
  }

  function startAction(label: string, patch: Parameters<RulesApi["planRule"]>[1], commit: (planHash: string, confirm: boolean) => Promise<RuleWriteResult>) {
    setBusy(true);
    setError(null);
    api
      .planRule(rule.id, patch, false)
      .then(async (plan) => {
        if (plan.requiresConfirm) {
          let ticketKeys: string[] | undefined;
          if (patch.enabled === true && (plan.confirmReason === "swarm-enable" || plan.confirmReason === "scope-ceiling")) {
            try {
              const preview = await api.previewRule(rule.id);
              ticketKeys = preview.tickets.slice(0, 10).map((t) => t.key);
            } catch {
              ticketKeys = undefined;
            }
          }
          setPendingAction({ label, plan, commit, ...(ticketKeys ? { ticketKeys } : {}) });
          setBusy(false);
          return;
        }
        return commit(plan.planHash, false).then((result) => {
          setLastWrite(result);
          onChanged();
        });
      })
      .catch((e: unknown) => setError(describeWriteError(e)))
      .finally(() => setBusy(false));
  }

  function confirmPendingAction() {
    if (!pendingAction) return;
    setBusy(true);
    pendingAction
      .commit(pendingAction.plan.planHash, true)
      .then((result) => {
        setLastWrite(result);
        onChanged();
        setPendingAction(null);
      })
      .catch((e: unknown) => setError(describeWriteError(e)))
      .finally(() => setBusy(false));
  }

  function buildFieldsPatch(): RuleFieldPatch {
    const patch: RuleFieldPatch = {};
    if (draftQuery !== rule.query) patch.query = draftQuery;
    if (draftPermissionMode !== (rule.permissionMode ?? "")) patch.permissionMode = draftPermissionMode || undefined;
    if (draftLizardMode !== (rule.lizardMode ?? false)) patch.lizardMode = draftLizardMode;
    if (canEditPreferences(rule)) {
      const entry: RuleAgentPreferencePatch = { harness: draftHarness };
      if (draftModel) entry.model = draftModel;
      if (draftEffort) entry.effort = draftEffort;
      const current = rule.agentPreferences[0];
      const changed = !current || current.harness !== draftHarness || (current.model ?? "") !== draftModel || (current.effort ?? "") !== draftEffort;
      if (changed) patch.agentPreferences = [entry];
    }
    return patch;
  }

  function handleSave() {
    const patch = buildFieldsPatch();
    if (Object.keys(patch).length === 0) return;
    startAction("save rule", patch, (planHash, confirm) => api.updateFields(rule.id, patch, sourceEtag, planHash, confirm));
  }

  function handleUndo() {
    if (!lastWrite?.backupId) return;
    setBusy(true);
    setError(null);
    api
      .undo(lastWrite.backupId)
      .then(() => {
        setLastWrite(null);
        onChanged();
      })
      .catch((e: unknown) => setError(describeWriteError(e)))
      .finally(() => setBusy(false));
  }

  const isPlaceholder = draftQuery === PLACEHOLDER_QUERY;
  const hasChanges = Object.keys(buildFieldsPatch()).length > 0;

  return (
    <ModalOverlay
      isOpen
      isDismissable
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Modal>
        <Dialog aria-label={`edit rule ${rule.id}`} data-testid="rule-edit-dialog">
          <h3>Edit "{rule.id}"</h3>
          {stale && (
            <Alert status="info" data-testid="rule-edit-stale">
              <AlertText>reload pending — the rules file changed on disk; every control below is disabled until the next reload</AlertText>
            </Alert>
          )}
          {error !== null && (
            <Alert status="error" data-testid="rule-edit-error">
              <AlertText>{error}</AlertText>
            </Alert>
          )}

          <label htmlFor="rule-edit-query-input">query</label>
          <input
            id="rule-edit-query-input"
            type="text"
            aria-label="rule query"
            data-testid="rule-edit-query-input"
            value={draftQuery}
            onInput={(e) => {
              setDraftQuery((e.target as HTMLInputElement).value);
              setScopePreview({ kind: "idle" });
            }}
            disabled={disabled}
          />
          {isPlaceholder && (
            <Text elementType="p" size="small" className="rules-view__cnc" data-testid="rule-edit-placeholder-notice">
              this query is still the placeholder — this rule cannot be enabled until it is changed
            </Text>
          )}
          {queryChanged && (
            <div className="rules-view__scope-preview">
              <Button size="small" variant="minimal" isDisabled={disabled || scopePreview.kind === "loading"} onPress={checkQueryScope}>
                check scope for this query
              </Button>
              {scopePreview.kind === "loading" && <Text elementType="span" size="small"> checking…</Text>}
              {scopePreview.kind === "loaded" && (
                <Text elementType="span" size="small" data-testid="rule-edit-scope-count">
                  {" "}
                  would match {scopePreview.total} ticket{scopePreview.total === 1 ? "" : "s"}
                </Text>
              )}
              {scopePreview.kind === "error" && (
                <Text elementType="span" size="small" className="rules-view__cnc" data-testid="rule-edit-scope-error">
                  {" "}
                  could not check scope — {scopePreview.error}
                </Text>
              )}
            </div>
          )}

          {canEditPreferences(rule) ? (
            <>
              <label htmlFor="rule-edit-harness-select">provider</label>
              <select
                id="rule-edit-harness-select"
                aria-label="provider"
                data-testid="rule-edit-harness-select"
                value={draftHarness}
                onChange={(e) => {
                  setDraftHarness(e.target.value as AgentHarness);
                  setForceCustomModel(false);
                  setDraftModel("");
                  setDraftEffort("");
                }}
                disabled={disabled}
              >
                {(catalog?.map((c) => c.harness) ?? AGENT_HARNESSES).map((h) => (
                  <option key={h} value={h}>
                    {h}
                  </option>
                ))}
              </select>

              <label htmlFor="rule-edit-model-select">preferred model</label>
              <select
                id="rule-edit-model-select"
                aria-label="preferred model"
                data-testid="rule-edit-model-select"
                value={modelSelectValue}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === "__custom__") {
                    setForceCustomModel(true);
                  } else {
                    setForceCustomModel(false);
                    setDraftModel(v);
                  }
                }}
                disabled={disabled}
              >
                <option value="">butchr's default</option>
                {shippedModels.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
                {catalogEntry?.allowsCustomModel !== false && <option value="__custom__">Other…</option>}
              </select>
              {showCustomModelInput && (
                <input
                  id="rule-edit-model-input"
                  type="text"
                  aria-label="custom model id"
                  data-testid="rule-edit-model-input"
                  placeholder="custom model id"
                  value={draftModel}
                  onInput={(e) => setDraftModel((e.target as HTMLInputElement).value)}
                  disabled={disabled}
                />
              )}

              <label htmlFor="rule-edit-effort-select">preferred effort</label>
              <select
                id="rule-edit-effort-select"
                aria-label="preferred effort"
                data-testid="rule-edit-effort-select"
                value={draftEffort}
                onChange={(e) => setDraftEffort(e.target.value as AgentEffort | "")}
                disabled={disabled}
              >
                <option value="">butchr's default</option>
                {effortOptions.map((e) => (
                  <option key={e} value={e}>
                    {e}
                  </option>
                ))}
              </select>
            </>
          ) : (
            <Text elementType="p" size="small" data-testid="rule-edit-no-preference-slot">
              this rule has no agent preference slot to edit — it uses butchr's global agent config
            </Text>
          )}

          <label htmlFor="rule-edit-permission-mode-select">permission mode</label>
          <select
            id="rule-edit-permission-mode-select"
            aria-label="permission mode"
            data-testid="rule-edit-permission-mode-select"
            value={draftPermissionMode}
            onChange={(e) => setDraftPermissionMode(e.target.value as RulePermissionMode | "")}
            disabled={disabled}
          >
            <option value="">butchr's default</option>
            {permissionModeOptions.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          {draftPermissionMode === "bypassPermissions" || draftPermissionMode === "auto" ? (
            <Text elementType="p" size="small" className="rules-view__cnc" data-testid="rule-edit-risky-permission-notice">
              "{draftPermissionMode}" skips the agent's own permission prompts — saving this needs an explicit confirm
            </Text>
          ) : null}

          <label htmlFor="rule-edit-lizard-mode-toggle">lizard mode</label>
          <span className="first-rule-lizard-toggle" title="auto-answers unambiguous tool-permission prompts so the agent is never left frozen waiting on one">
            <Switch
              id="rule-edit-lizard-mode-toggle"
              data-testid="rule-edit-lizard-mode-toggle"
              isSelected={draftLizardMode}
              isDisabled={disabled}
              switchLabels={false}
              aria-label="lizard mode"
              onChange={(isSelected) => setDraftLizardMode(isSelected)}
            />
          </span>
          {draftLizardMode && (
            <Text elementType="p" size="small" className="rules-view__cnc" data-testid="rule-edit-lizard-notice">
              lizard mode is never a default — saving this needs an explicit confirm
            </Text>
          )}

          {pendingAction && (
            <Alert status="warning" data-testid="rule-edit-confirm">
              <AlertText>
                this would start {pendingAction.plan.spawned} agent{pendingAction.plan.spawned === 1 ? "" : "s"}
                {pendingAction.plan.scopeCount !== undefined ? `, scope ${pendingAction.plan.scopeCount} ticket${pendingAction.plan.scopeCount === 1 ? "" : "s"}` : ""}, stop{" "}
                {pendingAction.plan.stopped}, and restart {pendingAction.plan.restarted} — confirm {pendingAction.label}?
                {(pendingAction.plan.confirmReason === "swarm-enable" || pendingAction.plan.confirmReason === "scope-ceiling") && (
                  <span data-testid="rule-edit-confirm-tickets">
                    {" "}
                    This will staff up to {pendingAction.plan.scopeCount ?? pendingAction.plan.spawned} ticket{(pendingAction.plan.scopeCount ?? pendingAction.plan.spawned) === 1 ? "" : "s"}
                    {pendingAction.ticketKeys && pendingAction.ticketKeys.length > 0 ? `: ${pendingAction.ticketKeys.join(", ")}` : ""}
                    {pendingAction.ticketKeys && pendingAction.ticketKeys.length === 10 ? ", ..." : ""}
                  </span>
                )}
              </AlertText>
              <div className="rules-view__dialog-actions">
                <Button variant="default" onPress={() => setPendingAction(null)}>
                  cancel
                </Button>
                <Button variant="primary" onPress={confirmPendingAction}>
                  confirm
                </Button>
              </div>
            </Alert>
          )}

          <div className="rules-view__dialog-actions">
            <Button variant="default" onPress={onClose}>
              close
            </Button>
            {lastWrite?.backupId && (
              <Button variant="minimal" isDisabled={stale || busy || !canWrite} data-testid="rule-edit-undo" onPress={handleUndo}>
                Undo last change
              </Button>
            )}
            <Button variant="primary" isDisabled={disabled || !hasChanges} onPress={handleSave}>
              Save
            </Button>
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
