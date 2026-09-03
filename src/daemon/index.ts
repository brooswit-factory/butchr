import { readFileSync } from "node:fs";
import { HerdrClient } from "@brooswit/herdr-sdk";
import { loadConfig, describeConfig } from "../config/config.js";
import { AtlassianClient } from "../atlassian/client.js";
import { buildApp, notifyIssue } from "./app.js";
import { combineHealth, createLoopHealth } from "./health.js";
import { createCoverageTracker } from "./coverage.js";
import { HerdrHerd, issueOfAgentName, type NudgeResult } from "../agents/herd.js";
import { buildIdentity, toBuildReport } from "../agents/build-identity.js";
import { runResourceLoop } from "./loop.js";
import { createIssueResourceType, ISSUE_JQL, createTodoWorkersFetch } from "../resources/issue.js";
import { createProjectResourceType, PROJECT_POLL_INTERVAL_MS } from "../resources/project.js";
import { isIssueKey, isProjectId } from "../resources/id.js";
import { watchPrompts } from "../agents/prompt-watch.js";
import { chooseStartupAnswer } from "../agents/prompt.js";
import { watchBlocked } from "../agents/blocked.js";
import { createEscalator } from "../agents/escalation-loop.js";
import { withIdleDialogDetection } from "../agents/idle-dialog.js";
import { detectTerminalPrefix } from "../terminal/open.js";
import { realAtlassian } from "../tools/atlassian-real.js";
import { atlassianTools } from "../tools/defs.js";
import { createLabelSync } from "../labels/sync.js";
import { createNotifyGate } from "../labels/notify-gate.js";
import { PrTracker } from "../labels/pr.js";
import { sweepStaleAgentLabels } from "../labels/sweep.js";
import { watchSessionLimits } from "../agents/session-limit-watch.js";
import { createCaptureStore } from "../agents/capture-store.js";
import { createStalledCheck } from "../agents/stalled.js";
import { createOwnWriteLedger, DAEMON_WRITER } from "../jira-watch/own-writes.js";
import { respawnComment } from "../agents/respawn.js";
import { createParkedDetector } from "../agents/parked.js";
import { createAbandonedDetector } from "../agents/abandoned.js";
import { prReviewStateNudge } from "../agents/pr-nudge.js";
import { changeNudge, notifyReasonTag } from "../agents/change-nudge.js";
import { speakOnOwnChannel, createOwnChannelComments } from "../tools/speak.js";
import { createFrozenAsleepDetector } from "../agents/frozen-asleep.js";
import { createCrashLoopDetector } from "../agents/crash-loop.js";
import { createReconcileFailureDetector } from "../agents/reconcile-failure.js";

let config;
try {
  config = loadConfig(process.env as Record<string, string | undefined>, (p) => readFileSync(p, "utf8"));
} catch (e) {
  console.error(`butchr: ${(e as Error).message}`);
  console.error("See .env.example for the required configuration.");
  process.exit(1);
}

const atlassian = new AtlassianClient(config.atlassian.site, config.atlassian.email, config.atlassian.token, undefined, (line) => console.error(`  ${line}`));
// Label writes must never silently 403: Jira only honours notifyUsers=false
// for an account holding Administer Jira/Projects on the ticket's project.
// This gate preflights that per project (first sight, cached for the run)
// and falls back to notifying writes — loudly, once — when it's absent.
// Shared between the poll loop and the one-time startup sweep below so both
// see the same cached verdict per project.
const labelWriter = createNotifyGate({ jira: atlassian, account: config.atlassian.email, log: (line) => console.error(`  ${line}`) });
const herdr = new HerdrClient(config.herdrSocket ? { socketPath: config.herdrSocket } : {});
const herd = new HerdrHerd(herdr, `http://localhost:${config.port}/mcp`);
const terminalPrefix = config.terminalPrefix ?? detectTerminalPrefix((c) => Bun.which(c) != null) ?? undefined;
const summaries = new Map<string, string>();

const ops = realAtlassian({ site: config.atlassian.site, email: config.atlassian.email, token: config.atlassian.token });

// The own-write ledger (src/jira-watch/own-writes.ts): every daemon-side
// write (agent tool calls, and this daemon's own label sync) records the
// target's read-back `updated` here, so startLoop can recognize its own
// echoes instead of nudging an agent to re-read a change it made itself.
const ownWrites = createOwnWriteLedger();

/**
 * Read each key's `updated` back after a write and record it under `writer`.
 * Batches all the given keys into one search call. Failures are swallowed
 * and logged — a read-back miss must never surface as a tool error, and at
 * worst it just costs one un-suppressed nudge.
 */
const recordOwnWrite = (keys: readonly string[], writer: string) => {
  void (async () => {
    try {
      const uniq = [...new Set(keys)];
      if (!uniq.length) return;
      const issues = await atlassian.search(`key IN (${uniq.join(",")})`);
      const now = Date.now();
      for (const i of issues) ownWrites.record(i.key, i.updated, writer, now);
    } catch (e) {
      console.error(`  WARNING: own-write read-back failed for ${keys.join(",")} (${writer}): ${(e as Error)?.message ?? e}`);
    }
  })();
};

// Poll-loop liveness (BUTCHR-18/BUTCHR-6): a positive heartbeat, recorded by
// startLoop's onPollSuccess below, independent of onError — see health.ts for
// why onError alone can't be the liveness source.
const loopHealth = createLoopHealth({
  name: "pollLoop",
  thresholdMs: config.pollStaleMs,
  log: (line) => console.error(line),
});
// Notify-stage liveness (BUTCHR-57): a SECOND, independent positive
// heartbeat — the poll (fetch) stage completing says nothing about whether
// the notify stage (loop.ts's onChange: diff, suppress, `deps.notify`) is
// actually running, since startLoop records onPollSuccess at the end of the
// FETCH stage only. Reuses `config.pollStaleMs` rather than adding a second
// threshold knob: loop.ts now runs the notify stage on the SAME cadence as
// the poll stage (every tick, not only when something changed — see the
// `hash` override in startLoop), so a threshold tuned for "a poll took too
// long" is equally the right threshold for "a notify pass took too long".
const notifyHealth = createLoopHealth({
  name: "notify",
  thresholdMs: config.pollStaleMs,
  log: (line) => console.error(line),
});
// BUTCHR-91/BUTCHR-68: the project tier's own pair of liveness components,
// so `/health` (and an operator asking "is the project tier deployed?")
// gets a truthful answer even when its allowlist is empty — the loop below
// always starts, so these always report SOMETHING (starting/ok/stale)
// rather than being silently absent. Threshold is a 4x multiple of the
// project loop's OWN 5-minute interval, mirroring the issue tier's own
// ratio above (60_000 / 15_000 = 4) rather than reusing `config.pollStaleMs`
// (tuned for a 15s loop; applied to a 5-minute one it would flap red on
// perfectly normal cadence).
const PROJECT_POLL_STALE_MS = PROJECT_POLL_INTERVAL_MS * 4;
const projectLoopHealth = createLoopHealth({
  name: "projectPollLoop",
  thresholdMs: PROJECT_POLL_STALE_MS,
  log: (line) => console.error(line),
});
const projectNotifyHealth = createLoopHealth({
  name: "projectNotify",
  thresholdMs: PROJECT_POLL_STALE_MS,
  log: (line) => console.error(line),
});
// BUTCHR-179: per-detector "could not check" coverage, reported as a
// /health sibling — see src/daemon/coverage.ts's own header for the full
// rationale. Wired into two detectors so far (syncLabels's stalled check,
// escalation-loop's unresponsive alarm) — see this ticket's own report for
// the rest of the declining set and why it's not all wired yet.
const coverage = createCoverageTracker();

const { app, mcp } = buildApp({
  state: async () => {
    const { agents } = await herdr.agent.list();
    return agents.flatMap((a) => {
      const issue = issueOfAgentName((a as { name?: string }).name);
      return issue ? [{ issue, status: a.agent_status, summary: summaries.get(issue) ?? "" }] : [];
    });
  },
  open: async (issue) => {
    const pane = await herd.paneFor(issue);
    if (!pane) return { ok: false, error: "agent not running for " + issue };
    if (!terminalPrefix) return { ok: false, error: "no terminal emulator found (set BUTCHR_TERMINAL)" };
    Bun.spawn([...terminalPrefix, "herdr", "agent", "attach", pane], { stdio: ["ignore", "ignore", "ignore"] });
    return { ok: true };
  },
  health: () => combineHealth([loopHealth, notifyHealth, projectLoopHealth, projectNotifyHealth], toBuildReport(buildIdentity), coverage.snapshot()),
}, atlassianTools(ops, undefined, config.assignees, recordOwnWrite));
app.listen(config.port);
console.error(`butchr daemon on http://localhost:${config.port}  (${describeConfig(config)})`);
console.error(`  terminal: ${terminalPrefix ? terminalPrefix.join(" ") : "NONE — set BUTCHR_TERMINAL to open agent shells"}`);
if (!config.github) console.error("  pr:* labels disabled: set GITHUB_TOKEN_FILE and BUTCHR_GITHUB_ORGS to enable PR discovery");

const readPane = async (paneId: string) => (await herdr.pane.read({ pane_id: paneId, source: "detection", strip_ansi: true })).read.text;
const sendPane = async (paneId: string, text: string) => { await herdr.pane.sendText({ pane_id: paneId, text }); };

const prTracker = config.github ? new PrTracker({ fetchImpl: fetch, token: config.github.token, orgs: config.github.orgs, log: (line) => console.error(`  ${line}`) }) : undefined;
// KAN-804/807: "idle since spawn, never spoke" — comments are only fetched
// for issues that already satisfy the cheap preconditions (see stalled.ts),
// never on every poll.
const stalled = createStalledCheck({
  now: () => Date.now(),
  minutes: config.stalledMinutes,
  comments: (issue) => atlassian.comments(issue),
  accountEmail: config.atlassian.email,
  log: (line) => console.error(`  ${line}`),
});
// BUTCHR-24: escalates a staffed child stuck in To Do under a live boss —
// see src/agents/parked.ts. Posts through the same `ops.addComment` seam as
// every other daemon-side comment write; no second Atlassian writer.
const parkedDetector = createParkedDetector({
  now: () => Date.now(),
  minutes: config.parkedMinutes,
  addComment: async (issue, text) => { await ops.addComment(issue, text); },
  comments: (issue) => atlassian.comments(issue),
  links: (issue) => atlassian.links(issue),
  log: (line) => console.error(`  ${line}`),
});
// BUTCHR-95/123/124/141: reads a resource's own channel — shared by the
// frozen-asleep detector below, BOTH crash-loop detector instances further
// down, and the blocked-dialog escalator (`escalator`'s `ownChannelComments`
// dep) — the one project-aware comment reader in this codebase, EXTRACTED
// (BUTCHR-141/§2.6) into `createOwnChannelComments` (src/tools/speak.ts) so
// it is importable into a unit test directly, rather than reproduced by
// hand there — see that function's own doc comment for the full mechanism
// (routing, the single-id call shape, and the BUTCHR-129 unwrap history).
// `issueComments` is injected as `atlassian.comments`, the same client
// `stalled`/`parkedDetector` above already use.
const ownChannelComments = createOwnChannelComments(ops, (key) => atlassian.comments(key));
// BUTCHR-200: escalates a worker whose Implements boss reached Done while it
// is still open — see src/agents/abandoned.ts. Unlike parkedDetector above
// (which predates the BUTCHR-95/123/141 comment-read-path fix and still
// uses the raw `atlassian.comments` call, deliberately not corrected here —
// out of scope), this reads through `ownChannelComments`, the tier-aware
// reader, per this ticket's own requirement. Posts through the same
// `ops.addComment` seam as every other daemon-side comment write; no second
// Atlassian writer. ON by default (see the wiring below): this detector's
// measured day-one population is ZERO (BUTCHR-192/BUTCHR-200), so an ON
// default cannot spam anything on day one — see this ticket's PR body for
// why steady-state volume should NOT be assumed to stay zero.
// BUTCHR-240: `todoWorkers` closes the To Do gap — see abandoned.ts's own
// "FORMER KNOWN LIMITATION" doc comment. A separate, narrower query
// (TODO_WORKER_JQL, src/resources/issue.ts) from `ISSUE_JQL` above,
// deliberately not folded into it — see that constant's own doc comment for
// why. Uses the raw `atlassian.search` call, not the `summaries`-recording
// wrapper `issueResourceType` below is given: a To Do worker has no running
// agent, so there is nothing here for that side-effect to usefully feed.
const abandonedDetector = createAbandonedDetector({
  now: () => Date.now(),
  minutes: config.abandonedMinutes,
  addComment: async (issue, text) => { await ops.addComment(issue, text); },
  comments: ownChannelComments,
  links: (issue) => atlassian.links(issue),
  todoWorkers: createTodoWorkersFetch({ search: (jql) => atlassian.search(jql) }),
  log: (line) => console.error(`  ${line}`),
});
// BUTCHR-95/123: bounds `atRest` (src/reconcile/plan.ts) in time — see
// src/agents/frozen-asleep.ts for the full mechanism. `addComment` reuses the
// SAME `speakOnOwnChannel` seam the blocked-dialog escalator already wires
// below, so this adds no second Atlassian writer either.
const frozenAsleepDetector = createFrozenAsleepDetector({
  now: () => Date.now(),
  minutes: config.atRestMinutes,
  addComment: async (id, text) => { await speakOnOwnChannel(ops, id, text); },
  comments: ownChannelComments,
  log: (line) => console.error(`  ${line}`),
});
// BUTCHR-141: audible-only crash-loop detection — see src/agents/crash-loop.ts
// for the full mechanism. TWO SEPARATE INSTANCES, one per loop (unlike
// frozenAsleepDetector above, which only the project tier can ever produce a
// candidate for): a crash loop has no such restriction, and each
// `runResourceLoop` call needs its own tracker for the same reason
// `RespawnGuard` is one instance per call rather than module-level. Both
// reuse the SAME `speakOnOwnChannel`/`ownChannelComments` seams — no second
// Atlassian writer or reader.
const issueCrashLoopDetector = createCrashLoopDetector({
  now: () => Date.now(),
  count: config.crashLoopCount,
  windowMinutes: config.crashLoopWindowMinutes,
  addComment: async (id, text) => { await speakOnOwnChannel(ops, id, text); },
  comments: ownChannelComments,
  log: (line) => console.error(`  ${line}`),
});
const projectCrashLoopDetector = createCrashLoopDetector({
  now: () => Date.now(),
  count: config.crashLoopCount,
  windowMinutes: config.crashLoopWindowMinutes,
  addComment: async (id, text) => { await speakOnOwnChannel(ops, id, text); },
  comments: ownChannelComments,
  log: (line) => console.error(`  ${line}`),
});
// BUTCHR-147: audible isolated herd.spawn/stop/respawn failure detection —
// see src/agents/reconcile-failure.ts for the full mechanism, and that
// module's own top comment for why this is independent of (not a
// replacement for) crashLoopDetector above. TWO SEPARATE INSTANCES, same
// reasoning as issueCrashLoopDetector/projectCrashLoopDetector: an isolated
// failure has no `atRest`-style single-tier restriction. Both reuse the SAME
// `speakOnOwnChannel`/`ownChannelComments` seams — no second Atlassian
// writer or reader.
const issueReconcileFailureDetector = createReconcileFailureDetector({
  now: () => Date.now(),
  addComment: async (id, text) => { await speakOnOwnChannel(ops, id, text); },
  comments: ownChannelComments,
  log: (line) => console.error(`  ${line}`),
});
const projectReconcileFailureDetector = createReconcileFailureDetector({
  now: () => Date.now(),
  addComment: async (id, text) => { await speakOnOwnChannel(ops, id, text); },
  comments: ownChannelComments,
  log: (line) => console.error(`  ${line}`),
});
const syncLabels = createLabelSync({
  jira: labelWriter,
  agentStatuses: async () => {
    const { agents } = await herdr.agent.list();
    const m = new Map<string, string>();
    for (const a of agents) {
      const issue = issueOfAgentName((a as { name?: string }).name);
      if (issue) m.set(issue, a.agent_status ?? "unknown");
    }
    return m;
  },
  ...(prTracker ? { prState: (key: string) => prTracker.stateFor(key), onPollEnd: () => prTracker.endPoll() } : {}),
  stalled,
  coverage,
  onWrite: (keys) => recordOwnWrite(keys, DAEMON_WRITER),
  log: (line) => console.error(`  ${line}`),
});

// KAN-804/807: a session-limit refusal is not a dialog — the prompt-watcher
// and escalator never see it (agent_status stays idle/done, not blocked).
// Level-triggered: every poll, for every idle/done agent, check the pane for
// the refusal and close it once past its printed reset time plus margin so
// the reconciler respawns with a fresh kickoff. Nothing persisted; a restart
// re-reads the same pane and reaches the same decision.
watchSessionLimits({
  list: async () => (await herdr.agent.list()).agents.map((a) => ({
    pane_id: a.pane_id,
    agent_status: a.agent_status ?? "",
    issue: issueOfAgentName((a as { name?: string }).name),
  })),
  read: readPane,
  close: (issue) => herd.stop(issue),
  now: () => Date.now(),
  log: (line) => console.error(`  ${line}`),
  captures: createCaptureStore(config.captureDir),
}, 15_000);

// One-time startup sweep: agent:* stranded by a ticket that went inactive
// while the daemon was down. createLabelSync's bookkeeping is in-memory and
// the 15s poll only ever sees active tickets, so nothing else ever revisits
// this. Not a new polling timer — runs once, here, and never again.
void sweepStaleAgentLabels({
  search: (jql) => atlassian.search(jql),
  jira: labelWriter,
  log: (line) => console.error(`  ${line}`),
}).catch((e) => console.error(`  WARNING: startup agent:* sweep failed: ${(e as Error)?.message ?? e}`));

// The issue tier expressed as ONE instance of ResourceType<JiraIssue>
// (BUTCHR-64/BUTCHR-69) — discovery (the JQL + the Implements-chain
// `related` walk), activation, event rules (the suppression stack) and
// spawn config all live in src/resources/issue.ts now; this daemon is just
// the wiring of that instance's I/O (the live Jira client + the own-write
// ledger) to the generic loop below.
const issueResourceType = createIssueResourceType({
  search: async (jql) => {
    const issues = await atlassian.search(jql);
    for (const i of issues) summaries.set(i.key, i.summary);
    return issues;
  },
  links: (key) => atlassian.links(key),
  suppress: (key, updated, watcher) => ownWrites.shouldSuppress(key, updated, watcher, Date.now()),
  comments: (key) => atlassian.comments(key),
});

runResourceLoop(issueResourceType, {
  herd,
  // BUTCHR-91/BUTCHR-68: required as of the project tier's own second
  // `runResourceLoop` instance below — both loops share this ONE `herd`
  // (one flat `butchr-*` agent namespace), so each must scope its own
  // reconcile to only the ids it owns or they evict each other's agents on
  // every poll (see loop.ts's `scopedHerd` doc comment for the measured
  // mechanism). `isIssueKey`/`isProjectId` (src/resources/id.ts) are
  // mutually exclusive by construction — a project loop's agent can never
  // also match this predicate.
  ownsId: isIssueKey,
  notify: async (issue, about, reason) => {
    // BUTCHR-87: `reason?.pr` keeps its own dedicated rendering
    // (prReviewStateNudge, src/agents/pr-nudge.ts — guarded by
    // test/unit/merge-check-guard.test.ts, deliberately untouched here);
    // every other member of NotifyReason, plus the no-reason fallback,
    // renders through changeNudge (src/agents/change-nudge.ts) instead of
    // the old bare "was updated" text this ticket replaces.
    const msg = reason && "pr" in reason ? prReviewStateNudge(issue, reason.pr.from, reason.pr.to) : changeNudge(issue, about, reason);
    // Channel push renders mid-turn; the prompt is what STARTS a turn on an
    // idle agent (measured: an idle epic never woke on the push alone).
    void notifyIssue(mcp, issue, msg);
    const outcome = await herd.nudge(issue, msg).catch((): NudgeResult => ({ delivered: false }));
    // BUTCHR-87: was `reason?.pr ? " (pr:from→to)" : ""` — every notify line
    // now carries a reason tag, never a silent "" for the 89% that used to
    // fall through the pr-only branch (see BUTCHR-34's own journal counts,
    // the measurement this line's [notify] output makes reproducible).
    const reasonTag = notifyReasonTag(reason);
    // KAN-829: a prompt that landed on a session-limit refusal is NOT
    // "delivered" in any sense an operator cares about — say so explicitly,
    // with the reset time, so `grep '\[notify\]'` and `grep 'session limit'`
    // both surface it instead of the incident's silent "prompt delivered".
    const promptState = outcome.refusal
      ? `refused (session limit, resets ${outcome.refusal.resetsAt !== null ? new Date(outcome.refusal.resetsAt).toISOString() : "unknown"})`
      : outcome.delivered ? "delivered" : "refused/absent";
    console.error(`  [notify] ${issue} ← ${about}${reasonTag}: channel pushed, prompt ${promptState}`);
  },
  onRespawn: async (issue, reason, observedArgv) => {
    console.error(`  [reconcile] ${issue} respawned: ${reason} (was: ${observedArgv.join(" ")})`);
    // A failed notice must not undo the respawn that already happened — log and move on.
    await ops.addComment(issue, respawnComment(issue, reason, new Date().toISOString())).catch((e) =>
      console.error(`  WARNING: [reconcile] respawn notice failed for ${issue}: ${(e as Error)?.message ?? e}`));
  },
  syncLabels,
  checkParked: parkedDetector.check,
  checkAbandoned: abandonedDetector.check,
  // BUTCHR-141: the issue tier is the fast, high-volume loop (15s) — the one
  // most likely to actually observe a crash loop reach its threshold quickly.
  checkCrashLoop: issueCrashLoopDetector.check,
  // BUTCHR-147: see src/agents/reconcile-failure.ts.
  checkReconcileFailure: issueReconcileFailureDetector.check,
  log: (line) => console.error(`  ${line}`),
  intervalMs: 15_000,
  onError: (e) => console.error(`  loop error: ${(e as Error)?.message ?? e}`),
  onPollSuccess: () => loopHealth.recordSuccess(),
  onNotifySuccess: () => notifyHealth.recordSuccess(),
});

// BUTCHR-91/BUTCHR-68: the project tier's own second `runResourceLoop`
// instance — the SAME `ops` (realAtlassian) and the SAME `atlassian.search`
// Jira client the issue tier already uses above; no second Atlassian
// client, no third credential path. OPT-IN, default OFF:
// `config.projectAllowlist` is empty unless BUTCHR_PROJECT_ALLOWLIST is
// set, and the allowlist is enforced inside `loadProjects`
// (src/resources/project.ts) itself — the SOLE discovery path
// `createProjectResourceType` exposes — so an unlisted project can never
// reach `eligible`/`active` by any route this daemon takes, regardless of
// what this wiring does or forgets to do.
//
// DESIGN CHOICE, stated per the ticket: this loop ALWAYS STARTS, even with
// an empty allowlist, rather than being conditionally constructed only when
// the allowlist is non-empty. An operator reading `/health` or this
// daemon's own logs to answer "is the project tier deployed?" gets a
// truthful answer either way: `projectPollLoop`/`projectNotify` always show
// up in `/health`, and this file's own startup banner (`describeConfig`,
// above) states the allowlist plainly — a loop that silently doesn't exist
// at all whenever the list is empty would be indistinguishable, from
// outside, from this code never having shipped. The cost of always starting
// it is one poll's worth of `getMyself()` + `searchProjects("live")` every
// `PROJECT_POLL_INTERVAL_MS` (5 min) even at zero allowlisted projects —
// negligible, and it never reaches any per-project I/O (property/version/
// comment reads), since `loadProjects` filters the allowlist before any of
// that runs.
const projectResourceType = createProjectResourceType({
  ops,
  search: (jql) => atlassian.search(jql),
  allowlist: new Set(config.projectAllowlist),
});

runResourceLoop(projectResourceType, {
  herd,
  // See the issue loop's own `ownsId` comment above — the other half of the
  // same fix, via the disjoint predicate.
  ownsId: isProjectId,
  notify: async (project, about, reason) => {
    // Projects have no `pr`-reason path (`createProjectEventRules` never
    // populates `reason` at all — src/resources/project.ts) and no related/
    // Implements-chain concept (`about === project` always, per that
    // module's own `eventRules.poll`), so this is a simplified sibling of
    // the issue loop's own notify closure above, not a call into it — the
    // issue loop's own call site above is left byte-for-byte untouched.
    const msg = changeNudge(project, about, reason);
    void notifyIssue(mcp, project, msg);
    const outcome = await herd.nudge(project, msg).catch((): NudgeResult => ({ delivered: false }));
    const promptState = outcome.refusal
      ? `refused (session limit, resets ${outcome.refusal.resetsAt !== null ? new Date(outcome.refusal.resetsAt).toISOString() : "unknown"})`
      : outcome.delivered ? "delivered" : "refused/absent";
    console.error(`  [notify] ${project} ← ${about}: channel pushed, prompt ${promptState}`);
  },
  // BUTCHR-95/123: only the project tier can ever produce a non-empty
  // `atRest` (the issue tier never sleeps — ISSUE_ACTIVATION never returns
  // "asleep"), so this is wired here only. See ReconcileOptions.checkFrozenAsleep's doc comment (src/daemon/loop.ts).
  checkFrozenAsleep: frozenAsleepDetector.check,
  // BUTCHR-141: wired here too — a crash loop has no `atRest`-style
  // single-tier restriction, and the project tier is the slower loop where a
  // real crash loop still needs to reach the threshold well inside the
  // configured window (see crashLoopCount's own doc comment, config.ts).
  checkCrashLoop: projectCrashLoopDetector.check,
  // BUTCHR-147: wired here too, same reasoning — see src/agents/reconcile-failure.ts.
  checkReconcileFailure: projectReconcileFailureDetector.check,
  log: (line) => console.error(`  ${line}`),
  intervalMs: PROJECT_POLL_INTERVAL_MS,
  onError: (e) => console.error(`  project loop error: ${(e as Error)?.message ?? e}`),
  onPollSuccess: () => projectLoopHealth.recordSuccess(),
  onNotifySuccess: () => projectNotifyHealth.recordSuccess(),
});

// `ownChannelComments` (the read half symmetric to the `addComment` dep's
// speakOnOwnChannel routing above) is built once, earlier in this file, from
// the extracted `createOwnChannelComments` (src/tools/speak.ts, BUTCHR-141/
// §2.6) — and shared with `frozenAsleepDetector`, `issueCrashLoopDetector`,
// `projectCrashLoopDetector`, `issueReconcileFailureDetector` and
// `projectReconcileFailureDetector` above, and `escalator` below, rather
// than redefined per caller (BUTCHR-129/BUTCHR-141/BUTCHR-147).

// Escalates dialogs chooseStartupAnswer declines onto the blocked agent's own
// ticket (see src/agents/escalation-loop.ts) — comments are only fetched for
// issues that are currently blocked AND already escalated, never on the 15s
// Jira loop above.
//
// BUTCHR-159: the escalator's OWN `comments` dep (issue-only — a 404 for a
// project key) is gone. Every comment-read inside escalation-loop.ts —
// dedupe/adoption, the directive/follow-up check, and the sustained-
// unresponsive alarm's own restart-adoption check — now goes through the
// SAME `ownChannelComments` seam below, so a project-keyed target's
// escalation dedupe and ANSWER directive are read from the resource its
// speech actually lives on (a Confluence footer comment on its root doc),
// not from a Jira issue endpoint that never resolves for it.
const escalator = createEscalator({
  read: readPane,
  send: sendPane,
  // HAZARD 2 (BUTCHR-67/BUTCHR-81): a blocked PROJECT agent's resolved id is
  // a project key, not addressable via `ops.addComment` (MEASURED live,
  // BUTCHR-62 2026-09-01: GET /rest/api/3/issue/BUTCHR -> 404) — the write
  // failed silently, caught and logged, and the escalation ended its life
  // in a daemon log nobody watches. This is a wiring-seam change only: for
  // an issue key, `speakOnOwnChannel` calls `ops.addComment(issue, text)`
  // exactly as before (see src/tools/speak.ts) — zero issue-tier behaviour
  // change — and for a project key it routes to that project's root doc via
  // the same seam BUTCHR-71 already shipped for report_to_boss/ask_boss.
  addComment: async (issue, text) => { await speakOnOwnChannel(ops, issue, text); },
  ownChannelComments,
  unresponsiveMinutes: config.unresponsiveMinutes,
  now: () => Date.now(),
  log: (line) => console.error(`  ${line}`),
  // BUTCHR-16: durably capture the full pane text at the moment a dialog
  // escalates, so the NEXT unknown shape can be fixtured from the escalation
  // itself instead of vanishing within hours like the effort-recommendation
  // dialog that opened this ticket. Shares config.captureDir with the
  // session-limit watcher's own captures (capture-store.ts); each recognizes
  // only its own filename shape, so neither ever evicts the other's files.
  captures: createCaptureStore(config.captureDir),
  coverage,
});

// Resolves a pane's issue key the same way for onExposed and onUnparseable —
// both need it, and neither can assume the caller already has it.
async function issueForPane(paneId: string): Promise<string | null> {
  const { agents } = await herdr.agent.list();
  return issueOfAgentName(agents.find((a) => a.pane_id === paneId)?.name);
}

// BUTCHR-5/16: a pane herdr reports idle/done for >= config.idleDialogMinutes
// whose text parses as a dialog, and whose trailing region isn't a recognized
// STALE scrollback quote, is folded into `.list()`'s rows as a "blocked"
// agent_status override, so it flows through blockedNow's existing filter
// exactly like a herdr-native "blocked" pane — blockedNow itself
// (src/agents/blocked.ts) stays pure and untouched. Pane text is only ever
// read for a pane that already cleared the cheap idle-duration precondition
// (see idle-dialog.ts) — this poll otherwise costs the same one
// herdr.agent.list() call it always did. `.isUnknownTrailing` is consulted
// below in onPrompt: a pane whose trailing region we could not classify as
// either genuinely live or a recognized stale quote must never be
// auto-answered on that unverifiable evidence, only escalated.
const idleDialogDetector = withIdleDialogDetection(
  async () => (await herdr.agent.list()).agents.map((a) => ({ pane_id: a.pane_id, agent_status: a.agent_status })),
  // idle-dialog.ts already prefixes its own log lines with [idle-dialog]
  // (the house convention — see stalled.ts/session-limit-watch.ts's own
  // wiring below); this callback stays bare or lines come out
  // double-tagged.
  { now: () => Date.now(), minutes: config.idleDialogMinutes, read: readPane, log: (line) => console.error(`  ${line}`) },
);

watchPrompts({
  onBlocked: (cb) => watchBlocked(
    idleDialogDetector.list,
    5_000, cb,
    (e) => console.error(`  [prompts] status poll failed: ${(e as Error)?.message ?? e}`),
    // Per-tick, synchronous: lets the escalator see the polls it was NOT
    // called on (the pane wasn't blocked), which is what resets a flickering
    // pane's debounce (KAN-756, item A).
    (blockedPaneIds, pollSeq) => escalator.onPoll(pollSeq, blockedPaneIds),
  ),
  read: readPane,
  send: sendPane,
  // KNOWN TOCTOU (PR #104 review, non-blocking, deliberate): `isUnknownTrailing`
  // reflects `idleDialogDetector.list`'s classification from the START of
  // this same tick; watchPrompts has just re-read the pane fresh and decides
  // via `parsePrompt` alone. The gap is milliseconds within one tick, and the
  // pane would have to transition from a genuinely-unverifiable trailing
  // shape to a clean one in that window — not worth a second, cache-fresh
  // classification. The strong check gates ONLY whether an idle-detected
  // pane may be auto-answered at all, never the send itself.
  onPrompt: ({ paneId, prompt }) => {
    if (idleDialogDetector.isUnknownTrailing(paneId)) {
      console.error(`  [prompts] ${paneId} "${prompt.question.slice(0, 60)}" → left for a human (idle-detected dialog with an unverifiable trailing shape — never auto-answered)`);
      return undefined;
    }
    const choice = chooseStartupAnswer(prompt);
    console.error(`  [prompts] ${paneId} "${prompt.question.slice(0, 60)}" → ${choice != null ? `answer ${choice} ("${prompt.options[choice - 1]?.slice(0, 40)}")` : "left for a human"}`);
    return choice ?? undefined;
  },
  // onExposed is typed void — this async body's promise goes unawaited by the
  // caller, so a rejection here (e.g. herdr.agent.list() failing) would
  // otherwise surface as an unhandled rejection instead of a [prompts] line.
  onExposed: ({ paneId, prompt, pollSeq }) => {
    void (async () => {
      try {
        const issue = await issueForPane(paneId);
        await escalator.onBlocked(paneId, issue, prompt, pollSeq);
      } catch (e) {
        console.error(`  [prompts] onExposed error: ${(e as Error)?.message ?? e}`);
      }
    })();
  },
  // A blocked pane whose text does not parse as a dialog (KAN-756, item C) —
  // resets the debounce like any other gap and logs, deduplicated by the
  // escalator, instead of being silently dropped.
  onUnparseable: ({ paneId, text, pollSeq }) => {
    void (async () => {
      try {
        const issue = await issueForPane(paneId);
        escalator.onNoPrompt(paneId, issue, text, pollSeq);
      } catch (e) {
        console.error(`  [prompts] onUnparseable error: ${(e as Error)?.message ?? e}`);
      }
    })();
  },
  onError: (e) => console.error(`  [prompts] error: ${(e as Error)?.message ?? e}`),
});

atlassian.search(ISSUE_JQL)
  .then((issues) => console.error(`  ${issues.length} active issue(s) assigned to this credential`))
  .catch((e) => console.error(`  WARNING: Atlassian credential check failed: ${e.message}`));
