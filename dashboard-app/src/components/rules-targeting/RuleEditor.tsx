/**
 * local/ui — a rule card's inline editor (the card's "editing" mode on the
 * Rules page). Every change goes straight into the page
 * draft through `onChange`; nothing is written until Review and save.
 *
 * Options come from `GET /api/rules/catalog` (`catalog`), falling back to
 * the same leaf-module constants `RuleEditDialog` falls back to, never a
 * second hand-maintained list.
 */
import { lazy, Suspense, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  Alert,
  AlertText,
  Button,
  Checkbox,
  ComboBox,
  FieldError,
  Group,
  IconButton,
  Input,
  Label,
  ListBox,
  ListBoxItem,
  Popover,
  Select,
  SelectValue,
  Switch,
  Text,
  TextArea,
  TextField,
} from "@launchpad-ui/components";
import { Icon } from "@launchpad-ui/icons";
import { AGENT_EFFORTS, type AgentEffort } from "../../../../src/resources/power-scale.js";
// Leaf module on purpose — see `FirstRuleSetup.tsx`'s top comment.
import { AGENT_HARNESSES, RULE_PERMISSION_MODES, type AgentHarness, type RulePermissionMode } from "../../../../src/rules/agent-harness.js";
import type { ResourceProvider } from "../../../../src/rules/agent-key.js";
import type { ExecutionMode } from "../../../../src/rules/rules.js";
import { PLACEHOLDER_QUERY, type BuiltinBrief, type NotifyDeliveryMode, type RuleDto, type RuleFormCatalogEntry } from "../../api/rules.js";
import { BUILTIN_BRIEF_PREFIX, builtinBriefName, DEFAULT_LINKED_ITEMS, DEFAULT_LINKED_TURNS_PER_HOUR, permissionDescription, type EditableField, type RuleDraft, type RuleIssue, type RuleRowState } from "../../view-model/rules-draft.js";
import { ADDABLE_PROVIDERS, providerInfo, supportsLinkedEvents } from "../../view-model/rule-providers.js";
import { formatJql, isJqlProvider } from "../../view-model/jql.js";

/** CodeMirror is only needed once a rule is open for editing, so it's split into its own chunk. */
const LazyQueryEditor = lazy(() => import("./QueryEditor.js"));

/** Select keys can't be empty strings; this stands in for "butchr's default". */
const DEFAULT_KEY = "__default__";
const CUSTOM_BRIEF_KEY = "__custom__";

/** Restated from `src/rules/rules.ts`'s `EXECUTION_MODES` (a value import from that module would pull `node:` builtins into the browser bundle). */
const EXECUTION_OPTIONS: readonly { id: ExecutionMode; label: string; description: string }[] = [
  { id: "swarm", label: "Swarm", description: "One agent per matching ticket" },
  { id: "singleton", label: "Singleton", description: "One agent for the whole query; stops when nothing matches" },
  { id: "persistent", label: "Persistent", description: "One agent that keeps running even when nothing matches" },
];

/** `Rule.notifyDeliveryMode` (FACTORY-1010). The two explicit modes never fall back to the other transport. */
const NOTIFY_DELIVERY_OPTIONS: readonly { id: string; label: string; description: string }[] = [
  { id: DEFAULT_KEY, label: "butchr's default", description: "MCP channel, falling back to a direct prompt" },
  { id: "channel", label: "Channel only", description: "Never falls back to a prompt" },
  { id: "prompt", label: "Direct prompt only", description: "Typed into the agent's session; never uses the channel" },
];

export type QueryTestResult =
  | { kind: "keys"; total: number; keys: string[] }
  | { kind: "count"; total: number | null; unmeasurable: boolean }
  | { kind: "error"; message: string };

export interface RuleEditorProps {
  row: RuleRowState;
  /** The saved rule as last loaded, for the fields the page can't change. `undefined` for a new rule. */
  baseRule: RuleDto | undefined;
  catalog: readonly RuleFormCatalogEntry[] | null;
  disabled: boolean;
  onChange: (changes: Partial<Pick<RuleDraft, EditableField>>) => void;
  /** `undefined` when this rule's query can't be tested from here (a saved rule on a provider the preview route doesn't support). */
  onTestQuery: (() => Promise<QueryTestResult>) | undefined;
  /** Focus the first field when the card opens (a just-added rule). */
  autoFocus?: boolean;
  /** The shipped `@builtin:` briefs; `null` while loading or when this butchr doesn't list them. */
  builtinBriefs: readonly BuiltinBrief[] | null;
  /** Why this rule's full definition (brief and file-only fields) couldn't be loaded, if it couldn't. */
  briefError?: string | undefined;
  /** The saved rule's full definition minus the brief, as `GET /api/rules/:id/details` returns it; `undefined` until loaded or for a new rule. */
  details?: Record<string, unknown> | undefined;
}

/**
 * `onInput` beside each field's `onChange`: same value, same keystroke in a
 * browser (a duplicate dispatch of an identical edit is a no-op), but it's
 * the event this repo's happy-dom component tests actually deliver — see
 * `FirstRuleSetup.tsx`'s note on `onInput`.
 */
function typed(fn: (value: string) => void) {
  return { onInput: (e: FormEvent<HTMLInputElement | HTMLTextAreaElement>) => fn((e.target as HTMLInputElement).value) };
}

function issueFor(issues: readonly RuleIssue[], field: EditableField): RuleIssue | undefined {
  return issues.find((i) => i.field === field);
}

function IssueText({ issue, standalone }: { issue: RuleIssue | undefined; standalone?: boolean }) {
  if (!issue) return null;
  if (standalone) {
    return (
      <Text elementType="p" size="small" className={issue.level === "invalid" ? "rt-field-error" : "rt-field-hint"}>
        {issue.message}
      </Text>
    );
  }
  if (issue.level === "invalid") return <FieldError className="rt-field-error">{issue.message}</FieldError>;
  return (
    <Text slot="description" className="rt-field-hint">
      {issue.message}
    </Text>
  );
}

function testResultText(result: QueryTestResult): string {
  if (result.kind === "error") return result.message;
  if (result.kind === "count") {
    if (result.unmeasurable || result.total === null) return "butchr couldn't measure what this query matches right now.";
    return `Matches ${result.total} ticket${result.total === 1 ? "" : "s"} right now.`;
  }
  if (result.total === 0) return "Matches no tickets right now.";
  const shown = result.keys.join(", ");
  return `Matches ${result.total} ticket${result.total === 1 ? "" : "s"}: ${shown}${result.total > result.keys.length ? ", …" : ""}`;
}

interface SelectFieldProps<K extends string> {
  label: string;
  value: K;
  options: readonly { id: K; label: string; description?: string }[];
  onChange: (value: K) => void;
  isDisabled: boolean;
  testId: string;
  description?: string;
}

function SelectField<K extends string>({ label, value, options, onChange, isDisabled, testId, description }: SelectFieldProps<K>) {
  return (
    <Select className="rt-field" selectedKey={value} onSelectionChange={(key) => key !== null && onChange(String(key) as K)} isDisabled={isDisabled} data-testid={testId}>
      <Label>{label}</Label>
      <Button>
        <SelectValue />
        <Icon name="chevron-down" size="small" />
      </Button>
      {description && <Text slot="description">{description}</Text>}
      <Popover>
        <ListBox>
          {options.map((o) => (
            <ListBoxItem key={o.id} id={o.id} textValue={o.label}>
              {o.description ? (
                <>
                  <Text slot="label">{o.label}</Text>
                  <Text slot="description">{o.description}</Text>
                </>
              ) : (
                o.label
              )}
            </ListBoxItem>
          ))}
        </ListBox>
      </Popover>
    </Select>
  );
}

export function RuleEditor({ row, baseRule, catalog, disabled, onChange, onTestQuery, autoFocus, builtinBriefs, briefError, details }: RuleEditorProps) {
  const { draft, base, issues } = row;
  const info = providerInfo(draft.resourceProvider);
  const idRef = useRef<HTMLInputElement>(null);
  const [testing, setTesting] = useState(false);
  const [formatNote, setFormatNote] = useState<string | null>(null);
  const queryLabelId = useId();
  const isJql = isJqlProvider(draft.resourceProvider);
  const [testResult, setTestResult] = useState<QueryTestResult | null>(null);
  const testedQuery = useRef<string | null>(null);
  const headingId = useId();

  useEffect(() => {
    if (!autoFocus) return;
    if (draft.isNew) idRef.current?.focus();
    // Only on mount: focusing again on every edit would steal the caret.
  }, []);

  useEffect(() => {
    // A result describes the query it ran against; drop it once the query changes.
    if (testedQuery.current !== null && testedQuery.current !== draft.query) setTestResult(null);
    setFormatNote(null);
  }, [draft.query]);

  function formatQuery() {
    const result = formatJql(draft.query);
    if (!result.ok) {
      setFormatNote(result.reason);
      return;
    }
    if (result.changed) onChange({ query: result.text });
    else setFormatNote("Already formatted.");
  }

  const harnesses: readonly AgentHarness[] = catalog?.map((c) => c.harness) ?? AGENT_HARNESSES;
  const pref = draft.preference;
  const entry = pref ? catalog?.find((c) => c.harness === pref.harness) : undefined;
  const models = entry?.models ?? [];
  const efforts: readonly AgentEffort[] = entry ? entry.efforts : AGENT_EFFORTS;
  const permissionModes: readonly RulePermissionMode[] = entry?.permissionModes ?? catalog?.[0]?.permissionModes ?? RULE_PERMISSION_MODES;
  // The server can't clear a permission mode back to butchr's default, so only offer "default" when there's nothing to clear.
  const offerDefaultPermission = !base || base.permissionMode === "";
  const isSentinelByProvider = draft.resourceProvider === "jira-project";

  async function runTest() {
    if (!onTestQuery) return;
    setTesting(true);
    testedQuery.current = draft.query;
    try {
      setTestResult(await onTestQuery());
    } catch (e) {
      setTestResult({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="rt-editor" data-testid="rule-editor" aria-labelledby={headingId}>
      <span id={headingId} hidden>
        {draft.isNew ? "new rule" : `rule ${draft.id}`} settings
      </span>

      <section className="rt-editor__section">
        <h4 className="rt-editor__heading">Match</h4>
        <div className="rt-editor__grid">
          {draft.isNew && (
            <>
              <TextField
                className="rt-field"
                value={draft.id}
                onChange={(id) => onChange({ id })}
                isDisabled={disabled}
                isInvalid={issueFor(issues, "id")?.level === "invalid"}
              >
                <Label>Rule id</Label>
                <Input ref={idRef} placeholder="e.g. my-team-bugs" spellCheck={false} autoComplete="off" data-testid="rule-id-input" {...typed((id) => onChange({ id }))} />
                <IssueText issue={issueFor(issues, "id")} />
                {!issueFor(issues, "id") && <Text slot="description">Lowercase letters, numbers and hyphens. Can't be changed later.</Text>}
              </TextField>
              <SelectField<ResourceProvider>
                label="Resource"
                value={draft.resourceProvider}
                options={ADDABLE_PROVIDERS.map((p) => ({ id: p, label: providerInfo(p).label, description: providerInfo(p).description }))}
                onChange={(resourceProvider) => onChange({ resourceProvider, role: resourceProvider === "jira-project" ? "sentinel" : draft.role === "sentinel" && draft.resourceProvider === "jira-project" ? "worker" : draft.role })}
                isDisabled={disabled}
                testId="rule-provider-select"
              />
            </>
          )}
          <div className="rt-field rt-field--wide">
            <Label id={queryLabelId}>{info.queryLanguage === "Query" ? "Query" : `${info.queryLanguage} query`}</Label>
            <Suspense fallback={<div className="rt-query-editor rt-query-editor--loading" aria-hidden="true" />}>
              <LazyQueryEditor
                value={draft.query}
                onChange={(query) => onChange({ query })}
                language={isJql ? "jql" : "plain"}
                disabled={disabled}
                placeholder={info.queryPlaceholder}
                labelledBy={queryLabelId}
                invalid={issueFor(issues, "query")?.level === "invalid"}
                testId="rule-query-input"
              />
            </Suspense>
            <IssueText issue={issueFor(issues, "query")} standalone />
          </div>
        </div>
        {draft.query.trim() === PLACEHOLDER_QUERY && (
          <Alert status="info" variant="inline" className="rt-inline-alert">
            <AlertText>This is butchr's starter rule. Replace the placeholder query to use it.</AlertText>
          </Alert>
        )}
        {(onTestQuery || isJql) && (
          <div className="rt-editor__row">
            {isJql && (
              <div className="rt-query-format">
                <Button size="small" variant="minimal" isDisabled={disabled || draft.query.trim() === ""} onPress={formatQuery} data-testid="rule-format-query">
                  <Icon name="magic-wand" size="small" />
                  Format
                </Button>
                {formatNote && (
                  <Text size="small" className="rt-muted" data-testid="rule-format-note">
                    {formatNote}
                  </Text>
                )}
              </div>
            )}
            {onTestQuery && (
              <div className="rt-query-test">
                <Button size="small" isPending={testing} isDisabled={draft.query.trim() === "" || draft.query.trim() === PLACEHOLDER_QUERY} onPress={() => void runTest()} data-testid="rule-test-query">
                  <Icon name="preview" size="small" />
                  Test query
                </Button>
                {testResult && (
                  <Text size="small" className={testResult.kind === "error" ? "rt-query-test__result rt-query-test__result--error" : "rt-query-test__result"} data-testid="rule-test-result">
                    {testResultText(testResult)}
                  </Text>
                )}
              </div>
            )}
          </div>
        )}
      </section>

      <section className="rt-editor__section">
        <h4 className="rt-editor__heading">Staffing</h4>
        <div className="rt-editor__grid">
          <SelectField<ExecutionMode>
            label="Execution"
            value={draft.execution}
            options={EXECUTION_OPTIONS}
            onChange={(execution) => onChange({ execution })}
            isDisabled={disabled}
            testId="rule-execution-select"
            description={EXECUTION_OPTIONS.find((o) => o.id === draft.execution)?.description ?? ""}
          />
          <div className="rt-field rt-field--switch">
            <Switch isSelected={draft.role === "worker"} isDisabled={disabled || isSentinelByProvider} onChange={(on) => onChange({ role: on ? "worker" : "sentinel" })}>
              Counts toward agent cap
            </Switch>
            <Text size="small" className="rt-muted">
              {isSentinelByProvider ? "Project-manager rules never count toward the cap." : "Off means this rule's agents are never held back by, or counted in, BUTCHR_MAX_AGENTS."}
            </Text>
          </div>
        </div>
        {draft.execution !== (baseRule?.execution ?? "swarm") && (baseRule?.enabled ?? false) && (
          <Alert status="warning" variant="inline" className="rt-inline-alert">
            <AlertText>Changing execution restarts this rule's agents. You'll confirm what it does when you save.</AlertText>
          </Alert>
        )}
      </section>

      <section className="rt-editor__section">
        <h4 className="rt-editor__heading">Agent</h4>
        {draft.isNew && (
          <Checkbox
            isSelected={pref !== null}
            isDisabled={disabled}
            onChange={(on) => onChange({ preference: on ? { harness: harnesses[0] ?? "claude", model: "", effort: "" } : null })}
          >
            Choose a specific agent for this rule
          </Checkbox>
        )}
        {pref ? (
          <div className="rt-editor__grid rt-editor__grid--one-row">
            <SelectField<AgentHarness>
              label="Harness"
              value={pref.harness}
              options={harnesses.map((h) => ({ id: h, label: h }))}
              onChange={(harness) => onChange({ preference: { harness, model: "", effort: "" } })}
              isDisabled={disabled}
              testId="rule-harness-select"
            />
            <ComboBox
              className="rt-field"
              allowsCustomValue
              inputValue={pref.model}
              onInputChange={(model) => onChange({ preference: { ...pref, model } })}
              onSelectionChange={(key) => key !== null && onChange({ preference: { ...pref, model: String(key) } })}
              defaultItems={models.map((m) => ({ id: m, name: m }))}
              menuTrigger="focus"
              isDisabled={disabled}
            >
              <Label>Model</Label>
              <Group>
                <Input placeholder="butchr's default" spellCheck={false} data-testid="rule-model-input" {...typed((model) => onChange({ preference: { ...pref, model } }))} />
                <IconButton icon="chevron-down" size="small" variant="minimal" aria-label="Show models" />
              </Group>
              <Popover>
                <ListBox<{ id: string; name: string }>>{(item) => <ListBoxItem id={item.id}>{item.name}</ListBoxItem>}</ListBox>
              </Popover>
            </ComboBox>
            {efforts.length > 0 && (
              <SelectField<string>
                label="Effort"
                value={pref.effort || DEFAULT_KEY}
                options={[{ id: DEFAULT_KEY, label: "butchr's default" }, ...efforts.map((e) => ({ id: e, label: e }))]}
                onChange={(v) => onChange({ preference: { ...pref, effort: v === DEFAULT_KEY ? "" : (v as AgentEffort) } })}
                isDisabled={disabled}
                testId="rule-effort-select"
              />
            )}
          </div>
        ) : (
          !draft.isNew && (
            <Text elementType="p" size="small" className="rt-muted">
              Uses butchr's global agent config. Adding an agent preference to an existing rule isn't supported here yet.
            </Text>
          )
        )}
      </section>

      <section className="rt-editor__section">
        <h4 className="rt-editor__heading">Permissions</h4>
        <div className="rt-editor__grid">
          <SelectField<string>
            label="Permission mode"
            value={draft.permissionMode || DEFAULT_KEY}
            options={[
              ...(offerDefaultPermission ? [{ id: DEFAULT_KEY, label: "butchr's default", description: permissionDescription("") }] : []),
              ...permissionModes.map((m) => ({ id: m, label: m, description: permissionDescription(m) })),
            ]}
            onChange={(v) => onChange({ permissionMode: v === DEFAULT_KEY ? "" : (v as RulePermissionMode) })}
            isDisabled={disabled}
            testId="rule-permission-select"
            description={permissionDescription(draft.permissionMode)}
          />
          <div className="rt-field rt-field--switch">
            <Switch isSelected={draft.lizardMode} isDisabled={disabled} onChange={(lizardMode) => onChange({ lizardMode })}>
              Lizard mode
            </Switch>
            <Text size="small" className="rt-muted">
              Auto-answers unambiguous tool-permission prompts so an agent never sits frozen waiting on one.
            </Text>
          </div>
        </div>
        <IssueText issue={issueFor(issues, "permissionMode")} standalone />
        {(draft.permissionMode === "bypassPermissions" || draft.permissionMode === "auto") && (
          <Alert status="warning" variant="inline" className="rt-inline-alert">
            <AlertText>
              {draft.permissionMode === "auto" ? "In auto mode a model classifier answers permission prompts instead of a person." : "Unattended mode skips every permission check."} You'll confirm this when you save.
            </AlertText>
          </Alert>
        )}
      </section>

      <section className="rt-editor__section">
        <h4 className="rt-editor__heading">Sessions</h4>
        <div className="rt-editor__grid">
          <div className="rt-field rt-field--switch">
            <Switch isSelected={draft.resumeOnRespawn} isDisabled={disabled} onChange={(resumeOnRespawn) => onChange({ resumeOnRespawn })}>
              Resume on respawn
            </Switch>
            <Text size="small" className="rt-muted">
              A respawned agent picks up its previous session instead of starting over.
            </Text>
          </div>
          <TextField
            className="rt-field"
            value={draft.resumeContextCutoff}
            onChange={(v) => onChange({ resumeContextCutoff: v.trim() })}
            isDisabled={disabled || !draft.resumeOnRespawn}
            isInvalid={issueFor(issues, "resumeContextCutoff")?.level === "invalid"}
          >
            <Label>Resume context cutoff</Label>
            <Input inputMode="numeric" placeholder="butchr's default" data-testid="rule-resume-cutoff-input" {...typed((v) => onChange({ resumeContextCutoff: v.trim() }))} />
            <IssueText issue={issueFor(issues, "resumeContextCutoff")} />
          </TextField>
        </div>
      </section>

      <section className="rt-editor__section">
        <h4 className="rt-editor__heading">Updates and stalls</h4>
        <div className="rt-editor__grid">
          <SelectField<string>
            label="Notification delivery"
            value={draft.notifyDeliveryMode || DEFAULT_KEY}
            options={NOTIFY_DELIVERY_OPTIONS}
            onChange={(v) => onChange({ notifyDeliveryMode: v === DEFAULT_KEY ? "" : (v as NotifyDeliveryMode) })}
            isDisabled={disabled}
            testId="rule-notify-delivery-select"
            description="How butchr sends ticket updates to this rule's agents. Idle pokes aren't affected."
          />
          <TextField
            className="rt-field"
            value={draft.stalledMinutes}
            onChange={(v) => onChange({ stalledMinutes: v.trim() })}
            isDisabled={disabled}
            isInvalid={issueFor(issues, "stalledMinutes")?.level === "invalid"}
          >
            <Label>Stall threshold (minutes)</Label>
            <Input inputMode="decimal" placeholder="butchr's default" data-testid="rule-stalled-minutes-input" {...typed((v) => onChange({ stalledMinutes: v.trim() }))} />
            {!issueFor(issues, "stalledMinutes") && <Text slot="description">How long an agent can go quiet before butchr marks it stalled.</Text>}
            <IssueText issue={issueFor(issues, "stalledMinutes")} />
          </TextField>
        </div>
      </section>

      {supportsLinkedEvents(draft.resourceProvider) && <LinkedEventsSection draft={draft} issues={issues} disabled={disabled} onChange={onChange} />}

      <section className="rt-editor__section">
        <h4 className="rt-editor__heading">Idle poke</h4>
        {draft.isNew ? (
          <Text elementType="p" size="small" className="rt-muted">
            New rules are saved with idle pokes off. Turn them on after saving.
          </Text>
        ) : (
          <div className="rt-editor__grid">
            <div className="rt-field rt-field--switch">
              <Switch isSelected={draft.idlePokeEnabled} isDisabled={disabled} onChange={(idlePokeEnabled) => onChange({ idlePokeEnabled })}>
                Poke idle agents
              </Switch>
              <Text size="small" className="rt-muted">
                Leaves a wake comment when an agent on this rule's ticket goes quiet.
              </Text>
            </div>
            <TextField
              className="rt-field"
              value={draft.idlePokeMinutes}
              onChange={(idlePokeMinutes) => onChange({ idlePokeMinutes: idlePokeMinutes.trim() })}
              isDisabled={disabled || !draft.idlePokeEnabled}
              isInvalid={issueFor(issues, "idlePokeMinutes")?.level === "invalid"}
            >
              <Label>Poke after (minutes)</Label>
              <Input inputMode="numeric" placeholder="global stall threshold" data-testid="rule-idle-minutes-input" {...typed((v) => onChange({ idlePokeMinutes: v.trim() }))} />
              <IssueText issue={issueFor(issues, "idlePokeMinutes")} />
            </TextField>
            <TextField
              className="rt-field rt-field--wide"
              value={draft.idlePokeMessage}
              onChange={(idlePokeMessage) => onChange({ idlePokeMessage })}
              isDisabled={disabled || !draft.idlePokeEnabled}
              isInvalid={issueFor(issues, "idlePokeMessage")?.level === "invalid"}
            >
              <Label>Poke message</Label>
              <Input placeholder="butchr's default wake text" data-testid="rule-idle-message-input" {...typed((idlePokeMessage) => onChange({ idlePokeMessage }))} />
              <IssueText issue={issueFor(issues, "idlePokeMessage")} />
            </TextField>
          </div>
        )}
      </section>

      <BriefSection draft={draft} issues={issues} disabled={disabled} onChange={onChange} builtinBriefs={builtinBriefs} briefError={briefError} />

      <ReadOnlyFields isNew={draft.isNew} details={details} error={briefError} provider={draft.resourceProvider} />
    </div>
  );
}

type CountFieldKey = "maxLinkedTurnsPerHour" | "maxLinkedItems" | "linkedPollIntervalMs";

function CountField({ draft, field, issues, label, placeholder, description, testId, isDisabled, onChange }: {
  draft: RuleDraft;
  field: CountFieldKey;
  issues: readonly RuleIssue[];
  label: string;
  placeholder: string;
  description: string;
  testId: string;
  isDisabled: boolean;
  onChange: RuleEditorProps["onChange"];
}) {
  const issue = issueFor(issues, field);
  const set = (v: string) => onChange({ [field]: v.trim() } as Partial<Pick<RuleDraft, CountFieldKey>>);
  return (
    <TextField className="rt-field" value={draft[field]} onChange={set} isDisabled={isDisabled} isInvalid={issue?.level === "invalid"}>
      <Label>{label}</Label>
      <Input inputMode="numeric" placeholder={placeholder} data-testid={testId} {...typed(set)} />
      {!issue && <Text slot="description">{description}</Text>}
      <IssueText issue={issue} />
    </TextField>
  );
}

/** `Rule.linkedEventing` and its knobs, for the providers that run it (`supportsLinkedEvents`). The knobs only matter while the switch is on. */
function LinkedEventsSection({ draft, issues, disabled, onChange }: { draft: RuleDraft; issues: readonly RuleIssue[]; disabled: boolean; onChange: RuleEditorProps["onChange"] }) {
  const noun = draft.resourceProvider === "jira-project" ? "project" : "ticket";
  const knobsDisabled = disabled || !draft.linkedEventing;
  return (
    <section className="rt-editor__section">
      <h4 className="rt-editor__heading">Linked-change events</h4>
      <div className="rt-editor__grid">
        <div className="rt-field rt-field--switch">
          <Switch isSelected={draft.linkedEventing} isDisabled={disabled} onChange={(linkedEventing) => onChange({ linkedEventing })}>
            Wake agents when linked items change
          </Switch>
          <Text size="small" className="rt-muted">
            Watches each {noun}'s linked Jira issues and parent, and wakes its agent when one changes.
            {draft.resourceProvider === "jira-work" && " Also its pull request (branch KEY or KEY-…): new comments and reviews. Needs GitHub set up in Settings."}
          </Text>
        </div>
        <CountField
          draft={draft}
          field="maxLinkedTurnsPerHour"
          issues={issues}
          label="Wakes per hour, at most"
          placeholder={`butchr's default (${DEFAULT_LINKED_TURNS_PER_HOUR})`}
          description="Caps how often linked changes can wake one agent."
          testId="rule-linked-turns-input"
          isDisabled={knobsDisabled}
          onChange={onChange}
        />
        <CountField
          draft={draft}
          field="maxLinkedItems"
          issues={issues}
          label="Linked items to watch, at most"
          placeholder={`butchr's default (${DEFAULT_LINKED_ITEMS})`}
          description={`Per ${noun}. Links past the cap are logged and skipped.`}
          testId="rule-linked-items-input"
          isDisabled={knobsDisabled}
          onChange={onChange}
        />
        <div className="rt-field rt-field--switch">
          <Switch isSelected={draft.linkedRemoteLinks} isDisabled={knobsDisabled} onChange={(linkedRemoteLinks) => onChange({ linkedRemoteLinks })}>
            Follow Jira remote links
          </Switch>
          <Text size="small" className="rt-muted">
            Also watches remote links. Costs one extra Jira call per {noun} each poll.
          </Text>
        </div>
        <div className="rt-field rt-field--switch">
          <Switch isSelected={draft.linkedDescriptionLinks} isDisabled={knobsDisabled} onChange={(linkedDescriptionLinks) => onChange({ linkedDescriptionLinks })}>
            Follow links in the description
          </Switch>
          <Text size="small" className="rt-muted">
            Also polls Confluence pages, GitHub issues and PRs, and webpages named in the description.
          </Text>
        </div>
        <CountField
          draft={draft}
          field="linkedPollIntervalMs"
          issues={issues}
          label="Re-check non-Jira links every (ms)"
          placeholder="every poll"
          description="For Confluence, GitHub and webpage links. Jira links are checked every poll."
          testId="rule-linked-interval-input"
          isDisabled={knobsDisabled}
          onChange={onChange}
        />
      </div>
    </section>
  );
}

/** Rule fields the editor above changes; everything else in a rule is listed read-only below them. */
const EDITED_HERE = new Set([
  "id",
  "enabled",
  "resourceProvider",
  "query",
  "brief",
  "execution",
  "role",
  "agentPreferences",
  "permissionMode",
  "lizardMode",
  "resumeOnRespawn",
  "resumeContextCutoff",
  "idlePokeMinutes",
  "idlePokeMessage",
  "idlePokeEnabled",
  "notifyDeliveryMode",
  "stalledMinutes",
]);

/** Keys butchr still accepts in rules.json but ignores, so they aren't shown: `account` was the Rocket.Chat account policy, and Rocket.Chat support is gone. */
const IGNORED_LEGACY = new Set(["account"]);

/** The rule fields that can only be changed in rules.json for now, listed even when unset so it's clear they exist. */
export const NOT_EDITABLE_YET: readonly { key: string; label: string }[] = [
  { key: "relationships", label: "Relationships" },
  { key: "mcpServers", label: "Extra MCP servers" },
  { key: "mcpConfigFile", label: "MCP config file" },
  { key: "maxNewPerTick", label: "New agents per poll" },
  { key: "minSecondsBetweenAdmissions", label: "Seconds between agent starts" },
];

/** Edited above for providers that run linked-change eventing; for any other provider, listed only when the rule sets them, since they do nothing there. */
const LINKED_READONLY: readonly { key: string; label: string }[] = [
  { key: "linkedEventing", label: "Linked-change events (unused for this provider)" },
  { key: "maxLinkedTurnsPerHour", label: "Linked wakes per hour (unused for this provider)" },
  { key: "maxLinkedItems", label: "Linked items watched (unused for this provider)" },
  { key: "linkedRemoteLinks", label: "Follow remote links (unused for this provider)" },
  { key: "linkedDescriptionLinks", label: "Follow description links (unused for this provider)" },
  { key: "linkedPollIntervalMs", label: "Linked poll interval, ms (unused for this provider)" },
];

/** A label inside a sentence: "Relationships" becomes "relationships", but "MCP config file" keeps its acronym. */
function midSentence(label: string): string {
  return /^[A-Z][a-z]/.test(label) ? label.charAt(0).toLowerCase() + label.slice(1) : label;
}

function humanizeKey(key: string): string {
  const words = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function readOnlyValue(value: unknown): ReactNode {
  if (value === undefined || value === null) return <span className="rt-muted">not set</span>;
  if (typeof value === "boolean") return value ? "on" : "off";
  if (typeof value === "number" || typeof value === "string") return <code className="rt-query">{String(value)}</code>;
  return <pre className="rt-readonly__json">{JSON.stringify(value, null, 2)}</pre>;
}

/** The fields this editor can't change yet, so nothing in the rule is hidden. */
export function ReadOnlyFields({ isNew, details, error, provider }: { isNew: boolean; details: Record<string, unknown> | undefined; error: string | undefined; provider: ResourceProvider }) {
  let body: ReactNode;
  if (isNew) {
    body = (
      <Text elementType="p" size="small" className="rt-muted">
        New rules start with butchr's defaults for these: {NOT_EDITABLE_YET.map((f) => midSentence(f.label)).join(", ")}. Change them in rules.json after saving.
      </Text>
    );
  } else if (!details) {
    body = (
      <Text elementType="p" size="small" className={error ? "rt-field-error" : "rt-muted"}>
        {error ? `Couldn't load the rest of this rule: ${error}` : "Loading…"}
      </Text>
    );
  } else {
    const known = new Set([...NOT_EDITABLE_YET, ...LINKED_READONLY].map((f) => f.key));
    const prefs = Array.isArray(details["agentPreferences"]) ? (details["agentPreferences"] as unknown[]) : [];
    const unusedLinked = supportsLinkedEvents(provider) ? [] : LINKED_READONLY.filter((f) => details[f.key] !== undefined);
    const rows: { key: string; label: string; value: unknown }[] = [
      ...NOT_EDITABLE_YET.map((f) => ({ key: f.key, label: f.label, value: details[f.key] })),
      ...unusedLinked.map((f) => ({ key: f.key, label: f.label, value: details[f.key] })),
      ...(prefs.length > 1 ? [{ key: "agentPreferences", label: "Fallback agents", value: prefs.slice(1) }] : []),
      ...Object.keys(details)
        .filter((k) => !EDITED_HERE.has(k) && !known.has(k) && !IGNORED_LEGACY.has(k))
        .map((k) => ({ key: k, label: humanizeKey(k), value: details[k] })),
    ];
    body = (
      <dl className="rt-readonly" data-testid="rule-readonly-fields">
        {rows.map((r) => (
          <div key={r.key} className="rt-readonly__row">
            <dt>{r.label}</dt>
            <dd>{readOnlyValue(r.value)}</dd>
          </div>
        ))}
      </dl>
    );
  }
  return (
    <section className="rt-editor__section rt-editor__section--readonly">
      <h4 className="rt-editor__heading">Not editable here yet</h4>
      <Text elementType="p" size="small" className="rt-muted">
        Set in rules.json.
      </Text>
      {body}
    </section>
  );
}

function BriefSection({
  draft,
  issues,
  disabled,
  onChange,
  builtinBriefs,
  briefError,
}: {
  draft: RuleDraft;
  issues: readonly RuleIssue[];
  disabled: boolean;
  onChange: RuleEditorProps["onChange"];
  builtinBriefs: readonly BuiltinBrief[] | null;
  briefError: string | undefined;
}) {
  const brief = draft.brief;
  if (brief === null) {
    return (
      <section className="rt-editor__section">
        <h4 className="rt-editor__heading">Brief</h4>
        <Text elementType="p" size="small" className={briefError ? "rt-field-error" : "rt-muted"} data-testid="rule-brief-loading">
          {briefError ? `Couldn't load this rule's brief: ${briefError}` : "Loading brief…"}
        </Text>
      </section>
    );
  }
  const builtinName = builtinBriefName(brief);
  const known = builtinBriefs ?? [];
  const names = known.map((b) => b.name);
  // A rule may name a built-in this list doesn't know (an older or newer butchr); keep it selectable.
  if (builtinName !== null && !names.includes(builtinName)) names.push(builtinName);
  const builtinText = builtinName !== null ? known.find((b) => b.name === builtinName)?.text : undefined;
  const options = [...names.map((n) => ({ id: n, label: `Built-in: ${n}` })), { id: CUSTOM_BRIEF_KEY, label: "Custom" }];
  return (
    <section className="rt-editor__section">
      <h4 className="rt-editor__heading">Brief</h4>
      <div className="rt-editor__grid">
        <SelectField<string>
          label="Brief"
          value={builtinName ?? CUSTOM_BRIEF_KEY}
          options={options}
          onChange={(v) => {
            if (v === CUSTOM_BRIEF_KEY) {
              // Start custom text from the built-in it replaces, so it's a tweak rather than a blank page.
              if (builtinName !== null) onChange({ brief: builtinText ?? "" });
            } else {
              onChange({ brief: `${BUILTIN_BRIEF_PREFIX}${v}` });
            }
          }}
          isDisabled={disabled}
          testId="rule-brief-select"
          description="What the agent is told to do. Each ticket gets its own copy."
        />
      </div>
      {builtinName !== null ? (
        <div className="rt-brief-preview" data-testid="rule-brief-preview">
          <pre className="rt-brief-preview__text">{builtinText ?? "This butchr didn't list this built-in brief's text."}</pre>
          {builtinText !== undefined && (
            <Button size="small" variant="minimal" isDisabled={disabled} onPress={() => onChange({ brief: builtinText })} data-testid="rule-brief-customize">
              <Icon name="edit" size="small" />
              Customize this brief
            </Button>
          )}
        </div>
      ) : (
        <TextField className="rt-field rt-field--wide" value={brief} onChange={(v) => onChange({ brief: v })} isDisabled={disabled} isInvalid={issueFor(issues, "brief")?.level === "invalid"}>
          <Label>Brief text</Label>
          <TextArea rows={10} spellCheck={false} className="rt-brief-input" data-testid="rule-brief-input" {...typed((v) => onChange({ brief: v }))} />
          <IssueText issue={issueFor(issues, "brief")} />
          {!issueFor(issues, "brief") && <Text slot="description">{"Filled in per ticket: {{KEY}}, {{SUMMARY}}, {{TYPE}}, {{PARENT}}."}</Text>}
        </TextField>
      )}
    </section>
  );
}
