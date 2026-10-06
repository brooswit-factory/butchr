/**
 * FACTORY-664: real-browser pass of the Settings page. Drives headless Chromium (raw CDP over a
 * WebSocket, no npm dependency) against the REAL `liveView` routes and the BUILT dashboard-app
 * (`bun run build:web` first) with isolated, in-memory fake dependencies — a fake env snapshot
 * carrying a sentinel secret, the real write guard/CSRF/audit wiring, and a STUB Atlassian server
 * on a local port that the Jira connection test calls instead of the real Atlassian API. NEVER a
 * daemon, never the shared herdr or `~/.config/butchr`. Modeled on, and copying verbatim, the
 * hardened Chromium lifecycle of `scripts/verify-rules-page-browser.ts` (setsid, process-group
 * SIGKILL on exit/error/signal, DevTools port 0, no `--remote-allow-origins`, profile dir removed,
 * nothing left running).
 *
 * NOTE: run `bun run build:web` IMMEDIATELY before (a full `bun test` run leaves a different,
 * fixture-mode build in dist/web that this script must not use).
 * Usage: bun run build:web && CHROME=/usr/bin/chromium bun run scripts/verify-settings-page-browser.ts
 * (screenshots land next to the temp dir it prints; exit code 1 if any check fails).
 */
import { mkdtempSync, rmSync, writeFileSync as wf } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpHandle } from "@brooswit/thatch";
import { liveView, type ViewDeps } from "../src/web/view.js";
import { createCsrfTokenIssuer } from "../src/web/csrf.js";
import { isSameUidPeer } from "../src/web/peer-uid.js";
import { createAuditLogger } from "../src/web/audit-log.js";
import { createWriteRateLimiter } from "../src/web/write-rate-limit.js";
import { buildSettingsApiResponse } from "../src/web/settings-api.js";
import { testJiraConnection } from "../src/web/jira-connection-test.js";
import { listenOptions } from "../src/daemon/listen.js";

async function main(): Promise<void> {

const S = process.env.S ?? mkdtempSync(join(tmpdir(), "butchr-settings-e2e-"));
const CHROME = process.env.CHROME ?? "/usr/bin/chromium";

// A stub Atlassian server: /rest/api/3/myself answers 200, 401, or hangs
// (to exercise the network/timeout path), switchable via `stubMode`.
const SECRET_SENTINEL = "sentinel-atlassian-token-should-never-be-visible-xyz123";
let stubMode: "ok" | "401" | "hang" = "ok";
const stub = Bun.serve({
  port: 0,
  fetch(req) {
    if (stubMode === "hang") return new Promise<Response>(() => {}); // never resolves — exercises the client's own timeout path is NOT exercised here (10s is too slow for this script); used only to prove the button shows a result and doesn't crash while pending.
    if (stubMode === "401") return new Response(JSON.stringify({ errorMessages: ["unauthorized"] }), { status: 401 });
    return new Response(JSON.stringify({ accountId: "stub-account", emailAddress: "butchr@example.com" }), { status: 200 });
  },
});
const stubSite = `http://127.0.0.1:${stub.port}`;

const env = { ATLASSIAN_SITE: stubSite, ATLASSIAN_EMAIL: "butchr@example.com", ATLASSIAN_TOKEN: SECRET_SENTINEL, BUTCHR_PORT: "0", BUTCHR_MAX_AGENTS: "8" };

const auditLines: unknown[] = [];
const auditWrite = createAuditLogger({ append: () => {}, postAlert: undefined, host: "codey", log: () => {} });
const csrf = createCsrfTokenIssuer();
const guard = { port: 0 };
const peerUidCheck = (client: { address: string; port: number }) => isSameUidPeer(client, { server: { address: "127.0.0.1", port: guard.port } });
const jiraTestRateLimit = createWriteRateLimiter({ windowMs: 5_000, max: 1 });
const fakeMcp = { connections: { list: () => [] } } as unknown as McpHandle;
const unused = () => { throw new Error("unused"); };

const deps = {
  state: async () => [], open: unused, openPane: unused, health: () => ({ ok: true }),
  dashboard: async () => ({ checked: true, confirmedAt: new Date(0).toISOString(), rows: [], admission: { cap: 0, residency: null, sentinels: null, sources: [] } }),
  header: () => ({ build: { sha: null, shaDirty: null, shaUnknownReason: "x", version: "0.0.0", versionProvenance: "tag", versionUnknownReason: null } }),
  resourceLink: unused,
  configInventory: async () => ({ rules: [], sessionDefinitions: [], errors: [] }),
  dashboardAppRoot: join(import.meta.dir, "..", "dist", "web"),
  dashboardOriginGuard: guard, peerUidCheck, csrf, writeGuard: { dashboardOriginGuard: guard, peerUidCheck, csrf },
  auditWrite: (e: unknown) => { auditLines.push(e); (auditWrite as unknown as (e: unknown) => void)(e as never); },
  settings: () => buildSettingsApiResponse(env, { unitHint: () => Promise.resolve(undefined) }),
  jiraTest: () => testJiraConnection({ site: env.ATLASSIAN_SITE, email: env.ATLASSIAN_EMAIL, token: env.ATLASSIAN_TOKEN }),
  jiraTestRateLimit,
} as unknown as ViewDeps;

const app = liveView(fakeMcp, deps);
app.listen(listenOptions(0));
const port = app.server!.port!;
guard.port = port;

const prof = mkdtempSync(join(S, "chrome-prof-"));
const chrome = Bun.spawn(["setsid", CHROME, "--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run", "--remote-debugging-port=0", `--user-data-dir=${prof}`, "about:blank"], { stdout: "ignore", stderr: "ignore" });
let cleaned = false;
const cleanup = (): void => {
  if (cleaned) return;
  cleaned = true;
  try { process.kill(-chrome.pid, "SIGKILL"); } catch { /* already gone */ }
  try { chrome.kill(9); } catch { /* already gone */ }
  try { rmSync(prof, { recursive: true, force: true }); } catch { /* best effort */ }
  try { stub.stop(true); } catch { /* best effort */ }
};
process.on("exit", cleanup);
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { cleanup(); process.exit(130); });

let dbg = 0;
for (let i = 0; i < 80 && dbg === 0; i++) {
  try { dbg = Number((await Bun.file(join(prof, "DevToolsActivePort")).text()).split("\n")[0]) || 0; } catch { await Bun.sleep(250); }
}
if (dbg === 0) { cleanup(); throw new Error("chromium did not report a DevTools port"); }
for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://127.0.0.1:${dbg}/json/version`)).ok) break; } catch {} await Bun.sleep(250); }
const tab = await (await fetch(`http://127.0.0.1:${dbg}/json/new?about:blank`, { method: "PUT" })).json() as any;
const ws = new WebSocket(tab.webSocketDebuggerUrl); await new Promise<void>((res) => { ws.onopen = () => res(); });
let id = 0; const pending = new Map<number, (v: any) => void>(); let loaded: () => void = () => {}; let loadedP = new Promise<void>((r) => { loaded = r; });
ws.onmessage = (ev) => { const m = JSON.parse(String(ev.data)); if (m.id && pending.has(m.id)) { pending.get(m.id)!(m.result ?? m); pending.delete(m.id); } else if (m.method === "Page.loadEventFired") loaded(); };
const send = (method: string, params: any = {}) => new Promise<any>((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
await send("Page.enable"); await send("Runtime.enable");

const shot = async (name: string) => { const r = await send("Page.captureScreenshot", { format: "png" }); wf(join(S, `settings-e2e-${name}.png`), Buffer.from(r.data, "base64")); };
const ev = async (js: string) => { const r = await send("Runtime.evaluate", { expression: js, awaitPromise: true, returnByValue: true }); return r.result?.value ?? { exception: r.exceptionDetails?.text }; };
const until = async (what: string, js: string, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await ev(js); if (v === true) return true; await Bun.sleep(150); } console.log("TIMEOUT waiting for:", what); return false; };
let fails = 0; const check = (label: string, ok: boolean, detail = "") => { console.log((ok ? "PASS " : "FAIL ") + label + (detail ? "  " + detail : "")); if (!ok) fails++; };
// `.click()` (not synthetic CDP mouse coordinates) — react-aria's Button listens for pointer
// events that a bare Input.dispatchMouseEvent sequence does not reliably synthesize across
// headless Chrome versions; `.click()` still exercises the real onPress wiring end to end.
const clickBtn = async (text: string) => ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim().toLowerCase() === ${JSON.stringify(text.toLowerCase())} && !x.disabled); if (!b) return false; b.click(); return true; })()`);

await send("Page.addScriptToEvaluateOnNewDocument", { source: "window.__errs=[];const ce=console.error;console.error=(...a)=>{__errs.push(a.map(String).join(' ').slice(0,500));ce(...a)};addEventListener('error',e=>__errs.push('ERR '+e.message));addEventListener('unhandledrejection',e=>__errs.push('REJ '+String(e.reason)))" });
await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });

// A: page renders, secrets never shown
await send("Page.navigate", { url: `http://127.0.0.1:${port}/dashboard-app/settings` }); await Promise.race([loadedP, Bun.sleep(8000)]);
check("A1 the settings page renders the settings table", await until("settings-table", `!!document.querySelector('[data-testid=settings-table]')`));
await Bun.sleep(600); await shot("1-initial");
const bodyHtml = await ev(`document.documentElement.outerHTML`);
check("A2 the ATLASSIAN_TOKEN secret value never appears anywhere in the rendered DOM", typeof bodyHtml === "string" && !bodyHtml.includes(SECRET_SENTINEL));
check("A3 the secret row shows 'set', not a value", await ev(`[...document.querySelectorAll('[data-testid=setting-row]')].some(r => r.getAttribute('data-setting-key') === 'ATLASSIAN_TOKEN' && r.querySelector('[data-testid=setting-value]').textContent.trim() === 'set')`) === true);
check("A4 the Jira connection card is rendered", await until("jira-card", `!!document.querySelector('[data-testid=jira-connection-card]')`));
check("A5 the secret never appears in the raw network response either", !((await (await fetch(`http://127.0.0.1:${port}/api/settings`, { headers: { host: `127.0.0.1:${port}`, "sec-fetch-site": "same-origin" } })).text()).includes(SECRET_SENTINEL)));

// B: Test connection against the stub — ok
stubMode = "ok";
check("B1 click Test connection", await clickBtn("Test connection"));
check("B2 the result shows 'connected' for a 2xx stub response", await until("connected", `(document.querySelector('[data-testid=jira-test-result]')?.textContent ?? '').includes('connected')`));
await shot("2-connected");

// C: Test connection against the stub — 401 (fixed error string, never the upstream body)
stubMode = "401";
await Bun.sleep(5200); // clear the 1-per-5s rate limit window from test B
check("C1 click Test connection again", await clickBtn("Test connection"));
check("C2 the result shows 401/403, not the stub's own error body text", await until("401", `(document.querySelector('[data-testid=jira-test-result]')?.textContent ?? '').includes('401/403')`));
check("C3 the stub's own error body text never reaches the UI", !((await ev(`document.querySelector('[data-testid=jira-test-result]')?.textContent ?? ''`) as string).includes("unauthorized")));
await shot("3-unauthorized");

// D: rate limit — a third click inside the 5s window is refused
stubMode = "ok";
check("D1 click Test connection a third time, inside the 5s window", await clickBtn("Test connection"));
check("D2 the result shows a rate-limit message", await until("rate limited", `(document.querySelector('[data-testid=jira-test-result]')?.textContent ?? '').toLowerCase().includes('rate limited')`));
await shot("4-rate-limited");

console.log("   page errors:", JSON.stringify(await ev("window.__errs")).slice(0, 1500));
console.log(`\nSUMMARY: ${fails === 0 ? "ALL PASS" : fails + " FAILED"}  (screenshots: ${S}/settings-e2e-*.png)`);
ws.close(); cleanup(); app.stop(true); process.exit(fails === 0 ? 0 : 1);

}

if (import.meta.main) await main();
