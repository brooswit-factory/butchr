import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { withDom } from "../setup/happy-dom.js";
import { StatusPill } from "../../dashboard-app/src/components/StatusPill.js";

withDom();
afterEach(cleanup);

describe("StatusPill — FACTORY-615", () => {
  test("renders the given label verbatim", () => {
    const { getByText } = render(<StatusPill statusClass="working" label="working" />);
    expect(getByText("working")).toBeTruthy();
  });

  test("the statusClass drives a distinct CSS class per known status — never the same class for two different statuses", () => {
    const { container: working } = render(<StatusPill statusClass="working" label="working" />);
    const { container: blocked } = render(<StatusPill statusClass="blocked" label="blocked" />);
    expect(working.querySelector(".status-pill--working")).toBeTruthy();
    expect(blocked.querySelector(".status-pill--blocked")).toBeTruthy();
    expect(working.querySelector(".status-pill--blocked")).toBeFalsy();
  });

  test("the withheld row's own 'waiting' status renders its own distinct class", () => {
    const { container } = render(<StatusPill statusClass="waiting" label="waiting for a slot" />);
    expect(container.querySelector(".status-pill--waiting")).toBeTruthy();
  });
});
