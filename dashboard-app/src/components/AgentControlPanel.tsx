/**
 * FACTORY-666 (epic FACTORY-659, story FACTORY-802, slice A1) — the
 * dashboard's agent-control panel: start, stop, shelve, adopt and
 * prioritize a fleet worker ticket (a Task/Story/Epic in Jira) instead of
 * the CLI/MCP. Deliberately OUT of scope (recorded on the ticket, agreed by
 * the epic owner): "send text to an agent pane" — that capability injects
 * instructions into a live agent and needs agentsafety's own review first.
 *
 * ONE ROUND TRIP, TWO CALLS for the destructive actions (stop/shelve), same
 * idiom `CreateRuleDialog.tsx` already uses for its own combined plan-then-
 * confirm route: the first call omits `confirm`, the server's own 200
 * response IS the dry-run preview (`requiresConfirm`/`confirmReason`/
 * `preview`, never parsed out of an error body — AC2), and pressing
 * "confirm" resends the SAME call with `confirm: true`.
 *
 * AC5/AC6: every successful action re-fetches the snapshot (`load()`) so
 * the panel always shows CURRENT state; `start`'s own note below states
 * explicitly that admission into a running agent still goes through the
 * daemon's capacity-capped reconcile poll, not this call.
 */
import { useState } from "react";
import { Button } from "@launchpad-ui/components";
import type { AgentActionPlan, AgentSnapshot, AgentsApi } from "../api/agents.js";
import "./RulesView.css";

export interface AgentControlPanelProps {
  api: AgentsApi;
  canWrite: boolean;
}

function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function isPlan(result: { requiresConfirm?: unknown }): result is AgentActionPlan {
  return result.requiresConfirm === true;
}

export function AgentControlPanel({ api, canWrite }: AgentControlPanelProps) {
  const [issueInput, setIssueInput] = useState("");
  const [snapshot, setSnapshot] = useState<AgentSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [stopPlan, setStopPlan] = useState<AgentActionPlan | null>(null);
  const [shelveReason, setShelveReason] = useState("");
  const [shelvePlan, setShelvePlan] = useState<AgentActionPlan | null>(null);
  const [adoptBossKey, setAdoptBossKey] = useState("");
  const [adoptDisposition, setAdoptDisposition] = useState<"start" | "shelve">("start");
  const [adoptReason, setAdoptReason] = useState("");
  const [priorityInput, setPriorityInput] = useState("");

  const disabled = busy || !canWrite;

  function load(key: string) {
    setLoading(true);
    setError(null);
    api
      .getSnapshot(key)
      .then((s) => {
        setSnapshot(s);
        setStopPlan(null);
        setShelvePlan(null);
      })
      .catch((e: unknown) => { setSnapshot(null); setError(describeError(e)); })
      .finally(() => setLoading(false));
  }

  function refresh() {
    if (snapshot) load(snapshot.key);
  }

  function runAction<T>(action: () => Promise<T>, onDone: (result: T) => void) {
    setBusy(true);
    setError(null);
    action()
      .then(onDone)
      .catch((e: unknown) => setError(describeError(e)))
      .finally(() => setBusy(false));
  }

  function doLoad() {
    const key = issueInput.trim();
    if (key) load(key);
  }

  function doStart() {
    if (!snapshot) return;
    runAction(() => api.start(snapshot.key), () => refresh());
  }

  function doStop(confirm: boolean) {
    if (!snapshot) return;
    runAction(
      () => api.stop(snapshot.key, confirm),
      (result) => {
        if (isPlan(result)) { setStopPlan(result); return; }
        setStopPlan(null);
        refresh();
      },
    );
  }

  function doShelve(confirm: boolean) {
    if (!snapshot) return;
    runAction(
      () => api.shelve(snapshot.key, shelveReason, confirm),
      (result) => {
        if (isPlan(result)) { setShelvePlan(result); return; }
        setShelvePlan(null);
        setShelveReason("");
        refresh();
      },
    );
  }

  function doAdopt() {
    if (!snapshot) return;
    runAction(
      () => api.adopt(snapshot.key, { bossKey: adoptBossKey.trim(), disposition: adoptDisposition, ...(adoptDisposition === "shelve" ? { reason: adoptReason } : {}) }),
      () => { setAdoptBossKey(""); setAdoptReason(""); refresh(); },
    );
  }

  function doPrioritize() {
    if (!snapshot || !priorityInput.trim()) return;
    runAction(() => api.prioritize(snapshot.key, priorityInput.trim()), () => { setPriorityInput(""); refresh(); });
  }

  return (
    <section aria-labelledby="agent-control-heading" data-testid="agent-control-panel">
      <h3 id="agent-control-heading">Agent control</h3>
      <label htmlFor="agent-control-issue-input">issue key</label>
      <input
        id="agent-control-issue-input"
        type="text"
        aria-label="issue key"
        data-testid="agent-control-issue-input"
        placeholder="FACTORY-666"
        value={issueInput}
        onInput={(e) => setIssueInput((e.target as HTMLInputElement).value)}
        disabled={loading}
      />
      <Button onPress={doLoad} isDisabled={loading || issueInput.trim() === ""} data-testid="agent-control-load-button">
        load
      </Button>

      {error !== null && (
        <p className="rules-view__cnc" data-testid="agent-control-error">
          {error}
        </p>
      )}

      {snapshot !== null && (
        <div data-testid="agent-control-snapshot">
          <p data-testid="agent-control-status">
            {snapshot.key}: status {snapshot.status ?? "unknown"}, boss {snapshot.boss ?? "none"}, {snapshot.running ? `running on ${snapshot.pane}` : "not running"}
          </p>

          {!snapshot.running && (
            <div>
              <Button onPress={doStart} isDisabled={disabled} data-testid="agent-control-start-button">
                start
              </Button>
              <p data-testid="agent-control-start-note">
                starting only marks the ticket ready — the daemon picks it up on its next reconcile poll, subject to the fleet-wide agent cap
              </p>
            </div>
          )}

          {snapshot.running && (
            <div>
              {stopPlan === null ? (
                <Button onPress={() => doStop(false)} isDisabled={disabled} data-testid="agent-control-stop-button">
                  stop
                </Button>
              ) : (
                <div data-testid="agent-control-stop-confirm">
                  <p>confirm stop: this will close pane {String(stopPlan.preview.pane ?? "")} for {snapshot.key}</p>
                  <Button variant="primary" onPress={() => doStop(true)} isDisabled={disabled} data-testid="agent-control-stop-confirm-button">
                    confirm stop
                  </Button>
                  <Button onPress={() => setStopPlan(null)} isDisabled={disabled}>
                    cancel
                  </Button>
                </div>
              )}
            </div>
          )}

          <div>
            <label htmlFor="agent-control-shelve-reason">shelve reason</label>
            <input
              id="agent-control-shelve-reason"
              type="text"
              aria-label="shelve reason"
              data-testid="agent-control-shelve-reason-input"
              value={shelveReason}
              onInput={(e) => setShelveReason((e.target as HTMLInputElement).value)}
              disabled={disabled}
            />
            {shelvePlan === null ? (
              <Button onPress={() => doShelve(false)} isDisabled={disabled || shelveReason.trim() === ""} data-testid="agent-control-shelve-button">
                shelve
              </Button>
            ) : (
              <div data-testid="agent-control-shelve-confirm">
                <p>confirm shelve: {snapshot.key} will move to To Do, labeled shelved, under boss {String(shelvePlan.preview.boss ?? "")}</p>
                <Button variant="primary" onPress={() => doShelve(true)} isDisabled={disabled} data-testid="agent-control-shelve-confirm-button">
                  confirm shelve
                </Button>
                <Button onPress={() => setShelvePlan(null)} isDisabled={disabled}>
                  cancel
                </Button>
              </div>
            )}
          </div>

          <div>
            <label htmlFor="agent-control-adopt-boss">adopt under boss</label>
            <input
              id="agent-control-adopt-boss"
              type="text"
              aria-label="boss key"
              data-testid="agent-control-adopt-boss-input"
              placeholder="FACTORY-802"
              value={adoptBossKey}
              onInput={(e) => setAdoptBossKey((e.target as HTMLInputElement).value)}
              disabled={disabled}
            />
            <select
              aria-label="adopt disposition"
              data-testid="agent-control-adopt-disposition-select"
              value={adoptDisposition}
              onChange={(e) => setAdoptDisposition(e.target.value as "start" | "shelve")}
              disabled={disabled}
            >
              <option value="start">start</option>
              <option value="shelve">shelve</option>
            </select>
            {adoptDisposition === "shelve" && (
              <input
                type="text"
                aria-label="adopt shelve reason"
                data-testid="agent-control-adopt-reason-input"
                value={adoptReason}
                onInput={(e) => setAdoptReason((e.target as HTMLInputElement).value)}
                disabled={disabled}
              />
            )}
            <Button
              onPress={doAdopt}
              isDisabled={disabled || adoptBossKey.trim() === "" || (adoptDisposition === "shelve" && adoptReason.trim() === "")}
              data-testid="agent-control-adopt-button"
            >
              adopt
            </Button>
          </div>

          <div>
            <label htmlFor="agent-control-priority">priority</label>
            <input
              id="agent-control-priority"
              type="text"
              aria-label="priority"
              data-testid="agent-control-priority-input"
              placeholder="High"
              value={priorityInput}
              onInput={(e) => setPriorityInput((e.target as HTMLInputElement).value)}
              disabled={disabled}
            />
            <Button onPress={doPrioritize} isDisabled={disabled || priorityInput.trim() === ""} data-testid="agent-control-prioritize-button">
              prioritize
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
