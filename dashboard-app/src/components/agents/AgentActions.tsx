/**
 * local/ui — the Agents page's actions, in place of upstream's separate
 * agent control panel (the user asked to fold it in): Stop on every agent's
 * row, Set priority and Put under a boss in the row menu of a Jira ticket's
 * agent, and Start a ticket in the page header. They use the same
 * `/api/agents/:issue/*` routes the panel did (`api/agents.ts`).
 *
 * Stop goes by the agent's own key, the id butchr's herd knows it by; the
 * panel went by the bare Jira key, which doesn't find an agent a rule runs.
 * Priority, boss and start are Jira-ticket operations done on the ticket's
 * boss's behalf, so they go by the ticket's key and need it to have a boss.
 */
import { useEffect, useState, type FormEvent } from "react";
import { Button, Dialog, Heading, IconButton, Input, Label, Menu, MenuItem, MenuTrigger, Modal, ModalOverlay, Popover, Text, TextField } from "@launchpad-ui/components";
import { Icon } from "@launchpad-ui/icons";
import type { AgentActionResult, AgentsApi, AgentSnapshot } from "../../api/agents.js";
import { decodeAnyAgentKey } from "../../view-model/agent-key-display.js";
import type { AgentRowView } from "../../view-model/dashboard-view.js";

const ISSUE_KEY_RE = /^[A-Z][A-Z0-9_]*-\d+$/;

/** The Jira ticket an agent works on, when it's a Jira work ticket: a jira-work rule's agent, or a legacy agent named by its bare key. */
export function jiraTicketOf(resourceKey: string): string | null {
  const decoded = decodeAnyAgentKey(resourceKey);
  if (decoded) return decoded.kind === "resource" && decoded.resourceProvider === "jira-work" ? decoded.resourceId : null;
  return ISSUE_KEY_RE.test(resourceKey) ? resourceKey : null;
}

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const typed = (fn: (value: string) => void) => ({ onInput: (e: FormEvent<HTMLInputElement>) => fn((e.target as HTMLInputElement).value) });
const noteOf = (r: AgentActionResult): string | null => {
  const note = (r as Record<string, unknown>)["note"];
  return typeof note === "string" ? note : null;
};

type Busy = { kind: "idle" } | { kind: "busy" } | { kind: "error"; message: string };

function StopDialog({ agentKey, label, api, onClose }: { agentKey: string; label: string; api: AgentsApi; onClose: (result: string | null) => void }) {
  const [plan, setPlan] = useState<{ pane: string; note: string } | null>(null);
  const [state, setState] = useState<Busy>({ kind: "busy" });
  useEffect(() => {
    let live = true;
    api.stop(agentKey, false).then(
      (r) => {
        if (!live) return;
        const preview = r.requiresConfirm ? r.preview : {};
        setPlan({ pane: String(preview["pane"] ?? ""), note: String(preview["note"] ?? "") });
        setState({ kind: "idle" });
      },
      (e) => live && setState({ kind: "error", message: errorText(e) }),
    );
    return () => { live = false; };
  }, [agentKey]);

  async function stop() {
    setState({ kind: "busy" });
    try {
      const r = await api.stop(agentKey, true);
      onClose(noteOf(r) ? `Stopped ${label}. ${noteOf(r)}` : `Stopped ${label}.`);
    } catch (e) {
      setState({ kind: "error", message: errorText(e) });
    }
  }

  return (
    <Dialog aria-label={`Stop ${label}'s agent`} data-testid="agent-stop-dialog">
      <div slot="header">
        <Heading slot="title">Stop {label}'s agent?</Heading>
        {plan && <Text slot="subtitle">This closes its pane, {plan.pane}.</Text>}
      </div>
      <div slot="body">
        {plan && <p className="ag-note st-muted">{plan.note}</p>}
        {!plan && state.kind === "busy" && <p className="ag-note st-muted">Checking…</p>}
        {state.kind === "error" && <p className="ag-note st-error" data-testid="agent-action-error">{state.message}</p>}
      </div>
      <div slot="footer">
        <Button onPress={() => onClose(null)}>Cancel</Button>
        <Button variant="destructive" isDisabled={!plan} isPending={plan !== null && state.kind === "busy"} onPress={() => void stop()} data-testid="agent-stop-confirm">
          Stop agent
        </Button>
      </div>
    </Dialog>
  );
}

/** Loads a ticket's snapshot (its boss, and whether an agent runs for it) for the Jira-ticket dialogs. */
function useSnapshot(api: AgentsApi, issue: string | null) {
  const [snapshot, setSnapshot] = useState<AgentSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setSnapshot(null);
    setError(null);
    if (!issue) return;
    let live = true;
    api.getSnapshot(issue).then((s) => live && setSnapshot(s), (e) => live && setError(errorText(e)));
    return () => { live = false; };
  }, [issue]);
  return { snapshot, error };
}

function NeedsBoss({ issue }: { issue: string }) {
  return (
    <p className="ag-note st-muted" data-testid="agent-needs-boss">
      butchr does this on the ticket's boss's behalf, and {issue} has no boss ticket yet. Put it under one first.
    </p>
  );
}

function PriorityDialog({ issue, api, onClose }: { issue: string; api: AgentsApi; onClose: (result: string | null) => void }) {
  const { snapshot, error } = useSnapshot(api, issue);
  const [priority, setPriority] = useState("");
  const [state, setState] = useState<Busy>({ kind: "idle" });
  async function save() {
    setState({ kind: "busy" });
    try {
      await api.prioritize(issue, priority.trim());
      onClose(`Set ${issue}'s priority to ${priority.trim()}.`);
    } catch (e) {
      setState({ kind: "error", message: errorText(e) });
    }
  }
  const hasBoss = snapshot !== null && snapshot.boss !== null;
  return (
    <Dialog aria-label={`Set ${issue}'s priority`} data-testid="agent-priority-dialog">
      <div slot="header">
        <Heading slot="title">Set {issue}'s priority</Heading>
        {snapshot?.boss && <Text slot="subtitle">As its boss, {snapshot.boss}.</Text>}
      </div>
      <div slot="body">
        {!snapshot && !error && <p className="ag-note st-muted">Loading…</p>}
        {snapshot && !hasBoss && <NeedsBoss issue={issue} />}
        {hasBoss && (
          <TextField value={priority} onChange={setPriority} isDisabled={state.kind === "busy"}>
            <Label>Priority</Label>
            <Input placeholder="High" data-testid="agent-priority-input" {...typed(setPriority)} />
            <Text slot="description">One of the project's Jira priorities, e.g. Highest, High, Medium.</Text>
          </TextField>
        )}
        {(error || state.kind === "error") && <p className="ag-note st-error" data-testid="agent-action-error">{error ?? (state.kind === "error" ? state.message : "")}</p>}
      </div>
      <div slot="footer">
        <Button onPress={() => onClose(null)}>Cancel</Button>
        <Button variant="primary" isDisabled={!hasBoss || !priority.trim()} isPending={state.kind === "busy"} onPress={() => void save()} data-testid="agent-priority-save">
          Set priority
        </Button>
      </div>
    </Dialog>
  );
}

/** Put a ticket under a boss and start it (`adopt`, the one disposition butchr has). Shared by the row menu and Start a ticket. */
function BossForm({ issue, api, onDone }: { issue: string; api: AgentsApi; onDone: (result: string) => void }) {
  const [boss, setBoss] = useState("");
  const [state, setState] = useState<Busy>({ kind: "idle" });
  async function adopt() {
    setState({ kind: "busy" });
    try {
      await api.adopt(issue, { bossKey: boss.trim(), disposition: "start" });
      onDone(`Put ${issue} under ${boss.trim()} and started it. butchr staffs it on its next poll if a slot is free.`);
    } catch (e) {
      setState({ kind: "error", message: errorText(e) });
    }
  }
  return (
    <form className="ag-form" onSubmit={(e) => { e.preventDefault(); if (boss.trim()) void adopt(); }}>
      <TextField value={boss} onChange={setBoss} isDisabled={state.kind === "busy"}>
        <Label>Boss ticket</Label>
        <Input placeholder="PROJ-12" spellCheck={false} data-testid="agent-boss-input" {...typed(setBoss)} />
        <Text slot="description">The ticket {issue} implements. Starting puts it In Progress.</Text>
      </TextField>
      {state.kind === "error" && <p className="ag-note st-error" data-testid="agent-action-error">{state.message}</p>}
      <Button type="submit" variant="primary" isDisabled={!boss.trim()} isPending={state.kind === "busy"} data-testid="agent-boss-save">
        Put under boss and start
      </Button>
    </form>
  );
}

function BossDialog({ issue, api, onClose }: { issue: string; api: AgentsApi; onClose: (result: string | null) => void }) {
  return (
    <Dialog aria-label={`Put ${issue} under a boss`} data-testid="agent-boss-dialog">
      <div slot="header">
        <Heading slot="title">Put {issue} under a boss</Heading>
      </div>
      <div slot="body">
        <BossForm issue={issue} api={api} onDone={(r) => onClose(r)} />
      </div>
      <div slot="footer">
        <Button onPress={() => onClose(null)}>Cancel</Button>
      </div>
    </Dialog>
  );
}

type Open = "stop" | "priority" | "boss" | null;

/** Stop for every agent; Set priority and Put under a boss for a Jira ticket's agent. */
export function AgentRowActions({ row, api, onResult }: { row: AgentRowView; api: AgentsApi; onResult: (text: string) => void }) {
  const [open, setOpen] = useState<Open>(null);
  const issue = jiraTicketOf(row.resourceKey);
  const close = (result: string | null) => {
    setOpen(null);
    if (result) onResult(result);
  };
  return (
    <div className="ag-actions">
      <Button size="small" onPress={() => setOpen("stop")} data-testid="agent-stop-button" aria-label={`Stop ${row.displayKey}'s agent`}>
        Stop
      </Button>
      {issue && (
        <MenuTrigger>
          <IconButton icon="more-vert" size="small" variant="minimal" aria-label={`More actions for ${row.displayKey}`} data-testid="agent-more-button" />
          <Popover placement="bottom end">
            <Menu onAction={(key) => setOpen(key as Open)}>
              <MenuItem id="priority" textValue="Set priority">
                <Text slot="label">
                  <Icon name="flag" size="small" /> Set priority…
                </Text>
              </MenuItem>
              <MenuItem id="boss" textValue="Put under a boss">
                <Text slot="label">
                  <Icon name="link" size="small" /> Put under a boss…
                </Text>
              </MenuItem>
            </Menu>
          </Popover>
        </MenuTrigger>
      )}
      <ModalOverlay isOpen={open !== null} isDismissable onOpenChange={(o) => { if (!o) setOpen(null); }}>
        <Modal size="small">
          {open === "stop" && <StopDialog agentKey={row.resourceKey} label={row.displayKey} api={api} onClose={close} />}
          {open === "priority" && issue && <PriorityDialog issue={issue} api={api} onClose={close} />}
          {open === "boss" && issue && <BossDialog issue={issue} api={api} onClose={close} />}
        </Modal>
      </ModalOverlay>
    </div>
  );
}

/** Start a Jira ticket that has no agent yet: look it up, then start it (or put it under a boss first). */
export function StartTicketButton({ api, onResult }: { api: AgentsApi; onResult: (text: string) => void }) {
  const [open, setOpen] = useState(false);
  const [keyInput, setKeyInput] = useState("");
  const [issue, setIssue] = useState<string | null>(null);
  const { snapshot, error } = useSnapshot(api, issue);
  const [state, setState] = useState<Busy>({ kind: "idle" });
  const reset = () => { setOpen(false); setIssue(null); setKeyInput(""); setState({ kind: "idle" }); };
  const done = (text: string) => { reset(); onResult(text); };

  async function start(key: string) {
    setState({ kind: "busy" });
    try {
      await api.start(key);
      done(`Started ${key}: it's In Progress, and butchr staffs it on its next poll if a slot is free.`);
    } catch (e) {
      setState({ kind: "error", message: errorText(e) });
    }
  }

  const key = keyInput.trim().toUpperCase();
  return (
    <>
      <Button size="small" onPress={() => setOpen(true)} data-testid="agent-start-open">
        <Icon name="add" size="small" />
        Start a ticket
      </Button>
      <ModalOverlay isOpen={open} isDismissable onOpenChange={(o) => { if (!o) reset(); }}>
        <Modal size="small">
          <Dialog aria-label="Start a ticket" data-testid="agent-start-dialog">
            <div slot="header">
              <Heading slot="title">Start a ticket</Heading>
              <Text slot="subtitle">Put a Jira ticket In Progress so butchr staffs it.</Text>
            </div>
            <div slot="body" className="ag-start">
              <form className="ag-form ag-form--row" onSubmit={(e) => { e.preventDefault(); if (ISSUE_KEY_RE.test(key)) { setState({ kind: "idle" }); setIssue(key); } }}>
                <TextField value={keyInput} onChange={setKeyInput} className="ag-form__grow">
                  <Label>Ticket</Label>
                  <Input placeholder="PROJ-123" spellCheck={false} autoComplete="off" data-testid="agent-start-key" {...typed(setKeyInput)} />
                </TextField>
                <Button type="submit" isDisabled={!ISSUE_KEY_RE.test(key)} data-testid="agent-start-lookup">
                  Look up
                </Button>
              </form>
              {issue && !snapshot && !error && <p className="ag-note st-muted">Looking up {issue}…</p>}
              {error && <p className="ag-note st-error" data-testid="agent-action-error">{error}</p>}
              {snapshot && (
                <>
                  <p className="ag-note" data-testid="agent-start-snapshot">
                    {snapshot.key}
                    {snapshot.summary ? `: ${snapshot.summary}` : ""} · {snapshot.status ?? "status unknown"} · boss {snapshot.boss ?? "none"}
                  </p>
                  {snapshot.running ? (
                    <p className="ag-note st-muted">It already has an agent, on {snapshot.pane}.</p>
                  ) : snapshot.boss === null ? (
                    <>
                      <NeedsBoss issue={snapshot.key} />
                      <BossForm issue={snapshot.key} api={api} onDone={done} />
                    </>
                  ) : (
                    <Button variant="primary" isPending={state.kind === "busy"} onPress={() => void start(snapshot.key)} data-testid="agent-start-confirm">
                      Start {snapshot.key}
                    </Button>
                  )}
                  {state.kind === "error" && <p className="ag-note st-error" data-testid="agent-action-error">{state.message}</p>}
                </>
              )}
            </div>
            <div slot="footer">
              <Button onPress={reset}>Close</Button>
            </div>
          </Dialog>
        </Modal>
      </ModalOverlay>
    </>
  );
}
