/**
 * FACTORY-927 (epic FACTORY-659, story FACTORY-802) — "Create a rule": the
 * ONLY place an operator can add a brand-new rule from the Rules page,
 * closing the last gap the epic's own headline outcome depends on ("set up
 * and run a first rule from the dashboard" without hand-editing
 * `rules.json`). Deliberately mirrors `RuleEditDialog.tsx`'s own write
 * discipline rather than inventing a second one: the harness/model/effort/
 * permission-mode options come from `GET /api/rules/catalog`
 * (`api.getCatalog()`), never a second, hand-maintained list.
 *
 * ONE ROUND TRIP, TWO CALLS (AC5): `api.createRule(draft, false)` is called
 * first — the server computes its own fresh plan internally and refuses
 * with a 409 naming the dry-run scope in its message text (never a
 * separate "plan" endpoint to call first: `src/web/view.ts`'s `POST
 * /api/rules` route always plans before writing, on every call) — that
 * refusal becomes the confirm step shown below; pressing "confirm create"
 * resends the SAME draft with `confirm: true`. There is no client-side
 * `planHash` to track at all (unlike `RuleEditDialog`'s `planRule`/
 * `updateFields` pair) — the server never asks for one on this route.
 *
 * SCOPE CUT (deliberate, v1): `brief`/`execution`/`account` are not
 * settable here — the server hardcodes them (`createRule`'s own doc
 * comment, `src/rules/rules-write.ts`) to the same defaults
 * `seed-first-run.ts`'s template rule uses. The new rule is ALWAYS created
 * disabled; there is no "enabled" field anywhere in this dialog because the
 * server never accepts one for create (AC4).
 */
import { useEffect, useState } from "react";
import { Button, Dialog, Modal, ModalOverlay, Switch } from "@launchpad-ui/components";
import { AGENT_EFFORTS, type AgentEffort } from "../../../src/resources/power-scale.js";
// Imported from the LEAF module, never `../../../src/rules/rules.js` directly — see `FirstRuleSetup.tsx`'s own top comment for why a VALUE import from that module breaks the Vite client bundle.
import { AGENT_HARNESSES, RULE_PERMISSION_MODES, type AgentHarness, type AgentRole, type RulePermissionMode } from "../../../src/rules/agent-harness.js";
import { RESOURCE_PROVIDERS, type ResourceProvider } from "../../../src/rules/agent-key.js";
import {
  RateLimitError,
  type RuleAgentPreferencePatch,
  type RuleCapacityRolesCatalog,
  type RuleCreateDraft,
  type RuleFormCatalogEntry,
  type RuleWriteResult,
  type RulesApi,
} from "../api/rules.js";
import "./RulesView.css";

export interface CreateRuleDialogProps {
  api: RulesApi;
  canWrite: boolean;
  stale: boolean;
  /** Called after a successful create so the caller can trigger a fresh `GET /api/rules` poll — this component never refetches on its own, same discipline as `RuleEditDialog`'s own `onChanged`. */
  onChanged: () => void;
  onClose: () => void;
}

/** Mirrors `RuleEditDialog.tsx`'s own `describeWriteError`. */
function describeWriteError(e: unknown): string {
  if (e instanceof RateLimitError && e.retryAfterSeconds !== undefined) {
    return `Too many changes — try again in ${e.retryAfterSeconds}s`;
  }
  return e instanceof Error ? e.message : String(e);
}

export function CreateRuleDialog({ api, canWrite, stale, onChanged, onClose }: CreateRuleDialogProps) {
  const [id, setId] = useState("");
  const [resourceProvider, setResourceProvider] = useState<ResourceProvider>(RESOURCE_PROVIDERS[0]);
  const [query, setQuery] = useState("");
  const [harness, setHarness] = useState<AgentHarness>(AGENT_HARNESSES[0]);
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState<AgentEffort | "">("");
  const [setPreference, setSetPreference] = useState(false);
  const [permissionMode, setPermissionMode] = useState<RulePermissionMode | "">("");
  const [lizardMode, setLizardMode] = useState(false);
  const [role, setRole] = useState<AgentRole>("worker");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The server's own "resend with confirm: true" refusal from the first (unconfirmed) call — its message carries the dry-run scope, shown as the confirm step. `null` means no pending confirmation. */
  const [pendingConfirmMessage, setPendingConfirmMessage] = useState<string | null>(null);
  const [created, setCreated] = useState<RuleWriteResult | null>(null);
  const [catalog, setCatalog] = useState<readonly RuleFormCatalogEntry[] | null>(null);
  const [capacityRoles, setCapacityRoles] = useState<RuleCapacityRolesCatalog | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api.getCatalog().then((c) => {
      if (!cancelled) setCatalog(c);
    });
    void api.getCapacityRoles().then((c) => {
      if (!cancelled) setCapacityRoles(c);
    });
    return () => {
      cancelled = true;
    };
  }, [api]);

  const catalogEntry = catalog?.find((e) => e.harness === harness);
  const shippedModels = catalogEntry?.models ?? [];
  const effortOptions = catalogEntry?.efforts ?? AGENT_EFFORTS;
  const permissionModeOptions = catalogEntry?.permissionModes ?? RULE_PERMISSION_MODES;

  const disabled = stale || busy || !canWrite;
  const canSubmit = id.trim() !== "" && query.trim() !== "" && !disabled;

  function buildDraft(): RuleCreateDraft {
    const draft: RuleCreateDraft = { id: id.trim(), resourceProvider, query: query.trim() };
    if (permissionMode) draft.permissionMode = permissionMode;
    if (lizardMode) draft.lizardMode = lizardMode;
    if (role !== "worker") draft.role = role;
    if (setPreference) {
      const entry: RuleAgentPreferencePatch & { harness: AgentHarness } = { harness };
      if (model) entry.model = model;
      if (effort) entry.effort = effort;
      draft.agentPreferences = [entry];
    }
    return draft;
  }

  function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    api
      .createRule(buildDraft(), false)
      .then((result) => {
        // The server accepted a create with `confirm: false`? Cannot happen
        // per the route's own unconditional confirm gate (AC5) — but handle
        // it defensively rather than assume: treat it as done.
        setCreated(result);
        onChanged();
      })
      .catch((e: unknown) => setPendingConfirmMessage(describeWriteError(e)))
      .finally(() => setBusy(false));
  }

  function confirmCreate() {
    setBusy(true);
    setError(null);
    api
      .createRule(buildDraft(), true)
      .then((result) => {
        setPendingConfirmMessage(null);
        setCreated(result);
        onChanged();
      })
      .catch((e: unknown) => setError(describeWriteError(e)))
      .finally(() => setBusy(false));
  }

  if (created) {
    return (
      <ModalOverlay isOpen isDismissable onOpenChange={(open) => { if (!open) onClose(); }}>
        <Modal>
          <Dialog aria-label="rule created" data-testid="create-rule-done-dialog">
            <h3>Rule "{id}" created</h3>
            <p data-testid="create-rule-done-notice">
              It was created DISABLED — enable it from the Rules table once you're ready for it to start matching tickets.
            </p>
            <div className="rules-view__dialog-actions">
              <Button variant="primary" onPress={onClose}>
                close
              </Button>
            </div>
          </Dialog>
        </Modal>
      </ModalOverlay>
    );
  }

  return (
    <ModalOverlay isOpen isDismissable onOpenChange={(open) => { if (!open) onClose(); }}>
      <Modal>
        <Dialog aria-label="create a new rule" data-testid="create-rule-dialog">
          <h3>Create a new rule</h3>
          {stale && (
            <p className="rules-view__cnc" data-testid="create-rule-stale">
              reload pending — the rules file changed on disk; every control below is disabled until the next reload
            </p>
          )}
          {error !== null && (
            <p className="rules-view__cnc" data-testid="create-rule-error">
              {error}
            </p>
          )}

          <label htmlFor="create-rule-id-input">id</label>
          <input
            id="create-rule-id-input"
            type="text"
            aria-label="rule id"
            data-testid="create-rule-id-input"
            placeholder="my-new-rule"
            value={id}
            onInput={(e) => setId((e.target as HTMLInputElement).value)}
            disabled={disabled}
          />

          <label htmlFor="create-rule-provider-select">resource type</label>
          <select
            id="create-rule-provider-select"
            aria-label="resource type"
            data-testid="create-rule-provider-select"
            value={resourceProvider}
            onChange={(e) => setResourceProvider(e.target.value as ResourceProvider)}
            disabled={disabled}
          >
            {RESOURCE_PROVIDERS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>

          <label htmlFor="create-rule-query-input">query</label>
          <input
            id="create-rule-query-input"
            type="text"
            aria-label="rule query"
            data-testid="create-rule-query-input"
            value={query}
            onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
            disabled={disabled}
          />
          <p data-testid="create-rule-disabled-notice">
            this rule will be created DISABLED — it won't match or staff anything until you enable it from the table
          </p>

          <label htmlFor="create-rule-set-preference-toggle">set a preferred agent</label>
          <Switch
            id="create-rule-set-preference-toggle"
            data-testid="create-rule-set-preference-toggle"
            isSelected={setPreference}
            isDisabled={disabled}
            switchLabels={false}
            aria-label="set a preferred agent"
            onChange={(isSelected) => setSetPreference(isSelected)}
          />
          {setPreference && (
            <>
              <label htmlFor="create-rule-harness-select">provider</label>
              <select
                id="create-rule-harness-select"
                aria-label="provider"
                data-testid="create-rule-harness-select"
                value={harness}
                onChange={(e) => {
                  setHarness(e.target.value as AgentHarness);
                  setModel("");
                  setEffort("");
                }}
                disabled={disabled}
              >
                {(catalog?.map((c) => c.harness) ?? AGENT_HARNESSES).map((h) => (
                  <option key={h} value={h}>
                    {h}
                  </option>
                ))}
              </select>

              <label htmlFor="create-rule-model-input">preferred model</label>
              <input
                id="create-rule-model-input"
                type="text"
                aria-label="preferred model"
                data-testid="create-rule-model-input"
                list="create-rule-model-options"
                placeholder="butchr's default"
                value={model}
                onInput={(e) => setModel((e.target as HTMLInputElement).value)}
                disabled={disabled}
              />
              <datalist id="create-rule-model-options">
                {shippedModels.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>

              <label htmlFor="create-rule-effort-select">preferred effort</label>
              <select
                id="create-rule-effort-select"
                aria-label="preferred effort"
                data-testid="create-rule-effort-select"
                value={effort}
                onChange={(e) => setEffort(e.target.value as AgentEffort | "")}
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
          )}

          <label htmlFor="create-rule-permission-mode-select">permission mode</label>
          <select
            id="create-rule-permission-mode-select"
            aria-label="permission mode"
            data-testid="create-rule-permission-mode-select"
            value={permissionMode}
            onChange={(e) => setPermissionMode(e.target.value as RulePermissionMode | "")}
            disabled={disabled}
          >
            <option value="">butchr's default</option>
            {permissionModeOptions.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          {permissionMode === "bypassPermissions" || permissionMode === "auto" ? (
            <p className="rules-view__cnc" data-testid="create-rule-risky-permission-notice">
              "{permissionMode}" skips the agent's own permission prompts
            </p>
          ) : null}

          <label htmlFor="create-rule-lizard-mode-toggle">lizard mode</label>
          <Switch
            id="create-rule-lizard-mode-toggle"
            data-testid="create-rule-lizard-mode-toggle"
            isSelected={lizardMode}
            isDisabled={disabled}
            switchLabels={false}
            aria-label="lizard mode"
            onChange={(isSelected) => setLizardMode(isSelected)}
          />

          <label htmlFor="create-rule-capacity-toggle">Included in capacity</label>
          <Switch
            id="create-rule-capacity-toggle"
            data-testid="create-rule-capacity-toggle"
            isSelected={role === "worker"}
            isDisabled={disabled || resourceProvider === "jira-project"}
            switchLabels={false}
            aria-label="Included in capacity"
            onChange={(isSelected) => setRole(isSelected ? "worker" : "sentinel")}
          />
          {capacityRoles && (
            <p data-testid="create-rule-capacity-default-hint">butchr's own default is "{capacityRoles.default}" (counted)</p>
          )}

          {pendingConfirmMessage !== null && (
            <div className="rules-view__cnc" data-testid="create-rule-confirm">
              <p data-testid="create-rule-confirm-message">{pendingConfirmMessage}</p>
              <div className="rules-view__dialog-actions">
                <Button variant="default" onPress={() => setPendingConfirmMessage(null)}>
                  cancel
                </Button>
                <Button variant="primary" onPress={confirmCreate} data-testid="create-rule-confirm-button">
                  confirm create
                </Button>
              </div>
            </div>
          )}

          <div className="rules-view__dialog-actions">
            <Button variant="default" onPress={onClose}>
              cancel
            </Button>
            <Button variant="primary" isDisabled={!canSubmit} onPress={submit} data-testid="create-rule-submit">
              Create
            </Button>
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
