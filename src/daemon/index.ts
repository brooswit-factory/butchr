import { decodeAgentKey } from '../rules/agent-key.js';
import { ResourceConnections } from '../agents/resource-connections.js';
import { createJiraProjectResourceType, ownsJiraProjectAgent, pinnedActiveMinutesFor } from '../rules/jira-project-type.js';
import { readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { DrovrClient, createLoginExpiredWatcher, scanPendingCodexApprovals, HerdrTransportError } from "@brooswit/drovr";
import { installLogSink } from "./log-sink.js";
import { createOutstandingGuard } from "./herdr-subscribe-deadline.js";
import { loadConfig, describeConfig, ignoredExtensionOriginsWarning, isAtlassianConfigured } from "../config/config.js";
import { resolveEffectiveJiraEnv } from "../config/effective-env.js";
import { runSetupModeDaemon } from "./setup-mode.js";
import { createSetupCodeManager, installSetupCodeSigusr2Handler } from "../setup/setup-code.js";
import { handleJiraTokenWrite, type JiraWriteDeps } from "../web/setup-api.js";
import { jiraTokenFilePath } from "../setup/jira-token-write.js";
import { AtlassianClient } from "../atlassian/client.js";
import { buildApp, notifyAgent } from "./app.js";
import { deliverNotice, renderNotifyDelivery } from "../notify/deliver.js";
import { inventoryCodexMcp } from "../agents/argv.js";
import { inventoryAgyMcp } from "../mcp/registration.js";
import { combineHealth, createLoopHealth, createResourceLoopHealth, createTickHealth } from "./health.js";
import { createLoopWatchdog } from "./loop-watchdog.js";
import { DAEMON_HOSTNAME, listenOptions } from "./listen.js";
import { createCoverageTracker } from "./coverage.js";
import { createCurrencyTracker } from "./currency.js";
import { HerdrHerd } from "../agents/herd.js";
import { reportPersistedAgentSessions } from "../agents/report-agent-sessions.js";
import { createCodexChannelRelayPool } from "../notify/codex-channel-relay.js";
import { agentIdOfWorkspacePath, resourceKeyOf, ruleAgentIdOfWorkspacePath, singleResourceOf, workspaceRoot } from "../agents/workspace.js";
import { basename, dirname, join } from "node:path";
import { hostname } from "node:os";
import { StatusFloorTracker } from "../agents/status-floor.js";
import { createDashboardFeed, cwdAgentResolvers, DASHBOARD_DETECTOR, type IssueMeta, type DashboardAgent } from "../agents/dashboard.js";
import { buildResourcesForUrlResponse } from "../resources/resource-lookup.js";
import { projectRootDoc } from "../tools/docs.js";
import { resolveResourceLink } from "../resources/resource-link.js";
import { buildIdentity, toBuildReport, describeBuild } from "../agents/build-identity.js";
import { resolveWebRoot, dashboardAppStatus } from "../web/static-assets.js";
import { computeBuildCurrency } from "../agents/build-currency.js";
import { runResourceLoop } from "./loop.js";
import { createTodoWorkersFetch } from "../resources/issue.js";
import { loadRules, rulesPath, unresolvedRelationships, formatUnresolvedRelationshipWarning, createRulesHolder, sourceEtagOf, DEFAULT_IDLE_POKE_MESSAGE, type AccountPolicy, type AgentEffort, type AgentRole } from "../rules/rules.js";
import { resourceMatches, type ExecutionUnit } from "../rules/execution.js";
import { createIdlePokeEngine, type IdlePokeRuleConfig } from "../agents/idle-poke.js";
import { seedFirstRunRules, type FirstRunSeedOutcome } from "../rules/seed-first-run.js";
import { runCapacityRoleMigration, type CapacityRoleMigrationOutcome } from "../rules/capacity-role-migration.js";
import { FIRST_RULE_ID } from "../rules/rules-write-registry.js";
import { RULE_FORM_CATALOG } from "../rules/rule-form-catalog.js";
import { reloadRules } from "../rules/reload.js";
import { createRuleResourceType, ownsRuleAgent, uniqueIssues, type RuleMatch } from "../rules/resource-type.js";
import type { NotifyReason } from "../resources/types.js";
import { decodeAnyAgentKey, decodeQueryAgentKey } from "../rules/agent-key.js";
import type { AgentCapacityRole, RuleRateLimit } from "../agents/admission.js";
import { capacityRoleFor } from "../agents/capacity-role.js";
import { watchPrompts } from "../agents/prompt-watch.js";
import { chooseStartupAnswer } from "../agents/prompt.js";
import { watchBlocked } from "../agents/blocked.js";
import { createEscalator } from "../agents/escalation-loop.js";
import { createManagedSessionEscalationWatcher } from "../agents/managed-session-escalation-watcher.js";
import { createCredentialDeathTracker } from "../agents/login-expired-alert.js";
import { createOpsAlertRouter } from "../agents/ops-alert.js";
import { createCodexDialogSightingsTracker } from "../agents/codex-dialog-sightings.js";
import { startPermissionAnswerWatch, type PermissionAnswerPushFrame, type PermissionAnswerSubscription } from "../agents/permission-answer-watch.js";
import { ruleLizardModeOf as sharedRuleLizardModeOf } from "../agents/permission-answer-loop.js";
import { createApprovalSoundNotifier } from "../agents/approval-sound.js";
import { withIdleDialogDetection } from "../agents/idle-dialog.js";
import { detectTerminalPrefix, hasDesktopDisplay, resolveAttach, attachRefusalMessage, terminalCommand } from "../terminal/open.js";
import { resolvePtyPane, isPaneStillLive } from "../terminal/pty-attach.js";
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
import { createSilentStopCheck } from "../agents/silent-stop.js";
import { createStallRemediator } from "../agents/stall-remediation.js";
import { createPinnedActiveDetector } from "../agents/pinned-active.js";
import { createOwnWriteLedger, DAEMON_WRITER } from "../jira-watch/own-writes.js";
import { respawnComment, respawnResumedComment, resumePreservedComment } from "../agents/respawn.js";
import { createParkedDetector } from "../agents/parked.js";
import { createAbandonedDetector } from "../agents/abandoned.js";
import { prReviewStateNudge } from "../agents/pr-nudge.js";
import { changeNudge, linkedChangeNudge, notifyReasonTag } from "../agents/change-nudge.js";
import { speakOnOwnChannel, createOwnChannelComments } from "../tools/speak.js";
import { createCrashLoopDetector } from "../agents/crash-loop.js";
import { createRestoredPaneEscalationDetector } from "../agents/restored-pane-escalation.js";
import { createReconcileFailureDetector } from "../agents/reconcile-failure.js";
import { createReaper } from "../agents/reap.js";
import { createAdmissionController } from "../agents/admission.js";
import { createGithubIssueClient } from "../resources/github-issue.js";
import { githubIssueStaffing, type GithubIssueMatch } from "../rules/github-issue-type.js";
import type { GithubIssueRef } from "../resources/github-issue-ref.js";
import { forJiraCallers, githubIssueTools } from "../tools/github-issue.js";
import { restrictJiraProjectManagers } from "../tools/jira-project-scope.js";
import { GITHUB_ISSUE_POLL_MS, startGithubIssueLoop } from "./github-issue-loop.js";
import { createGithubPrClient } from "../resources/github-pr.js";
import { githubPrStaffing } from "../rules/github-pr-type.js";
import { githubPrTools } from "../tools/github-pr.js";
import { GITHUB_PR_POLL_MS, startGithubPrLoop } from "./github-pr-loop.js";
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
import { sessionArchiveDir } from "../resources/session-archive.js";
import { buildQueryAgentInventory, ruleHasLiveAgent } from "../agents/query-agent-inventory.js";
import { listFilesystemResources } from "../resources/filesystem.js";
import { sessionFreezeTools } from "../tools/session-freeze-tools.js";
import { legacyAgentPreflight } from "./legacy-preflight.js";
import { missingRulesPreflight } from "./missing-rules-preflight.js";
import { loadRocketChatAuth, createRocketChatClient, createRocketChatPoster } from "../resources/rocketchat.js";
import { createAccountManager, createFileAccountStore } from "../accounts/manager.js";
import { rcUsernameFor } from "../accounts/identity.js";
import { createFileNexusManifestPublisher } from "../accounts/nexus-manifest.js";
import { createAccountLifecycle } from "../agents/account-lifecycle.js";
import { createAccountOrphanSweep } from "../agents/account-orphan-sweep.js";
import { runLinkCli } from "../cli/link-cli.js";
import { runSessionCli } from "../cli/session-cli.js";
import { runRulesCli } from "../cli/rules-cli.js";
import { resourceLinkTools } from "../tools/resource-links.js";
import { createLinkStore, defaultLinksStorePath } from "../resources/link-store.js";
import { createRoutingLinkStore } from "../resources/link-store-router.js";
import { createJiraProjectLinkStore } from "../resources/jira-project-link-store.js";
import { createRulesPreviewer } from "../web/rules-preview.js";
import { isSameUidPeerAsync } from "../web/peer-uid.js";
import { rulesEtag } from "../rules/write-rules.js";
import { createCsrfTokenIssuer } from "../web/csrf.js";
import { createWriteRateLimiter } from "../web/write-rate-limit.js";
import { createAuditLogger, fileAuditAppend, WEB_WRITE_AUDIT_LOG_BASENAME } from "../web/audit-log.js";
import { writeRuleEnabled, writeRuleFields, writeUndo, writeRuleDelete, planRuleWrite, createScopeCache } from "../rules/rules-write.js";
import { buildSettingsApiResponse } from "../web/settings-api.js";
import { readUnitHint } from "../web/settings-unit-hint.js";
import { testJiraConnection } from "../web/jira-connection-test.js";
import { loadSettingsFile, effectiveSettingsEnv, settingsFilePath } from "../settings/settings-file.js";
import { writeSetting } from "../settings/write-settings.js";
import { restartDaemon } from "../web/daemon-restart.js";

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

// FACTORY-621: `butchr rules check [file]` — validates a rules file and
// dry-runs its jira-work/jira-idea queries, read-only. Same precedent as
// `link`/`session` immediately above: intercepted before config/rules
// loading so a syntactically-broken rules file can be diagnosed with this
// command even though it would make the daemon itself refuse to start.
if (process.argv[2] === "rules") {
  process.exit(await runRulesCli(process.argv.slice(3)));
}

// BUTCHR-346: installed before anything else in this file ever logs — every
// `log:`/`deps.log` seam below that defaults to or directly calls
// `console.error` resolves that reference at CALL time, so this single
// install covers all of them, including the config-load error path
// immediately below and every closure defined later in this file. See
// `log-sink.ts`'s own doc comment for why this is the sink and why it is
// installed here rather than at any individual call site.
installLogSink();

// FACTORY-665 (epic FACTORY-659, slice S2): `settings.json` is a layer of
// NON-SECRET defaults strictly UNDER the environment for a small allowlist
// of keys (fleet cap, provider order, default model, poll-staleness
// tolerance) — `effectiveSettingsEnv` returns `process.env` unchanged for
// every key an env var already sets, and fills in the settings.json value
// only where the environment left a gap. `settingsFileResult.problems`
// (invalid JSON, wrong owner, a symlink, too-wide a mode, a non-
// allowlisted key, an out-of-range value) is reported LOUDLY — one journal
// line per problem, right here at startup, BEFORE `loadConfig` ever runs —
// and, once `teamAdminNotify` exists further down this file, also raised
// as an ops alert (see that section's own comment for why this can't post
// immediately: the poster isn't built yet this early in the file).
const settingsFileResult = loadSettingsFile(process.env);
for (const problem of settingsFileResult.problems) console.error(`butchr: ${problem}`);
const effectiveEnv = effectiveSettingsEnv(process.env as Record<string, string | undefined>, settingsFileResult.values);
// FACTORY-665 (PR-2) — a fresh install with no Atlassian identity yet must
// not crash at startup: it starts in SETUP MODE instead (serving only
// `/health`, the dashboard shell, and the setup API — see
// `./setup-mode.ts`'s own header) until an operator configures it through
// the dashboard. `resolveEffectiveJiraEnv` is what makes a RESTART after a
// successful setup actually leave setup mode: it fills in site/email/token
// from this daemon's own previously-persisted setup state (the durable
// identity file + the managed token file) for any field `process.env`
// itself leaves unset — env still wins per-field, exactly as before, for
// every operator who sets these by hand. Checked BEFORE `loadConfig`
// itself, which still throws for every OTHER kind of misconfiguration
// exactly as before — this is not a general "never crash" change, only the
// one case setup mode exists for.
const effectiveJiraEnv = resolveEffectiveJiraEnv(effectiveEnv, { onWarn: (line) => console.error(`butchr: ${line}`) });
if (!isAtlassianConfigured(effectiveJiraEnv)) {
  // Setup mode ONLY for a truly fresh install (no site, email, token, identity file or managed token file at all).
  // Any PARTIAL state is a misconfiguration: exit 1 loudly, exactly as before, instead of serving a quiet setup page with nothing polling (agentsafety A2 review item 3).
  const partial = [effectiveJiraEnv.ATLASSIAN_SITE, effectiveJiraEnv.ATLASSIAN_EMAIL, effectiveJiraEnv.ATLASSIAN_TOKEN, effectiveJiraEnv.ATLASSIAN_TOKEN_FILE].some((v) => !!v?.trim());
  if (partial) {
    console.error("butchr: Missing required config: ATLASSIAN_SITE, ATLASSIAN_EMAIL and ATLASSIAN_TOKEN (or ATLASSIAN_TOKEN_FILE) must all be set (partial Atlassian configuration is not setup mode). Inputs counted: ATLASSIAN_SITE/ATLASSIAN_EMAIL/ATLASSIAN_TOKEN/ATLASSIAN_TOKEN_FILE, the identity file written by UI setup (jira-identity.json in the butchr config directory) and the managed token file (secrets/atlassian-token). To start setup over, delete BOTH files.");
    process.exit(1);
  }
  await runSetupModeDaemon();
  // runSetupModeDaemon returns once app.listen() is called; the listening server keeps the process alive, so park here instead of falling through to the real daemon (or exiting).
  await new Promise<never>(() => {});
}

let config;
try {
  config = loadConfig(effectiveJiraEnv, (p) => readFileSync(p, "utf8"));
} catch (e) {
  console.error(`butchr: ${(e as Error).message}`);
  console.error("See .env.example for the required configuration.");
  process.exit(1);
}
if (config.agent) config.agent = inventoryCodexMcp(config.agent, (line) => console.error(`butchr: ${line}`));
if (config.agent) config.agent = inventoryAgyMcp(config.agent, (line) => console.error(`butchr: ${line}`));

// FACTORY-497: an existing systemd drop-in from before this ticket may still
// set BUTCHR_EXTENSION_ORIGINS — say so once rather than silently ignoring it.
{
  const ignoredExtensionOrigins = ignoredExtensionOriginsWarning(process.env as Record<string, string | undefined>);
  if (ignoredExtensionOrigins) console.error(`butchr: ${ignoredExtensionOrigins}`);
}

// FACTORY-339: `resolveUrlToResource`'s own deps — this daemon's configured
// Jira site as a bare, lower-cased HOST (never the full `https://` URL
// `config.atlassian.site` is), and its Zendesk subdomain read directly from
// `ZENDESK_SUBDOMAIN`, the SAME env var `zendesk-ticket.ts` itself reads
// (never routed through `Config`, matching that module's own convention —
// see this ticket's own doc for why Zendesk config isn't centralized there).
const resourceLookupDeps = { jiraHost: new URL(config.atlassian.site).hostname.toLowerCase(), zendeskSubdomain: process.env.ZENDESK_SUBDOMAIN?.trim() || undefined };

// Resource-agent rules (src/rules/rules.ts): the ONLY thing that decides what
// gets staffed. A present rules file with zero enabled rules staffs nothing;
// an absent file means zero rules (there are no built-in defaults), announced
// so an idle daemon is never a mystery.
let missingRulesPath: string | null = null;
// FACTORY-669: at TRUE first run only (see `../rules/seed-first-run.ts`'s own
// doc comment for the exact conditions), seed ONE disabled template rule
// before `loadRules` below ever runs for real, so a fresh install's
// dashboard (FACTORY-663) has something to edit/enable with no hand-edited
// JSON and no restart. Captured here rather than acted on immediately: the
// ops-alert router this seed's own "seeded"/"vanished" outcomes need to post
// through (agentsafety constraint 4) is constructed much later in this same
// file's startup sequence, after the Rocket.Chat credential is resolved —
// the raise happens there, right after that router exists (search
// `firstRunSeedOutcome` below).
const firstRunSeedOutcome: FirstRunSeedOutcome = seedFirstRunRules(process.env as Record<string, string | undefined>);
if (firstRunSeedOutcome.kind === "seeded") {
  console.error(`butchr: first run — seeded ${firstRunSeedOutcome.path} with one disabled template rule (${FIRST_RULE_ID}); edit its query in the dashboard, then enable it (its brief is file-only — edit that in ${firstRunSeedOutcome.path} by hand if you want it)`);
  if (firstRunSeedOutcome.dirPermissionsWarning) console.error(`WARNING: butchr: ${firstRunSeedOutcome.dirPermissionsWarning}`);
} else if (firstRunSeedOutcome.kind === "vanished-established-install") {
  console.error(
    `WARNING: butchr: no rules file at ${firstRunSeedOutcome.path}, but a prior backup (.bak-*) exists in its directory — this looks like an established install whose rules file vanished, not a fresh one, so no template was seeded. Restore it (from a backup, or by hand) and SIGHUP/restart; nothing is staffed until then.`,
  );
} else if (firstRunSeedOutcome.kind === "config-dir-not-empty") {
  console.error(
    `WARNING: butchr: no rules file at ${firstRunSeedOutcome.path}, but its directory already holds other state (beyond what the web setup flow itself writes) — this looks like an established install some other way, not a fresh one, so no template was seeded. Add a rules file (from a backup, or by hand) and SIGHUP/restart; nothing is staffed until then.`,
  );
} else if (firstRunSeedOutcome.kind === "seed-failed") {
  console.error(`WARNING: butchr: first-run seed of ${firstRunSeedOutcome.path} failed, starting with no rules as if the file were simply absent: ${firstRunSeedOutcome.error}`);
}
// FACTORY-810 (implementing FACTORY-754, epic FACTORY-748): runs BEFORE
// `loadRules` below ever reads the file for real, same ordering as the
// first-run seed just above — this migration must see an absent `role` as
// genuinely absent (never the schema's defaulted `"worker"`), which only
// reading the raw text (not `loadRules`'s parsed/defaulted `Rule[]`) can
// tell it. Idempotent and existence-based (see
// `../rules/capacity-role-migration.ts`'s own doc comment): a file with
// nothing to migrate is never touched — no backup, no rewritten mtime — so
// this costs nothing on every subsequent, ordinary startup.
const capacityRoleMigrationOutcome: CapacityRoleMigrationOutcome = runCapacityRoleMigration(process.env as Record<string, string | undefined>);
if (capacityRoleMigrationOutcome.kind === "migrated") {
  console.error(`butchr: upgrade migration — wrote role: "sentinel" onto ${capacityRoleMigrationOutcome.migratedIds.length} jira-work rule(s) that relied on the deleted issue-type capacity exemption (FACTORY-757): ${capacityRoleMigrationOutcome.migratedIds.join(", ")}`);
  for (const entry of capacityRoleMigrationOutcome.plan) {
    if (entry.outcome === "skip" && entry.reason !== "not-jira-work" && entry.reason !== "already-has-role") {
      console.error(`butchr: upgrade migration — left rule ${entry.id} untouched (${entry.reason}${entry.issueTypes ? `: ${entry.issueTypes.join(", ")}` : ""})`);
    }
  }
} else if (capacityRoleMigrationOutcome.kind === "unreadable") {
  console.error(`butchr: upgrade migration — could not read the rules file to check for a capacity-role migration (${capacityRoleMigrationOutcome.error}); proceeding to the normal rules loader, which will report any real problem with it`);
}
const rulesHolder = (() => {
  try {
    const loaded = loadRules(process.env as Record<string, string | undefined>);
    if (loaded.origin === "missing") missingRulesPath = loaded.path;
    const enabled = loaded.rules.filter((r) => r.enabled).map((r) => r.id);
    if (loaded.origin === "missing") console.error(`butchr: no rules file at ${loaded.path}: 0 rules — nothing will be staffed. See the README's "First run" section, and \`butchr rules check\` once you've written one.`);
    else console.error(`butchr: rules from ${loaded.path}: ${enabled.length} enabled${enabled.length ? ` (${enabled.join(", ")})` : " — nothing will be staffed"}`);
    return createRulesHolder(loaded.rules, sourceEtagOf(loaded.text));
  } catch (e) {
    console.error(`butchr: ${(e as Error).message}`);
    process.exit(1);
  }
})();
// FACTORY-657: every consumer below reads through `getRules()` rather than
// closing over a `rules` snapshot — see `RulesHolder`'s own doc comment
// (src/rules/rules.ts) for why this makes a SIGHUP reload (or an
// in-process `reloadRules` call, FACTORY-663) take effect without a
// restart, and what still doesn't (a provider with
// ZERO enabled rules — and so no client/loop at all — at startup still
// needs one to ever begin staffing; see the SIGHUP handler below).
const getRules = rulesHolder.getRules;
// BUTCHR-398: log every sentinel rule at startup, one line each, so an
// operator can see at a glance what is exempt from the fleet agent cap —
// the epic decision's own ask ("log each sentinel rule at startup"). No
// warning for an unflagged rule: `role` defaults to `"worker"`, and that
// default needs no announcement (this task's own ticket: "deliberately NO
// startup warning for rules without a role").
for (const r of getRules()) {
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
 * FACTORY-75 — same rebuilt-every-poll seam as `managedSessionRoles`/
 * `managedSessionAccountPolicies` above, one field over: this poll's
 * eligible definitions' resolved `(model, effort)` pair (`effectiveAgent`,
 * src/resources/session-definition.ts), keyed identically. `resolvedAgentOf`
 * below consults this map for a managed-session id before falling back to
 * `rules`' own `agentPreferences` for a rule-engine id — see that
 * function's own comment for the full shape.
 */
const managedSessionResolvedAgents = new Map<string, { model: string; effort?: AgentEffort }>();
/**
 * DROVR-42/FACTORY-67 — same rebuilt-every-poll seam as `managedSessionRoles`/
 * `managedSessionAccountPolicies` immediately above, one field over: whether
 * an eligible managed-session definition is lizard-mode eligible
 * (`SessionDefinition.lizardMode` — since FACTORY-138, absent now resolves
 * eligible for a `vendor: "claude"` definition; see that field's own doc
 * comment and the fill site, `ManagedSessionResourceDeps.lizardModes`,
 * src/rules/session-definition-type.ts, for the full default and its
 * Codex carve-out). Consulted below by `ruleLizardModeOf`,
 * which `lizardModeLabel` (the permission-answer timer's `eligiblePanes` hook)
 * is built from — see `ManagedSessionResourceDeps.lizardModes`'s own doc
 * comment (src/rules/session-definition-type.ts) for why this is
 * deliberately LIVE rather than persisted-at-spawn the way
 * `permissionMode`/`strictMcpConfig` are (FACTORY-43): this field never
 * reaches the launched process's argv. FACTORY-87: a RULE-launched agent
 * (jira-work/jira-project/github/filesystem, as opposed to a managed
 * session) has no per-file manifest of its own to rebuild a map like this
 * from every poll — its `lizardMode` lives on its own `Rule`
 * (src/rules/rules.ts), which is loaded once at startup, so `ruleLizardModeOf`
 * below reads it straight from the already-loaded `rules` list instead of a
 * second map, the same "rule-level fallback" shape `ruleRoleOfAgent` already
 * uses for `role`.
 */
const managedSessionLizardModes = new Map<string, boolean>();
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
  const rule = getRules().find((r) => r.id === decoded.ruleId && r.resourceProvider === decoded.resourceProvider);
  return rule?.role;
};
/**
 * FACTORY-87 (FACTORY-76, rule-side companion to DROVR-42) — `lizardMode`'s
 * own equivalent of `ruleRoleOfAgent` immediately above: true iff `id`'s
 * agent should be scanned/answered by the permission-answer timer. The
 * actual decision (`ruleLizardModeOf`, `src/agents/permission-answer-loop.ts`)
 * is a pure, importable function — extracted there (PR #478 review) so it
 * has its own unit tests independent of this module, which has no exports
 * and cannot itself be imported by a test without running the whole
 * daemon's startup side effects. This is just the daemon's own binding of
 * that decision to its own live state (`rules`, `managedSessionLizardModes`,
 * `ownsManagedSessionAgent`) — see `RuleLizardModeDeps`'s own doc comment for
 * what each input means and why a managed session needs the live map while
 * every other rule-launched agent reads straight off its own `Rule`.
 */
const ruleLizardModeOf = (id: string): boolean =>
  sharedRuleLizardModeOf(id, { rules: getRules(), isManagedSessionAgent: ownsManagedSessionAgent, managedSessionLizardModes });
// FACTORY-757 (supersedes BUTCHR-422/FACTORY-39's issue-type hardcoding):
// capacity is decided solely by each rule's own `role` field — see
// src/agents/capacity-role.ts for the construction-level exceptions (bare
// project agents, `jira-project` agents) and why issue type no longer plays
// any part here.
const roleOfAgent = (id: string): AgentCapacityRole => capacityRoleFor(id, ruleRoleOfAgent);
/**
 * FACTORY-907 — same decode-then-look-up-by-rule shape as `ruleRoleOfAgent`
 * immediately above, one field over: resolves a candidate id's own rule
 * `maxNewPerTick`/`minSecondsBetweenAdmissions` (if either is set) for
 * `AdmissionControllerDeps.rateLimitOf` (src/agents/admission.ts). `undefined`
 * for anything unresolved (a legacy/bare-issue agent, a rule since removed,
 * or a resolvable rule that sets neither field) — unlike `roleOfAgent`,
 * there is no fail-safe-to-limited default to get wrong here: an id this
 * cannot resolve simply keeps today's behaviour, same as a resolved rule
 * that never sets either field (see `RuleRateLimit`'s own doc comment).
 * BUTCHR-408's managed-session agents have no rule-engine `Rule` of their
 * own (see `managedSessionRoles`'s own comment above) and so are never
 * rate-limited by this — out of this ticket's scope, which wires exactly
 * the rule-engine providers `maxNewPerTick`/`minSecondsBetweenAdmissions`
 * validate for.
 */
const rateLimitOfAgent = (id: string): RuleRateLimit | undefined => {
  const decoded = decodeAnyAgentKey(id);
  if (!decoded) return undefined;
  const rule = getRules().find((r) => r.id === decoded.ruleId && r.resourceProvider === decoded.resourceProvider);
  if (!rule || (rule.maxNewPerTick === undefined && rule.minSecondsBetweenAdmissions === undefined)) return undefined;
  return {
    ruleId: rule.id,
    ...(rule.maxNewPerTick !== undefined ? { maxNewPerTick: rule.maxNewPerTick } : {}),
    ...(rule.minSecondsBetweenAdmissions !== undefined ? { minSecondsBetweenAdmissions: rule.minSecondsBetweenAdmissions } : {}),
  };
};

// BUTCHR-405: logged once per unresolved reference at startup, from this
// boot's own rules. /health (see combineHealth call below) recomputes this
// fresh from `getRules()` on every request instead of reusing this one-time
// list — FACTORY-657: a reload can fix (or introduce) an unresolved
// relationship, and /health must never keep reporting this boot's stale
// verdict after one.
for (const u of unresolvedRelationships(getRules())) console.error(`  ${formatUnresolvedRelationshipWarning(u)}`);

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
  const rule = getRules().find((r) => r.id === decoded.ruleId && r.resourceProvider === decoded.resourceProvider);
  return rule?.mcpServers;
};

/**
 * FACTORY-75 — `HerdrHerd.staleIssues()`'s own `resolvedAgentOf` seam (see
 * that constructor param's doc comment, src/agents/herd.ts): this issue's
 * CURRENTLY resolved `(model, effort)` pair for the given provider, from
 * the two-axis `modelPower`/`effort` mechanism (src/resources/power-scale.ts).
 * Same decode-then-look-up-by-ruleId shape as `mcpBindingsOf` immediately
 * above, for the SAME reason (HerdrHerd holds no rule state of its own) —
 * a managed-session id is checked FIRST against `managedSessionResolvedAgents`
 * (rebuilt every managed-sessions poll from that poll's eligible
 * definitions — see that map's own comment above), since a managed-session
 * definition has no entry in `rules` at all; a rule-engine id then falls
 * through to that rule's own `agentPreferences` entry for this provider —
 * ALREADY resolved at `loadRules()` time (`AgentPreference`'s own doc
 * comment, src/rules/rules.ts), so this is a plain lookup, not a second
 * resolution. `undefined` for anything neither map/lookup can answer — the
 * same "nothing to compare, so nothing reads stale" fail-safe `mcpBindingsOf`
 * already has.
 */
const resolvedAgentOf = (id: string, provider: string): { model?: string; effort?: AgentEffort } | undefined => {
  if (ownsManagedSessionAgent(id)) return managedSessionResolvedAgents.get(id);
  const decoded = decodeAnyAgentKey(id);
  if (!decoded) return undefined;
  const rule = getRules().find((r) => r.id === decoded.ruleId && r.resourceProvider === decoded.resourceProvider);
  const preference = rule?.agentPreferences?.find((p) => p.harness === provider);
  return preference ? { ...(preference.model !== undefined ? { model: preference.model } : {}), ...(preference.effort !== undefined ? { effort: preference.effort } : {}) } : undefined;
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
  const rule = getRules().find((r) => r.id === decoded.ruleId && r.resourceProvider === decoded.resourceProvider);
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
const githubStaffing = githubIssueStaffing(getRules(), config.github);
const githubIssues = githubStaffing.run && config.github
  ? createGithubIssueClient({ fetchImpl: fetch, token: config.github.token, orgs: config.github.orgs, log: (line) => console.error(`  ${line}`) })
  : undefined;

// github-pr rules share the SAME token/org config as github-issue (see
// Config["github"]'s own doc comment) but are their own provider, staffing
// gate, client and loop — a rules file with github-issue rules and no
// github-pr rules stays unaffected, and vice versa.
const githubPrStaffingResult = githubPrStaffing(getRules(), config.github);
const githubPrs = githubPrStaffingResult.run && config.github
  ? createGithubPrClient({ fetchImpl: fetch, token: config.github.token, orgs: config.github.orgs, log: (line) => console.error(`  ${line}`) })
  : undefined;

// zendesk-ticket rules run only with ZENDESK_SUBDOMAIN and an owner-only
// ZENDESK_OAUTH_TOKEN_FILE; otherwise none of them runs and nothing is spawned
// for one (announced by startZendeskTicketLoop). The token file is read only
// when an enabled zendesk-ticket rule exists.
const zendeskStaffing = zendeskTicketStaffing(getRules(), process.env as Record<string, string | undefined>);
const zendeskTickets = zendeskStaffing.run
  ? createZendeskTicketClient({ fetchImpl: fetch, subdomain: zendeskStaffing.subdomain, token: zendeskStaffing.token, log: (line) => console.error(`  ${line}`) })
  : undefined;

// filesystem rules need no external credential — every enabled one always
// runs, reading the local disk directly (src/resources/filesystem.ts).
const fsRules = filesystemRules(getRules());

const atlassian = new AtlassianClient(config.atlassian.site, config.atlassian.email, config.atlassian.token, undefined, (line) => console.error(`  ${line}`));
// jira-idea rules share this Jira client but are their own provider: their
// own loop, agents, MCP identity and read/comment tools (src/tools/jira-idea.ts).
const ideaRules = jiraIdeaRules(getRules());
const jiraIdeas = ideaRules.length ? createJiraIdeaClient(atlassian) : undefined;
// Label writes must never silently 403: Jira only honours notifyUsers=false
// for an account holding Administer Jira/Projects on the ticket's project.
// This gate preflights that per project (first sight, cached for the run)
// and falls back to notifying writes — loudly, once — when it's absent.
// Shared between the poll loop and the one-time startup sweep below so both
// see the same cached verdict per project.
const labelWriter = createNotifyGate({ jira: atlassian, account: config.atlassian.email, log: (line) => console.error(`  ${line}`) });
// FACTORY-722: `timeoutMs` bounds EVERY call this shared client makes
// (`@brooswit/herdr-sdk`'s `rpc()` arms its timer around the whole
// connect-write-respond sequence, not merely the read) — see
// `Config.herdrCallTimeoutMs`'s own doc comment for why this one knob is the
// actual fix for the wedge finding this ticket closes, not a defensive
// extra: before this, a hung herdr socket left `herdr.agent.list()` and
// `herdr.subscribe()` pending forever, wedging every caller that serializes
// on one of them.
const herdr = new DrovrClient({ ...(config.herdrSocket ? { socketPath: config.herdrSocket } : {}), timeoutMs: config.herdrCallTimeoutMs });
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
const herd = new HerdrHerd(herdr, `http://localhost:${config.port}/mcp`, undefined, (line) => console.error(`  ${line}`), config.agent, undefined, undefined, undefined, mcpBindingsOf, accountNameOf, resolvedAgentOf);
// FACTORY-95 (implementing FACTORY-90, epic FACTORY-83): relabel every
// currently-running, butchr-owned herdr workspace to its short display label
// on every daemon startup — no agent restart. Idempotent (see
// `relabelOwnedWorkspaces`'s own doc comment, src/agents/herd.ts), so running
// it again on the next restart is exactly as safe as running it here once.
// Fire-and-forget: a slow or failing herdr must never delay the rest of
// startup, and the method itself never throws.
void herd.relabelOwnedWorkspaces();
// FACTORY-714/FACTORY-713/FACTORY-704 (re-aimed) — report each already-
// running pane's persisted Claude session id to herdr, once per daemon
// startup, for whichever panes herdr doesn't already hold an
// `agent_session` for (see `reportPersistedAgentSessions`'s own doc
// comment, src/agents/report-agent-sessions.ts, for why this is the real
// fix — not the abandoned settle-gate approach — and why it is safe to run
// on every startup). Same fire-and-forget, idempotent-startup-sweep shape
// as `relabelOwnedWorkspaces` immediately above: a slow or failing herdr
// must never delay the rest of startup, and the function itself never
// throws (per-pane failures are swallowed and logged inside it).
void reportPersistedAgentSessions({ herdr, log: (line) => console.error(`  ${line}`) });
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
const ADMISSION_SOURCE_GITHUB_PR = "github-pr";
const ADMISSION_SOURCE_JIRA_IDEA = "jira-idea";
const ADMISSION_SOURCE_ZENDESK_TICKET = "zendesk-ticket";
// BUTCHR-425: jira-project agents always classify as sentinels (see
// src/agents/capacity-role.ts), so this bucket never withholds anything —
// it exists only so the admission census can report on this tier by name,
// the same reason every other provider gets its own named source.
const ADMISSION_SOURCE_JIRA_PROJECT = "jira-project";
const jiraProjectEnabled = getRules().some((r) => r.enabled && r.resourceProvider === "jira-project");
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
  // FACTORY-907: see `rateLimitOfAgent`'s own doc comment above.
  rateLimitOf: rateLimitOfAgent,
  log: (line) => console.error(`  ${line}`),
  now: () => Date.now(),
  sources: [ADMISSION_SOURCE_ISSUE, ...(githubIssues ? [ADMISSION_SOURCE_GITHUB_ISSUE] : []), ...(githubPrs ? [ADMISSION_SOURCE_GITHUB_PR] : []), ...(jiraIdeas ? [ADMISSION_SOURCE_JIRA_IDEA] : []), ...(zendeskTickets ? [ADMISSION_SOURCE_ZENDESK_TICKET] : []), ...(jiraProjectEnabled ? [ADMISSION_SOURCE_JIRA_PROJECT] : []), ...(fsRules.length ? [ADMISSION_SOURCE_FILESYSTEM] : []), ADMISSION_SOURCE_MANAGED_SESSIONS],
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
  const rule = getRules().find((r) => r.id === query.ruleId && r.resourceProvider === query.resourceProvider);
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
const githubPrHealth = createResourceLoopHealth({
  name: "github-pr",
  enabled: Boolean(githubPrs),
  ...(githubPrStaffingResult.run ? {} : { disabledReason: githubPrStaffingResult.reason ?? "no enabled github-pr rules" }),
  thresholdMs: Math.max(config.pollStaleMs, 3 * GITHUB_PR_POLL_MS),
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

// FACTORY-647: resolved ONCE — the real production resolution
// (src/web/static-assets.ts), read both by the startup check right below and
// by `/health`'s `dashboardApp` field (see `health` in `buildApp(...)`
// below) — never two independent resolutions that could disagree.
const dashboardAppRoot = resolveWebRoot();

const resourceConnections = new ResourceConnections(`http://127.0.0.1:${config.port}`, herd, (line) => console.error(line));

// FACTORY-660: `GET /api/rules/:id/preview`'s own dry-run — one shared
// instance (not rebuilt per request) so its per-rule rate-limit map
// actually accumulates across requests. Reuses THIS daemon's own LIVE
// `getRules` (review round 2, R2: a function, read fresh every call — see
// `RulesPreviewDeps.rules`'s own doc comment — never a startup snapshot, so
// a reload takes effect on the very next preview) and the SAME
// `atlassian.searchAll` capability the poll loops themselves call — the
// ONLY Jira capability it is ever given.
const rulesPreviewer = createRulesPreviewer({ rules: getRules, search: (jql) => atlassian.searchAll(jql), maxAgents: config.maxAgents });

// FACTORY-662: this process's one CSRF token (`GET /api/session` hands it
// out; every write route checks it) — minted once, here, never per-request
// and never persisted (see `../web/csrf.ts`'s own header).
const csrfIssuer = createCsrfTokenIssuer();

// N2 (FACTORY-678): ONE shared per-client write-flood limiter instance —
// same discipline as `rulesPreviewer`/`scopeOf` above — covering all four
// write-shaped routes (`../web/view.ts` wires this same instance into
// each), at its own real default window/cap (`../web/write-rate-limit.ts`).
const writeRateLimit = createWriteRateLimiter();

// FACTORY-664: a SEPARATE, tighter limiter for `POST /api/settings/jira/test`
// (1 per 5s, per the ticket's own spec) — this route makes a real outbound
// credentialed call, so it does not share the generic write budget above.
const jiraTestRateLimit = createWriteRateLimiter({ windowMs: 5_000, max: 1 });

// FACTORY-665: `POST /api/daemon/restart`'s own limiter — 1 per 10 minutes,
// per the ticket's own spec. Keyed by a single fixed string (not per-client
// like `writeRateLimit`/`jiraTestRateLimit` above): restarting butchr once
// already affects every client, so there is no meaningful per-client budget
// to track separately.
const daemonRestartRateLimitInstance = createWriteRateLimiter({ windowMs: 10 * 60_000, max: 1 });
const daemonRestartRateLimit = () => daemonRestartRateLimitInstance("daemon-restart");
// FACTORY-665 (PR-2): `PUT /api/settings/jira/token` (rotation) gets its own
// setup-code manager — this daemon is already configured, so no code is
// minted at startup (there is nothing to onboard); an operator mints one
// on demand via `SIGUSR2` whenever they actually want to rotate the token
// (same handler setup mode installs — see `../setup/setup-code.ts`'s own
// header for why this exists in BOTH modes, not just the unconfigured one).
const jiraTokenRotateCodeManager = createSetupCodeManager();
installSetupCodeSigusr2Handler(jiraTokenRotateCodeManager, (line) => console.error(line));
// Same two-budget shape setup mode uses for the identical reason — see
// `ViewDeps.jiraTokenTestRateLimit`/`jiraTokenWriteRateLimit`'s own doc
// comments (`../web/view.ts`).
const jiraTokenTestRateLimit = createWriteRateLimiter({ windowMs: 10 * 60_000, max: 5 });
const jiraTokenWriteRateLimit = createWriteRateLimiter({ windowMs: 60 * 60_000, max: 3 });

// FACTORY-662 item 4/7: one JSON-lines audit file, next to the rules file
// itself (same directory FACTORY-658's own backups live in) — every
// accepted/rejected write appends one line here AND raises a non-deduped
// alert through the SAME Rocket.Chat poster the managed-session escalator
// and ops-alert router already share (`teamAdminNotify`, defined further
// down this file) — referenced here only inside a closure not called until
// an actual write happens, well after `teamAdminNotify` is initialized; see
// `ptyAttach.read`'s own comment just below in this file for the identical,
// already-established pattern.
const auditLogPath = join(dirname(rulesPath()), WEB_WRITE_AUDIT_LOG_BASENAME);
// B4 (agentsafety second pass): ONE logger instance, not rebuilt per call —
// its rejected-write aggregation (`createAuditLogger`'s own header) only
// works if the SAME instance sees every write.
const auditWrite = createAuditLogger({
  append: fileAuditAppend(auditLogPath),
  // Deferred to CALL time (not evaluated here) — `teamAdminNotify` is
  // declared further down this file; this closure isn't invoked until an
  // actual write happens, well after it's initialized. Same pattern as
  // `ptyAttach.read`'s own comment elsewhere in this file.
  postAlert: (text: string) => (teamAdminNotify ? teamAdminNotify(config.opsAlert.room, text) : Promise.resolve()),
  host: hostname(),
  log: (line) => console.error(line),
});

// FACTORY-662's own rules-write orchestration (`../rules/rules-write.ts`),
// bound to THIS daemon's env/config. `reload` calls the REAL
// `reloadRules(rulesHolder)` (FACTORY-657, merged) — the SAME function
// `SIGHUP` already calls below, so a web write's reload and a SIGHUP's
// reload can never drift: every consumer reading through `getRules()`
// (the whole daemon, after FACTORY-657) sees the swap on its very next
// poll, no restart needed (B5a, agentsafety second pass: the previous
// version left this a stub — a UI write reported `reload:{"applied":true}`
// while the holder kept the OLD query). `scopeOf` reuses the SAME
// previewer `GET /api/rules/:id/preview` already shares — never a second
// Jira query mechanism — and fails safe (treats a failed/unavailable
// preview as an unbounded scope, which forces the confirm gate rather than
// silently skipping it). N1 (FACTORY-678): wrapped in `createScopeCache`
// (`../rules/rules-write.ts`) — ONE shared 10s-TTL cache, so `planRuleWrite`
// and `writeRuleEnabled` calling this for the SAME rule id moments apart
// (a UI's normal plan-then-apply flow) share one real previewer call
// instead of the second one being refused by the previewer's own 2s
// per-rule rate limit (which previously fell through to the
// `Number.POSITIVE_INFINITY` fail-safe below, tripping the scope ceiling
// on every back-to-back apply).
const scopeOf = createScopeCache(async (id: string, queryOverride: string): Promise<number> => {
  const result = await rulesPreviewer(id, queryOverride);
  return result.ok ? result.total : Number.POSITIVE_INFINITY;
});
const rulesWriteDeps = {
  env: process.env,
  reload: () => {
    const result = reloadRules(rulesHolder);
    // FACTORY-685 (N4): every successful write already calls this via
    // `toOutcome` — clearing the scope cache here, unconditionally, means a
    // cached scope reading can never outlive the write (or SIGHUP, or the
    // `reloadRulesNow` HTTP route below, which clear it the same way) that
    // may have invalidated it.
    scopeOf.clear();
    return { applied: result.ok, problems: result.problems };
  },
  // STALE-FILE REFUSAL (agentsafety second pass): the daemon's own
  // currently-loaded rules etag — see `RulesWriteDeps.getSourceEtag`'s own
  // doc comment (`../rules/rules-write.ts`) for the incident this closes.
  getSourceEtag: () => rulesHolder.getSourceEtag(),
};

const { app, mcp } = buildApp({
  getRules,
  getRulesSourceEtag: () => rulesHolder.getSourceEtag(),
  reloadRulesNow: () => {
    const result = reloadRules(rulesHolder);
    scopeOf.clear(); // FACTORY-685 (N4) — see `rulesWriteDeps.reload`'s own comment above.
    return result;
  },
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
    Bun.spawn(terminalCommand(terminalPrefix, pane), { stdio: ["ignore", "ignore", "ignore"] });
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
    const hasDisplay = hasDesktopDisplay(process.env);
    const decision = resolveAttach(pane, livePanes, terminalPrefix ?? null, hasDisplay);
    if (!decision.ok) return { ok: false, error: attachRefusalMessage(decision.refusal) };
    Bun.spawn(decision.argv, { stdio: ["ignore", "ignore", "ignore"] });
    return { ok: true };
  },
  // FACTORY-772: `issueLoopWatchdog` is assigned further below (after the
  // issue loop itself is started — see that call site's own comment for
  // why), but this closure only runs lazily per `/health` request, by which
  // point module-load has long finished and the forward reference has
  // resolved — same reasoning as every other health-sibling source here.
  // FACTORY-752 (FACTORY-746 (c)): `permissionAnswerHealth` (assigned further
  // below, near `PERMISSION_ANSWER_INTERVAL_MS`) joins `loopHealth`/
  // `notifyHealth` IN `components[]` — not the `resourceLoops[]` list below —
  // see `createTickHealth`'s own doc comment (src/daemon/health.ts) for why.
  health: () => combineHealth([loopHealth, notifyHealth, permissionAnswerHealth], toBuildReport(buildIdentity), coverage.snapshot(), admissionController.snapshot(), currency.snapshot(), [githubIssueHealth, githubPrHealth, jiraIdeaHealth, zendeskTicketHealth, jiraProjectHealth, filesystemHealth, managedSessionsHealth], unresolvedRelationships(getRules()), escalator.managedSessionEscalations(), credentialDeathTracker.current(), codexDialogSightings.sightings(), dashboardAppStatus(dashboardAppRoot), issueLoopWatchdog.reports(), commentChecksSkipped),
  // BUTCHR-269: NO I/O here — reads the snapshot the `agentStatuses` tee
  // (below, inside `createLabelSync`'s deps) last stored, fed by the issue
  // loop's own 15s poll. See src/agents/dashboard.ts's header and BUTCHR-263
  // for why a request-time fetch is the wrong pattern here even though it's
  // what `state` above does.
  dashboard: async () => dashboardFeed.snapshot(),
  // FACTORY-72: every configured rule and managed-session definition,
  // staffed or not — see src/agents/query-agent-inventory.ts's own top
  // comment for the reuse this is built from. `rulesFile`/`configReasonFor`
  // are this daemon's own already-computed values (loaded/decided once at
  // startup above), never a second load or a second staffing decision.
  configInventory: () =>
    buildQueryAgentInventory({
      rulesFile: { path: rulesPath(), rules: getRules(), error: null },
      dashboard: dashboardFeed.snapshot(),
      configReasonFor: (rule) => {
        if (rule.resourceProvider === "github-issue" && !githubStaffing.run && githubStaffing.rules.some((r) => r.id === rule.id)) return githubStaffing.reason;
        if (rule.resourceProvider === "github-pr" && !githubPrStaffingResult.run && githubPrStaffingResult.rules.some((r) => r.id === rule.id)) return githubPrStaffingResult.reason;
        if (rule.resourceProvider === "zendesk-ticket" && !zendeskStaffing.run && zendeskStaffing.rules.some((r) => r.id === rule.id)) return zendeskStaffing.reason;
        return null;
      },
      sessionDefinitions: {
        activeDir: sessionDefinitionsPath(),
        archiveDir: sessionArchiveDir(),
        store: defaultSessionFreezeIo().store,
      },
    }),
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
  // FACTORY-339: NO I/O here, same discipline as `dashboard` above —
  // `dashboardFeed.snapshot()` is the SAME already-polled staffed-agent
  // registry `/dashboard` itself serves, never a second poll or a live
  // per-request query (see `../resources/resource-lookup.ts`'s own header
  // for why re-running each rule's query here would be wrong).
  resourcesForUrl: async (url) => buildResourcesForUrlResponse(url, resourceLookupDeps, dashboardFeed.snapshot().rows),
  extensionAuth: config.extensionAuth,
  // FACTORY-453 (implementing FACTORY-337, epic FACTORY-330):
  // `GET /agents/:agentKey/pty`'s deps. `resolve`/`isLive` read the SAME
  // `dashboardFeed.snapshot()` `resourcesForUrl` above already reads — no
  // new poll, no new I/O, same discipline as every other route in this
  // object. `read`/`send` are this daemon's own existing pane helpers
  // (defined below, already used by the detector loops). `pollMs` (250ms)
  // is this daemon's own choice, not herdr's — see `docs/pty-attach.md`'s
  // Config section for why: fast enough to feel interactive for a person
  // typing, far above herdr's own per-call cost to matter as load.
  ptyAttach: {
    resolve: (agentKey) => resolvePtyPane(agentKey, dashboardFeed.snapshot().rows),
    isLive: (agentKey, pane) => isPaneStillLive(agentKey, pane, dashboardFeed.snapshot().rows),
    // Wrapped rather than passed directly: `readPaneForPty`/`sendPane` are
    // declared further down this file, and `buildApp(...)` runs at
    // module-evaluation time — a direct reference here would be a TDZ
    // error. These closures aren't evaluated until a socket actually calls
    // them, by which point the module has finished loading. `read` is
    // `readPaneForPty`, NOT the detectors' `readPane` — see that function's
    // own doc comment for why (ANSI must survive for a real terminal).
    read: (pane) => readPaneForPty(pane),
    send: (pane, text) => sendPane(pane, text),
    pollMs: 250,
  },
  // FACTORY-660: the rules page's own Origin/Host guard — this daemon's own
  // loopback origin at its own port, never a configurable allowlist (see
  // src/web/dashboard-origin-guard.ts's own header).
  dashboardOriginGuard: { port: config.port },
  // FACTORY-660 (SPEC CHANGE (c); PR #642 review round 2, G2/G3): same-UID
  // peer check for BOTH `GET /api/rules` and `GET /api/rules/:id/preview`
  // — `client` (address+port) is read in src/web/view.ts from
  // `server.requestIP(request)`; this daemon's own listening address+port
  // (`DAEMON_HOSTNAME`/`config.port`) is the other half of the FULL socket
  // 4-tuple `peer-uid.ts` looks up in `/proc/net/tcp`(6) (G3: matching on
  // port alone is not a unique socket identity). FACTORY-662 (write path)
  // builds its own equivalent closure from the SAME `isSameUidPeer` helper,
  // over the SAME `{ address: DAEMON_HOSTNAME, port: config.port }`.
  peerUidCheck: (client) => isSameUidPeerAsync(client, { server: { address: DAEMON_HOSTNAME, port: config.port } }),
  // FACTORY-660: `GET /api/rules`' own data — SAME discipline as
  // `configInventory` above: `rules: getRules()`/`error: null` are this
  // daemon's own already-loaded, already-validated LIVE values (review
  // round 2, R2 — read fresh, through the holder, never a startup-only
  // array; an invalid file would have kept this daemon from starting at
  // all, so `error` here is always `null`), never a second parse. `mtime`
  // and `fileEtag` (review round 1, note (b); review round 2, G1:
  // `rulesEtag()`, FACTORY-658, FACTORY-662's F7 requirement) are the real
  // per-request I/O this route needs (the file's own current bytes/mtime),
  // accepted for the same reason `configInventory` above accepts its own
  // session-definition-listing I/O: a distinct, infrequently-hit route,
  // never on `/`'s or `/dashboard`'s own request path. `getRulesSourceEtag()`
  // (passed to `buildApp` above) is read fresh too, by this route itself —
  // that gap between it and this call's own `fileEtag` is exactly what
  // `stale` reports.
  // FACTORY-729: `GET /api/rules/catalog`'s own data — pure constants, no I/O.
  rulesCatalog: () => RULE_FORM_CATALOG,
  rulesFileState: async () => {
    let mtime: string | null = null;
    try {
      mtime = (await stat(rulesPath())).mtime.toISOString();
    } catch {
      mtime = null;
    }
    return { path: rulesPath(), rules: getRules(), error: null, mtime, fileEtag: rulesEtag() };
  },
  rulesPreview: (id, queryOverride) => rulesPreviewer(id, queryOverride),
  // FACTORY-662: the write path's own deps — see the comments just above
  // `rulesWriteDeps`'s own declaration for why `reload` is a stub and
  // `scopeOf` reuses `rulesPreviewer`.
  csrf: csrfIssuer,
  writeGuard: { dashboardOriginGuard: { port: config.port }, peerUidCheck: (client) => isSameUidPeerAsync(client, { server: { address: DAEMON_HOSTNAME, port: config.port } }), csrf: csrfIssuer },
  rulesWrite: {
    enabled: (id, enabled, ifMatch, confirm, planHash) => writeRuleEnabled(id, enabled, ifMatch, confirm, planHash, scopeOf, rulesWriteDeps),
    fields: (id, patch, ifMatch, confirm, planHash) => writeRuleFields(id, patch, ifMatch, confirm, planHash, scopeOf, rulesWriteDeps),
    undo: (backupId) => writeUndo(backupId, rulesWriteDeps),
    plan: (id, patch, confirm) => planRuleWrite(id, patch, confirm, scopeOf, rulesWriteDeps),
    // FACTORY-731: `hasLiveAgents` reads the SAME poll-fed
    // `dashboardFeed.snapshot().rows` every other "is this rule staffed"
    // check in this daemon already reads (`ruleHasLiveAgent`'s own doc
    // comment, `../agents/query-agent-inventory.ts`, names the exact race
    // this accepts) — never a fresh census of its own.
    delete: (id, ifMatch, confirm) => writeRuleDelete(id, ifMatch, confirm, (ruleId) => ruleHasLiveAgent(ruleId, dashboardFeed.snapshot().rows), rulesWriteDeps),
  },
  auditWrite,
  writeRateLimit,
  // FACTORY-664 (epic FACTORY-659, slice S1, READ-ONLY): `GET /api/settings`'s
  // own data — read fresh every request (one `fs.stat` plus a best-effort
  // `systemctl --user show` call), never a startup snapshot, same discipline
  // as `rulesFileState` above.
  // FACTORY-665: `effectiveEnv` (settings.json layered under `process.env`,
  // computed once at startup above) is what this daemon ACTUALLY runs
  // with; `process.env` itself (unmerged) and the settings.json values it
  // was built from are passed through too, so `buildSettingEntries` can
  // report `source: "environment" | "file" | "default"` correctly for
  // every allowlisted key — see that function's own doc comment.
  settings: () => buildSettingsApiResponse(effectiveEnv, { unitHint: () => readUnitHint(), rawEnv: process.env as Record<string, string | undefined>, settingsFileValues: settingsFileResult.values }),
  // FACTORY-664: `POST /api/settings/jira/test` — calls Atlassian with THIS
  // daemon's own already-loaded credentials, never anything from the
  // request itself.
  jiraTest: () => testJiraConnection(config.atlassian),
  jiraTestRateLimit,
  // FACTORY-665: `PUT /api/settings/:key` — writes through
  // `writeSetting` (`../settings/write-settings.ts`), then re-reads the
  // SAME effective response `GET /api/settings` would serve (process.env
  // itself is unaffected by a settings.json write — only a restart picks
  // up the new value, hence `restartNeeded: true` on every allowlisted
  // key — but the just-written settings.json value is still worth
  // reflecting back immediately as `source: "file"`, so the UI's "restart
  // needed" badge has an accurate current/pending value to show it against).
  settingsWrite: async (key, value, confirm) => {
    writeSetting(key, value, confirm);
    const fresh = loadSettingsFile(process.env);
    return buildSettingsApiResponse(effectiveSettingsEnv(process.env as Record<string, string | undefined>, fresh.values), { unitHint: () => readUnitHint(), rawEnv: process.env as Record<string, string | undefined>, settingsFileValues: fresh.values });
  },
  // FACTORY-665: `POST /api/daemon/restart` — fixed-argv `systemctl --user
  // restart butchr.service`, ONLY when this daemon is actually running
  // under that unit (see `../web/daemon-restart.ts`'s own header).
  daemonRestart: () => restartDaemon(),
  daemonRestartRateLimit,
  // FACTORY-665 (PR-2): this daemon is already configured, so `GET
  // /api/setup/status` always reports `configured: true` here — the
  // dashboard's Setup page never shows once this is wired (setup mode,
  // `./setup-mode.ts`, is the only place `configured: false` is ever
  // returned).
  setupStatus: () => ({ configured: true }),
  // `PUT /api/settings/jira/token` — ROTATION only: site/email are this
  // daemon's own already-loaded `config.atlassian` values (never settable
  // from the request body here — see `ViewDeps.jiraTokenRotate`'s own doc
  // comment), and `requireEnvCheck: true` means an env-provided token
  // (`ATLASSIAN_TOKEN`/`ATLASSIAN_TOKEN_FILE` set) refuses with 409 before
  // the setup code is even checked.
  jiraTokenRotate: (input, rateGate) => handleJiraTokenWrite(
    { site: config.atlassian.site, email: config.atlassian.email, token: input.token, setupCode: input.setupCode },
    { setupCode: jiraTokenRotateCodeManager, path: jiraTokenFilePath(process.env as Record<string, string | undefined>), env: process.env as Record<string, string | undefined> } satisfies JiraWriteDeps,
    { requireEnvCheck: true, ...(rateGate ? { rateGate } : {}) },
  ),
  jiraTokenTestRateLimit,
  jiraTokenWriteRateLimit,
// check_in/stand_down are passed no registries: the rule engine has no
// project tier to check in and no per-agent sleep yet, so both tools run in
// their documented "declares nothing" mode instead of feeding state that no
// loop reads.
}, {
  // Jira/Confluence tools refuse github-issue, github-pr, jira-idea, zendesk-ticket and filesystem agents; each provider's own tools exist only when its rules run.
  // FACTORY-732: a jira-project (manager) caller passes `forJiraCallers`
  // now, but `restrictJiraProjectManagers` immediately confines it to its
  // own project's jira_get_issue/jira_search/jira_add_comment/jira_transition
  // — see src/tools/jira-project-scope.ts.
  ...restrictJiraProjectManagers(forJiraCallers(atlassianTools(ops, undefined, config.assignees, recordOwnWrite, isStaffed)), ops),
  // FACTORY-7/FACTORY-5: registered unconditionally, unlike every
  // provider-specific tool set below it — the local file store needs no
  // credentials and works for every ResourceRef kind, and a `jira-project`
  // owner routes to the project-property-backed store instead (this daemon
  // already has Jira credentials loaded, unlike the CLI, so the factory
  // below is cheap and side-effect-free rather than genuinely lazy) — see
  // `src/resources/link-store-router.ts` for the routing decision itself.
  // FACTORY-732: a jira-project (manager) CALLER (not the `resource` a link
  // names — the resource-link test fixtures above a jira-project OWNER as
  // an argument, which this gate never touches) has no allowlisted name
  // here (add_link/remove_link/list_links are all outside
  // JIRA_PROJECT_MANAGER_TOOLS), so it is refused on every one of these.
  ...restrictJiraProjectManagers(
    resourceLinkTools(
      routingLinkStore,
      (line) => console.error(line),
    ),
    ops,
  ),
  ...(githubIssues ? githubIssueTools({ client: githubIssues, onWrite: (resource, updated, writer) => ownWrites.record(resource, updated, writer, Date.now()) }) : {}),
  ...(githubPrs ? githubPrTools({ client: githubPrs, onWrite: (resource, updated, writer) => ownWrites.record(resource, updated, writer, Date.now()) }) : {}),
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
  // FACTORY-732: freeze_session is not in JIRA_PROJECT_MANAGER_TOOLS, so a jira-project (manager) caller is refused here too.
  ...restrictJiraProjectManagers(
    sessionFreezeTools({ dir: sessionDefinitionsPath(), list: listFilesystemResources, read: (p) => readFile(p, "utf8"), freeze: defaultSessionFreezeIo() }),
    ops,
  ),
});
app.all("/resource-mcp/:agent/:name", ({ request, params }) => resourceConnections.handle(request, params.agent, params.name));
app.listen(listenOptions(config.port));
console.error(`butchr daemon on http://${DAEMON_HOSTNAME}:${config.port}  (${describeConfig(config)})`);

// FACTORY-657 (FACTORY-643 slice 1, epic FACTORY-659): re-read rules.json
// without a restart. `reloadRules` (src/rules/reload.ts) goes through the
// exact same `loadRules` validation `butchr rules check` already dry-runs
// — on a problem it leaves `rulesHolder` untouched (the running rules keep
// running) and this logs the problem(s) once; on success it swaps the
// holder's contents IN PLACE, which every provider's own per-poll read
// (see `RulesHolder`'s own doc comment) picks up on its very next poll. A
// rule a reload removes or disables does not kill its agent(s) mid-ticket:
// the reconciler's ordinary stop/reap path ends them on a later poll,
// exactly as a restart's first poll already does today (README's own
// "Applying a change" section) — this changes nothing about that.
//
// No new HTTP route and no CLI subcommand here, per this ticket's own
// scope correction (FACTORY-657 comment, 2026-10-05): the web write path
// FACTORY-663 adds will call `reloadRules(rulesHolder)` in-process, right
// after it writes rules.json itself, using this SAME function — SIGHUP is
// the only trigger this daemon listens for on its own.
//
// Reload is per-poll, not instantaneous: every rule-reading site above
// reads `getRules()` live, and several of them do so at more than one
// `await` boundary within the SAME poll (e.g. a loop's `search()` reading
// `deps.rules` once, then a later step reading it again). A SIGHUP landing
// mid-poll can therefore be visible partway through that one poll's own
// work; it is always fully applied by the NEXT poll. This mirrors the
// existing restart behavior (the first poll after a restart already reads
// whatever rules.json says then) and is not a new kind of tear — see
// `test/unit/rules-reload.test.ts`'s own "does not tear" case for what IS
// guaranteed: a single `discovery.search()` call's own result set never
// mixes pre- and post-reload rules.
//
// Review round 1 (manager-factory): several startup-only computations do
// NOT follow a reload, because they gate whether a provider's client/loop
// exists AT ALL, not just which of its rules are enabled — `jiraProjectEnabled`,
// `fsRules`, `githubStaffing.run`/`githubPrStaffingResult.run`,
// `zendeskStaffing` (also re-reading its OAuth token file would be wrong -
// credentials don't change via a rules reload), and `jiraIdeas`'s client
// creation. A provider with ZERO enabled rules of its own kind at startup
// has no running loop for SIGHUP to wake: bringing up that provider's very
// first rule still needs a restart. `sweepStaleAgentLabels` similarly runs
// once, at startup, and is unaffected either way.
process.on("SIGHUP", () => {
  const before = rulesHolder.getRules().length;
  const result = reloadRules(rulesHolder);
  scopeOf.clear(); // FACTORY-685 (N4) — see `rulesWriteDeps.reload`'s own comment above.
  if (!result.ok) {
    console.error(`butchr: rules reload from ${result.path} failed; keeping the running rules:`);
    for (const line of result.problems) console.error(`  ${line}`);
    return;
  }
  const enabled = rulesHolder.getRules().filter((r) => r.enabled).map((r) => r.id);
  // Deliberately loud (not just "0 enabled") when a previously non-empty
  // rules set reloads to zero: `reloadRules` above already refuses to swap
  // in a MISSING file over a non-empty holder (that's the accident case),
  // so reaching zero here means the file was present and parsed to
  // genuinely zero enabled rules — an operator's real "disable everything"
  // — but it is rare enough, and consequential enough (every rule-having
  // agent stops on the next reconcile poll), to call out by name rather
  // than let it read like any other reload.
  console.error(
    enabled.length === 0 && before > 0
      ? `butchr: rules reloaded from ${result.path}: 0 enabled (was ${before}) — every rule-having agent will stop on the next reconcile poll`
      : `butchr: rules reloaded from ${result.path}: ${enabled.length} enabled${enabled.length ? ` (${enabled.join(", ")})` : ""}`,
  );
  if (result.added.length) console.error(`  added: ${result.added.join(", ")}`);
  if (result.removed.length) console.error(`  removed: ${result.removed.join(", ")}`);
  if (result.changed.length) console.error(`  changed: ${result.changed.join(", ")}`);
  if (!result.added.length && !result.removed.length && !result.changed.length) console.error(`  no change`);
});
// BUTCHR-320 (C): reuses the exact same buildIdentity/toBuildReport this
// daemon's own /health `build` field serves (see `health` above) — never a
// second derivation — so a journal window can be attributed to a BUILD, not
// only a pid (journald's pid only bounds one daemon generation).
console.error(`  ${describeBuild(toBuildReport(buildIdentity))}`);
// FACTORY-647: "fail loudly at startup" — the journal half of this ticket's
// fix, naming the exact missing path and remedy; `/health`'s `dashboardApp`
// field (see `health` above) is the OTHER half, for an uptime checker. Never
// fatal: the old server-rendered pages (`/`, `/configurations`) work fine
// without this build, so the daemon starts either way.
{
  const startupDashboardAppStatus = dashboardAppStatus(dashboardAppRoot);
  if (!startupDashboardAppStatus.built) {
    console.error(`  [butchr:dashboard-app] web build missing at ${startupDashboardAppStatus.path} — run \`bun run build:web\` (or \`bun run build\`) and restart; GET /dashboard-app/* will 503 until then`);
  }
}
console.error(`  terminal: ${terminalPrefix ? terminalPrefix.join(" ") : "NONE — set BUTCHR_TERMINAL to open agent shells"}`);
if (!config.github) console.error("  pr:* labels disabled: set GITHUB_TOKEN_FILE and BUTCHR_GITHUB_ORGS to enable PR discovery");

const readPane = async (paneId: string) => (await herdr.pane.read({ pane_id: paneId, source: "detection", strip_ansi: true })).read.text;
const sendPane = async (paneId: string, text: string) => { await herdr.pane.sendText({ pane_id: paneId, text }); };
// FACTORY-453 (implementing FACTORY-337, epic FACTORY-330): the PTY
// endpoint's OWN read, deliberately NOT `readPane` above. `readPane` passes
// `strip_ansi: true`, correct for the detectors that use it (they want
// plain text), but wrong here: FACTORY-338 puts xterm.js on the other end
// of `/agents/:agentKey/pty`'s socket, and ANSI-stripped output has no
// colour, no cursor positioning, no redraw — a dead scrolling text dump,
// not a terminal (FACTORY-330's own correction on this ticket, 2026-09-28).
// `source: "visible"` (not `readPane`'s `"detection"`) matches what this is
// FOR — the pane's current on-screen contents, the same thing a real
// terminal shows, not a detector's parse-friendly scrollback view. `format:
// "ansi"` alongside `strip_ansi: false` is this daemon's reading of "don't
// strip ANSI" as also meaning "ask for the ANSI-bearing format", not just
// leaving the default in place — see `docs/pty-attach.md`'s Contract
// section for this stated plainly, and `src/terminal/pty-bridge.ts`'s own
// header for why the bridge sends each read as a full-screen redraw rather
// than a diff once ANSI is in play.
const readPaneForPty = async (paneId: string) => (await herdr.pane.read({ pane_id: paneId, source: "visible", format: "ansi", strip_ansi: false })).read.text;

const prTracker = config.github ? new PrTracker({ fetchImpl: fetch, token: config.github.token, orgs: config.github.orgs, log: (line) => console.error(`  ${line}`) }) : undefined;
// KAN-804/807: "idle since it stopped working, never spoke" — comments are only fetched
// for issues that already satisfy the cheap preconditions (see stalled.ts),
// never on every poll.
// BUTCHR-305/BUTCHR-238: extracted so this closure is importable by name
// rather than reproduced inline — `createLabelSync` below has since moved to
// its own `agentStatusesFeedingDashboard` tee (FACTORY-407, see that
// closure's own doc comment), so the one live consumer of THIS closure today
// is `pinnedActiveDetector` further down (project loop only, FACTORY-941).
/**
 * The ticket a pane's workspace works, for rule-engine workspaces only — a
 * legacy workspace is never attributed to its ticket.
 *
 * Deliberately gated by `ownsRuleAgent` (jira-work only): this feeds
 * `resourceOfCwd` (label sync) and `escalationTargetOfCwd` (the
 * blocked-dialog escalator), and neither may ever see a `jira-project`
 * manager pane (an escalation target there would open a Confluence-comment
 * write and control channel on it). The dashboard's own, wider gate is
 * `dashboardAgentOfCwd` below.
 */
const { ownedAgentOfCwd, dashboardAgentOfCwd } = cwdAgentResolvers(agentIdOfWorkspacePath);
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
 * `resourceOfCwd` itself is UNCHANGED and still used for the label-sync
 * status map (`statusMapFromAgents`, which needs the BARE key to match a
 * Jira search's own issue keys). FACTORY-407: the dashboard no longer goes
 * through `resourceOfCwd` at all — `agentStatusesFeedingDashboard` below
 * feeds `buildDashboardRows` the FULL key (`dashboardAgentOfCwd`,
 * undiscarded) via a separate `agent_key` field, because `resourceOfCwd`'s
 * bare fallback is exactly what made every real `AgentDashboardRow.resourceKey`
 * undecodable — see that ticket for the full history.
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
// FACTORY-941: keyed by the FULL agentKey (`dashboardAgentOfCwd`, both
// `jira-work` and `jira-project` providers — see `cwdAgentResolvers`'s own
// doc comment, src/agents/dashboard.ts), never the bare key `resourceOfCwd`
// produces: `pinnedActiveDetector`'s ids are `ProjectMatch.agentKey`
// (`desiredFrom`'s `discovery.idOf` for the project resource type —
// src/rules/jira-project-type.ts), which `resourceOfCwd` would always
// resolve to `null` for (it is DELIBERATELY gated to `ownsRuleAgent` —
// see `ownedAgentOfCwd`'s own doc comment above), making this map
// structurally incapable of matching a project id if built that way.
const agentStatuses = async (): Promise<ReadonlyMap<string, string>> => {
  const { agents } = await herdr.agent.list();
  return statusMapFromAgents(agents.map((a) => ({ ...a, resource_key: dashboardAgentOfCwd(a.cwd) })));
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
      // FACTORY-407: `agent_key` (full, undiscarded) feeds the dashboard row's
      // own correlation identifier (`buildDashboardRows`); `resource_key`
      // (bare, via the UNCHANGED `resourceOfCwd`) stays exactly what
      // `statusMapFromAgents` below already needs. `agent_key` uses the
      // dashboard-only `dashboardAgentOfCwd`; `resource_key` stays on `ownedAgentOfCwd`.
      return { agents: agents.map((a) => ({ ...a, resource_key: resourceOfCwd(a.cwd), agent_key: dashboardAgentOfCwd(a.cwd) })) };
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
// FACTORY-740: dry-run only — see src/agents/silent-stop.ts's own top
// comment. `undefined` when BUTCHR_SILENT_STOP_MODE=off, the same
// disables-entirely-when-omitted shape `stalled`/`stallRemediation` use —
// src/labels/sync.ts's `silentStop?.check` is then simply never called.
const silentStop = config.silentStopMode === "off" ? undefined : createSilentStopCheck({
  now: () => Date.now(),
  suppressMinutes: config.silentStopSuppressMinutes,
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

// FACTORY-845: this poll's resolved idle-poke config per issue, built from
// the rule engine's own (rule, issue) matches just before `syncLabels` runs
// (see the `syncLabels: (matches) => ...` wiring further down this file) —
// `syncLabels` itself only ever sees de-duplicated issues, never the match
// list that produced them (src/rules/resource-type.ts's `uniqueIssues`
// deliberately discards rule identity), so this is the one place that
// association is still available. A ticket matched by more than one
// enabled rule resolves by the most conservative reading per field,
// independently: ANY matching rule's explicit `idlePokeEnabled: false`
// disables the poke outright (an opt-out from one rule should never be
// overridden by another rule's silence); among rules that leave it
// enabled, the SMALLEST explicit `idlePokeMinutes` wins (the more urgent
// configured interval, never the global, never an unset rule's silence);
// the first matching rule's explicit `idlePokeMessage` wins (arbitrary but
// deterministic — multi-rule-match on one ticket is an edge case this
// story's acceptance criteria do not exercise, so this is a simple,
// documented default rather than a modelled trade-off).
const idlePokeRuleConfigByIssue = new Map<string, IdlePokeRuleConfig>();
function updateIdlePokeRuleConfig(units: readonly ExecutionUnit<RuleMatch>[]): void {
  idlePokeRuleConfigByIssue.clear();
  for (const m of resourceMatches(units)) {
    if (!m.rule.enabled) continue;
    const existing = idlePokeRuleConfigByIssue.get(m.issue.key);
    if (m.rule.idlePokeEnabled === false) {
      idlePokeRuleConfigByIssue.set(m.issue.key, { idlePokeEnabled: false, ...(existing?.idlePokeMinutes !== undefined ? { idlePokeMinutes: existing.idlePokeMinutes } : {}), ...(existing?.idlePokeMessage !== undefined ? { idlePokeMessage: existing.idlePokeMessage } : {}) });
      continue;
    }
    if (existing?.idlePokeEnabled === false) continue; // an earlier rule's explicit opt-out already wins
    const idlePokeMinutes = m.rule.idlePokeMinutes !== undefined && (existing?.idlePokeMinutes === undefined || m.rule.idlePokeMinutes < existing.idlePokeMinutes) ? m.rule.idlePokeMinutes : existing?.idlePokeMinutes;
    const idlePokeMessage = existing?.idlePokeMessage ?? m.rule.idlePokeMessage;
    idlePokeRuleConfigByIssue.set(m.issue.key, {
      idlePokeEnabled: true,
      ...(idlePokeMinutes !== undefined ? { idlePokeMinutes } : {}),
      ...(idlePokeMessage !== undefined ? { idlePokeMessage } : {}),
    });
  }
}

// FACTORY-941: this poll's resolved pinned-active minutes override per
// jira-project agentKey — `pinnedActiveMinutesFor` (src/rules/
// jira-project-type.ts, exported there so its resolution logic is directly
// unit-testable without importing this module) rebuilds this fresh from
// each poll's own matches; see the `projectType.discovery.search` wrap
// further down for exactly where/why.
let pinnedActiveMinutesByProject: ReadonlyMap<string, number> = new Map();

// FACTORY-845: the channel half, copying the SAME call shape every other
// delivery seam in this file already uses (`deliverNotice`/
// `renderNotifyDelivery`, the MCP notify call, `herd.nudge`) — an
// EIGHTH seam in this file, which is why
// test/unit/notify-deliver-seams.test.ts's exact-count assertions are
// updated in this same commit (7 -> 8) — see that test file's own doc
// comment and this story's PR body for why that is the INTENDED outcome of
// adding a seam, not a sign anything is wrong.
const deliverIdlePoke = async (issue: string, text: string): Promise<{ via: "channel" | "prompt" }> => {
  const result = await deliverNotice({
    pushChannel: () => notifyAgent(mcp, issue, issue, text),
    nudgePrompt: () => herd.nudge(issue, text),
  });
  console.error(`  [notify] ${issue} ← idle-poke: ${renderNotifyDelivery(result)}`);
  return { via: result.via };
};

// FACTORY-845: the per-rule-configurable idle poke — see src/agents/
// idle-poke.ts's own top comment for why this is a separate, thin module
// built on `stalled`'s own streak rather than an extension of
// `stallRemediation` above. `undefined` when BUTCHR_IDLE_POKE_MODE=off,
// the same disables-entirely-when-omitted shape `silentStop` above uses.
const idlePoke = config.idlePokeMode === "off" ? undefined : createIdlePokeEngine({
  now: () => Date.now(),
  dryRun: config.idlePokeMode !== "live",
  globalMinutes: config.stalledMinutes,
  defaultMessage: DEFAULT_IDLE_POKE_MESSAGE,
  suppressMinutes: config.idlePokeSuppressMinutes,
  maxPokesPerPoll: config.idlePokeMaxPerPoll,
  comments: (issue) => atlassian.comments(issue),
  addComment: async (issue, text) => { await ops.addComment(issue, text); },
  deliver: deliverIdlePoke,
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
if (!rcAuth.ok && getRules().some((r) => r.enabled && r.account !== "none")) {
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
  // FACTORY-622: the two `addComment`/`comments` lines directly above are
  // the whole defect this adds a channel for — they are correct, and they
  // reach a journal on one host and nothing else. A managed session's crash
  // loop was therefore invisible twice over: 2026-10-02 (director and
  // genius, "nowhere to post") and 2026-10-03 (admin-brooswit-nexus, 26
  // "refusing implicit replacement" refusals, "a crash-loop complaint that
  // reached only the journal"). Wired ONLY here, never into
  // `issueCrashLoopDetector` above, which already posts on the resource's
  // own ticket — see `CrashLoopDetectorDeps.opsAlert`'s own doc comment for
  // that reasoning and for why this is a thunk: `opsAlertRouter` is
  // constructed several hundred lines below, after the Rocket.Chat
  // credential it needs is loaded, so reading it by value here would be a
  // temporal-dead-zone access.
  opsAlert: () => opsAlertRouter,
  refusalReason: (id) => herd.lastSpawnRefusal(id),
});
// FACTORY-501 (FACTORY-500 item 2, option b) — audible-only escalation for a
// herdr-restored pane stuck "deferred"/"stuck" on `herd.resumeInPlace()`, so
// a busy-forever restored agent is never silently degraded with no notice —
// see `src/agents/restored-pane-escalation.ts`'s own top comment for the
// full mechanism. TWO SEPARATE INSTANCES, same reasoning as
// issueCrashLoopDetector/managedSessionCrashLoopDetector above: an issue-tier
// agent has a Jira ticket to comment on, a managed-session agent (buddy,
// genius) does not.
const issueRestoredPaneEscalationDetector = createRestoredPaneEscalationDetector({
  now: () => Date.now(),
  addComment: async (id, text) => {
    if (isQueryLevelAgent(id)) { console.error(`  [restored-pane-escalation] ${id}: query-level agent — no single ticket to comment on, skipping`); return; }
    await speakOnOwnChannel(ops, resourceKeyOf(id), text);
  },
  log: (line) => console.error(`  ${line}`),
});
// FACTORY-501: a managed-session agent has NO Jira ticket to comment on at
// all — same reasoning as `managedSessionCrashLoopDetector` immediately
// above, and every id this instance ever sees is one of these ids (wired
// ONLY into `startManagedSessionsLoop` below), so `addComment` always logs
// rather than branching on `isQueryLevelAgent`.
const managedSessionRestoredPaneEscalationDetector = createRestoredPaneEscalationDetector({
  now: () => Date.now(),
  addComment: async (id, text) => { console.error(`  [managed-sessions:restored-pane-escalation] ${id}: no Jira ticket to comment on — logging instead:\n  ${text.replace(/\n/g, "\n  ")}`); },
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
  ...(silentStop ? { silentStop } : {}),
  ...(idlePoke ? { idlePoke, idlePokeRuleConfig: (key: string) => idlePokeRuleConfigByIssue.get(key) } : {}),
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
if (getRules().some(r => r.enabled && r.resourceProvider === "jira-work")) void sweepStaleAgentLabels({
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
  const result = await deliverNotice({
    pushChannel: () => notifyAgent(mcp, agent, aboutIssue, msg),
    nudgePrompt: () => herd.nudge(agent, msg),
  });
  const reasonTag = notifyReasonTag(reason);
  console.error(`  [notify] ${agent} ← ${aboutIssue}${reasonTag}: ${renderNotifyDelivery(result)}`);
};

// FACTORY-922: lifetime count of `decide()`'s skip-not-notify fallback —
// see `commentChecksSkipped`'s own doc comment (src/daemon/health.ts).
let commentChecksSkipped = 0;

const ruleResourceType = createRuleResourceType({
  rules: getRules(),
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
  // FACTORY-922: the `/health` counter's one writer — see
  // `commentChecksSkipped`'s own doc comment (src/daemon/health.ts).
  onCommentCheckSkipped: () => { commentChecksSkipped++; },
  // FACTORY-949: the boss-wake debounce window — see
  // `Config.blockedWakeDebounceMinutes`'s own doc comment.
  blockedWakeDebounceMinutes: config.blockedWakeDebounceMinutes,
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

// FACTORY-772: wrapped in a function, rather than called inline once, so
// the watchdog below can discard a wedged loop's `Stop` handle and start a
// completely independent replacement in its place — see
// src/daemon/loop-watchdog.ts's own top comment for why this (never a
// shared in-flight flag the old and new loop would have to race over) is
// the restart shape this ticket's watchdog relies on. Every dependency
// closed over here (herd, ops, the detectors, admissionController, …) is
// itself a long-lived instance shared across every call, so a restart
// recreates ONLY the `watch()` loop's own internal state (RespawnGuard,
// ResumeDeferGuard, the notify-tick hash counter — all local to
// `runResourceLoop`/`startLoop`) — never re-registers an agent, re-reads
// config, or duplicates any of this daemon's other long-lived state.
const startIssueLoop = () => runResourceLoop(ruleResourceType, {
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
  // FACTORY-916: `herd.lastFreshSpawnResumed` told `reconcileNow` this
  // respawn resumed its prior Claude session via an ordinary fresh spawn
  // (never `resumeInPlace()` — that is `onResumePreserved` below), so it
  // fires INSTEAD OF `onRespawn` above for this one respawn — see that
  // callback's own doc comment (src/daemon/loop.ts) for why exactly one of
  // the two always fires. Posts the third wording (`respawnResumedComment`),
  // not `respawnComment` (wrongly says "this session is fresh") and not
  // `resumePreservedComment` (wrongly says "your ticket has not changed" —
  // this agent's PROCESS was actually gone, unlike `resumeInPlace()`'s).
  onRespawnResumed: async (agent) => {
    console.error(`  [reconcile] ${agent} respawned, resumed its prior session`);
    if (isQueryLevelAgent(agent)) return;
    const issue = resourceKeyOf(agent);
    await ops.addComment(issue, respawnResumedComment(agent, new Date().toISOString())).catch((e) =>
      console.error(`  WARNING: [reconcile] respawn-resume notice failed for ${agent}: ${(e as Error)?.message ?? e}`));
  },
  // FACTORY-314: a model/effort-only change resumed the SAME session —
  // distinct marker/wording from `onRespawn` above (never "re-read your
  // ticket"), same query-level-agent exclusion (no single ticket to post to).
  onResumePreserved: async (agent) => {
    console.error(`  [reconcile] ${agent} resumed in place (session preserved)`);
    if (isQueryLevelAgent(agent)) return;
    const issue = resourceKeyOf(agent);
    await ops.addComment(issue, resumePreservedComment(agent, new Date().toISOString())).catch((e) =>
      console.error(`  WARNING: [reconcile] resume notice failed for ${agent}: ${(e as Error)?.message ?? e}`));
  },
  // FACTORY-314: fires once (not per-poll) after RESUME_WAITING_NOTICE_AT_POLLS
  // consecutive deferred/stuck polls — never a trigger to force a restart,
  // only a heads-up that a model/effort change is still waiting.
  onResumeWaiting: async (agent, outcome, consecutivePolls) => {
    console.error(`  [reconcile] ${agent} resume still waiting after ${consecutivePolls} polls (${outcome})`);
    if (isQueryLevelAgent(agent)) return;
    const issue = resourceKeyOf(agent);
    const why = outcome === "deferred"
      ? "it has stayed mid-turn across every poll since"
      : "its pane never returned to a shell prompt after being asked to exit — it may need a human to look at it";
    await ops.addComment(issue, `[butchr:resume] A model/effort change for ${agent} is still waiting to resume (checked ${consecutivePolls} polls ago and every poll since): ${why}. Nothing was interrupted; the daemon will keep retrying rather than force a restart.`).catch((e) =>
      console.error(`  WARNING: [reconcile] resume-waiting notice failed for ${agent}: ${(e as Error)?.message ?? e}`));
  },
  // FACTORY-501: the herdr-RESTORED-PANE deferred/stuck counterpart of
  // `onResumeWaiting` immediately above — see
  // `src/agents/restored-pane-escalation.ts`'s own top comment. Never called
  // for a model/effort-only deferral (src/daemon/loop.ts's own split at the
  // `RESTORED_PANE_STALE_REASON_PREFIX` check).
  checkRestoredPaneDeferred: issueRestoredPaneEscalationDetector.check,
  // Label sync and the parked/abandoned detectors work per TICKET, so they
  // see each matched issue once however many rules matched it.
  syncLabels: (matches) => {
    // FACTORY-845: refresh this poll's per-issue idle-poke rule config
    // BEFORE calling syncLabels, from the SAME matches it is about to
    // discard rule identity from — see `updateIdlePokeRuleConfig`'s own
    // doc comment above for why this is the only place that association
    // is still available.
    if (idlePoke) updateIdlePokeRuleConfig(matches);
    return syncLabels(uniqueIssues(matches));
  },
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

let stopIssueLoop = startIssueLoop();

// FACTORY-772: the backstop for any never-settling await that
// BUTCHR_HERDR_TIMEOUT_MS and the permission-answer watchdog do NOT cover
// (see src/daemon/loop-watchdog.ts's own top comment) — `pollLoop` and
// `notify` are two independent liveness heartbeats for the ONE issue loop
// started above, so both names share a single restart action: discard the
// current `Stop` handle and start a completely fresh loop in its place.
// Reported under BOTH names in `/health`'s `loopWatchdog` sibling (wired
// into the `health` callback far above this file — see that call site's
// own comment for why the forward reference there is safe) since one
// restart fixes both.
const issueLoopWatchdog = createLoopWatchdog(
  [{
    names: ["pollLoop", "notify"],
    components: () => [...loopHealth.status().components, ...notifyHealth.status().components],
    restart: () => {
      try {
        stopIssueLoop();
      } catch (e) {
        console.error(`  WARNING: [watchdog] stopping the wedged issue loop threw (starting its replacement anyway): ${(e as Error)?.message ?? e}`);
      }
      stopIssueLoop = startIssueLoop();
    },
  }],
  { thresholdMs: config.loopWatchdogThresholdMs, log: (line) => console.error(line) },
);

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
  rules: getRules(),
  client: githubIssues ?? { searchAll: async () => [], comments: async () => [] },
  herd,
  deliver: async (agent, resource, msg) => {
    const result = await deliverNotice({
      pushChannel: () => notifyAgent(mcp, agent, resource, msg),
      nudgePrompt: () => herd.nudge(agent, msg),
    });
    console.error(`  [notify] ${agent}: ${renderNotifyDelivery(result)}`);
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

// The github-pr rule loop: its own agents only, its own admission bucket
// under the same host cap, and none of the Jira-writing detectors above —
// same reasoning as the github-issue loop just above.
if (githubPrs) console.error(`  github-pr rules: ${githubPrStaffingResult.rules.map((r) => r.id).join(", ")}`);
startGithubPrLoop({
  staffing: githubPrStaffingResult,
  rules: getRules(),
  client: githubPrs ?? { searchAll: async () => [], comments: async () => [] },
  herd,
  deliver: async (agent, resource, msg) => {
    const result = await deliverNotice({
      pushChannel: () => notifyAgent(mcp, agent, resource, msg),
      nudgePrompt: () => herd.nudge(agent, msg),
    });
    console.error(`  [notify] ${agent}: ${renderNotifyDelivery(result)}`);
  },
  suppress: (resource, updated, watcher) => ownWrites.shouldSuppress(resource, updated, watcher, Date.now()),
  admission: (candidates, stopping) => admissionController.admit(candidates, stopping, ADMISSION_SOURCE_GITHUB_PR),
  onAdmitted: admissionController.recordSpawned,
  reserveAdmission: (ids) => admissionController.reserve(ids, ADMISSION_SOURCE_GITHUB_PR),
  releaseAdmission: (ids) => admissionController.release(ids, ADMISSION_SOURCE_GITHUB_PR),
  account: accountLifecycle,
  log: (line) => console.error(`  ${line}`),
  onPollSuccess: () => githubPrHealth.recordSuccess(),
  onError: (e) => githubPrHealth.recordError(e),
});

// The jira-idea rule loop: proven Product Discovery ideas only, its own
// agents and admission bucket, and none of the work-item detectors above.
if (jiraIdeas) console.error(`  jira-idea rules: ${ideaRules.map((r) => r.id).join(", ")}`);
if (!githubIssues && ideaRules.some((r) => r.relationships?.inwardConnectionRules?.length)) console.error("  WARNING: jira-idea rules list github-issue rules, but github-issue rules are not staffed; ideas hear no GitHub issues");
startJiraIdeaLoop({
  rules: getRules(),
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
    const result = await deliverNotice({
      pushChannel: () => notifyAgent(mcp, agent, resource, msg),
      nudgePrompt: () => herd.nudge(agent, msg),
    });
    console.error(`  [notify] ${agent}: ${renderNotifyDelivery(result)}`);
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
  rules: getRules(),
  client: zendeskTickets ?? { searchAll: async () => [], comments: async () => [] },
  herd,
  deliver: async (agent, resource, msg) => {
    const result = await deliverNotice({
      pushChannel: () => notifyAgent(mcp, agent, resource, msg),
      nudgePrompt: () => herd.nudge(agent, msg),
    });
    console.error(`  [notify] ${agent}: ${renderNotifyDelivery(result)}`);
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
  rules: getRules(),
  herd,
  deliver: async (agent, resource, msg) => {
    const result = await deliverNotice({
      pushChannel: () => notifyAgent(mcp, agent, resource, msg),
      nudgePrompt: () => herd.nudge(agent, msg),
    });
    console.error(`  [notify] ${agent}: ${renderNotifyDelivery(result)}`);
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
  resolvedAgents: managedSessionResolvedAgents,
  lizardModes: managedSessionLizardModes,
  account: accountLifecycle,
  herd,
  deliver: async (agent, resource, msg) => {
    const result = await deliverNotice({
      pushChannel: () => notifyAgent(mcp, agent, resource, msg),
      nudgePrompt: () => herd.nudge(agent, msg),
    });
    console.error(`  [notify] ${agent}: ${renderNotifyDelivery(result)}`);
  },
  admission: (candidates, stopping) => admissionController.admit(candidates, stopping, ADMISSION_SOURCE_MANAGED_SESSIONS),
  onAdmitted: admissionController.recordSpawned,
  reserveAdmission: (ids) => admissionController.reserve(ids, ADMISSION_SOURCE_MANAGED_SESSIONS),
  releaseAdmission: (ids) => admissionController.release(ids, ADMISSION_SOURCE_MANAGED_SESSIONS),
  checkCrashLoop: managedSessionCrashLoopDetector.check,
  // FACTORY-505: the gap FACTORY-500 found and this comment used to name —
  // `onResumeWaiting`/`onResumePreserved` never reached `startManagedSessionsLoop`
  // at all, so a managed session (buddy, genius) deferring a model/effort
  // resume was silent however long it deferred, and a successful in-place
  // resume never even logged. Same "no Jira ticket to comment on" reasoning
  // as `managedSessionCrashLoopDetector`/`managedSessionRestoredPaneEscalationDetector`
  // above — log only, never `ops.addComment`. See
  // `ManagedSessionsLoopDeps.onResumeWaiting`/`.onResumePreserved`'s own doc
  // comments (src/daemon/session-definitions-loop.ts).
  onResumeWaiting: (agent, outcome, consecutivePolls) => {
    console.error(`  [managed-sessions:resume-waiting] ${agent}: resume still waiting after ${consecutivePolls} polls (${outcome}) — no Jira ticket to comment on, logging instead`);
  },
  onResumePreserved: (agent) => {
    console.error(`  [managed-sessions] ${agent} resumed in place (session preserved)`);
  },
  // FACTORY-501: REQUIRED wiring — without this, a restored-pane escalation
  // would silently never fire for buddy/genius (the canary set), the exact
  // gap FACTORY-500 found in `onResumeWaiting`/`onResumePreserved` above
  // `startManagedSessionsLoop` never receiving them either. See
  // `ManagedSessionsLoopDeps.checkRestoredPaneDeferred`'s own doc comment
  // (src/daemon/session-definitions-loop.ts).
  checkRestoredPaneDeferred: managedSessionRestoredPaneEscalationDetector.check,
  log: (line) => console.error(`  ${line}`),
  onPollSuccess: () => managedSessionsHealth.recordSuccess(),
  onError: (e) => managedSessionsHealth.recordError(e),
  // FACTORY-53/FACTORY-71: linked-change eventing for a managed session that
  // opts in via `linkedEventingProjects` — the SAME `searchAll`/`comments`/
  // `notifyRuleAgent`/routed link store/`herd.frozen` seams the `jira-project`
  // rule loop's own linked-eventing wiring already uses above.
  searchIssues: (jql) => atlassian.searchAll(jql),
  comments: (key) => atlassian.comments(key),
  linkStore: routingLinkStore,
  notify: notifyRuleAgent,
  isFrozen: async (id) => (await herd.frozen([id])).has(id),
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
// FACTORY-369: a SEPARATE Rocket.Chat identity from `rcAuth`/`rcClient`
// above — that one is account-management only (see its own comment); a
// managed-session escalation posting to #team-admin needs a different
// Nexus grant that may not exist yet (see `Config.managedEscalationRocketChat`'s
// own doc comment). Absent/invalid credential: `teamAdminNotify` stays
// undefined and every escalation degrades to the loud journal line
// `escalation-loop.ts` already writes unconditionally (AC 6) — never a
// startup crash, exactly like `rcAuth`'s own "optional, refuse at point of
// use" contract above.
const managedEscalationAuth = config.managedEscalationRocketChat
  ? loadRocketChatAuth({
      ROCKETCHAT_URL: config.managedEscalationRocketChat.url,
      ROCKETCHAT_ADMIN_USER_ID: config.managedEscalationRocketChat.adminUserId,
      ROCKETCHAT_ADMIN_TOKEN_FILE: config.managedEscalationRocketChat.adminTokenFile,
    })
  : { ok: false as const, reason: "BUTCHR_TEAM_ADMIN_ROCKETCHAT_URL/_USER_ID/_TOKEN_FILE not set" };
// FACTORY-609 (Part B): the same one credential now posts to EITHER room —
// there is no second Nexus grant, only a second ROOM, and RocketChatPoster
// already takes a channel per call (FACTORY-607 comment 28784 item 4). The
// routing values themselves (which room/mention each tier uses) live in
// `config.managedEscalationRouting`, always present regardless of whether
// this credential is configured — see that field's own doc comment.
const managedEscalationRooms = [...new Set([config.managedEscalationRouting.normalRoom, config.managedEscalationRouting.assemblyRoom, config.managedEscalationRouting.directorRoom])];
if (!managedEscalationAuth.ok) {
  console.error(`  managed-session escalation disabled (${managedEscalationAuth.reason}) — every managed-session escalation logs a complete [managed-escalation] journal line only`);
} else {
  console.error(`  managed-session escalation enabled → #${managedEscalationRooms.join(", #")} (Rocket.Chat)`);
}
const teamAdminNotify = managedEscalationAuth.ok
  ? (() => {
      const poster = createRocketChatPoster({ fetchImpl: fetch, url: managedEscalationAuth.url, adminUserId: managedEscalationAuth.adminUserId, adminToken: managedEscalationAuth.adminToken });
      return async (room: string, text: string) => { await poster.postMessage(room, text); };
    })()
  : undefined;

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
  // FACTORY-369: absent (undefined) whenever `managedEscalationAuth` isn't
  // ok — see that constant's own comment just above for the fallback.
  ...(teamAdminNotify ? { teamAdminNotify } : {}),
  managedEscalationRouting: config.managedEscalationRouting,
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

// FACTORY-363/FACTORY-397: drovr's SEPARATE login-expired watcher
// (`createLoginExpiredWatcher`, `@brooswit/drovr` >= 0.16.3,
// src/agents/login-expired-alert.ts) — its OWN independent poll loop, own
// timer, own read of the fleet, deliberately NOT sharing
// `blockingEscalationTimer` above: that timer feeds ONLY
// `escalator.onDrovrUnknownDialog`, whose managed-session-only routing is
// exactly the trap this condition must not inherit (a keyed pane — both real
// incidents, FACTORY-314/w1T and FACTORY-324/w1V — resolves `managedSessionOf`
// to null there and would be silently dropped). This tracker has no
// managed-session concept at all: every pane drovr reports reaches the
// host-wide alert. See `src/agents/login-expired-alert.ts`'s own header for
// the full design and why its delivery (a journal line + a `/health` sibling
// field, both below) survives a dead Claude credential.
// FACTORY-630: the PUSH destination for this alert, and for every later ops
// condition that reuses the route. Built on the SAME `teamAdminNotify`
// closure the managed-session escalator is wired behind above — one poster,
// one credential, a second room per call, no second Rocket.Chat client. When
// that credential is absent, `post` is undefined and the router degrades to
// its own journal line, leaving this alert exactly as it behaved before this
// ticket (the journal line and `/health` below are untouched by it).
const opsAlertRouter = createOpsAlertRouter({
  ...(teamAdminNotify ? { post: teamAdminNotify } : {}),
  room: config.opsAlert.room,
  mention: config.opsAlert.mention,
  host: hostname(),
  now: () => Date.now(),
  log: (line) => console.log(line),
  dedupWindowMs: config.opsAlert.dedupMinutes * 60_000,
});
if (teamAdminNotify) console.error(`  ops alerts enabled → #${config.opsAlert.room} (Rocket.Chat), dedup ${config.opsAlert.dedupMinutes}m per condition`);
else console.error(`  ops alerts disabled (no Rocket.Chat posting credential) — every ops alert logs a [butchr:ops-alert] journal line only`);

// FACTORY-665: the settings.json problems already logged to the journal
// above (before `opsAlertRouter` existed this early in the file) ALSO get
// an ops alert, one per problem, `dedupWindowMs: 0` (non-deduped — same
// "never swallowed by the router's own hourly dedup" reasoning as the
// first-run-seed alert just below), since these are the "refuse LOUDLY"
// cases the ticket's own design constraint calls out by name.
for (const problem of settingsFileResult.problems) {
  opsAlertRouter.raise({ key: `settings-file-problem:${problem}`, condition: "settings-file-problem", subject: settingsFilePath(), reason: problem, dedupWindowMs: 0 });
}

// FACTORY-669, agentsafety constraint 4: one alert, raised here rather than
// at the seed's own call site (far above, before `opsAlertRouter` existed —
// see `firstRunSeedOutcome`'s own comment there). The "vanished" case passes
// `dedupWindowMs: 0` so it is never swallowed by the router's ordinary
// hourly dedup (agentsafety: "a vanished rules file on an established
// install must be noticed") — moot for THIS call alone (seeding runs once
// per process, so the router's in-memory dedup state can never have seen
// this key before), but it makes the non-deduped intent explicit rather
// than relying on that coincidence.
if (firstRunSeedOutcome.kind === "seeded") {
  opsAlertRouter.raise({
    key: "first-run-seed",
    condition: "first-run-seed",
    subject: `rules file ${firstRunSeedOutcome.path}`,
    reason: `seeded one disabled template rule (${FIRST_RULE_ID}) at true first run`,
    remedy: "Edit the template rule's query in the dashboard, then enable it; its brief is file-only, edited in the rules file by hand if you want it.",
  });
} else if (firstRunSeedOutcome.kind === "vanished-established-install") {
  opsAlertRouter.raise({
    key: `rules-file-vanished:${firstRunSeedOutcome.path}`,
    condition: "rules-file-vanished",
    subject: `rules file ${firstRunSeedOutcome.path}`,
    reason: "the default rules file is absent but a prior .bak-* backup exists in its directory — an established install's rules file appears to have vanished, so no first-run template was seeded",
    remedy: "Restore the rules file (from a .bak-* backup, or by hand) and SIGHUP/restart the daemon; nothing is staffed until then.",
    dedupWindowMs: 0,
  });
} else if (firstRunSeedOutcome.kind === "config-dir-not-empty") {
  // FACTORY-685 (L1): same non-deduped discipline as the "vanished" case
  // above — this is also "an established install some other way", never
  // swallowed by the router's ordinary hourly dedup.
  opsAlertRouter.raise({
    key: `rules-config-dir-not-empty:${firstRunSeedOutcome.path}`,
    condition: "rules-config-dir-not-empty",
    subject: `rules file ${firstRunSeedOutcome.path}`,
    reason: "the default rules file is absent and its directory holds no .bak-* backup, but the directory already holds other state — this looks like an established install some other way, so no first-run template was seeded",
    remedy: "Add a rules file (from a backup, or by hand) and SIGHUP/restart the daemon; nothing is staffed until then.",
    dedupWindowMs: 0,
  });
}

const credentialDeathTracker = createCredentialDeathTracker({ log: (line) => console.log(line), now: () => Date.now(), opsAlert: opsAlertRouter });
const loginExpiredWatcher = createLoginExpiredWatcher({
  onLoginExpired: (escalation) => credentialDeathTracker.onLoginExpired(escalation),
  onLoginExpiredResolved: (resolved) => credentialDeathTracker.onLoginExpiredResolved(resolved),
});
let loginExpiredPollInFlight = false;
const loginExpiredTimer = setInterval(() => {
  if (loginExpiredPollInFlight) return;
  loginExpiredPollInFlight = true;
  loginExpiredWatcher.poll(herdr)
    .catch((e) => console.error(`  [login-expired] poll failed: ${(e as Error)?.message ?? e}`))
    .finally(() => { loginExpiredPollInFlight = false; });
}, 5_000);
loginExpiredTimer.unref?.();

// FACTORY-425 (implements FACTORY-419): host-side counting of Codex
// unrecognised-dialog sightings per fingerprint — a FOURTH, independent poll
// loop, own timer, own read of the fleet, same isolation reasoning as
// `loginExpiredTimer`/`blockingEscalationTimer` above. Deliberately calls
// ONLY `scanPendingCodexApprovals` (a pure read — never
// `approveCodexApproval`/`autoAnswerCodexApprovals`, either of which can
// press keys for a RECOGNISED dialog): this loop observes and counts, never
// answers or classifies, per FACTORY-419's own scope correction. See
// `src/agents/codex-dialog-sightings.ts`'s own header for why this counts
// EPISODES, not polls, and for why there was no existing
// aggregate-count-by-fingerprint surface in this repo (for either vendor) to
// mirror.
const codexDialogSightings = createCodexDialogSightingsTracker({ log: (line) => console.log(line), now: () => Date.now() });
let codexDialogSightingsPollInFlight = false;
const codexDialogSightingsTimer = setInterval(() => {
  if (codexDialogSightingsPollInFlight) return;
  codexDialogSightingsPollInFlight = true;
  scanPendingCodexApprovals(herdr)
    .then((result) => codexDialogSightings.onScan(result.unrecognised))
    .catch((e) => console.error(`  [codex-unrecognised] poll failed: ${(e as Error)?.message ?? e}`))
    .finally(() => { codexDialogSightingsPollInFlight = false; });
}, 5_000);
codexDialogSightingsTimer.unref?.();

// DROVR-42/FACTORY-67 (host-wiring decision carried over from DROVR-41,
// under the DROVR-37 epic — narrowed to an explicit opt-in field by
// FACTORY-67's director before merge; see that ticket if this looks
// different from DROVR-41's original "sweep every pane" recommendation): a
// THIRD, independent pane-scanning timer — see
// src/agents/permission-answer-loop.ts's own header for the full reasoning
// (why this is its own timer rather than folded into the Jira reconcile
// loop above or `blockingEscalationTimer` immediately above, and why it
// cannot collide with `chooseStartupAnswer`/`watchPrompts` below). Presses
// keys (unlike `blockingEscalationTimer`, which never does — see that
// timer's own comment) so it earns its own tighter isolation from every
// other poll loop's failure modes, exactly like `blockingEscalationTimer`
// already does for the same reason.
//
// `lizardModeLabel` is this timer's `eligiblePanes` hook (see
// `PermissionAnswerLoopDeps.eligiblePanes`'s own doc comment): a pane counts
// only when its cwd resolves to SOME rule-engine agent id (managed session or
// rule-launched alike) AND `ruleLizardModeOf` says that id is eligible
// (`managedSessionLizardModes`'s live poll for a managed session,
// `Rule.lizardMode` for everything else — FACTORY-87). FACTORY-138 (operator
// decision, FACTORY-67 director comment 2026-09-26 22:24Z): a managed
// session (vendor "claude") or rule that never sets the field is now
// eligible BY DEFAULT — only an explicit `lizardMode: false` resolves
// `false`. A legacy/bare-issue agent, a managed session not yet observed
// this daemon's lifetime, or a `vendor: "codex"` managed session (which
// cannot set this field at all) still resolves `false` and is never
// touched — see `ruleLizardModeOf`'s own doc comment
// (src/agents/permission-answer-loop.ts) for the full breakdown of which
// cases the new default does and does not reach. The label itself (basename of
// the resource id, e.g. the definition file or the Jira/GitHub/filesystem
// resource) is what lets a log line name WHICH AGENT got a prompt answered
// (FACTORY-67's own requirement), not just an opaque pane id.
function lizardModeLabel(cwd: string | null | undefined): string | undefined {
  const id = agentIdOfWorkspacePath(cwd);
  if (!id || !ruleLizardModeOf(id)) return undefined;
  const decoded = decodeAnyAgentKey(id);
  return decoded && decoded.kind === "resource" ? basename(decoded.resourceId) : id;
}
// FACTORY-581 SAFETY GUARD 4: canary narrowing, applied AFTER `lizardModeLabel`
// decides a pane's label exactly as before — see `Config.permissionAnswerCanaryPaneLabel`'s
// own doc comment for the one-step rollback/widen and why this rides the
// existing `eligiblePanes` gate instead of a new flag. Unset (the default):
// every pane `lizardModeLabel` allows stays eligible, byte-for-byte today's
// behaviour.
const permissionAnswerEligiblePanes = (agents: readonly { pane_id: string; cwd: string | null | undefined }[]): ReadonlyMap<string, string> => {
  const out = new Map<string, string>();
  for (const a of agents) {
    const label = lizardModeLabel(a.cwd);
    if (!label) continue;
    if (config.permissionAnswerCanaryPaneLabel !== undefined && label !== config.permissionAnswerCanaryPaneLabel) continue;
    out.set(a.pane_id, label);
  }
  return out;
};
//
// CADENCE, chosen and measured against this daemon's own load rather than
// copied from DROVR-41's order-of-magnitude suggestion unread: 20s lands
// inside DROVR-41's own 15-30s recommendation, slower than the 5s
// `blockingEscalationTimer`/`watchPrompts` timers (a pure-read status poll,
// cheap to run often) but close to this daemon's own ~15s Jira reconcile
// cadence under load (BUTCHR-117) — a bound already proven acceptable
// elsewhere in this same daemon, without adding a fourth distinct polling
// rhythm to reason about. The lizard-mode opt-in gate above only shrinks
// this timer's real workload (a tick with zero eligible panes costs one
// `agent.list()` call and nothing else — see `runPermissionAnswerTick`'s own
// doc comment), so the original cost/cadence tradeoff this value was chosen
// against still holds even more comfortably now than when every pane was in
// scope.
// `READ_TIMEOUT_MS` (8s) sits comfortably below `INTERVAL_MS` (20s) — see
// `AutoAnswerPermissionsOptions.readTimeoutMs`'s own doc comment
// (`@brooswit/drovr`) for why a pane's attempt must never still be in
// flight when the next tick fires — with margin over drovr's own internal
// approve-verify budget (5s default `verifyTimeoutMs`, measured against
// `node_modules/@brooswit/drovr/dist/index.js`) rather than picked to
// exactly match it.
//
// FACTORY-98 (FACTORY-97): 20s is no longer the ONLY thing standing between
// a lizard-mode pane going `blocked` and getting answered — see
// `src/agents/permission-answer-watch.ts`'s own header for why (herdr's
// `pane.agent_status_changed` push event, real per `@brooswit/herdr-sdk`'s
// own generated types, but filtered to a specific `pane_id` — there is no
// "any pane" wildcard, so this stays a scan-driven sweep at its core, with
// the push connection layered on top as a fast path for panes the sweep
// already knows about). `INTERVAL_MS` unchanged: it is now the FALLBACK
// cadence (a dropped or not-yet-opened subscription still gets caught within
// one sweep, same bound as before this ticket), not the only path.
const PERMISSION_ANSWER_INTERVAL_MS = 20_000;
const PERMISSION_ANSWER_READ_TIMEOUT_MS = 8_000;
// FACTORY-752 (FACTORY-746 (c)): liveness for the permission-answer tick —
// the exact observable the 10-08 incident's own silence was missing (two
// `agent.list()` rejections, then NO line at all until a 50-minute-later
// restart). `thresholdMs` follows the SAME "at least three polls of the
// slower loop" convention the resource-loop healths above already use
// (`Math.max(config.pollStaleMs, 3 * <this loop's own interval>)`) — three
// missed sweeps (60s) is long enough that an ordinary slow tick (one pane
// near its own `PERMISSION_ANSWER_READ_TIMEOUT_MS` deadline) never trips it,
// but short enough that a genuinely wedged loop is flagged in roughly a
// minute, not the ~50 minutes the incident actually ran silent for. See
// `createTickHealth`'s own doc comment (src/daemon/health.ts) for why this
// rides in `components[]` (the liveness AND) rather than beside it.
const permissionAnswerHealth = createTickHealth({
  name: "permissionAnswer",
  thresholdMs: Math.max(config.pollStaleMs, 3 * PERMISSION_ANSWER_INTERVAL_MS),
  log: (line) => console.error(line),
});
// FACTORY-100/FACTORY-103: OFF unless BUTCHR_LIZARD_APPROVAL_SOUND is set
// (see Config.lizardApprovalSound's own doc comment) — `enabled: false`
// makes `createApprovalSoundNotifier` return a no-op `notifyApproved` before
// touching PATH, spawn, or the filesystem at all. `has`/`spawn` mirror
// `terminalPrefix`'s own detection wiring above (`Bun.which`/`Bun.spawn`).
// No cache dir: the only source left (URL support was cut) is either an
// override file already on disk, or drovr's own bundled asset resolved
// straight out of node_modules — nothing here is ever downloaded.
const approvalSoundNotifier = createApprovalSoundNotifier({
  enabled: config.lizardApprovalSound !== undefined,
  ...(config.lizardApprovalSound?.overridePath ? { overridePath: config.lizardApprovalSound.overridePath } : {}),
  has: (c) => Bun.which(c) != null,
  spawn: (argv) => Bun.spawn(argv, { stdio: ["ignore", "ignore", "ignore"] }),
  log: (line) => console.error(`  ${line}`),
});
// Narrows herdr's own push frame down to the one shape
// `permission-answer-watch.ts` needs (`pane_id` + `agent_status`) — real
// `PushFrame`s carry many other event shapes (workspace/tab/pane lifecycle)
// with neither field, so `"agent_status" in frame.data` (rather than
// asserting the wider union structurally matches) is what lets this compile
// without a cast: only a `pane.agent_status_changed` frame's data ever has
// both keys, which is the only kind `subscribeAgentStatus` below ever asks
// herdr to send.
async function* paneAgentStatusFrames(sub: Awaited<ReturnType<DrovrClient["subscribe"]>>): AsyncGenerator<PermissionAnswerPushFrame> {
  for await (const frame of sub) {
    if ("agent_status" in frame.data && "pane_id" in frame.data) {
      yield { event: frame.event, data: { pane_id: frame.data.pane_id, agent_status: frame.data.agent_status } };
    }
  }
}
/**
 * FACTORY-722: `DrovrClient.subscribe`/`HerdrClient.subscribe` opens its own
 * long-lived connection OUTSIDE `rpc()` (`Subscription.open`,
 * `@brooswit/herdr-sdk`) and never reads `herdr`'s own `timeoutMs` at all —
 * confirmed against that package's own source, which passes only
 * `socketPath` through, never the options object `timeoutMs` lives on. So
 * `config.herdrCallTimeoutMs` (which bounds every OTHER call this daemon
 * makes through `herdr`, including `agent.list()`) does nothing for this
 * one — a hung connect or a never-acked `events.subscribe` here would still
 * wedge `permission-answer-watch.ts`'s `runSubscription` forever without
 * this wrapper, leaving the push fast-path permanently unarmed (the sweep
 * alone would still answer prompts, just without the fast path — but a
 * caller can't know that from here, so this closes the gap rather than
 * relying on the fallback). Reuses `config.herdrCallTimeoutMs` rather than a
 * second knob — this is the same "a herdr call must not hang forever" bound,
 * just on the one call path the SDK doesn't already cover.
 */
// A `const` capture, not a direct `config.herdrCallTimeoutMs` read below:
// `config` itself is an un-annotated `let` narrowed by control flow (see its
// own declaration above), and TypeScript cannot carry that narrowing into a
// hoisted top-level `function` declaration — reading `config` directly from
// inside one (as the deadline guard below originally did) makes the WHOLE
// variable implicitly `any`, including every other read of it in this
// file. A `const` has a definite type at its own declaration site
// regardless of where it's later closed over, so capturing the one field
// this function needs here sidesteps the problem entirely.
const HERDR_CALL_TIMEOUT_MS = config.herdrCallTimeoutMs;
// FACTORY-751/FACTORY-775: ONE guard instance for the lifetime of this
// daemon process, shared across every `subscribeAgentStatus` call
// (including across resubscribes with a different pane-id set) — see
// `createOutstandingGuard`'s own doc comment (herdr-subscribe-deadline.ts)
// for why a fresh instance per call would defeat the bound entirely.
const guardedHerdrSubscribe = createOutstandingGuard<Awaited<ReturnType<DrovrClient["subscribe"]>>>(
  HERDR_CALL_TIMEOUT_MS,
  (ms) => new HerdrTransportError(`events.subscribe: no ack within ${ms}ms`),
);
function subscribeAgentStatus(paneIds: readonly string[]): Promise<PermissionAnswerSubscription> {
  return guardedHerdrSubscribe(() => herdr.subscribe(paneIds.map((pane_id) => ({ type: "pane.agent_status_changed" as const, pane_id }))))
    .then((sub) => ({ [Symbol.asyncIterator]: () => paneAgentStatusFrames(sub), close: () => sub.close() }));
}
startPermissionAnswerWatch(
  {
    client: herdr,
    eligiblePanes: permissionAnswerEligiblePanes,
    auditPath: config.permissionAuditPath,
    operator: "butchr-daemon",
    readTimeoutMs: PERMISSION_ANSWER_READ_TIMEOUT_MS,
    log: (line) => console.error(`  ${line}`),
    onApproved: approvalSoundNotifier.notifyApproved,
    // FACTORY-581 SAFETY GUARD 3: attributes a managed-session pane's "no
    // longer blocked" line to THIS pass, tagged with drovr's own
    // `recognizedVia` — see `Escalator.onPermissionAnswered`'s own doc
    // comment (src/agents/escalation-loop.ts). A no-op for every
    // non-managed-session pane.
    onAnswered: (r) => escalator.onPermissionAnswered(r.paneId, r.recognizedVia),
    // FACTORY-752 (FACTORY-746 (c)): see `permissionAnswerHealth`'s own
    // declaration above and `createTickHealth`'s doc comment for the full
    // reasoning — never called together for the same tick.
    onTickSuccess: () => permissionAnswerHealth.recordSuccess(),
    onTickError: (e) => permissionAnswerHealth.recordError(e),
    subscribe: subscribeAgentStatus,
    // FACTORY-722 fix-scope item (d): the watchdog's own journal line
    // (`[watchdog] restarted permission-answer`, permission-answer-watch.ts)
    // already fires on every trip regardless of alert routing below —
    // deduped per trip set of pane ids, so a watchdog that keeps tripping on
    // the SAME stuck panes doesn't spam the room every 30s check.
    onWatchdogTripped: (stuckPaneIds) => opsAlertRouter.raise({
      key: `permission-answer-watchdog:${stuckPaneIds.slice().sort().join(",")}`,
      condition: "permission-answer-watchdog",
      subject: "permission-answer watch",
      reason: `${stuckPaneIds.length} pane(s) blocked with a push trigger unconsumed for over 5 minutes — forced a resubscribe and tick restart: ${stuckPaneIds.join(", ")}`,
      remedy: "Check journalctl for '[permission-answer]'/'[watchdog]' lines and whether herdr itself is healthy; if this keeps tripping, the daemon may need a restart.",
    }),
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

// BUTCHR-305/BUTCHR-238/FACTORY-941: audible-only pinned-active detection
// for the project/manager tier — see src/agents/pinned-active.ts's own top
// comment for the full derivation of why this shape (a resource both
// `desired` "active" and `running`, with its agent stopped acting) is
// invisible to every other detector, and why it is wired into the PROJECT
// loop only (the issue tier already covers the same phenomenon via
// `syncLabels`/`stallRemediation` above). `minutesFor` resolves per-id from
// `pinnedActiveMinutesByProject`, refreshed each poll by the
// `projectType.discovery.search` wrap further down (see that wrap's own
// comment for why NOT `syncLabels`, unlike the issue tier's
// `updateIdlePokeRuleConfig`). `addComment`/
// `comments` decode `id` (a full `ProjectMatch.agentKey`) to its bare
// project key via `resourceKeyOf` before reaching Jira/Confluence — neither
// `speakOnOwnChannel` nor `ownChannelComments` understands an encoded
// agentKey (see `issueCrashLoopDetector`'s own identical `resourceKeyOf`
// wrapping above for the established precedent).
const pinnedActiveDetector = createPinnedActiveDetector({
  now: () => Date.now(),
  minutes: config.stalledMinutes,
  minutesFor: (id) => pinnedActiveMinutesByProject.get(id),
  agentStatuses,
  addComment: async (id, text) => { await speakOnOwnChannel(ops, resourceKeyOf(id), text); },
  comments: (id) => ownChannelComments(resourceKeyOf(id)),
  quotaBlocked: (id) => herd.resourceQuotaBlocked(resourceKeyOf(id)) || quotaGate.blockedIds().some((qid) => resourceKeyOf(qid) === resourceKeyOf(id)),
  log: (line) => console.error(`  [pinned-active] ${line}`),
});

// Free-form jira-project resource agents (BUTCHR-425): no ticket, Confluence,
// or boss/worker workflow — just discovery (matching Jira projects), spawn,
// and residency/admission, sharing the same host cap and herd namespace as
// every other rule provider. Always sentinels (src/agents/capacity-role.ts),
// so admission never withholds one regardless of `config.maxAgents`.
const projectType = createJiraProjectResourceType({
  rules: getRules(),
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
// FACTORY-941: refresh `pinnedActiveMinutesByProject` from this exact poll's
// matches BEFORE `runResourceLoop` (src/daemon/loop.ts) ever reaches
// `reconcileNow`/`checkPinnedActive` above — `discovery.search()` is the
// first thing each poll calls (ahead of `reconcileNow`, which in turn runs
// ahead of `syncLabels` — see that file's own call order), so wrapping it
// here, rather than updating from `syncLabels` the way
// `updateIdlePokeRuleConfig` does for the issue tier, is what keeps this
// map current for the SAME poll's `checkPinnedActive` call rather than one
// poll stale. `pinnedActiveMinutesFor` itself lives in jira-project-type.ts
// (exported there, unit-tested directly) — this wrap is only the glue that
// refreshes the module-level binding `pinnedActiveDetector.minutesFor`
// reads above.
const projectDiscoverySearch = projectType.discovery.search;
projectType.discovery.search = async () => {
  const matches = await projectDiscoverySearch();
  pinnedActiveMinutesByProject = pinnedActiveMinutesFor(matches);
  return matches;
};
runResourceLoop(projectType, {
  herd,
  ownsId: ownsJiraProjectAgent,
  // Free-form: no notification concept (eventRules.poll always reports no
  // changes — see jira-project-type.ts), and no respawn ticket to comment on.
  notify: async () => {},
  onRespawn: async (id, reason) => { console.error(`  [jira-project] ${id} respawned: ${reason}`); },
  // No labels to sync; the only per-poll bookkeeping is retiring MCP
  // connections for agents that dropped out of this poll's matches. The
  // pinned-active minutes refresh (FACTORY-941) is NOT done here: `syncLabels`
  // runs AFTER `reconcileNow` (src/daemon/loop.ts's own call order), which is
  // too late for `checkPinnedActive` below to see this poll's rule matches —
  // see the `projectType.discovery.search` wrap above instead.
  syncLabels: async (matches) => { await resourceConnections.retain(new Set(matches.map((m) => m.agentKey))); return new Set<string>(); },
  checkPinnedActive: pinnedActiveDetector.check,
  admission: (candidates, stopping) => admissionController.admit(candidates, stopping, ADMISSION_SOURCE_JIRA_PROJECT),
  onAdmitted: admissionController.recordSpawned,
  reserveAdmission: (ids) => admissionController.reserve(ids, ADMISSION_SOURCE_JIRA_PROJECT),
  releaseAdmission: (ids) => admissionController.release(ids, ADMISSION_SOURCE_JIRA_PROJECT),
  intervalMs: 60_000,
  log: (line) => console.error(`  [jira-project] ${line}`),
  onPollSuccess: () => jiraProjectHealth.recordSuccess(),
  onError: (e) => { jiraProjectHealth.recordError(e); console.error(`  [jira-project] ${String(e)}`); },
});
