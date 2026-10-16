/**
 * FACTORY-621 (GitHub issue #616) — `butchr rules check [file]`: validate a
 * rules file and dry-run each enabled Jira-backed rule's query, with NOTHING
 * else touched. A brand-new user pointed at their own account can otherwise
 * have `maxAgents` real tickets staffed on the very first poll with no way
 * to see that coming (docs/rules.example.json's own convention is
 * `assignee = currentUser()`); this command answers "what would happen"
 * before the daemon ever runs.
 *
 * Same precedent as `link-cli.ts`/`session-cli.ts`: dispatched from a guard
 * at the top of `src/daemon/index.ts`, before that file's own config/rules
 * loading.
 *
 * REUSE, NOT RE-DERIVATION:
 * - validation goes through `loadRulesFileState` (`../agents/query-agent-
 *   inventory.ts`), the exact non-throwing wrapper around `loadRules`
 *   (`../rules/rules.ts`) the `/config-inventory` route already uses — never
 *   a second parser.
 * - the dry-run goes through `searchRules`/`searchJiraIdeaRules`
 *   (`../rules/resource-type.ts` / `../rules/jira-idea-type.ts`) — the exact
 *   functions the daemon's own `jira-work`/`jira-idea` loops call each poll
 *   — fed a `search` function built from the SAME `AtlassianClient.searchAll`
 *   (`../atlassian/client.ts`) the daemon itself constructs from `loadConfig`
 *   (`../config/config.ts`). No rule-matching logic is reimplemented here.
 *
 * STRICTLY READ-ONLY, BY CONSTRUCTION, NOT BY DISCIPLINE: the only Jira
 * capability this file ever obtains is `AtlassianClient.searchAll` (a GET) —
 * there is no herdr/herd import, no `updateLabels`, no `comments`, nothing
 * that could spawn an agent or write a label/comment anywhere in this
 * module's import graph. `test/unit/rules-cli.test.ts` proves this against a
 * real `AtlassianClient` with a recording `fetchImpl`: every captured
 * request is a GET to the search endpoint, never a write.
 *
 * Only `jira-work`/`jira-idea` rules are dry-run: their `query` is JQL
 * executed against THIS Jira site over the exact path above. Every other
 * provider's query uses a different search syntax (GitHub issue/PR search,
 * Zendesk search, a JSON object for `jira-project`/`filesystem`) that this
 * command does not execute — its syntax was already checked by the
 * validation pass above, and this command says so plainly rather than
 * silently skipping it.
 */
import { readFileSync } from "node:fs";
import { loadConfig, type Config } from "../config/config.js";
import { AtlassianClient, type FetchLike } from "../atlassian/client.js";
import type { JiraIssue } from "../atlassian/types.js";
import { loadRulesFileState, type RulesFileState } from "../agents/query-agent-inventory.js";
import type { ReadRulesFile, Rule, RulesEnv } from "../rules/rules.js";
import { searchRules } from "../rules/resource-type.js";
import { searchJiraIdeaRules } from "../rules/jira-idea-type.js";

const USAGE = `usage: butchr rules check [file]

Validates a rules file (default: the same path the daemon would read —
BUTCHR_RULES_FILE, else $XDG_CONFIG_HOME/butchr/rules.json, else
~/.config/butchr/rules.json) and dry-runs every enabled jira-work/jira-idea
rule's JQL against this daemon's own configured Jira site.

Read-only: starts nothing, posts nothing, writes nothing. Exits non-zero on
a validation problem.`;

/** The Jira capability this command needs — ONLY a read, never a write or spawn (see this file's own top comment). */
export interface RulesCheckJiraEnv {
  maxAgents: number;
  search: (jql: string) => Promise<JiraIssue[]>;
}

export interface RulesCliIo {
  env: RulesEnv;
  /** Injectable for tests against fixture text, exactly as `loadRulesFileState` itself allows. */
  readRulesFile?: ReadRulesFile;
  /** May throw (e.g. missing Atlassian credentials) — reported as a clear message, never an uncaught crash. */
  loadJiraEnv: () => RulesCheckJiraEnv;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

/**
 * Builds the one Jira capability this command ever uses, from the SAME
 * environment/config the daemon itself reads — `fetchImpl` is injectable
 * purely for `test/unit/rules-cli.test.ts`'s own recording-fetch proof that
 * nothing but a GET search ever happens.
 */
export function createJiraEnv(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
  fetchImpl?: FetchLike,
  readFile: (path: string) => string = (p) => readFileSync(p, "utf8"),
): RulesCheckJiraEnv {
  const config: Config = loadConfig(env, readFile);
  const atlassian = new AtlassianClient(config.atlassian.site, config.atlassian.email, config.atlassian.token, fetchImpl);
  return { maxAgents: config.maxAgents, search: (jql) => atlassian.searchAll(jql) };
}

function defaultIo(): RulesCliIo {
  return {
    env: process.env as RulesEnv,
    loadJiraEnv: () => createJiraEnv(),
    stdout: (l) => console.log(l),
    stderr: (l) => console.error(l),
  };
}

const JIRA_BACKED_PROVIDERS = new Set(["jira-work", "jira-idea"]);

const STATUS_WIDTH = 16;

/** One line per matched ticket: key, status (padded), summary — exactly the three fields the ticket asks for. */
function formatMatch(issue: JiraIssue): string {
  const status = issue.status.length >= STATUS_WIDTH ? `${issue.status} ` : issue.status.padEnd(STATUS_WIDTH);
  return `    ${issue.key}  ${status}${issue.summary}`;
}

/**
 * Runs the dry-run over every enabled `jira-work`/`jira-idea` rule, writing
 * output as it goes via `stdout`. Returns the total real-ticket count across
 * every rule (for the impossible-to-miss summary line) — `null` if the
 * Jira query itself failed (credentials, network, a malformed JQL Jira
 * itself rejects), which the caller reports and turns into exit 1.
 */
async function dryRunJiraRules(
  jiraRules: readonly Rule[],
  jira: RulesCheckJiraEnv,
  stdout: (line: string) => void,
  stderr: (line: string) => void,
): Promise<number | null> {
  let work, ideas;
  try {
    [work, ideas] = await Promise.all([
      searchRules({ rules: jiraRules, search: jira.search }),
      searchJiraIdeaRules({ rules: jiraRules, search: jira.search }),
    ]);
  } catch (e) {
    stderr(`butchr rules check: dry-run query failed, treating this as "could not check" rather than "zero matches": ${(e as Error)?.message ?? e}`);
    return null;
  }
  const byRule = new Map<string, JiraIssue[]>();
  for (const m of [...work, ...ideas]) byRule.set(m.rule.id, [...(byRule.get(m.rule.id) ?? []), m.issue]);

  let total = 0;
  for (const rule of jiraRules) {
    const matches = byRule.get(rule.id) ?? [];
    total += matches.length;
    stdout("");
    stdout(`[${rule.id}] ${rule.resourceProvider}: ${rule.query}`);
    if (!matches.length) {
      stdout("  would staff 0 ticket(s)");
      continue;
    }
    stdout(`  would staff ${matches.length} ticket(s):`);
    for (const issue of matches) stdout(formatMatch(issue));
    if (matches.length > jira.maxAgents) {
      stdout(`  WARNING: ${matches.length} match(es) exceed maxAgents=${jira.maxAgents} — only ${jira.maxAgents} would run across the WHOLE fleet this poll; the rest wait for capacity (see BUTCHR_MAX_AGENTS)`);
    }
  }
  return total;
}

/** `argv` is everything AFTER `rules` (i.e. `process.argv.slice(3)` when `process.argv[2] === "rules"`). Returns the process exit code; never throws. */
export async function runRulesCli(argv: string[], io: RulesCliIo = defaultIo()): Promise<number> {
  const [sub, ...rest] = argv;

  if (sub === "--help" || sub === "-h") {
    io.stdout(USAGE);
    return 0;
  }
  if (sub === undefined) {
    io.stderr(USAGE);
    return 1;
  }
  if (sub !== "check") {
    io.stderr(`butchr rules: unknown subcommand ${JSON.stringify(sub)}\n\n${USAGE}`);
    return 1;
  }
  if (rest.length > 1) {
    io.stderr(`butchr rules check: expected at most one argument (a rules file path)\n\n${USAGE}`);
    return 1;
  }

  const file = rest[0];
  const env: RulesEnv = file !== undefined ? { ...io.env, BUTCHR_RULES_FILE: file } : io.env;
  const state: RulesFileState = loadRulesFileState(env, io.readRulesFile);

  if (state.error) {
    io.stderr(`butchr rules check: ${state.path} failed to validate:`);
    for (const line of state.error.message.split("\n")) io.stderr(`  ${line}`);
    return 1;
  }

  if (!state.rules.length) {
    io.stdout(`${state.path}: 0 rules — nothing will be staffed.`);
    io.stdout(`See the README's "First run" section for how to write and test your first rule.`);
    return 0;
  }

  const enabled = state.rules.filter((r) => r.enabled);
  io.stdout(`${state.path}: ${state.rules.length} rule(s) valid, ${enabled.length} enabled.`);

  const jiraRules = enabled.filter((r) => JIRA_BACKED_PROVIDERS.has(r.resourceProvider));
  const otherRules = enabled.filter((r) => !JIRA_BACKED_PROVIDERS.has(r.resourceProvider));

  io.stdout("");
  io.stdout("Dry run — read-only: starts nothing, posts nothing, writes nothing.");

  for (const rule of otherRules) {
    io.stdout("");
    io.stdout(`[${rule.id}] ${rule.resourceProvider}: not dry-run by "butchr rules check" (not a Jira-backed provider) — its query syntax was already validated above`);
  }

  if (!jiraRules.length) {
    io.stdout("");
    io.stdout("no enabled jira-work/jira-idea rules to dry-run.");
    return 0;
  }

  let jira: RulesCheckJiraEnv;
  try {
    jira = io.loadJiraEnv();
  } catch (e) {
    io.stderr(`butchr rules check: cannot reach Jira to dry-run ${jiraRules.length} rule(s): ${(e as Error)?.message ?? e}`);
    return 1;
  }

  const total = await dryRunJiraRules(jiraRules, jira, io.stdout, io.stderr);
  if (total === null) return 1;

  io.stdout("");
  io.stdout(total > 0
    ? `>>> WOULD STAFF ${total} REAL TICKET(S) across ${jiraRules.length} jira-work/jira-idea rule(s) <<<`
    : `0 tickets matched across ${jiraRules.length} jira-work/jira-idea rule(s) — nothing would be staffed right now.`);
  return 0;
}
