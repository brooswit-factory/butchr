import { decodeAgentKey } from '../rules/agent-key.js';
import { ResourceConnections } from '../agents/resource-connections.js';
import { createJiraProjectResourceType, ownsJiraProjectAgent } from '../rules/jira-project-type.js';
import { readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { DrovrClient } from "@brooswit/drovr";
import { installLogSink } from "./log-sink.js";
import { loadConfig, describeConfig } from "../config/config.js";
import { AtlassianClient } from "../atlassian/client.js";
import { buildApp, notifyAgent } from "./app.js";
import { inventoryCodexMcp } from "../agents/argv.js";
import { inventoryAgyMcp } from "../mcp/registration.js";
import { combineHealth, createLoopHealth, createResourceLoopHealth } from "./health.js";
import { DAEMON_HOSTNAME, listenOptions } from "./listen.js";
import { createCoverageTracker } from "./coverage.js";
import { createCurrencyTracker } from "./currency.js";
import { HerdrHerd, type NudgeResult } from "../agents/herd.js";
import { createCodexChannelRelayPool } from "../notify/codex-channel-relay.js";
import { agentIdOfWorkspacePath, resourceKeyOf, ruleAgentIdOfWorkspacePath, singleResourceOf, workspaceRoot } from "../agents/workspace.js";
import { join } from "node:path";
import { StatusFloorTracker } from "../agents/status-floor.js";
import { createDashboardFeed, DASHBOARD_DETECTOR, type IssueMeta, type DashboardAgent } from "../agents/dashboard.js";
import { projectRootDoc } from "../tools/docs.js";
import { resolveResourceLink } from "../resources/resource-link.js";
import { buildIdentity, toBuildReport, describeBuild } from "../agents/build-identity.js";
import { computeBuildCurrency } from "../agents/build-currency.js";
import { runResourceLoop } from "./loop.js";
import { createTodoWorkersFetch } from "../resources/issue.js";
import { loadRules, unresolvedRelationships, formatUnresolvedRelationshipWarning, type AccountPolicy, type AgentRole } from "../rules/rules.js";
import { createRuleResourceType, ownsRuleAgent, uniqueIssues, type RuleMatch } from "../rules/resource-type.js";
import type { NotifyReason } from "../resources/types.js";
import { decodeAnyAgentKey, decodeQueryAgentKey } from "../rules/agent-key.js";
import type { AgentCapacityRole } from "../agents/admission.js";
import { capacityRoleFor } from "../agents/capacity-role.js";
import { watchPrompts } from "../agents/prompt-watch.js";
import { chooseStartupAnswer } from "../agents/prompt.js";
import { watchBlocked } from "../agents/blocked.js";
import { createEscalator } from "../agents/escalation-loop.js";
import { createManagedSessionEscalationWatcher } from "../agents/managed-session-escalation-watcher.js";
import { startPermissionAnswerLoop } from "../agents/permission-answer-loop.js";
import { withIdleDialogDetection } from "../agents/idle-dialog.js";
import { detectTerminalPrefix, resolveAttach, attachRefusalMessage } from "../terminal/open.js";
import { realAtlassian } from "../tools/atlassian-real.js";
import { atlassianTools } from "../tools/defs.js";
import { createLabelSync } from "../labels/sync.js";
import { createNotifyGate } from "../labels/notify-gate.js";
import { PrTracker } from "../labels/pr.js";
import { sweepStaleAgentLabels } from "../labels/sweep.js";
import { watchSessionLimits } from "../agents/session-limit-watch.js";
import { createQuotaGate } from "../agents/quota-gate.js";
import { createCaptureStore } from "../agents/capture-store.js";
import { createStalledCheck } from "../agents/stalled.js";
import { createStallRemediator } from "../agents/stall-remediation.js";
import { createOwnWriteLedger, DAEMON_WRITER } from "../jira-watch/own-writes.js";
import { respawnComment } from "../agents/respawn.js";
import { createParkedDetector } from "../agents/parked.js";
import { createAbandonedDetector } from "../agents/abandoned.js";
import { prReviewStateNudge } from "../agents/pr-nudge.js";
import { changeNudge, linkedChangeNudge, notifyReasonTag } from "../agents/change-nudge.js";
import { speakOnOwnChannel, createOwnChannelComments } from "../tools/speak.js";
import { createCrashLoopDetector } from "../agents/crash-loop.js";
import { createReconcileFailureDetector } from "../agents/reconcile-failure.js";
import { createReaper } from "../agents/reap.js";
import { createAdmissionController } from "../agents/admission.js";
import { createGithubIssueClient } from "../resources/github-issue.js";
import { githubIssueStaffing, type GithubIssueMatch } from "../rules/github-issue-type.js";
import type { GithubIssueRef } from "../resources/github-issue-ref.js";
import { forJiraCallers, githubIssueTools } from "../tools/github-issue.js";
import { GITHUB_ISSUE_POLL_MS, startGithubIssueLoop } from "./github-issue-loop.js";
import { createJiraIdeaClient } from "../resources/jira-idea.js";
import { jiraIdeaTools } from "../tools/jira-idea.js";
import { ideaGithubLinkTools } from "../tools/idea-github-link.js";
import { JIRA_IDEA_POLL_MS, jiraIdeaRules, startJiraIdeaLoop } from "./jira-idea-loop.js";
import { createResidencyGuard } from "../agents/residency-guard.js";
import { createZendeskTicketClient } from "../resources/zendesk-ticket.js";
import { zendeskTicketStaffing } from "../rules/zendesk-ticket-type.js";
import { zendeskTicketTools } from "../tools/zendesk-ticket.js";
import { startZendeskTicketLoop, ZENDESK_TICKET_POLL_MS } from "./zendesk-ticket-loop.js";
import { filesystemRules, FILESYSTEM_POLL_MS, startFilesystemLoop } from "./filesystem-loop.js";
import { MANAGED_SESSIONS_POLL_MS, startManagedSessionsLoop } from "./session-definitions-loop.js";
import { sessionDefinitionsPath } from "../resources/session-definition.js";
import { ownsManagedSessionAgent } from "../rules/session-definition-type.js";
import { defaultSessionFreezeIo } from "../resources/session-freeze.js";
import { listFilesystemResources } from "../resources/filesystem.js";
import { sessionFreezeTools } from "../tools/session-freeze-tools.js";
import { legacyAgentPreflight } from "./legacy-preflight.js";
import { missingRulesPreflight } from "./missing-rules-preflight.js";
import { loadRocketChatAuth, createRocketChatClient } from "../resources/rocketchat.js";
import { createAccountManager, createFileAccountStore } from "../accounts/manager.js";
import { rcUsernameFor } from "../accounts/identity.js";
import { createFileNexusManifestPublisher } from "../accounts/nexus-manifest.js";
import { createAccountLifecycle } from "../agents/account-lifecycle.js";
import { createAccountOrphanSweep } from "../agents/account-orphan-sweep.js";
import { runLinkCli } from "../cli/link-cli.js";
import { runSessionCli } from "../cli/session-cli.js";
import { resourceLinkTools } from "../tools/resource-links.js";
import { createLinkStore, defaultLinksStorePath } from "../resources/link-store.js";
import { createRoutingLinkStore } from "../resources/link-store-router.js";
import { createJiraProjectLinkStore } from "../resources/jira-project-link-store.js";

// FACTORY-7: `butchr link list|add|remove` is the one subcommand this
// binary has (package.json's `bin.butchr` builds solely from THIS file —
// see `src/cli/link-cli.ts`'s own header for why the dispatch lives here).
// Intercepted before `installLogSink()`/config/rules loading below, on
// purpose: the link store is provider-agnostic local state, so a `butchr
// link ...` invocation must not require Jira credentials or a rules file to
// run, and must not emit this daemon's own structured startup logging.
if (process.argv[2] === "link") {
  process.exit(await runLinkCli(process.argv.slice(3)));
}

// BUTCHR-454: `butchr session list|show|create|freeze|unfreeze`, same
// precedent as `butchr link` immediately above — a managed-session
// definition is local filesystem state (plus the drovr-events freeze
// store), so this must run with no Jira credentials and no rules file.
if (process.argv[2] === "session") {
  process.exit(await runSessionCli(process.argv.slice(3)));
}

// BUTCHR-346: installed before anything else in this file ever logs — every
// `log:`/`deps.log` seam below that defaults to or directly calls
// `console.error` resolves that reference at CALL time, so this single
// install covers all of them, including the config-load error path
// immediately below and every closure defined later in this file. See
// `log-sink.ts`'s own doc comment for why this is the sink and why it is
// installed here rather than at any individual call site.
installLogSink();

let config;
try {
  config = loadConfig(process.env as Record<string, string | undefined>, (p) => readFileSync(p, "utf8"));
} catch (e) {
  console.error(`butchr: ${(e as Error).message}`);
  console.error("See .env.example for the required configuration.");
  process.exit(1);
}
if (config.agent) config.agent = inventoryCodexMcp(config.agent, (line) => console.error(`butchr: ${line}`));
if (config.agent) config.agent = inventoryAgyMcp(config.agent, (line) => console.error(`butchr: ${line}`));

// Resource-agent rules (src/rules/rules.ts): the ONLY thing that decides what
// gets staffed. A present rules file with zero enabled rules staffs nothing;
// an absent file means zero rules (there are no built-in defaults), announced
// so an idle daemon is never a mystery.
let rules;
let missingRulesPath: string | null = null;
try {
  const loaded = loadRules(process.env as Record<string, string | undefined>);
  rules = loaded.rules;
  if (loaded.origin === "missing") missingRulesPath = loaded.path;
  const enabled = rules.filter((r) => r.enabled).map((r) => r.id);
  if (loaded.origin === "missing") console.error(`butchr: no rules file at ${loaded.path}: 0 rules — nothing will be staffed`);
  else console.error(`butchr: rules from ${loaded.path}: ${enabled.length} enabled${enabled.length ? ` (${enabled.join(", ")})` : " — nothing will be staffed"}`);
} catch (e) {
  console.error(`butchr: ${(e as Error).message}`);
  process.exit(1);
}
// BUTCHR-398: log every sentinel rule at startup, one line each, so an
// operator can see at a glance what is exempt from the fleet agent cap —
// the epic decision's own ask ("log each sentinel rule at startup"). No
// warning for an unflagged rule: `role` defaults to `"worker"`, and that
// default needs no announcement (this task's own ticket: "deliberately NO
// startup warning for rules without a role").
for (const r of rules) {
  if (r.enabled && r.role === "sentinel") console.error(`butchr: rule ${r.id} (${r.resourceProvider}) is a sentinel — excluded from the agent cap and admission withholding`);
}
// BUTCHR-408 review fix: `roleOfAgent` below is RULE-level only (one shared
// `Rule` per provider) — the built-in managed-sessions rule (never in
// `rules`, and even if it were, fixed to `role: "worker"`) cannot express a
// per-FILE manifest's own `role`. This map is the seam: the managed-sessions
// loop rebuilds it every poll from that poll's eligible definitions (see
// `ManagedSessionResourceDeps.roles`, src/rules/session-definition-type.ts),
// keyed by the SAME agent key `roleOfAgent` is called with, and `roleOfAgent`
// consults it FIRST for any id `ownsManagedSessionAgent` recognizes. Before
// this loop's first poll (e.g. right after a restart, for an
// already-running managed-session agent), it has no entry yet and
// `roleOfAgent` falls through to its own existing fail-safe `"worker"`
// default below — documented here, not silently relied upon.
const managedSessionRoles = new Map<string, AgentRole>();
/**
 * BUTCHR-460 — same seam as `managedSessionRoles` immediately above, one
 * field over: `accountPolicyOf` below is RULE-level only, same reason
 * `roleOfAgent` needed `managedSessionRoles` — the built-in managed-sessions
 * rule is ONE shared `Rule` (fixed `account: "none"`) for every
 * heterogeneous definition file. Rebuilt every poll by the managed-sessions
 * loop itself (`ManagedSessionResourceDeps.accountPolicies`,
 * src/rules/session-definition-type.ts) from that poll's eligible matches.
 */
const managedSessionAccountPolicies = new Map<string, AccountPolicy>();
/**
 * BUTCHR-398 — the fleet capacity role classifier every rule loop's
 * admission wiring below shares: a running or candidate agent id's role,
 * derived from its rule (provider + rule id, `decodeAnyAgentKey`) looked up
 * against the loaded `rules`. Fails safe to `"worker"` for anything that
 * cannot be resolved — a legacy/bare-issue agent, or a rule since removed —
 * per `AdmissionControllerDeps.roleOf`'s own contract (src/agents/admission.ts).
 * BUTCHR-408: a managed-session agent's role comes from `managedSessionRoles`
 * (its OWN manifest field) instead, checked before the rule-level fallback —
 * see that map's own comment just above.
 */
const ruleRoleOfAgent = (id: string): AgentCapacityRole | undefined => {
  const decoded = decodeAnyAgentKey(id);
  if (!decoded) return undefined;
  if (ownsManagedSessionAgent(id)) {
    const manifestRole = managedSessionRoles.get(id);
    if (manifestRole) return manifestRole;
  }
  const rule = rules.find((r) => r.id === decoded.ruleId && r.resourceProvider === decoded.resourceProvider);
  return rule?.role;
};
// BUTCHR-422 (FACTORY-39 moved Bug out of the counted set): only leaf work
// (Task/Sub-task) counts toward the cap — project agents and Epic/Story/Bug
// agents are classified "sentinel" here (see src/agents/capacity-role.ts).
// `issueMeta` (declared below, filled by every jira-work search) supplies
// the issue type; it is only read at call time, after the whole module has
// initialised.
const roleOfAgent = (id: string): AgentCapacityRole =>
  capacityRoleFor(id, ruleRoleOfAgent, (key) => issueMeta.get(key)?.issuetype);

// BUTCHR-405: logged once per unresolved reference, and the same list rides
// on /health (see combineHealth call below) — both come from
// unresolvedRelationships so they can never disagree.
const unresolvedRuleRelationships = unresolvedRelationships(rules);
for (const u of unresolvedRuleRelationships) console.error(`  ${formatUnresolvedRelationshipWarning(u)}`);

/**
 * BUTCHR-411 — `HerdrHerd.staleIssues()`'s own `mcpBindingsOf` seam (see that
 * constructor param's doc comment, src/agents/herd.ts): same
 * decode-then-look-up-by-ruleId shape as `roleOfAgent` just above, for the
 * SAME reason (HerdrHerd is one flat instance with no rule state of its
 * own). `undefined` for anything unresolved — a legacy/bare-issue agent, or
 * a rule since removed/disabled — means "no bindings", which is exactly
 * today's argv; a rule that never sets `mcpServers` is unaffected.
 */
const mcpBindingsOf = (id: string) => {
  const decoded = decodeAnyAgentKey(id);
  if (!decoded) return undefined;
  const rule = rules.find((r) => r.id === decoded.ruleId && r.resourceProvider === decoded.resourceProvider);
  return rule?.mcpServers;
};

/**
 * BUTCHR-412 — same fail-safe classifier shape as `roleOfAgent` immediately
 * above, one field over: this id's rule's Rocket.Chat account policy, or
 * `"none"` for anything this daemon cannot resolve back to a rule (a legacy/
 * bare-issue id, or a rule since removed) — an unrecognised agent must never
 * provision an account for itself, mirroring `roleOfAgent`'s own "an
 * unrecognised agent is always a worker" fail-safe.
 * BUTCHR-460: a managed-session agent's OWN `account` (its manifest field)
 * IS read here — via `managedSessionAccountPolicies`, checked before the
 * rule-level fallback — same precedent as `ruleRoleOfAgent`'s own
 * `managedSessionRoles` lookup just above, for the identical reason (the
 * built-in managed-sessions rule cannot carry a per-file account policy
 * itself).
 */
const accountPolicyOf = (id: string): AccountPolicy => {
  const decoded = decodeAnyAgentKey(id);
  if (!decoded) return "none";
  if (ownsManagedSessionAgent(id)) {
    const manifestPolicy = managedSessionAccountPolicies.get(id);
    if (manifestPolicy) return manifestPolicy;
  }
  const rule = rules.find((r) => r.id === decoded.ruleId && r.resourceProvider === decoded.resourceProvider);
  return rule?.account ?? "none";
};

/**
 * BUTCHR-413 — this id's own non-secret Rocket.Chat account name
 * (`spec.rocketchatAccount`'s source, see that field's own doc comment,
 * src/agents/workspace.ts), for the two callers that have no live,
 * `ensure()`-populated `SpawnSpec` to read it from at all:
 * `HerdrHerd.spawn`/`HerdrHerd.staleIssues`' own fallback (only when
 * `account-lifecycle.ts`'s `ensure` never ran for a launch — no
 * accountLifecycle wired at all) and `createCodexChannelRelayPool`'s own
 * daemon-side connection (which reconciles against a bare issue id, never a
 * spec). `undefined` for an id whose rule grants it none
 * (`accountPolicyOf(id) === "none"`, the same fail-safe classifier
 * `accountLifecycle` itself is gated on immediately below).
 *
 * REVIEW FINDING (BUTCHR-413 round 3): the first version of this called
 * `rcUsernameFor(id)` with no prefix, silently assuming the DEFAULT managed
 * prefix — wrong once BUTCHR-412's configurable `Config.rocketchat.managedPrefix`
 * (`ROCKETCHAT_MANAGED_PREFIX`) is set to anything else, since
 * `ensureAccount` (`src/accounts/manager.ts`) derives the REAL provisioned
 * username with THAT prefix. Naming a different account than the one
 * actually provisioned would have pointed Codex's own reply header and this
 * relay's own connection at an account that doesn't exist, while
 * `staleIssues()` (recomputing this same wrong value) would never agree
 * with what `HerdrHerd.spawn` actually launched with whenever `ensure()`'s
 * real value WAS used — a respawn loop. Fixed: pass THE SAME configured
 * prefix `createAccountManager` below is given, so this can never name a
 * different account than `ensureAccount` actually provisions.
 */
const accountNameOf = (id: string): string | undefined =>
  accountPolicyOf(id) === "none" ? undefined : rcUsernameFor(id, config.rocketchat?.managedPrefix);

// github-issue rules run only with GitHub auth and org scope configured and
// every enabled rule's query scoped inside those orgs; otherwise none of them
// runs and nothing is spawned for one (announced by startGithubIssueLoop).
const githubStaffing = githubIssueStaffing(rules, config.github);
const githubIssues = githubStaffing.run && config.github
  ? createGithubIssueClient({ fetchImpl: fetch, token: config.github.token, orgs: config.github.orgs, log: (line) => console.error(`  ${line}`) })
  : undefined;

// zendesk-ticket rules run only with ZENDESK_SUBDOMAIN and an owner-only
// ZENDESK_OAUTH_TOKEN_FILE; otherwise none of them runs and nothing is spawned
// for one (announced by startZendeskTicketLoop). The token file is read only
// when an enabled zendesk-ticket rule exists.
const zendeskStaffing = zendeskTicketStaffing(rules, process.env as Record<string, string | undefined>);
const zendeskTickets = zendeskStaffing.run
  ? createZendeskTicketClient({ fetchImpl: fetch, subdomain: zendeskStaffing.subdomain, token: zendeskStaffing.token, log: (line) => console.error(`  ${line}`) })
  : undefined;

// filesystem rules need no external credential — every enabled one always
// runs, reading the local disk directly (src/resources/filesystem.ts).
const fsRules = filesystemRules(rules);

const atlassian = new AtlassianClient(config.atlassian.site, config.atlassian.email, config.atlassian.token, undefined, (line) => console.error(`  ${line}`));
// jira-idea rules share this Jira client but are their own provider: their
// own loop, agents, MCP identity and read/comment tools (src/tools/jira-idea.ts).
const ideaRules = jiraIdeaRules(rules);
const jiraIdeas = ideaRules.length ? createJiraIdeaClient(atlassian) : undefined;
// Label writes must never silently 403: Jira only honours notifyUsers=false
// for an account holding Administer Jira/Projects on the ticket's project.
// This gate preflights that per project (first sight, cached for the run)
// and falls back to notifying writes — loudly, once — when it's absent.
// Shared between the poll loop and the one-time startup sweep below so both
// see the same cached verdict per project.
const labelWriter = createNotifyGate({ jira: atlassian, account: config.atlassian.email, log: (line) => console.error(`  ${line}`) });
const herdr = new DrovrClient(config.herdrSocket ? { socketPath: config.herdrSocket } : {});
// Before any listener or loop exists: live agents in legacy flat workspaces
// count against the host cap but no rule loop owns them, so refuse to start
// rather than oversubscribe or adopt them (src/daemon/legacy-preflight.ts).
// Read-only — nothing is stopped and no workspace is touched.
const preflight = await legacyAgentPreflight(async () => (await herdr.agent.list()).agents);
if (!preflight.ok) {
  console.error(`butchr: ${preflight.message}`);
  process.exit(1);
}
// No rules file + live rule agents: refuse, rather than stop the whole fleet
// on the first poll over what is usually an accident (src/daemon/missing-rules-preflight.ts).
if (missingRulesPath !== null) {
  const rulesPreflight = await missingRulesPreflight(missingRulesPath, async () => (await herdr.agent.list()).agents);
  if (!rulesPreflight.ok) {
    console.error(`butchr: ${rulesPreflight.message}`);
    process.exit(1);
  }
}
// BUTCHR-320: the 4th, optional `log` param emits one [spawn] outcome line
// per spawn attempt (success/failure/noop) — see herd.ts's own `spawn()` doc
// comment. `undefined` for `wait` keeps HerdrHerd's own default real-timer
// wait; only `log` is being threaded through here.
const herd = new HerdrHerd(herdr, `http://localhost:${config.port}/mcp`, undefined, (line) => console.error(`  ${line}`), config.agent, undefined, undefined, undefined, mcpBindingsOf, accountNameOf);
// BUTCHR-413 — the Codex stopgap wake path for a `channel: true` MCP server
// binding (BUTCHR-411's `Rule.mcpServers`, e.g. Rocket.Chat's `rocketr`): a
// Claude agent bound to one needs nothing here (its own CLI opens the
// notification stream directly, per BUTCHR-411's launch wiring); a Codex
// agent has no development-channel concept and would otherwise receive
// nothing for it at all, so this daemon opens that stream on its behalf and
// turns each push into a `herd.nudge()` prompt — see
// src/notify/codex-channel-relay.ts's own top comment for the full account,
// including exactly what BUTCHR-359 should replace this with.
const codexChannelRelays = createCodexChannelRelayPool({
  nudge: (issue, text) => herd.nudge(issue, text),
  providerOf: (issue) => herd.providerOf!(issue),
  bindingsOf: mcpBindingsOf,
  runningIssues: () => herd.runningIssues(),
  log: (line) => console.error(`  ${line}`),
  // BUTCHR-413 (review finding 2): the SAME per-agent, non-secret account
  // name `herd` above uses for Codex's own bound-server headers — one
  // identity, two consumers, so a message aimed at this agent's account
  // reaches it however it is running, and the two paths can never disagree
  // about who this agent is.
  accountNameOf,
});
const codexChannelRelayTick = () => codexChannelRelays.reconcile().catch((e) => console.error(`  WARNING: [notify] codex channel relay reconcile failed: ${(e as Error)?.message ?? e}`));
void codexChannelRelayTick();
setInterval(codexChannelRelayTick, 15_000);
// BUTCHR-284: fleet-wide admission control — see src/agents/admission.ts for
// the full mechanism. ONE SHARED instance (unlike issueReaper/projectReaper
// below, which are deliberately two SEPARATE instances) wired into BOTH
// `runResourceLoop` calls below: the cap must bound the HOST, not each tier
// independently (see that module's own top comment, Trap 1) — a per-tier
// instance here would silently reintroduce exactly the bug this ticket
// exists to close. `residency` reads the RAW `herd` above (the unscoped
// `HerdrHerd` instance, before either loop's own `scopedHerd` wrapping),
// which is the one seam that can see every `butchr-*` agent regardless of
// which loop desired it.
// BUTCHR-332: the two tiers' own names on the admission census — declared up
// front (not discovered lazily) and passed as `sources` below, so
// `admissionController.census()` can report "this tier has not reported
// yet" from construction (see AdmissionControllerDeps.sources's own doc
// comment). The two thin wrappers further down (`admission:` at each
// `runResourceLoop` call site) are what actually name a call's own tier —
// this daemon never calls `admissionController.admit` directly.
const ADMISSION_SOURCE_ISSUE = "issue";
const ADMISSION_SOURCE_GITHUB_ISSUE = "github-issue";
const ADMISSION_SOURCE_JIRA_IDEA = "jira-idea";
const ADMISSION_SOURCE_ZENDESK_TICKET = "zendesk-ticket";
// BUTCHR-425: jira-project agents always classify as sentinels (see
// src/agents/capacity-role.ts), so this bucket never withholds anything —
// it exists only so the admission census can report on this tier by name,
// the same reason every other provider gets its own named source.
const ADMISSION_SOURCE_JIRA_PROJECT = "jira-project";
const jiraProjectEnabled = rules.some((r) => r.enabled && r.resourceProvider === "jira-project");
const ADMISSION_SOURCE_FILESYSTEM = "filesystem";
// BUTCHR-408: unlike every rule above, the managed-sessions query is built
// into the daemon, never a user rules.json rule — it always runs (no
// staffing gate, same "every enabled filesystem rule always runs" reasoning
// as ADMISSION_SOURCE_FILESYSTEM, minus the "enabled" part since there is no
// rules.json entry to disable), so it is unconditionally in `sources` below.
const ADMISSION_SOURCE_MANAGED_SESSIONS = "managed-sessions";
const admissionController = createAdmissionController({
  cap: config.maxAgents,
  residency: () => herd.runningIssues(),
  // BUTCHR-398: shared across every rule provider's admission bucket —
  // `roleOfAgent` reads the FULL `rules` list (every provider), so it
  // correctly classifies a running id of ANY provider, not just jira-work.
  // BUTCHR-408: a managed-session agent's OWN `role` (its manifest field) IS
  // read here — via `managedSessionRoles` (see that map's own comment,
  // above `roleOfAgent`'s definition), not the rule-level lookup every
  // other provider uses (the built-in managed-sessions rule is one shared
  // Rule for every heterogeneous definition file, so it cannot carry a
  // per-file role itself).
  roleOf: roleOfAgent,
  log: (line) => console.error(`  ${line}`),
  now: () => Date.now(),
  sources: [ADMISSION_SOURCE_ISSUE, ...(githubIssues ? [ADMISSION_SOURCE_GITHUB_ISSUE] : []), ...(jiraIdeas ? [ADMISSION_SOURCE_JIRA_IDEA] : []), ...(zendeskTickets ? [ADMISSION_SOURCE_ZENDESK_TICKET] : []), ...(jiraProjectEnabled ? [ADMISSION_SOURCE_JIRA_PROJECT] : []), ...(fsRules.length ? [ADMISSION_SOURCE_FILESYSTEM] : []), ADMISSION_SOURCE_MANAGED_SESSIONS],
});
const terminalPrefix = config.terminalPrefix ?? detectTerminalPrefix((c) => Bun.which(c) != null) ?? undefined;
// BUTCHR-269: widened from a bare `Map<string, string>` of summaries alone —
// `issuetype` is a declared field on every `JiraIssue` the issue loop's
// `search()` already returns on every poll (src/atlassian/types.ts) and was
// simply being thrown away here; retaining it alongside `summary` is what
// lets /dashboard's tier field distinguish epic/story/task WITHOUT a second
// Jira call. A key genuinely absent from this map (a fresh daemon before its
// first search lands, or a key that dropped out of the search while its
// agent is still winding down) must read as "could not check the tier", not
// as a guessed default — see src/agents/dashboard.ts's own header.
const issueMeta = new Map<string, IssueMeta>();
// BUTCHR-269: the dashboard's own "time in current agent_status" floor — see
// src/agents/status-floor.ts for why this is a THIRD tracker rather than a
// widening of StalledTracker/FrozenAsleepTracker (both load-bearing for a
// different question). One instance for the whole daemon, fed once per poll
// (see the `agentStatuses` tee below) — a floor must persist across polls to
// mean anything.
const dashboardStatusFloor = new StatusFloorTracker(() => Date.now());
// BUTCHR-332: a SECOND, dedicated StatusFloorTracker for the withheld set —
// see src/agents/dashboard.ts's `UpdateWithheldRowsDeps.tracker` doc comment
// for why this must not be the agent rows' own tracker above.
const dashboardWithheldStatusFloor = new StatusFloorTracker(() => Date.now());
// BUTCHR-269/BUTCHR-308: the poll-fed snapshot `/dashboard` serves. The fetch
// itself stays here (only this daemon knows whether THIS poll's
// `agent.list()` succeeded, and only it also needs the raw `agents` array to
// feed `createLabelSync`'s own status map below) but the "could not
// check"/stale-on-decline DECISION — what the snapshot looks like on success
// vs. failure — lives in `createDashboardFeed` (src/agents/dashboard.ts),
// unit-tested there directly. This daemon is wiring only: call `.poll()`
// with the real fetch, record coverage, serve `.snapshot()`.
//
// BUTCHR-332: `admission` reads `admissionController.census()` — the SAME
// controller instance both `runResourceLoop` calls below share — never a
// fresh call of its own; the census was already computed earlier in this
// same poll (see admission.ts's own top comment and this ticket's own
// falsifier for the ordering proof).
/**
 * BUTCHR-398: dashboard/state metadata for a herd id — `issueMeta` only ever
 * holds REAL tickets (keyed by their own Jira key), so a query-level id
 * (`resourceKeyOf` falls back to the whole bogus key for one — see this
 * file's own `isQueryLevelAgent` comment) would otherwise look up nothing
 * and render an empty summary. Synthesized here instead, from the rule
 * itself, so a query agent's row reads as what it is rather than blank.
 */
const metaFor = (key: string): IssueMeta | undefined => {
  const query = decodeQueryAgentKey(key);
  if (!query) return issueMeta.get(resourceKeyOf(key));
  const rule = rules.find((r) => r.id === query.ruleId && r.resourceProvider === query.resourceProvider);
  return { summary: rule ? `${rule.id} (query agent)` : "(query agent — rule not found)", issuetype: "task" };
};
const dashboardFeed = createDashboardFeed({
  now: () => Date.now(),
  issueMeta: metaFor,
  tracker: dashboardStatusFloor,
  withheldTracker: dashboardWithheldStatusFloor,
  admission: () => admissionController.census(),
});

const ops = realAtlassian({ site: config.atlassian.site, email: config.atlassian.email, token: config.atlassian.token });

// FACTORY-7/FACTORY-5: the local file store needs no credentials and works
// for every ResourceRef kind; a `jira-project:` owner routes to the
// project-property-backed store instead (this daemon already has Jira
// credentials loaded, so the factory is cheap and side-effect-free rather
// than genuinely lazy) — see `src/resources/link-store-router.ts` for the
// routing decision itself. BUTCHR-469: hoisted out of the MCP tool wiring
// below (its original, still-only-other, call site) so the SAME instance
// (stateless per call, so a second handle would be equivalent anyway — see
// `createLinkStore`'s own doc comment) can also be handed to the
// `jira-project` resource type's own linked-eventing wiring further down,
// without constructing a second routing store for no reason.
const routingLinkStore = createRoutingLinkStore({ fileStore: createLinkStore(defaultLinksStorePath()), jiraProjectStore: () => createJiraProjectLinkStore(ops) });

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
// github-issue, jira-idea, zendesk-ticket and filesystem loop health, reported beside (never inside) the
// liveness components: whether each type's rules run, and whether its polls
// complete. The threshold covers at least three polls of the slower loop.
const githubIssueHealth = createResourceLoopHealth({
  name: "github-issue",
  enabled: Boolean(githubIssues),
  ...(githubStaffing.run ? {} : { disabledReason: githubStaffing.reason ?? "no enabled github-issue rules" }),
  thresholdMs: Math.max(config.pollStaleMs, 3 * GITHUB_ISSUE_POLL_MS),
  log: (line) => console.error(line),
});
const jiraIdeaHealth = createResourceLoopHealth({
  name: "jira-idea",
  enabled: Boolean(jiraIdeas),
  ...(jiraIdeas ? {} : { disabledReason: "no enabled jira-idea rules" }),
  thresholdMs: Math.max(config.pollStaleMs, 3 * JIRA_IDEA_POLL_MS),
  log: (line) => console.error(line),
});
const jiraProjectHealth = createResourceLoopHealth({ name: "jira-project", enabled: jiraProjectEnabled, ...(jiraProjectEnabled ? {} : { disabledReason: "no enabled jira-project rules" }), thresholdMs: 300_000, log: (line) => console.error(line) });
const zendeskTicketHealth = createResourceLoopHealth({
  name: "zendesk-ticket",
  enabled: Boolean(zendeskTickets),
  ...(zendeskStaffing.run ? {} : { disabledReason: zendeskStaffing.reason ?? "no enabled zendesk-ticket rules" }),
  thresholdMs: Math.max(config.pollStaleMs, 3 * ZENDESK_TICKET_POLL_MS),
  log: (line) => console.error(line),
});
const filesystemHealth = createResourceLoopHealth({
  name: "filesystem",
  enabled: fsRules.length > 0,
  ...(fsRules.length ? {} : { disabledReason: "no enabled filesystem rules" }),
  thresholdMs: Math.max(config.pollStaleMs, 3 * FILESYSTEM_POLL_MS),
  log: (line) => console.error(line),
});
// BUTCHR-408: always enabled — the built-in query has no staffing gate and no rules.json entry to disable.
const managedSessionsHealth = createResourceLoopHealth({
  name: "managed-sessions",
  enabled: true,
  thresholdMs: Math.max(config.pollStaleMs, 3 * MANAGED_SESSIONS_POLL_MS),
  log: (line) => console.error(line),
});
// BUTCHR-179: per-detector "could not check" coverage, reported as a
// /health sibling — see src/daemon/coverage.ts's own header for the full
// rationale. Wired into two detectors so far (syncLabels's stalled check,
// escalation-loop's unresponsive alarm) — see this ticket's own report for
// the rest of the declining set and why it's not all wired yet.
const coverage = createCoverageTracker();

// BUTCHR-329: this daemon's own build-currency verdict, reported as a
// /health sibling — see src/daemon/currency.ts's own header for why it must
// be cached (computeBuildCurrency is expensive) rather than recomputed per
// poll, and why the cache is lazy (on `/health` access) rather than a
// background timer. `buildIdentity` satisfies `RunningBuild` structurally
// (a superset), so no adapter is needed here.
const currency = createCurrencyTracker({ compute: () => computeBuildCurrency(buildIdentity) });

/**
 * BUTCHR-244: `check_worker`'s live staffing probe — the narrow seam
 * `atlassianTools` takes rather than the whole `herd`, so `defs.ts` (and
 * `relationship.ts`'s `checkWorker`, which actually calls this) stays pure
 * over its dependencies. Resolves `true`/`false` from `herd.runningIssues()`
 * (this daemon's own live agent registry); `null` when that read itself
 * failed. Deliberately does NOT attempt to determine "is this worker even
 * one this daemon's herd could cover" here — `checkWorker` already does
 * that (AC-5: comparing the worker's own Jira assignee against this
 * credential's own identity, both of which it has independently, without
 * this probe's help) before ever calling this function, so this stays a
 * simple, honest "what does MY herd currently say" — see relationship.ts's
 * `probeCoversWorker` for that scope check and the incident it fixes.
 */
const isStaffed = async (key: string): Promise<boolean | null> => {
  try {
    const running = await herd.runningIssues();
    return running.some((id) => resourceKeyOf(id) === key);
  } catch {
    return null;
  }
};

const resourceConnections = new ResourceConnections(`http://127.0.0.1:${config.port}`, herd, (line) => console.error(line));
const { app, mcp } = buildApp({
  state: async () => {
    return (await herd.managedAgents()).map(({ issue, status }) => ({
      issue,
      status,
      summary: metaFor(issue)?.summary ?? "",
    }));
  },
  open: async (issue) => {
    const pane = await herd.paneFor(issue);
    if (!pane) return { ok: false, error: "agent not running for " + issue };
    if (!terminalPrefix) return { ok: false, error: "no terminal emulator found (set BUTCHR_TERMINAL)" };
    Bun.spawn([...terminalPrefix, "herdr", "agent", "attach", pane], { stdio: ["ignore", "ignore", "ignore"] });
    return { ok: true };
  },
  // BUTCHR-267: pane-keyed sibling of `open` above — the dashboard row link
  // target (BUTCHR-266 will build the link; BUTCHR-264 serves the pane in
  // the row data). "This daemon's own live agent registry" (criterion 4) is
  // the same workspace-path-owned set `state` above already builds
  // from `herdr.agent.list()` — a pane belonging to some other, non-butchr
  // pane on this host is never in that set, so it's refused rather than
  // handed to `herdr agent attach`.
  openPane: async (pane) => {
    const livePanes = (await herd.managedAgents()).map((agent) => agent.pane);
    const hasDisplay = Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
    const decision = resolveAttach(pane, livePanes, terminalPrefix ?? null, hasDisplay);
    if (!decision.ok) return { ok: false, error: attachRefusalMessage(decision.refusal) };
    Bun.spawn(decision.argv, { stdio: ["ignore", "ignore", "ignore"] });
    return { ok: true };
  },
  health: () => combineHealth([loopHealth, notifyHealth], toBuildReport(buildIdentity), coverage.snapshot(), admissionController.snapshot(), currency.snapshot(), [githubIssueHealth, jiraIdeaHealth, zendeskTicketHealth, jiraProjectHealth, filesystemHealth, managedSessionsHealth], unresolvedRuleRelationships, escalator.managedSessionEscalations()),
  // BUTCHR-269: NO I/O here — reads the snapshot the `agentStatuses` tee
  // (below, inside `createLabelSync`'s deps) last stored, fed by the issue
  // loop's own 15s poll. See src/agents/dashboard.ts's header and BUTCHR-263
  // for why a request-time fetch is the wrong pattern here even though it's
  // what `state` above does.
  dashboard: async () => dashboardFeed.snapshot(),
  // BUTCHR-339: the dashboard page's header info — the SAME `build`/`currency`
  // values `/health` already reads via `toBuildReport(buildIdentity)` and
  // `currency.snapshot()` (see `health` above), never a second derivation.
  // Synchronous, no I/O — same discipline as `dashboard` above.
  header: () => ({ build: toBuildReport(buildIdentity), currency: currency.snapshot() }),
  // BUTCHR-339: the dashboard row's resource-link redirect target — the
  // decision itself is `resolveResourceLink` (src/resources/resource-link.ts,
  // directly unit-tested there); this just supplies its real deps.
  // jira-project agents work a bare Jira project key, not a ticket
  // `resolveResourceLink` knows how to route — link straight to the
  // project's Jira browse page instead.
  resourceLink: (key) => decodeAgentKey(key)?.resourceProvider === "jira-project"
    ? Promise.resolve({ ok: true as const, url: `${config.atlassian.site}/browse/${resourceKeyOf(key)}` })
    : resolveResourceLink(resourceKeyOf(key), { jiraSite: config.atlassian.site, projectRootDocUrl: async (projectKey) => (await projectRootDoc(ops, projectKey)).url }),
// check_in/stand_down are passed no registries: the rule engine has no
// project tier to check in and no per-agent sleep yet, so both tools run in
// their documented "declares nothing" mode instead of feeding state that no
// loop reads.
}, {
  // Jira/Confluence tools refuse github-issue, jira-idea, zendesk-ticket and filesystem agents; each provider's own tools exist only when its rules run.
  ...forJiraCallers(atlassianTools(ops, undefined, config.assignees, recordOwnWrite, isStaffed)),
  // FACTORY-7/FACTORY-5: registered unconditionally, unlike every
  // provider-specific tool set below it — the local file store needs no
  // credentials and works for every ResourceRef kind, and a `jira-project`
  // owner routes to the project-property-backed store instead (this daemon
  // already has Jira credentials loaded, unlike the CLI, so the factory
  // below is cheap and side-effect-free rather than genuinely lazy) — see
  // `src/resources/link-store-router.ts` for the routing decision itself.
  ...resourceLinkTools(
    routingLinkStore,
    (line) => console.error(line),
  ),
  ...(githubIssues ? githubIssueTools({ client: githubIssues, onWrite: (resource, updated, writer) => ownWrites.record(resource, updated, writer, Date.now()) }) : {}),
  ...(zendeskTickets ? zendeskTicketTools({ client: zendeskTickets, onWrite: (resource, updated, writer) => ownWrites.record(resource, updated, writer, Date.now()) }) : {}),
  ...(jiraIdeas ? jiraIdeaTools({ client: jiraIdeas, site: config.atlassian.site, onWrite: (resource, updated, writer) => ownWrites.record(resource, updated, writer, Date.now()) }) : {}),
  // Linking needs both providers running: authorization reads both loops' latest matches.
  ...(githubIssues && jiraIdeas ? ideaGithubLinkTools({ ideas: jiraIdeas, github: githubIssues, ideaMatches: () => ideaMatches, githubMatches: () => githubMatches, site: config.atlassian.site }) : {}),
  // BUTCHR-456: registered unconditionally, like resourceLinkTools above — a
  // managed-session agent needs no external credential to be authorized
  // (the grant lives in another definition's own manifest), and the SAME
  // sessionDefinitionsPath()/listFilesystemResources/defaultSessionFreezeIo()
  // the managed-sessions loop and `butchr session` CLI already use, never a
  // second resolution of "where definitions live" or "which freeze store".
  ...sessionFreezeTools({ dir: sessionDefinitionsPath(), list: listFilesystemResources, read: (p) => readFile(p, "utf8"), freeze: defaultSessionFreezeIo() }),
});
app.all("/resource-mcp/:agent/:name", ({ request, params }) => resourceConnections.handle(request, params.agent, params.name));
app.listen(listenOptions(config.port));
console.error(`butchr daemon on http://${DAEMON_HOSTNAME}:${config.port}  (${describeConfig(config)})`);
// BUTCHR-320 (C): reuses the exact same buildIdentity/toBuildReport this
// daemon's own /health `build` field serves (see `health` above) — never a
// second derivation — so a journal window can be attributed to a BUILD, not
// only a pid (journald's pid only bounds one daemon generation).
console.error(`  ${describeBuild(toBuildReport(buildIdentity))}`);
console.error(`  terminal: ${terminalPrefix ? terminalPrefix.join(" ") : "NONE — set BUTCHR_TERMINAL to open agent shells"}`);
if (!config.github) console.error("  pr:* labels disabled: set GITHUB_TOKEN_FILE and BUTCHR_GITHUB_ORGS to enable PR discovery");

const readPane = async (paneId: string) => (await herdr.pane.read({ pane_id: paneId, source: "detection", strip_ansi: true })).read.text;
const sendPane = async (paneId: string, text: string) => { await herdr.pane.sendText({ pane_id: paneId, text }); };

const prTracker = config.github ? new PrTracker({ fetchImpl: fetch, token: config.github.token, orgs: config.github.orgs, log: (line) => console.error(`  ${line}`) }) : undefined;
// KAN-804/807: "idle since it stopped working, never spoke" — comments are only fetched
// for issues that already satisfy the cheap preconditions (see stalled.ts),
// never on every poll.
// BUTCHR-305/BUTCHR-238: extracted so `createLabelSync` below and
// `pinnedActiveDetector` further down (project loop only) share the SAME
// herdr.agent.list() read rather than each defining its own — "wire from the
// existing seam, do not add a second reader". Behaviour-preserving: this is
// the exact closure `syncLabels` was already given, moved to a name instead
// of an inline argument.
/** The ticket a pane's workspace works, for rule-engine workspaces only — a legacy workspace is never attributed to its ticket. */
const ownedAgentOfCwd = (cwd: string | null | undefined): string | null => {
  const id = agentIdOfWorkspacePath(cwd);
  return id && ownsRuleAgent(id) ? id : null;
};
const resourceOfCwd = (cwd: string | null | undefined): string | null => {
  const id = ownedAgentOfCwd(cwd);
  return id ? resourceKeyOf(id) : null;
};
/**
 * BUTCHR-398 (review finding 1): the escalation-safe sibling of
 * `resourceOfCwd` — `singleResourceOf` (src/agents/workspace.ts) instead of
 * `resourceKeyOf`, so a query-level agent's pane resolves to `null` (routed
 * through `escalation-loop.ts`'s own loud `issue === null` "cannot
 * escalate" path) rather than its own bogus `@query`-suffixed key, which
 * `speakOnOwnChannel`/`ops.addComment` would otherwise post a doomed Jira
 * write against — a real escalation silently lost for exactly the
 * long-lived (persistent/singleton) agents this ticket exists to support.
 * `resourceOfCwd` itself is UNCHANGED and still used for the dashboard/
 * label-sync status map, where the bogus fallback is a harmless, never-
 * looked-up orphan entry, not a write.
 */
const escalationTargetOfCwd = (cwd: string | null | undefined): string | null => {
  const id = ownedAgentOfCwd(cwd);
  return id ? singleResourceOf(id) : null;
};
const statusMapFromAgents = (agents: readonly DashboardAgent[]): ReadonlyMap<string, string> => {
  const m = new Map<string, string>();
  for (const a of agents) {
    const issue = a.resource_key ?? null;
    // Several rule agents may work one ticket; the ticket's agent:* label follows its busiest agent.
    if (issue && !(m.get(issue) === "working")) m.set(issue, a.agent_status ?? "unknown");
  }
  return m;
};
const agentStatuses = async (): Promise<ReadonlyMap<string, string>> => {
  const { agents } = await herdr.agent.list();
  return statusMapFromAgents(agents.map((a) => ({ ...a, resource_key: resourceOfCwd(a.cwd) })));
};
// BUTCHR-269/BUTCHR-308: the ISSUE loop's own `agentStatuses`, identical to
// the shared one above except that it tees /dashboard's poll-fed snapshot off
// the SAME single `agent.list()` — not a second fetch, the same discipline
// createQuotaGate documents for itself elsewhere in this file.
//
// On BUTCHR-305/BUTCHR-238's "share the SAME read, do not add a second
// reader" just above — that intent is met, and this is not a second reader:
// the issue loop calls THIS function and nothing else, the project loop calls
// the shared one and nothing else, and each performs exactly one
// `agent.list()`. The per-poll read count is unchanged; only the map-building
// is shared, via `statusMapFromAgents`.
//
// Deliberately NOT folded into the shared `agentStatuses`, and the reason is
// not tidiness: unlike that one, this is STATEFUL. It advances the dashboard
// snapshot's `confirmedAt`, the StatusFloorTracker's per-agent floors, and
// the DASHBOARD_DETECTOR coverage counters. The shared `agentStatuses` is
// also wired into `pinnedActiveDetector` on the PROJECT loop, which polls on
// its own cadence — so folding this in would make `confirmedAt` mean "the
// last poll of either loop" and would mix two cadences into one coverage
// denominator, which is the precise conflation src/daemon/coverage.ts exists
// to prevent. The dashboard is fed by the issue loop's poll, exactly where it
// was designed, reviewed and tested.
//
// A failure here already aborted the whole poll before this ticket (nothing
// in syncLabels catches it — see createLabelSync's own top comment); that
// behaviour is deliberately UNCHANGED. The try/catch exists only to record
// the dashboard's own coverage before the error propagates, never to swallow
// it — `dashboardFeed.poll` likewise updates its snapshot and rethrows. This
// is the measured `loop error: agent.list: connection closed before a
// response` case.
const agentStatusesFeedingDashboard = async (): Promise<ReadonlyMap<string, string>> => {
  let agents: readonly DashboardAgent[];
  try {
    agents = await dashboardFeed.poll(async () => {
      const { agents } = await herdr.agent.list();
      return { agents: agents.map((a) => ({ ...a, resource_key: resourceOfCwd(a.cwd) })) };
    });
  } catch (e) {
    coverage.recordDeclined(DASHBOARD_DETECTOR);
    throw e;
  }
  coverage.recordChecked(DASHBOARD_DETECTOR);
  return statusMapFromAgents(agents);
};
const stalled = createStalledCheck({
  now: () => Date.now(),
  minutes: config.stalledMinutes,
  comments: (issue) => atlassian.comments(issue),
  log: (line) => console.error(`  ${line}`),
});
// BUTCHR-221 criterion 10: a synchronous "is this issue quota-blocked right
// now" predicate, built by teeing the SAME list()/read() calls handed to
// watchSessionLimits below — through the SAME session-limit.ts recogniser —
// rather than a second detection path. See src/agents/quota-gate.ts's own
// top comment. Constructed here, ahead of stallRemediation, so its
// `isBlocked` can be wired straight into StallRemediationDeps; its
// `list`/`read` are wired into watchSessionLimits further down this file in
// place of the underlying functions, so this taps exactly the reads that
// watcher already performs — no extra pane I/O.
const quotaGate = createQuotaGate(
  async () => (await herdr.agent.list()).agents.map((a) => ({
    pane_id: a.pane_id,
    agent_status: a.agent_status ?? "",
    // Every rule loop's agents: a github-issue, jira-idea or zendesk-ticket
    // pane refused at a session limit needs the same close-after-reset as a
    // jira-work one, and nothing on this path writes to a resource.
    issue: ruleAgentIdOfWorkspacePath(a.cwd),
  })),
  readPane,
  () => Date.now(),
);
// BUTCHR-221/BUTCHR-210: the stall deadlock-breaker's remediation half —
// posts one debounced wake comment on a ticket once agent:stalled is
// actually applied (never on the raw per-poll signal — see
// src/agents/stall-remediation.ts's own top comment for the gating
// rationale and the own-write ledger hazard it avoids by construction).
// Always an issue key (syncLabels below is never wired into the project
// loop further down this file), so `ops.addComment` is the right seam —
// same one parked.ts uses, no second Atlassian writer.
const stallRemediation = createStallRemediator({
  now: () => Date.now(),
  addComment: async (issue, text) => { await ops.addComment(issue, text); },
  comments: (issue) => atlassian.comments(issue),
  quotaBlocked: (issue) => herd.resourceQuotaBlocked(issue) || quotaGate.blockedIds().some((id) => resourceKeyOf(id) === issue),
  // BUTCHR-353: a worker's own labels, for the "withheld at the admission
  // cap" branch — DELIBERATELY `ops.getIssue` (the raw single-issue read),
  // never a herd/live probe: a boss's worker is staffed under a different
  // Atlassian account than the boss (this fleet's own tier->account split),
  // so a probe wired here would be structurally blind to every worker it
  // could ever be asked about (three independent live confirmations, all
  // probeOutOfScope:true — see this ticket's own PR body) — the label path
  // is the only honest source, exactly as `staffingFromAgentLabel`'s own
  // doc comment argues (src/tools/relationship.ts). Paid at most once per
  // non-Done worker, only on the one poll that is actually about to post a
  // wake comment — see stall-remediation.ts's own cost-bound doc comment.
  labels: async (key) => (await ops.getIssue(key) as { fields?: { labels?: string[] } })?.fields?.labels ?? [],
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
// BUTCHR-141: audible-only crash-loop detection — see src/agents/crash-loop.ts
// for the full mechanism. TWO SEPARATE INSTANCES, one per loop (unlike
// frozenAsleepDetector above, which only the project tier can ever produce a
// candidate for): a crash loop has no such restriction, and each
// `runResourceLoop` call needs its own tracker for the same reason
// `RespawnGuard` is one instance per call rather than module-level. Both
// reuse the SAME `speakOnOwnChannel`/`ownChannelComments` seams — no second
// Atlassian writer or reader.
// BUTCHR-398 — the `resourceKeyOf` hazard (found in BUTCHR-397's review):
// `resourceKeyOf` on a query-level id (a `singleton`/`persistent` rule's one
// agent) returns the WHOLE bogus key (e.g. `jira-work:triage:%40query`), never
// a real ticket — `decodeAgentKey` deliberately rejects it (see
// src/rules/agent-key.ts). A query-level agent has no single ticket to
// comment on or read comments from, so every detector below that would
// otherwise call `speakOnOwnChannel`/`ownChannelComments` with that bogus
// key instead no-ops for one (and says so, once per id, rather than
// silently swallowing it).
const isQueryLevelAgent = (id: string): boolean => decodeQueryAgentKey(id) !== null;

// BUTCHR-412 — the Rocket.Chat account lifecycle, wired into every rule loop
// below as the SAME shared instance (one account manager/store for the whole
// daemon, not one per tier — same reasoning as `admissionController` above):
// see docs/rocketchat-accounts.md ("Wiring") for the full design and
// docs/execution-modes.md's `account` section for what each policy means.
//
// ALWAYS BUILT (BUTCHR-460 review finding, round 1, blocking — superseding
// this ticket's own first round, which gated this behind a `rcPolicyNeeded`
// computed once at startup from `rules.json` PLUS a startup-time snapshot of
// the session-definitions directory). That gate was correct for `rules.json`
// alone (loaded once, fixed for the daemon's whole life — a real "nothing
// will EVER want one" fact) but wrong for managed sessions: the built-in
// managed-sessions rule ALWAYS runs (no staffing gate — BUTCHR-408), and
// `butchr session create` can add a definition with `account: "temporary"`/
// `"permanent"` at ANY time while the daemon is running, no restart involved
// — so "nothing wants an account" is never a fact this daemon can know in
// advance, only "nothing wants one YET". Gating `accountLifecycle` itself
// behind that unknowable fact meant a definition created after a false
// startup snapshot would spawn with NO account hooks wired at all — not a
// visible refusal, a SILENT unaccounted spawn, exactly what BUTCHR-412's own
// "withheld, not degraded" doctrine forbids. Fixed by always building it: the
// RC HTTP client itself still stays `null` (and every `ensureAccount` call
// for a policy other than `"none"` still visibly refuses, logged and
// withheld — see `ensure`'s own doc comment) whenever `ROCKETCHAT_*` is
// unconfigured — this reuses that EXISTING refusal path rather than adding a
// second, managed-sessions-only one. `ensureAccount(id, "none")` still never
// touches the store or client at all (the policy table's own first row), so
// the ordinary, all-`"none"` daemon pays only for the (cheap: one keyed-lock
// check, no I/O) synchronous no-op path, not the store/client machinery
// itself — the one real, accepted cost of this fix is the orphan-sweep timer
// (below) now always runs, a `.butchr-rc-accounts.json` read every 30
// minutes, even on a daemon that will never provision anything.
const rcAuth = loadRocketChatAuth(process.env as Record<string, string | undefined>);
if (!rcAuth.ok && rules.some((r) => r.enabled && r.account !== "none")) {
  console.error(`  WARNING: [account] enabled rule(s) request a Rocket.Chat account policy but Rocket.Chat is not usable (${rcAuth.reason}) — every ensureAccount call will refuse until this is fixed`);
}
const rcClient = rcAuth.ok
  ? createRocketChatClient({ fetchImpl: fetch, url: rcAuth.url, adminUserId: rcAuth.adminUserId, adminToken: rcAuth.adminToken, log: (line) => console.error(`  ${line}`) })
  : null;
const accountManager = createAccountManager({
  client: rcClient,
  store: createFileAccountStore(),
  userCapThreshold: config.rocketchat?.userCapThreshold ?? 45,
  tempAccountCapThreshold: config.rocketchat?.temporaryAccountCapThreshold ?? 8,
  tokenDir: config.rocketchat?.tokenDir ?? join(workspaceRoot(), ".butchr-rc-tokens"),
  ...(config.rocketchat?.managedPrefix ? { managedPrefix: config.rocketchat.managedPrefix } : {}),
});
const manifestPublisher = createFileNexusManifestPublisher(config.rocketchat?.nexusManifestFile ?? join(workspaceRoot(), ".butchr-rc-nexus-manifest.json"));
const accountLifecycle = createAccountLifecycle({
  manager: accountManager,
  policyOf: accountPolicyOf,
  manifestPublisher,
  log: (line) => console.error(`  ${line}`),
  // Best-effort audible refusal beyond the log line above, for the two
  // Jira-backed providers only (jira-work, jira-idea) — github-issue and
  // zendesk-ticket have no generic `ops.addComment`-shaped route wired at
  // this layer (see docs/rocketchat-accounts.md's own residual-gap note);
  // a refusal for either of those is still visible in the journal.
  notify: async (id, text) => {
    if (isQueryLevelAgent(id)) return; // no single ticket to comment on — same discipline as issueCrashLoopDetector/issueReconcileFailureDetector above
    const decoded = decodeAnyAgentKey(id);
    if (decoded?.resourceProvider !== "jira-work" && decoded?.resourceProvider !== "jira-idea") return;
    await speakOnOwnChannel(ops, resourceKeyOf(id), text);
  },
});
// BUTCHR-412 — the daemon-shutdown residual gap, named honestly rather than
// closed: daemon shutdown has NO stop handler at all (src/agents/herd.ts's
// callers never call herd.stop from a shutdown path; agents keep running
// under herdr regardless of this process's own lifetime), so nothing here
// needs to release an account on shutdown — an agent that is still running
// still legitimately holds its account. The gap this DOES leave is an
// account whose agent genuinely stopped existing with no reaper run in
// between (this daemon crashing before a reap poll ever observed it, or an
// account orphaned by an earlier bug) — `reconcileOrphans` is the read-only
// backstop `docs/rocketchat-accounts.md` names for exactly this.
// `createAccountOrphanSweep` (src/agents/account-orphan-sweep.ts) is the
// SAFE wrapper around it — see that module's own top comment for why a
// single `herd.runningIssues()` snapshot is NOT safe to act on directly
// (review finding, round 1): it uses `herd.residentIssues()` (a real
// per-pane liveness check) plus a minimum record age and a two-consecutive-
// sweep grace before ever releasing anything. Run once at startup, then on
// this interval — cheap enough (one file read, one herd read per sweep)
// that a dedicated poll loop would be overkill. BUTCHR-460: this timer now
// always runs (see "ALWAYS BUILT" above) — a `.butchr-rc-accounts.json` read
// every 30 minutes even for a daemon that never provisions anything, the one
// accepted cost of closing the silent-unaccounted-spawn gap.
const orphanSweep = createAccountOrphanSweep({
  now: () => Date.now(),
  reconcileOrphans: (agentExists) => accountManager.reconcileOrphans(agentExists),
  residentIssues: () => herd.residentIssues(),
  release: (agentKey, reason) => accountLifecycle.release(agentKey, reason),
  publishBatch: () => accountLifecycle.publishBatch(),
  log: (line) => console.error(`  ${line}`),
});
const ACCOUNT_ORPHAN_SWEEP_MS = 30 * 60_000;
void orphanSweep.sweep();
setInterval(() => void orphanSweep.sweep(), ACCOUNT_ORPHAN_SWEEP_MS);

const issueCrashLoopDetector = createCrashLoopDetector({
  now: () => Date.now(),
  count: config.crashLoopCount,
  windowMinutes: config.crashLoopWindowMinutes,
  addComment: async (id, text) => {
    if (isQueryLevelAgent(id)) { console.error(`  [crash-loop] ${id}: query-level agent — no single ticket to comment on, skipping`); return; }
    await speakOnOwnChannel(ops, resourceKeyOf(id), text);
  },
  comments: (id) => (isQueryLevelAgent(id) ? Promise.resolve([]) : ownChannelComments(resourceKeyOf(id))),
  log: (line) => console.error(`  ${line}`),
});
// FACTORY-47: a managed-session agent (built-in `managed-sessions` rule,
// BUTCHR-408) has NO Jira ticket to comment on at all — unlike
// `issueCrashLoopDetector` above, every id this instance ever sees IS one of
// these filesystem-provider ids (this is wired ONLY into
// `startManagedSessionsLoop` below), never conditionally, so there is no
// `isQueryLevelAgent`-style branch here: `addComment`/`comments` always
// bypass Jira and log instead. Before this, a managed session whose agent
// kept dying and being respawned (a startup crash, an MCP config that
// failed to load, a session-limit refusal that never cleared, ...) had
// NOTHING recording why — see `createCrashLoopDetector`'s own top comment
// ("nothing to stop it and NOTHING TO SAY SO"), which this ticket found
// applied to managed sessions exactly as much as to an ordinary rule agent,
// just never wired up for them. Its own instance (never shared with
// `issueCrashLoopDetector`), same reasoning as that detector's own doc
// comment on why each `runResourceLoop` call needs its own tracker.
const managedSessionCrashLoopDetector = createCrashLoopDetector({
  now: () => Date.now(),
  count: config.crashLoopCount,
  windowMinutes: config.crashLoopWindowMinutes,
  addComment: async (id, text) => { console.error(`  [managed-sessions:crash-loop] ${id}: no Jira ticket to comment on — logging instead:\n  ${text.replace(/\n/g, "\n  ")}`); },
  comments: () => Promise.resolve([]),
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
  addComment: async (id, text) => {
    if (isQueryLevelAgent(id)) { console.error(`  [reconcile-failure] ${id}: query-level agent — no single ticket to comment on, skipping`); return; }
    await speakOnOwnChannel(ops, resourceKeyOf(id), text);
  },
  comments: (id) => (isQueryLevelAgent(id) ? Promise.resolve([]) : ownChannelComments(resourceKeyOf(id))),
  log: (line) => console.error(`  ${line}`),
});
// BUTCHR-245: per-poll reclamation of a workspace whose agent exited on its
// own — see src/agents/reap.ts for the full mechanism (the ownership join,
// the grace period, the per-poll cap). TWO SEPARATE INSTANCES, same
// reasoning as issueCrashLoopDetector/projectCrashLoopDetector above: each
// `runResourceLoop` call needs its own `ReapGuard` (grace-period state),
// same "one instance per loop" discipline `RespawnGuard` already follows.
// Both operate on the SAME shared herd namespace (there is no per-loop
// scoping here — reclamation is scoped to the WORKSPACE, never to an issue
// key, so `scopedHerd`'s ownsId filtering does not apply and is not used):
// whichever loop's poll observes a candidate clear its grace period first
// closes it; the other loop's own tracker simply stops seeing that
// workspace in its next `workspace.list()` snapshot and never attempts a
// second close. `herd` (the raw HerdrHerd instance, not `scopedHerd`'s
// wrapper) is used directly — `strandedCandidates`/`closeStranded` are
// HerdrHerd methods outside the `Herd` interface `scopedHerd` wraps.
const issueReaper = createReaper({
  now: () => Date.now(),
  candidates: () => herd.strandedCandidates(),
  close: (c) => herd.closeStranded(c),
  // BUTCHR-412: the self-exit path's own account teardown — a reaped
  // workspace's agent exited on its own (crash, `/exit`, quota) and never
  // went through `HerdrHerd.stop()`/`reconcileNow`'s `plan.stop` at all, so
  // nothing else in this daemon would otherwise release a temporary account
  // for it. `"stop"` — a reap IS a genuine stop, not a respawn.
  ...(accountLifecycle ? { release: (agentKey: string) => accountLifecycle!.release(agentKey, "stop") } : {}),
  log: (line) => console.error(`  ${line}`),
});
// BUTCHR-287: a live per-issue residency census, independent of
// agent.list() — see src/agents/residency-guard.ts and
// src/agents/residency-census.ts for the full mechanism. TWO SEPARATE
// INSTANCES, same reasoning as issueReaper/projectReaper above: each
// `runResourceLoop` call needs its own unknown-streak tracker (the bounded
// decay for a persistently-ambiguous census — see ResidencyGuard's own doc
// comment), same "one instance per loop" discipline `RespawnGuard`/
// `ReapGuard` already follow — unlike `admissionController` above, which is
// deliberately ONE shared instance because IT bounds the host, not a tier.
// `herd.residency` (the raw HerdrHerd instance's own method, not part of
// the `Herd` interface `scopedHerd` wraps) is used directly, same as
// `herd.strandedCandidates`/`herd.closeStranded` above — candidates always
// arrive pre-scoped to this loop's own `plan.spawn`, so there is nothing
// for `scopedHerd`'s `ownsId` filtering to add here.
const issueResidencyGuard = createResidencyGuard({
  census: (candidates) => herd.residency(candidates),
  log: (line) => console.error(`  ${line}`),
});
// BUTCHR-352: the issue tier's own admission census bucket — the SAME
// `admissionController` instance the issue/project `runResourceLoop` calls
// below already share (see that construction's own comment for why one
// instance, not one per tier). Only the ISSUE tier's bucket is relevant here:
// syncLabels only ever processes Jira issues (only the issue `runResourceLoop`
// call wires `syncLabels` in at all — see that call site's own comment), so
// a project-tier candidate is never a `syncLabels` input in the first place.
// Returns the TRUSTED withheld set from a `checked: true` bucket, or the
// literal `"unknown"` from a `checked: false` one (residency threw, an
// untrusted implausible zero, or this source has never reported) — never a
// guess either way. `desiredLabels` (src/labels/plan.ts) re-emits whatever
// admission:withheld marker a ticket already carries on `"unknown"` rather
// than flipping it off from an observation never made (KAN-832/837's own
// pattern) — so a bad poll holds the last TRUSTED state rather than
// asserting a confident wrong one in either direction. Synchronous:
// `census()` reads state `admit()` already computed EARLIER in this SAME
// poll (`reconcileNow` runs before `syncLabels` — see src/daemon/loop.ts's
// own call order), never a second/stale read.
const issueAdmissionWithheld = (): ReadonlySet<string> | "unknown" => {
  const bucket = admissionController.census().buckets.find((b) => b.source === ADMISSION_SOURCE_ISSUE);
  return bucket?.checked ? new Set(bucket.withheld.map(resourceKeyOf)) : "unknown";
};

const syncLabels = createLabelSync({
  jira: labelWriter,
  agentStatuses: agentStatusesFeedingDashboard,
  ...(prTracker ? { prState: (key: string) => prTracker.stateFor(key), onPollEnd: () => prTracker.endPoll() } : {}),
  stalled,
  stallRemediation,
  withheld: issueAdmissionWithheld,
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
// list/read wired through quotaGate (created above) rather than straight to
// herdr.agent.list()/readPane — same rows, same pane text, same recogniser,
// just tee'd so BUTCHR-221's quotaBlocked predicate stays current off this
// exact poll. watchSessionLimits itself is unmodified and unaware.
watchSessionLimits({
  list: quotaGate.list,
  read: quotaGate.read,
  close: (issue) => herd.stop(issue),
  skipRecovery: () => Boolean(config.agent?.providers || Object.keys(config.agent?.roleProviders ?? {}).length),
  now: () => Date.now(),
  log: (line) => console.error(`  ${line}`),
  captures: createCaptureStore(config.captureDir),
}, 15_000);

// One-time startup sweep: agent:* stranded by a ticket that went inactive
// while the daemon was down. createLabelSync's bookkeeping is in-memory and
// the 15s poll only ever sees active tickets, so nothing else ever revisits
// this. Not a new polling timer — runs once, here, and never again.
if (rules.some(r => r.enabled && r.resourceProvider === "jira-work")) void sweepStaleAgentLabels({
  search: (jql) => atlassian.search(jql),
  jira: labelWriter,
  log: (line) => console.error(`  ${line}`),
}).catch((e) => console.error(`  WARNING: startup agent:* sweep failed: ${(e as Error)?.message ?? e}`));

// The rule engine: every enabled rule's JQL, one agent per (rule, matched
// ticket), reconciled by the SAME generic loop the issue and project tiers
// used to run (src/rules/resource-type.ts). This replaces both of those
// loops outright — there is no second loop that could also staff a ticket.
//
// `ownsId: ownsRuleAgent` is what keeps legacy agents and workspaces
// untouched: a legacy `<root>/<ISSUE>` agent reports a bare issue key, which
// never decodes as an agent key, so this loop can neither stop nor adopt it.
// BUTCHR-436: pulled out of the `runResourceLoop` call below (which used to
// build this inline) so the SAME function can also be handed to
// `createRuleResourceType` as `RuleResourceDeps.notify` — the seam its own
// linked-change eventing tick delivers its coalesced nudge through (see
// src/jira-watch/linked-eventing.ts's own top comment for why this is
// "UNCHANGED IN SHAPE": the actual channel-push mechanism below is
// untouched, only its `reason` branching gains one more case).
const notifyRuleAgent = async (agent: string, about: string, reason?: NotifyReason): Promise<void> => {
  // BUTCHR-398 (review finding 5): `issue` is the agent's OWN identity —
  // for a query-level agent that's its own query key, shown as-is in
  // `changeNudge`'s "related to your X" framing (there is no friendlier
  // single ticket to name it by). `aboutIssue` is the CHANGED resource —
  // for `notifyAgent`'s own `meta.issue`, that changed resource (not the
  // agent's own identity) is what a notification is actually about, the
  // same thing the other three provider loops already pass as their own
  // `deliver(agent, resource, msg)` argument.
  const issue = resourceKeyOf(agent);
  const aboutIssue = resourceKeyOf(about);
  const msg = reason && "linked" in reason ? linkedChangeNudge(issue, reason.linked.events)
    : reason && "pr" in reason ? prReviewStateNudge(issue, reason.pr.from, reason.pr.to)
    : changeNudge(issue, aboutIssue, reason);
  void notifyAgent(mcp, agent, aboutIssue, msg).catch((e) => console.error(`  [notify] Claude channel failed: ${String(e)}`));
  const outcome = await herd.nudge(agent, msg).catch((): NudgeResult => ({ delivered: false }));
  const reasonTag = notifyReasonTag(reason);
  const promptState = outcome.refusal
    ? `refused (session limit, resets ${outcome.refusal.resetsAt !== null ? new Date(outcome.refusal.resetsAt).toISOString() : "unknown"})`
    : outcome.delivered ? "delivered" : "refused/absent";
  console.error(`  [notify] ${agent} ← ${aboutIssue}${reasonTag}: Claude channel attempted (Codex excluded), prompt ${promptState}`);
};

const ruleResourceType = createRuleResourceType({
  rules,
  // searchAll, never search: a first-page-only result would read as tickets
  // leaving the query and stop their agents.
  search: async (jql) => {
    const issues = await atlassian.searchAll(jql);
    for (const i of issues) issueMeta.set(i.key, { summary: i.summary, issuetype: i.issuetype });
    return issues;
  },
  suppress: (key, updated, watcher) => ownWrites.shouldSuppress(key, updated, watcher, Date.now()),
  comments: (key) => atlassian.comments(key),
  log: (line) => console.error(`  ${line}`),
  runningIds: async () => (await herd.runningIssues()).filter(ownsRuleAgent),
  // BUTCHR-436: gates each rule's own `linkedRemoteLinks` opt-in — a rule
  // that leaves it absent/false never calls this (see
  // src/jira-watch/linked-eventing.ts's own contract).
  remoteLinks: (key) => atlassian.remoteLinks(key),
  // BUTCHR-437: the three external-link pollers' own deps — every one
  // gated by a match's own `linkedDescriptionLinks` opt-in inside
  // linked-eventing.ts, never called otherwise. `webpage` needs no
  // config (a bare, unauthenticated `fetch`; see external-poll.ts's own
  // "SECURITY" doc comment for why it must never carry credentials);
  // `github` is omitted entirely when this daemon has no GitHub token/orgs
  // configured (same `config.github` this file's pr:* discovery already
  // gates on) — an omitted dep makes every GitHub-kind item resolve
  // "error" (skipped, retried, never reported unreadable), not a crash.
  confluenceVersion: (id) => atlassian.confluencePageVersion(id),
  ...(config.github ? { github: { fetchImpl: fetch, token: config.github.token } } : {}),
  webpage: { fetchImpl: fetch },
  // FACTORY-9: `pollFilesystem`'s own dep — plain `node:fs/promises` `stat`,
  // no config gate (mirrors `webpage` immediately above: no credentials, no
  // per-daemon opt-in needed).
  filesystem: { stat },
  // FACTORY-9: the SAME FACTORY-4 local link store `resourceLinkTools`
  // above is registered with (a fresh `LinkStore` handle onto the same
  // underlying file — this implementation is stateless per call, so a
  // second handle is equivalent to sharing one instance; see
  // `createLinkStore`'s own doc comment, src/resources/link-store.ts).
  linkStore: createLinkStore(defaultLinksStorePath()),
  notify: notifyRuleAgent,
});

runResourceLoop(ruleResourceType, {
  herd,
  ownsId: ownsRuleAgent,
  notify: notifyRuleAgent,
  onRespawn: async (agent, reason, observedArgv) => {
    console.error(`  [reconcile] ${agent} respawned: ${reason} (was: ${observedArgv.join(" ")})`);
    // BUTCHR-398: a query-level agent has no single ticket to post a respawn
    // notice on — `resourceKeyOf(agent)` would otherwise post to the bogus
    // key itself (see this file's own `isQueryLevelAgent` comment above).
    if (isQueryLevelAgent(agent)) return;
    const issue = resourceKeyOf(agent);
    await ops.addComment(issue, respawnComment(agent, reason, new Date().toISOString())).catch((e) =>
      console.error(`  WARNING: [reconcile] respawn notice failed for ${agent}: ${(e as Error)?.message ?? e}`));
  },
  // Label sync and the parked/abandoned detectors work per TICKET, so they
  // see each matched issue once however many rules matched it.
  syncLabels: (matches) => syncLabels(uniqueIssues(matches)),
  checkParked: (matches) => parkedDetector.check(uniqueIssues(matches), []),
  checkAbandoned: (matches) => abandonedDetector.check(uniqueIssues(matches)),
  checkCrashLoop: issueCrashLoopDetector.check,
  checkReconcileFailure: issueReconcileFailureDetector.check,
  checkReap: issueReaper.check,
  checkResidency: issueResidencyGuard.filter,
  admission: (candidates, stopping) => admissionController.admit(candidates, stopping, ADMISSION_SOURCE_ISSUE),
  onAdmitted: admissionController.recordSpawned,
  reserveAdmission: (ids) => admissionController.reserve(ids, ADMISSION_SOURCE_ISSUE),
  releaseAdmission: (ids) => admissionController.release(ids, ADMISSION_SOURCE_ISSUE),
  account: accountLifecycle,
  log: (line) => console.error(`  ${line}`),
  intervalMs: 15_000,
  onError: (e) => console.error(`  loop error: ${(e as Error)?.message ?? e}`),
  onPollSuccess: () => loopHealth.recordSuccess(),
  onNotifySuccess: () => notifyHealth.recordSuccess(),
});

// The github-issue rule loop: its own agents only, its own admission bucket
// under the same host cap, and none of the Jira-writing detectors above.
if (githubIssues) console.error(`  github-issue rules: ${githubStaffing.rules.map((r) => r.id).join(", ")}`);
// Read by the jira-idea loop: the GitHub issues idea rules may hear. Empty while github-issue rules are not staffed.
let githubMatches: readonly GithubIssueMatch[] = [];
// Read by the link tools: the ideas jira-idea rules currently match. Empty until the idea loop completes a poll.
let ideaMatches: readonly RuleMatch[] = [];
startGithubIssueLoop({
  onMatches: (matches) => { githubMatches = matches; },
  staffing: githubStaffing,
  client: githubIssues ?? { searchAll: async () => [], comments: async () => [] },
  herd,
  deliver: async (agent, resource, msg) => {
    void notifyAgent(mcp, agent, resource, msg).catch((e) => console.error(`  [notify] Claude channel failed: ${String(e)}`));
    const outcome = await herd.nudge(agent, msg).catch((): NudgeResult => ({ delivered: false }));
    console.error(`  [notify] ${agent}: Claude channel attempted (Codex excluded), prompt ${outcome.delivered ? "delivered" : "refused/absent"}`);
  },
  suppress: (resource, updated, watcher) => ownWrites.shouldSuppress(resource, updated, watcher, Date.now()),
  admission: (candidates, stopping) => admissionController.admit(candidates, stopping, ADMISSION_SOURCE_GITHUB_ISSUE),
  onAdmitted: admissionController.recordSpawned,
  reserveAdmission: (ids) => admissionController.reserve(ids, ADMISSION_SOURCE_GITHUB_ISSUE),
  releaseAdmission: (ids) => admissionController.release(ids, ADMISSION_SOURCE_GITHUB_ISSUE),
  account: accountLifecycle,
  log: (line) => console.error(`  ${line}`),  onPollSuccess: () => githubIssueHealth.recordSuccess(),
  onError: (e) => githubIssueHealth.recordError(e),
});

// The jira-idea rule loop: proven Product Discovery ideas only, its own
// agents and admission bucket, and none of the work-item detectors above.
if (jiraIdeas) console.error(`  jira-idea rules: ${ideaRules.map((r) => r.id).join(", ")}`);
if (!githubIssues && ideaRules.some((r) => r.relationships?.inwardConnectionRules?.length)) console.error("  WARNING: jira-idea rules list github-issue rules, but github-issue rules are not staffed; ideas hear no GitHub issues");
startJiraIdeaLoop({
  rules,
  search: async (jql) => {
    const issues = await atlassian.searchAll(jql);
    for (const i of issues) issueMeta.set(i.key, { summary: i.summary, issuetype: i.issuetype });
    return issues;
  },
  comments: (key) => atlassian.comments(key),
  onMatches: (matches) => { ideaMatches = matches; },
  ...(githubIssues && jiraIdeas ? {
    githubMatches: () => githubMatches,
    githubLinks: (key: string) => jiraIdeas.githubIssues(key),
    githubComments: (ref: GithubIssueRef) => githubIssues.comments(ref),
  } : {}),
  herd,
  deliver: async (agent, resource, msg) => {
    void notifyAgent(mcp, agent, resource, msg).catch((e) => console.error(`  [notify] Claude channel failed: ${String(e)}`));
    const outcome = await herd.nudge(agent, msg).catch((): NudgeResult => ({ delivered: false }));
    console.error(`  [notify] ${agent}: Claude channel attempted (Codex excluded), prompt ${outcome.delivered ? "delivered" : "refused/absent"}`);
  },
  suppress: (key, updated, watcher) => ownWrites.shouldSuppress(key, updated, watcher, Date.now()),
  admission: (candidates, stopping) => admissionController.admit(candidates, stopping, ADMISSION_SOURCE_JIRA_IDEA),
  onAdmitted: admissionController.recordSpawned,
  reserveAdmission: (ids) => admissionController.reserve(ids, ADMISSION_SOURCE_JIRA_IDEA),
  releaseAdmission: (ids) => admissionController.release(ids, ADMISSION_SOURCE_JIRA_IDEA),
  account: accountLifecycle,
  log: (line) => console.error(`  ${line}`),  onPollSuccess: () => jiraIdeaHealth.recordSuccess(),
  onError: (e) => jiraIdeaHealth.recordError(e),
});

// The zendesk-ticket rule loop: its own agents and admission bucket, and none
// of the detectors above. Its agents' only write is a private internal note.
if (zendeskStaffing.run) console.error(`  zendesk-ticket rules: ${zendeskStaffing.rules.map((r) => r.id).join(", ")} (subdomain ${zendeskStaffing.subdomain})`);
startZendeskTicketLoop({
  staffing: zendeskStaffing,
  client: zendeskTickets ?? { searchAll: async () => [], comments: async () => [] },
  herd,
  deliver: async (agent, resource, msg) => {
    void notifyAgent(mcp, agent, resource, msg).catch((e) => console.error(`  [notify] Claude channel failed: ${String(e)}`));
    const outcome = await herd.nudge(agent, msg).catch((): NudgeResult => ({ delivered: false }));
    console.error(`  [notify] ${agent}: Claude channel attempted (Codex excluded), prompt ${outcome.delivered ? "delivered" : "refused/absent"}`);
  },
  suppress: (resource, updated, watcher) => ownWrites.shouldSuppress(resource, updated, watcher, Date.now()),
  admission: (candidates, stopping) => admissionController.admit(candidates, stopping, ADMISSION_SOURCE_ZENDESK_TICKET),
  onAdmitted: admissionController.recordSpawned,
  reserveAdmission: (ids) => admissionController.reserve(ids, ADMISSION_SOURCE_ZENDESK_TICKET),
  releaseAdmission: (ids) => admissionController.release(ids, ADMISSION_SOURCE_ZENDESK_TICKET),
  account: accountLifecycle,
  log: (line) => console.error(`  ${line}`),
  onPollSuccess: () => zendeskTicketHealth.recordSuccess(),
  onError: (e) => zendeskTicketHealth.recordError(e),
});

// The filesystem rule loop: its own agents and admission bucket, no external
// credential, none of the Jira-writing detectors above, and its own resource
// (a file or directory) is never written to by butchr itself.
if (fsRules.length) console.error(`  filesystem rules: ${fsRules.map((r) => r.id).join(", ")}`);
startFilesystemLoop({
  rules,
  herd,
  deliver: async (agent, resource, msg) => {
    void notifyAgent(mcp, agent, resource, msg).catch((e) => console.error(`  [notify] Claude channel failed: ${String(e)}`));
    const outcome = await herd.nudge(agent, msg).catch((): NudgeResult => ({ delivered: false }));
    console.error(`  [notify] ${agent}: Claude channel attempted (Codex excluded), prompt ${outcome.delivered ? "delivered" : "refused/absent"}`);
  },
  admission: (candidates, stopping) => admissionController.admit(candidates, stopping, ADMISSION_SOURCE_FILESYSTEM),
  onAdmitted: admissionController.recordSpawned,
  reserveAdmission: (ids) => admissionController.reserve(ids, ADMISSION_SOURCE_FILESYSTEM),
  releaseAdmission: (ids) => admissionController.release(ids, ADMISSION_SOURCE_FILESYSTEM),
  log: (line) => console.error(`  ${line}`),
  onPollSuccess: () => filesystemHealth.recordSuccess(),
  onError: (e) => filesystemHealth.recordError(e),
});

// BUTCHR-408: the built-in managed-sessions query — butchr's own rule, never
// read from rules.json, over the well-known definitions directory. Same
// admission/health wiring shape as every rule loop above, its own bucket.
console.error(`  managed-session definitions: ${sessionDefinitionsPath()}`);
startManagedSessionsLoop({
  roles: managedSessionRoles,
  accountPolicies: managedSessionAccountPolicies,
  account: accountLifecycle,
  herd,
  deliver: async (agent, resource, msg) => {
    void notifyAgent(mcp, agent, resource, msg).catch((e) => console.error(`  [notify] Claude channel failed: ${String(e)}`));
    const outcome = await herd.nudge(agent, msg).catch((): NudgeResult => ({ delivered: false }));
    console.error(`  [notify] ${agent}: Claude channel attempted (Codex excluded), prompt ${outcome.delivered ? "delivered" : "refused/absent"}`);
  },
  admission: (candidates, stopping) => admissionController.admit(candidates, stopping, ADMISSION_SOURCE_MANAGED_SESSIONS),
  onAdmitted: admissionController.recordSpawned,
  reserveAdmission: (ids) => admissionController.reserve(ids, ADMISSION_SOURCE_MANAGED_SESSIONS),
  releaseAdmission: (ids) => admissionController.release(ids, ADMISSION_SOURCE_MANAGED_SESSIONS),
  checkCrashLoop: managedSessionCrashLoopDetector.check,
  log: (line) => console.error(`  ${line}`),
  onPollSuccess: () => managedSessionsHealth.recordSuccess(),
  onError: (e) => managedSessionsHealth.recordError(e),
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
  // FACTORY-50 (Part C): the SAME sink also lands a keyless managed-session
  // pane's capture, under its own disjoint filename shape — no separate dep
  // to wire, since `EscalatorDeps.captures` is already the one seam both
  // paths funnel through inside escalation-loop.ts.
  captures: createCaptureStore(config.captureDir),
  coverage,
  // FACTORY-45: called only when `issueForPane` already resolved null for
  // this pane (see the wiring below) — a real managed-session identity
  // widens the keyless path to a loud journal line + a `/health` stalled
  // mark; anything else keeps today's log-only behavior.
  managedSessionOf: managedSessionOfPane,
});

// Resolves a pane's issue key the same way for onExposed and onUnparseable —
// both need it, and neither can assume the caller already has it.
async function issueForPane(paneId: string): Promise<string | null> {
  const { agents } = await herdr.agent.list();
  return escalationTargetOfCwd(agents.find((a) => a.pane_id === paneId)?.cwd);
}

/**
 * FACTORY-45: `escalator`'s own `managedSessionOf` dep — resolves a pane's
 * managed-session identity, called ONLY when `issueForPane` already
 * returned null for it (see the escalator wiring below). `agentIdOfWorkspacePath`
 * decodes the pane's cwd back to its herd id regardless of provider;
 * `ownsManagedSessionAgent` narrows that to exactly the filesystem-provider
 * `managed-sessions` built-in rule (src/rules/session-definition-type.ts) —
 * every OTHER keyless pane (an unowned/legacy workspace, a query-level
 * agent, a plain `filesystem` agent under some OTHER rule, ...) resolves
 * `null` here, which keeps today's log-only behavior for them exactly (see
 * `EscalatorDeps.managedSessionOf`'s own doc comment). A second
 * `herdr.agent.list()` call, separate from `issueForPane`'s own: only paid
 * for a keyless pane, which is the uncommon case, and keeps this a small,
 * independent seam rather than reshaping `issueForPane`'s existing contract.
 */
async function managedSessionOfPane(paneId: string): Promise<{ agentKey: string; definitionPath: string } | null> {
  const { agents } = await herdr.agent.list();
  const cwd = agents.find((a) => a.pane_id === paneId)?.cwd;
  const id = agentIdOfWorkspacePath(cwd);
  if (!id || !ownsManagedSessionAgent(id)) return null;
  const decoded = decodeAnyAgentKey(id);
  // The built-in managed-sessions rule always runs `swarm` execution (one
  // agent per definition file — see builtinManagedSessionsRule's own doc
  // comment, src/rules/session-definition-type.ts), so it never produces a
  // query-level ("@query") agent key; this is defensive, not expected to be
  // exercised.
  if (!decoded || decoded.kind !== "resource") return null;
  return { agentKey: id, definitionPath: decoded.resourceId };
}

// FACTORY-45 Part B: drovr's own host-neutral escalation hook
// (`createManagedSessionEscalationWatcher`, src/agents/managed-session-escalation-watcher.ts,
// wrapping `@brooswit/drovr` >= 0.15.0's `createBlockingEscalationWatcher`)
// — deliberately a SEPARATE poll loop, own timer, own read of the fleet:
// the watcher's own contract ("never call poll concurrently on the same
// instance") is exactly the same "no overlapping polls" discipline
// watchBlocked already gives its own caller, so this loop earns it the
// same way rather than borrowing that one's cadence. Feeds ONLY the
// managed-session minimal escalation (`escalator.onDrovrUnknownDialog`/
// `onDrovrDialogResolved`) — a keyed pane, or a keyless pane that is not a
// managed session, is a no-op there (see that method's own doc comment,
// src/agents/escalation-loop.ts): Butchr's EXISTING `watchPrompts` pipeline
// below stays the SOLE answerer and authoritative detector/escalator for
// both, unchanged by this ticket — drovr's own `sendKeys` is a permanent
// no-op here (see `createManagedSessionEscalationWatcher`'s own doc
// comment for why: it detects and escalates, but never presses).
const blockingEscalationWatcher = createManagedSessionEscalationWatcher(escalator);
let blockingEscalationPollInFlight = false;
const blockingEscalationTimer = setInterval(() => {
  if (blockingEscalationPollInFlight) return;
  blockingEscalationPollInFlight = true;
  blockingEscalationWatcher.poll(herdr)
    .catch((e) => console.error(`  [blocking-escalation] poll failed: ${(e as Error)?.message ?? e}`))
    .finally(() => { blockingEscalationPollInFlight = false; });
}, 5_000);
blockingEscalationTimer.unref?.();

// DROVR-42 (host-wiring decision carried over from DROVR-41, under the
// DROVR-37 epic): a THIRD, independent pane-scanning timer — see
// src/agents/permission-answer-loop.ts's own header for the full reasoning
// (why this is its own timer rather than folded into the Jira reconcile
// loop above or `blockingEscalationTimer` immediately above, and why it
// cannot collide with `chooseStartupAnswer`/`watchPrompts` below). Presses
// keys (unlike `blockingEscalationTimer`, which never does — see that
// timer's own comment) so it earns its own tighter isolation from every
// other poll loop's failure modes, exactly like `blockingEscalationTimer`
// already does for the same reason.
//
// CADENCE, chosen and measured against this daemon's own load rather than
// copied from DROVR-41's order-of-magnitude suggestion unread: 20s lands
// inside DROVR-41's own 15-30s recommendation, slower than the 5s
// `blockingEscalationTimer`/`watchPrompts` timers (a pure-read status poll,
// cheap to run often) but close to this daemon's own ~15s Jira reconcile
// cadence under load (BUTCHR-117) — a blocked agent is now unblocked within
// one tick of a bound already proven acceptable elsewhere in this same
// daemon, without adding a fourth distinct polling rhythm to reason about.
// `READ_TIMEOUT_MS` (8s) sits comfortably below `INTERVAL_MS` (20s) — see
// `AutoAnswerPermissionsOptions.readTimeoutMs`'s own doc comment
// (`@brooswit/drovr`) for why a pane's attempt must never still be in
// flight when the next tick fires — with margin over drovr's own internal
// approve-verify budget (5s default `verifyTimeoutMs`, measured against
// `node_modules/@brooswit/drovr/dist/index.js`) rather than picked to
// exactly match it.
const PERMISSION_ANSWER_INTERVAL_MS = 20_000;
const PERMISSION_ANSWER_READ_TIMEOUT_MS = 8_000;
startPermissionAnswerLoop(
  {
    client: herdr,
    auditPath: config.permissionAuditPath,
    operator: "butchr-daemon",
    readTimeoutMs: PERMISSION_ANSWER_READ_TIMEOUT_MS,
    log: (line) => console.error(`  ${line}`),
  },
  PERMISSION_ANSWER_INTERVAL_MS,
);

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

// Free-form jira-project resource agents (BUTCHR-425): no ticket, Confluence,
// or boss/worker workflow — just discovery (matching Jira projects), spawn,
// and residency/admission, sharing the same host cap and herd namespace as
// every other rule provider. Always sentinels (src/agents/capacity-role.ts),
// so admission never withholds one regardless of `config.maxAgents`.
const projectType = createJiraProjectResourceType({
  rules,
  search: (q) => atlassian.searchProjects(q),
  isFrozen: async (id) => (await herd.frozen([id])).has(id),
  prepare: (spec) => resourceConnections.prepare(spec),
  // BUTCHR-469: linked-change eventing (member discovery + managed links) —
  // the SAME `searchAll`/`comments`/`notifyRuleAgent` seams the jira-work
  // rule loop's own linked-eventing wiring already uses above, plus the
  // SAME routed link store `resourceLinkTools` is wired with (a
  // `jira-project:` owner key routes to the `brooswit.butchr.links`
  // project-property store — see `routingLinkStore`'s own doc comment).
  searchIssues: (jql) => atlassian.searchAll(jql),
  comments: (key) => atlassian.comments(key),
  linkStore: routingLinkStore,
  notify: notifyRuleAgent,
  log: (line) => console.error(`  [jira-project] ${line}`),
});
runResourceLoop(projectType, {
  herd,
  ownsId: ownsJiraProjectAgent,
  // Free-form: no notification concept (eventRules.poll always reports no
  // changes — see jira-project-type.ts), and no respawn ticket to comment on.
  notify: async () => {},
  onRespawn: async (id, reason) => { console.error(`  [jira-project] ${id} respawned: ${reason}`); },
  // No labels to sync; the only per-poll bookkeeping is retiring MCP
  // connections for agents that dropped out of this poll's matches.
  syncLabels: async (matches) => { await resourceConnections.retain(new Set(matches.map((m) => m.agentKey))); return new Set<string>(); },
  admission: (candidates, stopping) => admissionController.admit(candidates, stopping, ADMISSION_SOURCE_JIRA_PROJECT),
  onAdmitted: admissionController.recordSpawned,
  reserveAdmission: (ids) => admissionController.reserve(ids, ADMISSION_SOURCE_JIRA_PROJECT),
  releaseAdmission: (ids) => admissionController.release(ids, ADMISSION_SOURCE_JIRA_PROJECT),
  intervalMs: 60_000,
  log: (line) => console.error(`  [jira-project] ${line}`),
  onPollSuccess: () => jiraProjectHealth.recordSuccess(),
  onError: (e) => { jiraProjectHealth.recordError(e); console.error(`  [jira-project] ${String(e)}`); },
});
