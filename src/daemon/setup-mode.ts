/**
 * FACTORY-665 (PR-2) — the daemon's SETUP MODE: entered by `src/daemon/
 * index.ts` instead of the real daemon startup whenever `isAtlassianConfigured`
 * (`../config/config.ts`) is false, so a fresh install never throws at
 * startup over missing Jira identity. Serves ONLY: `/health`, the dashboard
 * shell/static assets, `GET /api/setup/status`, and `POST /api/setup/jira`
 * — no Jira polling loop, no agent spawning, nothing else `buildApp`/
 * `liveView` (`./app.ts`, `../web/view.ts`) would otherwise wire up, because
 * every OTHER `ViewDeps` field is simply left undefined here (the existing
 * "absent dep -> 503" discipline every route in `view.ts` already follows —
 * this module adds no new rule, it just supplies a much smaller deps object
 * than the real daemon's own startup does).
 *
 * Prints the one-time setup code to the journal (via `log`, i.e. stdout/
 * stderr under systemd) ONCE at startup, and installs the `SIGUSR2` handler
 * so a later code can be minted without a restart — see `../setup/setup-
 * code.ts`'s own header. After a successful `POST /api/setup/jira`, the
 * daemon is still running in setup mode (this module never restarts
 * itself) — the UI's own "restart needed" messaging, plus PR-1's restart
 * control, is how an operator actually leaves this mode.
 *
 * `buildSetupModeViewDeps`'s optional `fetchFn` is for
 * `scripts/verify-setup-flow-browser.ts` only: site-shape validation
 * (`validateAtlassianSiteShape`) correctly refuses anything but a real
 * `https://<name>.atlassian.net`, so a real-browser test that must still
 * reach a local stub server redirects the OUTBOUND call via an injected
 * `fetchFn` while the SITE VALUE recorded/persisted stays a real-looking
 * hostname — production never passes this (defaults to the global `fetch`).
 */
import type { HealthStatus } from "./health.js";
import { buildApp } from "./app.js";
import type { ViewDeps } from "../web/view.js";
import { listenOptions, DAEMON_HOSTNAME } from "./listen.js";
import { parsePort, type ConfigEnv } from "../config/config.js";
import { isSameUidPeerAsync } from "../web/peer-uid.js";
import { createCsrfTokenIssuer } from "../web/csrf.js";
import { createWriteRateLimiter } from "../web/write-rate-limit.js";
import { createAuditLogger, fileAuditAppend, WEB_WRITE_AUDIT_LOG_BASENAME } from "../web/audit-log.js";
import { buildSetupStatus, handleJiraTokenWrite } from "../web/setup-api.js";
import { createSetupCodeManager, installSetupCodeSigusr2Handler } from "../setup/setup-code.js";
import { jiraTokenFilePath, type FetchLike } from "../setup/jira-token-write.js";
import { rulesPath } from "../rules/rules.js";
import { join, dirname } from "node:path";
import { hostname } from "node:os";

export interface SetupModeDeps {
  env?: ConfigEnv & Record<string, string | undefined>;
  log?: (line: string) => void;
}

/**
 * Pure(ish) builder: everything `runSetupModeDaemon` needs EXCEPT the
 * actual `app.listen(...)` call, so tests exercise the exact same route
 * wiring/deps the real daemon uses, via `liveView`/`app.handle()`, with no
 * real network listener required. `port` is taken explicitly (rather than
 * re-parsed from `env`) so a test can pick an arbitrary value without
 * fighting `BUTCHR_PORT` parsing.
 */
export function buildSetupModeViewDeps(port: number, env: ConfigEnv & Record<string, string | undefined>, log: (line: string) => void, fetchFn?: FetchLike, onSetupComplete: () => void = () => {}): { viewDeps: ViewDeps; setupCodeManager: ReturnType<typeof createSetupCodeManager> } {
  const setupCodeManager = createSetupCodeManager();

  // `dashboardOriginGuard.port` is read FRESH on every `peerUidCheck` call
  // (never captured by value) so a caller that passes `port: 0` here and
  // learns the OS-assigned real port only after `.listen()` can still
  // mutate `dashboardOriginGuard.port` afterward and have it take effect —
  // same discipline `scripts/verify-settings-page-browser.ts`'s own
  // `peerUidCheck` already follows (a dynamic port, previously baked into
  // this closure by value, silently broke the real-uid peer check for
  // exactly that case, caught by `scripts/verify-setup-flow-browser.ts`).
  const dashboardOriginGuard = { port };
  const peerUidCheck = (client: { address: string; port: number }) => isSameUidPeerAsync(client, { server: { address: DAEMON_HOSTNAME, port: dashboardOriginGuard.port } });
  const csrfIssuer = createCsrfTokenIssuer();
  const writeGuard = { dashboardOriginGuard, peerUidCheck, csrf: csrfIssuer };

  // Same audit-log destination/filename the real daemon uses (`index.ts`) —
  // one shared file under the XDG config dir, alongside everything else.
  // `postAlert` is omitted: setup mode has no Rocket.Chat credential loaded
  // (that requires the very configuration this mode exists to not require
  // yet) — the audit file and journal `log` line still happen either way.
  const auditLogPath = join(dirname(rulesPath(env)), WEB_WRITE_AUDIT_LOG_BASENAME);
  const auditWrite = createAuditLogger({ append: fileAuditAppend(auditLogPath), host: hostname(), log });

  const unused = (): never => { throw new Error("unused in setup mode"); };
  const viewDeps: ViewDeps = {
    state: async () => [],
    open: unused,
    openPane: unused,
    health: () => ({ ok: false, components: [], setupMode: true } as HealthStatus & { setupMode: true }), // 503 on purpose: not a working daemon yet
    dashboard: async () => ({ checked: false, declinedAt: new Date().toISOString(), rows: [], admission: { cap: 0, residency: null, sentinels: null, sources: [] } }),
    header: () => ({ build: null }),
    resourceLink: async () => ({ ok: false, error: "not configured (setup mode)" }),
    configInventory: async () => ({ rules: [], sessionDefinitions: [], errors: [] }),

    dashboardOriginGuard,
    peerUidCheck,
    csrf: csrfIssuer,
    writeGuard,
    auditWrite,

    setupStatus: () => buildSetupStatus(false),
    setupJiraWrite: async (input, rateGate) => {
      const result = await handleJiraTokenWrite(
        { ...input },
        { setupCode: setupCodeManager, path: jiraTokenFilePath(env), env, ...(fetchFn ? { fetchFn } : {}) },
        { requireEnvCheck: false, ...(rateGate ? { rateGate } : {}) },
      );
      if (!result.ok) return result;
      // Setup is complete: leave setup mode WITHOUT a shell. The response goes out first, then onSetupComplete
      // exits non-zero so the supervisor (systemd Restart=, launchd KeepAlive) starts the daemon in normal mode.
      // Only when the site/email were persisted durably: a restart without them would just land back in setup mode.
      if (!result.body.identityPersisted) return result;
      onSetupComplete();
      return { ...result, body: { ...result.body, restarting: true } };
    },
    jiraTokenTestRateLimit: createWriteRateLimiter({ windowMs: 10 * 60_000, max: 5 }),
    jiraTokenWriteRateLimit: createWriteRateLimiter({ windowMs: 60 * 60_000, max: 3 }),
  };

  return { viewDeps, setupCodeManager };
}

/**
 * Starts the minimal setup-mode server and returns once it is listening —
 * never resolves further on its own (same "runs forever" contract the real
 * daemon's own `app.listen(...)` call has); the caller (`index.ts`)
 * `process.exit(1)`s only if THIS function itself throws during startup.
 */
export async function runSetupModeDaemon(deps: SetupModeDeps = {}): Promise<void> {
  const env = deps.env ?? (process.env as ConfigEnv & Record<string, string | undefined>);
  const log = deps.log ?? ((line: string) => console.error(line));
  const port = parsePort(env);

  const { viewDeps, setupCodeManager } = buildSetupModeViewDeps(port, env, log, undefined, () => {
    log("butchr: setup complete — exiting so the supervisor restarts butchr in normal mode (a process started by hand must be started again).");
    setTimeout(() => process.exit(1), 1500);
  });

  log(`butchr: starting in SETUP MODE — no Atlassian identity configured yet.`);
  const initialCode = setupCodeManager.mint();
  log(`butchr: setup code (10 min, single-use, 5 attempts): ${initialCode}`);
  log(`butchr: open the dashboard and enter this code to configure Jira; mint a fresh one any time with: kill -SIGUSR2 ${process.pid} (or: systemctl --user kill -s SIGUSR2 butchr.service)`);
  installSetupCodeSigusr2Handler(setupCodeManager, log);

  const { app } = buildApp(viewDeps, {}, log);
  app.listen(listenOptions(port));
  log(`butchr: setup mode listening on http://${DAEMON_HOSTNAME}:${port} — serving /health, the dashboard shell, and the setup API only.`);
}
