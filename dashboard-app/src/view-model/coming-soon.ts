/**
 * local/ui — the Coming soon page's list: what butchr does that this web app
 * can't show or change yet, and where each lives today. Kept by hand; when a
 * page gains one of these, take it off here.
 */

export interface ComingSoonItem {
  title: string;
  detail: string;
  /** Where it lives today: a file, a setting, a command. */
  today: string;
}

export interface ComingSoonGroup {
  id: string;
  title: string;
  items: readonly ComingSoonItem[];
}

export const COMING_SOON: readonly ComingSoonGroup[] = [
  {
    id: "rules",
    title: "Rules",
    items: [
      { title: "Relationships between rules", detail: "A rule's child rule and the rules connected into it.", today: "rules.json: relationships" },
      { title: "Extra MCP servers", detail: "MCP servers a rule's agents get on top of butchr's own, and a project rule's MCP config file.", today: "rules.json: mcpServers, mcpConfigFile" },
      { title: "Start limits per rule", detail: "How many new agents a rule may start each poll, and how long it waits between starts.", today: "rules.json: maxNewPerTick, minSecondsBetweenAdmissions" },
      { title: "Fallback agents", detail: "The second and later harness and model choices, used when the first can't run. The Rules page shows them read-only.", today: "rules.json: agentPreferences" },
      { title: "A specific agent for an existing rule", detail: "Choosing a harness and model for a rule that was saved without one.", today: "rules.json: agentPreferences" },
      { title: "Idle poke on a new rule", detail: "New rules save with idle pokes off.", today: "the Rules page, after saving" },
      { title: "Back to the default permission mode", detail: "Clearing a rule's permission mode once one is set.", today: "rules.json: permissionMode" },
      { title: "Test query for every rule type", detail: "Test query runs only for Jira ticket and Product Discovery idea rules.", today: "butchr rules check (syntax only for the rest)" },
      { title: "Undo a save", detail: "butchr backs up rules.json before every save and can restore a backup.", today: "~/.config/butchr/rules.json.bak-*" },
      { title: "Check a rules file", detail: "Validate a whole rules file and dry-run its Jira queries before butchr loads it.", today: "butchr rules check [file]" },
      { title: "Jira component rules", detail: "A rule type upstream has started on: one agent per Jira component. butchr can't run it yet, so Add rule doesn't offer it.", today: "rules.json: resourceProvider \"jira-component\"" },
    ],
  },
  {
    id: "settings",
    title: "Settings",
    items: [
      { title: "Changing most daemon settings", detail: "Detector thresholds, assignees, the project allowlist, paths, the port, the herdr and terminal settings and the approval sound show read-only on Settings.", today: ".env" },
      { title: "Settings the page doesn't show", detail: "Idle-poke mode and limits, silent-stop mode, the stall wake comment (off unless set to live), the blocked- and stalled-wake debounces, the stalled-wake hourly cap and the loop watchdog threshold.", today: ".env: BUTCHR_IDLE_POKE_*, BUTCHR_SILENT_STOP_*, BUTCHR_STALL_REMEDIATION_MODE, BUTCHR_*_WAKE_*, BUTCHR_LOOP_WATCHDOG_THRESHOLD_MS" },
      { title: "Catamorbius push", detail: "Pushed change notices that let linked-change events skip polling: the server, its token, which providers it covers and its timings.", today: ".env: CATAMORBIUS_URL, CATAMORBIUS_TOKEN_FILE, CATAMORBIUS_PROVIDERS, CATAMORBIUS_*_MS" },
      { title: "Clearing a saved setting", detail: "Putting a value saved from Settings back to butchr's default.", today: "~/.config/butchr/settings.json" },
      { title: "The Atlassian site and account", detail: "Which Jira and Confluence site and account butchr uses. Settings can replace the token, not these.", today: ".env: ATLASSIAN_SITE, ATLASSIAN_EMAIL" },
    ],
  },
  {
    id: "health",
    title: "Status and health",
    items: [
      { title: "Detector coverage", detail: "Which detectors are watching which resources.", today: "/health: coverage" },
      { title: "Watchdog and wake counters", detail: "Loop watchdog reports, skipped comment checks and stalled-wake counts.", today: "/health: loopWatchdog, commentChecksSkipped, stalledWakes" },
      { title: "Problems butchr has flagged", detail: "Rule relationships that don't resolve, a dead credential, Codex dialogs butchr didn't recognize.", today: "/health" },
      { title: "Ops alerts", detail: "The conditions butchr raises an ops alert for.", today: "[butchr:ops-alert] lines in the log" },
      { title: "Catamorbius push status", detail: "Whether push mode is connected, and its notice counts.", today: "[catamorbius] lines in the log" },
      { title: "Log history and search", detail: "The Status page shows the last 200 lines.", today: "~/Library/Logs/butchr.log" },
    ],
  },
  {
    id: "agents",
    title: "Agents",
    items: [
      { title: "What an agent is doing", detail: "Its conversation and latest output.", today: "open terminal (its herdr pane)" },
    ],
  },
  {
    id: "history",
    title: "History and audits",
    items: [
      { title: "Dashboard write audit", detail: "Every write made from this dashboard, and how it went.", today: "~/.config/butchr/web-write-audit.jsonl" },
      { title: "Permission audit", detail: "Every permission prompt lizard mode answered.", today: "BUTCHR_PERMISSION_AUDIT_PATH (a JSONL file)" },
      { title: "Pane captures", detail: "What a pane showed when an agent hit a session limit, when a blocked dialog was escalated, and when a blocked pane had no ticket to escalate to.", today: "BUTCHR_CAPTURE_DIR" },
    ],
  },
];

/** What stays outside the web app on purpose, so it isn't mistaken for a gap. */
export const ON_PURPOSE: readonly ComingSoonItem[] = [
  { title: "The Zendesk and Trello opt-ins", detail: "Agents can read those credentials, so turning them on stays an .env decision.", today: ".env: BUTCHR_ZENDESK_ACCEPT_SHELL_CREDENTIAL_RISK, BUTCHR_TRELLO_ACCEPT_SHELL_CREDENTIAL_RISK" },
  { title: "Setup codes", detail: "Printed only to butchr's log, so only someone at this machine can approve a token change.", today: "launchctl kill SIGUSR2, then the log" },
];
