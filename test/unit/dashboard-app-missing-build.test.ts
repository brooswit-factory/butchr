import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../../src/daemon/app.js";
import { combineHealth, createLoopHealth, type HealthStatus } from "../../src/daemon/health.js";
import { dashboardAppStatus } from "../../src/web/static-assets.js";
import type { ViewDeps } from "../../src/web/view.js";
import type { DashboardResponse } from "../../src/agents/dashboard.js";
import type { DashboardHeaderInfo } from "../../src/web/dashboard-page.js";

// FACTORY-647: drives the REAL route code (`buildApp`/`liveView`, same as
// production) with a temp-dir `dashboardAppRoot` fixture, never a
// hand-rolled handler — so a regression in the real wiring (view.ts's
// `/dashboard-app*` routes, `dashboardAppStatus`, `combineHealth`'s new
// sibling field) actually fails this test. Two fixtures only (build present,
// build absent), no shell on hostile strings, matching the ticket's own
// test shape.
const unused = () => { throw new Error("unused in this test"); };
const noAdmissionView = { cap: 0, residency: null, sentinels: null, sources: [] };
const noDashboard = async (): Promise<DashboardResponse> => ({ checked: true, confirmedAt: new Date(0).toISOString(), rows: [], admission: noAdmissionView });
const noHeader = (): DashboardHeaderInfo => ({ build: { sha: null, shaDirty: null, shaUnknownReason: "test fixture", version: "0.0.0", versionProvenance: "tag", versionUnknownReason: null } });

const baseDeps = {
  state: unused, open: unused, openPane: unused,
  dashboard: noDashboard, header: noHeader,
  resourceLink: unused, configInventory: unused,
} as unknown as ViewDeps;

async function withApp(root: string, run: (base: string) => Promise<void>) {
  const poll = createLoopHealth({ name: "pollLoop", thresholdMs: 1_000, checkIntervalMs: 1e9 });
  poll.recordSuccess();
  const deps: ViewDeps = {
    ...baseDeps,
    dashboardAppRoot: root,
    health: () => combineHealth([poll], undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, dashboardAppStatus(root)),
  };
  const { app, mcp } = buildApp(deps);
  app.listen(0);
  const base = `http://localhost:${app.server!.port}`;
  try {
    await run(base);
  } finally {
    await mcp.closeAll();
    app.stop();
    poll.stop();
  }
}

describe("FACTORY-647: GET /dashboard-app* with the build present", () => {
  const root = mkdtempSync(join(tmpdir(), "butchr-web-built-"));
  mkdirSync(join(root, "assets"), { recursive: true });
  writeFileSync(join(root, "index.html"), "<!doctype html><div>dashboard app</div>");
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test("serves the built index.html, and /health reports built: true with no warning condition", async () => {
    await withApp(root, async (base) => {
      const page = await fetch(`${base}/dashboard-app/`);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain("dashboard app");

      const health = await (await fetch(`${base}/health`)).json() as HealthStatus;
      expect(health.ok).toBe(true);
      expect(health.dashboardApp).toEqual({ built: true, path: join(root, "index.html") });
    });
  });
});

describe("FACTORY-647: GET /dashboard-app* with the build absent", () => {
  const root = mkdtempSync(join(tmpdir(), "butchr-web-unbuilt-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test("friendly 503 body naming the remedy, old server-rendered pages still 200, /health still ok with built: false", async () => {
    await withApp(root, async (base) => {
      const mount = await fetch(`${base}/dashboard-app/`);
      expect(mount.status).toBe(503);
      const mountBody = await mount.text();
      expect(mountBody).toContain("bun run build:web");
      expect(mountBody).toContain(join(root, "index.html"));

      const deep = await fetch(`${base}/dashboard-app/some/deep/route`);
      expect(deep.status).toBe(503);
      expect(await deep.text()).toContain("bun run build:web");

      // Old server-rendered page: must keep working with dashboard-app absent.
      const home = await fetch(`${base}/`);
      expect(home.status).toBe(200);

      const health = await (await fetch(`${base}/health`)).json() as HealthStatus;
      expect(health.ok).toBe(true); // a missing web build never turns /health red
      expect(health.dashboardApp).toEqual({ built: false, path: join(root, "index.html") });
    });
  });
});
