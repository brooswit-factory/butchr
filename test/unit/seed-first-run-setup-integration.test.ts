/**
 * FACTORY-716 (fixing FACTORY-705/FACTORY-715) — the REAL setup-then-restart
 * path: drive the actual `POST /api/setup/jira` HTTP route (setup-code
 * mint, CSRF, the real write-guard chain, the real `handleJiraTokenWrite` +
 * `writeJiraIdentity`), exactly as a browser would, then spawn the REAL
 * daemon entry (`bun src/daemon/index.ts`, not a re-assembled view) a
 * SECOND time against the SAME scratch `XDG_CONFIG_HOME` the setup route
 * just wrote to — the actual "restart" FACTORY-705 diagnosed.
 *
 * This is the acceptance-criterion-1 test: a unit test that only calls
 * `seedFirstRunRules` against a HAND-BUILT directory does not discharge it
 * (see `test/unit/seed-first-run.test.ts` for that narrower coverage) —
 * the directory state here comes entirely from the real setup write path,
 * not from this test fabricating files.
 *
 * `src/daemon/index.ts`'s startup reaches `legacyAgentPreflight` (lists live
 * herdr agents over a unix socket) AFTER the seed decision and its log
 * line. This test's spawn sets `HERDR_SOCKET` to `<scratch home>/no-such-
 * herdr.sock` — a path under this test's own `mkdtempSync` home that
 * nothing ever listens on — so the preflight connect is STRUCTURALLY
 * guaranteed to fail closed: this test can never reach a real herdr
 * session, in this workspace or any other, regardless of whether one
 * happens to be running alongside it. (Leaving `HERDR_SOCKET` unset would
 * fall back to whatever default socket `DrovrClient`/`HerdrClient`
 * discovers — a REAL socket in a live butchr-factory workspace, exactly
 * the ambient coupling the review blocker on this ticket called out.)
 * `legacyAgentPreflight`'s catch branch (`src/daemon/legacy-preflight.ts`)
 * turns that failed connect into the "Start herdr and retry." refusal
 * asserted below — a separate, unrelated reason the process exits, not a
 * silent "it died, who knows why" — and the seed's own startup log line
 * (printed before that preflight ever runs) is read instead of the rules
 * HTTP API.
 * The rules FILE the real spawn's REAL seed call wrote is also read back
 * with the real `loadRules` — the same data `GET /api/rules` itself is
 * built from (`src/daemon/index.ts`'s `configInventory`/`rulesFileState`).
 *
 * Modeled on `test/unit/setup-mode-entry.test.ts` (the existing real-entry
 * spawn/drive helpers) and `scripts/verify-setup-flow-browser.ts` (the
 * existing in-process setup-mode drive, including its `fetchFn` trick for
 * redirecting the outbound Jira token test to a local stub while the
 * persisted site value stays real-looking).
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
import { loadRules } from "../../src/rules/rules.js";

function freePort(): number {
  const s = Bun.serve({ port: 0, fetch: () => new Response("") });
  const p = s.port as number;
  s.stop(true);
  return p;
}

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

    // The "restart": the REAL daemon entry, spawned a second time against
    // the SAME scratch config dir — no in-memory state carried over from
    // the setup-mode app above, nothing hand-built by this test. By now the
    // config dir holds exactly what the real setup route just wrote
    // (jira-identity.json, secrets/atlassian-token, web-write-audit.jsonl):
    // the post-setup state FACTORY-705 diagnosed.
    const port2 = freePort();
    // `HERDR_SOCKET` points at a path under this test's own scratch `home`
    // that nothing listens on — see this file's header. This makes the
    // preflight connect fail closed deterministically, so the spawn always
    // exits at `legacyAgentPreflight` rather than racing against whether a
    // real herdr socket happens to be reachable in this process's ambient
    // environment.
    const herdrSocket = join(home, "no-such-herdr.sock");
    const proc = Bun.spawn(["bun", "src/daemon/index.ts"], {
      cwd: join(import.meta.dir, "../.."),
      env: { PATH: process.env.PATH ?? "", HOME: home, XDG_CONFIG_HOME: configDir, BUTCHR_PORT: String(port2), HERDR_SOCKET: herdrSocket },
      stdout: "pipe",
      stderr: "pipe",
    });
    let stderrSoFar = "";
    const drainStderr = (async () => {
      const reader = proc.stderr.getReader();
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) stderrSoFar += decoder.decode(value);
        }
      } finally {
        reader.releaseLock();
      }
    })();

    try {
      // `HERDR_SOCKET` (set above) is structurally unreachable, so the
      // spawn always exits at `legacyAgentPreflight`, AFTER the seed
      // decision + its log line. Assert the exit is for EXACTLY that
      // separate, unrelated reason (not a silent "it died, who knows why")
      // and read the seed's own startup log line, printed before that
      // preflight ever runs.
      await proc.exited;
      await drainStderr;
      expect(stderrSoFar).toContain("first run — seeded");
      expect(stderrSoFar).toContain(FIRST_RULE_ID);
      // Acceptance criterion 3: the misleading hand-edit guidance is gone
      // from this path.
      expect(stderrSoFar).not.toContain("add a rules file");
      expect(stderrSoFar).not.toContain("config-dir-not-empty");
      expect(proc.exitCode).toBe(1);
      expect(stderrSoFar).toContain("Start herdr and retry");
    } finally {
      proc.kill();
      await proc.exited;
      await drainStderr;
    }

    // `GET /api/rules`'s own `rules` array is built directly from
    // `loadRules()`/`getRules()` (`src/daemon/index.ts`'s
    // `configInventory`/`rulesFileState`) — reading the rules file the
    // second spawn's REAL seed call just wrote, with the real `loadRules`,
    // checks exactly what that route would report.
    const restartEnv = { XDG_CONFIG_HOME: configDir } as Record<string, string | undefined>;
    const { rules, origin: rulesOrigin } = loadRules(restartEnv);
    expect(rulesOrigin).toBe("file");
    const starter = rules.find((r) => r.id === FIRST_RULE_ID);
    expect(starter).toBeDefined();
    expect(starter?.enabled).toBe(false);
    expect(starter?.resourceProvider).toBe("jira-work");
    expect(starter?.execution).toBe("swarm");

    rmSync(home, { recursive: true, force: true });
  }, 30_000);
});
