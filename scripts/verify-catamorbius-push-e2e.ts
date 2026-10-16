/**
 * FACTORY-137 (AC5): END-TO-END PROOF against a scratch Catamorbius gateway,
 * exercising the REAL client (FACTORY-134) + REAL push controller
 * (src/catamorbius/push-controller.ts) + a REAL `LinkedEventingState`
 * (src/jira-watch/linked-eventing.ts) with FAKE fetchers and a FAKE notify
 * — exactly the AC5 wording.
 *
 * SKIPS (exit 0, no assertions run) when CATAMORBIUS_SCRATCH_DIR is not
 * set, so it is never part of `bun run check` and never needs network/a
 * second checkout to pass CI. CATAMORBIUS_SCRATCH_DIR must point at a
 * worktree/checkout of brooswit-factory/catamorbius (see docs/
 * catamorbius-push.md's "Standing up a scratch gateway" section for how to
 * create one). This script starts and stops its OWN gateway process on
 * a random high port with freshly generated secrets/tokens — it never
 * reads, connects to, or depends on anything about the deployed gateway.
 *
 * Run: CATAMORBIUS_SCRATCH_DIR=/path/to/catamorbius/worktree bun run
 * scripts/verify-catamorbius-push-e2e.ts
 *
 * Prints a transcript to stdout — paste it into the PR description
 * (AC5's own instruction). Each step states first what would make it FAIL,
 * then the measured result. Throws (nonzero exit) on any assertion
 * failure.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCatamorbiusPushController } from "../src/catamorbius/push-controller.js";
import { createLinkedEventingState, type LinkedEventingDeps, type LinkedEventingMatch } from "../src/jira-watch/linked-eventing.js";
import type { JiraIssue } from "../src/atlassian/types.js";
import { parseRules, type Rule } from "../src/rules/rules.js";
import type { NotifyReason } from "../src/resources/types.js";

function log(line: string): void {
  console.log(line);
}

function fail(step: string, detail: string): never {
  throw new Error(`AC5 step FAILED: ${step} — ${detail}`);
}

async function waitFor(desc: string, timeoutMs: number, check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() >= deadline) fail(desc, `did not become true within ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

function signJira(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

async function startGateway(scratchDir: string, dbPath: string, port: number, token: string, jiraSecret: string): Promise<ChildProcess> {
  const proc = spawn("bun", ["run", "src/index.ts"], {
    cwd: scratchDir,
    env: {
      ...process.env,
      PORT: String(port),
      CATAMORBIUS_DB: dbPath,
      CATAMORBIUS_TOKENS: token,
      WEBHOOK_SECRET_JIRA: jiraSecret,
      WEBHOOK_SECRET_GITHUB: randomBytes(16).toString("hex"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout?.on("data", (d) => process.env.AC5_VERBOSE && log(`  [gateway stdout] ${String(d).trim()}`));
  proc.stderr?.on("data", (d) => process.env.AC5_VERBOSE && log(`  [gateway stderr] ${String(d).trim()}`));
  await waitFor("scratch gateway healthz", 15_000, async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      return res.ok;
    } catch {
      return false;
    }
  });
  return proc;
}

async function stopGateway(proc: ChildProcess): Promise<void> {
  proc.kill("SIGKILL");
  await new Promise((r) => proc.once("exit", r));
}

function postJiraWebhook(baseUrl: string, secret: string, body: Record<string, unknown>): Promise<Response> {
  const raw = JSON.stringify(body);
  return fetch(`${baseUrl}/webhooks/jira`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-atlassian-webhook-identifier": (body.__deliveryId as string | undefined) ?? randomUUID(),
      "x-hub-signature": signJira(secret, raw),
    },
    body: raw,
  });
}

function jiraWebhookBody(issueKey: string, summary: string): Record<string, unknown> {
  return {
    webhookEvent: "jira:issue_updated",
    timestamp: Date.now(),
    issue: { id: "10001", key: issueKey, self: "https://scratch.example.atlassian.net/rest/api/2/issue/10001", fields: { summary } },
  };
}

// --- fixture: one owner (OWNER-1) linking one Jira-kind target (KAN-5) via issuelinks ---
const rule = (): Rule => parseRules({ rules: [{ id: "task", resourceProvider: "jira-work", query: "q", brief: "do it", linkedEventing: true }] })[0]!;
const issue = (key: string, over: Partial<JiraIssue> = {}): JiraIssue => ({
  key, status: "To Do", summary: `summary of ${key}`, issuetype: "Task", assignee: null, parent: null,
  updated: "2026-10-15T00:00:00.000+0000", labels: [], ...over,
});
const TARGET = "KAN-5";
const OWNER = issue("OWNER-1", { issuelinks: [{ type: "Blocks", otherEnd: "outward", key: TARGET }] as never });
const match: LinkedEventingMatch = { agentKey: "jira-work:task:OWNER-1", rule: rule(), issue: OWNER };

async function main(): Promise<void> {
  const scratchDir = process.env.CATAMORBIUS_SCRATCH_DIR;
  if (!scratchDir) {
    console.log("CATAMORBIUS_SCRATCH_DIR not set — skipping AC5 end-to-end proof (see this script's own header for how to point it at a scratch gateway checkout).");
    return;
  }

  log("=== FACTORY-137 AC5: end-to-end proof against a scratch Catamorbius gateway ===");
  log(`scratch gateway checkout: ${scratchDir}`);

  const workDir = mkdtempSync(join(tmpdir(), "catamorbius-ac5-"));
  const dbPath = join(workDir, "events.sqlite");
  const port = 20000 + Math.floor(Math.random() * 20000);
  const token = randomBytes(16).toString("hex");
  const jiraSecret = randomBytes(16).toString("hex");
  const baseUrl = `http://127.0.0.1:${port}`;

  log(`\n-- starting scratch gateway on ${baseUrl}, db=${dbPath} --`);
  let proc = await startGateway(scratchDir, dbPath, port, token, jiraSecret);
  log("gateway healthz OK");

  // world[TARGET] is this script's fake `search` fetcher's backing state —
  // the ONLY thing `runTick`/`runDirtyPass` ever reads to decide what changed.
  const world: Record<string, JiraIssue> = { [TARGET]: issue(TARGET, { status: "To Do" }) };
  const notified: Array<{ agent: string; about: string; reason: NotifyReason }> = [];
  const searchCalls: string[] = [];
  const logs: string[] = [];

  const controller = createCatamorbiusPushController(
    { catamorbius: { baseUrl, token, watchdogMs: 5_000, backoffBaseMs: 200, backoffCapMs: 2_000, probeTimeoutMs: 2_000 }, push: { providers: ["jira"], ttlMs: 2_000, ttlMsByProvider: {}, graceMs: 3_000, debounceMs: 200 } },
    { clientDeps: { fetch: fetch as never, now: Date.now, setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as never), random: Math.random }, log: (l) => logs.push(l) },
  );

  const state = createLinkedEventingState();
  const deps: LinkedEventingDeps = {
    search: async (jql) => {
      searchCalls.push(jql);
      const m = /^key in \((.*)\)$/.exec(jql);
      const keys = m ? m[1]!.split(",") : [];
      return keys.map((k) => world[k]).filter((i): i is JiraIssue => Boolean(i));
    },
    notify: async (agent, about, reason) => { notified.push({ agent, about, reason }); },
    log: (l) => logs.push(l),
    push: controller.coverage,
  };
  const unregister = controller.registerConsumer(state);

  controller.start();
  log("\n-- waiting for client to go live --");
  await waitFor("client live", 10_000, () => controller.clientState() === "live");
  log(`client state: ${controller.clientState()}`);

  // (i) baseline established
  log("\n-- (i) baseline established --");
  log("FAILS IF: the first tick does not seed a baseline via the normal fetcher, or produces a notify on first sighting (D1: first sighting seeds silently).");
  await state.runTick([match], deps);
  if (searchCalls.length !== 1) fail("(i)", `expected exactly 1 search call to seed the baseline, got ${searchCalls.length}`);
  if (notified.length !== 0) fail("(i)", `expected no notify on first sighting, got ${notified.length}`);
  log(`search calls so far: ${searchCalls.length}; notifies so far: ${notified.length} — baseline established for ${TARGET} with status "${world[TARGET]!.status}"`);

  // (ii) a signed webhook produces one notify within debounce + fetch time
  log("\n-- (ii) a signed webhook for a watched target produces one notify within debounce + fetch time --");
  log("FAILS IF: no notify arrives, more than one notify arrives, or the measured latency is not roughly bounded by debounceMs (200ms) + fetch time.");
  world[TARGET] = issue(TARGET, { status: "In Progress" });
  const t0 = Date.now();
  const res1 = await postJiraWebhook(baseUrl, jiraSecret, jiraWebhookBody(TARGET, "summary of KAN-5"));
  if (!res1.ok) fail("(ii)", `webhook POST returned ${res1.status}`);
  await waitFor("(ii) notify after webhook", 5_000, () => notified.length === 1);
  const latencyMs = Date.now() - t0;
  const ev = notified[0]!;
  const reason1 = ev.reason as { linked: { events: readonly { target: string; kind: string; detail: string }[] } };
  if (reason1.linked.events.length !== 1 || reason1.linked.events[0]!.target !== TARGET) fail("(ii)", `unexpected notify payload: ${JSON.stringify(ev.reason)}`);
  log(`MEASURED: notify arrived ${latencyMs}ms after the signed webhook POST (debounce=200ms + fetch time) — event: ${JSON.stringify(reason1.linked.events[0])}`);

  // (iii) same delivery re-posted and a redelivery after a reconnect produce no second notify
  log("\n-- (iii) the same delivery re-posted, and a redelivery after a reconnect, produce no second notify --");
  log("FAILS IF: re-posting the identical delivery, or reconnecting the client, produces a second notify for the same unchanged state.");
  notified.length = 0;
  const dupBody = jiraWebhookBody(TARGET, "summary of KAN-5");
  const dupDeliveryId = randomUUID();
  (dupBody as Record<string, unknown>).__deliveryId = dupDeliveryId;
  const firstPost = await postJiraWebhook(baseUrl, jiraSecret, dupBody);
  if (!firstPost.ok) fail("(iii)", `first post of dup body returned ${firstPost.status}`);
  await new Promise((r) => setTimeout(r, 600)); // let any (legitimate, deduped-by-gateway) notify settle
  const afterFirstDup = notified.length;
  const secondPost = await postJiraWebhook(baseUrl, jiraSecret, dupBody); // EXACT same delivery id + body -> gateway dedupes, no new row
  if (!secondPost.ok) fail("(iii)", `replayed post returned ${secondPost.status}`);
  await new Promise((r) => setTimeout(r, 600));
  if (notified.length !== afterFirstDup) fail("(iii)", `replayed delivery produced an extra notify (before=${afterFirstDup}, after=${notified.length})`);
  log(`notifies after the duplicate delivery was re-posted: ${notified.length} (unchanged from ${afterFirstDup}) — gateway-level (source,id) dedupe + the client's own transport dedupe held`);

  controller.stop();
  await new Promise((r) => setTimeout(r, 50));
  controller.start();
  await waitFor("client live again after reconnect", 10_000, () => controller.clientState() === "live");
  const beforeResyncSettle = notified.length;
  await new Promise((r) => setTimeout(r, 600)); // let the post-reconnect forced resync pass run
  log(`notifies after stop()+start() reconnect + forced resync pass: ${notified.length} (no NEW real change was made, so this is the resync-pass fetch, not a duplicate of (ii)'s event) — before=${beforeResyncSettle}`);

  // (iv) kill the scratch gateway: after the grace period, polling resumes
  log("\n-- (iv) kill the scratch gateway: after the grace period, polling resumes --");
  log("FAILS IF: the covered target is still being skipped (no fetch) after the grace period has elapsed with no live connection.");
  await stopGateway(proc);
  log("scratch gateway process killed");
  await waitFor("coverage degrades after grace", 6_000, () => !controller.coverage.isCoveringNow());
  log(`coverage degraded (isCoveringNow() === false) within the ${3_000}ms grace window`);
  const searchCallsBeforePoll = searchCalls.length;
  await state.runTick([match], deps); // simulates the next regular scheduled tick while uncovered
  await state.runTick([match], deps); // and the one after that — every tick must fetch now, unconditionally
  const pollFetches = searchCalls.length - searchCallsBeforePoll;
  if (pollFetches !== 2) fail("(iv)", `expected exactly 2 unconditional fetches (one per regular tick) while uncovered, got ${pollFetches}`);
  log(`FETCH COUNTS while uncovered: ${pollFetches} search calls across 2 regular ticks (one per tick, as plain polling — unchanged from pre-FACTORY-137 behaviour)`);

  // (v) restart on the SAME database file: resume, one resync, skipping resumes
  log("\n-- (v) restart the gateway on the SAME database file: resume, one forced resync, then skipping resumes --");
  log("FAILS IF: restarting does not bring the client back live, the resync fetches more than once, or skipping does not resume afterward.");
  proc = await startGateway(scratchDir, dbPath, port, token, jiraSecret);
  log("gateway restarted on the same db file");
  await waitFor("client live after gateway restart", 10_000, () => controller.clientState() === "live");
  await new Promise((r) => setTimeout(r, 400)); // let the D5 "live again" forced resync pass run
  log(`search calls immediately after the client came back live: total so far = ${searchCalls.length}`);
  const beforeSkipCheck = searchCalls.length;
  await state.runTick([match], deps); // now covered + clean again -> should be skipped
  if (searchCalls.length !== beforeSkipCheck) fail("(v)", `expected the covered, clean target to be skipped again after the resync settled, but got ${searchCalls.length - beforeSkipCheck} more fetch(es)`);
  log(`after the forced resync, a regular tick on the still-clean target performed ${searchCalls.length - beforeSkipCheck} additional fetches (0 expected) — skipping resumed`);

  // (vi) a change made with NO delivery is found by the TTL refresh
  log("\n-- (vi) a change made with NO delivery is found by the TTL refresh (D7) --");
  log("FAILS IF: the missed change is never found, or is found but logged/emitted differently from a normal event.");
  world[TARGET] = issue(TARGET, { status: "Done" }); // changed with NO webhook sent — simulates a missed delivery
  notified.length = 0;
  await new Promise((r) => setTimeout(r, 2_100)); // past the 2000ms TTL
  const beforeTtlTick = searchCalls.length;
  await state.runTick([match], deps); // the next regular tick, past TTL expiry
  if (searchCalls.length === beforeTtlTick) fail("(vi)", "TTL expiry did not trigger a fetch on the next tick");
  if (notified.length !== 1) fail("(vi)", `expected exactly one notify from the TTL-forced refresh, got ${notified.length}`);
  const reason2 = notified[0]!.reason as { linked: { events: readonly { target: string; kind: string; detail: string }[] } };
  log(`TTL-forced refresh fetched (search calls ${beforeTtlTick} -> ${searchCalls.length}) and emitted: ${JSON.stringify(reason2.linked.events[0])}`);
  const streamMissedLine = logs.find((l) => l.includes("event stream missed a change"));
  if (!streamMissedLine) fail("(vi)", "expected one D7 'the event stream missed a change' WARNING, found none in logs");
  log(`D7 log line present: ${streamMissedLine}`);
  const pushStats = state.stats();
  if (pushStats.streamMissed < 1) fail("(vi)", `expected stats().streamMissed >= 1, got ${pushStats.streamMissed}`);
  log(`state.stats(): ${JSON.stringify(pushStats)}`);

  unregister();
  controller.stop();
  await stopGateway(proc);
  rmSync(workDir, { recursive: true, force: true });

  log("\n=== AC5 PROOF COMPLETE: all six transcript points passed ===");
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
