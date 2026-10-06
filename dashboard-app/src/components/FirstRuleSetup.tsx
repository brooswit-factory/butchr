/**
 * FACTORY-663 — "Set up your first rule": the ONLY write-capable flow this
 * ticket builds, and it only ever targets the one seeded template rule,
 * `FIRST_RULE_ID` ("ui-first-rule", FACTORY-669). No generic "create a
 * rule" capability exists anywhere in this component or the module it talks
 * to (`../api/rules.js`) — see that module's own top comment.
 *
 * TWO RENDERED STATES:
 *   - `rule` is `undefined` (the template hasn't been seeded onto this
 *     daemon's rules file yet): shows how to add it — a JSON snippet, the
 *     file path, and a copy button. NEVER writes anything itself; adding
 *     the file is always a manual step outside this UI (scope discipline:
 *     "no new server/API endpoints").
 *   - `rule` is present: the guided form (starter query examples, a
 *     model/effort picker when the rule already carries a preference slot
 *     to edit — see `canEditPreferences`'s own comment for why an EMPTY
 *     `agentPreferences` array can't just grow one), Preview (via the
 *     existing `RulePreviewDialog`), Save, Enable/Disable, and Undo.
 *
 * WRITE DISCIPLINE (ticket items 3-5): every write goes through
 * `planRule` FIRST to get a fresh `planHash` — the SAME plan the real
 * server computes, which already decides whether a stop/restart/over-
 * ceiling confirm is required (`needsConfirmFor` below). A write is never
 * attempted with a stale or guessed `planHash`, and `ifMatch` is ALWAYS
 * `sourceEtag` (never `fileEtag` — ticket item 5). `stale` disables every
 * control here outright, independent of `canWrite`.
 */
import { useState } from "react";
import { Alert, AlertText, Button, Text } from "@launchpad-ui/components";
import { AGENT_EFFORTS, type AgentEffort } from "../../../src/resources/power-scale.js";
import {
  ENABLE_SCOPE_CEILING,
  FIRST_RULE_ID,
  PLACEHOLDER_QUERY,
  type RuleAgentPreferencePatch,
  type RuleDto,
  type RuleFieldPatch,
  type RulePlanResponse,
  type RuleWriteResult,
  type RulesApi,
} from "../api/rules.js";
import { RulePreviewDialog } from "./RulePreviewDialog.js";
import "./RulesView.css";

export interface FirstRuleSetupProps {
  api: RulesApi;
  rule: RuleDto | undefined;
  sourceEtag: string;
  stale: boolean;
  canWrite: boolean;
  /** Called after any successful write/undo so the caller can trigger a fresh `GET /api/rules` poll — this component never refetches on its own. */
  onChanged: () => void;
}

const STARTER_QUERIES: { label: string; query: string }[] = [
  { label: "one specific ticket", query: "key = XYZ-1" },
  { label: "my assigned tickets", query: "assignee = currentUser() AND status != Done" },
  { label: "a whole project's open tickets", query: 'project = XYZ AND status = "To Do"' },
];

const RULES_FILE_PATH_HINT = "$BUTCHR_RULES_FILE, else $XDG_CONFIG_HOME/butchr/rules.json, else ~/.config/butchr/rules.json";

const MISSING_TEMPLATE_SNIPPET = `{
  "id": "${FIRST_RULE_ID}",
  "resourceProvider": "jira-work",
  "query": "${PLACEHOLDER_QUERY}",
  "enabled": false,
  "brief": "Describe what this agent should do when it picks up a matching ticket.",
  "agentPreferences": []
}`;

interface PendingAction {
  label: string;
  plan: RulePlanResponse;
  commit: (planHash: string, confirm: boolean) => Promise<RuleWriteResult>;
}

/**
 * The server's own `PUT /api/rules/:id` constraint (`rules-write-apply.ts`,
 * PR #647): a patch's `agentPreferences` array must be the SAME LENGTH as
 * the rule's current one — there is no way to grow it from empty through
 * this endpoint. `ui-first-rule` is seeded with `agentPreferences: []`
 * (FACTORY-669), so unless an operator has since hand-edited the file to
 * add a slot, this form has nothing to edit — it says so plainly rather
 * than rendering pickers that would always 400.
 */
function canEditPreferences(rule: RuleDto): boolean {
  return rule.agentPreferences.length > 0;
}

export function FirstRuleSetup({ api, rule, sourceEtag, stale, canWrite, onChanged }: FirstRuleSetupProps) {
  const [draftQuery, setDraftQuery] = useState(rule?.query ?? "");
  const [draftModel, setDraftModel] = useState(rule?.agentPreferences[0]?.model ?? "");
  const [draftEffort, setDraftEffort] = useState<AgentEffort | "">(rule?.agentPreferences[0]?.effort ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastWrite, setLastWrite] = useState<RuleWriteResult | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);

  const disabled = stale || busy || !canWrite;

  function startAction(label: string, patch: Parameters<RulesApi["planRule"]>[1], commit: (planHash: string, confirm: boolean) => Promise<RuleWriteResult>) {
    if (!rule) return;
    setBusy(true);
    setError(null);
    api
      .planRule(rule.id, patch, false)
      .then((plan) => {
        const overCeiling = patch.enabled === true && plan.scopeCount !== undefined && plan.scopeCount > ENABLE_SCOPE_CEILING;
        const needsConfirm = plan.stopped > 0 || plan.restarted > 0 || overCeiling;
        if (needsConfirm) {
          setPendingAction({ label, plan, commit });
          setBusy(false);
          return;
        }
        return commit(plan.planHash, false).then((result) => {
          setLastWrite(result);
          onChanged();
        });
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
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
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  }

  function handleSaveQuery() {
    if (!rule) return;
    startAction("save query", { query: draftQuery }, (planHash, confirm) => api.updateFields(rule.id, { query: draftQuery }, sourceEtag, planHash, confirm));
  }

  function handleSavePreferences() {
    if (!rule || !canEditPreferences(rule)) return;
    const entry: RuleAgentPreferencePatch = {};
    if (draftModel) entry.model = draftModel;
    if (draftEffort) entry.effort = draftEffort;
    const patch: RuleFieldPatch = { agentPreferences: [entry] };
    startAction("save agent preferences", patch, (planHash, confirm) => api.updateFields(rule.id, patch, sourceEtag, planHash, confirm));
  }

  function handleEnable() {
    if (!rule) return;
    startAction("enable", { enabled: true }, (planHash, confirm) => api.setEnabled(rule.id, true, sourceEtag, planHash, confirm));
  }

  function handleDisable() {
    if (!rule) return;
    startAction("disable", { enabled: false }, (planHash, confirm) => api.setEnabled(rule.id, false, sourceEtag, planHash, confirm));
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
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  }

  function handleCopySnippet() {
    try {
      void navigator.clipboard.writeText(MISSING_TEMPLATE_SNIPPET);
      setCopyStatus("copied");
    } catch {
      setCopyStatus("could not copy — select the text above manually");
    }
  }

  if (!rule) {
    return (
      <section className="rules-view__first-rule" data-testid="first-rule-missing" aria-labelledby="first-rule-heading">
        <Text elementType="h3" id="first-rule-heading">
          Set up your first rule
        </Text>
        <Text elementType="p">
          Butchr found no "{FIRST_RULE_ID}" template in the rules file yet. Add this to the <code>rules</code> array in {RULES_FILE_PATH_HINT}:
        </Text>
        <pre className="rules-view__snippet" data-testid="first-rule-snippet">
          {MISSING_TEMPLATE_SNIPPET}
        </pre>
        <Button size="small" onPress={handleCopySnippet}>
          copy snippet
        </Button>
        {copyStatus && <Text elementType="span" size="small" data-testid="first-rule-copy-status"> {copyStatus}</Text>}
      </section>
    );
  }

  const isPlaceholder = rule.query === PLACEHOLDER_QUERY;

  return (
    <section className="rules-view__first-rule" data-testid="first-rule-setup" aria-labelledby="first-rule-heading">
      <Text elementType="h3" id="first-rule-heading">
        Set up your first rule
      </Text>
      {stale && (
        <Alert status="info" data-testid="first-rule-stale">
          <AlertText>reload pending — the rules file changed on disk; every control below is disabled until the next reload</AlertText>
        </Alert>
      )}
      {error !== null && (
        <Alert status="error" data-testid="first-rule-error">
          <AlertText>{error}</AlertText>
        </Alert>
      )}
      <Text elementType="span" size="small" className={rule.enabled ? "rules-table__badge rules-table__badge--enabled" : "rules-table__badge rules-table__badge--disabled"}>
        {rule.enabled ? "enabled" : "disabled"}
      </Text>

      <label htmlFor="first-rule-query-input">query</label>
      {/* `onInput`, not `onChange`: functionally identical for a live text
          field (both fire per keystroke; React's own `onChange` for
          `<input type="text">` is itself backed by the native `input`
          event under the hood), kept this way because it is the one that
          this repo's own component-test harness (happy-dom via
          `test/setup/happy-dom.ts`) reliably delivers to a React 19 root
          for a plain controlled text input — `fireEvent.change` was
          observed NOT firing `onChange` at all in that harness during this
          ticket's own testing, confirmed with a minimal repro outside this
          component. */}
      <input
        id="first-rule-query-input"
        type="text"
        aria-label="rule query"
        data-testid="first-rule-query-input"
        value={draftQuery}
        onInput={(e) => setDraftQuery((e.target as HTMLInputElement).value)}
        disabled={disabled}
      />
      <div className="rules-view__starter-queries">
        {STARTER_QUERIES.map((s) => (
          <Button key={s.label} size="small" variant="minimal" isDisabled={disabled} onPress={() => setDraftQuery(s.query)}>
            {s.label}
          </Button>
        ))}
      </div>
      {isPlaceholder && draftQuery === PLACEHOLDER_QUERY && (
        <Text elementType="p" size="small" className="rules-view__cnc" data-testid="first-rule-placeholder-notice">
          this rule's query is still the placeholder — pick a starter example or write your own, then save, before enabling
        </Text>
      )}
      <Button size="small" isDisabled={disabled} onPress={handleSaveQuery}>
        save query
      </Button>

      {canEditPreferences(rule) ? (
        <>
          <label htmlFor="first-rule-model-input">preferred model</label>
          <input
            id="first-rule-model-input"
            type="text"
            aria-label="preferred model"
            data-testid="first-rule-model-input"
            value={draftModel}
            onInput={(e) => setDraftModel((e.target as HTMLInputElement).value)}
            disabled={disabled}
          />
          <label htmlFor="first-rule-effort-select">preferred effort</label>
          <select
            id="first-rule-effort-select"
            aria-label="preferred effort"
            data-testid="first-rule-effort-select"
            value={draftEffort}
            onChange={(e) => setDraftEffort(e.target.value as AgentEffort | "")}
            disabled={disabled}
          >
            <option value="">butchr's default</option>
            {AGENT_EFFORTS.map((e) => (
              <option key={e} value={e}>
                {e}
              </option>
            ))}
          </select>
          <Button size="small" isDisabled={disabled} onPress={handleSavePreferences}>
            save model/effort
          </Button>
        </>
      ) : (
        <Text elementType="p" size="small" data-testid="first-rule-no-preference-slot">
          this rule has no agent preference slot to edit yet — it uses butchr's global agent config
        </Text>
      )}

      <Button size="small" variant="minimal" isDisabled={!rule || busy} onPress={() => setPreviewOpen(true)}>
        Preview
      </Button>
      {previewOpen && <RulePreviewDialog ruleId={rule.id} resourceProvider={rule.resourceProvider} api={api} onClose={() => setPreviewOpen(false)} />}

      {rule.enabled ? (
        <Button size="small" variant="primary" isDisabled={disabled} onPress={handleDisable}>
          Disable
        </Button>
      ) : (
        <Button size="small" variant="primary" isDisabled={disabled} onPress={handleEnable}>
          Enable
        </Button>
      )}

      {lastWrite?.backupId && (
        <Button size="small" variant="minimal" isDisabled={stale || busy || !canWrite} data-testid="first-rule-undo" onPress={handleUndo}>
          Undo last change
        </Button>
      )}

      {pendingAction && (
        <Alert status="warning" data-testid="first-rule-confirm">
          <AlertText>
            this would start {pendingAction.plan.spawned} agent{pendingAction.plan.spawned === 1 ? "" : "s"}
            {pendingAction.plan.scopeCount !== undefined ? `, scope ${pendingAction.plan.scopeCount} ticket${pendingAction.plan.scopeCount === 1 ? "" : "s"}` : ""}, stop{" "}
            {pendingAction.plan.stopped}, and restart {pendingAction.plan.restarted} — confirm {pendingAction.label}?
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
    </section>
  );
}
