/**
 * local/ui — one rule on the Rules page, as a card: a header (collapse chevron, name, provider,
 * change status, live staffing, the on/off switch, a "⋮" menu and Edit / ✕)
 * over either a read-only summary or the inline editor.
 *
 * The coloured left border comes from `data-status` (see
 * `RulesTargeting.css`); problems outrank change markers.
 *
 * Every rule field is rendered as plain JSX text (React escapes it), same
 * as `RulesTable.tsx` — no `dangerouslySetInnerHTML` anywhere.
 */
import { useEffect, useRef } from "react";
import { Button, IconButton, Menu, MenuItem, MenuTrigger, Popover, Separator, Switch, Text } from "@launchpad-ui/components";
import { Icon } from "@launchpad-ui/icons";
import { PLACEHOLDER_QUERY, type BuiltinBrief, type RuleDto, type RuleFormCatalogEntry } from "../../api/rules.js";
import { briefText, deleteBlockedReason, executionText, idlePokeText, notifyDeliveryText, permissionText, preferenceText, type EditableField, type RuleCardStatus, type RuleDraft, type RuleRowState } from "../../view-model/rules-draft.js";
import { canPreview, providerInfo, supportsLinkedEvents } from "../../view-model/rule-providers.js";
import { ruleAnchorId } from "../../view-model/config-links.js";
import { RuleEditor, type QueryTestResult } from "./RuleEditor.js";
import { JqlCode } from "./JqlCode.js";
import { isJqlProvider } from "../../view-model/jql.js";

export type RuleCardMode = "viewing" | "editing" | "collapsed";

export interface RuleCardProps {
  row: RuleRowState;
  /** The rule as the latest poll reports it (staffing status), if it exists on the server. */
  live: RuleDto | undefined;
  /** The rule as it was when this draft started, for read-only fields and the delete gate. */
  baseRule: RuleDto | undefined;
  mode: RuleCardMode;
  catalog: readonly RuleFormCatalogEntry[] | null;
  /** True while nothing may be edited (write API unavailable, reload pending, saving). */
  disabled: boolean;
  onEdit: (changes: Partial<Pick<RuleDraft, EditableField>>) => void;
  onModeChange: (mode: RuleCardMode) => void;
  /** ✕ — the page asks first when the card has changes. */
  onDiscard: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onRestore: () => void;
  onPreview: () => void;
  onTestQuery: (() => Promise<QueryTestResult>) | undefined;
  /** Scroll into view and focus the first field (a just-added rule). */
  isJustAdded?: boolean;
  /** local/ui: the URL's #anchor names this rule (an agent row's "config" link): scroll to it and highlight it once. */
  isTarget?: boolean;
  builtinBriefs: readonly BuiltinBrief[] | null;
  briefError?: string | undefined;
  details?: Record<string, unknown> | undefined;
}

const STATUS_TAGS: Partial<Record<RuleCardStatus, { label: string; tone: string }>> = {
  added: { label: "New", tone: "success" },
  edited: { label: "Modified", tone: "info" },
  deleted: { label: "Will be deleted", tone: "error" },
  incomplete: { label: "Incomplete", tone: "warning" },
  invalid: { label: "Needs fixing", tone: "error" },
};

function StatusTag({ status, isNew }: { status: RuleCardStatus; isNew: boolean }) {
  // A new rule that's still incomplete reads better as "New" than as a warning before anything is typed.
  const tag = status === "incomplete" && isNew ? STATUS_TAGS.added : STATUS_TAGS[status];
  if (!tag) return null;
  return (
    <span className={`rt-tag rt-tag--${tag.tone}`} data-testid="rule-status-tag">
      {tag.label}
    </span>
  );
}

function LiveStatus({ live }: { live: RuleDto }) {
  if (live.staffed === true) {
    return (
      <span className="rt-live rt-live--on" title="At least one agent is working on this rule's tickets">
        <span className="rt-live__dot" aria-hidden="true" />
        Staffed
      </span>
    );
  }
  const label = live.staffed === false ? "Not staffed" : "Couldn't check";
  return (
    <span className={live.staffed === false ? "rt-live" : "rt-live rt-live--unknown"} title={live.reason ?? undefined}>
      <span className="rt-live__dot" aria-hidden="true" />
      {label}
    </span>
  );
}

/** Why a rule isn't staffed, minus what the Off switch already says. */
export function unstaffedReason(live: RuleDto | undefined): string | null {
  if (!live || live.staffed === true || !live.reason) return null;
  if (!live.enabled) {
    if (live.reason === "disabled") return null;
    if (live.reason.startsWith("disabled: ")) return live.reason.slice("disabled: ".length);
  }
  return live.reason;
}

function RuleSummary({ draft, baseRule, live }: { draft: RuleDraft; baseRule: RuleDto | undefined; live: RuleDto | undefined }) {
  const info = providerInfo(draft.resourceProvider);
  const statusReason = unstaffedReason(live);
  const runs: { text: string; tone?: "warning" }[] = [{ text: `permission: ${permissionText(draft.permissionMode)}`, ...(draft.permissionMode === "bypassPermissions" || draft.permissionMode === "auto" ? { tone: "warning" as const } : {}) }];
  if (draft.lizardMode) runs.push({ text: "lizard mode", tone: "warning" });
  runs.push({ text: draft.role === "worker" ? "counts toward the agent cap" : "not counted in the agent cap" });
  runs.push({ text: draft.resumeOnRespawn ? "resume on respawn" : "no resume on respawn" });
  runs.push({ text: `idle poke: ${idlePokeText(draft)}` });
  if (draft.notifyDeliveryMode) runs.push({ text: `updates: ${notifyDeliveryText(draft.notifyDeliveryMode)}` });
  if (draft.stalledMinutes) runs.push({ text: `stalled after ${draft.stalledMinutes} min` });
  if (draft.linkedEventing && supportsLinkedEvents(draft.resourceProvider)) runs.push({ text: "linked-change events" });
  // The list only carries an excerpt; that's enough to name a built-in or show custom text's first line.
  const brief = draft.brief ?? baseRule?.briefExcerpt ?? null;
  return (
    <dl className="rt-summary" data-testid="rule-summary">
      <div className="rt-summary__row">
        <dt>Match</dt>
        <dd>
          <span className="rt-lang">{info.queryLanguage}</span>
          {draft.query && isJqlProvider(draft.resourceProvider) ? <JqlCode query={draft.query} /> : <code className="rt-query">{draft.query || "(no query yet)"}</code>}
        </dd>
      </div>
      <div className="rt-summary__row">
        <dt>Staffing</dt>
        <dd>{executionText(draft.execution)}</dd>
      </div>
      <div className="rt-summary__row">
        <dt>Agent</dt>
        <dd>{preferenceText(draft.preference)}</dd>
      </div>
      {brief !== null && (
        <div className="rt-summary__row">
          <dt>Brief</dt>
          <dd>{briefText(brief)}</dd>
        </div>
      )}
      <div className="rt-summary__row">
        <dt>Runs with</dt>
        <dd className="rt-chips">
          {runs.map((r) => (
            <span key={r.text} className={r.tone ? `rt-chip rt-chip--${r.tone}` : "rt-chip"}>
              {r.text}
            </span>
          ))}
        </dd>
      </div>
      {statusReason && (
        <div className="rt-summary__row">
          <dt>Status</dt>
          <dd className="rt-muted">{statusReason}</dd>
        </div>
      )}
      {draft.query.trim() === PLACEHOLDER_QUERY && (
        <div className="rt-summary__row">
          <dt />
          <dd className="rt-muted">This is butchr's starter rule. Edit it and replace the placeholder query to use it.</dd>
        </div>
      )}
    </dl>
  );
}

export function RuleCard(props: RuleCardProps) {
  const { row, live, baseRule, mode, catalog, disabled, onEdit, onModeChange, onDiscard, onDuplicate, onDelete, onRestore, onPreview, onTestQuery, isJustAdded, isTarget, builtinBriefs, briefError, details } = props;
  const { draft, status } = row;
  const info = providerInfo(draft.resourceProvider);
  const ref = useRef<HTMLElement>(null);
  const name = draft.id || "new rule";
  const editing = mode === "editing" && !draft.deleted;
  const collapsed = mode === "collapsed" || draft.deleted;
  const deleteBlocked = draft.isNew ? null : deleteBlockedReason(baseRule);
  const previewable = !draft.isNew && canPreview(draft.resourceProvider);

  useEffect(() => {
    if (isJustAdded) ref.current?.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
  }, [isJustAdded]);

  useEffect(() => {
    if (isTarget) ref.current?.scrollIntoView?.({ block: "center" });
  }, [isTarget]);

  const menuDisabledKeys = [...(previewable ? [] : ["preview"]), ...(disabled ? ["duplicate", "delete"] : deleteBlocked ? ["delete"] : [])];

  return (
    <article
      ref={ref}
      {...(draft.isNew ? {} : { id: ruleAnchorId(draft.resourceProvider, draft.id) })}
      className={isTarget ? "rt-card rt-card--target" : "rt-card"}
      data-status={status}
      data-testid="rule-card"
      data-rule-key={draft.key}
      aria-label={`rule ${name}`}
    >
      <header className="rt-card__header">
        {!editing && (
          <IconButton
            icon={collapsed ? "chevron-right" : "chevron-down"}
            size="small"
            variant="minimal"
            aria-label={collapsed ? `Expand ${name}` : `Collapse ${name}`}
            isDisabled={draft.deleted}
            onPress={() => onModeChange(collapsed ? "viewing" : "collapsed")}
          />
        )}
        <h3 className={draft.id ? "rt-card__title" : "rt-card__title rt-card__title--placeholder"}>{draft.id || "New rule"}</h3>
        <span className="rt-card__provider">
          <Icon name={info.icon} size="small" />
          {info.label}
        </span>
        <StatusTag status={status} isNew={draft.isNew} />
        <span className="rt-card__spacer" />
        {live && !draft.isNew && <LiveStatus live={live} />}
        <span className="rt-card__switch" title={draft.isNew ? "New rules are saved off. Turn this on after saving." : undefined}>
          <Switch
            isSelected={draft.enabled}
            isDisabled={disabled || draft.isNew || draft.deleted}
            onChange={(enabled) => onEdit({ enabled })}
            aria-label={`${draft.enabled ? "Turn off" : "Turn on"} ${name}`}
            data-testid="rule-enabled-switch"
          />
        </span>
        <MenuTrigger>
          <IconButton icon="more-vert" size="small" variant="minimal" aria-label={`More actions for ${name}`} />
          <Popover placement="bottom end">
            <Menu
              disabledKeys={menuDisabledKeys}
              onAction={(key) => {
                if (key === "preview") onPreview();
                else if (key === "duplicate") onDuplicate();
                else if (key === "delete") onDelete();
              }}
            >
              <MenuItem id="preview" textValue="Preview matching tickets">
                <Text slot="label">
                  <Icon name="visibility" size="small" /> Preview matching tickets
                </Text>
                {!previewable && <Text slot="description">{draft.isNew ? "Save the rule first, or use Test query" : "Only Jira-backed rules can be previewed"}</Text>}
              </MenuItem>
              <MenuItem id="duplicate" textValue="Duplicate rule">
                <Text slot="label">
                  <Icon name="copy-content" size="small" /> Duplicate rule
                </Text>
              </MenuItem>
              <Separator />
              <MenuItem id="delete" textValue={draft.isNew ? "Remove rule" : "Delete rule"} variant="destructive">
                <Text slot="label">
                  <Icon name="delete" size="small" /> {draft.isNew ? "Remove rule" : "Delete rule"}
                </Text>
                {deleteBlocked && <Text slot="description">{deleteBlocked}</Text>}
              </MenuItem>
            </Menu>
          </Popover>
        </MenuTrigger>
        {draft.deleted ? (
          <Button size="small" onPress={onRestore} isDisabled={disabled} data-testid="rule-undo-delete">
            <Icon name="arrow-undo" size="small" />
            Undo delete
          </Button>
        ) : editing ? (
          <>
            {!draft.isNew && (
              <Button size="small" variant="minimal" onPress={() => onModeChange("viewing")} data-testid="rule-done">
                Done
              </Button>
            )}
            <IconButton icon="cancel" size="small" variant="minimal" aria-label={draft.isNew ? `Remove ${name}` : `Discard changes to ${name}`} onPress={onDiscard} data-testid="rule-discard" />
          </>
        ) : (
          <Button size="small" onPress={() => onModeChange("editing")} isDisabled={disabled} data-testid="rule-edit">
            <Icon name="edit" size="small" />
            Edit
          </Button>
        )}
      </header>
      {draft.deleted && (
        <div className="rt-card__body rt-card__body--note">
          <Text size="small" className="rt-muted">
            This rule will be deleted when you save.
          </Text>
        </div>
      )}
      {!collapsed && (
        <div className="rt-card__body">
          {editing ? (
            <RuleEditor
              row={row}
              baseRule={baseRule}
              catalog={catalog}
              disabled={disabled}
              onChange={onEdit}
              onTestQuery={onTestQuery}
              autoFocus={isJustAdded ?? false}
              builtinBriefs={builtinBriefs}
              briefError={briefError}
              details={details}
            />
          ) : (
            <RuleSummary draft={draft} baseRule={baseRule} live={live} />
          )}
        </div>
      )}
    </article>
  );
}
