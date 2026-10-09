/**
 * FACTORY-666 — `AgentControlPanel.tsx`'s own UI discipline: AC2 requires
 * the UI to never show a hard error as a confirm prompt, and to only ever
 * enter the confirm step from the server's own structured
 * `requiresConfirm`/`preview` field on a 200 — never parsed out of an error
 * body. Uses a minimal hand-rolled `AgentsApi` stub, same idiom
 * `dashboard-app-create-rule-dialog.test.tsx` already uses.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { withDom } from "../setup/happy-dom.js";
import { AgentControlPanel } from "../../dashboard-app/src/components/AgentControlPanel.js";
import type { AgentSnapshot, AgentsApi } from "../../dashboard-app/src/api/agents.js";

withDom();
afterEach(cleanup);

const RUNNING_SNAPSHOT: AgentSnapshot = { key: "FACTORY-1", status: "In Progress", summary: "x", labels: [], boss: "FACTORY-BOSS", running: true, pane: "pane-7" };
const IDLE_SNAPSHOT: AgentSnapshot = { key: "FACTORY-1", status: "To Do", summary: "x", labels: [], boss: "FACTORY-BOSS", running: false, pane: null };

function stubApi(overrides: Partial<AgentsApi>): AgentsApi {
  const unused = (name: string) => () => Promise.reject(new Error(`unused: ${name}`));
  return {
    getSnapshot: unused("getSnapshot"),
    start: unused("start"),
    stop: unused("stop"),
    shelve: unused("shelve"),
    adopt: unused("adopt"),
    prioritize: unused("prioritize"),
    ...overrides,
  } as AgentsApi;
}

async function loadIssue(getByTestId: (id: string) => HTMLElement) {
  fireEvent.input(getByTestId("agent-control-issue-input"), { target: { value: "FACTORY-1" } });
  fireEvent.click(getByTestId("agent-control-load-button"));
}

describe("AgentControlPanel — FACTORY-666", () => {
  test("loading an issue shows its status/boss/running state", async () => {
    const api = stubApi({ getSnapshot: () => Promise.resolve(RUNNING_SNAPSHOT) });
    const { getByTestId, findByTestId } = render(<AgentControlPanel api={api} canWrite />);
    await loadIssue(getByTestId);
    const status = await findByTestId("agent-control-status");
    expect(status.textContent).toContain("In Progress");
    expect(status.textContent).toContain("FACTORY-BOSS");
    expect(status.textContent).toContain("running on pane-7");
  });

  test("a snapshot load failure shows the error verbatim, no snapshot rendered", async () => {
    const api = stubApi({ getSnapshot: () => Promise.reject(new Error("could not read FACTORY-1: HTTP 404")) });
    const { getByTestId, findByTestId, queryByTestId } = render(<AgentControlPanel api={api} canWrite />);
    await loadIssue(getByTestId);
    const error = await findByTestId("agent-control-error");
    expect(error.textContent).toBe("could not read FACTORY-1: HTTP 404");
    expect(queryByTestId("agent-control-snapshot")).toBeNull();
  });

  test("stop: the ordinary first call (requiresConfirm) shows a confirm step naming the pane, NEVER stops directly", async () => {
    let stopCalls = 0;
    const api = stubApi({
      getSnapshot: () => Promise.resolve(RUNNING_SNAPSHOT),
      stop: (_issue, confirm) => {
        stopCalls++;
        if (!confirm) return Promise.resolve({ requiresConfirm: true, confirmReason: "agent-stop", preview: { key: "FACTORY-1", pane: "pane-7" } });
        return Promise.resolve({ ok: true });
      },
    });
    const { getByTestId, findByTestId } = render(<AgentControlPanel api={api} canWrite />);
    await loadIssue(getByTestId);
    await findByTestId("agent-control-stop-button");
    fireEvent.click(getByTestId("agent-control-stop-button"));
    const confirm = await findByTestId("agent-control-stop-confirm");
    expect(confirm.textContent).toContain("pane-7");
    expect(stopCalls).toBe(1); // the plan call only — stop was never confirmed yet
  });

  test("stop: confirming resends with confirm:true and refreshes the snapshot afterward", async () => {
    let snapshotCalls = 0;
    let lastConfirm: boolean | undefined;
    const api = stubApi({
      getSnapshot: () => { snapshotCalls++; return Promise.resolve(snapshotCalls === 1 ? RUNNING_SNAPSHOT : IDLE_SNAPSHOT); },
      stop: (_issue, confirm) => {
        lastConfirm = confirm;
        if (!confirm) return Promise.resolve({ requiresConfirm: true, confirmReason: "agent-stop", preview: { key: "FACTORY-1", pane: "pane-7" } });
        return Promise.resolve({ ok: true });
      },
    });
    const { getByTestId, findByTestId } = render(<AgentControlPanel api={api} canWrite />);
    await loadIssue(getByTestId);
    await findByTestId("agent-control-stop-button");
    fireEvent.click(getByTestId("agent-control-stop-button"));
    await findByTestId("agent-control-stop-confirm-button");
    fireEvent.click(getByTestId("agent-control-stop-confirm-button"));
    await waitFor(() => expect(lastConfirm).toBe(true));
    await waitFor(() => expect(snapshotCalls).toBe(2));
  });

  test("shelve requires a non-empty reason before the button is enabled", async () => {
    const api = stubApi({ getSnapshot: () => Promise.resolve(IDLE_SNAPSHOT) });
    const { getByTestId, findByTestId } = render(<AgentControlPanel api={api} canWrite />);
    await loadIssue(getByTestId);
    const shelveButton = await findByTestId("agent-control-shelve-button") as HTMLButtonElement;
    expect(shelveButton.disabled).toBe(true);
    fireEvent.input(getByTestId("agent-control-shelve-reason-input"), { target: { value: "operator stepping in" } });
    await waitFor(() => expect((getByTestId("agent-control-shelve-button") as HTMLButtonElement).disabled).toBe(false));
  });

  test("not running: shows the start button and the next-poll note (AC6), never a stop button", async () => {
    const api = stubApi({ getSnapshot: () => Promise.resolve(IDLE_SNAPSHOT) });
    const { getByTestId, findByTestId, queryByTestId } = render(<AgentControlPanel api={api} canWrite />);
    await loadIssue(getByTestId);
    await findByTestId("agent-control-start-button");
    expect(queryByTestId("agent-control-stop-button")).toBeNull();
    const note = await findByTestId("agent-control-start-note");
    expect(note.textContent).toContain("next reconcile poll");
    expect(note.textContent).toContain("fleet-wide agent cap");
  });
});
