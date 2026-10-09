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
 * QUERY DRY-RUN (ticket item 3, review round 2): a CHANGED query is now a
 * SERVER-ENFORCED confirm gate, same mechanism as a stop/restart or a risky
 * permission — `planRule` dry-runs the NEW query text whenever it differs
 * from the rule's saved one (regardless of the rule's enabled state) and
 * reports it back as `scopeCount` with `confirmReason: "query-change"`.
 * Save always goes through `planRule` first; when that scope requires
 * confirming, the SAME confirm step every other gate here already uses
 * shows "this query would now match N ticket(s)" and the write is refused
 * server-side until `confirm: true` is resent — there is no separate,
 * optional "check scope" affordance to skip (a prior revision had one; the
 * review found it did not actually gate Save, which is the whole point of
 * AC3). A disabled rule's query edit, previously zero-blast-radius, now
 * ALSO goes through this confirm step.
 */
import { useEffect, useState } from "react";
import { Button, Dialog, Modal, ModalOverlay, Switch } from "@launchpad-ui/components";
import { AGENT_EFFORTS, type AgentEffort } from "../../../src/resources/power-scale.js";
// Imported from the LEAF module, never `../../../src/rules/rules.js` directly — see `FirstRuleSetup.tsx`'s own top comment for why a VALUE import from that module breaks the Vite client bundle.
import { AGENT_HARNESSES, RULE_PERMISSION_MODES, type AgentHarness, type AgentRole, type RulePermissionMode } from "../../../src/rules/agent-harness.js";
import {
  PLACEHOLDER_QUERY,
  RateLimitError,
  type RuleAgentPreferencePatch,
  type RuleCapacityRolesCatalog,
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

export function RuleEditDialog({ api, rule, sourceEtag, stale, canWrite, onChanged, onClose }: RuleEditDialogProps) {
  const [draftQuery, setDraftQuery] = useState(rule.query);
  const [draftHarness, setDraftHarness] = useState<AgentHarness>(rule.agentPreferences[0]?.harness ?? AGENT_HARNESSES[0]);
  const [draftModel, setDraftModel] = useState(rule.agentPreferences[0]?.model ?? "");
  const [forceCustomModel, setForceCustomModel] = useState(false);
  const [draftEffort, setDraftEffort] = useState<AgentEffort | "">(rule.agentPreferences[0]?.effort ?? "");
  const [draftPermissionMode, setDraftPermissionMode] = useState<RulePermissionMode | "">(rule.permissionMode ?? "");
  const [draftLizardMode, setDraftLizardMode] = useState(rule.lizardMode ?? false);
  // FACTORY-856 (story FACTORY-756) — "Included in capacity": `rule.role` is
  // never null on the wire (`Rule.role` defaults to `"worker"` at parse
  // time), so — same as `FirstRuleSetup.tsx`'s own `draftRole` — the toggle
  // always starts from the rule's own current, real value, no "butchr's
  // default" tri-state needed.
  const [draftRole, setDraftRole] = useState<AgentRole>(rule.role ?? "worker");
  // FACTORY-846 (epic FACTORY-836, story FACTORY-844) — same inherit-via-
  // empty contract as `FirstRuleSetup.tsx`'s own `draftIdlePoke*`:
  // `rule.idlePokeMinutes`/`idlePokeMessage` are nullable (`null` means
  // this rule inherits the global `stalledMinutes`/today's existing wake
  // text — NOT the epic's own 30/default-text seed), so the draft starts
  // EMPTY, never seeded with that epic default, when the rule's own value
  // is `null`. `buildFieldsPatch` below only includes a field when its
  // draft actually differs from the rule's current value (the same
  // diff-based pattern every other field here already uses), so clicking
  // Save never pins an untouched inherited field to a concrete number.
  const [draftIdlePokeMinutes, setDraftIdlePokeMinutes] = useState(rule.idlePokeMinutes != null ? String(rule.idlePokeMinutes) : "");
  const [draftIdlePokeMessage, setDraftIdlePokeMessage] = useState(rule.idlePokeMessage ?? "");
  // `idlePokeEnabled` is never `null` on `RuleDto` (`parseRules` always resolves it) — no inherit-ambiguity to protect, same as `lizardMode`.
  const [draftIdlePokeEnabled, setDraftIdlePokeEnabled] = useState(rule.idlePokeEnabled ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastWrite, setLastWrite] = useState<RuleWriteResult | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [catalog, setCatalog] = useState<readonly RuleFormCatalogEntry[] | null>(null);
  // FACTORY-856: fetched alongside the harness catalog above (same mount,
  // same `GET /api/rules/catalog` the server serves both fields from) —
  // used only for the "Included in capacity" default-hint copy, mirroring
  // `FirstRuleSetup.tsx`'s own `capacityRoles`.
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

  const catalogEntry = catalog?.find((e) => e.harness === draftHarness);
  const shippedModels = catalogEntry?.models ?? [];
  const modelInShippedList = draftModel !== "" && shippedModels.includes(draftModel);
  const showCustomModelInput = forceCustomModel || (draftModel !== "" && !modelInShippedList);
  const modelSelectValue = showCustomModelInput ? "__custom__" : draftModel;
  const effortOptions = catalogEntry?.efforts ?? AGENT_EFFORTS;
  const permissionModeOptions = catalogEntry?.permissionModes ?? RULE_PERMISSION_MODES;

  const disabled = stale || busy || !canWrite;
  const queryChanged = draftQuery !== rule.query;

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
    if (draftRole !== (rule.role ?? "worker")) patch.role = draftRole;
    // FACTORY-846: diff against the rule's current (possibly-null) value —
    // an EMPTY draft (never touched, or cleared back to empty) never sends
    // a field, since `RuleFieldPatch.idlePokeMinutes`/`idlePokeMessage`
    // have no "clear back to inherit" encoding (same limitation
    // `permissionMode` already has above — there is no way to unset it
    // back to "butchr's default" through this dialog either).
    const currentIdlePokeMinutesStr = rule.idlePokeMinutes != null ? String(rule.idlePokeMinutes) : "";
    if (draftIdlePokeMinutes !== currentIdlePokeMinutesStr && draftIdlePokeMinutes !== "") patch.idlePokeMinutes = Number(draftIdlePokeMinutes);
    const currentIdlePokeMessage = rule.idlePokeMessage ?? "";
    if (draftIdlePokeMessage !== currentIdlePokeMessage && draftIdlePokeMessage !== "") patch.idlePokeMessage = draftIdlePokeMessage;
    if (draftIdlePokeEnabled !== (rule.idlePokeEnabled ?? true)) patch.idlePokeEnabled = draftIdlePokeEnabled;
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
            <p className="rules-view__cnc" data-testid="rule-edit-stale">
              reload pending — the rules file changed on disk; every control below is disabled until the next reload
            </p>
          )}
          {error !== null && (
            <p className="rules-view__cnc" data-testid="rule-edit-error">
              {error}
            </p>
          )}

          <label htmlFor="rule-edit-query-input">query</label>
          <input
            id="rule-edit-query-input"
            type="text"
            aria-label="rule query"
            data-testid="rule-edit-query-input"
            value={draftQuery}
            onInput={(e) => setDraftQuery((e.target as HTMLInputElement).value)}
            disabled={disabled}
          />
          {isPlaceholder && (
            <p className="rules-view__cnc" data-testid="rule-edit-placeholder-notice">
              this query is still the placeholder — this rule cannot be enabled until it is changed
            </p>
          )}
          {queryChanged && (
            <p className="rules-view__cnc" data-testid="rule-edit-query-changed-notice">
              saving a changed query requires confirming what it would now match
            </p>
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
            <p data-testid="rule-edit-no-preference-slot">
              this rule has no agent preference slot to edit — it uses butchr's global agent config
            </p>
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
            <p className="rules-view__cnc" data-testid="rule-edit-risky-permission-notice">
              "{draftPermissionMode}" skips the agent's own permission prompts — saving this needs an explicit confirm
            </p>
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
            <p className="rules-view__cnc" data-testid="rule-edit-lizard-notice">
              lizard mode is never a default — saving this needs an explicit confirm
            </p>
          )}

          <label htmlFor="rule-edit-capacity-toggle">Included in capacity</label>
          {/*
           * FACTORY-856 (story FACTORY-756, epic FACTORY-748) — mirrors
           * `FirstRuleSetup.tsx`'s own "Included in capacity" toggle
           * verbatim: `role` on the wire — "worker" (ON, this toggle's
           * checked state) counts this rule's agent(s) toward
           * `BUTCHR_MAX_AGENTS`; "sentinel" (OFF) opts them out entirely,
           * and requires an explicit confirm to save. `jira-project` rules
           * are sentinel BY CONSTRUCTION (`src/agents/capacity-role.ts`'s
           * own `capacityRoleFor`), so the toggle is shown-but-disabled
           * with an explanatory note rather than hidden outright.
           */}
          <span className="first-rule-capacity-toggle" title="agents from this rule consume fleet capacity (BUTCHR_MAX_AGENTS) while this is on">
            <Switch
              id="rule-edit-capacity-toggle"
              data-testid="rule-edit-capacity-toggle"
              isSelected={draftRole === "worker"}
              isDisabled={disabled || rule.resourceProvider === "jira-project"}
              switchLabels={false}
              aria-label="Included in capacity"
              onChange={(isSelected) => setDraftRole(isSelected ? "worker" : "sentinel")}
            />
          </span>
          {rule.resourceProvider === "jira-project" ? (
            <p className="rules-view__cnc" data-testid="rule-edit-capacity-manager-notice">
              project-manager rules never consume fleet capacity, regardless of this toggle — it has no effect here
            </p>
          ) : (
            <p data-testid="rule-edit-capacity-copy">
              {draftRole === "worker"
                ? `on: this rule's agents count toward the fleet's agent cap (today's default)`
                : `off: this rule's agents are never withheld or counted toward the fleet's agent cap`}
            </p>
          )}
          {draftRole === "sentinel" && (
            <p className="rules-view__cnc" data-testid="rule-edit-capacity-notice">
              turning capacity off is never a default — saving this needs an explicit confirm
            </p>
          )}
          {capacityRoles && (
            <p data-testid="rule-edit-capacity-default-hint">butchr's own default is "{capacityRoles.default}" (counted)</p>
          )}

          <label htmlFor="rule-edit-idle-poke-minutes-input">idle poke interval (minutes)</label>
          {/* FACTORY-846: empty, with a placeholder, means "inherits butchr's global stall threshold" — this rule's real effective value when `rule.idlePokeMinutes` is `null`, never the epic's own 30. */}
          <input
            id="rule-edit-idle-poke-minutes-input"
            type="number"
            aria-label="idle poke interval (minutes)"
            data-testid="rule-edit-idle-poke-minutes-input"
            placeholder="inherits butchr's global stall threshold"
            value={draftIdlePokeMinutes}
            onInput={(e) => setDraftIdlePokeMinutes((e.target as HTMLInputElement).value)}
            disabled={disabled}
          />

          <label htmlFor="rule-edit-idle-poke-message-input">idle poke message</label>
          <input
            id="rule-edit-idle-poke-message-input"
            type="text"
            aria-label="idle poke message"
            data-testid="rule-edit-idle-poke-message-input"
            placeholder="inherits today's existing wake text"
            value={draftIdlePokeMessage}
            onInput={(e) => setDraftIdlePokeMessage((e.target as HTMLInputElement).value)}
            disabled={disabled}
          />

          <label htmlFor="rule-edit-idle-poke-enabled-toggle">idle poke enabled</label>
          <span className="first-rule-idle-poke-toggle" title="whether this rule's tickets get a stall wake comment at all">
            <Switch
              id="rule-edit-idle-poke-enabled-toggle"
              data-testid="rule-edit-idle-poke-enabled-toggle"
              isSelected={draftIdlePokeEnabled}
              isDisabled={disabled}
              switchLabels={false}
              aria-label="idle poke enabled"
              onChange={(isSelected) => setDraftIdlePokeEnabled(isSelected)}
            />
          </span>

          {pendingAction && (
            <div className="rules-view__cnc" data-testid="rule-edit-confirm">
              <p>
                {/* FACTORY-730 (review round 2): a query-change confirm leads
                    with the dry-run scope count itself ("this query would now
                    match N tickets") — the actionable number AC3 asks for —
                    rather than the generic spawn/stop/restart summary, which
                    for a disabled rule's query edit would otherwise read "0
                    agents, 0 stop, 0 restart" and bury the one number that
                    matters. */}
                {pendingAction.plan.confirmReason === "query-change" ? (
                  <>
                    this query would now match {pendingAction.plan.scopeCount ?? 0} ticket{(pendingAction.plan.scopeCount ?? 0) === 1 ? "" : "s"} — confirm {pendingAction.label}?
                  </>
                ) : (
                  <>
                    this would start {pendingAction.plan.spawned} agent{pendingAction.plan.spawned === 1 ? "" : "s"}
                    {pendingAction.plan.scopeCount !== undefined ? `, scope ${pendingAction.plan.scopeCount} ticket${pendingAction.plan.scopeCount === 1 ? "" : "s"}` : ""}, stop{" "}
                    {pendingAction.plan.stopped}, and restart {pendingAction.plan.restarted} — confirm {pendingAction.label}?
                  </>
                )}
                {(pendingAction.plan.confirmReason === "swarm-enable" || pendingAction.plan.confirmReason === "scope-ceiling") && (
                  <span data-testid="rule-edit-confirm-tickets">
                    {" "}
                    This will staff up to {pendingAction.plan.scopeCount ?? pendingAction.plan.spawned} ticket{(pendingAction.plan.scopeCount ?? pendingAction.plan.spawned) === 1 ? "" : "s"}
                    {pendingAction.ticketKeys && pendingAction.ticketKeys.length > 0 ? `: ${pendingAction.ticketKeys.join(", ")}` : ""}
                    {pendingAction.ticketKeys && pendingAction.ticketKeys.length === 10 ? ", ..." : ""}
                  </span>
                )}
              </p>
              <div className="rules-view__dialog-actions">
                <Button variant="default" onPress={() => setPendingAction(null)}>
                  cancel
                </Button>
                <Button variant="primary" onPress={confirmPendingAction}>
                  confirm
                </Button>
              </div>
            </div>
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
