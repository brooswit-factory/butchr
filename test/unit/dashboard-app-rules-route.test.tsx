import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { withDom } from "../setup/happy-dom.js";
import { RulesRoute } from "../../dashboard-app/src/routes/RulesRoute.js";
import { createFixturesRulesApi, defaultRulesFixture } from "../../dashboard-app/src/api/rules.js";
import type { RuleDto, RulesListResponse } from "../../dashboard-app/src/api/rules.js";

withDom();
afterEach(cleanup);

function rule(overrides: Partial<RuleDto> = {}): RuleDto {
  return {
    id: "r1",
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

describe("RulesRoute — FACTORY-661: list", () => {
  test("renders one row per rule, with its own id, provider, execution, and staffed text", async () => {
    const api = createFixturesRulesApi({ initial: defaultRulesFixture(), latencyMs: 0 });
    const { findAllByTestId, getByText } = render(<RulesRoute api={api} />);
    const rows = await findAllByTestId("rule-row");
    expect(rows).toHaveLength(3);
    expect(getByText("factory-triage")).toBeTruthy();
    expect(getByText(/execution: singleton/)).toBeTruthy();
    expect(getByText("UNSTAFFED: disabled")).toBeTruthy();
    expect(getByText(/COULD NOT CHECK: census unavailable/)).toBeTruthy();
  });

  test("a validation-problems banner renders when the rules file is invalid, independent of whether any rules also loaded", async () => {
    const data: RulesListResponse = { rules: [], errors: [{ path: "/home/x/.config/butchr/rules.json", message: 'rules[0].id must be a lowercase slug' }] };
    const api = createFixturesRulesApi({ initial: data, latencyMs: 0 });
    const { findByTestId, getByText } = render(<RulesRoute api={api} />);
    const banner = await findByTestId("rules-file-errors");
    expect(banner.textContent).toContain("rules[0].id must be a lowercase slug");
    expect(getByText(/rules.json/)).toBeTruthy();
  });

  test("empty state (no rules, no errors) explains why and shows a disabled 'Add your first rule' button", async () => {
    const api = createFixturesRulesApi({ initial: { rules: [], errors: [] }, latencyMs: 0 });
    const { findByTestId, getByRole } = render(<RulesRoute api={api} />);
    const empty = await findByTestId("rules-empty-state");
    expect(empty.textContent).toContain("No rules file");
    const button = getByRole("button", { name: "Add your first rule" });
    expect(button.hasAttribute("disabled")).toBe(true);
  });

  test("the toggle is disabled with a 'needs the write API' explanation when capabilities.write is false (the real implementation)", async () => {
    const api = createFixturesRulesApi({ initial: defaultRulesFixture(), latencyMs: 0 });
    // @ts-expect-error -- test-only override to simulate the real (no-write) implementation without touching globalThis.fetch
    api.capabilities = { write: false };
    const { findAllByTestId, container } = render(<RulesRoute api={api} />);
    await findAllByTestId("rule-row");
    const toggleWrap = container.querySelector(".rules-table__toggle");
    expect(toggleWrap?.getAttribute("title")).toBe("needs the write API");
    const input = container.querySelector('.rules-table__toggle input[type="checkbox"]') as HTMLInputElement | null;
    expect(input?.disabled).toBe(true);
  });
});

describe("RulesRoute — FACTORY-661: preview", () => {
  test("Preview shows the total and each ticket KEY, linked — no summary field anywhere", async () => {
    const api = createFixturesRulesApi({
      initial: { rules: [rule({ id: "triage" })], errors: [] },
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
    const api = createFixturesRulesApi({ initial: { rules: [rule({ id: "triage" })], errors: [] }, latencyMs: 0 });
    api.previewRule = async () => {
      throw new Error("preview backend down");
    };
    const { findAllByTestId, getByRole, findByText } = render(<RulesRoute api={api} />);
    await findAllByTestId("rule-row");
    fireEvent.click(getByRole("button", { name: "Preview" }));
    expect(await findByText(/could not load preview — preview backend down/)).toBeTruthy();
  });
});

describe("RulesRoute — FACTORY-661: toggle + plan-confirm warning", () => {
  test("a toggle whose plan would stop/restart agents shows a confirm dialog naming spawned/stopped/restarted, and does nothing until confirmed", async () => {
    const api = createFixturesRulesApi({
      initial: { rules: [rule({ id: "triage", enabled: true })], errors: [] },
      latencyMs: 0,
      plans: { triage: { planHash: "h1", spawned: 0, stopped: 3, restarted: 1, etag: "e1" } },
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
      initial: { rules: [rule({ id: "triage", enabled: true })], errors: [] },
      latencyMs: 0,
      plans: { triage: { planHash: "h1", spawned: 0, stopped: 1, restarted: 0, etag: "e1" } },
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
      initial: { rules: [rule({ id: "triage", enabled: false })], errors: [] },
      latencyMs: 0,
      plans: { triage: { planHash: "h1", spawned: 1, stopped: 0, restarted: 0, etag: "e1" } },
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

describe("RulesRoute — FACTORY-661: CSP/escaping (agentsafety review 2026-10-05 item d)", () => {
  test("a script-tag and an onerror-image payload in id/query/agentPreferences render as inert text, never as markup", async () => {
    const scriptPayload = '<script>window.__pwned = true</script>';
    const imgPayload = '"><img src=x onerror=window.__pwned=true>';
    const api = createFixturesRulesApi({
      initial: {
        rules: [
          rule({
            id: scriptPayload,
            query: imgPayload,
            agentPreferences: [{ harness: "claude", model: imgPayload }],
          }),
        ],
        errors: [],
      },
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
});
