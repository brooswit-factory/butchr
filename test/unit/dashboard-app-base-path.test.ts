import { afterAll, describe, expect, test } from "bun:test";
import { build } from "vite";
import { buildApp } from "../../src/daemon/app.js";
import type { ViewDeps } from "../../src/web/view.js";
import type { DashboardResponse } from "../../src/agents/dashboard.js";
import type { DashboardHeaderInfo } from "../../src/web/dashboard-page.js";

// FACTORY-642 (butchr GH #625): `vite.config.ts` set `root`/`build.outDir`
// but not `base`, so Vite emitted the built HTML's `src`/`href` from `/`
// (e.g. `/assets/index-XXXX.js`) while `src/web/view.ts` only ever serves
// assets under `/dashboard-app/*` (`/assets/*` is never registered at all) —
// a blank page, both files 404ing. This drives the REAL build
// (`vite.config.ts`, not a hand-written fixture) through the REAL daemon app
// (`buildApp`, the same route code `src/web/view.ts` registers) on an
// ephemeral port, so a regression in either the Vite config or the route
// wiring fails this test. Proved to fail against the pre-fix config (no
// `base`): every extracted URL 404s instead of 200.
const unused = () => { throw new Error("unused in this test"); };
const noAdmissionView = { cap: 0, residency: null, sentinels: null, sources: [] };
const noDashboard = async (): Promise<DashboardResponse> => ({ checked: true, confirmedAt: new Date(0).toISOString(), rows: [], admission: noAdmissionView });
const noHeader = (): DashboardHeaderInfo => ({ build: { sha: null, shaDirty: null, shaUnknownReason: "test fixture", version: "0.0.0" } });
const deps = {
  state: unused, open: unused, openPane: unused,
  health: () => ({ ok: true, components: [] }),
  dashboard: noDashboard, header: noHeader,
  resourceLink: unused, configInventory: unused,
} as unknown as ViewDeps;

describe("FACTORY-642: dashboard-app's built asset URLs resolve under /dashboard-app/", () => {
  test("every src/href the built HTML emits — on the bare mount point AND a deep client-side route — resolves to 200 through the real daemon app", async () => {
    // Real build, real vite.config.ts — not a hand-crafted fixture, so a
    // regression here (a dropped `base`, a changed outDir) actually fails.
    await build({ logLevel: "silent" });

    const { app, mcp } = buildApp(deps);
    app.listen(0);
    const base = `http://localhost:${app.server!.port}`;
    try {
      for (const path of ["/dashboard-app/", "/dashboard-app/configurations"]) {
        const html = await (await fetch(`${base}${path}`)).text();
        const urls = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]!);
        expect(urls.length).toBeGreaterThan(0);
        for (const url of urls) {
          const res = await fetch(`${base}${url}`);
          expect(res.status).toBe(200);
        }
      }
    } finally {
      await mcp.closeAll();
      app.stop();
    }
  }, 30000);
});
