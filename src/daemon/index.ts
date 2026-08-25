import { readFileSync } from "node:fs";
import { HerdrClient } from "@brooswit/herdr-sdk";
import { loadConfig, describeConfig } from "../config/config.js";
import { AtlassianClient } from "../atlassian/client.js";
import { buildApp, notifyIssue } from "./app.js";
import { HerdrHerd, issueOfAgentName } from "../agents/herd.js";
import { startLoop } from "./loop.js";
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
startLoop({
  search: async () => {
    const issues = await atlassian.search(JQL);
    for (const i of issues) summaries.set(i.key, i.summary);
    return issues;
  },
  herd,
  notify: (issue) => void notifyIssue(mcp, issue, `Ticket ${issue} was updated — re-read it.`),
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
