import { readFileSync } from "node:fs";
import { HerdrClient } from "@brooswit/herdr-sdk";
import { loadConfig, describeConfig } from "../config/config.js";
import { AtlassianClient } from "../atlassian/client.js";
import { buildApp, notifyIssue } from "./app.js";
import { HerdrHerd, issueOfAgentName } from "../agents/herd.js";
import { startLoop, type RelatedIssue } from "./loop.js";
import { watchPrompts } from "../agents/prompt-watch.js";
import { watchBlocked } from "../agents/blocked.js";
import { detectTerminalPrefix } from "../terminal/open.js";
import { realAtlassian } from "../tools/atlassian-real.js";
import { atlassianTools } from "../tools/defs.js";

let config;
try {
  config = loadConfig(process.env as Record<string, string | undefined>, (p) => readFileSync(p, "utf8"));
} catch (e) {
  console.error(`butchr: ${(e as Error).message}`);
  console.error("See .env.example for the required configuration.");
  process.exit(1);
}

const atlassian = new AtlassianClient(config.atlassian.site, config.atlassian.email, config.atlassian.token);
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
}, atlassianTools(ops));
app.listen(config.port);
console.error(`butchr daemon on http://localhost:${config.port}  (${describeConfig(config)})`);
console.error(`  terminal: ${terminalPrefix ? terminalPrefix.join(" ") : "NONE — set BUTCHR_TERMINAL to open agent shells"}`);

const JQL = 'assignee = currentUser() AND status IN ("In Progress", "In Review") ORDER BY updated DESC';
const KEY_RE = /^[A-Z][A-Z0-9]*-\d+$/;

// Related work for the active set: children of each active ticket, plus the
// tickets linked to it. Watched regardless of assignee — the assigned-issues
// query above is per-credential, but a reviewer must hear about its child's
// progress even when another account (another machine's daemon) staffs it.
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
  for (const c of await atlassian.search(`parent IN (${keys.join(",")})`))
    if (c.parent) add(c, c.parent);
  const linkWatchers = new Map<string, Set<string>>();
  for (const k of keys)
    for (const l of await atlassian.links(k)) {
      if (!KEY_RE.test(l.key) || keys.includes(l.key)) continue; // active ends are already watched
      (linkWatchers.get(l.key) ?? linkWatchers.set(l.key, new Set()).get(l.key)!).add(k);
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
  notify: (issue, about) => void notifyIssue(mcp, issue, about === issue
    ? `Ticket ${issue} was updated — re-read it.`
    : `${about} (related to your ${issue}) was updated — re-read it, then act on what changed.`),
  intervalMs: 15_000,
  onError: (e) => console.error(`  loop error: ${(e as Error)?.message ?? e}`),
});

watchPrompts({
  onBlocked: (cb) => watchBlocked(
    async () => (await herdr.agent.list()).agents.map((a) => ({ pane_id: a.pane_id, agent_status: a.agent_status })),
    5_000, cb,
  ),
  read: async (paneId) => (await herdr.pane.read({ pane_id: paneId, source: "detection", strip_ansi: true })).read.text,
  send: async (paneId, text) => { await herdr.pane.sendText({ pane_id: paneId, text }); },
  onPrompt: ({ prompt }) => (/trust this folder|local development|resume from summary|settings warning/i.test(prompt.question + " " + (prompt.options[0] ?? "")) ? 1 : undefined),
});

atlassian.search(JQL)
  .then((issues) => console.error(`  ${issues.length} active issue(s) assigned to this credential`))
  .catch((e) => console.error(`  WARNING: Atlassian credential check failed: ${e.message}`));
