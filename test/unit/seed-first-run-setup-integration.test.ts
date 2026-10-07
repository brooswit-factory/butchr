/**
 * FACTORY-716 (fixing FACTORY-705/FACTORY-715) — the REAL setup-then-restart
 * path: drive the actual `POST /api/setup/jira` HTTP route (setup-code
 * mint, CSRF, the real write-guard chain, the real `handleJiraTokenWrite` +
 * `writeJiraIdentity`), exactly as a browser would, then replay the EXACT
 * sequence `src/daemon/index.ts`'s own startup runs on its next start
 * (`resolveEffectiveJiraEnv` -> `isAtlassianConfigured` -> `loadConfig` ->
 * `seedFirstRunRules` -> `loadRules`, every one the real, unmodified
 * production function) against the SAME scratch `XDG_CONFIG_HOME` the setup
 * route just wrote to, and assert the starter rule comes back exactly as
 * `GET /api/rules` would report it (that route's own `rules` array is
 * built directly from this same `loadRules()`/`getRules()` result — see
 * `src/daemon/index.ts`'s `configInventory`/`rulesFileState`).
 *
 * This is the acceptance-criterion-1 test: a unit test that only calls
 * `seedFirstRunRules` against a HAND-BUILT directory does not discharge it
 * (see `test/unit/seed-first-run.test.ts` for that narrower coverage) —
 * the directory state here comes entirely from the real setup write path,
 * not from this test fabricating files.
 *
 * Modeled on `test/unit/setup-mode-entry.test.ts` (the existing real-entry
 * spawn/drive helpers) and `scripts/verify-setup-flow-browser.ts` (the
 * existing in-process setup-mode drive, including its `fetchFn` trick for
 * redirecting the outbound Jira token test to a local stub while the
 * persisted site value stays real-looking, and its own precedent for
 * proving "a restart actually leaves setup mode" via a FRESH call into the
 * real `loadConfig`/`isAtlassianConfigured` rather than a second spawned
 * OS process).
 *
 * NOT spawned as a second full `bun src/daemon/index.ts` process in normal
 * mode: that startup path also runs `legacyAgentPreflight`, which requires
 * a live herdr unix socket this test suite has no fixture for anywhere
 * (confirmed: no existing test spawns the real daemon entry past setup
 * mode) — an orthogonal infra dependency, not something this ticket's seed
 * module or its one call site touches. `test/unit/setup-mode-entry.test.ts`
 * itself only ever spawns the entry INTO setup mode for exactly this
 * reason. Replaying the real functions index.ts calls, in the same order,
 * against the real on-disk state setup just wrote, proves the actual fix
 * (the seed no longer declining on setup's own output) without that
 * unrelated dependency.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpHandle } from "@brooswit/thatch";
import { liveView } from "../../src/web/view.js";
import { buildSetupModeViewDeps } from "../../src/daemon/setup-mode.js";
import { FIRST_RULE_ID } from "../../src/rules/rules-write-registry.js";
import { CSRF_HEADER } from "../../src/web/csrf.js";
import { resolveEffectiveJiraEnv } from "../../src/config/effective-env.js";
import { isAtlassianConfigured, loadConfig } from "../../src/config/config.js";
import { seedFirstRunRules } from "../../src/rules/seed-first-run.js";
import { loadRules } from "../../src/rules/rules.js";
import { readFileSync } from "node:fs";

const fakeMcp = { connections: { list: () => [] } } as unknown as McpHandle;

describe("FACTORY-716: real setup-then-restart seeds the starter rule", () => {
  test("after the real POST /api/setup/jira flow, the real daemon-startup sequence (same functions, same order as src/daemon/index.ts) seeds the starter rule and GET /api/rules's own data source lists it, disabled", async () => {
    const home = mkdtempSync(join(tmpdir(), "butchr-seed-setup-e2e-"));
    const configDir = join(home, "cfg");

    // A stub Atlassian server standing in for `GET /rest/api/3/myself` — same
    // technique `scripts/verify-setup-flow-browser.ts` uses, never a real
    // outbound call.
    const stub = Bun.serve({
      port: 0,
      fetch(req) {
        if (new URL(req.url).pathname !== "/rest/api/3/myself") return new Response("not found", { status: 404 });
        return new Response(JSON.stringify({ accountId: "seed-e2e-account-1", displayName: "Seed E2E Operator" }), { status: 200 });
      },
    });
    const fakeSite = "https://butchr-seed-e2e-test.atlassian.net";
    const candidateToken = "seed-e2e-token";
    const fetchFn = (async (url: string, init: RequestInit) => {
      const u = new URL(url);
      if (u.hostname === "butchr-seed-e2e-test.atlassian.net") return fetch(`http://127.0.0.1:${stub.port}${u.pathname}${u.search}`, init);
      return fetch(url, init);
    }) as typeof fetch;

    const env = { XDG_CONFIG_HOME: configDir, BUTCHR_PORT: "0" };
    const { viewDeps, setupCodeManager } = buildSetupModeViewDeps(0, env, () => {}, fetchFn);
    const setupCode = setupCodeManager.mint();

    // Same precedent as `test/unit/setup-mode.test.ts`: `isSameUidPeer`'s
    // real `/proc/net/tcp` lookup is exercised by its own dedicated test
    // (`test/unit/peer-uid.test.ts`), not re-proven here — stubbed to `true`
    // so this test exercises the setup ROUTE/guard-chain/write logic itself.
    viewDeps.peerUidCheck = () => true;
    if (viewDeps.writeGuard) viewDeps.writeGuard.peerUidCheck = () => true;

    const app = liveView(fakeMcp, viewDeps);
    app.listen(0);
    const port = app.server!.port!;
    (viewDeps.dashboardOriginGuard as { port: number }).port = port;
    const origin = `http://127.0.0.1:${port}`;
    const headers = { origin, host: `127.0.0.1:${port}` };

    try {
      // Real route, real guard chain: mint a CSRF token the way the dashboard does.
      const sessionRes = await fetch(`${origin}/api/session`, { headers });
      expect(sessionRes.status).toBe(200);
      const { csrfToken } = (await sessionRes.json()) as { csrfToken: string };

      // Real `POST /api/setup/jira` — site/email/token/setupCode, through the
      // full write-guard chain (origin/host/peer-uid/content-type/CSRF),
      // exactly as the real UI submits it. This is what persists the
      // identity file + managed token into `configDir/butchr/` AND appends
      // the write-audit log (`web-write-audit.jsonl`) there — all three of
      // which are now on `seedFirstRunRules`'s `setupWriteAllowlist`.
      const setupRes = await fetch(`${origin}/api/setup/jira`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json", [CSRF_HEADER]: csrfToken },
        body: JSON.stringify({ site: fakeSite, email: "seed-e2e@example.com", token: candidateToken, setupCode }),
      });
      expect(setupRes.status).toBe(200);
      const setupBody = (await setupRes.json()) as { ok: boolean; identityPersisted: boolean; restarting?: boolean };
      expect(setupBody.ok).toBe(true);
      expect(setupBody.identityPersisted).toBe(true);
      expect(setupBody.restarting).toBe(true);
    } finally {
      app.stop(true);
      stub.stop(true);
    }

    // The "restart": the exact production sequence `src/daemon/index.ts`
    // itself runs, in the same order, against the SAME scratch
    // `XDG_CONFIG_HOME` — no in-memory state carried over from the
    // setup-mode app above, nothing hand-built by this test.
    const restartEnv = { XDG_CONFIG_HOME: configDir } as Record<string, string | undefined>;
    const effectiveJiraEnv = resolveEffectiveJiraEnv(restartEnv);
    expect(isAtlassianConfigured(effectiveJiraEnv)).toBe(true); // the actual restart-leaves-setup-mode claim
    const config = loadConfig(effectiveJiraEnv, (p) => readFileSync(p, "utf8"));
    expect(config.atlassian.site).toBe(fakeSite);
    expect(config.atlassian.token).toBe(candidateToken);

    // FACTORY-716's own fix, against real on-disk state the real setup
    // route wrote — not a hand-built directory.
    const seedOutcome = seedFirstRunRules(effectiveJiraEnv);
    expect(seedOutcome.kind).toBe("seeded");

    // `GET /api/rules`'s own `rules` array is built directly from this same
    // `loadRules()`/`getRules()` result (`src/daemon/index.ts`'s
    // `configInventory`/`rulesFileState`) — checking it here checks exactly
    // what that route would report.
    const { rules, origin: rulesOrigin } = loadRules(effectiveJiraEnv);
    expect(rulesOrigin).toBe("file");
    const starter = rules.find((r) => r.id === FIRST_RULE_ID);
    expect(starter).toBeDefined();
    expect(starter?.enabled).toBe(false);
    expect(starter?.resourceProvider).toBe("jira-work");
    expect(starter?.execution).toBe("swarm");

    rmSync(home, { recursive: true, force: true });
  }, 30_000);
});
