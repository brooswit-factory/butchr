import type { AtlassianOps } from "./atlassian.js";
import { findBossKey, ensureDoc, JIRA_KEY_RE, type DocResult } from "./docs.js";
import { EXEMPT_LABEL } from "../agents/parked.js";
import { adfToText } from "../atlassian/client.js";
import { isProjectId } from "../resources/id.js";
import { speakOnOwnChannel } from "./speak.js";

/** Role -> Atlassian accountId, the same shape `jira_create_issue` staffs by (src/tools/defs.ts's `AssigneeRoles`). Duplicated here as a structural type, not imported, so this module has no runtime dependency on defs.ts (which imports THIS module to wire the tools) — see defs.ts for the wiring direction. `epic` (BUTCHR-71) staffs an Epic a PROJECT caller's `new_worker`/`adopt_worker` creates or adopts — the same per-call-refusal-when-unset shape `story`/`task` already have. */
export interface Roles {
  story?: string;
  task?: string;
  epic?: string;
}

/** `start`, or `shelve` with a reason. No default, no third option — see the glossary page's "two legitimate states of a new worker". */
export type Disposition = { kind: "start" } | { kind: "shelve"; reason: string };

/** Every agent comment on this channel is prefixed with its identity tag — the same idiom `jira_add_comment` uses (src/tools/defs.ts), duplicated here (not imported) to keep this module's only dependency on defs.ts-shaped types structural, never a runtime import back to it. */
function tagComment(who: string, text: string): string {
  const tag = `[${who}] `;
  return text.startsWith(`[${who}]`) ? text : tag + text;
}

/** Marks an `ask_boss` comment as a QUESTION AWAITING AN ANSWER — distinguishes it from a plain `report_to_boss`, and lets a boss find unanswered questions without reading every comment its workers wrote. Placed right after the identity tag. STATED HERE VERBATIM because BUTCHR-30's briefs need to quote it. */
export const ASK_MARKER = "[ask]";

/** The role env var that governs a given issuetype's staffing (src/config/config.ts's `Config.assignees`). Shared by `noRoleMsg` below and BUTCHR-110's collision messages so the two never drift apart on naming. */
function envVarFor(issuetype: "Story" | "Task" | "Epic"): string {
  return issuetype === "Story" ? "BUTCHR_ASSIGNEE_STORY" : issuetype === "Task" ? "BUTCHR_ASSIGNEE_TASK" : "BUTCHR_ASSIGNEE_EPIC";
}

function noRoleMsg(verb: string, issuetype: "Story" | "Task" | "Epic"): string {
  return `${verb}: no assignee for a ${issuetype} — set ${envVarFor(issuetype)} (an Atlassian accountId) on this daemon, or adopt/create it with an explicit assignee via jira_assign/jira_create_issue`;
}

function issuetypeOf(issue: unknown): string | undefined {
  return (issue as { fields?: { issuetype?: { name?: string } } })?.fields?.issuetype?.name;
}
function projectKeyOf(issue: unknown): string | undefined {
  return (issue as { fields?: { project?: { key?: string } } })?.fields?.project?.key;
}
function statusOf(issue: unknown): string | undefined {
  return (issue as { fields?: { status?: { name?: string } } })?.fields?.status?.name;
}
function assigneeAccountIdOf(issue: unknown): string | undefined {
  return (issue as { fields?: { assignee?: { accountId?: string } | null } })?.fields?.assignee?.accountId;
}
function labelsOf(issue: unknown): string[] {
  return (issue as { fields?: { labels?: string[] } })?.fields?.labels ?? [];
}
/** Jira's description field is ADF (a doc node), not plain text — flattened by the caller via `adfToText`, never here, so this stays a pure structural read like its siblings above. */
function descriptionOf(issue: unknown): unknown {
  return (issue as { fields?: { description?: unknown } })?.fields?.description;
}
function summaryOf(issue: unknown): string | undefined {
  return (issue as { fields?: { summary?: string } })?.fields?.summary;
}

/** An Epic's children are Stories, a Story's children are Tasks. A Task is the bottom of the hierarchy — no child type. */
const CHILD_TYPE: Record<string, "Story" | "Task"> = { Epic: "Story", Story: "Task" };

// ---------------------------------------------------------------------------
// BUTCHR-110: tier-identity collision — RECORD, never refuse (BUTCHR-103's
// decision). A boss (issue OR project tier) staffs a worker by assigning it
// an accountId drawn from this daemon's role map; when that accountId is the
// SAME as the boss's OWN accountId, the review hop between them is dead on
// arrival — `gh pr review --approve` refuses an approval from the PR's own
// author. Refusing the staffing call itself would deadlock the fleet (an
// agent has no permitted way to edit a BUTCHR_ASSIGNEE_* value), so instead
// this makes the collision LOUD: a result field, an audit line (written by
// the caller in src/tools/defs.ts, from the field this returns), and a
// durable comment on the worker's own ticket (written here, since only this
// module has the worker's key at the point the collision is known).
// ---------------------------------------------------------------------------

/** AccountIds are not secrets; truncated to match src/config/config.ts's own startup-banner format exactly (BUTCHR-110) — never invent a second truncation convention for the same value. */
const truncAccountId = (id: string): string => (id.length > 11 ? `${id.slice(0, 11)}…` : id);

type CollisionTier = "project" | "epic" | "story" | "task";

/**
 * One side of a possible collision. `describe` is a FULL CLAUSE naming
 * provenance, not just a variable name — BUTCHR-103's review of this ticket
 * (2026-09-02) rejected a bare `envVarFor(tier)` label on the CALLER side:
 * the caller's accountId is read from the caller's own TICKET, which can
 * differ from what that tier's role variable is currently set to (that is
 * the whole reason it's read from the ticket at all), so a label that reads
 * as "this variable produced this value" can name the WRONG variable to
 * fix — measured concretely on the exact daemon BUTCHR-100 already measured
 * for S2's honesty clause: `BUTCHR_ASSIGNEE_EPIC` UNSET locally, an Epic
 * staffed by a DIFFERENT daemon collides anyway, and a naive label would
 * tell an operator to edit a variable that governs nothing here and did not
 * produce the value shown. `describe` is therefore built by each call site,
 * which knows whether its own accountId truly came from a local role
 * variable (the CHILD side always does) or was merely observed on a ticket
 * (an ISSUE caller) or is this daemon's own credential (a PROJECT caller).
 */
interface CollisionSide {
  tier: CollisionTier;
  describe: string;
  accountId: string | undefined;
}

/** The CHILD side's accountId always comes straight from this daemon's own role map (it's what `ops.assign`/`ops.createIssue` was just called with) — "governs" is literally true here, unlike the caller side. */
function childSide(tier: "Epic" | "Story" | "Task", accountId: string | undefined): CollisionSide {
  return { tier: tier.toLowerCase() as CollisionTier, describe: `${envVarFor(tier)} (governs this daemon's ${tier.toLowerCase()} tier)`, accountId };
}

/**
 * The ISSUE-CALLER side. The accountId is OBSERVED on `callerKey`'s own
 * ticket, never asserted to have come FROM the local role variable for the
 * caller's tier — those can differ, which is the entire reason this reads
 * the ticket rather than the variable. `describe` states both facts
 * separately: where the value was actually observed, and what the local
 * variable for that tier is currently set to (or that it's unset here) —
 * so a reader can tell "the caller's actual identity" from "what this
 * daemon's config says that tier's identity normally is" and is never told
 * to edit a variable that did not produce the collision.
 */
function callerIssueSide(tier: "Epic" | "Story" | "Task", callerKey: string, roles: Roles, accountId: string | undefined): CollisionSide {
  const envVar = envVarFor(tier);
  const local = tier === "Story" ? roles.story : tier === "Task" ? roles.task : roles.epic;
  const localState = local ? `currently set to ${truncAccountId(local)} here` : "UNSET here";
  return {
    tier: tier.toLowerCase() as CollisionTier,
    describe: `the caller (${tier.toLowerCase()} tier, accountId observed on ${callerKey}'s own assignee — normally governed by ${envVar} on this daemon, which is ${localState})`,
    accountId,
  };
}

/** The PROJECT-CALLER side. There is no role variable to potentially mismatch — `ops.getMyself()` IS this daemon's own credential, full stop — so this can name it directly, same as the child side. */
function callerProjectSide(accountId: string | undefined): CollisionSide {
  return { tier: "project", describe: "ATLASSIAN_EMAIL (this daemon's own Atlassian credential — the project tier has no role variable)", accountId };
}

/**
 * Pure comparison — no I/O. `undefined` on either side (an unset role, a
 * caller ticket with no assignee at all, or a collision CHECK that could
 * not run — see `resolveCallerIdentity` below) is NOT a collision, only a
 * genuine accountId equality is. Returns the full message (naming both
 * sides' provenance, both tiers, the specific hop, and the shared
 * accountId) or `undefined`.
 */
function collisionBetween(caller: CollisionSide, child: CollisionSide): string | undefined {
  if (!caller.accountId || !child.accountId || caller.accountId !== child.accountId) return undefined;
  return (
    `${caller.describe} and ${child.describe} resolve to the SAME Atlassian accountId (${truncAccountId(caller.accountId)}) — ` +
    `the ${caller.tier} that owns this ${child.tier} will not be able to approve its PR: GitHub refuses a pull request approval from the PR's own author. ` +
    `This hop has no second identity behind it; RECORDED here rather than refused (BUTCHR-103's decision) — the call above still succeeds.`
  );
}

/**
 * Posts `message` as a comment on the worker's own ticket (`workerKey`) —
 * the ticket whose PR will not be approvable, read by both the boss and the
 * author. FAIL-SAFE, NEVER FAIL-SILENT: a failed write is folded INTO the
 * returned text rather than swallowed bare (this project has already
 * catalogued a load-bearing write hidden behind a bare `.catch(() => {})` as
 * a defect — success and failure must never look identical to the caller).
 * The staffing call this is called from never fails because of this.
 */
async function traceCollision(ops: AtlassianOps, workerKey: string, who: string, message: string): Promise<string> {
  try {
    await ops.addComment(workerKey, tagComment(who, message));
    return message;
  } catch (e) {
    return `${message} — THE DURABLE TRACE COMMENT ON ${workerKey} COULD NOT BE WRITTEN (${(e as Error).message}): this warning exists ONLY in this tool result and the daemon's audit log, not as a comment on the ticket.`;
  }
}

/**
 * BUTCHR-110 (review fix, 2026-09-02): the collision check's OWN reads —
 * `adopt_worker`'s extra `ops.getIssue(callerKey)`, and `ops.getMyself()`
 * for a PROJECT caller — must never turn a successful staffing call into a
 * failure, the SAME standard `traceCollision` above already holds for the
 * trace comment. Without this guard a transient read failure here throws
 * the whole staffing call — for `adopt_worker`, AFTER `assign`/`linkIssues`
 * already succeeded and BEFORE the disposition is applied, producing
 * exactly the "linked and assigned but undeclared" state this file's own
 * `adoptWorker` doc comment names as the state `adopt_worker` itself exists
 * to REPAIR, not to create. Converts any rejection into an `unknown`
 * message instead of throwing — "not checked" must never look like
 * "checked and clean" — the same principle behind S2's own honesty clause
 * (`src/config/config.ts`), applied here to S1's check itself.
 */
async function resolveCollisionSide<T>(read: () => Promise<T>, whatFailed: string): Promise<{ value: T; unknown?: undefined } | { value?: undefined; unknown: string }> {
  try {
    return { value: await read() };
  } catch (e) {
    return { unknown: `the tier-identity collision check could not run: ${whatFailed} (${(e as Error).message}) — this hop was NOT checked for a shared identity.` };
  }
}

/**
 * Returns the fetched issue (not just void) so callers that need it for a
 * follow-up decision — `startWorker`/`finishWorker` checking for a stale
 * `EXEMPT_LABEL` — reuse this fetch instead of paying for a second one. A
 * worker that was never shelved must cost exactly what it cost before this
 * check existed.
 *
 * GROWS A PROJECT-CALLER BRANCH HERE (BUTCHR-71, Contract 3) so every verb
 * that routes through this one check — start_worker, shelve_worker,
 * finish_worker, prioritize_worker, tell_worker — gets project-caller
 * support UNIFORMLY, in one place, rather than each reimplementing it.
 *
 * For a PROJECT caller, ownership is MEMBERSHIP, not an Implements link (a
 * Jira PROJECT is not an issue, so none of the issue-link machinery reaches
 * it — confirmed against this repo: `linkIssues`/`findBossKey` are never
 * called with a project key anywhere in this file). Membership is read
 * straight off the worker's OWN `fields.project.key` — no second Jira call,
 * since `ops.getIssue(workerKey)` already carries it.
 *
 * MEMBERSHIP ALONE IS DELIBERATELY NOT ENOUGH, and this is the exact
 * shortcut a future reader will be tempted by: a project CONTAINS every
 * Story and Task filed under any of its Epics too (they share the same
 * Jira `project.key`), and a project boss has no business calling
 * `finish_worker`/`tell_worker`/etc. on one of THOSE — its own workers are
 * its Epics, one tier down, exactly like every other boss/worker pair in
 * this fleet. So this REQUIRES BOTH: the target is IN the caller's project,
 * AND the target IS an Epic. Either failing refuses, and the message says
 * WHICH — matching the sharpness of the issue-caller Implements-link check
 * below (the failure that check exists to prevent — a boss acting on a
 * stranger's ticket because one character of a key was wrong — has an
 * exact project-caller analogue here: acting on a ticket that merely
 * SHARES A PROJECT with the caller).
 */
async function assertOwnWorker(ops: AtlassianOps, verb: string, callerKey: string, workerKey: string): Promise<unknown> {
  const issue = await ops.getIssue(workerKey);
  if (isProjectId(callerKey)) {
    const project = projectKeyOf(issue);
    if (project !== callerKey) {
      throw new Error(`${verb}: ${workerKey} is not one of ${callerKey}'s own workers (it belongs to project ${project ?? "an unreadable project"}, not ${callerKey}) — refusing`);
    }
    const type = issuetypeOf(issue);
    if (type !== "Epic") {
      throw new Error(`${verb}: ${workerKey} is not one of ${callerKey}'s own workers (it is a ${type ?? "unknown type"} in project ${callerKey}, not an Epic — a project boss's own workers are its Epics only, one tier down, same as every other boss/worker pair) — refusing`);
    }
    return issue;
  }
  const boss = findBossKey(issue);
  if (boss !== callerKey) {
    throw new Error(`${verb}: ${workerKey} is not one of ${callerKey}'s own workers (its Implements link points to ${boss ?? "no boss at all"}, not ${callerKey}) — refusing`);
  }
  return issue;
}

/**
 * The rollback `new_worker` (either shape — issue or project caller) uses
 * when a post-create step fails: attempts `ops.deleteIssue`, and either way
 * throws naming what happened — see `newWorker`'s own doc comment for the
 * full reasoning (measured DELETE_ISSUES refusal, why it's attempted
 * anyway). Factored out so the project-caller branch (`newProjectWorker`)
 * doesn't reimplement the same three-way message.
 */
function makeRollback(ops: AtlassianOps, verb: string, key: string): (why: string) => Promise<never> {
  return async (why: string): Promise<never> => {
    let deleted = false;
    let deleteError: string | undefined;
    try {
      await ops.deleteIssue(key);
      deleted = true;
    } catch (e) {
      deleteError = (e as Error).message;
    }
    throw new Error(
      deleted
        ? `${verb}: ${why} — ticket ${key} has been rolled back (deleted); nothing survives.`
        : `${verb}: ${why} — ticket ${key} COULD NOT be rolled back (${deleteError}); this daemon's credential may lack DELETE_ISSUES on this project (measured absent as of BUTCHR-35 — granting it upgrades this path to true atomicity with no code change). Ticket ${key} SURVIVES and needs manual cleanup.`,
    );
  };
}

// ---------------------------------------------------------------------------
// Boss -> worker
// ---------------------------------------------------------------------------

export interface NewWorkerInput {
  summary: string;
  description?: string;
  priority?: string;
  disposition: Disposition;
}
export interface NewWorkerResult {
  key: string;
  /** Present ONLY for an ISSUE caller — the Implements link target (the caller's own key). */
  implements?: string;
  /** Present ONLY for a PROJECT caller — the Jira PROJECT key the new Epic is a MEMBER of. There is no Implements link for a project/epic relationship (a Jira project is not an issue), so this is a DIFFERENT field, not `implements` set to the project key — reporting `implements` here would claim a link that does not exist. The field's presence/absence, not its value, is what tells an agent reading the result which relationship it's looking at. */
  member?: string;
  doc: DocResult;
  disposition: Disposition["kind"];
  /** BUTCHR-110: present ONLY when the caller's own accountId and the child's about-to-be-assigned accountId collide — see this file's own "tier-identity collision" section above. A distinct, greppable key so an agent that skims the result still catches it; absent entirely on a healthy hop (never present-but-empty). */
  identityCollision?: string;
  /** BUTCHR-110 (review fix): present ONLY when the collision check's OWN read (this daemon's identity, for a PROJECT caller) failed and the check could not run at all — mutually exclusive with `identityCollision`, since a failed check has no verdict to report. "Not checked" must never look like "checked and clean". */
  identityUnknown?: string;
}

/**
 * Creates a worker one tier below `callerKey`: infers the child's issue type
 * from the caller's own type, the assignee from `roles`, the project from
 * the caller's, and the doc's parent from the caller's own doc.
 *
 * WRITE ORDER, AND WHY IT IS NOT THE ORDER THE VERBS ARE LISTED IN: the
 * ticket create is irreversible and first — everything else needs its key.
 * Everything AFTER it is ordered so each successive stopping point is LESS
 * HARMFUL than the last, not by convenience:
 *   1. Create the ticket — labels (the shelve exemption label included when
 *      the disposition is "shelve"), assignee and priority all in this one
 *      call. Irreversible.
 *   2. Implements link to `callerKey`. A ticket with no boss is the worst
 *      survivable state, so this closes immediately.
 *   3. The disposition — transition to In Progress for "start"; for
 *      "shelve" the label is already on from step 1, so this is just the
 *      reason comment. AFTER THIS STEP the ticket is a fully declared
 *      worker: it has a boss and it is RUNNING or SHELVED, never undeclared
 *      — which is the invariant this whole epic exists to hold.
 *   4. The doc — page, label, remote link. Deliberately LAST: a failure
 *      here is harmless, NOT because anything "heals" it — nothing retries,
 *      there is no sweeper — but because `ensureDoc` (BUTCHR-33) is
 *      CONVERGENT: it can never produce a duplicate, so the ticket's own
 *      first `set_doc` call (whenever the agent working it makes one) safely
 *      completes the binding. If that call never happens, the ticket simply
 *      has no doc until something calls for that key — worse than nothing,
 *      but strictly better than an orphan or a duplicate page, and
 *      recoverable by anyone at any time. No rollback is attempted for step
 *      4; there is nothing to roll back FROM, because nothing downstream
 *      depends on it.
 *
 * ROLLBACK covers only steps 2 and 3, via `ops.deleteIssue` — the
 * genuinely damaging window, where the ticket exists but is not yet a
 * declared worker. MEASURED (BUTCHR-35): this daemon's credential does NOT
 * currently hold Jira's `DELETE_ISSUES` permission on this project (a
 * `mypermissions` read reports `havePermission: false`, and a live
 * create-then-delete round trip 403s). The delete is attempted anyway,
 * because the refusal is a PROJECT PERMISSION, not an API limitation:
 * granting `Delete Issues` to this daemon's Atlassian account upgrades this
 * path to fully working with no code change. Every caller must already
 * handle it failing, and on failure this reports a NAMED PARTIAL STATE (the
 * surviving ticket key) rather than pretending the write undid itself.
 *
 * WHAT A NORMAL RETURN MEANS, AND WHAT A THROW MEANS, HONESTLY: rule (a) as
 * originally stated — "creates the ticket, the doc, links both directions,
 * or it fails and leaves nothing" — is not what this delivers, and this
 * comment does not claim it. A NORMAL RETURN always means a ticket that has
 * a boss (step 2), a declared disposition (step 3) — never undeclared — AND
 * a doc (step 4 also succeeded). A THROW after step 1 means exactly one of
 * three things, distinguishable from the error text: (1) the link or
 * disposition write failed and the rollback delete SUCCEEDED — nothing
 * survives; (2) that same failure happened and the rollback delete ALSO
 * FAILED — the error names exactly which ticket key needs manual cleanup;
 * or (3) the link and disposition both succeeded and ONLY the doc step
 * failed — the ticket, its boss link and its disposition all survive
 * (correctly, undamaged, never rolled back), and its doc is completed by
 * that ticket's own first `set_doc` call, whenever the agent working it
 * makes one. Case (3) is the one easiest to misread as case (2): both throw,
 * but only (2) means something needs to be cleaned up — read the message.
 */
export async function newWorker(ops: AtlassianOps, roles: Roles, callerKey: string, input: NewWorkerInput): Promise<NewWorkerResult> {
  if (isProjectId(callerKey)) return newProjectWorker(ops, roles, callerKey, input);

  const { disposition } = input;
  if (disposition.kind === "shelve" && !disposition.reason.trim()) {
    throw new Error("new_worker: a \"shelve\" disposition requires a non-empty reason — an activation condition nobody wrote down is indistinguishable six weeks later from a ticket somebody forgot");
  }

  const callerIssue = await ops.getIssue(callerKey);
  const callerType = issuetypeOf(callerIssue);
  const childType = callerType ? CHILD_TYPE[callerType] : undefined;
  if (!childType) {
    const msg = callerType === "Task"
      ? `new_worker: ${callerKey} is a Task — a Task is the bottom of this hierarchy and has no worker beneath it; new_worker can only be called by an Epic or a Story`
      : `new_worker: ${callerKey}'s issue type ("${callerType ?? "unknown"}") has no defined child type — new_worker can only be called by an Epic or a Story`;
    throw new Error(msg);
  }
  const role = childType === "Story" ? roles.story : roles.task;
  if (!role) throw new Error(noRoleMsg("new_worker", childType));
  const projectKey = projectKeyOf(callerIssue);
  if (!projectKey) throw new Error(`new_worker: could not read ${callerKey}'s own project key — refusing rather than guessing`);

  // (1) create — irreversible; the shelve label, if any, lands HERE.
  const created = (await ops.createIssue({
    projectKey,
    issuetype: childType,
    summary: input.summary,
    ...(input.description ? { description: input.description } : {}),
    assignee: role,
    ...(input.priority ? { priority: input.priority } : {}),
    ...(disposition.kind === "shelve" ? { labels: [EXEMPT_LABEL] } : {}),
  })) as { key?: string };
  const key = created.key;
  if (!key) throw new Error("new_worker: create response carried no issue key — refusing to link or transition against nothing");

  // Rollback for steps 2/3 only (see the function comment for why step 4
  // never rolls back). Attempts the delete unconditionally — see
  // AtlassianOps.deleteIssue's doc comment for why a currently-refused
  // permission is not a reason to skip the attempt.
  const rollback = makeRollback(ops, "new_worker", key);

  // (2) link — outward from the new child to the caller, never the reverse.
  try {
    await ops.linkIssues(key, callerKey, "Implements");
  } catch (e) {
    return rollback(`the Implements link to ${callerKey} failed (${(e as Error).message})`);
  }

  // (3) disposition — after this, the ticket is a fully declared worker.
  if (disposition.kind === "start") {
    try {
      await ops.transition(key, "In Progress");
    } catch (e) {
      return rollback(`the disposition transition to In Progress failed (${(e as Error).message})`);
    }
  } else {
    try {
      await ops.addComment(key, tagComment(callerKey, disposition.reason));
    } catch (e) {
      return rollback(`the shelve reason comment failed to post (${(e as Error).message}); the exemption label was already applied at creation`);
    }
  }

  // (3.5) BUTCHR-110: tier-identity collision — RECORD, never refuse (see
  // this file's own section above `CHILD_TYPE`). The caller's accountId
  // comes from the caller's OWN ticket, already fetched above for type/
  // project inference — no extra Jira call here — never from the role
  // variable that governs the caller's tier: those can differ (a
  // hand-assigned ticket), and the observed value is the one that decides
  // whether GitHub will refuse the review. `callerType` is known to be
  // "Story" or "Epic" here (childType resolved above via CHILD_TYPE).
  const collisionMsg = collisionBetween(
    callerIssueSide(callerType as "Story" | "Epic", callerKey, roles, assigneeAccountIdOf(callerIssue)),
    childSide(childType, role),
  );
  const identityCollision = collisionMsg ? await traceCollision(ops, key, callerKey, collisionMsg) : undefined;

  // (4) doc — last, on purpose. `ensureDoc` is convergent (BUTCHR-33), so a
  // failure here is reported but NOT rolled back: the ticket is already a
  // fully declared worker (steps 2/3 succeeded), and nothing downstream
  // depends on the doc existing yet. Convergent means "the next call for
  // this key cannot make a duplicate", NOT "something retries automatically"
  // — nothing here does. The doc is completed by that ticket's own first
  // `set_doc` call, whenever the agent working it makes one.
  let doc: DocResult;
  try {
    doc = await ensureDoc(ops, key);
  } catch (e) {
    throw new Error(
      `new_worker: ticket ${key} was created, linked to ${callerKey}, and its disposition (${disposition.kind}) applied — it is a fully declared worker; no rollback was attempted or is needed. ` +
        `Only its Confluence doc failed to create (${(e as Error).message}); it will be completed by ${key}'s own first set_doc call, whenever that agent makes one (ensureDoc is convergent — it will never create a duplicate — but nothing here retries automatically).`,
    );
  }

  return { key, implements: callerKey, doc, disposition: disposition.kind, ...(identityCollision ? { identityCollision } : {}) };
}

/**
 * PROJECT caller -> creates an EPIC, one tier below. See `newWorker`'s own
 * doc comment for the general shape (disposition validation, the four-step
 * ordering) — this differs from it in exactly the ways BUTCHR-71's Contract
 * 2 calls out, both DELIBERATE, not oversights:
 *
 *  1. NO IMPLEMENTS LINK, SO THE WRITE ORDER COLLAPSES FROM FOUR STEPS TO
 *     THREE. A Jira PROJECT is not an issue, so none of the issue-link
 *     machinery (`ops.linkIssues`) reaches it — confirmed by this file: no
 *     call below ever links a project key to anything. The boss/worker
 *     relationship here is MEMBERSHIP IN THE PROJECT, which is already true
 *     the INSTANT `ops.createIssue` lands the ticket in `projectKey` — there
 *     is no separate "link" write establishing it afterward, unlike the
 *     issue-caller path's step 2. So the order here is: (1) create, (2)
 *     disposition, (3) doc.
 *  2. ROLLBACK STILL COVERS THE DISPOSITION STEP, mirroring `newWorker`'s
 *     own reasoning even with one fewer step to protect: between create and
 *     disposition, the ticket exists but is not yet a DECLARED worker (no
 *     RUNNING/SHELVED state on record) — the same genuinely damaging window
 *     `newWorker`'s rollback exists for, just without a link step ahead of
 *     it. There is no rollback for step 3 (the doc), same reasoning as
 *     `newWorker`'s own step 4: convergent (`ensureDoc`), nothing downstream
 *     depends on it, so a failure there is reported, never rolled back.
 *  3. `member`, NOT `implements`, IN THE RESULT. Reporting `implements:
 *     projectKey` would be a LIE — no such link exists (see 1 above) — so
 *     the result carries `member` instead (see `NewWorkerResult`'s own doc
 *     comment); `implements` is simply omitted rather than set to a value
 *     that would read as true and isn't.
 *
 * DOC NESTING — VERIFIED, NOT ASSUMED: see the comment on `ensureDoc`'s own
 * boss-resolution step (src/tools/docs.ts) for why the new Epic's doc
 * already nests under `projectKey`'s root doc with no second code path.
 */
async function newProjectWorker(ops: AtlassianOps, roles: Roles, projectKey: string, input: NewWorkerInput): Promise<NewWorkerResult> {
  const { disposition } = input;
  if (disposition.kind === "shelve" && !disposition.reason.trim()) {
    throw new Error("new_worker: a \"shelve\" disposition requires a non-empty reason — an activation condition nobody wrote down is indistinguishable six weeks later from a ticket somebody forgot");
  }
  const role = roles.epic;
  if (!role) throw new Error(noRoleMsg("new_worker", "Epic"));

  // (1) create — irreversible; the shelve label, if any, lands HERE.
  // Membership in `projectKey` is already real the instant this returns.
  const created = (await ops.createIssue({
    projectKey,
    issuetype: "Epic",
    summary: input.summary,
    ...(input.description ? { description: input.description } : {}),
    assignee: role,
    ...(input.priority ? { priority: input.priority } : {}),
    ...(disposition.kind === "shelve" ? { labels: [EXEMPT_LABEL] } : {}),
  })) as { key?: string };
  const key = created.key;
  if (!key) throw new Error("new_worker: create response carried no issue key — refusing to transition against nothing");

  const rollback = makeRollback(ops, "new_worker", key);

  // (2) disposition — after this, the epic is a fully declared worker
  // (membership + a declared RUNNING/SHELVED state). See the function doc
  // comment for why rollback still covers this step despite there being no
  // link step ahead of it.
  if (disposition.kind === "start") {
    try {
      await ops.transition(key, "In Progress");
    } catch (e) {
      return rollback(`the disposition transition to In Progress failed (${(e as Error).message})`);
    }
  } else {
    try {
      await ops.addComment(key, tagComment(projectKey, disposition.reason));
    } catch (e) {
      return rollback(`the shelve reason comment failed to post (${(e as Error).message}); the exemption label was already applied at creation`);
    }
  }

  // (2.5) BUTCHR-110: tier-identity collision — RECORD, never refuse. For a
  // PROJECT caller there is no role variable on the caller's own side (the
  // project tier is governed by this daemon's Atlassian CREDENTIAL, not a
  // BUTCHR_ASSIGNEE_* var) — `ops.getMyself()` is the same call BUTCHR-67's
  // discovery lead-filter already uses (src/resources/project.ts) to answer
  // "the account this credential runs as", reused here rather than adding a
  // second way to ask the same question. GUARDED (review fix, 2026-09-01):
  // this read runs AFTER the disposition, so the epic is already fully
  // declared either way — but an unguarded throw here would still hand the
  // caller a raw transport error instead of a clean result, so it gets the
  // same fail-safe treatment as every other collision-check read.
  const me = await resolveCollisionSide(() => ops.getMyself(), "reading this daemon's own Atlassian identity (getMyself) failed");
  const collisionMsg = me.value ? collisionBetween(callerProjectSide(me.value.accountId), childSide("Epic", role)) : undefined;
  const identityCollision = collisionMsg ? await traceCollision(ops, key, projectKey, collisionMsg) : undefined;

  // (3) doc — last, on purpose; see newWorker's own step-4 comment (same reasoning).
  let doc: DocResult;
  try {
    doc = await ensureDoc(ops, key);
  } catch (e) {
    throw new Error(
      `new_worker: epic ${key} was created in project ${projectKey} and its disposition (${disposition.kind}) applied — it is a fully declared worker (membership, not a link); no rollback was attempted or is needed. ` +
        `Only its Confluence doc failed to create (${(e as Error).message}); it will be completed by ${key}'s own first set_doc call, whenever that agent makes one.`,
    );
  }

  return {
    key, member: projectKey, doc, disposition: disposition.kind,
    ...(identityCollision ? { identityCollision } : {}),
    ...(me.unknown ? { identityUnknown: me.unknown } : {}),
  };
}

/**
 * Worker -> In Progress. Refuses a key that is not one of the caller's own
 * workers. The call that actually staffs an agent; also reactivates a
 * shelved worker and sends an In Review worker back to work.
 *
 * CLEARS `EXEMPT_LABEL` (`butchr:shelved`) FIRST, ONLY IF PRESENT, THEN
 * TRANSITIONS — this is the fix for BUTCHR-50: the label means CURRENTLY
 * shelved, a state, not a history, so the verb that reverses a shelve is the
 * verb that withdraws the declaration. Ordering (not just presence) is the
 * design decision, by the same "order writes by how bad it is to stop
 * halfway" principle shelveWorker's own comment and newWorker's step
 * ordering already use: transitioning first and then failing the label
 * removal would leave an In Progress ticket silently carrying a stale
 * exemption — exactly the blind spot this fix exists to close. Clearing
 * first and then failing the transition instead leaves a To Do, assigned,
 * UNEXEMPT child under a live boss, which the parked detector reports
 * loudly. Never leave a partial state where the detector is silently wrong;
 * prefer the one where it is loudly right. Skipped entirely (zero extra
 * Jira calls) when the label isn't present, reusing assertOwnWorker's fetch.
 */
export async function startWorker(ops: AtlassianOps, callerKey: string, workerKey: string): Promise<unknown> {
  const issue = await assertOwnWorker(ops, "start_worker", callerKey, workerKey);
  if (labelsOf(issue).includes(EXEMPT_LABEL)) {
    await ops.removeLabels(workerKey, [EXEMPT_LABEL]);
  }
  return ops.transition(workerKey, "In Progress");
}

/**
 * Worker -> Done. Refuses a key that is not one of the caller's own workers.
 * A worker never finishes itself — see submit_to_boss; the review hop is the
 * point.
 *
 * CLEARS `EXEMPT_LABEL` FIRST, ONLY IF PRESENT, THEN TRANSITIONS — same
 * ordering and reasoning as `startWorker` above. Done is not shelved: a
 * finished ticket that still carries the exemption is the exact residue this
 * ticket exists to stop producing (BUTCHR-28/-29/-30/-31, all Done and all
 * still carrying it before this fix).
 */
export async function finishWorker(ops: AtlassianOps, callerKey: string, workerKey: string): Promise<unknown> {
  const issue = await assertOwnWorker(ops, "finish_worker", callerKey, workerKey);
  if (labelsOf(issue).includes(EXEMPT_LABEL)) {
    await ops.removeLabels(workerKey, [EXEMPT_LABEL]);
  }
  return ops.transition(workerKey, "Done");
}

/**
 * Moves the worker to To Do, ADDS the exemption label (additively — never
 * drops labels the ticket already carries), and posts `reason` as a comment
 * — all as one tool call. Refuses a key that is not one of the caller's own
 * workers, and refuses an empty reason.
 */
export async function shelveWorker(ops: AtlassianOps, callerKey: string, workerKey: string, reason: string): Promise<void> {
  if (!reason.trim()) throw new Error("shelve_worker: a reason is required — an activation condition nobody wrote down is indistinguishable six weeks later from a ticket somebody forgot");
  await assertOwnWorker(ops, "shelve_worker", callerKey, workerKey);
  // LABEL BEFORE TRANSITION, on purpose (order the writes by how bad it is to
  // stop there, the same principle newWorker uses): if the label write fails
  // after the transition, the ticket is left To Do, assigned, under a live
  // boss, with NO exemption label — a textbook parked child, indistinguishable
  // from one nobody ever declared. Labelling first means a partial failure
  // instead leaves the ticket In Progress carrying an inert label — harmless,
  // since the parked-ticket detector only ever looks at To Do tickets.
  await ops.addLabels(workerKey, [EXEMPT_LABEL]);
  await ops.transition(workerKey, "To Do");
  await ops.addComment(workerKey, tagComment(callerKey, reason));
}

export interface AdoptWorkerResult {
  key: string;
  alreadyAdopted: boolean;
  doc: DocResult;
  disposition: Disposition["kind"];
  /** BUTCHR-110: present ONLY when the caller's own accountId and the adopted ticket's about-to-be-assigned accountId collide — see the "tier-identity collision" section near the top of this file. Computed and reported on EVERY call (including a fully idempotent re-adoption), because it states a fact about current state, not an action taken — but the underlying ticket COMMENT is only (re-)posted when this call does real adoption work (`!alreadyAdopted`); see the comment at this field's call site for why. */
  identityCollision?: string;
  /** BUTCHR-110 (review fix): present ONLY when the collision check's OWN read (the caller's own ticket, or this daemon's identity for a PROJECT caller) failed and the check could not run at all — mutually exclusive with `identityCollision`. "Not checked" must never look like "checked and clean". */
  identityUnknown?: string;
}

/**
 * Takes ownership of an existing ticket: infers the assignee from the
 * ADOPTED ticket's own type, links it (Implements, outward) to `callerKey`,
 * and ensures its doc. IDEMPOTENT on the FULL adopted state — link, assignee
 * AND disposition — not on the link alone: `alreadyAdopted` is true only
 * when the ticket is already linked to `callerKey`, already assigned by
 * role, and already sitting in the state its disposition names (In Progress
 * for "start"; To Do WITH the exemption label for "shelve" — matching the
 * glossary's own definition of SHELVED). Only then are the assign/link/
 * disposition writes skipped entirely.
 *
 * THIS MATTERS BEYOND ORDINARY IDEMPOTENCE: it is the documented recovery
 * path from `newWorker`'s own worst-case partial state. On a deployment
 * where `deleteIssue` is refused (measured, BUTCHR-35), a step-2/3 failure
 * in `newWorker` can leave a ticket that is linked and assigned but NOT yet
 * declared (no disposition applied) — an undeclared worker under a live
 * boss, exactly what the parked-ticket detector exists to catch. The
 * documented repair is calling `adopt_worker` again with a disposition. If
 * "already adopted" were decided from the link alone, that repair call
 * would see the link, call itself done, and silently skip the disposition
 * — leaving the worker undeclared FOREVER while reporting success. Deciding
 * from the full state closes that: a linked-but-undeclared ticket is NOT
 * "already adopted", so the disposition is applied for real.
 *
 * `ensureDoc` still runs unconditionally as a no-op-when-already-present
 * safety net, regardless of `alreadyAdopted`. Refuses a ticket already
 * linked to a DIFFERENT boss.
 *
 * A `disposition: "start"` ALSO CLEARS `EXEMPT_LABEL` (`butchr:shelved`)
 * whenever the adopted ticket carries it, whether or not this call is
 * otherwise a no-op (BUTCHR-50) — see the comment at the removeLabels call
 * below for why that check is not gated on `alreadyAdopted`.
 *
 * SEPARATELY, THIS CALL ALSO CLEARS `ORPHAN_LABEL` (`butchr:orphan`)
 * whenever the adopted ticket carries it — for BOTH dispositions, unlike
 * `EXEMPT_LABEL` above, and likewise not gated on `alreadyAdopted`
 * (BUTCHR-108/BUTCHR-137). `ORPHAN_LABEL` means UNDIRECTED, not shelved, and
 * a ticket adopted with `"shelve"` is exactly as directed as one adopted
 * with `"start"` — it has a boss, a link, and a recorded decision either
 * way. See the comment at that removeLabels call below for the full
 * argument.
 *
 * THE REASON COMMENT IS NOT PART OF "STATE ALREADY MATCHES, SKIP IT": for a
 * "shelve" disposition, the reason is posted whenever this call does ANY
 * real adoption work at all (`!alreadyAdopted`) — even if the ticket
 * already happens to be To Do with the exemption label already on it (set
 * by a human, or by a boss that has since died). The label is STATE; the
 * reason is a DECLARATION this caller is making on its own authority as
 * part of taking ownership, and skipping it whenever the label happened to
 * already be present would adopt an orphan straight into "shelved, with no
 * activation condition on record" — the one state the glossary says must
 * never exist. Only a genuinely idempotent re-adoption (`alreadyAdopted`)
 * skips the comment.
 */
export async function adoptWorker(ops: AtlassianOps, roles: Roles, callerKey: string, workerKey: string, disposition: Disposition): Promise<AdoptWorkerResult> {
  if (disposition.kind === "shelve" && !disposition.reason.trim()) {
    throw new Error("adopt_worker: a \"shelve\" disposition requires a non-empty reason — an activation condition nobody wrote down is indistinguishable six weeks later from a ticket somebody forgot");
  }
  if (isProjectId(callerKey)) return adoptProjectWorker(ops, roles, callerKey, workerKey, disposition);

  const issue = await ops.getIssue(workerKey);
  const existingBoss = findBossKey(issue);
  if (existingBoss && existingBoss !== callerKey) {
    throw new Error(`adopt_worker: ${workerKey} is already linked to a different boss (${existingBoss}) — stealing another boss's worker must be an explicit act, not a side effect of a mistyped key; use jira_link_issues only if this is deliberate`);
  }

  const issuetype = issuetypeOf(issue) as "Story" | "Task" | undefined;
  if (issuetype !== "Story" && issuetype !== "Task") {
    throw new Error(`adopt_worker: ${workerKey}'s issue type ("${issuetype ?? "unknown"}") cannot be adopted as a worker — only a Story or a Task can be`);
  }
  const role = issuetype === "Story" ? roles.story : roles.task;
  if (!role) throw new Error(noRoleMsg("adopt_worker", issuetype));

  const labels = labelsOf(issue);
  const linkedCorrectly = existingBoss === callerKey;
  const assignedCorrectly = assigneeAccountIdOf(issue) === role;
  const currentStatus = statusOf(issue);
  const dispositionAlreadyApplied =
    disposition.kind === "start" ? currentStatus === "In Progress" : currentStatus === "To Do" && labels.includes(EXEMPT_LABEL);
  const alreadyAdopted = linkedCorrectly && assignedCorrectly && dispositionAlreadyApplied;

  if (!alreadyAdopted) {
    if (!assignedCorrectly) await ops.assign(workerKey, role);
    if (!linkedCorrectly) await ops.linkIssues(workerKey, callerKey, "Implements");
  }

  // BUTCHR-110: tier-identity collision — RECORD, never refuse. UNLIKE
  // new_worker's issue path, adopt_worker never otherwise reads the
  // CALLER's own ticket (only the ADOPTED ticket, above) — this is one
  // extra Jira read, paid here as the price of the check, per this
  // ticket's own S1 spec. Caller's accountId comes from the caller's
  // ACTUAL ticket, never from the role variable governing the caller's
  // tier (those can differ — a hand-assigned ticket).
  //
  // GUARDED (review fix, 2026-09-02): this read runs AFTER `assign`/
  // `linkIssues` above and BEFORE the disposition below — an unguarded
  // throw here would leave the ticket assigned and linked but UNDECLARED,
  // exactly the damaging partial state this function's own doc comment
  // names, and which `adopt_worker` itself exists to REPAIR, not to create.
  // A read failure therefore never throws: it's reported as `identityUnknown`
  // on the result instead, and the call proceeds exactly as if this
  // collision check did not exist. "Not checked" must never look like
  // "checked and clean".
  const callerRead = await resolveCollisionSide(() => ops.getIssue(callerKey), `reading ${callerKey}'s own assignee failed`);
  const callerType = callerRead.value ? (issuetypeOf(callerRead.value) as "Story" | "Task" | "Epic" | undefined) : undefined;
  const callerAccountId = callerRead.value ? assigneeAccountIdOf(callerRead.value) : undefined;
  const collisionMsg = callerType
    ? collisionBetween(callerIssueSide(callerType, callerKey, roles, callerAccountId), childSide(issuetype, role))
    : undefined;
  // THE COMMENT IS POSTED ONLY WHEN THIS CALL DOES REAL ADOPTION WORK
  // (`!alreadyAdopted`) — deliberately mirroring the shelve-reason comment's
  // OWN idiom just above (and its own doc comment on `adoptWorker`): a fully
  // idempotent re-adoption changes nothing else about the ticket, and
  // re-posting an identical collision comment on every subsequent no-op
  // check (e.g. a boss re-adopting on every restart to reconcile state)
  // would spam the ticket with duplicates carrying no new information. The
  // RESULT FIELD and the AUDIT LINE (written by the caller in
  // src/tools/defs.ts from this field) are NOT gated the same way — both
  // are read-only per call, cost nothing to repeat, and "loud on every
  // call that could go wrong" is the point — so they are computed here
  // regardless of `alreadyAdopted`.
  const identityCollision = collisionMsg
    ? alreadyAdopted
      ? `${collisionMsg} (not reposted as a ticket comment: this call is a fully idempotent re-adoption doing no other write — the trace comment is written on the call this hop is actually adopted, not on every subsequent no-op check)`
      : await traceCollision(ops, workerKey, callerKey, collisionMsg)
    : undefined;

  const doc = await ensureDoc(ops, workerKey);

  // CLEARS ORPHAN_LABEL WHENEVER IT'S PRESENT — REGARDLESS OF DISPOSITION,
  // AND NOT GATED ON `alreadyAdopted` EITHER (BUTCHR-108/BUTCHR-137). The
  // gating on EXEMPT_LABEL just below is specific to what THAT label means
  // (CURRENTLY shelved, a state only "start" reverses); ORPHAN_LABEL means
  // something different — UNDIRECTED — and a ticket adopted with "shelve" is
  // exactly as directed as one adopted with "start": either way it now has a
  // boss, a link, and a recorded decision, so this clear runs for BOTH. Reuses
  // `labels` from the fetch above — no extra Jira call. Not gated on
  // `alreadyAdopted`, by the same BUTCHR-50 argument EXEMPT_LABEL's own clear
  // makes below: an otherwise fully idempotent re-adoption must still clear a
  // stale orphan label, or a live, directed ticket keeps silently polluting
  // the undirected-ticket query forever — exactly the residue this fix
  // exists to stop producing. Cleared BEFORE any transition below — same
  // "never leave a partial state where the detector is silently wrong"
  // ordering EXEMPT_LABEL's own clear and startWorker's comment already use.
  if (labels.includes(ORPHAN_LABEL)) {
    await ops.removeLabels(workerKey, [ORPHAN_LABEL]);
  }

  // CLEARS EXEMPT_LABEL FOR A "start" DISPOSITION WHENEVER IT'S PRESENT — NOT
  // gated on `alreadyAdopted`. Reuses `labels` from the fetch above (BUTCHR-50:
  // this path already reads the issue and computes labelsOf(issue), so this
  // costs no extra Jira call). Adopting a ticket that already carries the
  // label straight into (or already sitting in) In Progress reproduces the
  // identical bug startWorker fixes, through a second door — even a fully
  // idempotent re-adoption (already linked, assigned, and In Progress) must
  // not leave a live ticket silently carrying a stale exemption, which is
  // exactly the residue this fix exists to stop producing. Cleared BEFORE any
  // transition below — same ordering reasoning as startWorker's own comment:
  // never leave a partial state where the detector is silently wrong.
  if (disposition.kind === "start" && labels.includes(EXEMPT_LABEL)) {
    await ops.removeLabels(workerKey, [EXEMPT_LABEL]);
  }

  // NOTE: the reason comment for "shelve" is posted whenever this call is
  // doing ANY real adoption work (!alreadyAdopted) — NOT gated on
  // `dispositionAlreadyApplied` the way the transition/label are. Those two
  // are STATE (already To Do + labelled — cheap to check, safe to skip
  // re-writing); the reason is a DECLARATION this caller is making right
  // now, on ITS OWN authority, as part of taking ownership. A ticket can
  // already carry the label (set by a human, or by a boss that has since
  // died) while this boss has never written down why IT is shelving it — if
  // the comment were skipped whenever the label happens to already be
  // there, exactly that ticket (adopting an orphan that already carries the
  // exemption label) would end up SHELVED with no activation condition on
  // record at all, which is the one state the glossary says must never
  // exist. Only `alreadyAdopted` (a true no-op re-adoption by the same
  // caller) may skip it.
  if (!alreadyAdopted) {
    if (disposition.kind === "start") {
      if (!dispositionAlreadyApplied) await ops.transition(workerKey, "In Progress");
    } else {
      if (!dispositionAlreadyApplied) {
        // Label before transition — see shelveWorker's comment for why.
        await ops.addLabels(workerKey, [EXEMPT_LABEL]);
        if (currentStatus !== "To Do") await ops.transition(workerKey, "To Do");
      }
      await ops.addComment(workerKey, tagComment(callerKey, disposition.reason));
    }
  }

  return {
    key: workerKey, alreadyAdopted, doc, disposition: disposition.kind,
    ...(identityCollision ? { identityCollision } : {}),
    ...(callerRead.unknown ? { identityUnknown: callerRead.unknown } : {}),
  };
}

/**
 * PROJECT caller adopting an existing EPIC into the project (an orphan
 * epic, or one whose boss agent has since ended). "Already adopted" here
 * can NEVER mean "already linked" — there is no link for a project/epic
 * relationship (see `newProjectWorker`'s doc comment) — so it means the
 * epic is already a MEMBER of `projectKey`, already assigned by the epic
 * role, and already sitting in the state its disposition names. Refuses an
 * epic that is a member of a DIFFERENT project — stealing another
 * project's epic must be an explicit act, not a side effect of a mistyped
 * key, mirroring the issue-caller path's refusal of a different existing
 * boss (there is no equivalent "explicit move" verb for project
 * membership here — moving an issue between Jira projects is out of scope
 * for this tool surface, not silently omitted).
 *
 * ALSO CLEARS `ORPHAN_LABEL` (`butchr:orphan`) WHENEVER PRESENT, SAME AS THE
 * ISSUE-CALLER PATH ABOVE — argued explicitly here rather than left implicit
 * (BUTCHR-108/BUTCHR-137): `fileWhereItBelongs` can only ever create a Story
 * or a Task (its `issuetype` input is typed that way), so an orphan Epic can
 * never arrive here through this codebase's own write path today. Clearing
 * it here anyway is a symmetry / defence-in-depth call, not a reachable-bug
 * fix — the label could still land on an Epic by hand, or from a future
 * caller this tool surface doesn't control. It costs nothing to add: this
 * path already fetches and computes `labels` for its own idempotence check,
 * so the clear reuses that fetch exactly like the issue-caller path's does.
 */
async function adoptProjectWorker(ops: AtlassianOps, roles: Roles, projectKey: string, workerKey: string, disposition: Disposition): Promise<AdoptWorkerResult> {
  const issue = await ops.getIssue(workerKey);
  const existingProject = projectKeyOf(issue);
  if (existingProject !== projectKey) {
    throw new Error(`adopt_worker: ${workerKey} belongs to project ${existingProject ?? "an unreadable project"}, not ${projectKey} — stealing another project's epic must be an explicit act, not a side effect of a mistyped key`);
  }

  const issuetype = issuetypeOf(issue);
  if (issuetype !== "Epic") {
    throw new Error(`adopt_worker: ${workerKey}'s issue type ("${issuetype ?? "unknown"}") cannot be adopted by a project caller — only an Epic can be`);
  }
  const role = roles.epic;
  if (!role) throw new Error(noRoleMsg("adopt_worker", "Epic"));

  const labels = labelsOf(issue);
  const assignedCorrectly = assigneeAccountIdOf(issue) === role;
  const currentStatus = statusOf(issue);
  const dispositionAlreadyApplied =
    disposition.kind === "start" ? currentStatus === "In Progress" : currentStatus === "To Do" && labels.includes(EXEMPT_LABEL);
  // MEMBERSHIP IS ALREADY GIVEN (checked above) — the idempotence test here
  // mirrors the issue-caller path's OWN reasoning: membership is a
  // structural fact of the ticket, not a declared act, so it is never part
  // of "already adopted" either way. Only assignment + disposition state
  // decide it.
  const alreadyAdopted = assignedCorrectly && dispositionAlreadyApplied;

  if (!alreadyAdopted && !assignedCorrectly) await ops.assign(workerKey, role);

  // BUTCHR-110: tier-identity collision — RECORD, never refuse. The project
  // tier has no role variable of its own; the caller's accountId is this
  // daemon's own Atlassian CREDENTIAL (`ops.getMyself()` — the same call
  // BUTCHR-67's discovery lead-filter already uses, src/resources/
  // project.ts). Comment-posting is gated on `!alreadyAdopted`, same
  // reasoning as the issue-caller path (adoptWorker, above) — see its own
  // comment at the equivalent call site for why.
  //
  // GUARDED (review fix, 2026-09-02): this read runs AFTER `assign` above
  // and BEFORE the disposition below — same partial-state hazard as
  // adoptWorker's own guarded read; see its comment for the full reasoning.
  const me = await resolveCollisionSide(() => ops.getMyself(), "reading this daemon's own Atlassian identity (getMyself) failed");
  const collisionMsg = me.value ? collisionBetween(callerProjectSide(me.value.accountId), childSide("Epic", role)) : undefined;
  const identityCollision = collisionMsg
    ? alreadyAdopted
      ? `${collisionMsg} (not reposted as a ticket comment: this call is a fully idempotent re-adoption doing no other write — the trace comment is written on the call this hop is actually adopted, not on every subsequent no-op check)`
      : await traceCollision(ops, workerKey, projectKey, collisionMsg)
    : undefined;

  const doc = await ensureDoc(ops, workerKey);

  // Same BUTCHR-108/BUTCHR-137 fix as the issue-caller path: clear a stale
  // ORPHAN_LABEL whenever it's present, for BOTH dispositions and not gated
  // on `alreadyAdopted` — see this function's own doc comment above for why
  // this path clears it too (symmetry / defence-in-depth, argued there), and
  // adoptWorker's ORPHAN_LABEL comment for the full disposition-gating
  // reasoning. Reuses `labels` from the fetch above — no extra Jira call.
  if (labels.includes(ORPHAN_LABEL)) {
    await ops.removeLabels(workerKey, [ORPHAN_LABEL]);
  }

  // Same BUTCHR-50 fix as the issue-caller path: clear a stale EXEMPT_LABEL
  // on a "start" disposition whenever it's present, not gated on
  // `alreadyAdopted` — see adoptWorker's own comment on this for the full
  // reasoning (reproduces the identical bug through a second door if skipped).
  if (disposition.kind === "start" && labels.includes(EXEMPT_LABEL)) {
    await ops.removeLabels(workerKey, [EXEMPT_LABEL]);
  }

  if (!alreadyAdopted) {
    if (disposition.kind === "start") {
      if (!dispositionAlreadyApplied) await ops.transition(workerKey, "In Progress");
    } else {
      if (!dispositionAlreadyApplied) {
        await ops.addLabels(workerKey, [EXEMPT_LABEL]);
        if (currentStatus !== "To Do") await ops.transition(workerKey, "To Do");
      }
      await ops.addComment(workerKey, tagComment(projectKey, disposition.reason));
    }
  }

  return {
    key: workerKey, alreadyAdopted, doc, disposition: disposition.kind,
    ...(identityCollision ? { identityCollision } : {}),
    ...(me.unknown ? { identityUnknown: me.unknown } : {}),
  };
}

/** Revises a worker's priority. Refuses a key that is not one of the caller's own workers, AND refuses the caller's OWN key — your priority is your boss's judgment, never your own. */
export async function prioritizeWorker(ops: AtlassianOps, callerKey: string, workerKey: string, priority: string): Promise<unknown> {
  if (workerKey === callerKey) {
    throw new Error(`prioritize_worker: refusing to set ${callerKey}'s own priority — your priority is your boss's judgment, never your own`);
  }
  await assertOwnWorker(ops, "prioritize_worker", callerKey, workerKey);
  return ops.setPriority(workerKey, priority);
}

/**
 * Marks the archive comment `correctWorker` posts before it overwrites a
 * worker's description/summary — greppable across the whole corpus, the
 * same idea as ASK_MARKER, placed right after the identity tag. Added on
 * review (BUTCHR-53's approval of BUTCHR-41's design) specifically because
 * this is the one verb in this fleet that destroys evidence by design,
 * guarded only by the archive step and an ownership check: "show me every
 * change anyone ever made to authored text, and the stated reason for each"
 * is only possible if the archive comments share one shape. AN EXPORTED
 * CONSTANT, NEVER RETYPED — including in tests, which must read this symbol
 * rather than hardcode the literal — because a marker that exists as a
 * literal in two places will eventually exist as two different literals,
 * and a grep that silently misses half the corrections is worse than no
 * grep at all: it answers, just wrongly. Deliberately ONE marker, not one
 * per use case (see `correctWorker`'s own doc comment for why a correction
 * and an additive update share this marker rather than getting their own).
 * STATED HERE VERBATIM because briefs need to quote it, same as ASK_MARKER.
 */
export const CORRECTION_MARKER = "[correction]";

/**
 * Marks a follow-up comment `correctWorker` posts when the replace (the
 * write AFTER the archive) fails for a reason the size pre-check below did
 * not catch — a transient network fault, a permissions change, anything
 * else Jira can reject with. Placed right after the identity tag, same
 * idiom as `CORRECTION_MARKER`/`ASK_MARKER`. AN EXPORTED CONSTANT, NEVER
 * RETYPED — including in tests, which read this symbol — for the same
 * reason `CORRECTION_MARKER`'s own comment gives: a marker duplicated as a
 * literal eventually drifts into two different literals, and a grep that
 * silently misses half the corpus answers wrong instead of not at all.
 * This is BUTCHR-136's fix for the gap BUTCHR-128 measured: the thrown
 * error already tells the CALLER a rejected write happened, but nothing
 * durable told a later reader of the ticket itself — this comment is that
 * durable record, posted immediately after the `[correction]` archive it
 * is annotating, best-effort (see `correctWorker`'s catch block: its own
 * failure must never mask the original edit error).
 */
export const CORRECTION_REJECTED_MARKER = "[correction-rejected]";

/**
 * Body for the `CORRECTION_REJECTED_MARKER` follow-up comment — mirrors
 * `correctionArchiveBody`'s shape so the two read as one family. Points at
 * "the archive comment immediately above" rather than an ID: comments are
 * posted in order and this one is always the very next one, so a reader
 * never needs anything but position to connect the two.
 */
function correctionRejectedAnnotationBody(workerKey: string, editError: string): string {
  return [
    `the ${CORRECTION_MARKER} archive comment immediately above records a write that was REJECTED.`,
    `The edit meant to replace it failed (${editError}) after the archive was posted, so the archived text above did NOT get superseded — ${workerKey}'s description/summary are UNCHANGED. Treat the archived text above as still current, not history. Safe to retry.`,
  ].join("\n\n");
}

/**
 * Documented, non-configurable Jira Cloud limits, established rather than
 * guessed (BUTCHR-136, corrected on review): Jira Cloud enforces a fixed
 * 32767-character limit on rich-text fields, `description` included — this
 * is NOT the `jira.text.field.character.limit` advanced setting (that
 * setting is a Server/Data Center mechanism, configurable there, and does
 * not exist as a readable or writable Cloud setting at all; asserting
 * "fixed... and not configurable" under that name would be true on Server/DC
 * for the wrong reason and wrong on Cloud, where the setting is simply
 * absent). The 32767 figure itself is corroborated, not sourced, by
 * Atlassian's support KB for `CommentBodyCharacterLimitExceededException`
 * (a Cloud Migration Assistant comment-body limit) quoting the same string
 * verbatim: "The entered text is too long. It exceeds the allowed limit of
 * 32,767 characters." — that KB is about a different field in a different
 * tool, cited here only because it independently lands on the same number
 * as the `CONTENT_LIMIT_EXCEEDED` error this verb actually catches.
 * `summary` is a separate system field with its own fixed 255-character
 * Cloud limit ("Summary can't exceed 255 characters") — the two fields are
 * NOT the same limit, which is why this is two constants, not one reused
 * twice.
 *
 * Sanity-checked against this corpus's own falsifier before shipping:
 * BUTCHR-125 holds a description Jira ACCEPTED at 30,091 characters
 * (BUTCHR-100's measurement, cited on BUTCHR-128/BUTCHR-130) — any
 * description limit at or below 30,091 would be wrong on its face, and
 * 32767 clears that bar.
 */
export const JIRA_DESCRIPTION_CHAR_LIMIT = 32767;
export const JIRA_SUMMARY_CHAR_LIMIT = 255;

/**
 * The archive comment body `correctWorker` posts BEFORE overwriting — see
 * `correctWorker`'s own doc comment for the ordering this exists to serve.
 * `CORRECTION_MARKER` is added by the caller via `tagComment`, not here, so
 * this function only ever builds the body. Calls the quoted text the
 * PREVIOUS VERSION, superseded by the current description/summary — never
 * "the wrong text": `why` covers a genuine correction as much as a boss
 * adding a late-arriving requirement to a ticket it already filed, and only
 * the first of those is "wrong". "Superseded" is accurate for both; "wrong"
 * is accurate for only one. What stays constant either way is the part that
 * matters: the ticket's CURRENT description/summary is authoritative, this
 * comment is history, not instruction.
 */
function correctionArchiveBody(why: string, oldDescription: string | undefined, oldSummary: string | undefined): string {
  const parts = [`why: ${why}`, "The text below is the PREVIOUS VERSION — superseded by the ticket's CURRENT description/summary, kept here as history, not instruction."];
  if (oldDescription !== undefined) parts.push("--- previous description ---", oldDescription.trim() ? oldDescription : "(was empty)");
  if (oldSummary !== undefined) parts.push("--- previous summary ---", oldSummary.trim() ? oldSummary : "(was empty)");
  return parts.join("\n\n");
}

export interface CorrectWorkerInput {
  description?: string;
  summary?: string;
  /** Why the text changed — a genuine correction ("this was wrong") AND a late-arriving requirement added to an already-filed ticket ("this was incomplete") are both legitimate; this is NOT restricted to "what was wrong". */
  why: string;
}
export interface CorrectWorkerResult {
  key: string;
  correctedDescription: boolean;
  correctedSummary: boolean;
  /** States, in words, what this correction reaches and (when a summary was corrected) what it does NOT — see the function comment's "TWO FIELDS, TWO DIFFERENT REACHES" section. */
  message: string;
}

/**
 * Corrects ONE OF THE CALLER'S OWN workers' description and/or summary IN
 * PLACE — a REPLACE, never an append — after archiving the superseded text
 * as a comment first. Built for BUTCHR-41: no agent in this fleet could
 * previously edit a ticket's most-read text, so every correction was a
 * comment posted UNDERNEATH text that stayed wrong forever, and an agent
 * that reads the description carefully and the comments quickly (the
 * normal, correct ratio) built the wrong thing while believing it had read
 * the ticket. Nothing errored. The design decision this implements — an
 * edit verb, chosen over an append-only rendered correction block and over
 * moving the authoritative brief into the doc — was argued and approved on
 * BUTCHR-41 before this was built; that ticket carries the reasoning, this
 * comment states the contract and the ordering.
 *
 * TWO LEGITIMATE USE CASES, ONE VERB, ONE MARKER — do not read `why` as
 * "what was wrong" only. A boss also reaches for this when it holds a
 * genuinely NEW fact its worker's ticket predates — a late-arriving
 * requirement added AFTER the child was already filed — which is not an
 * error in the original text, just text that stopped being current. Both
 * are "the text changed, and here is why"; only the first is "wrong". Kept
 * as ONE verb and ONE marker (`CORRECTION_MARKER`) rather than splitting a
 * second one for the additive case: two markers means two greps, and
 * someone eventually runs only one and gets a confidently incomplete
 * answer, which is worse than no answer. The archive wording below reflects
 * this — it calls the old text the PREVIOUS VERSION, never "the wrong
 * text", because "superseded" is accurate for both cases and "wrong" is
 * accurate for only one.
 *
 * REFUSALS, IN THE ORDER THEY ARE CHECKED — cheapest, no-Jira-read checks
 * first, exactly as `shelveWorker` orders its own reason check before its
 * ownership read:
 *   1. `workerKey === callerKey` — refused BEFORE any Jira read, the same
 *      shape `prioritizeWorker` already refuses for: your own brief is your
 *      boss's judgment, never your own. An agent that could rewrite its own
 *      definition of done could launder a failure into a success, and the
 *      resulting ticket would be indistinguishable from one that was always
 *      right — a WORSE artefact than the stale text this verb exists to
 *      fix, because stale text is at least honestly wrong. The route up
 *      still exists and is unchanged: ask_boss / report_to_boss.
 *   2. neither `description` nor `summary` given — a correction that
 *      corrects nothing is a mistake, not a no-op.
 *   3. `why` empty or whitespace-only — same discipline `shelveWorker`
 *      already applies to its own `reason`: an intention nobody wrote down
 *      is indistinguishable six weeks later from a mistake.
 *   4. oversized `description`/`summary` — BUTCHR-136: refused against the
 *      REAL, documented Jira Cloud limits (`JIRA_DESCRIPTION_CHAR_LIMIT`,
 *      `JIRA_SUMMARY_CHAR_LIMIT`) BEFORE the archive comment is posted, so
 *      an oversized correction leaves the worker byte-for-byte untouched
 *      instead of an archive comment with no replacement to match it. This
 *      is a cheap, no-Jira-read check like 1-3 above, so it belongs here,
 *      not after the ownership read.
 *   5. `assertOwnWorker` — the existing ownership helper, reused unchanged;
 *      this is the only place ownership is checked, on purpose.
 *
 * WHEN THE REPLACE FAILS FOR ANY OTHER REASON — a pre-check on size cannot
 * cover a transient network fault, a permissions change, or any other
 * ground Jira might reject on. In that case the archive already stands, so
 * the catch below posts a best-effort `CORRECTION_REJECTED_MARKER`
 * follow-up comment marking that archive as recording a write that was
 * REJECTED, then re-throws the ORIGINAL error unchanged. "Best-effort"
 * means exactly that: the follow-up post is wrapped in its own try/catch
 * that swallows its own failure — a reader who never sees the annotation
 * still gets the original, already-correct error, never a secondary one
 * about the annotation itself failing.
 *
 * ARCHIVE BEFORE OVERWRITE — THE ORDERING IS THE DESIGN, not decoration:
 * this reads the worker's CURRENT description/summary, posts them as a
 * `CORRECTION_MARKER`-tagged comment, and ONLY THEN performs the edit. If
 * the archive comment fails, this REFUSES and does not edit. Stated so the
 * ordering can be CHECKED, not trusted, the same standard `newWorker`'s own
 * comment holds itself to: archive fails -> nothing is destroyed, the call
 * refuses, the worker is unchanged; edit fails AFTER a successful archive
 * -> one harmless extra comment sits on the worker, its description/summary
 * are UNCHANGED, and retrying is safe. This is why no separate rendered
 * "correction block" is needed: the audit trail lives in the COMMENT
 * STREAM, which this factory already treats as the event log, and the
 * description holds what is true now. Today the truth is a comment under
 * wrong text; after this call, the wrong text is a comment under the
 * truth — that inversion is the entire point.
 *
 * TWO FIELDS, TWO DIFFERENT REACHES — NOT THE SAME PROBLEM, and this is the
 * honest half of the feature, stated in `result.message`, not just here:
 * A DESCRIPTION is read LIVE — every read goes through `jira_get_issue`, so
 * correcting it reaches every future reader, including an agent that spawns
 * later, with no further action by anyone. A SUMMARY is SNAPSHOTTED — the
 * workspace builder interpolates it into `brief.md`/`CLAUDE.md` at
 * workspace-build time, so correcting it updates Jira, the board and every
 * future read, but does NOT rewrite the `brief.md` already on disk for an
 * agent that is currently running. Rewriting live workspaces is
 * deliberately OUT OF SCOPE. `result.message` names this limitation ONLY
 * when a summary was actually corrected, and points at `tell_worker` as the
 * follow-up if a running agent needs to know.
 *
 * WHO MAY CORRECT AN EPIC'S DESCRIPTION, STATED AS WHAT `assertOwnWorker`
 * ACTUALLY CHECKS, NOT AS WHICH TIERS HAPPEN TO EXIST TODAY: a PROJECT
 * caller may correct a target that is BOTH a member of its own project AND
 * an Epic — so a project agent CAN correct one of its own epics'
 * descriptions with this verb. Refusal 1 above is unaffected and
 * unconditional at every tier, project callers included: it only stops a
 * ticket from correcting ITSELF (`workerKey === callerKey`) — nobody
 * corrects themselves, an epic being corrected by its own project is not an
 * exception to that. Where `assertOwnWorker` accepts no caller for a given
 * ticket, the recourse is a person editing it directly in the Jira UI — the
 * same "the human is the fallback, not the first responder" arrangement
 * this fleet already runs on elsewhere, and the intended path here, not a
 * workaround. This comment previously claimed no agent could ever correct
 * an epic this way, on the premise that stood before BUTCHR-62 shipped the
 * project tier; that premise no longer holds, and the claim built on it was
 * corrected under BUTCHR-88. See BUTCHR-53's review comments on BUTCHR-41
 * for the original ruling this refines.
 */
export async function correctWorker(ops: AtlassianOps, callerKey: string, workerKey: string, input: CorrectWorkerInput): Promise<CorrectWorkerResult> {
  if (workerKey === callerKey) {
    throw new Error(
      `correct_worker: refusing to correct ${callerKey}'s own description/summary — your own brief is your boss's judgment, never your own; an agent that can rewrite its own definition of done can launder a failure into a success, and the resulting ticket would be indistinguishable from one that was always right. Ask your own boss to correct it instead (ask_boss / report_to_boss) — it can correct you, you cannot correct yourself.`,
    );
  }
  if (input.description === undefined && input.summary === undefined) {
    throw new Error("correct_worker: neither `description` nor `summary` was given — a correction that corrects nothing is a mistake, not a no-op");
  }
  if (!input.why.trim()) {
    throw new Error("correct_worker: `why` is required and must be non-empty — an intention nobody wrote down is indistinguishable six weeks later from a mistake");
  }
  if (input.description !== undefined && input.description.length > JIRA_DESCRIPTION_CHAR_LIMIT) {
    throw new Error(
      `correct_worker: refusing — the new description is ${input.description.length} characters, over Jira's ${JIRA_DESCRIPTION_CHAR_LIMIT}-character limit; ${workerKey} is untouched, no comment was posted. Cut it down and retry.`,
    );
  }
  if (input.summary !== undefined && input.summary.length > JIRA_SUMMARY_CHAR_LIMIT) {
    throw new Error(
      `correct_worker: refusing — the new summary is ${input.summary.length} characters, over Jira's ${JIRA_SUMMARY_CHAR_LIMIT}-character limit; ${workerKey} is untouched, no comment was posted. Cut it down and retry.`,
    );
  }
  await assertOwnWorker(ops, "correct_worker", callerKey, workerKey);

  const issue = await ops.getIssue(workerKey);
  // adfToText's node type isn't exported (src/atlassian/client.ts) — pulled
  // structurally via Parameters rather than duplicating or widening to `any`.
  const oldDescription = input.description !== undefined ? adfToText(descriptionOf(issue) as Parameters<typeof adfToText>[0]) : undefined;
  const oldSummary = input.summary !== undefined ? (summaryOf(issue) ?? "") : undefined;

  const archiveBody = tagComment(callerKey, `${CORRECTION_MARKER} ${correctionArchiveBody(input.why, oldDescription, oldSummary)}`);
  try {
    await ops.addComment(workerKey, archiveBody);
  } catch (e) {
    throw new Error(
      `correct_worker: the archive comment failed to post on ${workerKey} (${(e as Error).message}) — refusing to edit without first preserving the superseded text; ${workerKey} is UNCHANGED.`,
    );
  }

  try {
    await ops.correctText(workerKey, {
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.summary !== undefined ? { summary: input.summary } : {}),
    });
  } catch (e) {
    const editError = (e as Error).message;
    try {
      await ops.addComment(workerKey, tagComment(callerKey, `${CORRECTION_REJECTED_MARKER} ${correctionRejectedAnnotationBody(workerKey, editError)}`));
    } catch {
      // Best-effort, by design: the annotation is a nice-to-have durable
      // record, not a substitute for the ORIGINAL error thrown below. A
      // reader who never sees this comment still gets the correct,
      // already-established error text — never a secondary error about the
      // annotation itself failing to post.
    }
    throw new Error(
      `correct_worker: archived the superseded text on ${workerKey} (see the ${CORRECTION_MARKER} comment) but the edit itself failed (${editError}) — one harmless extra comment now sits on ${workerKey}; its description/summary are UNCHANGED. Safe to retry.`,
    );
  }

  const correctedDescription = input.description !== undefined;
  const correctedSummary = input.summary !== undefined;
  const message = correctedSummary
    ? `correct_worker: ${workerKey}'s ${correctedDescription ? "description and summary" : "summary"} corrected; the superseded text was archived first (${CORRECTION_MARKER}). NOTE: a summary is SNAPSHOTTED into a workspace's brief.md/CLAUDE.md at build time — this correction updates Jira, the board and every future read, but does NOT rewrite the workspace already on disk for an agent currently running on ${workerKey}. If a running agent needs to know, follow up with tell_worker.`
    : `correct_worker: ${workerKey}'s description corrected; the superseded text was archived first (${CORRECTION_MARKER}). A description is read live (jira_get_issue), so this reaches every future reader immediately, including any agent that spawns later.`;

  return { key: workerKey, correctedDescription, correctedSummary, message };
}

/**
 * The only way to speak DOWN to a worker. Refuses a key that is not one of
 * the caller's own workers. The highest-consequence messages in this fleet
 * travel here: the `[review] APPROVED <pr-url> @ <sha>` / `[review]
 * CHANGES_REQUESTED` lines that wake a PR author, and the `ANSWER <n>
 * <fingerprint>` reply that unfreezes a worker blocked on a dialog.
 */
export async function tellWorker(ops: AtlassianOps, callerKey: string, workerKey: string, text: string): Promise<unknown> {
  await assertOwnWorker(ops, "tell_worker", callerKey, workerKey);
  return ops.addComment(workerKey, tagComment(callerKey, text));
}

// ---------------------------------------------------------------------------
// Worker -> boss
// ---------------------------------------------------------------------------

/**
 * Speaks on the CALLER'S OWN CHANNEL — an issue caller's own ticket, a
 * PROJECT caller's own ROOT DOC (see `speakOnOwnChannel`, the seam that
 * decides which). No key parameter, by design — see the glossary page's
 * "known hazard, kept deliberately" note. A PROJECT CALLER IS ALLOWED HERE
 * (BUTCHR-71 spec correction, ruled by the epic on BUTCHR-62): a project has
 * no boss to submit its own ticket to (see `submitToBoss`), but it is
 * genuinely talked TO by comments on its root doc, and this is the
 * corresponding way it talks back — including to escalate when it is
 * blocked, which every brief in this fleet depends on being possible.
 */
export async function reportToBoss(ops: AtlassianOps, callerKey: string, text: string): Promise<unknown> {
  return speakOnOwnChannel(ops, callerKey, tagComment(callerKey, text));
}

/**
 * Same channel as report_to_boss, but marked `[ask]` right after the
 * identity tag — greppable, so a boss can find its workers' unanswered
 * questions without reading every comment. Asking does NOT change the
 * asker's status. Allowed for a PROJECT caller, same reasoning as `reportToBoss`.
 */
export async function askBoss(ops: AtlassianOps, callerKey: string, text: string): Promise<unknown> {
  return speakOnOwnChannel(ops, callerKey, tagComment(callerKey, `${ASK_MARKER} ${text}`));
}

/** The caller's OWN ticket -> In Review. No arguments at all — the one transition an agent is always entitled to make about itself. */
export async function submitToBoss(ops: AtlassianOps, callerKey: string): Promise<unknown> {
  return ops.transition(callerKey, "In Review");
}

// ---------------------------------------------------------------------------
// Self-close: finish_without_a_boss
// ---------------------------------------------------------------------------

/**
 * The caller's OWN ticket -> Done, but ONLY when the caller HAS NO BOSS.
 * Every other route to Done goes through a review hop: `submit_to_boss`
 * only ever targets In Review, and `finish_worker` only fires from a boss
 * closing one of its OWN workers. Neither reaches a ticket with no boss at
 * all (today, in practice, an Epic) — that ticket has nobody to submit to
 * and nobody who will ever call `finish_worker` on it. This verb is the
 * dedicated route for exactly that one case, and no other.
 *
 * NO ARGUMENTS: like `submit_to_boss`, the only ticket this can ever act on
 * is the caller's own (`x-issue`), so there is nothing to get wrong.
 *
 * THE REFUSAL IS THE FEATURE, NOT A GUARD. A worker never finishes itself —
 * that is the entire point of the boss/worker asymmetry (`finish_worker`'s
 * own doc comment), and this verb exists to hold that line for the one
 * caller shape that could otherwise slip past it: a ticket with a boss has
 * no business reaching for a "no boss" verb, so refusing it here converts
 * "a worker never finishes itself" from a sentence in a brief into a call
 * that fails, the same move `prioritize_worker` makes refusing the caller's
 * own key. Every Done in this system, apart from this one deliberate
 * exception, requires a SECOND IDENTITY to have looked at the work before
 * it closes; a caller with a boss already has that second identity waiting
 * (`submit_to_boss`, then its boss's `finish_worker`), so it is refused here
 * and pointed at the path that actually gets its work reviewed.
 *
 * DESIGNED TO BECOME OBSOLETE, NOT ABANDONED. This system's design decisions
 * record a planned tier ABOVE epics (a "project" level) that does not exist
 * yet. If it did, an epic would have a boss like everything else, would call
 * `submit_to_boss` and let that boss call `finish_worker` on it, and this
 * verb would simply have no caller left — a ticket with a boss can never use
 * it, so the day every top-level ticket has one, this narrows to nothing ON
 * ITS OWN, with no removal needed. A future reader who finds this verb with
 * zero callers should read that as the tier having arrived, not as dead code
 * nobody cleaned up.
 *
 * OPEN QUESTION THIS DOES NOT SETTLE, AND IS NOT THIS VERB'S TO SETTLE:
 * whether a top-level ticket SHOULD be able to close itself at all, with no
 * second identity ever looking, is a real question — every other Done here
 * requires a review hop, and a bossless ticket's self-close has none. This
 * verb only formalizes what `jira_transition` already lets happen today; it
 * takes no position on whether that's the right end state, and that
 * question belongs to whoever decides if and when the project tier above
 * epics gets built — a human call, not an agent's to make by building or
 * not building this.
 */
export async function finishWithoutABoss(ops: AtlassianOps, callerKey: string): Promise<unknown> {
  const issue = await ops.getIssue(callerKey);
  const boss = findBossKey(issue);
  if (boss) {
    throw new Error(
      `finish_without_a_boss: ${callerKey} has a boss (${boss}) — refusing. Use submit_to_boss to move your own ticket to In Review, then let ${boss} call finish_worker on you instead. Every Done in this system requires a second identity to have looked at the work before it closes; a ticket with a boss already has one waiting, so it can never close itself — that review hop is the point, not an inconvenience.`,
    );
  }
  return ops.transition(callerKey, "Done");
}

// ---------------------------------------------------------------------------
// The deliberate-orphan escape: file_where_it_belongs
// ---------------------------------------------------------------------------

/**
 * `butchr:orphan` — makes "show me every undirected ticket" a one-line JQL
 * filter. Applied exactly once, at creation, by `fileWhereItBelongs`.
 * WITHDRAWN by `adoptWorker` / `adoptProjectWorker` (BUTCHR-108/BUTCHR-137)
 * the moment the ticket gains a boss — for either disposition, not gated on
 * idempotence — see the comment at those `removeLabels` calls for the full
 * reasoning.
 *
 * Never combined with `EXEMPT_LABEL` (`butchr:shelved`) IN THE SAME CALL:
 * `fileWhereItBelongs` never applies `EXEMPT_LABEL` at creation (see its own
 * doc comment for why an orphan can't trip the parked-ticket detector), and
 * `adoptWorker`'s `"shelve"` path withdraws `ORPHAN_LABEL` in the same call
 * it adds `EXEMPT_LABEL` — so a live ticket never ends up carrying both.
 */
export const ORPHAN_LABEL = "butchr:orphan";

/** A destination is either a named existing Epic, or prose explaining why a new one is needed. Neither is a fallback for the other. */
export type OrphanDestination = { kind: "epic"; key: string } | { kind: "reason"; text: string };

/**
 * Known placeholders an agent reaches for when it hasn't actually thought
 * about where work belongs. Normalized (trimmed, lowercased, trailing
 * `.`/`!` stripped) before comparison, so "N/A.", "Unknown", " tbd " all
 * still hit.
 */
const PLACEHOLDER_DESTINATIONS = new Set([
  "n/a", "na", "tbd", "unknown", "none", "?", "??", "-", "--", "idk", "dunno", "todo", "later", "null", "undefined", "n/a for now",
]);

/**
 * A prose reason shorter than this (non-whitespace characters) is refused as
 * too thin to be a real reason. Tuned deliberately low: every placeholder in
 * PLACEHOLDER_DESTINATIONS is already caught by that set, so this only needs
 * to catch the un-listed near-placeholders ("misc", "later maybe") without
 * punishing a genuinely terse real reason like "no epic covers billing yet"
 * (which clears it easily). A false refusal here is worse than letting a
 * marginal one through — it's what teaches an agent the verb is an obstacle.
 */
const MIN_REASON_CHARS = 8;

function normalizeDestinationText(raw: string): string {
  return raw.trim().toLowerCase().replace(/[.!]+$/, "");
}

/**
 * Every refusal from this verb ends on the same teaching tail: what a good
 * destination looks like, both accepted shapes, and WHY it's asked at all.
 * `reason` is the specific complaint, stated plainly and without scolding.
 */
function destinationRefusal(reason: string): Error {
  return new Error(
    `file_where_it_belongs: ${reason} A destination is either an EXISTING EPIC KEY this work belongs under (e.g. "BUTCHR-25"), or a short REASON it needs a brand-new epic (e.g. "no epic covers observability tooling yet") — both are legitimate, neither is a fallback for the other. ` +
      "This is required, not bureaucracy: filing a ticket outside your own scope is only half the job — saying where it should live is the other half. An orphan with no stated destination is exactly the silent failure this verb exists to prevent.",
  );
}

/**
 * Classifies (and refuses) `raw` — pure, no Jira reads. A Jira-key-shaped
 * destination is returned as `{ kind: "epic" }` UNVALIDATED: whether it
 * actually exists and is actually an Epic is a read, done by the caller
 * (fileWhereItBelongs), not here.
 */
export function classifyDestination(raw: string): OrphanDestination {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw destinationRefusal("no destination was given (empty, or only whitespace).");
  }
  if (JIRA_KEY_RE.test(trimmed)) {
    return { kind: "epic", key: trimmed };
  }
  const normalized = normalizeDestinationText(trimmed);
  if (PLACEHOLDER_DESTINATIONS.has(normalized)) {
    throw destinationRefusal(`"${trimmed}" is a placeholder, not a destination.`);
  }
  if (trimmed.replace(/\s+/g, "").length < MIN_REASON_CHARS) {
    throw destinationRefusal(`"${trimmed}" is too thin to be a real reason a new epic is needed.`);
  }
  return { kind: "reason", text: trimmed };
}

/** The header block baked into the created ticket's OWN description — see fileWhereItBelongs's doc comment for why this, not a comment, is where the destination is recorded. */
function orphanHeader(destination: OrphanDestination, filerKey: string): string {
  const where = destination.kind === "epic" ? `Epic ${destination.key}` : `a NEW epic (none exists yet) — reason given: "${destination.text}"`;
  return [
    "[ORPHAN] This ticket has no boss. It was filed here on purpose, outside its filer's own scope.",
    `Filed by: ${filerKey}`,
    `Destination: ${where}`,
    "It is not linked to anything yet — a boss makes it theirs by calling adopt_worker. Until then, nobody owns it.",
  ].join("\n");
}

/** The pushed notice's body — worded so a human reading it cold (case A on the epic, case B on the topmost ticket) knows what was filed, by whom, where it's meant to go, and that it isn't anyone's yet. */
function orphanNotice(filerKey: string, key: string, summary: string, destination: OrphanDestination, noticeTarget: string): string {
  const belongs =
    destination.kind === "epic"
      ? `${filerKey} thinks it belongs under this epic (${destination.key}) — it is NOT linked to you; filing this notice does not make it yours. Adopt it with adopt_worker if you want it.`
      : `${filerKey} says it needs a NEW epic — reason given: "${destination.text}". There is no epic yet to comment on, so this is posted here, on the topmost ticket in ${filerKey}'s own Implements chain (${noticeTarget}), for a human to see and decide.`;
  return [`Filed ${key} ("${summary}"), outside ${filerKey}'s own scope.`, belongs, `${key} has no boss and is linked to nothing — nobody owns it until someone adopts it.`].join("\n");
}

/** Depth cap for walking a caller's OWN Implements chain in case B — same reasoning as ensureDoc's MAX_BOSS_DEPTH: a real boss chain is a handful of hops, and only a genuine Implements cycle would recurse forever without one. */
const MAX_ORPHAN_CHAIN_DEPTH = 20;

/** Walks UP `startKey`'s own Implements chain (never the new orphan's — it has none) to the topmost ticket, reusing `startIssue` (already fetched by the caller) to avoid re-reading `startKey` itself. */
async function topmostBoss(ops: AtlassianOps, startKey: string, startIssue: unknown): Promise<string> {
  let key = startKey;
  let issue = startIssue;
  for (let i = 0; i < MAX_ORPHAN_CHAIN_DEPTH; i++) {
    const boss = findBossKey(issue);
    if (!boss) return key;
    key = boss;
    issue = await ops.getIssue(key);
  }
  throw new Error(`file_where_it_belongs: ${startKey}'s own Implements chain is more than ${MAX_ORPHAN_CHAIN_DEPTH} hops deep — refusing rather than risking a cycle looping forever`);
}

export interface FileWhereItBelongsInput {
  summary: string;
  description?: string;
  issuetype: "Story" | "Task";
  priority?: string;
  destination: string;
}
export interface FileWhereItBelongsResult {
  key: string;
  destination: OrphanDestination;
  noticeTarget: string;
  doc: DocResult;
}

/**
 * The successor to `jira_create_issue`'s `implements: "none"` deliberate-
 * orphan escape (still an unchanged alias this release — see defs.ts). Files
 * a ticket that is explicitly NOT the caller's: no Implements link is ever
 * made, to the destination or to anything else. Was named
 * `file_for_another_boss` during design; renamed before shipping because
 * that name asserts there IS another boss, which is false in the "needs a
 * new epic" case — see the glossary entry for the full reasoning.
 *
 * NO DISPOSITION PARAMETER, unlike new_worker/adopt_worker — argued, not
 * omitted: a disposition answers "what happens to MY worker", and nobody can
 * answer that for a ticket that is by definition not the caller's. It is
 * filed To Do, staffed by role exactly as jira_create_issue staffs it today,
 * and stays there until some future boss calls adopt_worker on it.
 *
 * NEVER LABELLED `EXEMPT_LABEL` (butchr:shelved): `parkedCandidates`
 * (src/agents/parked.ts) only ever walks tickets reachable by an Implements
 * link off the active set, and this ticket has none — the parked detector
 * structurally cannot see it, so that label here would be cargo-culted state
 * meaning nothing. Labelled `ORPHAN_LABEL` instead, which is what actually
 * makes it discoverable (a saved JQL filter) — withdrawn by `adoptWorker` /
 * `adoptProjectWorker` the moment this ticket gains a boss and stops being
 * undirected (BUTCHR-108/BUTCHR-137); see the comment at those
 * `removeLabels` calls.
 *
 * WRITE ORDER, AND WHY: unlike new_worker, there is no "worst survivable
 * state" to protect against here, because this ticket never gets a boss link
 * at all — the one thing that makes a half-finished new_worker call
 * dangerous (a linked-but-undeclared child a live boss waits on forever)
 * cannot happen to an orphan by construction. So the ordering question here
 * is narrower: which is worse, a real ticket whose destination is on it but
 * whose human notice never fired, or a notice that points at a ticket that
 * doesn't exist? The second is actively misleading — a dangling reference a
 * human can't even open — while the first is merely quiet: the ticket is
 * still fully self-documenting (destination in its own description,
 * ORPHAN_LABEL for the saved-filter route) and findable with zero
 * cooperation from anything downstream. So:
 *   1. CREATE — summary, issuetype, assignee (by role), priority, and a
 *      description with the destination header ALREADY BAKED IN, plus
 *      ORPHAN_LABEL — all in the one call. Irreversible, and there is no
 *      window, ever, where this ticket exists without its destination
 *      recorded on it: both land in the same write.
 *   2. NOTICE — best-effort comment: case A on the named epic, case B on the
 *      topmost ticket in the CALLER's own Implements chain (walked fresh,
 *      never the orphan's own — it has none). Creates NO link either way;
 *      case B in particular must never re-parent the ticket onto whatever it
 *      lands on, or this verb becomes the exact suppression-by-quiet-
 *      adoption it exists to prevent.
 *   3. DOC — ensureDoc, last, same reasoning as new_worker: convergent
 *      (BUTCHR-33), so a failure here is reported but not rolled back, and
 *      is completed by this ticket's own first set_doc call whenever its
 *      eventual owner makes one. `ensureDoc` already bottoms a bossless
 *      ticket out under the project root doc, so this needs no new logic —
 *      the orphan surfaces in the doc tree at the top level, next to the
 *      epics.
 *
 * WHAT A THROW AFTER STEP 1 MEANS, HONESTLY: the ticket, its destination and
 * ORPHAN_LABEL all survive untouched — there is nothing to roll back, and
 * nothing here ever attempts to. The error names exactly which of the notice
 * and the doc failed (either, or both) and what a caller can do about each:
 * re-post the notice by hand with jira_add_comment, or wait for the ticket's
 * own first set_doc call.
 *
 * A KNOWN NARROWING IN CASE B, RECORDED RATHER THAN FIXED (found in review of
 * BUTCHR-37, after that branch had already merged — a defect in the original
 * spec, not in that implementation): case B's guarantee is "a person sees
 * it" only when the CALLER's own Implements chain is intact and bottoms out
 * at an Epic, which is human-watched. `topmostBoss` walks that chain and
 * returns whatever key has no boss above it — if the CALLER ITSELF is a
 * bossless Story (an orphan filing an orphan), that key is the caller's own,
 * and the notice lands on an agent-owned ticket nobody human is watching.
 * The guarantee silently degrades from "a person sees it" to "an agent sees
 * it". This is rare — it needs an orphan to be doing the filing — and it is
 * inherent to how the walk is specified (find the topmost ticket in MY OWN
 * chain), not a bug in the walk itself. NOT fixed here: no fallback, no
 * config key, no human/root-key lookup added for it — matching this file's
 * own standard elsewhere (see `newWorker`'s three throws and its measured
 * `DELETE_ISSUES` refusal) of stating a known limitation rather than
 * silently accepting it or quietly patching around it.
 *
 * CASE B'S MISSING LINK IS DELIBERATE, AND IT WILL NOT FEEL DELIBERATE TO
 * WHOEVER READS IT NEXT — that is exactly why this is spelled out rather than
 * left to the "creates NO link" line above to carry alone. A notice arrives
 * on someone's ticket announcing unowned work; the natural, helpful,
 * courteous reflex on reading it is to link the orphan so it has a home. THAT
 * REFLEX IS THE FAILURE this verb exists to prevent — the same
 * suppression-by-quiet-adoption named above, just arriving as a well-meaning
 * "fix" instead of a bug. Nothing about the missing link is an oversight: do
 * not add it, ever, from inside this function. The fact that adding it feels
 * like a kindness is precisely the reason the warning has to be this
 * explicit — a reader who understands WHY they want to change this is far
 * less likely to than one who is only told not to.
 */
export async function fileWhereItBelongs(ops: AtlassianOps, roles: Roles, callerKey: string, input: FileWhereItBelongsInput): Promise<FileWhereItBelongsResult> {
  const destination = classifyDestination(input.destination);

  if (destination.kind === "epic") {
    let epicIssue: unknown;
    try {
      epicIssue = await ops.getIssue(destination.key);
    } catch (e) {
      throw destinationRefusal(`"${destination.key}" looks like a Jira key but could not be read (${(e as Error).message}) — a typo'd destination that silently "succeeds" produces an orphan whose stated home does not exist.`);
    }
    const epicType = issuetypeOf(epicIssue);
    if (epicType !== "Epic") {
      throw destinationRefusal(`"${destination.key}" exists but is a ${epicType ?? "unknown type"}, not an Epic.`);
    }
  }

  const role = input.issuetype === "Story" ? roles.story : roles.task;
  if (!role) throw new Error(noRoleMsg("file_where_it_belongs", input.issuetype));

  const callerIssue = await ops.getIssue(callerKey);
  const projectKey = projectKeyOf(callerIssue);
  if (!projectKey) throw new Error(`file_where_it_belongs: could not read ${callerKey}'s own project key — refusing rather than guessing`);

  const header = orphanHeader(destination, callerKey);
  const description = input.description ? `${header}\n\n---\n\n${input.description}` : header;

  // (1) create — irreversible; destination + ORPHAN_LABEL land in this same call.
  const created = (await ops.createIssue({
    projectKey,
    issuetype: input.issuetype,
    summary: input.summary,
    description,
    assignee: role,
    ...(input.priority ? { priority: input.priority } : {}),
    labels: [ORPHAN_LABEL],
  })) as { key?: string };
  const key = created.key;
  if (!key) throw new Error("file_where_it_belongs: create response carried no issue key — refusing to notify or document against nothing");

  // (2) notice — best-effort, never a link.
  const noticeTarget = destination.kind === "epic" ? destination.key : await topmostBoss(ops, callerKey, callerIssue);
  const noticeText = tagComment(callerKey, orphanNotice(callerKey, key, input.summary, destination, noticeTarget));
  let noticeError: string | undefined;
  try {
    await ops.addComment(noticeTarget, noticeText);
  } catch (e) {
    noticeError = (e as Error).message;
  }

  // (3) doc — last, on purpose (see the function comment).
  let doc: DocResult | undefined;
  let docError: string | undefined;
  try {
    doc = await ensureDoc(ops, key);
  } catch (e) {
    docError = (e as Error).message;
  }

  if (noticeError || docError) {
    const parts: string[] = [`file_where_it_belongs: ticket ${key} was created with its destination recorded and ${ORPHAN_LABEL} applied — nothing there needs cleanup.`];
    if (noticeError) parts.push(`The notice comment on ${noticeTarget} failed (${noticeError}); post it by hand with jira_add_comment(${noticeTarget}, ...) if it still matters.`);
    if (docError) parts.push(`Its Confluence doc failed to create (${docError}); it will be completed by ${key}'s own first set_doc call, whenever the agent working it makes one.`);
    throw new Error(parts.join(" "));
  }

  return { key, destination, noticeTarget, doc: doc! };
}
