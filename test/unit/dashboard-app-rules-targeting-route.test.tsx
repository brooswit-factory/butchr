/**
 * local/ui — the Rules page (`RulesTargetingRoute`), driven
 * through the DOM against the in-memory fixtures API.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { Link, MemoryRouter, Route, Routes, useNavigate } from "react-router";
import { withDom } from "../setup/happy-dom.js";
import { createFixturesRulesApi, FIXTURE_BUILTIN_BRIEFS, type RuleDto } from "../../dashboard-app/src/api/rules.js";
import { forgetKeptRulesDrafts, RulesTargetingRoute, rulesPageReducer, saveBlockedReason, type RulesPageState } from "../../dashboard-app/src/routes/RulesTargetingRoute.js";
import { unstaffedReason } from "../../dashboard-app/src/components/rules-targeting/RuleCard.js";
import { describeDraft } from "../../dashboard-app/src/components/rules-targeting/SaveBar.js";
import { newDraftKey, summarizeDraft } from "../../dashboard-app/src/view-model/rules-draft.js";

withDom();
afterEach(() => {
  cleanup();
  forgetKeptRulesDrafts();
});

function rule(overrides: Partial<RuleDto> = {}): RuleDto {
  return {
    id: "triage",
    resourceProvider: "jira-work",
    query: "project = A",
    enabled: false,
    execution: "swarm",
    role: "worker",
    agentPreferences: [{ harness: "claude", model: "claude-opus-5" }],
    permissionMode: null,
    lizardMode: null,
    resumeOnRespawn: null,
    idlePokeMinutes: null,
    idlePokeMessage: null,
    idlePokeEnabled: true,
    notifyDeliveryMode: null,
    staffed: false,
    reason: "disabled",
    briefExcerpt: "@builtin:task",
    ...overrides,
  };
}

function mount(rules: RuleDto[], opts: Parameters<typeof createFixturesRulesApi>[0] = {}) {
  const api = createFixturesRulesApi({ initial: { rules, errors: [] }, latencyMs: 0, ...opts });
  const view = render(
    <MemoryRouter initialEntries={["/rules"]}>
      <RulesTargetingRoute api={api} />
    </MemoryRouter>,
  );
  return { api, ...view };
}

async function cardFor(view: ReturnType<typeof render>, name: string) {
  return within(await view.findByRole("article", { name: `rule ${name}` }));
}

function setText(input: HTMLElement, value: string) {
  fireEvent.input(input, { target: { value } });
  fireEvent.change(input, { target: { value } });
}

/** The query box is a (lazy-loaded) CodeMirror editor: wait for it, then replace its document the way typing would. */
async function setQuery(card: ReturnType<typeof within>, value: string) {
  const content = await card.findByTestId("rule-query-input");
  const editor = EditorView.findFromDOM(content.closest(".cm-editor") as HTMLElement);
  if (!editor) throw new Error("query editor not mounted");
  act(() => {
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value } });
  });
}

async function queryText(card: ReturnType<typeof within>): Promise<string> {
  const content = await card.findByTestId("rule-query-input");
  return EditorView.findFromDOM(content.closest(".cm-editor") as HTMLElement)!.state.doc.toString();
}

/** Opens a LaunchPad Select by its wrapper's test id and picks an option. */
async function choose(view: ReturnType<typeof render>, scope: ReturnType<typeof within>, testId: string, option: RegExp) {
  fireEvent.click(scope.getByTestId(testId).querySelector("button")!);
  fireEvent.click(await view.findByRole("option", { name: option }));
}

describe("RulesTargetingRoute", () => {
  test("renders one card per rule with its summary and live status, and nothing to save", async () => {
    const view = mount([rule(), rule({ id: "live", enabled: true, staffed: true, reason: null, lizardMode: true })]);
    const triage = await cardFor(view, "triage");
    expect(triage.getByTestId("rule-summary").textContent).toContain("project = A");
    expect(triage.getByText("Not staffed")).toBeTruthy();
    const live = await cardFor(view, "live");
    expect(live.getByText("Staffed")).toBeTruthy();
    expect(live.getByText("lizard mode")).toBeTruthy();
    expect(view.getByTestId("rules-save-bar").textContent).toContain("No unsaved changes");
    expect((view.getByTestId("rules-review-save") as HTMLButtonElement).disabled).toBe(true);
  });

  test("the leave-page warning stays on from another page while the kept draft is unsaved, and goes once it's saved or discarded", async () => {
    const api = createFixturesRulesApi({ initial: { rules: [rule()], errors: [] }, latencyMs: 0, previewsByQuery: { "triage:project = B": { ruleId: "triage", total: 1, tickets: [] } } });
    const view = render(
      <MemoryRouter initialEntries={["/rules"]}>
        <nav>
          <Link to="/agents" data-testid="nav-agents">Agents</Link>
          <Link to="/rules" data-testid="nav-rules">Rules</Link>
        </nav>
        <Routes>
          <Route path="/rules" element={<RulesTargetingRoute api={api} />} />
          <Route path="/agents" element={<p data-testid="agents-page">agents</p>} />
        </Routes>
      </MemoryRouter>,
    );
    const leaveIsBlocked = () => {
      const ev = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(ev);
      return ev.defaultPrevented;
    };
    const edit = async (query: string) => {
      const card = await cardFor(view, "triage");
      await waitFor(() => expect((card.getByTestId("rule-edit") as HTMLButtonElement).disabled).toBe(false));
      fireEvent.click(card.getByTestId("rule-edit"));
      await setQuery(card, query);
      await waitFor(() => expect(card.getByTestId("rule-status-tag").textContent).toBe("Modified"));
    };
    const toAgents = async () => {
      fireEvent.click(view.getByTestId("nav-agents"));
      await view.findByTestId("agents-page");
    };
    const toRules = async () => {
      fireEvent.click(view.getByTestId("nav-rules"));
      await view.findByTestId("rules-save-bar");
    };

    expect(leaveIsBlocked()).toBe(false);
    await edit("project = B");
    await toAgents();
    expect(leaveIsBlocked()).toBe(true); // the Rules page is gone, its unsaved draft isn't

    await toRules();
    fireEvent.click(view.getByTestId("rules-undo-all"));
    fireEvent.click(within(await view.findByTestId("rules-discard-dialog")).getByTestId("rules-discard-confirm"));
    await waitFor(() => expect(view.getByTestId("rules-save-bar").textContent).toContain("No unsaved changes"));
    await toAgents();
    expect(leaveIsBlocked()).toBe(false);

    await toRules();
    await edit("project = B");
    fireEvent.click(view.getByTestId("rules-review-save"));
    fireEvent.click(within(await view.findByTestId("rules-review-dialog")).getByTestId("rules-save-confirm"));
    await waitFor(() => expect(view.getByTestId("rules-save-bar").textContent).toContain("No unsaved changes"));
    await toAgents();
    expect(leaveIsBlocked()).toBe(false);
  });

  test("unsaved edits survive going to another page and coming back, through a nav link and through Back", async () => {
    const api = createFixturesRulesApi({ initial: { rules: [rule()], errors: [] }, latencyMs: 0 });
    function BackButton() {
      const navigate = useNavigate();
      return <button type="button" data-testid="go-back" onClick={() => void navigate(-1)}>Back</button>;
    }
    const view = render(
      <MemoryRouter initialEntries={["/rules"]}>
        <nav>
          <Link to="/agents" data-testid="nav-agents">Agents</Link>
          <Link to="/rules" data-testid="nav-rules">Rules</Link>
          <BackButton />
        </nav>
        <Routes>
          <Route path="/rules" element={<RulesTargetingRoute api={api} />} />
          <Route path="/agents" element={<p data-testid="agents-page">agents</p>} />
        </Routes>
      </MemoryRouter>,
    );
    const card = await cardFor(view, "triage");
    await waitFor(() => expect((card.getByTestId("rule-edit") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(card.getByTestId("rule-edit"));
    await setQuery(card, "project = KEPT");
    await waitFor(() => expect(card.getByTestId("rule-status-tag").textContent).toBe("Modified"));

    fireEvent.click(view.getByTestId("nav-agents"));
    await view.findByTestId("agents-page");
    fireEvent.click(view.getByTestId("nav-rules"));
    await waitFor(() => expect(view.getByTestId("rules-save-bar").textContent).toContain("1 rule with unsaved changes (1 edited)"));
    expect((await cardFor(view, "triage")).getByTestId("rule-status-tag").textContent).toBe("Modified");

    fireEvent.click(view.getByTestId("nav-agents"));
    await view.findByTestId("agents-page");
    fireEvent.click(view.getByTestId("go-back"));
    await waitFor(() => expect(view.getByTestId("rules-save-bar").textContent).toContain("1 rule with unsaved changes (1 edited)"));
  });

  test("edit a query inline, review what it matches, and save it", async () => {
    const { api, ...view } = mount([rule()], { previewsByQuery: { "triage:project = B": { ruleId: "triage", total: 4, tickets: [] } } });
    const card = await cardFor(view, "triage");
    await waitFor(() => expect((card.getByTestId("rule-edit") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(card.getByTestId("rule-edit"));
    await setQuery(card, "project = B");
    await waitFor(() => expect(card.getByTestId("rule-status-tag").textContent).toBe("Modified"));
    expect(view.getByTestId("rules-save-bar").textContent).toContain("1 rule with unsaved changes (1 edited)");

    fireEvent.click(view.getByTestId("rules-review-save"));
    const dialog = within(await view.findByTestId("rules-review-dialog"));
    await waitFor(() => expect(dialog.getByText("The new query matches 4 tickets.")).toBeTruthy());
    expect(dialog.getByText("project = B")).toBeTruthy();
    fireEvent.click(dialog.getByTestId("rules-save-confirm"));

    await waitFor(() => expect(view.getByTestId("rules-save-result").textContent).toContain("Saved 1 change."));
    expect((await api.listRules()).rules[0]?.query).toBe("project = B");
    await waitFor(() => expect(view.getByTestId("rules-save-bar").textContent).toContain("No unsaved changes"));
  });

  test("add a rule from the + menu, complete it, and save it (created off)", async () => {
    const { api, ...view } = mount([rule()]);
    await cardFor(view, "triage");
    await waitFor(() => expect((view.getByTestId("add-rule") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(view.getByTestId("add-rule"));
    fireEvent.click(await view.findByRole("menuitem", { name: /GitHub pull requests/ }));

    const card = await cardFor(view, "new rule");
    expect(card.getByTestId("rule-status-tag").textContent).toBe("New");
    expect(view.getByTestId("rules-save-blocked").textContent).toBe("Complete the highlighted rules to save.");
    setText(card.getByTestId("rule-id-input"), "Bad Id");
    await waitFor(() => expect(view.getByTestId("rules-save-blocked").textContent).toBe("Fix the errors in the highlighted rules to save."));
    setText(card.getByTestId("rule-id-input"), "prs");
    await setQuery(card, "is:open");
    await waitFor(() => expect(view.queryByTestId("rules-save-blocked")).toBeNull());

    fireEvent.click(view.getByTestId("rules-review-save"));
    const dialog = within(await view.findByTestId("rules-review-dialog"));
    await waitFor(() => expect(dialog.getByText(/New rules are saved off/)).toBeTruthy());
    fireEvent.click(dialog.getByTestId("rules-save-confirm"));
    await waitFor(() => expect(view.getByTestId("rules-save-result").textContent).toContain("prs was created off"));
    const saved = (await api.listRules()).rules.find((r) => r.id === "prs");
    expect(saved).toMatchObject({ resourceProvider: "github-pr", query: "is:open", enabled: false });
    await cardFor(view, "prs");
  });

  test("✕ on an edited card asks first, then puts the rule back", async () => {
    const view = mount([rule()]);
    const card = await cardFor(view, "triage");
    await waitFor(() => expect((card.getByTestId("rule-edit") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(card.getByTestId("rule-edit"));
    await setQuery(card, "project = Q");
    fireEvent.click(card.getByTestId("rule-discard"));
    const dialog = within(await view.findByTestId("rules-discard-dialog"));
    expect(dialog.getByText("project = Q")).toBeTruthy();
    fireEvent.click(dialog.getByTestId("rules-discard-confirm"));
    await waitFor(() => expect(view.getByTestId("rules-save-bar").textContent).toContain("No unsaved changes"));
    expect((await cardFor(view, "triage")).getByTestId("rule-summary").textContent).toContain("project = A");
  });

  test("Undo changes discards everything after confirming; a blank new rule's ✕ just removes it", async () => {
    const view = mount([rule()]);
    await cardFor(view, "triage");
    await waitFor(() => expect((view.getByTestId("add-rule") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(view.getByTestId("add-rule"));
    fireEvent.click(await view.findByRole("menuitem", { name: /Jira tickets/ }));
    fireEvent.click((await cardFor(view, "new rule")).getByTestId("rule-discard"));
    await waitFor(() => expect(view.queryByRole("article", { name: "rule new rule" })).toBeNull());

    const card = await cardFor(view, "triage");
    fireEvent.click(card.getByTestId("rule-enabled-switch").querySelector("input")!);
    await waitFor(() => expect(view.getByTestId("rules-undo-all")).toBeTruthy());
    fireEvent.click(view.getByTestId("rules-undo-all"));
    fireEvent.click(within(await view.findByTestId("rules-discard-dialog")).getByTestId("rules-discard-confirm"));
    await waitFor(() => expect(view.getByTestId("rules-save-bar").textContent).toContain("No unsaved changes"));
  });

  test("delete marks the card until saved, and can be undone", async () => {
    const view = mount([rule()]);
    const card = await cardFor(view, "triage");
    await waitFor(() => expect((card.getByTestId("rule-edit") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(card.getByRole("button", { name: "More actions for triage" }));
    fireEvent.click(await view.findByRole("menuitem", { name: /Delete rule/ }));
    await waitFor(() => expect(card.getByTestId("rule-status-tag").textContent).toBe("Will be deleted"));
    expect(card.getByText("This rule will be deleted when you save.")).toBeTruthy();
    fireEvent.click(card.getByTestId("rule-undo-delete"));
    await waitFor(() => expect(card.queryByTestId("rule-status-tag")).toBeNull());
  });

  test("Test query previews a saved Jira rule's draft query", async () => {
    const view = mount([rule()], { previewsByQuery: { "triage:project = B": { ruleId: "triage", total: 2, tickets: [{ key: "B-1" }, { key: "B-2" }] } } });
    const card = await cardFor(view, "triage");
    await waitFor(() => expect((card.getByTestId("rule-edit") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(card.getByTestId("rule-edit"));
    await setQuery(card, "project = B");
    fireEvent.click(card.getByTestId("rule-test-query"));
    await waitFor(() => expect(card.getByTestId("rule-test-result").textContent).toBe("Matches 2 tickets: B-1, B-2"));
  });

  test("Format tidies a long JQL query in the editor", async () => {
    const long = 'assignee = currentUser() and status = "In Progress" and labels = "agent-ready" and issuetype = Task';
    const view = mount([rule({ query: long })]);
    const card = await cardFor(view, "triage");
    // The summary shows it formatted and highlighted already; what's stored is unchanged.
    expect(card.getByTestId("rule-query-code").textContent).toContain('AND status = "In Progress"');
    await waitFor(() => expect((card.getByTestId("rule-edit") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(card.getByTestId("rule-edit"));
    await card.findByTestId("rule-query-input");
    fireEvent.click(card.getByTestId("rule-format-query"));
    await waitFor(async () => expect(await queryText(card)).toBe('assignee = currentUser()\nAND status = "In Progress"\nAND labels = "agent-ready"\nAND issuetype = Task'));
    await waitFor(() => expect(card.getByTestId("rule-status-tag").textContent).toBe("Modified"));
    fireEvent.click(card.getByTestId("rule-format-query"));
    await waitFor(() => expect(card.getByTestId("rule-format-note").textContent).toBe("Already formatted."));
    await setQuery(card, 'summary ~ "open');
    fireEvent.click(card.getByTestId("rule-format-query"));
    await waitFor(() => expect(card.getByTestId("rule-format-note").textContent).toBe("A quoted string isn't closed."));
  });

  test("the brief loads when a card opens, can be customized from a built-in, and saves", async () => {
    const { api, ...view } = mount([rule()]);
    const card = await cardFor(view, "triage");
    expect(card.getByTestId("rule-summary").textContent).toContain('built-in "task"');
    await waitFor(() => expect((card.getByTestId("rule-edit") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(card.getByTestId("rule-edit"));
    const preview = await card.findByTestId("rule-brief-preview");
    await waitFor(() => expect(preview.textContent).toContain(FIXTURE_BUILTIN_BRIEFS[0]!.text.split("\n")[0]!));
    fireEvent.click(card.getByTestId("rule-brief-customize"));
    const input = await card.findByTestId("rule-brief-input");
    setText(input, "Fix {{KEY}} and report back.");
    await waitFor(() => expect(card.getByTestId("rule-status-tag").textContent).toBe("Modified"));

    fireEvent.click(view.getByTestId("rules-review-save"));
    const dialog = within(await view.findByTestId("rules-review-dialog"));
    await waitFor(() => expect(dialog.getByText(/custom: Fix \{\{KEY\}\} and report back\./)).toBeTruthy());
    fireEvent.click(dialog.getByTestId("rules-save-confirm"));
    await waitFor(() => expect(view.getByTestId("rules-save-result").textContent).toContain("Saved 1 change."));
    expect((await api.getRuleDetails!("triage")).brief).toBe("Fix {{KEY}} and report back.");
    await waitFor(() => expect(view.getByTestId("rules-save-bar").textContent).toContain("No unsaved changes"));
  });

  test("switching an enabled rule to swarm is reviewed as staffing every match; resume settings edit inline", async () => {
    const view = mount([rule({ enabled: true, execution: "singleton", staffed: true, reason: null })], { previews: { triage: { ruleId: "triage", total: 6, tickets: [{ key: "A-1" }] } } });
    const card = await cardFor(view, "triage");
    await waitFor(() => expect((card.getByTestId("rule-edit") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(card.getByTestId("rule-edit"));
    await choose(view, card, "rule-execution-select", /^Swarm/);
    await waitFor(() => expect(card.getByText(/Changing execution restarts/)).toBeTruthy());

    fireEvent.click(view.getByTestId("rules-review-save"));
    const dialog = within(await view.findByTestId("rules-review-dialog"));
    await waitFor(() => expect(dialog.getByText(/Staffs up to 6 tickets: A-1/)).toBeTruthy());
    expect(dialog.getByText("swarm")).toBeTruthy();
  });

  test("notification delivery and the stall threshold edit inline and save", async () => {
    const { api, ...view } = mount([rule()]);
    const card = await cardFor(view, "triage");
    await waitFor(() => expect((card.getByTestId("rule-edit") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(card.getByTestId("rule-edit"));
    await choose(view, card, "rule-notify-delivery-select", /^Direct prompt only/);
    setText(card.getByTestId("rule-stalled-minutes-input"), "0");
    await waitFor(() => expect(view.getByTestId("rules-save-blocked").textContent).toContain("Fix the errors"));
    setText(card.getByTestId("rule-stalled-minutes-input"), "25");
    await waitFor(() => expect(view.queryByTestId("rules-save-blocked")).toBeNull());

    fireEvent.click(view.getByTestId("rules-review-save"));
    const dialog = within(await view.findByTestId("rules-review-dialog"));
    await waitFor(() => expect(dialog.getByText("direct prompt only")).toBeTruthy());
    expect(dialog.getByText("25 min")).toBeTruthy();
    fireEvent.click(dialog.getByTestId("rules-save-confirm"));
    await waitFor(() => expect(view.getByTestId("rules-save-result").textContent).toContain("Saved 1 change."));
    const saved = (await api.listRules()).rules[0]!;
    expect([saved.notifyDeliveryMode, saved.stalledMinutes]).toEqual(["prompt", 25]);
  });

  test("a rule's card shows a non-default delivery mode and stall threshold", async () => {
    const view = mount([rule({ notifyDeliveryMode: "prompt", stalledMinutes: 25 })]);
    const summary = (await cardFor(view, "triage")).getByTestId("rule-summary").textContent;
    expect(summary).toContain("updates: direct prompt only");
    expect(summary).toContain("stalled after 25 min");
  });

  test("linked-change events edit inline for a jira-work rule and save", async () => {
    const { api, ...view } = mount([rule()]);
    const card = await cardFor(view, "triage");
    await waitFor(() => expect((card.getByTestId("rule-edit") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(card.getByTestId("rule-edit"));
    expect(((await card.findByTestId("rule-linked-items-input")) as HTMLInputElement).disabled).toBe(true);
    expect(card.getByText(/Also its pull request \(branch KEY or KEY-…\)/)).toBeTruthy();
    fireEvent.click(card.getByRole("switch", { name: /Wake agents when linked items change/ }));
    await waitFor(() => expect((card.getByTestId("rule-linked-items-input") as HTMLInputElement).disabled).toBe(false));
    setText(card.getByTestId("rule-linked-items-input"), "13");
    fireEvent.click(card.getByRole("switch", { name: /Follow Jira remote links/ }));

    fireEvent.click(view.getByTestId("rules-review-save"));
    const dialog = within(await view.findByTestId("rules-review-dialog"));
    await waitFor(() => expect(dialog.getByText("13")).toBeTruthy());
    fireEvent.click(dialog.getByTestId("rules-save-confirm"));
    await waitFor(() => expect(view.getByTestId("rules-save-result").textContent).toContain("Saved 1 change."));
    const saved = (await api.listRules()).rules[0]!;
    expect([saved.linkedEventing, saved.maxLinkedItems, saved.linkedRemoteLinks, saved.linkedDescriptionLinks]).toEqual([true, 13, true, undefined]);
    expect(card.queryByText("Wakes per hour, at most")).toBeNull(); // FACTORY-252: the hourly cap is gone
  });

  test("other providers get no linked-change section, and a linked field set there is listed as unused", async () => {
    const view = mount([rule({ id: "prs", resourceProvider: "github-pr", query: "is:pr" })], { ruleFields: { prs: { linkedEventing: true } } });
    const card = await cardFor(view, "prs");
    await waitFor(() => expect((card.getByTestId("rule-edit") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(card.getByTestId("rule-edit"));
    const list = within(await card.findByTestId("rule-readonly-fields"));
    expect(list.getByText("Linked-change events (unused for this provider)")).toBeTruthy();
    expect(card.queryByText("Wake agents when linked items change")).toBeNull();
  });

  test("fields the editor can't change yet are listed read-only at the bottom", async () => {
    const view = mount([rule({ agentPreferences: [{ harness: "claude", model: "claude-opus-5" }, { harness: "codex", effort: "high" }] })], {
      // `account` is the ignored legacy Rocket.Chat key a rules.json may still carry.
      ruleFields: { triage: { maxNewPerTick: 2, linkedEventing: true, relationships: { childRule: "tasks" }, somethingNew: "x", account: "none" } },
    });
    const card = await cardFor(view, "triage");
    expect(card.getByTestId("rule-summary").textContent).toContain("Staffing");
    await waitFor(() => expect((card.getByTestId("rule-edit") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(card.getByTestId("rule-edit"));
    const list = within(await card.findByTestId("rule-readonly-fields"));
    const row = (label: string) => list.getByText(label).closest(".rt-readonly__row")!.textContent;
    expect(row("New agents per poll")).toBe("New agents per poll2");
    // A jira-work rule edits linked-change events above, so they aren't listed here.
    expect(list.queryByText(/Linked-change events/)).toBeNull();
    expect(row("Relationships")).toContain('"childRule": "tasks"');
    expect(row("Extra MCP servers")).toBe("Extra MCP serversnot set");
    expect(row("Fallback agents")).toContain('"harness": "codex"');
    expect(row("Something new")).toBe("Something newx");
    expect(list.queryByText("Account")).toBeNull();
  });

  test("a new rule explains its file-only defaults; a butchr without the details route says so", async () => {
    const api = createFixturesRulesApi({ initial: { rules: [rule()], errors: [] }, latencyMs: 0 });
    delete (api as { getRuleDetails?: unknown }).getRuleDetails;
    const view = render(
      <MemoryRouter initialEntries={["/rules"]}>
        <RulesTargetingRoute api={api} />
      </MemoryRouter>,
    );
    const card = await cardFor(view, "triage");
    await waitFor(() => expect((card.getByTestId("rule-edit") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(card.getByTestId("rule-edit"));
    await waitFor(() => expect(card.getByText("Couldn't load the rest of this rule: this butchr doesn't serve rule details")).toBeTruthy());
    expect(card.getByTestId("rule-brief-loading").textContent).toContain("this butchr doesn't serve rule details");
    fireEvent.click(view.getByTestId("add-rule"));
    fireEvent.click(await view.findByRole("menuitem", { name: /Jira tickets/ }));
    expect((await cardFor(view, "new rule")).getByText(/New rules start with butchr's defaults for these/)).toBeTruthy();
  });

  test("read-only when the write API isn't available", async () => {
    const view = mount([rule()], { sessionOk: false });
    await view.findByTestId("rules-read-only");
    const card = await cardFor(view, "triage");
    expect((card.getByTestId("rule-edit") as HTMLButtonElement).disabled).toBe(true);
    expect((view.getByTestId("add-rule") as HTMLButtonElement).disabled).toBe(true);
  });

  test("an empty rules file shows the empty state; Collapse all hides summaries", async () => {
    const empty = mount([]);
    await empty.findByTestId("rules-empty");
    cleanup();
    const view = mount([rule(), rule({ id: "second" })]);
    const card = await cardFor(view, "triage");
    fireEvent.click(view.getByTestId("rules-collapse-all"));
    await waitFor(() => expect(card.queryByTestId("rule-summary")).toBeNull());
    fireEvent.click(view.getByTestId("rules-collapse-all"));
    await waitFor(() => expect(card.getByTestId("rule-summary")).toBeTruthy());
  });
});

describe("rulesPageReducer", () => {
  const server = (rules: RuleDto[], etag: string) => ({ type: "server" as const, rules, etag });

  test("follows the server while clean and flags a newer server while dirty", () => {
    let s: RulesPageState | null = rulesPageReducer(null, server([rule()], "e1"));
    expect(rulesPageReducer(s, server([rule()], "e1"))).toBe(s);
    s = rulesPageReducer(s, server([rule({ query: "theirs" })], "e2"));
    expect(s?.draft.rules[0]?.query).toBe("theirs");
    s = rulesPageReducer(s, { type: "draft", action: { type: "edit", key: "triage", changes: { lizardMode: true } } });
    s = rulesPageReducer(s, server([rule({ query: "theirs again" })], "e3"));
    expect(s?.serverAhead?.etag).toBe("e3");
    expect(s?.draft.rules[0]?.query).toBe("theirs");
    s = rulesPageReducer(s, { type: "accept-server" });
    expect(s?.serverAhead).toBeNull();
    expect(s?.draft.rules[0]).toMatchObject({ query: "theirs again", lizardMode: true });
    expect(rulesPageReducer(s, { type: "accept-server" })).toBe(s);
  });

  test("after a save, the next snapshot is applied even though the old draft looked dirty", () => {
    let s = rulesPageReducer(null, server([], "e1"));
    s = rulesPageReducer(s, { type: "draft", action: { type: "add", resourceProvider: "jira-work" } });
    s = rulesPageReducer(s, { type: "draft", action: { type: "edit", key: newDraftKey(1), changes: { id: "made", query: "q" } } });
    s = rulesPageReducer(s, { type: "saved", created: { [newDraftKey(1)]: "made" }, briefs: { made: "@builtin:task" } });
    s = rulesPageReducer(s, server([rule({ id: "made", query: "q" })], "e2"));
    expect(s?.pendingSave).toBeNull();
    expect(s?.draft.briefs).toEqual({ made: "@builtin:task" });
    expect(summarizeDraft(s!.draft).dirty).toBe(false);
    expect(rulesPageReducer(null, { type: "accept-server" })).toBeNull();
  });

  test("a matching snapshot clears a stale server-ahead banner", () => {
    let s = rulesPageReducer(null, server([rule()], "e1"));
    s = rulesPageReducer(s, { type: "draft", action: { type: "edit", key: "triage", changes: { lizardMode: true } } });
    s = rulesPageReducer(s, server([rule()], "e2"));
    expect(s?.serverAhead).not.toBeNull();
    s = rulesPageReducer(s, server([rule()], "e1"));
    expect(s?.serverAhead).toBeNull();
  });
});

describe("helpers", () => {
  test("saveBlockedReason, describeDraft, unstaffedReason", () => {
    const clean = summarizeDraft(rulesPageReducer(null, { type: "server", rules: [rule()], etag: "e" })!.draft);
    expect(saveBlockedReason(clean, { canWrite: true, reloadPending: false })).toBe("Make a change to save.");
    const dirty = { ...clean, dirty: true };
    expect(saveBlockedReason(dirty, { canWrite: false, reloadPending: false })).toContain("isn't accepting");
    expect(saveBlockedReason(dirty, { canWrite: true, reloadPending: true })).toContain("reload");
    expect(saveBlockedReason(dirty, { canWrite: true, reloadPending: false })).toBeNull();
    expect(describeDraft({ added: 2, edited: 0, deleted: 1 })).toBe("3 rules with unsaved changes (2 new, 1 to delete)");
    expect(unstaffedReason(rule())).toBeNull();
    expect(unstaffedReason(rule({ reason: "disabled: not yet configured" }))).toBe("not yet configured");
    expect(unstaffedReason(rule({ enabled: true, reason: "census unavailable" }))).toBe("census unavailable");
    expect(unstaffedReason(rule({ staffed: true }))).toBeNull();
    expect(unstaffedReason(undefined)).toBeNull();
  });
});
