/**
 * local/ui — the Settings page's Providers section: one card per integration
 * butchr holds a token for (Atlassian, GitHub, Zendesk, Trello), the one-time setup-code
 * instructions every token change needs, and a restart banner once
 * something changed. Tokens go in password fields that are cleared after
 * every submit; nothing here displays, stores or logs a token value.
 */
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Alert, AlertText, Button, Dialog, FieldError, Heading, IconButton, Input, Label, Modal, ModalOverlay, Text, TextField } from "@launchpad-ui/components";
import { Icon } from "@launchpad-ui/icons";
import { RateLimitError, type CredentialsSummary, type LayeredValue, type SettingsApi, type TokenStatus } from "../../api/settings.js";
import { ProvidedByEnvironmentError, RateLimitError as SetupRateLimitError, type SetupApi } from "../../api/setup.js";
import { GITHUB_ORGS_MAX, githubTestText, jiraTestText, layeredPending, orgRowProblems, orgsPending, orgsToSave, pendingRestartChanges, providerTestText, stillUsingText, tokenIsSet, tokenLocationText, tokenWarning } from "../../view-model/credentials-view.js";
import { ProviderIcon } from "./ProviderIcon.js";
import "./Credentials.css";

/** `onInput` beside `onChange`: same value, but it's the event happy-dom delivers in this repo's component tests (see `RuleEditor`'s `typed`). */
function typed(fn: (value: string) => void) {
  return { onInput: (e: FormEvent<HTMLInputElement>) => fn((e.target as HTMLInputElement).value) };
}

function errorText(e: unknown): string {
  if (e instanceof RateLimitError || e instanceof SetupRateLimitError) return e.retryAfterSeconds !== undefined ? `${e.message} (retry in ${e.retryAfterSeconds}s)` : e.message;
  return e instanceof Error ? e.message : String(e);
}

type Result = { kind: "ok" | "error"; text: string } | null;

function ResultText({ result, testId }: { result: Result; testId: string }) {
  if (!result) return null;
  return (
    <Text elementType="p" size="small" className={result.kind === "error" ? "cr-error" : "cr-ok"} data-testid={testId}>
      {result.text}
    </Text>
  );
}

function TokenLine({ token, testId }: { token: TokenStatus; testId: string }) {
  const warning = tokenWarning(token);
  return (
    <div className="cr-token" data-testid={testId}>
      <Text elementType="p" size="small">
        {tokenLocationText(token)}
      </Text>
      {warning && (
        <Text elementType="p" size="small" className="cr-warning">
          {warning}
        </Text>
      )}
    </div>
  );
}

function TestButton({ run, testId }: { run: () => Promise<{ ok: boolean; text: string }>; testId: string }) {
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<Result>(null);
  async function test() {
    setPending(true);
    try {
      const r = await run();
      setResult({ kind: r.ok ? "ok" : "error", text: r.text });
    } catch (e) {
      setResult({ kind: "error", text: errorText(e) });
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="cr-test">
      <Button onPress={() => void test()} isDisabled={pending} data-testid={`${testId}-button`}>
        {pending ? "Testing…" : "Test connection"}
      </Button>
      <ResultText result={result} testId={`${testId}-result`} />
    </div>
  );
}

interface SecretField {
  name: string;
  label: string;
}

/**
 * "Set token" / "Replace token": one password field per secret plus the
 * setup code, all cleared after every submit. Each field's test id is
 * `<prefix>-<name>`.
 */
function SecretForm({ tokens, fields, labels, testIdPrefix, submit }: {
  tokens: readonly TokenStatus[];
  fields: readonly SecretField[];
  labels: { set: string; replace: string; save: string };
  testIdPrefix: string;
  submit: (values: Readonly<Record<string, string>>, setupCode: string) => Promise<string>;
}) {
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [code, setCode] = useState("");
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<Result>(null);

  const readOnlyReason = tokens.map((t) => t.readOnlyReason).find((r) => r !== null);
  if (readOnlyReason) {
    return (
      <Text elementType="p" size="small" className="cr-muted" data-testid={`${testIdPrefix}-readonly`}>
        {readOnlyReason}
      </Text>
    );
  }

  const complete = fields.every((f) => (values[f.name] ?? "").trim() !== "") && code.trim() !== "";
  const setField = (name: string) => (value: string) => setValues((prev) => ({ ...prev, [name]: value }));
  const clear = () => { setValues({}); setCode(""); };

  async function save() {
    if (pending || !complete) return;
    setPending(true);
    try {
      setResult({ kind: "ok", text: await submit(values, code) });
      setOpen(false);
    } catch (e) {
      setResult({ kind: "error", text: errorText(e) });
    } finally {
      clear();
      setPending(false);
    }
  }

  return (
    <div className="cr-token-form">
      {!open && (
        <Button onPress={() => { setOpen(true); setResult(null); }} data-testid={`${testIdPrefix}-open`}>
          {tokens.every(tokenIsSet) ? labels.replace : labels.set}
        </Button>
      )}
      {open && (
        <form className="cr-form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
          {fields.map((f) => (
            <TextField key={f.name} className="cr-field" value={values[f.name] ?? ""} onChange={setField(f.name)} isDisabled={pending}>
              <Label>{f.label}</Label>
              <Input type="password" autoComplete="off" spellCheck={false} data-testid={`${testIdPrefix}-${f.name}`} {...typed(setField(f.name))} />
            </TextField>
          ))}
          <TextField className="cr-field" value={code} onChange={setCode} isDisabled={pending}>
            <Label>Setup code</Label>
            <Input autoComplete="off" spellCheck={false} data-testid={`${testIdPrefix}-code`} {...typed(setCode)} />
            <Text slot="description">One-time code from butchr's log. See "Getting a setup code" below.</Text>
          </TextField>
          <div className="cr-actions">
            <Button onPress={() => { setOpen(false); clear(); }} isDisabled={pending}>
              Cancel
            </Button>
            <Button variant="primary" onPress={() => void save()} isDisabled={pending || !complete} data-testid={`${testIdPrefix}-save`}>
              {pending ? "Checking…" : labels.save}
            </Button>
          </div>
        </form>
      )}
      <ResultText result={result} testId={`${testIdPrefix}-result`} />
    </div>
  );
}

/** The one-secret case every token card uses. */
function TokenForm({ token, label, testIdPrefix, submit }: { token: TokenStatus; label: string; testIdPrefix: string; submit: (input: { token: string; setupCode: string }) => Promise<string> }) {
  return (
    <SecretForm
      tokens={[token]}
      fields={[{ name: "token", label }]}
      labels={{ set: "Set token", replace: "Replace token", save: "Save token" }}
      testIdPrefix={testIdPrefix}
      submit={(values, setupCode) => submit({ token: values["token"] ?? "", setupCode })}
    />
  );
}

/** A non-secret setting a card owns (a subdomain, a board id): editable unless butchr's environment sets it, saved to settings.json. */
function LayeredField({ settingKey, layered, label, placeholder, description, testId, change, api, onChanged }: {
  settingKey: string;
  layered: LayeredValue;
  label: string;
  placeholder: string;
  description: string;
  testId: string;
  /** How the restart banner names this change. */
  change: string;
  api: SettingsApi;
  onChanged: (what: string) => void;
}) {
  const [text, setText] = useState(layered.value ?? "");
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<Result>(null);
  if (!layered.editable) {
    return (
      <Text elementType="p" size="small" data-testid={`${testId}-readonly`}>
        {label}: {layered.value} (set in butchr's environment, {settingKey}).
      </Text>
    );
  }
  const draft = text.trim();
  async function save() {
    setSaving(true);
    try {
      await api.writeSetting(settingKey, draft, false);
      onChanged(change);
      setResult({ kind: "ok", text: "Saved. Restart butchr to use it." });
    } catch (e) {
      setResult({ kind: "error", text: errorText(e) });
    } finally {
      setSaving(false);
    }
  }
  return (
    <>
      <div className="cr-orgs">
        <TextField className="cr-field cr-field--wide" value={text} onChange={setText} isDisabled={saving}>
          <Label>{label}</Label>
          <Input placeholder={placeholder} spellCheck={false} data-testid={testId} {...typed(setText)} />
          <Text slot="description">{description}</Text>
        </TextField>
        <Button onPress={() => void save()} isDisabled={saving || !draft || draft === (layered.value ?? "")} data-testid={`${testId}-save`}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
      <ResultText result={result} testId={`${testId}-result`} />
      {result === null && layeredPending(layered) && (
        <Text elementType="p" size="small" className="cr-muted" data-testid={`${testId}-pending`}>
          {stillUsingText(layered.running)}
        </Text>
      )}
    </>
  );
}

function AtlassianCard({ atlassian, api, setupApi, onChanged }: { atlassian: CredentialsSummary["atlassian"]; api: SettingsApi; setupApi: SetupApi; onChanged: (what: string) => void }) {
  return (
    <section className="cr-card" aria-labelledby="cr-atlassian-title" data-testid="cr-atlassian">
      <header className="cr-card__header">
        <Heading level={3} id="cr-atlassian-title" className="cr-card__title">
          <ProviderIcon provider="atlassian" />
          Atlassian
        </Heading>
        <Text size="small" className="cr-muted">
          Jira and Confluence
        </Text>
      </header>
      <div className="cr-card__body">
        <dl className="cr-facts">
          <div>
            <dt>Site</dt>
            <dd>{atlassian.site ?? "not configured"}</dd>
          </div>
          <div>
            <dt>Email</dt>
            <dd>{atlassian.email ?? "not configured"}</dd>
          </div>
        </dl>
        <TokenLine token={atlassian.token} testId="cr-atlassian-token-status" />
        <TestButton
          testId="cr-atlassian-test"
          run={async () => {
            const r = await api.testJiraConnection();
            return { ok: r.ok, text: jiraTestText(r) };
          }}
        />
        <TokenForm
          token={atlassian.token}
          label="New Atlassian API token"
          testIdPrefix="cr-atlassian"
          submit={async (input) => {
            try {
              const r = await setupApi.rotateToken(input);
              onChanged("the Atlassian token");
              return `Saved. It belongs to ${r.displayName}. Restart butchr to use it.`;
            } catch (e) {
              if (e instanceof ProvidedByEnvironmentError) throw new Error("The token is set directly in butchr's environment (ATLASSIAN_TOKEN), so it can't be changed here.");
              throw e;
            }
          }}
        />
      </div>
    </section>
  );
}

interface OrgRow {
  id: number;
  name: string;
}

/**
 * The GitHub card's organizations: one field per org, − removes it, + adds
 * one. Saved as BUTCHR_GITHUB_ORGS, the comma-separated list butchr reads.
 * Focus follows the list: a new row gets it, and removing a row hands it to
 * the row that takes its place (or the add button when none is left).
 */
function OrgListField({ saved, pendingText, api, onChanged }: { saved: readonly string[]; pendingText: string | null; api: SettingsApi; onChanged: (what: string) => void }) {
  const nextId = useRef(0);
  const newRow = (name: string): OrgRow => ({ id: nextId.current++, name });
  const [rows, setRows] = useState<OrgRow[]>(() => (saved.length > 0 ? saved.map(newRow) : [newRow("")]));
  const [focus, setFocus] = useState<{ row: number } | "add" | null>(null);
  const inputs = useRef(new Map<number, HTMLInputElement>());
  const addButton = useRef<HTMLButtonElement>(null);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<Result>(null);

  useEffect(() => {
    if (focus === null) return;
    (focus === "add" ? addButton.current : inputs.current.get(focus.row))?.focus();
    setFocus(null);
  }, [focus]);

  const problems = orgRowProblems(rows.map((r) => r.name));
  const draft = orgsToSave(rows.map((r) => r.name));
  const canSave = !saving && draft.length > 0 && draft.join(",") !== saved.join(",") && problems.every((p) => p === null);

  const rename = (id: number) => (name: string) => setRows((prev) => prev.map((r) => (r.id === id ? { ...r, name } : r)));
  function add() {
    const row = newRow("");
    setRows((prev) => [...prev, row]);
    setFocus({ row: row.id });
  }
  function remove(id: number) {
    const at = rows.findIndex((r) => r.id === id);
    const rest = rows.filter((r) => r.id !== id);
    setRows(rest);
    const next = rest[at] ?? rest[at - 1];
    setFocus(next ? { row: next.id } : "add");
  }
  async function save() {
    setSaving(true);
    try {
      await api.writeSetting("BUTCHR_GITHUB_ORGS", draft.join(","), false);
      onChanged("the GitHub organizations");
      setResult({ kind: "ok", text: "Saved. Restart butchr to use them." });
    } catch (e) {
      setResult({ kind: "error", text: errorText(e) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="cr-org-list" role="group" aria-labelledby="cr-github-orgs-label" aria-describedby="cr-github-orgs-help" data-testid="cr-github-orgs">
      <Label id="cr-github-orgs-label" elementType="span">
        Organizations
      </Label>
      <Text id="cr-github-orgs-help" elementType="p" size="small" className="cr-muted">
        butchr only works with repositories in these organizations.
      </Text>
      {rows.length > 0 && (
        <ul className="cr-org-rows">
          {rows.map((row, i) => {
            const name = row.name.trim();
            return (
              <li key={row.id} className="cr-org-row">
                <TextField className="cr-field cr-field--wide" aria-label={`Organization ${i + 1}`} value={row.name} onChange={rename(row.id)} isInvalid={problems[i] !== null} isDisabled={saving}>
                  <Input
                    ref={(el: HTMLInputElement | null) => { if (el) inputs.current.set(row.id, el); else inputs.current.delete(row.id); }}
                    placeholder="e.g. acme"
                    spellCheck={false}
                    autoComplete="off"
                    data-testid={`cr-github-org-${i}`}
                    {...typed(rename(row.id))}
                  />
                  <FieldError data-testid={`cr-github-org-${i}-error`}>{problems[i]}</FieldError>
                </TextField>
                <IconButton
                  icon="minus"
                  size="small"
                  variant="minimal"
                  aria-label={name ? `Remove ${name}` : `Remove organization ${i + 1}`}
                  onPress={() => remove(row.id)}
                  isDisabled={saving}
                  className="cr-org-remove"
                  data-testid={`cr-github-org-${i}-remove`}
                />
              </li>
            );
          })}
        </ul>
      )}
      {draft.length === 0 && saved.length > 0 && (
        <Text elementType="p" size="small" className="cr-warning" data-testid="cr-github-orgs-empty">
          GitHub needs at least one organization. Add one to save.
        </Text>
      )}
      <div className="cr-actions">
        <Button ref={addButton} onPress={add} isDisabled={saving || rows.length >= GITHUB_ORGS_MAX} data-testid="cr-github-orgs-add">
          <Icon name="add" size="small" />
          Add organization
        </Button>
        <Button onPress={() => void save()} isDisabled={!canSave} data-testid="cr-github-orgs-save">
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
      <ResultText result={result} testId="cr-github-orgs-result" />
      {result === null && pendingText && (
        <Text elementType="p" size="small" className="cr-muted" data-testid="cr-github-orgs-pending">
          {pendingText}
        </Text>
      )}
    </div>
  );
}

function GithubCard({ github, api, onChanged }: { github: CredentialsSummary["github"]; api: SettingsApi; onChanged: (what: string) => void }) {
  return (
    <section className="cr-card" aria-labelledby="cr-github-title" data-testid="cr-github">
      <header className="cr-card__header">
        <Heading level={3} id="cr-github-title" className="cr-card__title">
          <ProviderIcon provider="github" />
          GitHub
        </Heading>
        <Text size="small" className={github.active ? "cr-ok" : "cr-muted"} data-testid="cr-github-status">
          {github.active ? "On" : "Off: needs a token and at least one organization, then a restart"}
        </Text>
      </header>
      <div className="cr-card__body">
        {github.orgsEditable ? (
          <OrgListField saved={github.orgs} pendingText={orgsPending(github) ? stillUsingText(github.runningOrgs.join(", ") || null) : null} api={api} onChanged={onChanged} />
        ) : (
          <Text elementType="p" size="small" data-testid="cr-github-orgs-readonly">
            Organizations: {github.orgs.join(", ")} (set in butchr's environment, BUTCHR_GITHUB_ORGS).
          </Text>
        )}
        <TokenLine token={github.token} testId="cr-github-token-status" />
        <TestButton
          testId="cr-github-test"
          run={async () => {
            const r = await api.testGithubConnection();
            return { ok: r.ok, text: githubTestText(r) };
          }}
        />
        <TokenForm
          token={github.token}
          label="New GitHub token"
          testIdPrefix="cr-github"
          submit={async (input) => {
            const r = await api.writeGithubToken(input);
            onChanged("the GitHub token");
            return `Saved. It belongs to ${r.login}. Restart butchr to use it.`;
          }}
        />
      </div>
    </section>
  );
}

function ZendeskCard({ zendesk, api, onChanged }: { zendesk: CredentialsSummary["zendesk"]; api: SettingsApi; onChanged: (what: string) => void }) {
  return (
    <section className="cr-card" aria-labelledby="cr-zendesk-title" data-testid="cr-zendesk">
      <header className="cr-card__header">
        <Heading level={3} id="cr-zendesk-title" className="cr-card__title">
          <ProviderIcon provider="zendesk" />
          Zendesk
        </Heading>
        <Text size="small" className="cr-muted">
          zendesk-ticket rules
        </Text>
      </header>
      <div className="cr-card__body">
        <LayeredField
          settingKey="ZENDESK_SUBDOMAIN"
          layered={zendesk.subdomain}
          label="Subdomain"
          placeholder="e.g. acme"
          description="The part before .zendesk.com."
          testId="cr-zendesk-subdomain"
          change="the Zendesk subdomain"
          api={api}
          onChanged={onChanged}
        />
        <TokenLine token={zendesk.token} testId="cr-zendesk-token-status" />
        <Text elementType="p" size="small" className={zendesk.riskAccepted ? "cr-muted" : "cr-warning"} data-testid="cr-zendesk-risk">
          {zendesk.riskAccepted
            ? "Turned on in butchr's environment (BUTCHR_ZENDESK_ACCEPT_SHELL_CREDENTIAL_RISK)."
            : "Off until butchr's environment sets BUTCHR_ZENDESK_ACCEPT_SHELL_CREDENTIAL_RISK=agents-can-read-the-zendesk-token: agents run shell commands as butchr's user, so they can read this token. That stays an .env decision."}
        </Text>
        <TestButton
          testId="cr-zendesk-test"
          run={async () => {
            const r = await api.testProviderConnection("zendesk");
            return { ok: r.ok, text: providerTestText(r) };
          }}
        />
        <TokenForm
          token={zendesk.token}
          label="New Zendesk OAuth token"
          testIdPrefix="cr-zendesk"
          submit={async (input) => {
            const r = await api.writeZendeskToken(input);
            onChanged("the Zendesk token");
            return `Saved. It belongs to ${r.account}. Restart butchr to use it.`;
          }}
        />
      </div>
    </section>
  );
}

function TrelloCard({ trello, api, onChanged }: { trello: CredentialsSummary["trello"]; api: SettingsApi; onChanged: (what: string) => void }) {
  return (
    <section className="cr-card" aria-labelledby="cr-trello-title" data-testid="cr-trello">
      <header className="cr-card__header">
        <Heading level={3} id="cr-trello-title" className="cr-card__title">
          <ProviderIcon provider="trello" />
          Trello
        </Heading>
        <Text size="small" className="cr-muted">
          trello-card rules
        </Text>
      </header>
      <div className="cr-card__body">
        <LayeredField
          settingKey="TRELLO_BOARD_ID"
          layered={trello.boardId}
          label="Board id"
          placeholder="24 hex characters"
          description="The one board butchr works on. Add .json to the board's URL to find its id."
          testId="cr-trello-board"
          change="the Trello board"
          api={api}
          onChanged={onChanged}
        />
        <TokenLine token={trello.apiKey} testId="cr-trello-key-status" />
        <TokenLine token={trello.token} testId="cr-trello-token-status" />
        <Text elementType="p" size="small" className={trello.riskAccepted ? "cr-muted" : "cr-warning"} data-testid="cr-trello-risk">
          {trello.riskAccepted
            ? "Turned on in butchr's environment (BUTCHR_TRELLO_ACCEPT_SHELL_CREDENTIAL_RISK)."
            : "Rules stay off until butchr's environment sets BUTCHR_TRELLO_ACCEPT_SHELL_CREDENTIAL_RISK=agents-can-read-the-trello-credentials: agents run shell commands as butchr's user, so they can read this key and token. That stays an .env decision."}
        </Text>
        <TestButton
          testId="cr-trello-test"
          run={async () => {
            const r = await api.testProviderConnection("trello");
            return { ok: r.ok, text: providerTestText(r) };
          }}
        />
        <SecretForm
          tokens={[trello.apiKey, trello.token]}
          fields={[{ name: "key", label: "Trello API key" }, { name: "token", label: "Trello token" }]}
          labels={{ set: "Set key and token", replace: "Replace key and token", save: "Save both" }}
          testIdPrefix="cr-trello"
          submit={async (values, setupCode) => {
            const r = await api.writeTrelloCredentials({ apiKey: values["key"] ?? "", token: values["token"] ?? "", setupCode });
            onChanged("the Trello credentials");
            return `Saved. They belong to ${r.account}. Restart butchr to use them.`;
          }}
        />
      </div>
    </section>
  );
}

function CommandLine({ command, testId }: { command: string; testId: string }) {
  return (
    <div className="cr-command">
      <code data-testid={testId}>{command}</code>
      <IconButton icon="copy-code" aria-label="Copy command" size="small" variant="minimal" onPress={() => void navigator.clipboard?.writeText(command)} />
    </div>
  );
}

function SetupCodeHelp({ setupCode }: { setupCode: CredentialsSummary["setupCode"] }) {
  return (
    <section className="cr-help" aria-labelledby="cr-setup-code-title" data-testid="cr-setup-code">
      <Heading level={3} id="cr-setup-code-title" className="cr-card__title">
        Getting a setup code
      </Heading>
      <Text elementType="p" size="small">
        Every token change needs a one-time code that butchr prints only to {setupCode.where}, so only someone at this machine can approve it. In a terminal, run:
      </Text>
      <CommandLine command={setupCode.command} testId="cr-setup-code-command" />
      {setupCode.findCommand && (
        <>
          <Text elementType="p" size="small">
            then read the code with:
          </Text>
          <CommandLine command={setupCode.findCommand} testId="cr-setup-code-find" />
        </>
      )}
      <Text elementType="p" size="small" className="cr-muted">
        A code works once, for 10 minutes. Five wrong tries lock it until you ask for a new one.
      </Text>
    </section>
  );
}

type RestartState = { kind: "idle" } | { kind: "confirm" } | { kind: "restarting" } | { kind: "back" } | { kind: "error"; message: string };

function RestartBanner({ changes, supported, restartAndWait, onBack }: { changes: readonly string[]; supported: boolean; restartAndWait: () => Promise<void>; onBack: () => void }) {
  const [state, setState] = useState<RestartState>({ kind: "idle" });
  async function restart() {
    setState({ kind: "restarting" });
    try {
      await restartAndWait();
      setState({ kind: "back" });
      onBack();
    } catch (e) {
      setState({ kind: "error", message: errorText(e) });
    }
  }
  if (changes.length === 0) {
    return state.kind === "back" ? (
      <Alert status="success" variant="inline" className="cr-banner" data-testid="cr-restart-done">
        <AlertText>butchr is back, using your changes.</AlertText>
      </Alert>
    ) : null;
  }
  return (
    <div className="cr-banner" data-testid="cr-restart-banner">
      <Alert status="info" variant="inline">
        <AlertText>
          You changed {changes.join(" and ")}. Restart butchr to apply {changes.length > 1 ? "them" : "it"}. Running agents keep running, and butchr picks them back up.
        </AlertText>
      </Alert>
      {supported ? (
        <Button variant="primary" onPress={() => setState({ kind: "confirm" })} isDisabled={state.kind === "restarting"} data-testid="cr-restart-button">
          {state.kind === "restarting" ? "Restarting…" : "Restart butchr"}
        </Button>
      ) : (
        <Text size="small" className="cr-muted">
          Restart butchr by hand to apply it.
        </Text>
      )}
      {state.kind === "error" && (
        <Text elementType="p" size="small" className="cr-error" data-testid="cr-restart-error">
          {state.message}
        </Text>
      )}
      <ModalOverlay isOpen={state.kind === "confirm"} isDismissable onOpenChange={(open) => { if (!open) setState({ kind: "idle" }); }}>
        <Modal size="small">
          <Dialog aria-label="Restart butchr" data-testid="cr-restart-dialog">
            <div slot="header">
              <Heading slot="title">Restart butchr?</Heading>
              <Text slot="subtitle">The dashboard and agents' butchr connection drop for a few seconds. Running agents keep running.</Text>
            </div>
            <div slot="footer">
              <Button onPress={() => setState({ kind: "idle" })}>Cancel</Button>
              <Button variant="primary" onPress={() => void restart()} data-testid="cr-restart-confirm">
                Restart now
              </Button>
            </div>
          </Dialog>
        </Modal>
      </ModalOverlay>
    </div>
  );
}

export interface CredentialsSectionProps {
  credentials: CredentialsSummary;
  api: SettingsApi;
  setupApi: SetupApi;
  /** Restarts butchr and resolves once it answers again (the Settings route owns the polling). */
  restartAndWait: () => Promise<void>;
  /** What the rest of the Settings page changed, so the one restart banner names those too. */
  otherChanges?: readonly string[];
  /** Called once butchr is back after the banner's restart, so the rest of the page can forget its changes. */
  onRestarted?: () => void;
}

export function CredentialsSection({ credentials, api, setupApi, restartAndWait, otherChanges = [], onRestarted }: CredentialsSectionProps) {
  const [changes, setChanges] = useState<string[]>([]);
  const onChanged = (what: string) => setChanges((prev) => (prev.includes(what) ? prev : [...prev, what]));
  // What butchr says is saved but not running yet (so the banner survives a
  // reload), except in answers from the process a restart just replaced:
  // those can still arrive for a moment after it's back.
  const [restartedFrom, setRestartedFrom] = useState<string | null>(null);
  const serverPending = credentials.restart.startedAt === restartedFrom ? [] : pendingRestartChanges(credentials);
  const ours = [...changes, ...serverPending.filter((p) => !changes.includes(p))];
  const pending = [...ours, ...otherChanges.filter((p) => !ours.includes(p))];
  return (
    <section className="cr-section" aria-labelledby="cr-heading" data-testid="credentials-section">
      <div className="cr-section__intro">
        <Heading level={2} id="cr-heading" className="cr-section__title">
          Providers
        </Heading>
        <Text elementType="p" size="small" className="cr-muted">
          Tokens are checked before they're saved, stored in owner-only files, and never shown again. Changes apply after a restart.
        </Text>
      </div>
      <RestartBanner
        changes={pending}
        supported={credentials.restart.supported}
        restartAndWait={restartAndWait}
        onBack={() => {
          setChanges([]);
          setRestartedFrom(credentials.restart.startedAt ?? null);
          onRestarted?.();
        }}
      />
      <div className="cr-cards">
        <AtlassianCard atlassian={credentials.atlassian} api={api} setupApi={setupApi} onChanged={onChanged} />
        <GithubCard github={credentials.github} api={api} onChanged={onChanged} />
        <ZendeskCard zendesk={credentials.zendesk} api={api} onChanged={onChanged} />
        <TrelloCard trello={credentials.trello} api={api} onChanged={onChanged} />
      </div>
      <SetupCodeHelp setupCode={credentials.setupCode} />
    </section>
  );
}
