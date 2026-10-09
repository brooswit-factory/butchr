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
    permissionMode: null,
    lizardMode: null,
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
      plans: { "ui-triage": { planHash: "h1", spawned: 0, stopped: 3, restarted: 1, etag: "e1", requiresConfirm: true, confirmReason: "stop-restart" } },
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
      plans: { "ui-triage": { planHash: "h1", spawned: 0, stopped: 1, restarted: 0, etag: "e1", requiresConfirm: true, confirmReason: "stop-restart" } },
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

  test("a toggle whose plan reports zero stopped/restarted and requiresConfirm:false applies immediately, with no confirm dialog", async () => {
    // execution: "singleton" — FACTORY-685 (item 2/3) now requires a
    // confirm dialog on ANY swarm enable regardless of blast radius; this
    // test's own point (a truly zero-blast-radius change applies with no
    // dialog, trusting the server's own requiresConfirm) needs a rule the
    // new gate does not apply to.
    const api = createFixturesRulesApi({
      initial: response({ rules: [rule({ id: "ui-triage", enabled: false, execution: "singleton" })] }),
      latencyMs: 0,
      plans: { "ui-triage": { planHash: "h1", spawned: 1, stopped: 0, restarted: 0, etag: "e1", requiresConfirm: false } },
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

  // FACTORY-730: the real server's route-level `ui-`-prefix gate is retired
  // — a non-`ui-` row's toggle is no longer disabled client-side (contrast
  // the FACTORY-663 review follow-up this test used to exercise), and a
  // plain click reaches the server and succeeds.
  test("FACTORY-730: a non-ui- row's toggle is enabled and clicking it flips the rule", async () => {
    // execution: "singleton" (and starting DISABLED, so the click is an
    // enable with spawned=1/stopped=0/restarted=0) — a genuinely
    // zero-blast-radius transition, same discipline the FACTORY-685 comment
    // on the pre-existing toggle test above this describe block documents:
    // a swarm rule's enable needs confirm at ANY scope, which would make
    // `requiresConfirm: false` below an unrealistic plan for THIS test's
    // own point (a plain click reaching the server and succeeding with no
    // confirm step at all).
    const api = createFixturesRulesApi({
      initial: response({ rules: [rule({ id: "factory-triage", enabled: false, execution: "singleton" })] }),
      latencyMs: 0,
      plans: { "factory-triage": { planHash: "h1", spawned: 1, stopped: 0, restarted: 0, etag: "e1", requiresConfirm: false } },
    });
    const { findAllByTestId, container } = render(<RulesRoute api={api} />);
    await findAllByTestId("rule-row");
    await waitFor(() => expect(api.capabilities.write).toBe(true));
    const toggle = container.querySelector('.rules-table__toggle input[type="checkbox"]') as HTMLInputElement;
    expect(toggle.disabled).toBe(false);
    fireEvent.click(toggle);
    await waitFor(async () => {
      const after = await api.listRules();
      expect(after.rules.find((r) => r.id === "factory-triage")!.enabled).toBe(true);
    });
  });

  test("FACTORY-730: the toggle carries no special tooltip for a non-ui- rule when writes are otherwise enabled", async () => {
    const api = createFixturesRulesApi({
      initial: response({ rules: [rule({ id: "factory-triage", enabled: true })] }),
      latencyMs: 0,
    });
    const { findAllByTestId, container } = render(<RulesRoute api={api} />);
    await findAllByTestId("rule-row");
    await waitFor(() => expect(api.capabilities.write).toBe(true));
    const toggleWrap = container.querySelector(".rules-table__toggle");
    expect(toggleWrap?.getAttribute("title")).toBeNull();
    const input = container.querySelector('.rules-table__toggle input[type="checkbox"]') as HTMLInputElement | null;
    expect(input?.disabled).toBe(false);
  });

  test("the toggle stays enabled and clickable for ui-first-rule (and other ui- ids) once writes are enabled", async () => {
    // execution: "singleton" — this test's own point is the toggle's
    // enabled/disabled state and that a click applies, not the FACTORY-685
    // swarm-confirm gate (covered separately above and in its own describe
    // block).
    const api = createFixturesRulesApi({
      initial: response({ rules: [rule({ id: "ui-triage", enabled: false, execution: "singleton" })] }),
      latencyMs: 0,
      plans: { "ui-triage": { planHash: "h1", spawned: 1, stopped: 0, restarted: 0, etag: "e1", requiresConfirm: false } },
    });
    const { findAllByTestId, container } = render(<RulesRoute api={api} />);
    await findAllByTestId("rule-row");
    await waitFor(() => expect(api.capabilities.write).toBe(true));
    const toggleWrap = container.querySelector(".rules-table__toggle");
    expect(toggleWrap?.getAttribute("title")).toBeNull();
    const input = container.querySelector('.rules-table__toggle input[type="checkbox"]') as HTMLInputElement;
    expect(input.disabled).toBe(false);
    fireEvent.click(input);
    await waitFor(async () => {
      const after = await api.listRules();
      expect(after.rules[0]!.enabled).toBe(true);
    });
  });

  describe("FACTORY-685 (item 2/3): confirm dialog on ANY swarm enable, naming the ticket keys", () => {
    test("GO-RED: enabling a disabled SWARM rule at a tiny scope (well under the ceiling) still shows the confirm dialog, naming 'This will staff up to N tickets' and the actual keys", async () => {
      const api = createFixturesRulesApi({
        initial: response({ rules: [rule({ id: "ui-triage", enabled: false, execution: "swarm" })] }),
        latencyMs: 0,
        previews: { "ui-triage": { ruleId: "ui-triage", total: 2, tickets: [{ key: "FACTORY-1" }, { key: "FACTORY-2" }] } },
        // No `plans` override — the fixture computes requiresConfirm/confirmReason itself (FACTORY-685's own swarm-enable gate), same as the real server would.
      });
      const { findAllByTestId, findByTestId } = render(<RulesRoute api={api} />);
      await findAllByTestId("rule-row");
      fireEvent.click(document.querySelector('.rules-table__toggle input[type="checkbox"]') as HTMLInputElement);

      const dialog = await findByTestId("rule-toggle-confirm-dialog");
      expect(dialog.textContent).toContain("This will staff up to 2 tickets: FACTORY-1, FACTORY-2");

      // Still unapplied until confirmed.
      const stillDisabled = await api.listRules();
      expect(stillDisabled.rules[0]!.enabled).toBe(false);
    });

    test("a SINGLETON rule's enable at the same scope shows NO confirm dialog — this gate is swarm-specific", async () => {
      const api = createFixturesRulesApi({
        initial: response({ rules: [rule({ id: "ui-triage", enabled: false, execution: "singleton" })] }),
        latencyMs: 0,
        previews: { "ui-triage": { ruleId: "ui-triage", total: 2, tickets: [{ key: "FACTORY-1" }, { key: "FACTORY-2" }] } },
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
  });
});

describe("RulesRoute — FACTORY-730: edit an existing rule from the Rules page", () => {
  test("clicking Edit on a non-ui- row opens RuleEditDialog prefilled with that rule's own query", async () => {
    const api = createFixturesRulesApi({
      initial: response({ rules: [rule({ id: "epics", query: "project = FACTORY AND type = Epic" })] }),
      latencyMs: 0,
    });
    const { findAllByTestId, findByTestId, getAllByRole } = render(<RulesRoute api={api} />);
    await findAllByTestId("rule-row");
    const editButton = getAllByRole("button", { name: "Edit" })[0]!;
    fireEvent.click(editButton);
    const dialog = await findByTestId("rule-edit-dialog");
    expect(dialog.textContent).toContain("epics");
    const input = (await findByTestId("rule-edit-query-input")) as HTMLInputElement;
    expect(input.value).toBe("project = FACTORY AND type = Epic");
  });

  test("closing the dialog removes it from the DOM", async () => {
    const api = createFixturesRulesApi({
      initial: response({ rules: [rule({ id: "epics" })] }),
      latencyMs: 0,
    });
    const { findAllByTestId, findByTestId, queryByTestId, getAllByRole, getByRole } = render(<RulesRoute api={api} />);
    await findAllByTestId("rule-row");
    fireEvent.click(getAllByRole("button", { name: "Edit" })[0]!);
    await findByTestId("rule-edit-dialog");
    fireEvent.click(getByRole("button", { name: "close" }));
    expect(queryByTestId("rule-edit-dialog")).toBeNull();
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

  // FACTORY-730 (review round 2): ANY query change now requires a
  // server-enforced confirm (the dry-run scope count) — this is no longer
  // a zero-blast-radius save, even for a disabled rule whose query was
  // still the placeholder. The confirm step's own count comes from the
  // fixture's default (no `previewsByQuery` override): 0 tickets.
  test("shows the guided form when ui-first-rule is present, and saving a new query shows a confirm step (the new-query scope count) before it succeeds", async () => {
    const api = createFixturesRulesApi({ initial: defaultRulesFixture(), latencyMs: 0 });
    const { findByTestId, findAllByTestId, getByRole } = render(<RulesRoute api={api} />);
    await findAllByTestId("rule-row");
    const section = await findByTestId("first-rule-setup");
    expect(section).toBeTruthy();

    const input = (await findByTestId("first-rule-query-input")) as HTMLInputElement;
    fireEvent.input(input, { target: { value: "key = XYZ-1" } });
    const saveButtons = section.querySelectorAll("button");
    const saveButton = Array.from(saveButtons).find((b) => b.textContent === "save query")!;
    fireEvent.click(saveButton);

    const confirm = await findByTestId("first-rule-confirm");
    expect(confirm.textContent).toContain("scope 0 ticket");
    fireEvent.click(getByRole("button", { name: "confirm" }));

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
      plans: { [FIRST_RULE_ID]: { planHash: "plan-1", spawned: 1, stopped: 0, restarted: 0, etag: "e", scopeCount: ENABLE_SCOPE_CEILING + 5, requiresConfirm: true, confirmReason: "scope-ceiling" } },
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

  test("GO-RED (FACTORY-685, item 2/3): enabling ui-first-rule at a tiny scope (well under the ceiling) STILL shows a confirm step, naming 'This will staff up to N tickets' and the actual keys — not an immediate apply", async () => {
    const seeded = defaultRulesFixture();
    const idx = seeded.rules.findIndex((r) => r.id === FIRST_RULE_ID);
    seeded.rules[idx] = { ...seeded.rules[idx]!, query: "project = FACTORY" }; // past the placeholder; execution stays "swarm" (the seeded default)
    const api = createFixturesRulesApi({
      initial: seeded,
      latencyMs: 0,
      previews: { [FIRST_RULE_ID]: { ruleId: FIRST_RULE_ID, total: 2, tickets: [{ key: "FACTORY-10" }, { key: "FACTORY-11" }] } },
      // No `plans` override — the fixture computes requiresConfirm/confirmReason ("swarm-enable") itself, exactly as the real server now would.
    });
    const { findByTestId, getByRole } = render(<RulesRoute api={api} />);
    await findByTestId("first-rule-setup");
    fireEvent.click(getByRole("button", { name: "Enable" }));
    const confirm = await findByTestId("first-rule-confirm");
    expect(confirm.textContent).toContain("This will staff up to 2 tickets: FACTORY-10, FACTORY-11");

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
    // FACTORY-730 (review round 2): ANY query change now requires confirm.
    await findByTestId("first-rule-confirm");
    fireEvent.click(getByRole("button", { name: "confirm" }));
    const undoButton = await findByTestId("first-rule-undo");
    fireEvent.click(undoButton);
    await waitFor(async () => {
      const after = await api.listRules();
      expect(after.rules.find((r) => r.id === FIRST_RULE_ID)!.query).toBe(PLACEHOLDER_QUERY);
    });
    expect(queryByTestId("first-rule-undo")).toBeNull();
  });

  // FACTORY-678 (landing soon, not yet merged): a server-side write rate
  // limit will return 429 with a `Retry-After` header on this route. Not
  // testable end-to-end today (nothing emits a real 429 yet) — these use
  // the fixture's own one-shot `nextRateLimit` simulation, forward-
  // compatible handling ahead of that server change landing.
  test("a write refused with a Retry-After value shows an actionable 'try again in Ns' message, not the raw error text", async () => {
    const api = createFixturesRulesApi({ initial: defaultRulesFixture(), latencyMs: 0, nextRateLimit: { retryAfterSeconds: 6 } });
    const { findByTestId, getByRole } = render(<RulesRoute api={api} />);
    await findByTestId("first-rule-setup");
    const input = (await findByTestId("first-rule-query-input")) as HTMLInputElement;
    fireEvent.input(input, { target: { value: "key = XYZ-1" } });
    fireEvent.click(getByRole("button", { name: "save query" }));
    // FACTORY-730 (review round 2): ANY query change now requires confirm;
    // the simulated rate limit only fires on the real write, not the plan.
    await findByTestId("first-rule-confirm");
    fireEvent.click(getByRole("button", { name: "confirm" }));
    const error = await findByTestId("first-rule-error");
    expect(error.textContent).toContain("Too many changes — try again in 6s");
  });

  test("a write refused with no Retry-After value falls back to the generic verbatim error message", async () => {
    const api = createFixturesRulesApi({ initial: defaultRulesFixture(), latencyMs: 0, nextRateLimit: {} });
    const { findByTestId, getByRole } = render(<RulesRoute api={api} />);
    await findByTestId("first-rule-setup");
    const input = (await findByTestId("first-rule-query-input")) as HTMLInputElement;
    fireEvent.input(input, { target: { value: "key = XYZ-1" } });
    fireEvent.click(getByRole("button", { name: "save query" }));
    // FACTORY-730 (review round 2): ANY query change now requires confirm;
    // the simulated rate limit only fires on the real write, not the plan.
    await findByTestId("first-rule-confirm");
    fireEvent.click(getByRole("button", { name: "confirm" }));
    const error = await findByTestId("first-rule-error");
    expect(error.textContent).toContain("too many changes — rate limited, retry shortly");
    expect(error.textContent).not.toContain("Too many changes — try again in");
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
    // FACTORY-729: `FirstRuleSetup` now fetches `GET /api/rules/catalog` on
    // mount (its own `useEffect`) — a second async hop beyond this test's
    // own `findByTestId` wait. This is the LAST test in the file: with
    // nothing else to await, `afterAll`'s `GlobalRegistrator.unregister()`
    // (`../setup/happy-dom.js`) can tear down `window` before React's own
    // scheduler (a `MessageChannel`-posted task, not a plain microtask) has
    // flushed the state update that promise resolution triggers — the
    // macrotask that flushes it then throws `window is not defined`. A bare
    // `setTimeout(resolve, 0)` was NOT enough (still raced it); 50ms reliably
    // gives that scheduler task room to run before the file's own teardown.
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
});
