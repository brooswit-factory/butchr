/**
 * FACTORY-666 — dashboard agent control: start, stop, shelve, adopt and
 * prioritize a fleet worker ticket from the web UI instead of the CLI/MCP.
 * `src/web/view.ts` wires these to HTTP (guards, confirm/audit plumbing,
 * rate limiting); nothing in this file knows about Elysia, Origin headers
 * or CSRF.
 *
 * REUSE, NOT RE-DERIVATION: every Jira-side effect reuses the EXACT same
 * functions the MCP tools (`start_worker`/`shelve_worker`/`adopt_worker`/
 * `prioritize_worker`, `src/tools/relationship.ts`) already call — this
 * module adds NO second implementation of ownership checks, label
 * bookkeeping, or Jira writes. The one thing an MCP call has that an
 * operator's dashboard click does not is a `callerKey` (the calling agent's
 * OWN ticket, verified as the worker's boss) — for start/shelve/prioritize
 * this module derives that caller key automatically from the worker's own
 * CURRENT boss (`resolveBoss`, `../tools/docs.js`, the same Implements-link-
 * then-parent-fallback resolution `assertOwnWorker` itself uses), so the
 * dashboard acts "as" the ticket's own boss rather than needing the operator
 * to type one in. `adopt` is the one action with no current boss to derive
 * (that is the whole point of adopting) — the operator supplies the new
 * boss key directly, same as the MCP `adopt_worker` call would receive as
 * its own `callerKey`.
 *
 * STOP IS A DIFFERENT KIND OF ACTION: there is no `stop_worker` MCP tool.
 * Stopping a RUNNING AGENT PROCESS is a herdr/process concern, not a Jira
 * state concern, and the fleet reconcile loop already has exactly one
 * public, idempotent primitive for it — `Herd.stop(issue)` (`./herd.ts`),
 * the same call `resumeInPlaceExclusive`'s own failure paths use before a
 * respawn. This module calls that directly; it does not touch Jira at all
 * for stop (the worker ticket's status is whatever it already was — a stop
 * only kills the process, it never, by itself, moves or labels the ticket).
 */
import type { AtlassianOps } from "../tools/atlassian.js";
import { resolveBoss } from "../tools/docs.js";
import { startWorker, shelveWorker, adoptWorker, prioritizeWorker, type Disposition, type Roles } from "../tools/relationship.js";
import { Refusal } from "../tools/outcome.js";
import type { Herd } from "./herd.js";

export interface AgentWriteDeps {
  ops: AtlassianOps;
  herd: Pick<Herd, "stop" | "paneFor">;
  /** `config.assignees` — see `Roles`' own doc comment (`../tools/relationship.ts`) for why this is a structural (not imported) duplicate of `AssigneeRoles`, `../tools/defs.ts`. */
  roles: Roles;
}

function fieldsOf(issue: unknown): Record<string, unknown> {
  const f = (issue as { fields?: unknown } | undefined)?.fields;
  return f && typeof f === "object" ? (f as Record<string, unknown>) : {};
}
function issueTypeNameOf(issue: unknown): string | undefined {
  const t = fieldsOf(issue).issuetype as { name?: unknown } | undefined;
  return typeof t?.name === "string" ? t.name : undefined;
}
function statusNameOf(issue: unknown): string | undefined {
  const s = fieldsOf(issue).status as { name?: unknown } | undefined;
  return typeof s?.name === "string" ? s.name : undefined;
}
function summaryOf(issue: unknown): string | undefined {
  const s = fieldsOf(issue).summary;
  return typeof s === "string" ? s : undefined;
}
function labelsOf(issue: unknown): string[] {
  const l = fieldsOf(issue).labels;
  return Array.isArray(l) ? l.filter((x): x is string => typeof x === "string") : [];
}

/** A refusal from the underlying operation (ownership, a missing reason, an unknown Jira value, …) — ALWAYS operator-actionable text, reached verbatim by the HTTP layer. Never a generic 500: a thrown `Refusal` (or any other error from the underlying op/Jira call) is caught here and turned into this same shape. */
export type AgentWriteOutcome =
  | { ok: true; [key: string]: unknown }
  | { ok: false; status: number; error: string; confirmReason?: string };

async function resolveCallerBoss(deps: AgentWriteDeps, workerKey: string): Promise<{ ok: true; boss: string; issue: unknown } | { ok: false; status: number; error: string }> {
  let issue: unknown;
  try {
    issue = await deps.ops.getIssue(workerKey);
  } catch (e) {
    return { ok: false, status: 404, error: `could not read ${workerKey}: ${(e as Error).message}` };
  }
  const resolution = resolveBoss(issue, issueTypeNameOf(issue));
  if (!resolution.boss) {
    return { ok: false, status: 409, error: `${workerKey} has no boss (no Implements link and no eligible Jira parent) — adopt it first with a boss key before starting, shelving or prioritizing it` };
  }
  return { ok: true, boss: resolution.boss, issue };
}

function fromThrown(e: unknown): { status: number; error: string } {
  const error = (e as Error)?.message ?? String(e);
  return { status: e instanceof Refusal ? 409 : 502, error };
}

/** Read-only snapshot for the dashboard's agent-control panel — the worker ticket's own Jira state plus whether it currently has a running agent. Never throws: a Jira read failure is reported as `ok: false`, same discipline every other dashboard data route in this daemon follows. */
export async function agentSnapshot(deps: AgentWriteDeps, issue: string): Promise<AgentWriteOutcome> {
  let jiraIssue: unknown;
  try {
    jiraIssue = await deps.ops.getIssue(issue);
  } catch (e) {
    return { ok: false, status: 404, error: `could not read ${issue}: ${(e as Error).message}` };
  }
  const pane = await deps.herd.paneFor(issue);
  const resolution = resolveBoss(jiraIssue, issueTypeNameOf(jiraIssue));
  return {
    ok: true,
    key: issue,
    status: statusNameOf(jiraIssue) ?? null,
    summary: summaryOf(jiraIssue) ?? null,
    labels: labelsOf(jiraIssue),
    boss: resolution.boss,
    running: pane !== null,
    pane,
  };
}

/** `start_worker`'s own effect (status -> In Progress, clears a stale shelved-exemption label), called under the worker's OWN current boss — never destructive (nothing stops or changes irreversibly), so no confirm step. Where the operator sees this take effect: the Jira transition is immediate, but admission into a RUNNING agent still goes through the daemon's own capacity-capped reconcile poll — see this route's own "takes effect after the next poll" UI note (`src/web/view.ts`). */
export async function doAgentStart(deps: AgentWriteDeps, issue: string): Promise<AgentWriteOutcome> {
  const boss = await resolveCallerBoss(deps, issue);
  if (!boss.ok) return boss;
  try {
    await startWorker(deps.ops, boss.boss, issue);
    return { ok: true, key: issue, startedUnderBoss: boss.boss };
  } catch (e) {
    return { ok: false, ...fromThrown(e) };
  }
}

/** Report-only — never kills anything. `requiresConfirm: true` whenever there IS a running agent to stop (the ordinary first step); a genuine refusal (nothing running) is reported the same way a rejected write is, since there is nothing here for a client to usefully confirm into. */
export async function planAgentStop(deps: AgentWriteDeps, issue: string): Promise<AgentWriteOutcome> {
  const pane = await deps.herd.paneFor(issue);
  if (!pane) return { ok: false, status: 409, error: `no running agent for ${issue} to stop` };
  return { ok: true, requiresConfirm: true, confirmReason: "agent-stop", preview: { key: issue, pane } };
}

/** `Herd.stop(issue)` (`./herd.ts`) — idempotent, already the production primitive the reconcile loop itself uses before a respawn. Touches herdr only, never Jira: the worker ticket's own status/labels are whatever they already were. */
export async function doAgentStop(deps: AgentWriteDeps, issue: string): Promise<AgentWriteOutcome> {
  const pane = await deps.herd.paneFor(issue);
  if (!pane) return { ok: false, status: 409, error: `no running agent for ${issue} to stop` };
  await deps.herd.stop(issue);
  return { ok: true, key: issue, stoppedPane: pane };
}

/** Report-only — never writes. Refuses up front (same refusal `shelve_worker` itself throws) on an empty `reason`, and on a worker with no derivable boss, before ever naming a `confirmReason` a client could mistake for "go ahead". */
export async function planAgentShelve(deps: AgentWriteDeps, issue: string, reason: string): Promise<AgentWriteOutcome> {
  if (!reason.trim()) return { ok: false, status: 400, error: `shelve: a reason is required — an activation condition nobody wrote down is indistinguishable six weeks later from a ticket somebody forgot` };
  const boss = await resolveCallerBoss(deps, issue);
  if (!boss.ok) return boss;
  return { ok: true, requiresConfirm: true, confirmReason: "agent-shelve", preview: { key: issue, boss: boss.boss, reason } };
}

/** `shelve_worker`'s own effect (label, then transition to To Do, then the reason as a comment), under the worker's own current boss. */
export async function doAgentShelve(deps: AgentWriteDeps, issue: string, reason: string): Promise<AgentWriteOutcome> {
  if (!reason.trim()) return { ok: false, status: 400, error: `shelve: a reason is required — an activation condition nobody wrote down is indistinguishable six weeks later from a ticket somebody forgot` };
  const boss = await resolveCallerBoss(deps, issue);
  if (!boss.ok) return boss;
  try {
    await shelveWorker(deps.ops, boss.boss, issue, reason);
    return { ok: true, key: issue, shelvedUnderBoss: boss.boss, reason };
  } catch (e) {
    return { ok: false, ...fromThrown(e) };
  }
}

export interface AdoptInput {
  bossKey: string;
  disposition: "start" | "shelve";
  /** Required (and must be non-empty) when `disposition === "shelve"` — see `shelveWorker`'s own refusal for why. Ignored for `"start"`. */
  reason?: string;
}

/**
 * FACTORY-666 (AC7) — the route-level body-shape validators, exported here
 * (not left as inline `typeof` checks buried in `src/web/view.ts`) SO THAT
 * a test can feed the real dashboard-app client's own serialized request
 * body straight into the SAME function the route calls — the exact
 * cross-contract proof `validateRuleCreateInput` (`../rules/rules-write-
 * registry.ts`) already set the precedent for, after a client/route body-
 * shape mismatch once shipped a route unreachable from the real UI. Each
 * one is a pure, no-I/O shape check; the business logic above (reason
 * required, confirm required for stop/shelve, …) stays in this module's
 * own `plan*`/`do*` functions, never duplicated here.
 */
export function validateStopRequestBody(body: unknown): { ok: true; confirm: boolean } | { ok: false; error: string } {
  if (body === null || body === undefined) return { ok: true, confirm: false };
  if (typeof body !== "object") return { ok: false, error: "body must be an object with an optional confirm: boolean" };
  const b = body as Record<string, unknown>;
  if ("confirm" in b && typeof b.confirm !== "boolean") return { ok: false, error: "confirm must be a boolean" };
  return { ok: true, confirm: b.confirm === true };
}

export function validateShelveRequestBody(body: unknown): { ok: true; reason: string; confirm: boolean } | { ok: false; error: string } {
  const error = "body must include reason: string (and optional confirm: boolean)";
  if (!body || typeof body !== "object") return { ok: false, error };
  const b = body as Record<string, unknown>;
  if (typeof b.reason !== "string") return { ok: false, error };
  if ("confirm" in b && typeof b.confirm !== "boolean") return { ok: false, error };
  return { ok: true, reason: b.reason, confirm: b.confirm === true };
}

export function validateAdoptRequestBody(body: unknown): { ok: true; input: AdoptInput } | { ok: false; error: string } {
  const error = `body must include bossKey: string and disposition: "start" | "shelve" (plus reason: string for "shelve")`;
  if (!body || typeof body !== "object") return { ok: false, error };
  const b = body as Record<string, unknown>;
  if (typeof b.bossKey !== "string" || b.bossKey.length === 0) return { ok: false, error };
  if (b.disposition !== "start" && b.disposition !== "shelve") return { ok: false, error };
  if ("reason" in b && b.reason !== undefined && typeof b.reason !== "string") return { ok: false, error };
  return { ok: true, input: { bossKey: b.bossKey, disposition: b.disposition, reason: typeof b.reason === "string" ? b.reason : undefined } };
}

export function validatePrioritizeRequestBody(body: unknown): { ok: true; priority: string } | { ok: false; error: string } {
  const error = "body must include priority: string";
  if (!body || typeof body !== "object") return { ok: false, error };
  const b = body as Record<string, unknown>;
  if (typeof b.priority !== "string" || b.priority.length === 0) return { ok: false, error };
  return { ok: true, priority: b.priority };
}

/** `adopt_worker`'s own effect, called with the OPERATOR-SUPPLIED `bossKey` — the one action in this module with no current boss to derive (that is the entire point of adopting). Not flagged destructive in this ticket's scope (it only ever gains a ticket a boss/disposition it did not have, or confirms one it already has — see `adoptWorker`'s own idempotence contract), so no confirm step. */
export async function doAgentAdopt(deps: AgentWriteDeps, issue: string, input: AdoptInput): Promise<AgentWriteOutcome> {
  if (input.disposition === "shelve" && !(input.reason ?? "").trim()) {
    return { ok: false, status: 400, error: `adopt: a reason is required for disposition "shelve" — an activation condition nobody wrote down is indistinguishable six weeks later from a ticket somebody forgot` };
  }
  const disposition: Disposition = input.disposition === "shelve" ? { kind: "shelve", reason: input.reason!.trim() } : { kind: "start" };
  try {
    const result = await adoptWorker(deps.ops, deps.roles, input.bossKey, issue, disposition);
    return { ok: true, ...result };
  } catch (e) {
    return { ok: false, ...fromThrown(e) };
  }
}

/** `prioritize_worker`'s own effect, under the worker's own current boss — it, not the operator, is the one whose "judgment" the priority records, exactly as the MCP tool's own doc comment frames it; this route is simply how that judgment reaches Jira without an agent session. */
export async function doAgentPrioritize(deps: AgentWriteDeps, issue: string, priority: string): Promise<AgentWriteOutcome> {
  if (!priority.trim()) return { ok: false, status: 400, error: `prioritize: priority is required` };
  const boss = await resolveCallerBoss(deps, issue);
  if (!boss.ok) return boss;
  try {
    await prioritizeWorker(deps.ops, boss.boss, issue, priority);
    return { ok: true, key: issue, priority };
  } catch (e) {
    return { ok: false, ...fromThrown(e) };
  }
}
