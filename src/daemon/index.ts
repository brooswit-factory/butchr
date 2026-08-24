import { readFileSync } from "node:fs";
import { loadConfig, describeConfig } from "../config/config.js";
import { AtlassianClient } from "../atlassian/client.js";
import { buildApp } from "./app.js";

// Entry point. Kept thin: parse config, build the app, listen. The watch and
// reconcile loops are wired here as they land.
let config;
try {
  config = loadConfig(process.env as Record<string, string | undefined>, (p) => readFileSync(p, "utf8"));
} catch (e) {
  console.error(`butchr: ${(e as Error).message}`);
  console.error("See .env.example for the required configuration.");
  process.exit(1);
}
const atlassian = new AtlassianClient(config.atlassian.site, config.atlassian.email, config.atlassian.token);
const { app } = buildApp();

app.listen(config.port);
console.error(`butchr daemon on http://localhost:${config.port}  (${describeConfig(config)})`);

// Smoke the credential once at startup so a bad token fails loudly and early.
atlassian
  .search("assignee = currentUser() AND status IN (\"In Progress\", \"In Review\")")
  .then((issues) => console.error(`  ${issues.length} active issue(s) assigned to this credential`))
  .catch((e) => console.error(`  WARNING: Atlassian credential check failed: ${e.message}`));
