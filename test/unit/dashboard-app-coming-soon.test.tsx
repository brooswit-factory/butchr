/**
 * local/ui — the Coming soon page: every group and item renders, and the
 * rule fields the Rules editor still can't change are all on it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, within } from "@testing-library/react";
import { withDom } from "../setup/happy-dom.js";
import { ComingSoonRoute } from "../../dashboard-app/src/routes/ComingSoonRoute.js";
import { COMING_SOON, ON_PURPOSE } from "../../dashboard-app/src/view-model/coming-soon.js";
import { NOT_EDITABLE_YET } from "../../dashboard-app/src/components/rules-targeting/RuleEditor.js";

withDom();
afterEach(cleanup);

describe("Coming soon page", () => {
  test("lists every group with its items and where each lives today, then what stays outside on purpose", () => {
    const view = render(<ComingSoonRoute />);
    expect(view.getByRole("heading", { name: "Coming soon" })).toBeTruthy();
    for (const g of COMING_SOON) {
      const card = within(view.getByTestId(`cs-group-${g.id}`));
      expect(card.getByRole("heading", { name: g.title })).toBeTruthy();
      for (const item of g.items) expect(card.getByText(item.title)).toBeTruthy();
    }
    const onPurpose = within(view.getByTestId("cs-on-purpose"));
    for (const item of ON_PURPOSE) expect(onPurpose.getByText(item.title)).toBeTruthy();
  });

  test("every rule field the Rules editor lists as not editable yet is on the page", () => {
    const rules = COMING_SOON.find((g) => g.id === "rules")!;
    const text = rules.items.map((i) => i.today).join(" ");
    for (const f of NOT_EDITABLE_YET) expect(text).toContain(f.key);
  });
});
