import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { withDom } from "../setup/happy-dom.js";
import { RulesRoute } from "../../dashboard-app/src/routes/RulesRoute.js";
import { createFixturesRulesApi, defaultRulesFixture, FIRST_RULE_ID, PLACEHOLDER_QUERY, ENABLE_SCOPE_CEILING } from "../../dashboard-app/src/api/rules.js";
import type { RuleDto, RulesListResponse } from "../../dashboard-app/src/api/rules.js";

withDom();
afterEach(cleanup);

function rule(overrides: Partial<RuleDto> = {}): RuleDto {
  return {
    id: "ui-triage",
    resourceProvider: "jira-work",
    query: "project = X",
    enabled: true,
    execution: "swarm",
    account: "none",
    role: "worker",
    agentPreferences: [],
    staffed: true,
    reason: null,
    ...overrides,
  };
}

function response(overrides: Partial<RulesListResponse> = {}): RulesListResponse {
  return { rules: [], errors: [], sourceEtag: "e1", fileEtag: "e1", stale: false, ...overrides };
}

describe("RulesRoute — FACTORY-661: list", () => {
  test("renders one row per rule, with its own id, provider, execution, and staffed text", async () => {
    const api = createFixturesRulesApi({ initial: defaultRulesFixture(), latencyMs: 0 });
    const { findAllByTestId, getByText } = render(<RulesRoute api={api} />);
    const rows = await findAllByTestId("rule-row");
    expect(rows).toHaveLength(4); // factory-triage, stale-github-prs, vip-zendesk, ui-first-rule
    expect(getByText("factory-triage")).toBeTruthy();
    expect(getByText(/execution: singleton/)).toBeTruthy();
    expect(getByText("UNSTAFFED: disabled")).toBeTruthy();
    expect(getByText(/COULD NOT CHECK: census unavailable/)).toBeTruthy();
  });

  test("a validation-problems banner renders when the rules file is invalid, independent of whether any rules also loaded", async () => {
    const data = response({ errors: [{ path: "/home/x/.config/butchr/rules.json", message: "rules[0].id must be a lowercase slug" }] });
    const api = createFixturesRulesApi({ initial: data, latencyMs: 0 });
    const { findByTestId } = render(<RulesRoute api={api} />);
    const banner = await findByTestId("rules-file-errors");
    expect(banner.textContent).toContain("rules[0].id must be a lowercase slug");
    expect(banner.textContent).toContain("rules.json");
  });

  test("empty state (no rules, no errors) explains why and shows a disabled 'Add your first rule' button, alongside the first-rule-missing snippet", async () => {
    const api = createFixturesRulesApi({ initial: response(), latencyMs: 0 });
    const { findByTestId, getByRole } = render(<RulesRoute api={api} />);
    const empty = await findByTestId("rules-empty-state");
    expect(empty.textContent).toContain("No rules file");
    const button = getByRole("button", { name: "Add your first rule" });
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(await findByTestId("first-rule-missing")).toBeTruthy();
  });

  test("the toggle is disabled with a 'needs the write API' explanation when capabilities.write is false (simulating the real implementation before a session check succeeds)", async () => {
    const api = createFixturesRulesApi({ initial: defaultRulesFixture(), latencyMs: 0, sessionOk: false });
    api.capabilities.write = false; // the state before any refreshCapabilities call resolves
    const { findAllByTestId, container } = render(<RulesRoute api={api} />);
    await findAllByTestId("rule-row");
    await waitFor(() => expect(api.capabilities.write).toBe(false)); // refreshCapabilities resolved and confirmed false (sessionOk: false)
    const toggleWrap = container.querySelector(".rules-table__toggle");
    expect(toggleWrap?.getAttribute("title")).toBe("needs the write API");
    const input = container.querySelector('.rules-table__toggle input[type="checkbox"]') as HTMLInputElement | null;
    expect(input?.disabled).toBe(true);
  });
});

describe("RulesRoute — FACTORY-661: preview", () => {
  test("Preview shows the total and each ticket KEY, linked — no summary field anywhere", async () => {
    const api = createFixturesRulesApi({
      initial: response({ rules: [rule({ id: "triage" })] }),
      latencyMs: 0,
      previews: { triage: { ruleId: "triage", total: 2, tickets: [{ key: "FACTORY-1" }, { key: "FACTORY-2" }] } },
    });
    const { findAllByTestId, getByRole, findByTestId, getByText } = render(<RulesRoute api={api} />);
    await findAllByTestId("rule-row");
    fireEvent.click(getByRole("button", { name: "Preview" }));
    const dialog = await findByTestId("rule-preview-dialog");
    expect(dialog).toBeTruthy();
    await waitFor(() => expect(getByText("2 matching tickets")).toBeTruthy());
    const link = getByText("FACTORY-1").closest("a");
    expect(link?.getAttribute("href")).toBe(`/resource/${encodeURIComponent("jira-work:triage:FACTORY-1")}/open`);
    expect(dialog.textContent).not.toContain("summary");
  });

  test("a preview fetch failure shows an error inside the dialog, not a crash", async () => {
    const api = createFixturesRulesApi({ initial: response({ rules: [rule({ id: "triage" })] }), latencyMs: 0 });
    api.previewRule = async () => {
      throw new Error("preview backend down");
    };
    const { findAllByTestId, getByRole, findByText } = render(<RulesRoute api={api} />);
    await findAllByTestId("rule-row");
    fireEvent.click(getByRole("button", { name: "Preview" }));
    expect(await findByText(/could not load preview — preview backend down/)).toBeTruthy();
  });
});

describe("RulesRoute — FACTORY-661/FACTORY-663: toggle + plan-confirm warning", () => {
  test("a toggle whose plan would stop/restart agents shows a confirm dialog naming spawned/stopped/restarted, and does nothing until confirmed", async () => {
    const api = createFixturesRulesApi({
      initial: response({ rules: [rule({ id: "ui-triage", enabled: true })] }),
      latencyMs: 0,
      plans: { "ui-triage": { planHash: "h1", spawned: 0, stopped: 3, restarted: 1, etag: "e1" } },
    });
    const { findAllByTestId, getByRole, findByTestId, getByText } = render(<RulesRoute api={api} />);
    await findAllByTestId("rule-row");
    const toggleInput = document.querySelector('.rules-table__toggle input[type="checkbox"]') as HTMLInputElement;
    fireEvent.click(toggleInput);

    const dialog = await findByTestId("rule-toggle-confirm-dialog");
    expect(dialog.textContent).toContain("this would start 0 agents on real tickets, stop 3, and restart 1");

    // Not yet applied: a fresh poll still reports enabled:true (nothing was written).
    const stillEnabled = await api.listRules();
    expect(stillEnabled.rules[0]!.enabled).toBe(true);

    fireEvent.click(getByRole("button", { name: "confirm" }));
    await waitFor(async () => {
      const after = await api.listRules();
      expect(after.rules[0]!.enabled).toBe(false);
    });
  });

  test("cancelling the confirm dialog leaves the rule unchanged", async () => {
    const api = createFixturesRulesApi({
      initial: response({ rules: [rule({ id: "ui-triage", enabled: true })] }),
      latencyMs: 0,
      plans: { "ui-triage": { planHash: "h1", spawned: 0, stopped: 1, restarted: 0, etag: "e1" } },
    });
    const { findAllByTestId, getByRole, findByTestId, queryByTestId } = render(<RulesRoute api={api} />);
    await findAllByTestId("rule-row");
    fireEvent.click(document.querySelector('.rules-table__toggle input[type="checkbox"]') as HTMLInputElement);
    await findByTestId("rule-toggle-confirm-dialog");
    fireEvent.click(getByRole("button", { name: "cancel" }));
    await waitFor(() => expect(queryByTestId("rule-toggle-confirm-dialog")).toBeNull());
    const after = await api.listRules();
    expect(after.rules[0]!.enabled).toBe(true);
  });

  test("a toggle whose plan reports zero stopped/restarted applies immediately, with no confirm dialog", async () => {
    const api = createFixturesRulesApi({
      initial: response({ rules: [rule({ id: "ui-triage", enabled: false })] }),
      latencyMs: 0,
      plans: { "ui-triage": { planHash: "h1", spawned: 1, stopped: 0, restarted: 0, etag: "e1" } },
    });
    const { findAllByTestId, queryByTestId } = render(<RulesRoute api={api} />);
    await findAllByTestId("rule-row");
    fireEvent.click(document.querySelector('.rules-table__toggle input[type="checkbox"]') as HTMLInputElement);
    await waitFor(async () => {
      const after = await api.listRules();
      expect(after.rules[0]!.enabled).toBe(true);
    });
    expect(queryByTestId("rule-toggle-confirm-dialog")).toBeNull();
  });

  test("a toggle refused by the server (e.g. a non-ui- rule) shows the server's own message in the toggle-error banner", async () => {
    const api = createFixturesRulesApi({
      initial: response({ rules: [rule({ id: "factory-triage", enabled: true })] }),
      latencyMs: 0,
      plans: { "factory-triage": { planHash: "h1", spawned: 0, stopped: 0, restarted: 0, etag: "e1" } },
    });
    const { findAllByTestId, findByTestId } = render(<RulesRoute api={api} />);
    await findAllByTestId("rule-row");
    fireEvent.click(document.querySelector('.rules-table__toggle input[type="checkbox"]') as HTMLInputElement);
    const banner = await findByTestId("rule-toggle-error");
    expect(banner.textContent).toContain('does not carry the "ui-" prefix');
  });
});

describe("RulesRoute — FACTORY-663: Set up your first rule", () => {
  test("shows the JSON snippet + path + copy button when ui-first-rule is missing, with no write call ever attempted", async () => {
    const api = createFixturesRulesApi({ initial: response({ rules: [rule({ id: "ui-triage" })] }), latencyMs: 0 });
    let wrote = false;
    api.setEnabled = async (...args) => {
      wrote = true;
      throw new Error("should never be called");
    };
    const { findByTestId } = render(<RulesRoute api={api} />);
    const section = await findByTestId("first-rule-missing");
    expect(section.textContent).toContain(FIRST_RULE_ID);
    const snippet = await findByTestId("first-rule-snippet");
    expect(snippet.textContent).toContain(FIRST_RULE_ID);
    expect(snippet.textContent).toContain(PLACEHOLDER_QUERY);
    expect(wrote).toBe(false);
  });

  test("shows the guided form when ui-first-rule is present, and saving a new query succeeds with zero blast radius (no confirm)", async () => {
    const api = createFixturesRulesApi({ initial: defaultRulesFixture(), latencyMs: 0 });
    const { findByTestId, findAllByTestId } = render(<RulesRoute api={api} />);
    await findAllByTestId("rule-row");
    const section = await findByTestId("first-rule-setup");
    expect(section).toBeTruthy();

    const input = (await findByTestId("first-rule-query-input")) as HTMLInputElement;
    fireEvent.input(input, { target: { value: "key = XYZ-1" } });
    const saveButtons = section.querySelectorAll("button");
    const saveButton = Array.from(saveButtons).find((b) => b.textContent === "save query")!;
    fireEvent.click(saveButton);

    await waitFor(async () => {
      const after = await api.listRules();
      expect(after.rules.find((r) => r.id === FIRST_RULE_ID)!.query).toBe("key = XYZ-1");
    });
    expect(await findByTestId("first-rule-undo")).toBeTruthy();
  });

  test("picking a starter example fills the query field", async () => {
    const api = createFixturesRulesApi({ initial: defaultRulesFixture(), latencyMs: 0 });
    const { findByTestId, getByText } = render(<RulesRoute api={api} />);
    await findByTestId("first-rule-setup");
    fireEvent.click(getByText("one specific ticket"));
    const input = (await findByTestId("first-rule-query-input")) as HTMLInputElement;
    expect(input.value).toBe("key = XYZ-1");
  });

  test("enabling while the query is still the placeholder shows the server's refusal message plainly", async () => {
    const api = createFixturesRulesApi({ initial: defaultRulesFixture(), latencyMs: 0 });
    const { findByTestId, getByRole } = render(<RulesRoute api={api} />);
    await findByTestId("first-rule-setup");
    fireEvent.click(getByRole("button", { name: "Enable" }));
    const error = await findByTestId("first-rule-error");
    expect(error.textContent).toContain("cannot be enabled while its query is still the placeholder");
  });

  test("enabling over the scope ceiling shows a confirm step naming the scope, and only writes once confirmed", async () => {
    const seeded = defaultRulesFixture();
    const idx = seeded.rules.findIndex((r) => r.id === FIRST_RULE_ID);
    seeded.rules[idx] = { ...seeded.rules[idx]!, query: "project = FACTORY" };
    const api = createFixturesRulesApi({
      initial: seeded,
      latencyMs: 0,
      plans: { [FIRST_RULE_ID]: { planHash: "plan-1", spawned: 1, stopped: 0, restarted: 0, etag: "e", scopeCount: ENABLE_SCOPE_CEILING + 5 } },
    });
    const { findByTestId, getByRole } = render(<RulesRoute api={api} />);
    await findByTestId("first-rule-setup");
    fireEvent.click(getByRole("button", { name: "Enable" }));
    const confirm = await findByTestId("first-rule-confirm");
    expect(confirm.textContent).toContain(`scope ${ENABLE_SCOPE_CEILING + 5} tickets`);

    const stillDisabled = await api.listRules();
    expect(stillDisabled.rules.find((r) => r.id === FIRST_RULE_ID)!.enabled).toBe(false);

    fireEvent.click(getByRole("button", { name: "confirm" }));
    await waitFor(async () => {
      const after = await api.listRules();
      expect(after.rules.find((r) => r.id === FIRST_RULE_ID)!.enabled).toBe(true);
    });
  });

  test("stale: true disables every first-rule control and shows the reload-pending notice", async () => {
    const api = createFixturesRulesApi({ initial: { ...defaultRulesFixture(), stale: true }, latencyMs: 0 });
    const { findByTestId } = render(<RulesRoute api={api} />);
    const stale = await findByTestId("first-rule-stale");
    expect(stale.textContent).toContain("reload pending");
    const input = (await findByTestId("first-rule-query-input")) as HTMLInputElement;
    expect(input.disabled).toBe(true);
  });

  test("undo reverts the most recent write", async () => {
    const api = createFixturesRulesApi({ initial: defaultRulesFixture(), latencyMs: 0 });
    const { findByTestId, getByRole, queryByTestId } = render(<RulesRoute api={api} />);
    await findByTestId("first-rule-setup");
    const input = (await findByTestId("first-rule-query-input")) as HTMLInputElement;
    fireEvent.input(input, { target: { value: "key = XYZ-1" } });
    fireEvent.click(getByRole("button", { name: "save query" }));
    const undoButton = await findByTestId("first-rule-undo");
    fireEvent.click(undoButton);
    await waitFor(async () => {
      const after = await api.listRules();
      expect(after.rules.find((r) => r.id === FIRST_RULE_ID)!.query).toBe(PLACEHOLDER_QUERY);
    });
    expect(queryByTestId("first-rule-undo")).toBeNull();
  });
});

describe("RulesRoute — FACTORY-661/FACTORY-663: CSP/escaping (agentsafety review 2026-10-05 item d)", () => {
  test("a script-tag and an onerror-image payload in id/query/agentPreferences render as inert text, never as markup", async () => {
    const scriptPayload = '<script>window.__pwned = true</script>';
    const imgPayload = '"><img src=x onerror=window.__pwned=true>';
    const api = createFixturesRulesApi({
      initial: response({
        rules: [
          rule({
            id: scriptPayload,
            query: imgPayload,
            agentPreferences: [{ harness: "claude", model: imgPayload }],
          }),
        ],
      }),
      latencyMs: 0,
    });
    const { findAllByTestId, container } = render(<RulesRoute api={api} />);
    await findAllByTestId("rule-row");

    expect(container.querySelector("script")).toBeNull();
    const img = container.querySelector("img");
    expect(img).toBeNull();
    expect((globalThis as { __pwned?: boolean }).__pwned).toBeUndefined();

    expect(container.textContent).toContain(scriptPayload);
    expect(container.textContent).toContain(imgPayload);
  });

  test("a script-tag payload in ui-first-rule's own query renders as inert text in the guided form's missing-template snippet and input value", async () => {
    const scriptPayload = '<script>window.__pwned2 = true</script>';
    const api = createFixturesRulesApi({
      initial: response({ rules: [rule({ id: FIRST_RULE_ID, query: scriptPayload, enabled: false })] }),
      latencyMs: 0,
    });
    const { findByTestId, container } = render(<RulesRoute api={api} />);
    const input = (await findByTestId("first-rule-query-input")) as HTMLInputElement;
    expect(input.value).toBe(scriptPayload);
    expect(container.querySelector("script")).toBeNull();
    expect((globalThis as { __pwned2?: boolean }).__pwned2).toBeUndefined();
  });
});
