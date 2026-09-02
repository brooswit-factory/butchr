import { join } from "node:path";
import { workspaceRoot } from "../agents/workspace.js";

/**
 * Butchr's configuration, parsed from the environment once at startup.
 *
 * The Atlassian credential is a classic API token used as HTTP Basic auth
 * (`email:token`). The token is read from `ATLASSIAN_TOKEN`, or — preferred —
 * from a file named by `ATLASSIAN_TOKEN_FILE`, so it never has to sit in the
 * process environment or a shell history.
 */
export interface Config {
  atlassian: { site: string; email: string; token: string };
  /** Port the daemon serves the MCP endpoint and the live-view webapp on. */
  port: number;
  /** herdr socket; defaults to herdr's own default when unset. */
  herdrSocket?: string;
  /** Terminal-emulator prefix for opening an agent shell; detected at startup if unset. */
  terminalPrefix?: string[];
  /**
   * GitHub PR discovery (pr:* labels). Both a token and at least one org are
   * required — an unscoped GitHub search spans all of GitHub, not just ours —
   * so this is present only when BOTH GITHUB_TOKEN_FILE and
   * BUTCHR_GITHUB_ORGS are set; otherwise pr:* discovery is skipped entirely.
   */
  github?: { token: string; orgs: string[] };
  /**
   * KAN-804/807: minutes an active ticket's agent must sit idle/done,
   * continuously since first observed running, with zero comments from this
   * account, before it's surfaced as `agent:stalled` — a swallowed kickoff
   * "idle since spawn, never spoke" must never look like a finished agent.
   */
  stalledMinutes: number;
  /**
   * BUTCHR-24: minutes a staffed child must sit continuously in To Do under
   * a live (In Progress) boss before the parked-ticket detector's stage 1
   * escalation comment fires (see src/agents/parked.ts) — also the interval
   * between each subsequent stage. Default 10.
   */
  parkedMinutes: number;
  /**
   * BUTCHR-95/123: minutes a resource must read `"asleep"` with its agent
   * STILL RUNNING, continuously, before `atRest` (src/reconcile/plan.ts)
   * stops protecting it indefinitely and the frozen-asleep detector (see
   * src/agents/frozen-asleep.ts) posts its complaint and marks it reapable.
   * Default 10, same family as `stalledMinutes`/`parkedMinutes` above and
   * for the same reason: the race this bounds (a woken agent's
   * advance-watermark-then-exit) is milliseconds to seconds, and the
   * project tier's own poll cadence (`PROJECT_POLL_INTERVAL_MS`,
   * src/resources/project.ts — 5 minutes, the only resource type this can
   * ever fire for today) is far shorter than 10 minutes too — so a
   * genuinely-exiting agent clears the resting-and-running state within one
   * poll, nowhere near this bound, while 10 minutes still guarantees at
   * least one full extra 5-minute poll cycle of margin before a real freeze
   * is ever reported, rather than tripping on the very first poll to
   * observe it.
   */
  atRestMinutes: number;
  /**
   * BUTCHR-5/16: minutes a pane's herdr status must read idle/done,
   * CONTINUOUSLY, before its text is even read to check for an end-of-pane
   * dialog herdr's own classification missed (the second, herdr-independent
   * blocked-detector — see src/agents/idle-dialog.ts). Default 2: short
   * enough that a real freeze is caught fast, long enough that a normal
   * end-of-turn idle blip (which resolves within seconds, long before the
   * next 5s poll even lands) never trips it. The asymmetry that sets this
   * bound: escalating a dialog we could have answered costs one Jira
   * notification; failing to escalate one we cannot answer costs hours times
   * the number of agents sitting on it (measured: ~12 hours × 5 agents on
   * 2026-08-30, the incident this ticket exists to close) — so this stays
   * deliberately short rather than "safely" long.
   */
  idleDialogMinutes: number;
  /**
   * BUTCHR-18/BUTCHR-6: how long, in ms, `/health` tolerates the poll loop
   * going without a successfully-completed cycle before reporting it stale —
   * also doubles as the startup grace period (see src/daemon/health.ts).
   * Default 60_000 (a 4x multiple of the loop's 15s `intervalMs`, src/daemon/
   * index.ts): a small multiple, not 15s exactly, so one slow Jira call
   * doesn't flap it red.
   */
  pollStaleMs: number;
  /**
   * Role -> Atlassian accountId, for staffing `jira_create_issue` by
   * issuetype. All three are optional so a daemon that only ever reads Jira
   * still boots; the refusal for an unstaffable Story/Task/Epic happens
   * per-call, at create time (see src/tools/defs.ts), not here. `epic`
   * (BUTCHR-71) staffs the Epic a PROJECT caller's `new_worker`/
   * `adopt_worker` creates or adopts — DELIBERATELY never falls back to
   * `story`/`task` (or vice versa): the epic tier and the project tier must
   * NOT resolve to the same Atlassian account, because a project approving
   * an epic (`finish_worker`/`tell_worker`) is the cross-account review hop
   * the whole project-tier identity design exists for, and GitHub will not
   * accept a PR approval from the PR's own author.
   */
  assignees: { story?: string; task?: string; epic?: string };
  /**
   * BUTCHR-12: directory the session-limit watcher's evidence captures land
   * in. Default `.captures` under the workspace root — dot-prefixed so it
   * can never collide with a per-issue workspace directory (issue keys are
   * `[A-Z]+-\d+`, never dot-prefixed).
   */
  captureDir: string;
  /**
   * BUTCHR-91/BUTCHR-68: the project tier's opt-in staffing scope — a
   * project key must appear here to ever be staffed (see
   * `src/resources/project.ts`'s `ProjectResourceDeps.allowlist`, the one
   * place this is actually enforced). Default EMPTY, deliberately: this
   * ticket's whole hazard is that the shipped discovery+activation code
   * verdicts every led-and-eligible project `"active"` on its very first
   * poll (no project on this site has ever been checked in on), so an
   * unset `BUTCHR_PROJECT_ALLOWLIST` must staff zero projects on deploy —
   * enabling one is a deliberate env-var edit plus a restart, never a
   * silent side effect of this commit landing. Comma-separated project
   * keys, same shape as `BUTCHR_GITHUB_ORGS` above.
   */
  projectAllowlist: string[];
}

export interface ConfigEnv {
  ATLASSIAN_SITE?: string | undefined;
  ATLASSIAN_EMAIL?: string | undefined;
  ATLASSIAN_TOKEN?: string | undefined;
  ATLASSIAN_TOKEN_FILE?: string | undefined;
  BUTCHR_PORT?: string | undefined;
  HERDR_SOCKET?: string | undefined;
  BUTCHR_TERMINAL?: string | undefined;
  GITHUB_TOKEN_FILE?: string | undefined;
  BUTCHR_GITHUB_ORGS?: string | undefined;
  BUTCHR_STALLED_MINUTES?: string | undefined;
  BUTCHR_PARKED_MINUTES?: string | undefined;
  BUTCHR_ATREST_MINUTES?: string | undefined;
  BUTCHR_IDLE_DIALOG_MINUTES?: string | undefined;
  BUTCHR_POLL_STALE_MS?: string | undefined;
  BUTCHR_ASSIGNEE_STORY?: string | undefined;
  BUTCHR_ASSIGNEE_TASK?: string | undefined;
  BUTCHR_ASSIGNEE_EPIC?: string | undefined;
  BUTCHR_CAPTURE_DIR?: string | undefined;
  BUTCHR_PROJECT_ALLOWLIST?: string | undefined;
}

/** `readFile` is injected so config parsing stays pure and testable. */
export function loadConfig(env: ConfigEnv, readFile: (path: string) => string): Config {
  const site = required(env.ATLASSIAN_SITE, "ATLASSIAN_SITE").replace(/\/+$/, "");
  const email = required(env.ATLASSIAN_EMAIL, "ATLASSIAN_EMAIL");
  const token = env.ATLASSIAN_TOKEN_FILE
    ? readFile(env.ATLASSIAN_TOKEN_FILE).trim()
    : required(env.ATLASSIAN_TOKEN, "ATLASSIAN_TOKEN (or ATLASSIAN_TOKEN_FILE)");
  if (!token) throw new Error("Atlassian token is empty");

  const port = env.BUTCHR_PORT ? Number(env.BUTCHR_PORT) : 7717;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`BUTCHR_PORT is not a valid port: ${env.BUTCHR_PORT}`);

  const githubToken = env.GITHUB_TOKEN_FILE ? readFile(env.GITHUB_TOKEN_FILE).trim() : undefined;
  const githubOrgs = env.BUTCHR_GITHUB_ORGS ? env.BUTCHR_GITHUB_ORGS.split(",").map((o) => o.trim()).filter(Boolean) : [];
  const github = githubToken && githubOrgs.length ? { token: githubToken, orgs: githubOrgs } : undefined;

  const stalledMinutes = env.BUTCHR_STALLED_MINUTES ? Number(env.BUTCHR_STALLED_MINUTES) : 10;
  if (!Number.isFinite(stalledMinutes) || stalledMinutes <= 0) throw new Error(`BUTCHR_STALLED_MINUTES is not a positive number: ${env.BUTCHR_STALLED_MINUTES}`);

  const parkedMinutes = env.BUTCHR_PARKED_MINUTES ? Number(env.BUTCHR_PARKED_MINUTES) : 10;
  if (!Number.isFinite(parkedMinutes) || parkedMinutes <= 0) throw new Error(`BUTCHR_PARKED_MINUTES is not a positive number: ${env.BUTCHR_PARKED_MINUTES}`);

  const atRestMinutes = env.BUTCHR_ATREST_MINUTES ? Number(env.BUTCHR_ATREST_MINUTES) : 10;
  if (!Number.isFinite(atRestMinutes) || atRestMinutes <= 0) throw new Error(`BUTCHR_ATREST_MINUTES is not a positive number: ${env.BUTCHR_ATREST_MINUTES}`);

  const idleDialogMinutes = env.BUTCHR_IDLE_DIALOG_MINUTES ? Number(env.BUTCHR_IDLE_DIALOG_MINUTES) : 2;
  if (!Number.isFinite(idleDialogMinutes) || idleDialogMinutes <= 0) throw new Error(`BUTCHR_IDLE_DIALOG_MINUTES is not a positive number: ${env.BUTCHR_IDLE_DIALOG_MINUTES}`);
  const pollStaleMs = env.BUTCHR_POLL_STALE_MS ? Number(env.BUTCHR_POLL_STALE_MS) : 60_000;
  if (!Number.isFinite(pollStaleMs) || pollStaleMs <= 0) throw new Error(`BUTCHR_POLL_STALE_MS is not a positive number: ${env.BUTCHR_POLL_STALE_MS}`);

  const assigneeStory = env.BUTCHR_ASSIGNEE_STORY?.trim();
  const assigneeTask = env.BUTCHR_ASSIGNEE_TASK?.trim();
  const assigneeEpic = env.BUTCHR_ASSIGNEE_EPIC?.trim();

  const captureDir = env.BUTCHR_CAPTURE_DIR?.trim() || join(workspaceRoot(), ".captures");

  const projectAllowlist = env.BUTCHR_PROJECT_ALLOWLIST ? env.BUTCHR_PROJECT_ALLOWLIST.split(",").map((k) => k.trim()).filter(Boolean) : [];

  return {
    atlassian: { site, email, token },
    port,
    stalledMinutes,
    parkedMinutes,
    atRestMinutes,
    idleDialogMinutes,
    pollStaleMs,
    ...(env.HERDR_SOCKET ? { herdrSocket: env.HERDR_SOCKET } : {}),
    ...(env.BUTCHR_TERMINAL ? { terminalPrefix: env.BUTCHR_TERMINAL.trim().split(/\s+/).filter(Boolean) } : {}),
    ...(github ? { github } : {}),
    assignees: {
      ...(assigneeStory ? { story: assigneeStory } : {}),
      ...(assigneeTask ? { task: assigneeTask } : {}),
      ...(assigneeEpic ? { epic: assigneeEpic } : {}),
    },
    captureDir,
    projectAllowlist,
  };
}

function required(v: string | undefined, name: string): string {
  if (!v || !v.trim()) throw new Error(`Missing required config: ${name}`);
  return v.trim();
}

/** AccountIds are not secrets; truncate them only for readability, never redact. */
const truncAccountId = (id: string): string => (id.length > 11 ? `${id.slice(0, 11)}…` : id);

/** Names the consequence, not just the fact of being unset — an operator should see this before an agent trips over it. */
const describeRole = (role: "Story" | "Task" | "Epic", id: string | undefined): string =>
  id ? truncAccountId(id) : `unset — ${role} creation will be refused`;

type Role = "story" | "task" | "epic";
const ROLE_ENV_VAR: Record<Role, string> = { story: "BUTCHR_ASSIGNEE_STORY", task: "BUTCHR_ASSIGNEE_TASK", epic: "BUTCHR_ASSIGNEE_EPIC" };
/** Ranks a role by hierarchy depth so a colliding pair can be named as "the OWNER that owns this OWNED" rather than an unordered set — matches the phrasing new_worker/adopt_worker's own S1 collision message uses (src/tools/relationship.ts). */
const ROLE_RANK: Record<Role, number> = { epic: 0, story: 1, task: 2 };

/**
 * BUTCHR-110/S2: every pair among the SET roles whose accountId is
 * IDENTICAL — unset is a DIFFERENT condition (see `describeRole` above,
 * unaffected by this) and is never reported here. Pairwise across exactly
 * {story, task, epic}: the project↔epic hop is deliberately NOT compared
 * here (see `describeConfig`'s own honesty clause below for why, and why
 * that omission must be STATED rather than silent).
 */
function collidingRolePairs(assignees: Config["assignees"]): Array<[Role, Role]> {
  const set = (Object.keys(ROLE_ENV_VAR) as Role[]).filter((r) => assignees[r]);
  const pairs: Array<[Role, Role]> = [];
  for (let i = 0; i < set.length; i++) {
    for (let j = i + 1; j < set.length; j++) {
      const a = set[i]!;
      const b = set[j]!;
      if (assignees[a] === assignees[b]) pairs.push([a, b]);
    }
  }
  return pairs;
}

/**
 * BUTCHR-110/S2 — THE HONESTY CLAUSE, the graded part of this check
 * (measured by BUTCHR-100, 2026-09-02): a daemon whose LOCAL role map has
 * only STORY and TASK set, both different accounts, reports a clean boot
 * under a naive pairwise comparison — even when a live Epic in the SAME
 * fleet, staffed by a DIFFERENT daemon under a different Unix user, carries
 * an assignee identical to this daemon's task role. This daemon's role map
 * has no epic entry at all, so it has nothing local to compare that Epic
 * against — the collapsed epic↔task hop is real and this check cannot see
 * it. A clean report is read as "checked and safe", so the clean case is
 * exactly the one that must not be silent about what it did not look at.
 * This clause is therefore ALWAYS present — collision or none — never only
 * alongside a finding (a clause that only shows up when there's a problem
 * is decoration, not honesty).
 *
 * Also carries the (weaker, still true) per-daemon scoping: the role map is
 * per-daemon and two daemons in this fleet have been observed to disagree
 * about it, so a line that reads as a statement about "the fleet" would be
 * plausible-but-wrong for a reader on a different daemon.
 *
 * DELIBERATELY DOES NOT CLOSE THE GAP: the project↔epic hop's caller side is
 * this daemon's Atlassian CREDENTIAL, whose accountId is not known without a
 * Jira call (`ops.getMyself()`), and this function — like all of
 * `loadConfig`/`describeConfig` — is pure and synchronous by design. Adding
 * a Jira call here is out of scope (BUTCHR-103, reaffirmed on this ticket).
 * The OPTIONAL bounded improvement the ticket allows — comparing each
 * configured role against the accountId this daemon itself runs as, if that
 * accountId falls out of a call already made at startup — is SKIPPED: as of
 * this change, `src/daemon/index.ts` calls `describeConfig` synchronously,
 * directly after `app.listen`, before any Atlassian call of any kind (the
 * first `ops.getMyself()` in this codebase runs later, inside the project
 * resource loop's own poll — async, and gated behind a non-empty
 * `BUTCHR_PROJECT_ALLOWLIST` besides). Taking the improvement would mean
 * adding a call and/or moving this check out of the pure rendering
 * function, both explicitly out of scope here — so it is skipped, and S1
 * (`new_worker`/`adopt_worker`, src/tools/relationship.ts) remains the check
 * that actually catches the project↔epic hop, and the case measured above.
 */
function describeCollisions(assignees: Config["assignees"]): string {
  const pairs = collidingRolePairs(assignees);
  const hopLines = pairs.map(([a, b]) => {
    const [owner, owned] = ROLE_RANK[a] < ROLE_RANK[b] ? [a, b] : [b, a];
    return (
      `${ROLE_ENV_VAR[a]} and ${ROLE_ENV_VAR[b]} (the ${a} and ${b} roles) are the SAME accountId on THIS daemon (${truncAccountId(assignees[a]!)}) — ` +
      `the ${owner} that owns a ${owned} will not be able to approve its PR: GitHub refuses an approval from the PR's own author`
    );
  });
  const found = hopLines.length ? hopLines.join("; ") : "none among this daemon's currently-SET roles";
  const honesty =
    "this compares LOCALLY CONFIGURED role variables ONLY; a tier staffed by a DIFFERENT daemon has no local variable here to compare against " +
    "(measured, BUTCHR-100 2026-09-02: a daemon with only story/task set can report clean while a live Epic staffed elsewhere collapses onto its task role); " +
    "a clean report here is NOT evidence every review hop on this Epic's fleet is sound — the project↔epic hop in particular is never checked here at all (no Jira call at config load); " +
    "new_worker/adopt_worker's own staffing-time check (S1) is what actually catches what this cannot";
  return `${found} — ${honesty}`;
}

/** Never logs a token value; use this to describe a config safely. */
export const describeConfig = (c: Config): string =>
  `site=${c.atlassian.site} email=${c.atlassian.email} token=***(${c.atlassian.token.length} chars) port=${c.port} ` +
  `github=${c.github ? `orgs=${c.github.orgs.join(",")} token=***(${c.github.token.length} chars)` : "disabled"} ` +
  `stalledMinutes=${c.stalledMinutes} parkedMinutes=${c.parkedMinutes} atRestMinutes=${c.atRestMinutes} idleDialogMinutes=${c.idleDialogMinutes} pollStaleMs=${c.pollStaleMs} ` +
  `assignees=story:${describeRole("Story", c.assignees.story)} task:${describeRole("Task", c.assignees.task)} epic:${describeRole("Epic", c.assignees.epic)} ` +
  `roleCollisions(this daemon only)=${describeCollisions(c.assignees)} ` +
  `captureDir=${c.captureDir} ` +
  `projectAllowlist=${c.projectAllowlist.length ? c.projectAllowlist.join(",") : "EMPTY — project tier staffs nothing"}`;
