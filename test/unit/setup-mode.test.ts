import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpHandle } from "@brooswit/thatch";
import { liveView } from "../../src/web/view.js";
import { buildSetupModeViewDeps, runSetupModeDaemon } from "../../src/daemon/setup-mode.js";

const fakeMcp = { connections: { list: () => [] } } as unknown as McpHandle;

function scratchEnv(dir: string): Record<string, string | undefined> {
  return { XDG_CONFIG_HOME: dir };
}

describe("buildSetupModeViewDeps", () => {
  test("every required ViewDeps field is present and health is always ok with no components", () => {
    const dir = mkdtempSync(join(tmpdir(), "setup-mode-test-"));
    try {
      const logs: string[] = [];
      const { viewDeps } = buildSetupModeViewDeps(0, scratchEnv(dir), (l) => logs.push(l));
      expect(viewDeps.health()).toEqual({ ok: true, components: [] });
      expect(viewDeps.setupStatus?.()).toEqual({ configured: false });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("the built deps serve GET /api/setup/status and POST /api/setup/jira over a real listener, and nothing else Jira-shaped", async () => {
    const dir = mkdtempSync(join(tmpdir(), "setup-mode-test-"));
    try {
      const logs: string[] = [];
      const { viewDeps, setupCodeManager } = buildSetupModeViewDeps(0, scratchEnv(dir), (l) => logs.push(l));
      // `isSameUidPeer`'s real `/proc/net/tcp` lookup is exercised directly
      // by `test/unit/peer-uid.test.ts`; this test is about ROUTE WIRING
      // (does setup mode serve the right routes with the right deps),
      // so the peer-uid check itself is stubbed, same discipline
      // `settings-route.test.ts` already uses for the equivalent real route.
      viewDeps.peerUidCheck = () => true;
      if (viewDeps.writeGuard) viewDeps.writeGuard.peerUidCheck = () => true;
      const app = liveView(fakeMcp, viewDeps);
      app.listen(0);
      const port = app.server!.port!;
      (viewDeps.dashboardOriginGuard as { port: number }).port = port;
      try {
        const headers = { origin: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}` };
        const health = await fetch(`http://127.0.0.1:${port}/health`);
        expect(health.status).toBe(200);

        const status = await fetch(`http://127.0.0.1:${port}/api/setup/status`, { headers });
        expect(await status.json()).toEqual({ configured: false });

        const session = await fetch(`http://127.0.0.1:${port}/api/session`, { headers: { ...headers, "sec-fetch-site": "same-origin" } });
        const { csrfToken } = (await session.json()) as { csrfToken: string };

        const code = setupCodeManager.mint();
        const setupRes = await fetch(`http://127.0.0.1:${port}/api/setup/jira`, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json", "x-butchr-csrf": csrfToken },
          body: JSON.stringify({ site: "https://x.atlassian.net", email: "a@b.c", token: "t", setupCode: code }),
        });
        // No real network reaches Jira from this test — the candidate test
        // fails (no stub server), which is expected; the point is the route
        // is WIRED and reaches real orchestration logic, not 503.
        expect(setupRes.status).not.toBe(503);

        // Settings/rules/rotation routes are all unreachable: these deps were
        // never supplied, so every one of them 503s rather than crashing.
        const settings = await fetch(`http://127.0.0.1:${port}/api/settings`, { headers });
        expect(settings.status).toBe(503);
        const rotate = await fetch(`http://127.0.0.1:${port}/api/settings/jira/token`, { method: "PUT", headers: { ...headers, "content-type": "application/json", "x-butchr-csrf": csrfToken }, body: "{}" });
        expect(rotate.status).toBe(503);
      } finally { await app.stop(true); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("runSetupModeDaemon", () => {
  test("starts listening on the configured port, logs the setup code exactly once, and SIGUSR2 mints a fresh one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "setup-mode-test-"));
    try {
      const logs: string[] = [];
      // port 0 lets the OS assign a free ephemeral port — this function
      // doesn't return it, but we only need to prove it started without
      // throwing and logged the expected lines; a full route exercise is
      // `buildSetupModeViewDeps`'s own test above, against a server this
      // test file controls directly.
      await runSetupModeDaemon({ env: { ...scratchEnv(dir), BUTCHR_PORT: "0" }, log: (l) => logs.push(l) });
      expect(logs.some((l) => l.includes("SETUP MODE"))).toBe(true);
      expect(logs.filter((l) => l.includes("setup code")).length).toBe(1);
      expect(logs.some((l) => l.includes("listening on"))).toBe(true);

      logs.length = 0;
      process.emit("SIGUSR2");
      expect(logs.filter((l) => l.includes("setup code")).length).toBe(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("an invalid BUTCHR_PORT throws rather than starting a listener", async () => {
    const dir = mkdtempSync(join(tmpdir(), "setup-mode-test-"));
    try {
      await expect(runSetupModeDaemon({ env: { ...scratchEnv(dir), BUTCHR_PORT: "not-a-port" }, log: () => {} })).rejects.toThrow(/BUTCHR_PORT/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
