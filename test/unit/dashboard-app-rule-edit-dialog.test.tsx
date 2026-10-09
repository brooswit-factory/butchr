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
import { capacityRoleFor } from "../../src/agents/capacity-role.js";

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
    resumeOnRespawn: null,
    resumeContextCutoff: null,
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

  // FACTORY-730 (review round 2, blocking finding — AC3): a query edit is
  // NEVER zero-blast-radius any more, even for a disabled rule — Save shows
  // a confirm step naming the new query's own dry-run scope, and the write
  // is refused server-side (via the fixture's own mirrored gate) until
  // that confirm is sent. This replaces the old "...with zero blast radius
  // (no confirm)" test, whose premise the review found unsafe (AC3).
  test("editing a disabled rule's query shows a confirm step naming the new scope, and only writes once confirmed", async () => {
    const api = createFixturesRulesApi({
      initial: { rules: [rule()], errors: [] },
      latencyMs: 0,
      previewsByQuery: { "epics:project = FACTORY AND type = Epic AND status != Done": { ruleId: "epics", total: 7, tickets: [] } },
    });
    const { findByTestId, getByRole } = render(
      <RuleEditDialog api={api} rule={rule()} sourceEtag="fixture-etag-0" stale={false} canWrite onChanged={() => undefined} onClose={() => undefined} />,
    );
    const input = (await findByTestId("rule-edit-query-input")) as HTMLInputElement;
    fireEvent.input(input, { target: { value: "project = FACTORY AND type = Epic AND status != Done" } });
    fireEvent.click(getByRole("button", { name: "Save" }));
    const confirm = await findByTestId("rule-edit-confirm");
    expect(confirm.textContent).toContain("would now match 7 tickets");

    const stillOld = await api.listRules();
    expect(stillOld.rules.find((r) => r.id === "epics")!.query).toBe(rule().query);

    fireEvent.click(getByRole("button", { name: "confirm" }));
    await waitFor(async () => {
      const after = await api.listRules();
      expect(after.rules.find((r) => r.id === "epics")!.query).toBe("project = FACTORY AND type = Epic AND status != Done");
    });
    expect(await findByTestId("rule-edit-undo")).toBeTruthy();
  });

  // ticket item 3: a confirm step is required before applying a query edit
  // to an ENABLED rule, and applying without confirming is impossible
  // (server-enforced — the fixture mirrors the real server's own
  // `requireConfirmForBlastRadius`). FACTORY-730 (review round 2):
  // `confirmReason` is `"query-change"` here, not the generic
  // `"stop-restart"` — both gates independently require confirm (either
  // alone would block Save), but the dialog leads with the more actionable
  // scope count rather than the generic restart count when both apply.
  test("editing the query of an ALREADY-ENABLED rule shows a confirm step naming the new scope, and only writes once confirmed", async () => {
    const enabledRule = rule({ enabled: true });
    const api = createFixturesRulesApi({
      initial: { rules: [enabledRule], errors: [] },
      latencyMs: 0,
      previewsByQuery: { "epics:project = FACTORY AND type = Epic AND status != Done": { ruleId: "epics", total: 3, tickets: [] } },
    });
    const { findByTestId, getByRole } = render(
      <RuleEditDialog api={api} rule={enabledRule} sourceEtag="fixture-etag-0" stale={false} canWrite onChanged={() => undefined} onClose={() => undefined} />,
    );
    const input = (await findByTestId("rule-edit-query-input")) as HTMLInputElement;
    fireEvent.input(input, { target: { value: "project = FACTORY AND type = Epic AND status != Done" } });
    fireEvent.click(getByRole("button", { name: "Save" }));
    const confirm = await findByTestId("rule-edit-confirm");
    expect(confirm.textContent).toContain("would now match 3 tickets");

    const stillOld = await api.listRules();
    expect(stillOld.rules.find((r) => r.id === "epics")!.query).toBe(enabledRule.query);

    fireEvent.click(getByRole("button", { name: "confirm" }));
    await waitFor(async () => {
      const after = await api.listRules();
      expect(after.rules.find((r) => r.id === "epics")!.query).toBe("project = FACTORY AND type = Epic AND status != Done");
    });
  });

  // ticket item 3 / AC3 (review round 2): "applying without the confirm
  // step must be impossible (server-enforced, not just UI)" — a changed
  // query shows a notice as soon as it's dirty, and clicking Save (never
  // skippable) is what surfaces the actual dry-run scope count, inside the
  // mandatory confirm step itself.
  test("FACTORY-730 (ticket item 3 / AC3): a dirty query shows a notice, and Save's confirm step shows the new query's own dry-run count", async () => {
    const api = createFixturesRulesApi({
      initial: { rules: [rule()], errors: [] },
      latencyMs: 0,
      previewsByQuery: { "epics:project = FACTORY AND type = Epic AND status != Done": { ruleId: "epics", total: 7, tickets: [] } },
    });
    const { findByTestId, getByRole, queryByTestId } = render(
      <RuleEditDialog api={api} rule={rule()} sourceEtag="fixture-etag-0" stale={false} canWrite onChanged={() => undefined} onClose={() => undefined} />,
    );
    expect(queryByTestId("rule-edit-query-changed-notice")).toBeNull();
    const input = (await findByTestId("rule-edit-query-input")) as HTMLInputElement;
    fireEvent.input(input, { target: { value: "project = FACTORY AND type = Epic AND status != Done" } });
    expect(await findByTestId("rule-edit-query-changed-notice")).toBeTruthy();
    fireEvent.click(getByRole("button", { name: "Save" }));
    const confirm = await findByTestId("rule-edit-confirm");
    expect(confirm.textContent).toContain("would now match 7 tickets");
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
    // FACTORY-730 (review round 2): the query change itself now requires a
    // confirm step first (planRule's own `requiresConfirm`, independent of
    // the sourceEtag) — the etag mismatch only surfaces once that's
    // confirmed and the real write (`updateFields`) is attempted.
    await findByTestId("rule-edit-confirm");
    fireEvent.click(getByRole("button", { name: "confirm" }));
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

  // FACTORY-856 (story FACTORY-756, epic FACTORY-748): "Included in
  // capacity" toggle, existing-rule edit dialog surface. Epic review on PR
  // 715 (comment on FACTORY-856) requires criterion 4 to owe a form
  // round-trip on an EXISTING rule, asserted via the engine's own reader
  // (`capacityRoleFor` fed a `ruleRoleOf` built from the reloaded rules),
  // not just the raw stored field — the same discipline
  // `test/unit/rules-write.test.ts` already applies server-side for
  // `ui-first-rule`.
  describe("FACTORY-856: 'Included in capacity' toggle", () => {
    test("renders at the rule's current role — unset (role: worker) is ON", async () => {
      const api = createFixturesRulesApi({ initial: { rules: [rule()], errors: [] }, latencyMs: 0 });
      const { findByTestId } = render(
        <RuleEditDialog api={api} rule={rule()} sourceEtag="fixture-etag-0" stale={false} canWrite onChanged={() => undefined} onClose={() => undefined} />,
      );
      const toggle = (await findByTestId("rule-edit-capacity-toggle")) as HTMLElement;
      const input = toggle.querySelector("input")!;
      expect(input.getAttribute("aria-checked") ?? String(input.checked)).toBe("true");
      expect(await findByTestId("rule-edit-capacity-copy")).toBeTruthy();
    });

    test("renders OFF for a rule already saved with role: sentinel", async () => {
      const sentinelRule = rule({ role: "sentinel" });
      const api = createFixturesRulesApi({ initial: { rules: [sentinelRule], errors: [] }, latencyMs: 0 });
      const { findByTestId } = render(
        <RuleEditDialog api={api} rule={sentinelRule} sourceEtag="fixture-etag-0" stale={false} canWrite onChanged={() => undefined} onClose={() => undefined} />,
      );
      const toggle = (await findByTestId("rule-edit-capacity-toggle")) as HTMLElement;
      const input = toggle.querySelector("input")!;
      expect(input.getAttribute("aria-checked") ?? String(input.checked)).toBe("false");
    });

    test("a jira-project rule shows the toggle disabled with an explanatory note", async () => {
      const managerRule = rule({ resourceProvider: "jira-project" });
      const api = createFixturesRulesApi({ initial: { rules: [managerRule], errors: [] }, latencyMs: 0 });
      const { findByTestId } = render(
        <RuleEditDialog api={api} rule={managerRule} sourceEtag="fixture-etag-0" stale={false} canWrite onChanged={() => undefined} onClose={() => undefined} />,
      );
      const toggle = (await findByTestId("rule-edit-capacity-toggle")) as HTMLElement;
      expect(toggle.querySelector("input")?.hasAttribute("disabled")).toBe(true);
      const notice = await findByTestId("rule-edit-capacity-manager-notice");
      expect(notice.textContent).toContain("never consume fleet capacity");
    });

    // buildFieldsPatch discipline (epic review item 1): `role` is sent ONLY
    // when the draft differs from the rule's own saved value — unlike
    // `FirstRuleSetup`'s always-send. Toggling then toggling back must
    // produce an EMPTY patch, i.e. Save does nothing (no plan/write call at
    // all) rather than round-tripping the unchanged value through the wire.
    test("toggling off then back on sends no role patch at all (buildFieldsPatch discipline)", async () => {
      const api = createFixturesRulesApi({ initial: { rules: [rule()], errors: [] }, latencyMs: 0 });
      const { findByTestId, getByRole } = render(
        <RuleEditDialog api={api} rule={rule()} sourceEtag="fixture-etag-0" stale={false} canWrite onChanged={() => undefined} onClose={() => undefined} />,
      );
      const toggle = await findByTestId("rule-edit-capacity-toggle");
      const input = toggle.querySelector("input")!;
      fireEvent.click(input);
      expect(await findByTestId("rule-edit-capacity-notice")).toBeTruthy();
      fireEvent.click(input);
      fireEvent.click(getByRole("button", { name: "Save" }));
      // No confirm step appears and the rule is untouched — an unchanged
      // draft produces an empty patch, so `handleSave` is a no-op.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(document.querySelector('[data-testid="rule-edit-confirm"]')).toBeNull();
      const after = await api.listRules();
      expect(after.rules.find((r) => r.id === "epics")!.role).toBe("worker");
    });

    test("turning capacity off requires an explicit confirm, and round-trips through the engine's own capacityRoleFor reader", async () => {
      const api = createFixturesRulesApi({ initial: { rules: [rule()], errors: [] }, latencyMs: 0 });
      const { findByTestId, getByRole } = render(
        <RuleEditDialog api={api} rule={rule()} sourceEtag="fixture-etag-0" stale={false} canWrite onChanged={() => undefined} onClose={() => undefined} />,
      );
      const toggle = await findByTestId("rule-edit-capacity-toggle");
      const input = toggle.querySelector("input")!;
      fireEvent.click(input);
      expect(await findByTestId("rule-edit-capacity-notice")).toBeTruthy();
      fireEvent.click(getByRole("button", { name: "Save" }));
      expect(await findByTestId("rule-edit-confirm")).toBeTruthy();

      const stillWorker = await api.listRules();
      expect(stillWorker.rules.find((r) => r.id === "epics")!.role).toBe("worker");

      fireEvent.click(getByRole("button", { name: "confirm" }));
      await waitFor(async () => {
        const after = await api.listRules();
        expect(after.rules.find((r) => r.id === "epics")!.role).toBe("sentinel");
      });

      // Criterion 4 / epic review item 2: assert via the engine's own
      // reader, fed the RELOADED rules — not the raw field on the response
      // — mirroring `src/daemon/index.ts`'s own `ruleRoleOfAgent`.
      const reloaded = await api.listRules();
      const ruleRoleOf = (_id: string) => reloaded.rules.find((r) => r.id === "epics")?.role;
      expect(capacityRoleFor("jira-work:epics:BUTCHR-1", ruleRoleOf)).toBe("sentinel");
    });

    test("saving role: worker (toggling an already-sentinel rule back on) needs no confirm", async () => {
      const sentinelRule = rule({ role: "sentinel" });
      const api = createFixturesRulesApi({ initial: { rules: [sentinelRule], errors: [] }, latencyMs: 0 });
      const { findByTestId, getByRole } = render(
        <RuleEditDialog api={api} rule={sentinelRule} sourceEtag="fixture-etag-0" stale={false} canWrite onChanged={() => undefined} onClose={() => undefined} />,
      );
      const toggle = await findByTestId("rule-edit-capacity-toggle");
      fireEvent.click(toggle.querySelector("input")!);
      fireEvent.click(getByRole("button", { name: "Save" }));
      await waitFor(async () => {
        const after = await api.listRules();
        expect(after.rules.find((r) => r.id === "epics")!.role).toBe("worker");
      });
      const reloaded = await api.listRules();
      const ruleRoleOf = (_id: string) => reloaded.rules.find((r) => r.id === "epics")?.role;
      expect(capacityRoleFor("jira-work:epics:BUTCHR-1", ruleRoleOf)).toBe("worker");
    });
  });
});
