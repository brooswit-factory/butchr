import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { withDom } from "../setup/happy-dom.js";
import { App } from "../../dashboard-app/src/App.js";

withDom();
afterEach(cleanup);

// Both routes poll real endpoints on mount (`useDashboard`/`useConfigInventory`)
// — a never-resolving fetch keeps every test below deterministic (asserting
// on the initial render, before any response lands) without needing to stub
// two different JSON shapes just to reach the shell/nav assertions.
beforeEach(() => {
  globalThis.fetch = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;
});

describe("App shell — FACTORY-614", () => {
  test("renders the LaunchPad Heading-based header and both nav links", () => {
    const { getByRole } = render(
      <MemoryRouter initialEntries={["/"]}>
        <App />
      </MemoryRouter>,
    );
    expect(getByRole("heading", { name: "butchr dashboard" })).toBeTruthy();
    expect(getByRole("link", { name: "Dashboard" })).toBeTruthy();
    expect(getByRole("link", { name: "Configurations" })).toBeTruthy();
  });

  test("route \"/\" renders the Dashboard placeholder and marks the Dashboard nav link current", async () => {
    const { getByRole } = render(
      <MemoryRouter initialEntries={["/"]}>
        <App />
      </MemoryRouter>,
    );
    await waitFor(() => expect(getByRole("heading", { name: "Dashboard" })).toBeTruthy());
    expect(getByRole("link", { name: "Dashboard" }).getAttribute("aria-current")).toBe("page");
    expect(getByRole("link", { name: "Configurations" }).getAttribute("aria-current")).toBeNull();
  });

  test("route \"/configurations\" renders the Configurations placeholder and marks that nav link current", async () => {
    const { getByRole } = render(
      <MemoryRouter initialEntries={["/configurations"]}>
        <App />
      </MemoryRouter>,
    );
    await waitFor(() => expect(getByRole("heading", { name: "Configurations" })).toBeTruthy());
    expect(getByRole("link", { name: "Configurations" }).getAttribute("aria-current")).toBe("page");
    expect(getByRole("link", { name: "Dashboard" }).getAttribute("aria-current")).toBeNull();
  });

  test("theme wiring: the app shell renders fine under the explicit data-theme=\"dark\" attribute main.tsx's `watchSystemTheme` applies on an OS dark preference (apply-system-theme.test.ts covers that logic itself) — this just proves the shell tolerates the attribute, never requiring the absence of a toggle to mean the absence of a theme", () => {
    document.documentElement.dataset.theme = "dark";
    try {
      const { getByRole } = render(
        <MemoryRouter initialEntries={["/"]}>
          <App />
        </MemoryRouter>,
      );
      expect(getByRole("heading", { name: "butchr dashboard" })).toBeTruthy();
      expect(document.documentElement.dataset.theme).toBe("dark");
    } finally {
      delete document.documentElement.dataset.theme;
    }
  });
});
