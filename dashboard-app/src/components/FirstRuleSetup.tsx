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
 *     provider/model/effort picker when the rule already carries a
 *     preference slot to edit — see `canEditPreferences`'s own comment for
 *     why an EMPTY `agentPreferences` array can't just grow one — plus a
 *     permission-mode picker and lizard-mode toggle, FACTORY-729, which
 *     apply regardless of that slot), Preview (via the existing
 *     `RulePreviewDialog`), Save, Enable/Disable, and Undo.
 *
 * FACTORY-729: the provider/model/effort/permission-mode options above are
 * never hardcoded here — all four, plus whether a custom model id is
 * allowed, are fetched once on mount from `GET /api/rules/catalog`
 * (`api.getCatalog()`), the SAME catalog (`../../../src/rules/rule-form-
 * catalog.js`'s `RULE_FORM_CATALOG`) the write path's own validator checks
 * every submitted value against server-side.
 *
 * WRITE DISCIPLINE (ticket items 3-5): every write goes through
 * `planRule` FIRST to get a fresh `planHash` — the SAME plan the real
 * server computes, which already decides whether a stop/restart/over-
 * ceiling confirm is required (`needsConfirmFor` below). A write is never
 * attempted with a stale or guessed `planHash`, and `ifMatch` is ALWAYS
 * `sourceEtag` (never `fileEtag` — ticket item 5). `stale` disables every
 * control here outright, independent of `canWrite`.
 */
import { useEffect, useState } from "react";
import { Alert, AlertText, Button, Switch, Text } from "@launchpad-ui/components";
import { AGENT_EFFORTS, type AgentEffort } from "../../../src/resources/power-scale.js";
import { AGENT_HARNESSES, RULE_PERMISSION_MODES, type AgentHarness, type RulePermissionMode } from "../../../src/rules/rules.js";
import {
  FIRST_RULE_ID,
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

/**
 * FACTORY-678 (landing soon, not yet merged): the server's upcoming
 * write-rate-limit refusal is a `RateLimitError` (see `../api/rules.js`),
 * not a plain `Error`. When it carries a parsed `Retry-After` value, show
 * something a user can act on ("try again in Ns") rather than the generic
 * verbatim `{error}` text. No `Retry-After` header was present on the
 * response (always possible) -> fall back to that generic message, same as
 * every other write refusal this component already renders.
 */
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
  /** FACTORY-685 (item 3): first page of ticket keys this action would staff — only populated for an enable whose `confirmReason` is `"swarm-enable"`/`"scope-ceiling"`. */
  ticketKeys?: string[];
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
  const [draftHarness, setDraftHarness] = useState<AgentHarness>(rule?.agentPreferences[0]?.harness ?? AGENT_HARNESSES[0]);
  const [draftModel, setDraftModel] = useState(rule?.agentPreferences[0]?.model ?? "");
  /** Set only by explicitly picking "Other…" in the model select below — reset whenever a shipped model (or "butchr's default") is picked instead. `showCustomModelInput` below ALSO goes true automatically once the catalog loads if the rule's current model isn't in the shipped list, with no need for this flag to anticipate that. */
  const [forceCustomModel, setForceCustomModel] = useState(false);
  const [draftEffort, setDraftEffort] = useState<AgentEffort | "">(rule?.agentPreferences[0]?.effort ?? "");
  const [draftPermissionMode, setDraftPermissionMode] = useState<RulePermissionMode | "">(rule?.permissionMode ?? "");
  const [draftLizardMode, setDraftLizardMode] = useState(rule?.lizardMode ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastWrite, setLastWrite] = useState<RuleWriteResult | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  // FACTORY-729: `GET /api/rules/catalog`, fetched once on mount — the
  // single source for the harness/model/effort/permission-mode dropdowns
  // below, never a hardcoded list. `null` until it resolves (the pickers
  // render with no options meanwhile — `stale`/`busy` already disable every
  // control until the first `/api/rules` poll lands anyway, so a brief
  // catalog-less render is not actionable either way).
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

  function startAction(label: string, patch: Parameters<RulesApi["planRule"]>[1], commit: (planHash: string, confirm: boolean) => Promise<RuleWriteResult>) {
    if (!rule) return;
    setBusy(true);
    setError(null);
    api
      .planRule(rule.id, patch, false)
      .then(async (plan) => {
        // FACTORY-685 (item 2/3): trust the server's own `requiresConfirm`
        // verdict — it already folds in every gate (the scope ceiling, a
        // stop/restart, an unmeasurable scope, and now ANY swarm enable),
        // rather than re-deriving it here from `stopped`/`restarted`/
        // `scopeCount` and risking drift from a gate added server-side.
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

  function handleSaveQuery() {
    if (!rule) return;
    startAction("save query", { query: draftQuery }, (planHash, confirm) => api.updateFields(rule.id, { query: draftQuery }, sourceEtag, planHash, confirm));
  }

  function handleSavePreferences() {
    if (!rule || !canEditPreferences(rule)) return;
    const entry: RuleAgentPreferencePatch = { harness: draftHarness };
    if (draftModel) entry.model = draftModel;
    if (draftEffort) entry.effort = draftEffort;
    const patch: RuleFieldPatch = { agentPreferences: [entry] };
    startAction("save agent preferences", patch, (planHash, confirm) => api.updateFields(rule.id, patch, sourceEtag, planHash, confirm));
  }

  /**
   * FACTORY-729 — `permissionMode`/`lizardMode` share one Save button: both
   * are top-level `Rule` fields (unlike `agentPreferences`, there is no
   * per-slot gate to check first). `permissionMode: ""` ("butchr's
   * default") is OMITTED from the patch entirely rather than sent as some
   * sentinel — there is no "clear this field" value on the wire, only
   * "don't mention it" (same discipline `draftModel`/`draftEffort` already
   * follow in `handleSavePreferences` above). `lizardMode` is always sent —
   * a checkbox has no "leave unchanged" state to omit instead.
   */
  function handleSaveLaunchSettings() {
    if (!rule) return;
    const patch: RuleFieldPatch = { lizardMode: draftLizardMode, ...(draftPermissionMode ? { permissionMode: draftPermissionMode } : {}) };
    startAction("save launch settings", patch, (planHash, confirm) => api.updateFields(rule.id, patch, sourceEtag, planHash, confirm));
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
      .catch((e: unknown) => setError(describeWriteError(e)))
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
          <label htmlFor="first-rule-harness-select">provider</label>
          {/* FACTORY-729 — `AGENT_HARNESSES` fallback keeps this select
              populated before the catalog resolves; its OWN values are what
              drive `catalogEntry` (and so the model/effort options below)
              once it does. */}
          <select
            id="first-rule-harness-select"
            aria-label="provider"
            data-testid="first-rule-harness-select"
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

          <label htmlFor="first-rule-model-select">preferred model</label>
          <select
            id="first-rule-model-select"
            aria-label="preferred model"
            data-testid="first-rule-model-select"
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
              id="first-rule-model-input"
              type="text"
              aria-label="custom model id"
              data-testid="first-rule-model-input"
              placeholder="custom model id"
              value={draftModel}
              onInput={(e) => setDraftModel((e.target as HTMLInputElement).value)}
              disabled={disabled}
            />
          )}

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
            {effortOptions.map((e) => (
              <option key={e} value={e}>
                {e}
              </option>
            ))}
          </select>
          <Button size="small" isDisabled={disabled} onPress={handleSavePreferences}>
            save provider/model/effort
          </Button>
        </>
      ) : (
        <Text elementType="p" size="small" data-testid="first-rule-no-preference-slot">
          this rule has no agent preference slot to edit yet — it uses butchr's global agent config
        </Text>
      )}

      <label htmlFor="first-rule-permission-mode-select">permission mode</label>
      <select
        id="first-rule-permission-mode-select"
        aria-label="permission mode"
        data-testid="first-rule-permission-mode-select"
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
        <Text elementType="p" size="small" className="rules-view__cnc" data-testid="first-rule-risky-permission-notice">
          "{draftPermissionMode}" skips the agent's own permission prompts — saving this needs an explicit confirm
        </Text>
      ) : null}

      <label htmlFor="first-rule-lizard-mode-toggle">lizard mode</label>
      <span className="rules-table__toggle" title="auto-answers unambiguous tool-permission prompts so the agent is never left frozen waiting on one">
        <Switch
          id="first-rule-lizard-mode-toggle"
          data-testid="first-rule-lizard-mode-toggle"
          isSelected={draftLizardMode}
          isDisabled={disabled}
          switchLabels={false}
          aria-label="lizard mode"
          onChange={(isSelected) => setDraftLizardMode(isSelected)}
        />
      </span>
      {draftLizardMode && (
        <Text elementType="p" size="small" className="rules-view__cnc" data-testid="first-rule-lizard-notice">
          lizard mode is never a default — saving this needs an explicit confirm
        </Text>
      )}
      <Button size="small" isDisabled={disabled} onPress={handleSaveLaunchSettings}>
        save permission mode/lizard mode
      </Button>

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
            {/* FACTORY-685 (item 3): "This will staff up to N tickets: <first 10 keys>" for a swarm enable/over-ceiling enable specifically. */}
            {(pendingAction.plan.confirmReason === "swarm-enable" || pendingAction.plan.confirmReason === "scope-ceiling") && (
              <span data-testid="first-rule-confirm-tickets">
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
    </section>
  );
}
