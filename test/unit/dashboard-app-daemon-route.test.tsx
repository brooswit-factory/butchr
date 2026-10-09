import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, waitFor, fireEvent } from "@testing-library/react";
import { withDom } from "../setup/happy-dom.js";
import { DaemonRoute } from "../../dashboard-app/src/routes/DaemonRoute.js";
import { createFixturesDaemonApi, DaemonLogsUnavailableError, DaemonReloadFailedError } from "../../dashboard-app/src/api/daemon.js";
import { createFixturesSettingsApi } from "../../dashboard-app/src/api/settings.js";
import type { HealthStatus } from "../../src/daemon/health.js";

withDom();
afterEach(cleanup);

function healthFetch(status: HealthStatus): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/health") return new Response(JSON.stringify(status), { status: status.ok ? 200 : 503, headers: { "content-type": "application/json" } });
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
}

const HEALTHY: HealthStatus = {
  ok: true,
  components: [{ name: "poll-loop", ok: true, state: "ok", lastSuccessAt: "2026-01-01T00:00:00.000Z", staleForMs: 0 }],
  build: { sha: "abc1234", shaProvenance: "git-at-start", shaDirty: false, shaUnknownReason: null, version: "1.0.1+204", versionProvenance: "package-json", versionUnknownReason: null, startedAt: "2026-01-01T00:00:00.000Z", pid: 123, unit: "butchr.service", journalctl: "journalctl --user -u butchr.service" } as unknown as HealthStatus["build"],
};

describe("DaemonRoute — FACTORY-668", () => {
  test("renders health, logs, reload and restart controls once loaded", async () => {
    globalThis.fetch = healthFetch(HEALTHY);
    const daemonApi = createFixturesDaemonApi();
    const settingsApi = createFixturesSettingsApi();
    const { getByTestId } = render(<DaemonRoute api={daemonApi} settingsApi={settingsApi} />);

    await waitFor(() => expect(getByTestId("daemon-health-ok").textContent).toBe("healthy"));
    expect(getByTestId("daemon-build-info").textContent).toContain("1.0.1+204");
    await waitFor(() => expect(getByTestId("daemon-logs-lines")).toBeTruthy());
    expect(getByTestId("daemon-reload-button")).toBeTruthy();
    expect(getByTestId("daemon-restart-button")).toBeTruthy();
  });

  test("logs source unavailable: shows the operator-actionable message, never an empty page", async () => {
    globalThis.fetch = healthFetch(HEALTHY);
    const daemonApi = createFixturesDaemonApi({ nextLogsError: new DaemonLogsUnavailableError("no systemd unit or scheduled task detected for this daemon — logs are unavailable") });
    const settingsApi = createFixturesSettingsApi();
    const { getByText } = render(<DaemonRoute api={daemonApi} settingsApi={settingsApi} />);

    await waitFor(() => expect(getByText(/no systemd unit or scheduled task detected/)).toBeTruthy());
  });

  test("reload button: success updates the status line with what changed", async () => {
    globalThis.fetch = healthFetch(HEALTHY);
    const daemonApi = createFixturesDaemonApi({ nextReloadResult: { ok: true, path: "/x/rules.json", added: ["r1"], removed: [], changed: [] } });
    const settingsApi = createFixturesSettingsApi();
    const { getByTestId } = render(<DaemonRoute api={daemonApi} settingsApi={settingsApi} />);

    await waitFor(() => expect(getByTestId("daemon-reload-button")).toBeTruthy());
    fireEvent.click(getByTestId("daemon-reload-button"));
    await waitFor(() => expect(getByTestId("daemon-reload-status").textContent).toContain("added: r1"));
  });

  test("reload button: failure shows the server's own problem text, never a silent no-op", async () => {
    globalThis.fetch = healthFetch(HEALTHY);
    const daemonApi = createFixturesDaemonApi({ nextReloadError: new DaemonReloadFailedError("reload failed: bad json", ["bad json"]) });
    const settingsApi = createFixturesSettingsApi();
    const { getByTestId } = render(<DaemonRoute api={daemonApi} settingsApi={settingsApi} />);

    await waitFor(() => expect(getByTestId("daemon-reload-button")).toBeTruthy());
    fireEvent.click(getByTestId("daemon-reload-button"));
    await waitFor(() => expect(getByTestId("daemon-reload-status").textContent).toContain("bad json"));
  });
});
