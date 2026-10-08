/**
 * FACTORY-730 — `RuleEditDialog.tsx`: the generic "edit an existing rule"
 * dialog the Rules table's per-row Edit button opens for ANY rule (the
 * route-level `ui-`-prefix write gate is retired — `src/rules/rules-write-
 * registry.ts`'s own header). Exercises it directly (not through
 * `RulesRoute`) against `createFixturesRulesApi`, same isolation discipline
 * every other component test in this repo follows (never a real daemon).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { withDom } from "../setup/happy-dom.js";
import { RuleEditDialog } from "../../dashboard-app/src/components/RuleEditDialog.js";
import { createFixturesRulesApi } from "../../dashboard-app/src/api/rules.js";
import type { RuleDto } from "../../dashboard-app/src/api/rules.js";

withDom();
afterEach(cleanup);

function rule(overrides: Partial<RuleDto> = {}): RuleDto {
  return {
    id: "epics",
    resourceProvider: "jira-work",
    query: "project = FACTORY AND type = Epic",
    enabled: false,
    execution: "swarm",
    account: "none",
    role: "worker",
    agentPreferences: [{ harness: "claude", model: "claude-opus-5" }],
    permissionMode: null,
    lizardMode: null,
    staffed: false,
    reason: "disabled",
    ...overrides,
  };
}

describe("RuleEditDialog — FACTORY-730: edit an existing (non-ui-prefixed) rule", () => {
  test("prefills the query input from the rule, not the placeholder", async () => {
    const api = createFixturesRulesApi({ initial: { rules: [rule()], errors: [] }, latencyMs: 0 });
    const { findByTestId } = render(
      <RuleEditDialog api={api} rule={rule()} sourceEtag="fixture-etag-0" stale={false} canWrite onChanged={() => undefined} onClose={() => undefined} />,
    );
    const input = (await findByTestId("rule-edit-query-input")) as HTMLInputElement;
    expect(input.value).toBe("project = FACTORY AND type = Epic");
  });

  test("editing a disabled rule's query and saving writes it with zero blast radius (no confirm)", async () => {
    const api = createFixturesRulesApi({ initial: { rules: [rule()], errors: [] }, latencyMs: 0 });
    const { findByTestId, getByRole } = render(
      <RuleEditDialog api={api} rule={rule()} sourceEtag="fixture-etag-0" stale={false} canWrite onChanged={() => undefined} onClose={() => undefined} />,
    );
    const input = (await findByTestId("rule-edit-query-input")) as HTMLInputElement;
    fireEvent.input(input, { target: { value: "project = FACTORY AND type = Epic AND status != Done" } });
    fireEvent.click(getByRole("button", { name: "Save" }));
    await waitFor(async () => {
      const after = await api.listRules();
      expect(after.rules.find((r) => r.id === "epics")!.query).toBe("project = FACTORY AND type = Epic AND status != Done");
    });
    expect(await findByTestId("rule-edit-undo")).toBeTruthy();
  });

  // ticket item 3: a confirm step is required before applying an edit that
  // would restart a running agent, and applying without confirming is
  // impossible (server-enforced — the fixture mirrors the real server's own
  // `requireConfirmForBlastRadius`).
  test("editing the query of an ALREADY-ENABLED rule shows a confirm step naming the restart, and only writes once confirmed", async () => {
    const enabledRule = rule({ enabled: true });
    const api = createFixturesRulesApi({ initial: { rules: [enabledRule], errors: [] }, latencyMs: 0 });
    const { findByTestId, getByRole } = render(
      <RuleEditDialog api={api} rule={enabledRule} sourceEtag="fixture-etag-0" stale={false} canWrite onChanged={() => undefined} onClose={() => undefined} />,
    );
    const input = (await findByTestId("rule-edit-query-input")) as HTMLInputElement;
    fireEvent.input(input, { target: { value: "project = FACTORY AND type = Epic AND status != Done" } });
    fireEvent.click(getByRole("button", { name: "Save" }));
    const confirm = await findByTestId("rule-edit-confirm");
    expect(confirm.textContent).toContain("restart 1");

    const stillOld = await api.listRules();
    expect(stillOld.rules.find((r) => r.id === "epics")!.query).toBe(enabledRule.query);

    fireEvent.click(getByRole("button", { name: "confirm" }));
    await waitFor(async () => {
      const after = await api.listRules();
      expect(after.rules.find((r) => r.id === "epics")!.query).toBe("project = FACTORY AND type = Epic AND status != Done");
    });
  });

  // ticket item 3: "before apply, show the operator what the edit would do,
  // including the dry-run/preview scope count for a CHANGED query" — the
  // scope check is available (and surfaces a count) independent of whether
  // the save itself needs a confirm (this rule is DISABLED, so saving its
  // query alone never trips the stop/restart gate).
  test("FACTORY-730 (ticket item 3): changing the query reveals a 'check scope' control that dry-runs the DRAFT text and shows the count, before saving", async () => {
    const api = createFixturesRulesApi({
      initial: { rules: [rule()], errors: [] },
      latencyMs: 0,
      previewsByQuery: { "epics:project = FACTORY AND type = Epic AND status != Done": { ruleId: "epics", total: 7, tickets: [] } },
    });
    const { findByTestId, getByRole, queryByTestId } = render(
      <RuleEditDialog api={api} rule={rule()} sourceEtag="fixture-etag-0" stale={false} canWrite onChanged={() => undefined} onClose={() => undefined} />,
    );
    expect(queryByTestId("rule-edit-scope-count")).toBeNull();
    const input = (await findByTestId("rule-edit-query-input")) as HTMLInputElement;
    fireEvent.input(input, { target: { value: "project = FACTORY AND type = Epic AND status != Done" } });
    fireEvent.click(getByRole("button", { name: "check scope for this query" }));
    const scope = await findByTestId("rule-edit-scope-count");
    expect(scope.textContent).toContain("would match 7 tickets");
  });

  test("setting permissionMode: bypassPermissions requires an explicit confirm before saving", async () => {
    const api = createFixturesRulesApi({ initial: { rules: [rule()], errors: [] }, latencyMs: 0 });
    const { findByTestId, getByRole } = render(
      <RuleEditDialog api={api} rule={rule()} sourceEtag="fixture-etag-0" stale={false} canWrite onChanged={() => undefined} onClose={() => undefined} />,
    );
    const select = (await findByTestId("rule-edit-permission-mode-select")) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "bypassPermissions" } });
    expect(await findByTestId("rule-edit-risky-permission-notice")).toBeTruthy();
    fireEvent.click(getByRole("button", { name: "Save" }));
    const confirm = await findByTestId("rule-edit-confirm");
    expect(confirm).toBeTruthy();
    fireEvent.click(getByRole("button", { name: "confirm" }));
    await waitFor(async () => {
      const after = await api.listRules();
      expect(after.rules.find((r) => r.id === "epics")!.permissionMode).toBe("bypassPermissions");
    });
  });

  test("a write refusal (e.g. stale etag) surfaces the server's own message verbatim", async () => {
    const api = createFixturesRulesApi({ initial: { rules: [rule()], errors: [] }, latencyMs: 0 });
    const { findByTestId, getByRole } = render(
      <RuleEditDialog api={api} rule={rule()} sourceEtag="stale-etag-does-not-match" stale={false} canWrite onChanged={() => undefined} onClose={() => undefined} />,
    );
    const input = (await findByTestId("rule-edit-query-input")) as HTMLInputElement;
    fireEvent.input(input, { target: { value: "project = CHANGED" } });
    fireEvent.click(getByRole("button", { name: "Save" }));
    const error = await findByTestId("rule-edit-error");
    expect(error.textContent).toContain("etag mismatch");
  });

  test("every control is disabled while stale is true", async () => {
    const api = createFixturesRulesApi({ initial: { rules: [rule()], errors: [] }, latencyMs: 0 });
    const { findByTestId } = render(
      <RuleEditDialog api={api} rule={rule()} sourceEtag="fixture-etag-0" stale canWrite onChanged={() => undefined} onClose={() => undefined} />,
    );
    const input = (await findByTestId("rule-edit-query-input")) as HTMLInputElement;
    expect(input.disabled).toBe(true);
    expect(await findByTestId("rule-edit-stale")).toBeTruthy();
  });
});
