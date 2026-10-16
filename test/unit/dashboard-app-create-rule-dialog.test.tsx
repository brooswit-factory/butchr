/**
 * FACTORY-927 (review round 1, item 2) — `CreateRuleDialog.tsx` must show
 * the "confirm create" button ONLY for the server's own "please confirm"
 * dry-run step (`{kind: "needs-confirm", plan: {confirmReason:
 * "rule-create"}}`) — every OTHER outcome (an id collision, a plain
 * validation 400, a rate-limited 429, or a `confirmReason:
 * "unmeasurable-scope"` 503) must render as a plain refusal with NO
 * confirm button at all, since resending with `confirm: true` cannot fix
 * any of those.
 *
 * Uses a minimal hand-rolled `RulesApi` stub (not `createFixturesRulesApi`)
 * so each test controls `createRule`'s exact `RuleCreateOutcome` directly —
 * the fixture's own in-memory state machine has no natural equivalent for
 * "plain 400" or "unmeasurable scope" (those are server-side refusals this
 * dialog must handle regardless of which gate produced them).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { withDom } from "../setup/happy-dom.js";
import { CreateRuleDialog } from "../../dashboard-app/src/components/CreateRuleDialog.js";
import type { RuleCreateOutcome, RulesApi } from "../../dashboard-app/src/api/rules.js";
import { RULE_FORM_CATALOG, AGENT_ROLES, CAPACITY_ROLE_DEFAULT } from "../../src/rules/rule-form-catalog.js";

withDom();
afterEach(cleanup);

function stubApi(createRule: (...a: unknown[]) => Promise<RuleCreateOutcome>): RulesApi {
  return {
    capabilities: { write: true },
    listRules: () => Promise.reject(new Error("unused")),
    getCatalog: () => Promise.resolve(RULE_FORM_CATALOG),
    getCapacityRoles: () => Promise.resolve({ values: AGENT_ROLES, default: CAPACITY_ROLE_DEFAULT }),
    previewRule: () => Promise.reject(new Error("unused")),
    planRule: () => Promise.reject(new Error("unused")),
    setEnabled: () => Promise.reject(new Error("unused")),
    updateFields: () => Promise.reject(new Error("unused")),
    deleteRule: () => Promise.reject(new Error("unused")),
    undo: () => Promise.reject(new Error("unused")),
    refreshCapabilities: () => Promise.resolve({ write: true }),
    createRule: createRule as RulesApi["createRule"],
  } as unknown as RulesApi;
}

async function fillMinimalForm(getByTestId: (id: string) => HTMLElement) {
  fireEvent.input(getByTestId("create-rule-id-input"), { target: { value: "new-rule" } });
  fireEvent.input(getByTestId("create-rule-query-input"), { target: { value: "project = X" } });
}

describe("CreateRuleDialog — review round 1, item 2 (confirm button only for confirmReason === 'rule-create')", () => {
  test("ordinary needs-confirm (confirmReason 'rule-create'): shows the confirm button", async () => {
    const api = stubApi(async () => ({ kind: "needs-confirm", plan: { planHash: "h", spawned: 0, stopped: 0, restarted: 0, scope: 3, etag: "e", requiresConfirm: true, confirmReason: "rule-create" } }));
    const { getByTestId, queryByTestId, findByTestId } = render(<CreateRuleDialog api={api} canWrite stale={false} onChanged={() => undefined} onClose={() => undefined} />);
    await fillMinimalForm(getByTestId);
    fireEvent.click(getByTestId("create-rule-submit"));
    await findByTestId("create-rule-confirm-button");
    expect(queryByTestId("create-rule-error")).toBeNull();
  });

  test("id collision (refused): plain error, NO confirm button", async () => {
    const api = stubApi(async () => ({ kind: "refused", error: `a rule with id "new-rule" already exists` }));
    const { getByTestId, queryByTestId, findByTestId } = render(<CreateRuleDialog api={api} canWrite stale={false} onChanged={() => undefined} onClose={() => undefined} />);
    await fillMinimalForm(getByTestId);
    fireEvent.click(getByTestId("create-rule-submit"));
    const error = await findByTestId("create-rule-error");
    expect(error.textContent).toContain("already exists");
    expect(queryByTestId("create-rule-confirm-button")).toBeNull();
  });

  test("plain validation failure (refused, e.g. a 400): plain error, NO confirm button", async () => {
    const api = stubApi(async () => ({ kind: "refused", error: `resourceProvider must be one of jira-work, github-issue, ...` }));
    const { getByTestId, queryByTestId, findByTestId } = render(<CreateRuleDialog api={api} canWrite stale={false} onChanged={() => undefined} onClose={() => undefined} />);
    await fillMinimalForm(getByTestId);
    fireEvent.click(getByTestId("create-rule-submit"));
    const error = await findByTestId("create-rule-error");
    expect(error.textContent).toContain("resourceProvider must be one of");
    expect(queryByTestId("create-rule-confirm-button")).toBeNull();
  });

  test("rate limited (refused, 429): plain error, NO confirm button", async () => {
    const api = stubApi(async () => ({ kind: "refused", error: "rate limited: too many write attempts — retry after 5s", retryAfterSeconds: 5 }));
    const { getByTestId, queryByTestId, findByTestId } = render(<CreateRuleDialog api={api} canWrite stale={false} onChanged={() => undefined} onClose={() => undefined} />);
    await fillMinimalForm(getByTestId);
    fireEvent.click(getByTestId("create-rule-submit"));
    const error = await findByTestId("create-rule-error");
    expect(error.textContent).toContain("rate limited");
    expect(queryByTestId("create-rule-confirm-button")).toBeNull();
  });

  test("unmeasurable scope (refused, 503, confirmReason 'unmeasurable-scope'): plain error, NO confirm button", async () => {
    const api = stubApi(async () => ({ kind: "refused", error: "could not evaluate the scope for the new rule's query — the previewer is unavailable; this create is refused closed (even with confirm: true) until scope can be measured — try again", confirmReason: "unmeasurable-scope" }));
    const { getByTestId, queryByTestId, findByTestId } = render(<CreateRuleDialog api={api} canWrite stale={false} onChanged={() => undefined} onClose={() => undefined} />);
    await fillMinimalForm(getByTestId);
    fireEvent.click(getByTestId("create-rule-submit"));
    const error = await findByTestId("create-rule-error");
    expect(error.textContent).toContain("previewer is unavailable");
    expect(queryByTestId("create-rule-confirm-button")).toBeNull();
  });

  test("confirming after the ordinary needs-confirm step creates the rule", async () => {
    let lastConfirm: boolean | undefined;
    const api = stubApi(async (draft, confirm) => {
      lastConfirm = confirm as boolean;
      if (!confirm) return { kind: "needs-confirm", plan: { planHash: "h", spawned: 0, stopped: 0, restarted: 0, scope: 3, etag: "e", requiresConfirm: true, confirmReason: "rule-create" } };
      return { kind: "created", result: { backupId: "b1", etag: "e2", changedIds: ["new-rule"] } };
    });
    const { getByTestId, findByTestId } = render(<CreateRuleDialog api={api} canWrite stale={false} onChanged={() => undefined} onClose={() => undefined} />);
    await fillMinimalForm(getByTestId);
    fireEvent.click(getByTestId("create-rule-submit"));
    await findByTestId("create-rule-confirm-button");
    fireEvent.click(getByTestId("create-rule-confirm-button"));
    await findByTestId("create-rule-done-dialog");
    await waitFor(() => expect(lastConfirm).toBe(true));
  });
});
