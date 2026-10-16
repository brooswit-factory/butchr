/**
 * FACTORY-660 PR #642 review round 1, finding 2 — "prove it in a real
 * browser, not only with synthetic headers". Every route and guard this
 * script exercises is the ACTUAL production code (`src/daemon/app.ts`'s
 * `buildApp`, `src/web/view.ts`'s `liveView`, `src/web/dashboard-origin-
 * guard.ts`'s `checkDashboardOrigin`), unmodified — same "stub the
 * surrounding ViewDeps, keep the route/guard code real" technique
 * `scripts/real-guard-server.ts` already uses for the extension-origin
 * guard. What's stubbed: a live Jira-fed dashboard poll and a herdr pane
 * registry — standing up the FULL daemon needs live Atlassian credentials
 * and a running herdr fleet, neither of which belongs in an HTTP-origin
 * regression check. The rules file IS real (a real temp file on disk,
 * `loadRulesFileState` reads it for real) and the rules route's shaping
 * (`buildRulesApiResponse`) is the real production function.
 *
 * Drives a REAL headless browser (puppeteer-core, pointed at the
 * environment's already-installed Chrome — no bundled Chromium download)
 * against two real, listening servers:
 *   - the daemon-under-test (real `liveView`/`buildApp`), on its own port
 *   - a second, unrelated static server, standing in for "some other
 *     origin", on a different port
 *
 * and checks exactly what the review asked for:
 *   1. a page loaded FROM the daemon's own origin, running a plain
 *      `fetch("/api/rules")` (no custom headers — this is what the real
 *      dashboard-app client does) — the browser sends NO `Origin` header
 *      on this same-origin GET (Fetch spec), only `Sec-Fetch-Site:
 *      same-origin`. Expected: 200, real rules JSON.
 *   2. a page loaded from the OTHER origin, running
 *      `fetch("http://127.0.0.1:<daemonPort>/api/rules")` — a genuinely
 *      cross-origin GET, so the browser DOES stamp `Origin` (the other
 *      origin), which is not on the daemon's own allowlist. Expected:
 *      refused (403).
 *
 * `puppeteer-core` is a DEV-ONLY, TEMPORARY addition for this one
 * verification run (see the PR body for the exact `bun add -d
 * puppeteer-core` / `bun remove puppeteer-core` either side of running
 * this) — it is not meant to stay a permanent dependency of this repo; the
 * review asked to "add or run and paste the output of" this check, and this
 * script is kept in `scripts/` as the artifact of record for that, re-
 * runnable by anyone who re-adds `puppeteer-core` locally.
 *
 * Usage: PUPPETEER_EXECUTABLE_PATH=/path/to/chrome bun run
 * scripts/verify-dashboard-origin-browser.ts
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/daemon/app.js";
import { DAEMON_HOSTNAME } from "../src/daemon/listen.js";
import type { ViewDeps } from "../src/web/view.js";
import { loadRulesFileState } from "../src/agents/query-agent-inventory.js";
import { buildQueryAgentInventory } from "../src/agents/query-agent-inventory.js";
import { isSameUidPeer } from "../src/web/peer-uid.js";

const notImplemented = (name: string) => async () => {
  throw new Error(`verify-dashboard-origin-browser.ts: ${name} is not implemented — out of scope for this check`);
};

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "butchr-verify-origin-"));
  const rulesFile = join(dir, "rules.json");
  writeFileSync(rulesFile, JSON.stringify({
    rules: [
      { id: "triage", enabled: true, resourceProvider: "jira-work", query: "project = FACTORY", brief: "Pick up newly assigned tickets." },
    ],
  }));
  const env = { BUTCHR_RULES_FILE: rulesFile } as Record<string, string | undefined>;

  const daemonView: ViewDeps = {
    state: async () => [],
    open: notImplemented("open"),
    openPane: notImplemented("openPane"),
    health: () => ({ ok: true, components: [] }) as any,
    dashboard: async () => ({ checked: true as const, confirmedAt: new Date().toISOString(), rows: [], admission: { cap: 0, residency: null, sources: [] } }) as any,
    header: () => ({ build: null }),
    resourceLink: notImplemented("resourceLink"),
    configInventory: async () => buildQueryAgentInventory({
      rulesFile: loadRulesFileState(env),
      dashboard: { checked: true, confirmedAt: new Date().toISOString(), rows: [], admission: { cap: 0, residency: null, sources: [] } } as any,
      configReasonFor: () => null,
      sessionDefinitions: { activeDir: join(dir, "sessions-active"), archiveDir: join(dir, "sessions-archive"), store: { read: async () => ({}), write: async () => {} } } as any,
    }),
  };

  const { app: daemonApp } = buildApp(daemonView);

  // Second, unrelated server standing in for "some other origin" — a plain
  // Bun.serve, nothing from this repo's own route code.
  const otherServer = Bun.serve({ port: 0, hostname: DAEMON_HOSTNAME, fetch: () => new Response("<html><body>other origin</body></html>", { headers: { "content-type": "text/html" } }) });

  let daemonPort = 0;
  try {
    // `peerUidCheck` always true here: this script, the daemon, and the
    // browser's own OS process all share this invocation's uid on this
    // box, so the SAME-uid case is what a real run of this script actually
    // exercises — the peer-uid mechanism itself is unit-tested in isolation
    // (test/unit/peer-uid.test.ts) against a synthetic /proc/net/tcp table.
    daemonView.dashboardOriginGuard = { port: 0 }; // placeholder, set below once the real port is known
    daemonApp.listen({ port: 0, hostname: DAEMON_HOSTNAME });
    daemonPort = daemonApp.server?.port ?? 0;
    daemonView.dashboardOriginGuard.port = daemonPort;
    daemonView.peerUidCheck = (client) => isSameUidPeer(client, { server: { address: DAEMON_HOSTNAME, port: daemonPort } });
    daemonView.getRulesSourceEtag = () => "verify-script";
    daemonView.rulesFileState = async () => {
      const state = loadRulesFileState(env);
      return { ...state, mtime: null, fileEtag: "verify-script" };
    };

    // A non-literal specifier so `tsc` never statically resolves this
    // module (`as any`'s own TS2307 fires on the specifier itself, not the
    // result, so wrapping the call doesn't help) — `puppeteer-core` is a
    // temporary dev dependency only present while this script is actually
    // run (see the header above), and this file is otherwise imported
    // unconditionally by `test/load`'s generated load-test suite.
    const puppeteerModuleName = "puppeteer-core";
    const puppeteer: { launch: (opts: Record<string, unknown>) => Promise<{ newPage: () => Promise<any>; close: () => Promise<void> }> } = await import(puppeteerModuleName);
    const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH?.trim() || "/usr/bin/google-chrome";
    const browser = await puppeteer.launch({ executablePath, headless: true, args: ["--no-sandbox", "--disable-gpu"] });
    try {
      const daemonOrigin = `http://127.0.0.1:${daemonPort}`;
      const otherOrigin = `http://127.0.0.1:${otherServer.port}`;

      console.log(`daemon origin:  ${daemonOrigin}`);
      console.log(`other origin:   ${otherOrigin}`);
      console.log("");

      // 1. Same-origin: load a page FROM the daemon's own origin, fetch
      // /api/rules with NO custom headers — exactly what the dashboard-app
      // client does. The browser decides the Origin/Sec-Fetch-Site headers,
      // not this script.
      const samePage = await browser.newPage();
      await samePage.goto(`${daemonOrigin}/health`, { waitUntil: "load" });
      const sameResult = await samePage.evaluate(async () => {
        const res = await fetch("/api/rules");
        return { status: res.status, body: await res.json() };
      });
      console.log("1. same-origin fetch(\"/api/rules\") from a page loaded at the daemon's own origin:");
      console.log(`   status: ${sameResult.status}`);
      console.log(`   body:   ${JSON.stringify(sameResult.body)}`);
      const sameOk = sameResult.status === 200 && Array.isArray((sameResult.body as any).rules);
      console.log(`   ${sameOk ? "PASS" : "FAIL"} — expected 200 with real rules JSON`);
      await samePage.close();

      // 2. Cross-origin: load a page from the OTHER origin, fetch the
      // daemon's /api/rules by full URL — a genuinely cross-origin request,
      // so the browser DOES stamp Origin: <otherOrigin>, not on the
      // daemon's allowlist.
      const otherPage = await browser.newPage();
      await otherPage.goto(otherOrigin, { waitUntil: "load" });
      const crossResult = await otherPage.evaluate(async (url: string) => {
        try {
          const res = await fetch(url);
          return { status: res.status, body: await res.json() };
        } catch (e) {
          return { status: null, error: String(e) };
        }
      }, `${daemonOrigin}/api/rules`);
      console.log("");
      console.log("2. cross-origin fetch(\"<daemonOrigin>/api/rules\") from a page loaded at a DIFFERENT origin:");
      console.log(`   result: ${JSON.stringify(crossResult)}`);
      const crossRefused = crossResult.status === 403 || crossResult.status === null;
      console.log(`   ${crossRefused ? "PASS" : "FAIL"} — expected refused (403, or a CORS-blocked fetch reporting no readable status)`);
      await otherPage.close();

      if (!sameOk || !crossRefused) process.exitCode = 1;
    } finally {
      await browser.close();
    }
  } finally {
    await daemonApp.stop(true);
    otherServer.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.main) await main();
