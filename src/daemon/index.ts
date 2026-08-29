import { readFileSync } from "node:fs";
import { HerdrClient } from "@brooswit/herdr-sdk";
import { loadConfig, describeConfig } from "../config/config.js";
import { AtlassianClient } from "../atlassian/client.js";
import { buildApp, notifyIssue } from "./app.js";
import { HerdrHerd, issueOfAgentName } from "../agents/herd.js";
import { startLoop, type RelatedIssue } from "./loop.js";
import { watchedKeys } from "../jira-watch/routes.js";
import { watchPrompts } from "../agents/prompt-watch.js";
import { chooseStartupAnswer } from "../agents/prompt.js";
import { watchBlocked } from "../agents/blocked.js";
import { createEscalator } from "../agents/escalation-loop.js";
import { detectTerminalPrefix } from "../terminal/open.js";
import { realAtlassian } from "../tools/atlassian-real.js";
import { atlassianTools } from "../tools/defs.js";
import { createLabelSync } from "../labels/sync.js";
import { createNotifyGate } from "../labels/notify-gate.js";
import { PrTracker } from "../labels/pr.js";
import { sweepStaleAgentLabels } from "../labels/sweep.js";
import { respawnComment } from "../agents/respawn.js";

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
}, atlassianTools(ops, undefined, config.assignees));
app.listen(config.port);
console.error(`butchr daemon on http://localhost:${config.port}  (${describeConfig(config)})`);
console.error(`  terminal: ${terminalPrefix ? terminalPrefix.join(" ") : "NONE — set BUTCHR_TERMINAL to open agent shells"}`);
if (!config.github) console.error("  pr:* labels disabled: set GITHUB_TOKEN_FILE and BUTCHR_GITHUB_ORGS to enable PR discovery");

const prTracker = config.github ? new PrTracker({ fetchImpl: fetch, token: config.github.token, orgs: config.github.orgs }) : undefined;
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
  ...(prTracker ? { prState: (key: string) => prTracker.stateFor(key) } : {}),
  log: (line) => console.error(`  ${line}`),
});

// One-time startup sweep: agent:* stranded by a ticket that went inactive
// while the daemon was down. createLabelSync's bookkeeping is in-memory and
// the 15s poll only ever sees active tickets, so nothing else ever revisits
// this. Not a new polling timer — runs once, here, and never again.
void sweepStaleAgentLabels({
  search: (jql) => atlassian.search(jql),
  jira: labelWriter,
  log: (line) => console.error(`  ${line}`),
}).catch((e) => console.error(`  WARNING: startup agent:* sweep failed: ${(e as Error)?.message ?? e}`));

const JQL = 'assignee = currentUser() AND status IN ("In Progress", "In Review") ORDER BY updated DESC';
const KEY_RE = /^[A-Z][A-Z0-9]*-\d+$/;

// Related work for the active set: the Implements chain (a boss watches what
// implements it — a story hears its tasks, an epic hears its stories).
// Watched regardless of assignee — the assigned-issues query above is
// per-credential, but a boss must hear about its implementer's progress even
// when another account (another machine's daemon) staffs it. A thin I/O
// adapter over routes.ts: this function fetches links and hydrates issues;
// routes.ts decides which links are routed.
const related = async (active: readonly string[]): Promise<RelatedIssue[]> => {
  const keys = active.filter((k) => KEY_RE.test(k));
  if (!keys.length) return [];
  const out = new Map<string, { issue: import("../atlassian/types.js").JiraIssue; watchers: Set<string> }>();
  const add = (issue: import("../atlassian/types.js").JiraIssue, watcher: string) => {
    const e = out.get(issue.key) ?? { issue, watchers: new Set<string>() };
    e.issue = issue;
    e.watchers.add(watcher);
    out.set(issue.key, e);
  };
  const linkWatchers = new Map<string, Set<string>>();
  for (const k of keys)
    for (const other of watchedKeys(await atlassian.links(k))) {
      // Active ends are NOT skipped: a boss and its implementer can both be
      // staffed by this same daemon (same assignee credential), and the boss
      // must still hear its implementer's changes through this link. The
      // loop's `sent` dedupe (`${issue}|${about}`) already prevents the
      // implementer's own agent being notified twice about itself.
      if (!KEY_RE.test(other)) continue;
      (linkWatchers.get(other) ?? linkWatchers.set(other, new Set()).get(other)!).add(k);
    }
  const linked = [...linkWatchers.keys()];
  if (linked.length)
    for (const i of await atlassian.search(`key IN (${linked.join(",")})`))
      for (const w of linkWatchers.get(i.key) ?? []) add(i, w);
  return [...out.values()].map((e) => ({ issue: e.issue, watchers: [...e.watchers] }));
};

startLoop({
  search: async () => {
    const issues = await atlassian.search(JQL);
    for (const i of issues) summaries.set(i.key, i.summary);
    return issues;
  },
  related,
  herd,
  notify: async (issue, about) => {
    const msg = about === issue
      ? `[butchr] Ticket ${issue} was updated — re-read it.`
      : `[butchr] ${about} (related to your ${issue}) was updated — re-read it, then act on what changed.`;
    // Channel push renders mid-turn; the prompt is what STARTS a turn on an
    // idle agent (measured: an idle epic never woke on the push alone).
    void notifyIssue(mcp, issue, msg);
    const woke = await herd.nudge(issue, msg).catch(() => false);
    console.error(`  [notify] ${issue} ← ${about}: channel pushed, prompt ${woke ? "delivered" : "refused/absent"}`);
  },
  onRespawn: async (issue, reason, observedArgv) => {
    console.error(`  [reconcile] ${issue} respawned: ${reason} (was: ${observedArgv.join(" ")})`);
    // A failed notice must not undo the respawn that already happened — log and move on.
    await ops.addComment(issue, respawnComment(issue, reason, new Date().toISOString())).catch((e) =>
      console.error(`  WARNING: [reconcile] respawn notice failed for ${issue}: ${(e as Error)?.message ?? e}`));
  },
  syncLabels,
  intervalMs: 15_000,
  onError: (e) => console.error(`  loop error: ${(e as Error)?.message ?? e}`),
});

const readPane = async (paneId: string) => (await herdr.pane.read({ pane_id: paneId, source: "detection", strip_ansi: true })).read.text;
const sendPane = async (paneId: string, text: string) => { await herdr.pane.sendText({ pane_id: paneId, text }); };

// Escalates dialogs chooseStartupAnswer declines onto the blocked agent's own
// ticket (see src/agents/escalation-loop.ts) — comments are only fetched for
// issues that are currently blocked AND already escalated, never on the 15s
// Jira loop above.
const escalator = createEscalator({
  read: readPane,
  send: sendPane,
  addComment: async (issue, text) => { await ops.addComment(issue, text); },
  comments: (issue) => atlassian.comments(issue),
  now: () => Date.now(),
  log: (line) => console.error(`  ${line}`),
});

// Resolves a pane's issue key the same way for onExposed and onUnparseable —
// both need it, and neither can assume the caller already has it.
async function issueForPane(paneId: string): Promise<string | null> {
  const { agents } = await herdr.agent.list();
  return issueOfAgentName(agents.find((a) => a.pane_id === paneId)?.name);
}

watchPrompts({
  onBlocked: (cb) => watchBlocked(
    async () => (await herdr.agent.list()).agents.map((a) => ({ pane_id: a.pane_id, agent_status: a.agent_status })),
    5_000, cb,
    (e) => console.error(`  [prompts] status poll failed: ${(e as Error)?.message ?? e}`),
    // Per-tick, synchronous: lets the escalator see the polls it was NOT
    // called on (the pane wasn't blocked), which is what resets a flickering
    // pane's debounce (KAN-756, item A).
    (blockedPaneIds, pollSeq) => escalator.onPoll(pollSeq, blockedPaneIds),
  ),
  read: readPane,
  send: sendPane,
  onPrompt: ({ paneId, prompt }) => {
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

atlassian.search(JQL)
  .then((issues) => console.error(`  ${issues.length} active issue(s) assigned to this credential`))
  .catch((e) => console.error(`  WARNING: Atlassian credential check failed: ${e.message}`));
