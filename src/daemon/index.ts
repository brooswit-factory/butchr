import { readFileSync } from "node:fs";
import { HerdrClient } from "@brooswit/herdr-sdk";
import { loadConfig, describeConfig } from "../config/config.js";
import { AtlassianClient } from "../atlassian/client.js";
import { buildApp, notifyIssue } from "./app.js";
import { HerdrHerd } from "../agents/herd.js";
import { startLoop } from "./loop.js";
import { watchPrompts } from "../agents/prompt-watch.js";
import { watchBlocked } from "../agents/blocked.js";

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
const { app, mcp } = buildApp();
app.listen(config.port);
console.error(`butchr daemon on http://localhost:${config.port}  (${describeConfig(config)})`);

const herd = new HerdrHerd(herdr, `http://localhost:${config.port}/mcp`);
const JQL = 'assignee = currentUser() AND status IN ("In Progress", "In Review") ORDER BY updated DESC';

startLoop({
  search: () => atlassian.search(JQL),
  herd,
  notify: (issue) => void notifyIssue(mcp, issue, `Ticket ${issue} was updated — re-read it.`),
  intervalMs: 15_000,
  onError: (e) => console.error(`  loop error: ${(e as Error)?.message ?? e}`),
});

// Auto-answer the launch prompts that would otherwise block an unattended agent.
watchPrompts({
  onBlocked: (cb) => watchBlocked(
    async () => (await herdr.agent.list()).agents.map((a) => ({ pane_id: a.pane_id, agent_status: a.agent_status })),
    5_000, cb,
  ),
  read: async (paneId) => (await herdr.pane.read({ pane_id: paneId, source: "detection", strip_ansi: true })).read.text,
  send: async (paneId, text) => { await herdr.pane.sendText({ pane_id: paneId, text }); },
  onPrompt: ({ prompt }) => {
    const first = prompt.options[0] ?? "";
    if (/trust this folder|local development|resume from summary/i.test(prompt.question + " " + first)) return 1;
    return undefined; // a real decision — leave it for a human
  },
});

atlassian
  .search(JQL)
  .then((issues) => console.error(`  ${issues.length} active issue(s) assigned to this credential`))
  .catch((e) => console.error(`  WARNING: Atlassian credential check failed: ${e.message}`));
