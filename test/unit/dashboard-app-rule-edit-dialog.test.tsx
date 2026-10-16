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
    agentPreferences: [{ harness: "claude", model: "claude-opus-5" }],
    permissionMode: null,
    lizardMode: null,
    resumeOnRespawn: null,
    resumeContextCutoff: null,
    idlePokeMinutes: null,
    idlePokeMessage: null,
    idlePokeEnabled: true,
    notifyDeliveryMode: null,
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

  // FACTORY-846 (review round 1): no confirm needed (CONFIG SURFACE ONLY,
  // never risky) — unlike the permissionMode test above.
  test("editing idlePokeMinutes/idlePokeMessage/idlePokeEnabled saves without a confirm step", async () => {
    const api = createFixturesRulesApi({ initial: { rules: [rule()], errors: [] }, latencyMs: 0 });
    const { findByTestId, getByRole } = render(
      <RuleEditDialog api={api} rule={rule()} sourceEtag="fixture-etag-0" stale={false} canWrite onChanged={() => undefined} onClose={() => undefined} />,
    );
    const minutesInput = (await findByTestId("rule-edit-idle-poke-minutes-input")) as HTMLInputElement;
    const messageInput = (await findByTestId("rule-edit-idle-poke-message-input")) as HTMLInputElement;
    expect(minutesInput.value).toBe("");
    expect(messageInput.value).toBe("");
    fireEvent.input(minutesInput, { target: { value: "45" } });
    fireEvent.input(messageInput, { target: { value: "go check your ticket" } });
    const toggle = await findByTestId("rule-edit-idle-poke-enabled-toggle");
    fireEvent.click(toggle.querySelector("input")!);
    fireEvent.click(getByRole("button", { name: "Save" }));
    await waitFor(async () => {
      const after = await api.listRules();
      const saved = after.rules.find((r) => r.id === "epics")!;
      expect(saved.idlePokeMinutes).toBe(45);
      expect(saved.idlePokeMessage).toBe("go check your ticket");
      expect(saved.idlePokeEnabled).toBe(false);
    });
  });

  // FACTORY-846 (review round 1): an UNTOUCHED, empty (null-backed) idle-poke
  // field must never be sent on save — the exact "saving pins a seeded
  // value" defect the review flagged. Here only idlePokeEnabled changes, so
  // idlePokeMinutes/idlePokeMessage must stay null (not get pinned to "").
  test("saving only idlePokeEnabled leaves idlePokeMinutes/idlePokeMessage null — an untouched empty field is never sent", async () => {
    const api = createFixturesRulesApi({ initial: { rules: [rule()], errors: [] }, latencyMs: 0 });
    const { findByTestId, getByRole } = render(
      <RuleEditDialog api={api} rule={rule()} sourceEtag="fixture-etag-0" stale={false} canWrite onChanged={() => undefined} onClose={() => undefined} />,
    );
    const toggle = await findByTestId("rule-edit-idle-poke-enabled-toggle");
    fireEvent.click(toggle.querySelector("input")!);
    fireEvent.click(getByRole("button", { name: "Save" }));
    await waitFor(async () => {
      const after = await api.listRules();
      const saved = after.rules.find((r) => r.id === "epics")!;
      expect(saved.idlePokeEnabled).toBe(false);
      expect(saved.idlePokeMinutes).toBeNull();
      expect(saved.idlePokeMessage).toBeNull();
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

  // FACTORY-1010 — the notification-delivery select: channel/prompt save
  // with no confirm step (never risky, same as the idle-poke knobs above),
  // "Default" after an explicit value sends an actual `null` (clearing it,
  // not merely omitting the field), and re-rendering with the reloaded DTO
  // after each save proves the choice is actually persisted/displayed, not
  // just accepted by the mock. Closes the independent review's own
  // "focused interaction test" request.
  test("FACTORY-1010: notification-delivery select saves channel/prompt with no confirm, reverting to Default sends an explicit null, and each step reflects in the reloaded rule", async () => {
    const api = createFixturesRulesApi({ initial: { rules: [rule()], errors: [] }, latencyMs: 0 });

    // starts at "Default" (butchr's own fallback) — the fixture rule never set it
    {
      const { findByTestId, unmount } = render(
        <RuleEditDialog api={api} rule={rule()} sourceEtag="fixture-etag-0" stale={false} canWrite onChanged={() => undefined} onClose={() => undefined} />,
      );
      const select = (await findByTestId("rule-edit-notify-delivery-mode-select")) as HTMLSelectElement;
      expect(select.value).toBe("");
      unmount();
    }

    // Default -> channel, no confirm needed
    let afterChannel = await api.listRules();
    {
      const current = afterChannel.rules.find((r) => r.id === "epics")!;
      const { findByTestId, getByRole, queryByTestId, unmount } = render(
        <RuleEditDialog api={api} rule={current} sourceEtag={afterChannel.sourceEtag} stale={false} canWrite onChanged={() => undefined} onClose={() => undefined} />,
      );
      const select = (await findByTestId("rule-edit-notify-delivery-mode-select")) as HTMLSelectElement;
      fireEvent.change(select, { target: { value: "channel" } });
      fireEvent.click(getByRole("button", { name: "Save" }));
      await waitFor(() => expect(queryByTestId("rule-edit-confirm")).toBeNull());
      await waitFor(async () => {
        afterChannel = await api.listRules();
        expect(afterChannel.rules.find((r) => r.id === "epics")!.notifyDeliveryMode).toBe("channel");
      });
      unmount();
    }

    // reopening reflects the persisted "channel" choice
    {
      const current = afterChannel.rules.find((r) => r.id === "epics")!;
      const { findByTestId, unmount } = render(
        <RuleEditDialog api={api} rule={current} sourceEtag={afterChannel.sourceEtag} stale={false} canWrite onChanged={() => undefined} onClose={() => undefined} />,
      );
      const select = (await findByTestId("rule-edit-notify-delivery-mode-select")) as HTMLSelectElement;
      expect(select.value).toBe("channel");
      unmount();
    }

    // channel -> prompt, no confirm needed
    let afterPrompt = afterChannel;
    {
      const current = afterChannel.rules.find((r) => r.id === "epics")!;
      const { findByTestId, getByRole, queryByTestId, unmount } = render(
        <RuleEditDialog api={api} rule={current} sourceEtag={afterChannel.sourceEtag} stale={false} canWrite onChanged={() => undefined} onClose={() => undefined} />,
      );
      const select = (await findByTestId("rule-edit-notify-delivery-mode-select")) as HTMLSelectElement;
      expect(select.value).toBe("channel");
      fireEvent.change(select, { target: { value: "prompt" } });
      fireEvent.click(getByRole("button", { name: "Save" }));
      await waitFor(() => expect(queryByTestId("rule-edit-confirm")).toBeNull());
      await waitFor(async () => {
        afterPrompt = await api.listRules();
        expect(afterPrompt.rules.find((r) => r.id === "epics")!.notifyDeliveryMode).toBe("prompt");
      });
      unmount();
    }

    // prompt -> Default: an explicit null clear, not merely an omitted field
    {
      const current = afterPrompt.rules.find((r) => r.id === "epics")!;
      const { findByTestId, getByRole, queryByTestId, unmount } = render(
        <RuleEditDialog api={api} rule={current} sourceEtag={afterPrompt.sourceEtag} stale={false} canWrite onChanged={() => undefined} onClose={() => undefined} />,
      );
      const select = (await findByTestId("rule-edit-notify-delivery-mode-select")) as HTMLSelectElement;
      expect(select.value).toBe("prompt");
      fireEvent.change(select, { target: { value: "" } });
      fireEvent.click(getByRole("button", { name: "Save" }));
      await waitFor(() => expect(queryByTestId("rule-edit-confirm")).toBeNull());
      await waitFor(async () => {
        const reloaded = await api.listRules();
        expect(reloaded.rules.find((r) => r.id === "epics")!.notifyDeliveryMode).toBeNull();
      });
      unmount();
    }
  });

  test("FACTORY-1010: an unchanged omitted default sends no notifyDeliveryMode field, and triggers no write at all (no-op save discipline)", async () => {
    const api = createFixturesRulesApi({ initial: { rules: [rule()], errors: [] }, latencyMs: 0 });
    const { findByTestId, getByRole } = render(
      <RuleEditDialog api={api} rule={rule()} sourceEtag="fixture-etag-0" stale={false} canWrite onChanged={() => undefined} onClose={() => undefined} />,
    );
    const select = (await findByTestId("rule-edit-notify-delivery-mode-select")) as HTMLSelectElement;
    expect(select.value).toBe("");
    fireEvent.click(getByRole("button", { name: "Save" })); // nothing touched at all — buildFieldsPatch is empty, handleSave is a no-op
    const before = await api.listRules();
    expect(before.sourceEtag).toBe("fixture-etag-0"); // no write happened — the fixture's own etag only advances on a real write
    expect(before.rules.find((r) => r.id === "epics")!.notifyDeliveryMode).toBeNull();
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
