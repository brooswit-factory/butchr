/**
 * FACTORY-665 (PR-2): real-browser pass of the Setup flow. Drives headless Chromium (raw CDP
 * over a WebSocket, no npm dependency) against the REAL setup-mode app (`buildSetupModeViewDeps`,
 * `src/daemon/setup-mode.ts`) and the BUILT dashboard-app (`bun run build:web` first), with a
 * scratch `XDG_CONFIG_HOME` (never the shared herdr or the real `~/.config/butchr`) and a STUB
 * Atlassian server standing in for `GET /rest/api/3/myself`. Modeled on, and copying verbatim,
 * the hardened Chromium lifecycle of `scripts/verify-settings-page-browser.ts`/
 * `verify-rules-page-browser.ts` (setsid, process-group SIGKILL on exit/error/signal, DevTools
 * port 0, no `--remote-allow-origins`, profile dir removed, nothing left running).
 *
 * Flow proven end to end: unconfigured start (the App shows the Setup page, not the normal nav) →
 * the setup code is read from the CAPTURED journal/stdout line (this script's own injected `log`
 * callback — the exact mechanism `runSetupModeDaemon` uses against the real journal under
 * systemd) → submitted through the real UI (site/email/token/setup-code fields) → the candidate
 * token is tested against the stub Atlassian server and the write succeeds → the UI shows
 * "Restart needed" → a SIMULATED restart (a fresh `resolveEffectiveJiraEnv` + `loadConfig` call
 * against the SAME scratch `XDG_CONFIG_HOME`, with NO in-memory state reused from the setup-mode
 * app this script just drove) proves the persisted site/email/token file alone are enough for
 * `isAtlassianConfigured`/`loadConfig` to succeed — the actual gap this ticket closes.
 *
 * NOTE: run `bun run build:web` IMMEDIATELY before (a full `bun test` run leaves a different,
 * fixture-mode build in dist/web that this script must not use).
 * Usage: bun run build:web && CHROME=/usr/bin/chromium bun run scripts/verify-setup-flow-browser.ts
 * (screenshots land next to the temp dir it prints; exit code 1 if any check fails).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync as wf } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpHandle } from "@brooswit/thatch";
import { liveView } from "../src/web/view.js";
import { buildApp } from "../src/daemon/app.js";
import { buildSetupModeViewDeps } from "../src/daemon/setup-mode.js";
import { listenOptions } from "../src/daemon/listen.js";
import { isAtlassianConfigured, loadConfig } from "../src/config/config.js";
import { resolveEffectiveJiraEnv } from "../src/config/effective-env.js";

async function main(): Promise<void> {

const S = process.env.S ?? mkdtempSync(join(tmpdir(), "butchr-setup-e2e-"));
const CHROME = process.env.CHROME ?? "/usr/bin/chromium";
const CONFIG_DIR = mkdtempSync(join(S, "xdg-"));

// A stub Atlassian server: /rest/api/3/myself answers 200 with a fixed
// identity — real enough for `testCandidateJiraToken`'s own parsing
// (`accountId`/`displayName`), never a real network call.
const CANARY_TOKEN = "sentinel-setup-token-should-never-be-visible-xyz789";
const stub = Bun.serve({
  port: 0,
  fetch(req) {
    if (new URL(req.url).pathname !== "/rest/api/3/myself") return new Response("not found", { status: 404 });
    return new Response(JSON.stringify({ accountId: "stub-account-1", displayName: "Stub Operator", emailAddress: "butchr@example.com" }), { status: 200 });
  },
});
// The SITE submitted through the UI must satisfy `validateAtlassianSiteShape`
// (exactly `https://<name>.atlassian.net`) — a bare `http://127.0.0.1:PORT`
// no longer passes, which is the whole point of that validation. `fetchFn`
// below redirects the SERVER-SIDE outbound call this hostname triggers to
// the local stub, while the site VALUE recorded/persisted stays real-looking.
const fakeSite = "https://butchr-e2e-test.atlassian.net";
const fetchFn = (async (url: string, init: RequestInit) => {
  const u = new URL(url);
  if (u.hostname === "butchr-e2e-test.atlassian.net") return fetch(`http://127.0.0.1:${stub.port}${u.pathname}${u.search}`, init);
  return fetch(url, init);
}) as typeof fetch;

// The "captured journal" — exactly what `runSetupModeDaemon` would hand
// `console.error` under systemd, captured here instead so this script can
// read the setup code the same way an operator reads it off `journalctl`.
const journal: string[] = [];
const log = (line: string) => { journal.push(line); console.log("[journal]", line); };

const env = { XDG_CONFIG_HOME: CONFIG_DIR, BUTCHR_PORT: "0" };
const { viewDeps, setupCodeManager } = buildSetupModeViewDeps(0, env, log, fetchFn);
const setupCode = setupCodeManager.mint();
log(`butchr: setup code (10 min, single-use, 5 attempts): ${setupCode}`);

// The journal-capture mechanism itself, proven: the code pulled out of
// `journal` below must be the SAME one `setupCodeManager.mint()` just
// returned — this script never reads the plaintext code directly off
// `setupCodeManager`, only off the (simulated) journal, same as a real
// operator would.
const codeFromJournal = (() => {
  const line = journal.find((l) => l.includes("setup code"));
  const m = line ? /:\s*([A-Z0-9]{13})$/.exec(line.trim()) : null;
  return m?.[1] ?? null;
})();

const dashboardAppRoot = join(import.meta.dir, "..", "dist", "web");
const app = liveView({ connections: { list: () => [] } } as unknown as McpHandle, { ...viewDeps, dashboardAppRoot });
app.listen(listenOptions(0));
const port = app.server!.port!;
(viewDeps.dashboardOriginGuard as { port: number }).port = port;

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

const shot = async (name: string) => { const r = await send("Page.captureScreenshot", { format: "png" }); wf(join(S, `setup-e2e-${name}.png`), Buffer.from(r.data, "base64")); };
const ev = async (js: string) => { const r = await send("Runtime.evaluate", { expression: js, awaitPromise: true, returnByValue: true }); return r.result?.value ?? { exception: r.exceptionDetails?.text }; };
const until = async (what: string, js: string, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await ev(js); if (v === true) return true; await Bun.sleep(150); } console.log("TIMEOUT waiting for:", what); return false; };
let fails = 0; const check = (label: string, ok: boolean, detail = "") => { console.log((ok ? "PASS " : "FAIL ") + label + (detail ? "  " + detail : "")); if (!ok) fails++; };
const setInput = async (testid: string, value: string) => ev(`(() => { const el = document.querySelector('[data-testid=${testid}]'); if (!el) return false; const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; setter.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
const clickBtn = async (testid: string) => ev(`(() => { const b = document.querySelector('[data-testid=${testid}]'); if (!b || b.disabled) return false; b.click(); return true; })()`);

await send("Page.addScriptToEvaluateOnNewDocument", { source: "window.__errs=[];const ce=console.error;console.error=(...a)=>{__errs.push(a.map(String).join(' ').slice(0,500));ce(...a)};addEventListener('error',e=>__errs.push('ERR '+e.message));addEventListener('unhandledrejection',e=>__errs.push('REJ '+String(e.reason)))" });
await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });

// A: unconfigured — the App shows the Setup page, not the normal nav
await send("Page.navigate", { url: `http://127.0.0.1:${port}/dashboard-app/` }); await Promise.race([loadedP, Bun.sleep(8000)]);
await Bun.sleep(500);
check("A1 the Setup page renders (unconfigured gate)", await until("setup-page", `!!document.querySelector('[data-testid=setup-page]')`));
check("A2 no normal nav (Dashboard/Rules/Settings) is rendered while unconfigured", await ev(`!document.querySelector('a[href*="/rules"]')`) === true);
check("A3 the setup code was correctly extracted from the captured journal line", codeFromJournal !== null && codeFromJournal === setupCode);
await shot("1-unconfigured");

// B: submit the setup form
await setInput("setup-site-input", fakeSite);
await setInput("setup-email-input", "butchr@example.com");
await setInput("setup-token-input", CANARY_TOKEN);
await setInput("setup-code-input", codeFromJournal ?? "");
check("B1 click Configure", await clickBtn("setup-submit-button"));
check("B2 the result shows the stub account/displayName", await until("configured", `(document.querySelector('[data-testid=setup-result]')?.textContent ?? '').includes('Stub Operator')`));
check("B3 the result says restart needed", await ev(`(document.querySelector('[data-testid=setup-result]')?.textContent ?? '').toLowerCase().includes('restart needed')`) === true);
check("B4 the candidate token never appears anywhere in the rendered DOM", !((await ev(`document.documentElement.outerHTML`) as string).includes(CANARY_TOKEN)));
await shot("2-configured");

// C: the token/setup-code fields were cleared after submit (never left sitting in the DOM's own input value)
check("C1 the token field is cleared after submit", await ev(`document.querySelector('[data-testid=setup-token-input]').value`) === "");
check("C2 the setup-code field is cleared after submit", await ev(`document.querySelector('[data-testid=setup-code-input]').value`) === "");

console.log("   page errors:", JSON.stringify(await ev("window.__errs")).slice(0, 1500));

// D: the actual "restart" claim — proven against the REAL loadConfig/
// isAtlassianConfigured, with a FRESH env object (nothing carried over
// in-process from the setup-mode app above), reading ONLY what the setup
// write just persisted to the scratch XDG_CONFIG_HOME.
const restartEnv = { XDG_CONFIG_HOME: CONFIG_DIR } as Record<string, string | undefined>;
const effectiveEnv = resolveEffectiveJiraEnv(restartEnv);
check("D1 isAtlassianConfigured is now true from a FRESH env (identity + managed token file alone)", isAtlassianConfigured(effectiveEnv));
let restarted: { site: string; email: string; token: string } | null = null;
let restartError: string | null = null;
try {
  const cfg = loadConfig(effectiveEnv, (p) => readFileSync(p, "utf8"));
  restarted = cfg.atlassian;
} catch (e) {
  restartError = (e as Error).message;
}
check("D2 loadConfig succeeds after the simulated restart (the actual bug this PR fixes)", restarted !== null, restartError ?? "");
check("D3 the restarted config's site/email match what was submitted", restarted?.site === fakeSite && restarted?.email === "butchr@example.com");
check("D4 the restarted config's token matches the candidate token written during setup", restarted?.token === CANARY_TOKEN);

console.log(`\nSUMMARY: ${fails === 0 ? "ALL PASS" : fails + " FAILED"}  (screenshots: ${S}/setup-e2e-*.png)`);
ws.close(); cleanup(); app.stop(true);
try { rmSync(CONFIG_DIR, { recursive: true, force: true }); } catch { /* best effort */ }
process.exit(fails === 0 ? 0 : 1);

}

if (import.meta.main) await main();
