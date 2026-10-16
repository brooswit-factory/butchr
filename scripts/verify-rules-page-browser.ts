/**
 * FACTORY-686: real-browser pass of the Rules page. Drives headless Chromium (raw CDP over a
 * WebSocket, no npm dependency) against the REAL `liveView` routes and the BUILT dashboard-app
 * (`bun run build:web` first) with isolated, in-memory fake dependencies: a temp rules file, a
 * 3-ticket stub previewer, the production holder/reload/scope-cache wiring, the real write guard.
 * NEVER a daemon, never the shared herdr or `~/.config/butchr`. It found two bugs no unit test
 * could (static assets served with no content-type under `nosniff`; Preview crashing the app on
 * the server's real response shape). 21 checks: render, same-origin session, save query, preview,
 * enable, undo, stale-file "reload pending", stale-lock error, cross-origin refusal.
 *

 * NOTE: run `bun run build:web` IMMEDIATELY before (a full `bun test` run leaves a different, fixture-mode build in dist/web that this script must not use).
 * Usage: bun run build:web && CHROME=/usr/bin/chromium bun run scripts/verify-rules-page-browser.ts
 * (screenshots land next to the temp dir it prints in S; exit code 1 if any check fails).
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpHandle } from "@brooswit/thatch";
import { liveView, type ViewDeps } from "../src/web/view.js";
import { createCsrfTokenIssuer } from "../src/web/csrf.js";
import { isSameUidPeer } from "../src/web/peer-uid.js";
import { createAuditLogger } from "../src/web/audit-log.js";
import { createRulesPreviewer } from "../src/web/rules-preview.js";
import { writeRulesFile, rulesEtag } from "../src/rules/write-rules.js";
import { loadRules, createRulesHolder, sourceEtagOf } from "../src/rules/rules.js";
import { reloadRules } from "../src/rules/reload.js";
import { createScopeCache, writeRuleEnabled, writeRuleFields, writeUndo, planRuleWrite } from "../src/rules/rules-write.js";
import { listenOptions } from "../src/daemon/listen.js";
import { writeFileSync as wf } from "node:fs";
import { writeFileSync as wlock, unlinkSync as ul } from "node:fs";

async function main(): Promise<void> {

const S = process.env.S ?? mkdtempSync(join(tmpdir(), "butchr-rules-e2e-")); const CHROME = process.env.CHROME ?? "/usr/bin/chromium";
const d = mkdtempSync(join(S, "t3-browser-")); const env = { XDG_CONFIG_HOME: d } as any; const rulesFile = join(d, "butchr", "rules.json");
const doc = (rules: unknown[]) => JSON.stringify({ rules }, null, 2) + "\n";
const MGR = { id: "managers", resourceProvider: "jira-work", query: "project = A", brief: "managers brief", enabled: true };
const UI = { id: "ui-first-rule", resourceProvider: "jira-work", query: "PLACEHOLDER_QUERY", brief: "ui brief", execution: process.env.EXEC ?? "singleton", account: "none", enabled: false };
writeRulesFile(doc([MGR, UI]), env);
const holder = createRulesHolder(loadRules(env).rules, sourceEtagOf(readFileSync(rulesFile, "utf8")));
const issues = Array.from({ length: 3 }, (_, i) => ({ key: `P-${i + 1}`, fields: {} })) as any;
const previewer = createRulesPreviewer({ rules: () => holder.getRules(), search: async () => issues, maxAgents: 24 } as any);
const scopeOf = createScopeCache(async (id: string) => { const r: any = await previewer(id); return r.ok ? r.total : Number.POSITIVE_INFINITY; });
const deps0: any = { env, reload: () => { const r = reloadRules(holder, env); return { applied: r.ok, problems: r.problems }; }, getSourceEtag: () => holder.getSourceEtag() };
const alerts: string[] = [];
const auditWrite = createAuditLogger({ append: () => {}, postAlert: async (t: string) => { alerts.push(t); }, host: "codey", log: () => {}, rejectAggregateWindowMs: 50 });
const csrf = createCsrfTokenIssuer(); const guard = { port: 0 };
const peerUidCheck = (client: { address: string; port: number }) => isSameUidPeer(client, { server: { address: "127.0.0.1", port: guard.port } });
const fakeMcp = { connections: { list: () => [] } } as unknown as McpHandle;
const unused = () => { throw new Error("unused"); };
const deps = { state: async () => [], open: unused, openPane: unused, health: () => ({ ok: true }), dashboard: async () => ({ checked: true, confirmedAt: new Date(0).toISOString(), rows: [], admission: { cap: 0, residency: null, sentinels: null, sources: [] } }),
  header: () => ({ build: { sha: null, shaDirty: null, shaUnknownReason: "x", version: "0.0.0", versionProvenance: "tag", versionUnknownReason: null } }), resourceLink: unused, configInventory: async () => ({ rules: holder.getRules().map((r: any) => ({ kind: "rule", id: r.id, resourceProvider: r.resourceProvider, query: r.query, enabled: r.enabled, execution: r.execution, account: r.account, role: r.role, agentPreferences: r.agentPreferences ?? [], linkedEventing: !!r.linkedEventing, mcpServerNames: [], staffed: null, reason: "e2e harness: no agent fleet" })), sessionDefinitions: [], errors: [] }),
  dashboardAppRoot: join(import.meta.dir, "..", "dist", "web"), dashboardOriginGuard: guard, peerUidCheck, csrf, writeGuard: { dashboardOriginGuard: guard, peerUidCheck, csrf },
  rulesWrite: { enabled: (id: string, e: boolean, m: string, c: boolean, h: string) => writeRuleEnabled(id, e, m, c, h, scopeOf, deps0), fields: (id: string, p: any, m: string, c: boolean, h: string) => writeRuleFields(id, p, m, c, h, scopeOf, deps0), undo: (b: string) => writeUndo(b, deps0), plan: (id: string, p: any, c: boolean) => planRuleWrite(id, p, c, scopeOf, deps0) },
  auditWrite, rulesPreview: (id: string) => previewer(id), getRulesSourceEtag: () => holder.getSourceEtag(),
  rulesFileState: async () => ({ path: rulesFile, rules: holder.getRules(), error: null, mtime: null, fileEtag: rulesEtag(env) }) } as unknown as ViewDeps;
const app = liveView(fakeMcp, deps); app.listen(listenOptions(0)); const port = app.server!.port!; guard.port = port;

const prof = mkdtempSync(join(S, "chrome-prof-"));
// The browser runs in its OWN session/process group (setsid) so the whole tree can be killed by group id: on normal
// exit, on any thrown error, and on SIGINT/SIGTERM. Port 0 + the loopback-only default (no fixed port, no
// `--remote-allow-origins=*`): the DevTools endpoint is unauthenticated, so it must never outlive this script.
const chrome = Bun.spawn(["setsid", CHROME, "--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run", "--remote-debugging-port=0", `--user-data-dir=${prof}`, "about:blank"], { stdout: "ignore", stderr: "ignore" });
let cleaned = false;
const cleanup = (): void => {
  if (cleaned) return;
  cleaned = true;
  try { process.kill(-chrome.pid, "SIGKILL"); } catch { /* already gone */ }
  try { chrome.kill(9); } catch { /* already gone */ }
  try { rmSync(prof, { recursive: true, force: true }); } catch { /* best effort */ }
};
process.on("exit", cleanup);
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { cleanup(); process.exit(130); });
let dbg = 0;
for (let i = 0; i < 80 && dbg === 0; i++) { try { dbg = Number(readFileSync(join(prof, "DevToolsActivePort"), "utf8").split("\n")[0]) || 0; } catch { await Bun.sleep(250); } }
if (dbg === 0) { cleanup(); throw new Error("chromium did not report a DevTools port"); }
for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://127.0.0.1:${dbg}/json/version`)).ok) break; } catch {} await Bun.sleep(250); }
const tab = await (await fetch(`http://127.0.0.1:${dbg}/json/new?about:blank`, { method: "PUT" })).json() as any;
const ws = new WebSocket(tab.webSocketDebuggerUrl); await new Promise<void>((res) => { ws.onopen = () => res(); });
let id = 0; const pending = new Map<number, (v: any) => void>(); let loaded: () => void = () => {}; const loadedP = new Promise<void>((r) => { loaded = r; });
ws.onmessage = (ev) => { const m = JSON.parse(String(ev.data)); if (m.id && pending.has(m.id)) { pending.get(m.id)!(m.result ?? m); pending.delete(m.id); } else if (m.method === "Page.loadEventFired") loaded(); };
const send = (method: string, params: any = {}) => new Promise<any>((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
await send("Page.enable"); await send("Runtime.enable");

const shot = async (name: string) => { const r = await send("Page.captureScreenshot", { format: "png" }); wf(join(S, `ui-e2e-${name}.png`), Buffer.from(r.data, "base64")); };
const ev = async (js: string) => { const r = await send("Runtime.evaluate", { expression: js, awaitPromise: true, returnByValue: true }); return r.result?.value ?? { exception: r.exceptionDetails?.text }; };
const until = async (what: string, js: string, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await ev(js); if (v === true) return true; await Bun.sleep(150); } console.log("TIMEOUT waiting for:", what); return false; };
let fails = 0; const check = (label: string, ok: boolean, detail = "") => { console.log((ok ? "PASS " : "FAIL ") + label + (detail ? "  " + detail : "")); if (!ok) fails++; };
const clickBtn = async (text: string) => { const pos = await ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim().toLowerCase() === ${JSON.stringify(text.toLowerCase())} && !x.disabled); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`); if (!pos) return false;
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x: pos.x, y: pos.y, button: "left", clickCount: 1 }); return true; };
const typeQuery = async (q: string) => { await ev(`(() => { const i = document.querySelector('[data-testid=first-rule-query-input]'); i.focus(); i.select(); return true; })()`); await send("Input.insertText", { text: q }); };
const api = async (path: string) => ev(`fetch(${JSON.stringify(path)}).then(r => r.json())`);
const rule = async () => { const b: any = await api("/api/rules"); return { b, r: b.rules.find((x: any) => x.id === "ui-first-rule") }; };

await send("Page.addScriptToEvaluateOnNewDocument", { source: "window.__errs=[];const ce=console.error;console.error=(...a)=>{__errs.push(a.map(String).join(' ').slice(0,500));ce(...a)};addEventListener('error',e=>__errs.push('ERR '+e.message));addEventListener('unhandledrejection',e=>__errs.push('REJ '+String(e.reason)))" });
await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: `http://127.0.0.1:${port}/dashboard-app/rules` }); await Promise.race([loadedP, Bun.sleep(8000)]);
check("A rules page renders the first-rule flow", await until("first-rule-setup", `!!document.querySelector('[data-testid=first-rule-setup]')`));
await Bun.sleep(600); await shot("1-initial");
check("A2 placeholder notice is shown", await ev(`!!document.querySelector('[data-testid=first-rule-placeholder-notice]')`) === true);
check("A3 Enable is clickable (write capability detected via /api/session)", await ev(`[...document.querySelectorAll('button')].some(x => x.textContent.trim() === 'Enable' && !x.disabled)`) === true);
check("A4 no stale banner on a fresh daemon", await ev(`!document.querySelector('[data-testid=first-rule-stale]')`) === true);

// B: starter example then save the query
await clickBtn("one specific ticket"); await Bun.sleep(200);
check("B1 starter example fills the query input", (await ev(`document.querySelector('[data-testid=first-rule-query-input]').value`)) === "key = XYZ-1");
await typeQuery("key = P-1"); await Bun.sleep(200);
check("B2 typing replaces the query text", (await ev(`document.querySelector('[data-testid=first-rule-query-input]').value`)) === "key = P-1", String(await ev(`document.querySelector('[data-testid=first-rule-query-input]').value`)));
check("B3 click 'save query'", await clickBtn("save query"));
check("B4 the server rule file now holds the new query", await until("query saved", `fetch('/api/rules').then(r => r.json()).then(b => b.rules.find(x => x.id === 'ui-first-rule').query === 'key = P-1')`));
await Bun.sleep(400); await shot("2-query-saved");
{ const { b, r } = await rule(); check("B5 reload applied: running rules == file (stale false)", b.stale === false && r.query === "key = P-1", JSON.stringify({ stale: b.stale })); }

// C: preview
check("C1 click Preview", await clickBtn("Preview"));
await Bun.sleep(1200); console.log("   page errors after Preview:", JSON.stringify(await ev("window.__errs")).slice(0,1500));
check("C2 preview dialog lists the matched ticket keys", await until("preview keys", `document.body.innerText.includes('P-1') && document.body.innerText.includes('P-3')`));
await shot("3-preview"); check("C3 close the preview dialog", await clickBtn("close")); await Bun.sleep(400);

// D: enable
await Bun.sleep(2600); check("D1 click Enable", await clickBtn("Enable"));
await Bun.sleep(1500); console.log("   after Enable click: error=", JSON.stringify(await ev(`document.querySelector('[data-testid=first-rule-error]')?.innerText`)), "confirm=", JSON.stringify(await ev(`document.querySelector('[data-testid=first-rule-confirm]')?.innerText`)), "errs=", JSON.stringify(await ev("window.__errs")).slice(0,600), "enableDisabled=", await ev(`[...document.querySelectorAll('button')].filter(b=>b.textContent.trim()==='Enable').map(b=>b.disabled)`));
const confirmShown = await until("confirm or enabled", `!!document.querySelector('[data-testid=first-rule-confirm]') || [...document.querySelectorAll('button')].some(x => x.textContent.trim() === 'Disable')`);
check("D2 enable proceeds (confirm step or direct)", confirmShown);
if (await ev(`!!document.querySelector('[data-testid=first-rule-confirm]')`) === true) { console.log("   confirm text:", await ev(`document.querySelector('[data-testid=first-rule-confirm]').innerText`)); await shot("4-confirm"); await clickBtn("confirm"); }
check("D3 the rule is enabled on the server and the UI shows Disable + Undo", await until("enabled", `fetch('/api/rules').then(r => r.json()).then(b => b.rules.find(x => x.id === 'ui-first-rule').enabled === true) && [...document.querySelectorAll('button')].some(x => x.textContent.trim() === 'Disable')`));
await Bun.sleep(300); await shot("5-enabled");

// E: undo
check("E1 click 'Undo last change'", await clickBtn("Undo last change"));
check("E2 undo restores the previous state on the server (disabled again)", await until("undone", `fetch('/api/rules').then(r => r.json()).then(b => b.rules.find(x => x.id === 'ui-first-rule').enabled === false)`));
await Bun.sleep(300); await shot("6-undone");

// F: stale file (admin edits the file on disk, no reload)
{ const cur = JSON.parse(readFileSync(rulesFile, "utf8")); cur.rules[0].query = "project = ADMIN-EDIT"; writeRulesFile(JSON.stringify(cur, null, 2) + "\n", env); }
await send("Page.navigate", { url: `http://127.0.0.1:${port}/dashboard-app/rules` }); await Promise.race([new Promise((r) => setTimeout(r, 2500))]);
check("F1 stale banner 'reload pending' appears", await until("stale banner", `!!document.querySelector('[data-testid=first-rule-stale]')`));
check("F2 every write control is disabled while stale", await ev(`[...document.querySelectorAll('[data-testid=first-rule-setup] button')].filter(b => ['Enable','save query'].includes(b.textContent.trim())).every(b => b.disabled)`) === true);
await shot("7-stale");
reloadRules(holder, env); await send("Page.navigate", { url: `http://127.0.0.1:${port}/dashboard-app/rules` }); 
check("F3 after the reload the banner is gone", await until("stale gone", `!!document.querySelector('[data-testid=first-rule-setup]') && !document.querySelector('[data-testid=first-rule-stale]')`));

// G: stale lock error shown to the user
const lock = join(d, "butchr", ".rules.lock"); wlock(lock, "999999999");
await typeQuery("key = P-2"); await Bun.sleep(200); await clickBtn("save query");
check("G1 the stale-lock error reaches the UI and names the lock file", await until("lock error", `(document.querySelector('[data-testid=first-rule-error]')?.innerText ?? '').includes('.rules.lock')`));
console.log("   error text:", await ev(`document.querySelector('[data-testid=first-rule-error]')?.innerText`)); await shot("8-lock-error"); ul(lock);

// H: cross-origin page cannot read the API
await send("Page.navigate", { url: `http://localhost:${port}/dashboard-app/rules` }); await Bun.sleep(1500);
check("H1 same machine, different origin (localhost): the page does not get write capability to the 127.0.0.1 origin", (await ev(`fetch('http://127.0.0.1:${port}/api/rules').then(r => r.status).catch(e => 'blocked')`)) !== 200);

const consoleErrors = await ev(`window.__errs ?? 'n/a'`);
console.log(`\nSUMMARY: ${fails === 0 ? "ALL PASS" : fails + " FAILED"}  (screenshots: ${S}/ui-e2e-*.png)`);
ws.close(); cleanup(); app.stop(true); process.exit(fails === 0 ? 0 : 1);

}

if (import.meta.main) await main();
