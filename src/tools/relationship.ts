import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AtlassianOps } from "./atlassian.js";
import { findBossKey, ensureDoc, JIRA_KEY_RE, type DocResult } from "./docs.js";
import { EXEMPT_LABEL } from "../agents/parked.js";
import { adfToText } from "../atlassian/client.js";
import { isProjectId } from "../resources/id.js";
import { speakOnOwnChannel } from "./speak.js";
import { briefFor, interpolate, workspaceRoot, type SpawnSpec } from "../agents/workspace.js";

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

/**
 * The swallowed-argument shape (BUTCHR-177/BUTCHR-180): a caller's tool call
 * malforms one argument's closing tag, and the harness's own argument parser
 * folds everything after it — including the FOLLOWING argument's own opening
 * tag — into the still-open value. Measured twice in this corpus, both on
 * `file_where_it_belongs`'s `destination` (BUTCHR-127 via BUTCHR-102,
 * BUTCHR-164 via BUTCHR-156): a ticket's own description, in the wrong
 * field, whole and readable but sitting behind a visible seam nobody's code
 * caught. Both specimens contain the SAME two substrings in the SAME order:
 * a closing tag naming the argument that was cut short, immediately
 * followed by this harness's own `<parameter name="...">` wrapper opening
 * the next one.
 *
 * This catches the SHAPE, not a length bound — see `MIN_REASON_CHARS`'s own
 * comment for the opposite bound already living beside this one. A long,
 * honest reason is legitimate and must not be refused for being long, only
 * for CONTAINING what a swallowed argument boundary looks like. Two
 * capturing groups, never both set: group 1 is the name inside a premature
 * `</name>` closing tag; group 2 is the name inside a `<parameter name="...">`
 * opening tag. Exported so this guard's own tests read one symbol rather
 * than a re-typed regex that could silently drift from what this actually
 * checks.
 */
export const SWALLOWED_ARGUMENT_RE = /<\/([A-Za-z_][\w:-]*)\s*>|<parameter\s+name=["']([^"']+)["']/;

/**
 * Refuses a SHORT-PROSE argument — one an agent composes as a title, a
 * reason, or a brief explanation, as opposed to a `description` or a doc
 * `body`, which may legitimately contain any text at all, this shape
 * included, and must never be guarded this way (getting that backwards
 * would make the tools unable to describe their own defects — including the
 * tickets that found this one). Called EARLY in every relationship verb
 * that accepts one, before that verb's first side effect — the point is to
 * fail the call before anything is written or posted, not to clean up
 * after.
 *
 * Matches `destinationRefusal`'s own house style deliberately (see that
 * function, just below in this file for `file_where_it_belongs`'s own
 * `destination`): the specific complaint, plainly and without scolding,
 * then a teaching tail. The tail never reproduces the matched text as one
 * contiguous run of `<`, `/` and `>` — only the bare argument NAME the tag
 * appeared to reference — for the same reason this whole ticket exists: a
 * caller that copied a refusal message straight into its next call would
 * otherwise be handed the exact literal that trips this guard.
 *
 * FALSE-POSITIVE COST, STATED OUT LOUD: a legitimate value that happens to
 * contain real tag-shaped text (quoting markup, or describing this very
 * defect) will be refused. That is why this refusal explains what to do
 * instead — break the literal up in words — rather than only "try again",
 * which would just reintroduce the problem one layer up.
 */
export function guardShortProse(verb: string, argName: string, raw: string): void {
  const m = SWALLOWED_ARGUMENT_RE.exec(raw);
  if (!m) return;
  const name = m[1] ?? m[2];
  const what =
    m[1] !== undefined
      ? `what looks like a premature closing tag naming \`${name}\``
      : `what looks like the wrapper that opens the NEXT tool-call argument (naming \`${name}\`)`;
  throw new Error(
    `${verb}: \`${argName}\` contains ${what}, partway through its own text — the exact seam a malformed tool call leaves when the harness's argument parser folds a LATER argument into this one instead of starting it separately (measured twice in this corpus: BUTCHR-127, BUTCHR-164). ` +
      `Length alone is not the problem — a long, honest \`${argName}\` is fine on its own. Rewrite the call so \`${argName}\` holds only its own value, and check that every other argument you meant to send is still its own separate argument rather than text trapped inside this one. If you genuinely need literal tag syntax inside \`${argName}\`, describe it in words instead of the raw characters — the same discipline this defect's own tickets use when they have to talk about it. This call was refused before anything was written or posted.`,
  );
}

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
  guardShortProse("new_worker", "summary", input.summary);
  if (disposition.kind === "shelve") guardShortProse("new_worker", "reason", disposition.reason);

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
  guardShortProse("new_worker", "summary", input.summary);
  if (disposition.kind === "shelve") guardShortProse("new_worker", "reason", disposition.reason);
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
  guardShortProse("shelve_worker", "reason", reason);
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
  /** BUTCHR-151/BUTCHR-157: present ONLY when this call found a stale `[ORPHAN]` description header and successfully retired it (see `retireOrphanHeader`) — absent in the overwhelmingly common case (a normal, never-orphaned worker). Mutually exclusive with `orphanHeaderNotWithdrawn`. */
  orphanHeaderWithdrawn?: string;
  /** BUTCHR-151/BUTCHR-157: present ONLY when a header-shaped block WAS found but could not be safely or successfully retired (ambiguous shape, or the write itself failed) — same "not checked must never look like checked and clean" principle as `identityUnknown`. Never blocks the adoption itself. */
  orphanHeaderNotWithdrawn?: string;
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
  if (disposition.kind === "shelve") guardShortProse("adopt_worker", "reason", disposition.reason);
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

  // BUTCHR-151/BUTCHR-157: retire a stale [ORPHAN] description header, for
  // BOTH dispositions — the same "adopted with 'shelve' is exactly as
  // directed as adopted with 'start'" reasoning the ORPHAN_LABEL clear just
  // above already uses — and NOT gated on `alreadyAdopted`, same reason: an
  // otherwise fully idempotent re-adoption still retires a header that
  // somehow survived a previous adoption (e.g. this daemon ran an older
  // version of this function then), rather than leaving the prose stale
  // forever with no other reachable remedy (mirroring ORPHAN_LABEL's own
  // "only reachable remedy is a re-adoption" argument). GATED ON THE
  // DESCRIPTION ITSELF, not on `labels.includes(ORPHAN_LABEL)` — deliberately
  // decoupled from the label's presence: a ticket whose orphan label was
  // already cleared by some other means but whose header was not must still
  // get its header looked at here, and gating on the label would silently
  // skip exactly that case. `retireOrphanHeader` never throws (see its own
  // doc comment) — a failure in this secondary concern is reported on the
  // result, never allowed to abort or corrupt the adoption already in
  // progress (the ordering/partial-state discipline this function's own doc
  // comment and the `resolveCollisionSide` guard above already hold to).
  const headerOutcome = await retireOrphanHeader(ops, issue, workerKey, callerKey);

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
    ...(headerOutcome?.retired ? { orphanHeaderWithdrawn: headerOutcome.message } : {}),
    ...(headerOutcome && !headerOutcome.retired ? { orphanHeaderNotWithdrawn: headerOutcome.message } : {}),
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

  // BUTCHR-151/BUTCHR-157: same header retirement as the issue-caller path
  // above, argued there in full — declared defence-in-depth here for the
  // same reason the ORPHAN_LABEL clear just above is: `fileWhereItBelongs`
  // can only ever create a Story or a Task, so an orphan Epic (and thus an
  // Epic carrying an [ORPHAN] header) cannot arrive through this codebase's
  // own write path today. Costs nothing extra to add — reuses the `issue`
  // already fetched for this path's own idempotence check.
  const headerOutcome = await retireOrphanHeader(ops, issue, workerKey, projectKey);

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
    ...(headerOutcome?.retired ? { orphanHeaderWithdrawn: headerOutcome.message } : {}),
    ...(headerOutcome && !headerOutcome.retired ? { orphanHeaderNotWithdrawn: headerOutcome.message } : {}),
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

/**
 * The Jira Cloud limit for a COMMENT body (BUTCHR-145/BUTCHR-140) — a
 * different field from `JIRA_DESCRIPTION_CHAR_LIMIT` above even though both
 * currently read 32767 (Atlassian's support KB for
 * `CommentBodyCharacterLimitExceededException` independently lands on the
 * same figure, cited on that constant's own comment), so this is its OWN
 * constant rather than the same one reused across two fields that could in
 * principle diverge.
 *
 * ESTABLISHED LIVE, not inherited (Requirement 1), with a THREE-WAY
 * discrimination from a single artefact rather than the usual two:
 * BUTCHR-145 posted a 32,011-character prose probe on its own ticket (id
 * 17461 — see that ticket's comment thread; two earlier probes built from
 * long runs of a single repeated character were independently found to be
 * unreliably transmitted — see the note below — and were superseded by
 * this one before being trusted) containing multi-byte guillemet markers
 * (‹ ›), which happen to separate three different size measures at once.
 * Verified by BOTH ends of the round trip: the comment was diffed
 * byte-for-byte against a locally-saved reference file after posting (all
 * 320 embedded position markers present, in order, none missing) — not
 * measured by length alone. Re-measured independently via `jira_get_issue`
 * after posting:
 *   - plain-text characters (JS string `.length`): 32,580 — UNDER 32767
 *   - UTF-8 bytes of that same text:                33,870 — OVER 32767
 *   - serialized ADF (the actual wire payload `addComment` sends; see
 *     `adf()` in atlassian-real.ts, which wraps a comment's whole body in
 *     exactly one paragraph with one text node): 35,904 — OVER 32767
 * Jira ACCEPTED the comment. Since the plain-text measure was the only one
 * of the three still under the cap, the cap is checked against PLAIN-TEXT
 * CHARACTER COUNT specifically — not UTF-8 bytes, and not the serialized
 * ADF payload — the same measure `JIRA_DESCRIPTION_CHAR_LIMIT` already
 * uses for the description field. `postCorrectionArchive` below therefore
 * splits on plain-text `.length`, not on byte length or
 * `JSON.stringify(adf(text)).length`.
 *
 * THE BOUNDARY IS BRACKETED, NOT PRECISELY MEASURED: the same 32,580-plain
 * -character comment above was ACCEPTED; BUTCHR-139's independently
 * recorded correction #3 (a real, unrelated ticket, not a probe) was
 * REFUSED with `CONTENT_LIMIT_EXCEEDED` at a plain-text archive size of
 * roughly 33,950. So the true boundary sits somewhere in (32,580, 33,950]
 * — and the documented 32767 figure falls inside that bracket, 187
 * characters above the highest accepted value measured here. This
 * corroborates 32767 from this corpus; it does not claim to have found the
 * exact integer boundary by bisection, and no further probing was done to
 * narrow it further (BUTCHR-140's explicit instruction, once the bracket
 * was already tighter than needed).
 *
 * A NARROWER CAVEAT THAN FIRST SUSPECTED, worth recording because it
 * surprised both BUTCHR-140 and me: two earlier probes on this ticket,
 * built from long runs of a SINGLE repeated character (all newlines),
 * showed the STORED comment shorter than the exact count constructed and
 * verified locally before posting (one stored roughly half of what was
 * sent). That looked at first like it might threaten this feature's core
 * lossless-reassembly promise. It does not: two follow-up probes built
 * from ORDINARY, VARIED PROSE — one at 8,000 characters, one at the full
 * 32,011 used above — both round-tripped losslessly, byte-for-byte against
 * a saved reference, markers included. So whatever caused the earlier loss
 * is specific to long runs of one repeated character (never true of a real
 * archive body, which mixes `why` prose with a description's own text) and
 * is not a general defect in the comment-write path this feature depends
 * on. Filed as its own open question for BUTCHR-140/the epic to route, not
 * BUTCHR-145's to fix.
 */
export const JIRA_COMMENT_CHAR_LIMIT = 32767;

/**
 * Marks a chained archive as BROKEN — some but not all of its parts
 * managed to post. Posted as a best-effort follow-up (same discipline as
 * `CORRECTION_REJECTED_MARKER`'s own catch below) immediately after
 * whichever part failed, so it is the very next comment a reader
 * encounters after the last part that DID post.
 *
 * Deliberately its OWN marker, not `CORRECTION_REJECTED_MARKER`: that one
 * means "the archive is complete but the REPLACE that followed it was
 * rejected" — a different failure at a different step. This one means "the
 * archive itself never finished" — precisely the shape of defect
 * Requirement 3 exists to make self-evident. The per-part "(part i of N)"
 * header (see `partHeader` below) is necessary but NOT sufficient on its
 * own: a reader who never sees part 3 needs a POSITIVE signal that the
 * chain broke, not just the absence of a part they may not think to look
 * for. This comment is that signal. AN EXPORTED CONSTANT, NEVER RETYPED —
 * including in tests, which read this symbol — same reasoning as every
 * other marker in this file: a literal duplicated in two places eventually
 * drifts into two different literals, and a grep that silently misses half
 * the corpus answers wrong instead of not at all.
 */
export const CORRECTION_CHAIN_INCOMPLETE_MARKER = "[correction-incomplete]";

/**
 * The "(part i of N)" header a chained archive part carries right after
 * `CORRECTION_MARKER` — visible in the part itself (Requirement 2: "a
 * reader holding only part 2 must be able to tell that parts 1 and 3
 * exist").
 */
function partHeader(i: number, n: number): string {
  return `(part ${i} of ${n}) `;
}

/**
 * Reserved width for `partHeader`, sized for up to 4-digit part counts
 * (9999) rather than computed from the ACTUAL i/N digit width. A real
 * correction will never come close to needing that many parts — at this
 * function's per-part budget an archive body would have to run past 100 MB
 * to require it — so this is deliberately generous rather than tight,
 * which keeps the per-part budget below stable (it does not shrink as N
 * grows past 9/99/999) and leaves real headroom past the boundary, exactly
 * as Requirement 2 asks for ("leave real headroom rather than aiming
 * exactly at the boundary").
 */
const PART_HEADER_RESERVED_LEN = partHeader(9999, 9999).length;

/**
 * Flat extra safety margin subtracted from every part's budget, on top of
 * `PART_HEADER_RESERVED_LEN`'s own headroom — defends against overhead this
 * function did not anticipate (e.g. a future identity-tag format change)
 * turning a just-fitting part into an oversized one.
 */
const CHAIN_SAFETY_MARGIN = 100;

/**
 * Splits `text` into chunks of at most `maxChunkLen` UTF-16 code units
 * each, NEVER inside a surrogate pair — slicing a JS string at an
 * arbitrary index can otherwise cut an astral-plane character in half,
 * silently corrupting it (Requirement 2's "do not split inside a UTF-16
 * surrogate pair"). Pure: concatenating the returned chunks, in order,
 * reproduces `text` EXACTLY — the property Requirement 2's lossless
 * reassembly requirement depends on.
 */
function splitPreservingSurrogates(text: string, maxChunkLen: number): string[] {
  const chunks: string[] = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + maxChunkLen, text.length);
    if (end < text.length) {
      const code = text.charCodeAt(end - 1);
      // A high surrogate (0xD800-0xDBFF) at the very end of the slice means
      // its low surrogate is the NEXT character — cutting here would split
      // the pair. Back off by one so the whole pair moves to the next chunk.
      if (code >= 0xd800 && code <= 0xdbff) {
        end -= 1;
        // Pathological only: a budget of 1 landing exactly on a pair. Keep
        // the pair together rather than ever emit a chunk that splits it.
        if (end <= i) end = Math.min(i + maxChunkLen + 1, text.length);
      }
    }
    chunks.push(text.slice(i, end));
    i = end;
  }
  return chunks;
}

/**
 * Posts the archive comment(s) for `correctWorker`, BEFORE any edit —
 * exactly ONE comment for an ordinary under-cap correction (byte-for-byte
 * what this step did before Requirement 2: same body, same wording, no
 * user-visible difference), or a chained, numbered sequence of comments
 * when the full archive body would exceed `JIRA_COMMENT_CHAR_LIMIT`.
 *
 * FAILS CLOSED, same guarantee this step always made: any failure — the
 * single comment, or any part of a chain — throws, and the caller
 * (`correctWorker`) must not proceed to the edit; the worker's
 * description/summary stay untouched. A mid-chain failure additionally
 * posts a best-effort `CORRECTION_CHAIN_INCOMPLETE_MARKER` comment
 * (Requirement 3) so a reader with only the comment thread can never
 * mistake the partial chain for a complete one.
 */
async function postCorrectionArchive(
  ops: AtlassianOps,
  callerKey: string,
  workerKey: string,
  why: string,
  oldDescription: string | undefined,
  oldSummary: string | undefined,
): Promise<void> {
  const body = correctionArchiveBody(why, oldDescription, oldSummary);
  const singleComment = tagComment(callerKey, `${CORRECTION_MARKER} ${body}`);
  if (singleComment.length <= JIRA_COMMENT_CHAR_LIMIT) {
    try {
      await ops.addComment(workerKey, singleComment);
    } catch (e) {
      throw new Error(
        `correct_worker: the archive comment failed to post on ${workerKey} (${(e as Error).message}) — refusing to edit without first preserving the superseded text; ${workerKey} is UNCHANGED.`,
      );
    }
    return;
  }

  // Chained archive: the identity tag and CORRECTION_MARKER are re-paid on
  // EVERY part, so the splittable payload per part is the comment cap minus
  // that per-part overhead, minus the reserved part-header width, minus a
  // flat safety margin.
  const tagPrefixLen = `[${callerKey}] `.length;
  const overhead = tagPrefixLen + CORRECTION_MARKER.length + 1 + PART_HEADER_RESERVED_LEN + CHAIN_SAFETY_MARGIN;
  const perPartBudget = JIRA_COMMENT_CHAR_LIMIT - overhead;
  if (perPartBudget <= 0) {
    throw new Error(`correct_worker: cannot chain the archive comment on ${workerKey} — the identity tag and markers alone leave no room under Jira's ${JIRA_COMMENT_CHAR_LIMIT}-character comment cap; ${workerKey} is UNCHANGED.`);
  }
  const chunks = splitPreservingSurrogates(body, perPartBudget);
  const n = chunks.length;
  for (let idx = 0; idx < n; idx++) {
    const i = idx + 1;
    const partComment = tagComment(callerKey, `${CORRECTION_MARKER} ${partHeader(i, n)}${chunks[idx]}`);
    try {
      await ops.addComment(workerKey, partComment);
    } catch (e) {
      const postError = (e as Error).message;
      try {
        await ops.addComment(
          workerKey,
          tagComment(
            callerKey,
            `${CORRECTION_CHAIN_INCOMPLETE_MARKER} the archive immediately above is INCOMPLETE: it needed ${n} ${CORRECTION_MARKER} parts to preserve the superseded text losslessly, and only ${i - 1} of them posted before part ${i} failed (${postError}). Do NOT treat the ${CORRECTION_MARKER} part(s) above as the full superseded text — some of it is missing from this ticket. ${workerKey}'s description/summary were NOT changed; this correction was refused. Safe to retry.`,
          ),
        );
      } catch {
        // Best-effort, same discipline as CORRECTION_REJECTED_MARKER's own
        // catch below: a reader who never sees this annotation still gets
        // the correct, already-established error thrown next — never a
        // secondary error about the annotation itself failing to post.
      }
      throw new Error(
        `correct_worker: the archive comment for ${workerKey} exceeded Jira's ${JIRA_COMMENT_CHAR_LIMIT}-character comment cap and had to be split into ${n} parts; part ${i} of ${n} failed to post (${postError}) — refusing to edit without a complete archive; ${workerKey} is UNCHANGED. Safe to retry.`,
      );
    }
  }
}

/**
 * Margin (characters) below `JIRA_DESCRIPTION_CHAR_LIMIT` at which a
 * successful correction's `result.message` warns about the NEXT one
 * (Requirement 4). Chosen as headroom for a typical `why` — the live
 * BUTCHR-139 case's refused correction supplied a `why` of roughly 2,400
 * characters — plus the archive's fixed preamble/marker text (a few
 * hundred characters; see `correctionArchiveBody`), rounded up generously.
 * A description within this margin of the limit will very likely need its
 * next archive split across multiple comments, even for an ordinarily
 * sized `why`.
 *
 * WORDED FOR THE WORLD AFTER THIS CHANGE (Requirement 4's trap, and
 * BUTCHR-130's own corrected AC5): crossing the boundary no longer causes a
 * FAILURE — `postCorrectionArchive` above chains instead — so this warning
 * says "the next correction will still succeed, but its archive will be
 * split," never "the next correction will fail." A warning worded the old
 * way would be false the moment this file's own fix landed.
 */
const NEAR_BOUNDARY_MARGIN = 3000;

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
  /**
   * BUTCHR-169: `WORKSPACE_REGISTRY.SUMMARY`'s declared withdrawal path
   * (src/workspace/registry.ts), reported as a STRUCTURED field so a caller
   * can check it without parsing `message` prose — only meaningful when
   * `correctedSummary` is true; absent otherwise (never a padded
   * "not-applicable" string on a call that never touched a summary).
   * "no-workspace-on-disk" is the common case (no agent has ever been
   * spawned for `workerKey`, or its workspace was already cleaned up) and is
   * NOT an error. "failed" means the Jira correction above already
   * succeeded and is unaffected — see `message` for the actual error text.
   * NONE of these values mean a RUNNING agent's already-loaded context was
   * updated — that gap cannot be closed by a file rewrite; `message` says so
   * explicitly and points at `tell_worker`.
   */
  summaryWorkspaceRewrite?: "no-workspace-on-disk" | "rewritten" | "failed";
}

/**
 * BUTCHR-169: `WORKSPACE_REGISTRY.SUMMARY`'s declared withdrawal mechanism
 * (src/workspace/registry.ts) — best-effort regenerates `brief.md` for any
 * workspace already built for `spec.key`, from the SAME `briefFor`/
 * `interpolate` machinery `buildWorkspace` itself uses (src/agents/
 * workspace.ts), so the file on disk matches exactly what a fresh spawn
 * would have written with the corrected summary. Deliberately does NOT
 * touch `CLAUDE.md` — it carries no `{{SUMMARY}}` placeholder (see
 * `WORKSPACE_REGISTRY.SUMMARY`'s own `appliedBy`), and rewriting it would
 * silently reintroduce the exact false claim this ticket fixed elsewhere.
 * NEVER THROWS: a workspace that was never built (or already cleaned up)
 * for `spec.key` is the common, expected case, not an error — reported as
 * "no-workspace-on-disk". A write failure (permission, disk) is caught and
 * reported as "failed" with its message, NEVER re-thrown — by the time this
 * runs, `correctWorker`'s Jira edit has already succeeded and must not be
 * lost over a filesystem problem (DoD 6 / `retireOrphanHeader`'s precedent).
 * Does NOT reach a RUNNING agent's already-loaded context — no file rewrite
 * can — `correctWorker`'s own returned `message` names that gap explicitly.
 */
function rewriteWorkspaceBriefSummary(spec: SpawnSpec): { outcome: "no-workspace-on-disk" | "rewritten" | "failed"; error?: string } {
  const briefPath = join(workspaceRoot(), spec.key, "brief.md");
  if (!existsSync(briefPath)) return { outcome: "no-workspace-on-disk" };
  try {
    writeFileSync(briefPath, interpolate(briefFor(spec.issuetype), spec));
    return { outcome: "rewritten" };
  } catch (e) {
    return { outcome: "failed", error: (e as Error).message };
  }
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
 * workspace builder interpolates it into `brief.md` ONLY at workspace-build
 * time (verified: `briefs/CLAUDE.md` carries no `{{SUMMARY}}` placeholder at
 * all — an earlier version of this exact comment and this exact success
 * message both claimed "brief.md/CLAUDE.md", which was simply false for the
 * CLAUDE.md half; fixed by BUTCHR-169, which found itself repeating that
 * same false claim to a caller mid-investigation of the bug it names). So
 * correcting a summary updates Jira, the board and every future read, AND
 * (BUTCHR-169: see `rewriteWorkspaceBriefSummary` below,
 * `WORKSPACE_REGISTRY.SUMMARY` in src/workspace/registry.ts) best-effort
 * REGENERATES `brief.md` for any workspace already on disk for the worker —
 * but this can NEVER reach a RUNNING agent's already-loaded context, because
 * no file rewrite can edit a process's memory; that gap is not "out of
 * scope", it is structurally unclosable by this mechanism. `result.message`
 * names both halves — what the rewrite achieved (or why it didn't apply/
 * failed) and the running-agent gap it cannot close — and points at
 * `tell_worker` as the only channel that can close the second half.
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
  guardShortProse("correct_worker", "why", input.why);
  if (input.summary !== undefined) guardShortProse("correct_worker", "summary", input.summary);
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

  await postCorrectionArchive(ops, callerKey, workerKey, input.why, oldDescription, oldSummary);

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

  // BUTCHR-169: SUMMARY's declared withdrawal path — best-effort, never
  // throws (see rewriteWorkspaceBriefSummary's own doc comment). issuetype
  // and the boss key come from THIS SAME `issue` fetch above, not a second
  // call — findBossKey mirrors bossKeyFrom's (src/resources/issue.ts)
  // Implements-link convention on the RAW shape ops.getIssue returns.
  const summaryRewrite = correctedSummary
    ? rewriteWorkspaceBriefSummary({ key: workerKey, issuetype: issuetypeOf(issue) ?? "", summary: input.summary!, parent: findBossKey(issue) })
    : undefined;
  const summaryRewriteNote =
    summaryRewrite === undefined
      ? ""
      : summaryRewrite.outcome === "rewritten"
        ? ` brief.md on ${workerKey}'s on-disk workspace was regenerated with the new summary — see WORKSPACE_REGISTRY.SUMMARY (src/workspace/registry.ts).`
        : summaryRewrite.outcome === "no-workspace-on-disk"
          ? ` No on-disk workspace exists for ${workerKey} (never spawned, or already cleaned up) — nothing to rewrite.`
          : ` brief.md rewrite FAILED (${summaryRewrite.error}) — Jira's correction above already landed and is UNAFFECTED; the on-disk brief.md is now stale. Safe to retry (this call is idempotent for the rewrite step) or fix brief.md by hand.`;

  const message = correctedSummary
    ? `correct_worker: ${workerKey}'s ${correctedDescription ? "description and summary" : "summary"} corrected; the superseded text was archived first (${CORRECTION_MARKER}).${summaryRewriteNote} NOTE: a summary is SNAPSHOTTED into a workspace's brief.md ONLY (never CLAUDE.md) — this correction updates Jira, the board, every future read, AND (see above) any workspace already on disk, but does NOT reach a RUNNING agent's already-loaded context, because no file rewrite can. If a running agent needs to know, follow up with tell_worker.`
    : `correct_worker: ${workerKey}'s description corrected; the superseded text was archived first (${CORRECTION_MARKER}). A description is read live (jira_get_issue), so this reaches every future reader immediately, including any agent that spawns later.`;

  // Requirement 4: warn on THIS successful correction when the description
  // it just wrote is close enough to JIRA_DESCRIPTION_CHAR_LIMIT that the
  // NEXT correction's archive will likely need Requirement 2's chaining.
  // Worded for the world AFTER this fix (see NEAR_BOUNDARY_MARGIN's own
  // comment): the next correction will still SUCCEED, never "will fail".
  const nearBoundaryWarning =
    correctedDescription && input.description!.length > JIRA_DESCRIPTION_CHAR_LIMIT - NEAR_BOUNDARY_MARGIN
      ? ` WARNING: ${workerKey}'s description is now ${input.description!.length} characters, within ${NEAR_BOUNDARY_MARGIN} of Jira's ${JIRA_DESCRIPTION_CHAR_LIMIT}-character limit — the NEXT correction on ${workerKey} will still succeed, but its archive will likely be split across multiple ${CORRECTION_MARKER} comments and be harder to read as one piece.`
      : "";

  return {
    key: workerKey,
    correctedDescription,
    correctedSummary,
    message: message + nearBoundaryWarning,
    ...(summaryRewrite !== undefined ? { summaryWorkspaceRewrite: summaryRewrite.outcome } : {}),
  };
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

/**
 * Marks the archive comment `retireOrphanHeader` posts before it rewrites a
 * ticket's description — the description-header analogue of
 * `CORRECTION_MARKER`, deliberately its OWN, DISTINCT marker rather than a
 * reuse of `CORRECTION_MARKER`: this fires automatically, on every orphan
 * adoption, as a declared consequence of gaining a boss — not a human
 * judgment call that "this text was wrong or stale", which is what
 * `CORRECTION_MARKER`/`correct_worker` mean. Using the same marker for both
 * would make a future "show me every hand correction" grep silently include
 * every routine adoption too. AN EXPORTED CONSTANT, NEVER RETYPED, same
 * reasoning as every other marker in this file.
 */
export const HEADER_WITHDRAWN_MARKER = "[header-withdrawn]";

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
  guardShortProse("file_where_it_belongs", "destination", trimmed);
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

/**
 * Every distinct description-header "kind" this codebase bakes into a
 * ticket's own description — the type-level door `src/headers/registry.ts`'s
 * `HEADER_REGISTRY` is keyed by (BUTCHR-151/BUTCHR-157: the description-
 * header medium's analogue of `src/labels/registry.ts`'s `RegisteredLabel`).
 * `HEADER_REGISTRY` is typed `Record<DescriptionHeaderKind, ...>`, so adding
 * a member here without a matching registry entry fails to compile — same
 * mechanism, same reason: a declaration that can be extended silently is the
 * bug this whole family exists to catch.
 *
 * `"adopted"` (review fix, BUTCHR-157, 2026-09-02): `retireOrphanHeader`'s
 * OWN successor text is itself a description header baked into a ticket —
 * caught in review, the exact class of defect this ticket exists to close,
 * shipping inside the fix for it. Registered here (see
 * `src/headers/registry.ts`'s `adopted` entry) rather than left to compile
 * by accident; see `ADOPTED_HEADER_OPEN_LINE` below for why its opening line
 * is a whole literal, and `retireOrphanHeader` for why its wording is
 * deliberately time-invariant (never goes stale, so `withdrawnBy: null` is
 * an honest declaration, not a dodge).
 */
export type DescriptionHeaderKind = "orphan" | "adopted";

/**
 * The bracketed marker tag for each `DescriptionHeaderKind`, single-sourced
 * here so the registry and the source scanner (`src/headers/header-scan.ts`)
 * never retype the literal — the same discipline `CORRECTION_MARKER`'s own
 * comment states: a marker duplicated as a literal in two places eventually
 * drifts into two different literals.
 */
export const HEADER_TAGS: Readonly<Record<DescriptionHeaderKind, string>> = { orphan: "ORPHAN", adopted: "ADOPTED" };

/**
 * The header's first and last lines — STATIC regardless of `destination`/
 * `filerKey`, unlike the two lines between them — exported so
 * `retireOrphanHeader` below can locate the block by content instead of by
 * counting lines (the middle "Destination: …" line can itself span more
 * than one line when a filer's reason prose contains a newline).
 */
export const ORPHAN_HEADER_OPEN_LINE = "[ORPHAN] This ticket has no boss. It was filed here on purpose, outside its filer's own scope.";
export const ORPHAN_HEADER_CLOSE_LINE = "It is not linked to anything yet — a boss makes it theirs by calling adopt_worker. Until then, nobody owns it.";

/**
 * `retireOrphanHeader`'s successor header's OPENING line — a WHOLE string
 * literal with no substitution, on purpose (review fix, BUTCHR-157,
 * 2026-09-02): the source-scanning door (`src/headers/header-scan.ts`)
 * only matches `ts.isStringLiteralLike` nodes, which a template literal
 * WITH substitutions (`` `[ADOPTED] ... ${x}` ``) is not — that was
 * reachable-in-review, caught before merge, precisely because the first
 * version of this text was built as one interpolated template with the
 * tag baked into it, invisible to the very scanner this ticket ships. This
 * constant is a whole literal, containing NOTHING that varies per ticket,
 * so it is always caught by that scanner regardless of how the surrounding
 * function assembles the rest of the block — the same shape
 * `ORPHAN_HEADER_OPEN_LINE` already uses, for the same reason.
 */
export const ADOPTED_HEADER_OPEN_LINE = "[ADOPTED] This ticket's [ORPHAN] header was retired because the ticket gained a boss.";

/** The header block baked into the created ticket's OWN description — see fileWhereItBelongs's doc comment for why this, not a comment, is where the destination is recorded. */
function orphanHeader(destination: OrphanDestination, filerKey: string): string {
  const where = destination.kind === "epic" ? `Epic ${destination.key}` : `a NEW epic (none exists yet) — reason given: "${destination.text}"`;
  return [ORPHAN_HEADER_OPEN_LINE, `Filed by: ${filerKey}`, `Destination: ${where}`, ORPHAN_HEADER_CLOSE_LINE].join("\n");
}

/**
 * The declared withdrawal owner for the `[ORPHAN]` description header
 * (BUTCHR-151/BUTCHR-157) — `HEADER_REGISTRY["orphan"].withdrawnBy` in
 * `src/headers/registry.ts` names this function by name. Called from BOTH
 * `adoptWorker` and `adoptProjectWorker`, for BOTH dispositions, in the same
 * spirit as the `ORPHAN_LABEL` clear those two functions already make —
 * "the header must not outlive the same call" the label withdrawal fires in.
 *
 * NEVER THROWS. Every branch returns a result describing what happened; the
 * one exception is a truly unexpected bug, which callers must treat the same
 * way they already treat `resolveCollisionSide`'s guarded reads — reported,
 * never allowed to abort or corrupt the adoption in progress. See the two
 * call sites for how the result is folded into `AdoptWorkerResult` without
 * ever throwing.
 *
 * UNGUARDED AT ITS CALL SITE, UNLIKE `resolveCollisionSide`'s read, AND WHY
 * THAT'S FINE (noted in review, BUTCHR-157): this runs before the
 * disposition is applied, same position `resolveCollisionSide`'s guarded
 * read occupies. The difference is that both Jira writes IN HERE are
 * already individually wrapped in their own try/catch, so nothing inside
 * this function can propagate a throw up to its caller — a `resolveCollisionSide`-style
 * wrapper would only be defending against a bug in this function's own
 * control flow, not against a live Jira call, and would just move the same
 * guarantee one frame out for no new coverage.
 *
 *
 * SURGICAL BY CONSTRUCTION — never touches the ticket at all unless it can
 * find the header UNAMBIGUOUSLY:
 *   - ABSENT (the overwhelmingly common case: any ticket not created by
 *     `fileWhereItBelongs`, or one whose header was already retired):
 *     `text` does not begin, at position 0, with `ORPHAN_HEADER_OPEN_LINE`.
 *     Silent no-op — `undefined` is returned, not a result object, so
 *     callers can skip folding anything into `AdoptWorkerResult` at all in
 *     the common case (matching how `identityCollision`/`identityUnknown`
 *     are only ever present on a call where there was something to say).
 *   - HAND-EDITED: the opening line is present at position 0 but
 *     `ORPHAN_HEADER_CLOSE_LINE` cannot be found anywhere after it — the
 *     block was partially edited (or the two lines separated by unrelated
 *     text) and this function cannot safely guess where "the header" ends.
 *     Refuses to touch the description; reports why.
 *   - APPEARS TWICE: `ORPHAN_HEADER_OPEN_LINE` occurs a second time anywhere
 *     in the text (header duplicated, or reappearing further down in a body
 *     someone pasted). Refuses to guess which occurrence is real; reports
 *     why. (A quoted MENTION of the header inside unrelated prose — e.g. a
 *     ticket discussing this very defect — cannot trigger this: the check
 *     requires the OPEN line to sit at position 0 to engage at all, and a
 *     quote embedded mid-body never does.)
 *   - HEADER RELOCATED, NOT AT THE START: if a human has moved the header
 *     block away from position 0 (or it was never there — same bytes,
 *     different origin), this function treats it as ABSENT, not "found
 *     elsewhere" — deliberately: text that merely CONTAINS the header's
 *     wording, not at the very start where `fileWhereItBelongs` always
 *     places it, is no longer distinguishable from a ticket quoting it as
 *     history (see BUTCHR-144's own `[correction]` comment for a real
 *     example of exactly that). Never guessed at; always left alone.
 *
 * ARCHIVE BEFORE OVERWRITE, LIKE `correctWorker` — BUT ITS OWN, LIGHTER
 * MECHANISM, ARGUED HERE RATHER THAN REUSED, AND WHY: `correctWorker`'s
 * chained-archive machinery (`postCorrectionArchive`, `JIRA_COMMENT_CHAR_
 * LIMIT` splitting) exists because a human-authored description can run
 * close to Jira's 32767-character field limit, so its own archive comment
 * can too. A description HEADER, by contrast, is fixed, small, machine-
 * generated boilerplate — four lines plus one filer's destination reason —
 * with no realistic path to Jira's comment cap; building or reusing chaining
 * for it would defend a limit this shape cannot reach. So this posts ONE
 * plain comment, under its OWN marker (`HEADER_WITHDRAWN_MARKER`, not
 * `CORRECTION_MARKER` — see that constant's own comment for why they must
 * stay distinct), and if that single comment is ever rejected as oversized
 * (it never has been, and is not expected to be), this reports the failure
 * honestly rather than silently truncating or attempting to chain — the
 * same "say what happened, never pretend" standard as everything else here.
 *
 * WHY THE DESCRIPTION IS REWRITTEN AT ALL, RATHER THAN DELETED TO BLANK:
 * `[ORPHAN] … nobody owns it` is replaced with a TRUTHFUL SUCCESSOR line —
 * `registry.ts`'s own doc-title marker is the model this follows (the
 * `[unwritten]` marker is retired by being REPLACED with a real, outcome-
 * shaped title, never blanked) — so the description keeps asserting
 * something, and that something is now true. The filer's identity is parsed
 * back out of the retired header text itself (`Filed by: …`) rather than
 * threaded through as a new parameter, so this function's only inputs are
 * what `adoptWorker`/`adoptProjectWorker` already have in hand.
 *
 * THE SUCCESSOR IS ITSELF A REGISTERED HEADER (`"adopted"` in
 * `DescriptionHeaderKind`/`HEADER_REGISTRY`) — CAUGHT IN REVIEW, NOT
 * DESIGNED IN FROM THE START (BUTCHR-157, 2026-09-02): the first version of
 * this text asserted PRESENT-TENSE, LIVE facts — "This ticket HAS a boss
 * (X)" and "(disposition: Y)" — which are exactly the shape of cached
 * assertion this whole ticket exists to stop shipping: "has a boss" can be
 * falsified by a later `jira_link_issues` re-parent, and "(disposition: Y)"
 * goes stale the moment a `"shelve"`-adopted ticket is later sent through
 * `start_worker` (which transitions and clears `EXEMPT_LABEL` but never
 * touches the description). Worse, that version's opening line was a
 * template literal WITH substitutions, which `ts.isStringLiteralLike` does
 * not match — so it was invisible to this PR's own scanner, on day one, in
 * the change that introduces the detector. Both defects are fixed together:
 * the wording below asserts ONLY HISTORICAL, TIME-INVARIANT facts — an
 * adoption EVENT that happened at a timestamp, never a claim about who owns
 * the ticket NOW — so it can never go stale and `HEADER_REGISTRY["adopted"]`
 * declares `withdrawnBy: null` honestly; and its opening line
 * (`ADOPTED_HEADER_OPEN_LINE`) is hoisted into its own whole-literal
 * constant, so the scanner catches it the same way it catches `[ORPHAN]`'s.
 *
 * WHAT "BYTE FOR BYTE" MEANS HERE, REASONED EXPLICITLY (Requirement 5): Jira
 * descriptions are ADF, not plain text. This reads via `adfToText` (the same
 * flattening `correctWorker` already uses) and writes via `ops.correctText`,
 * whose real implementation (`adfForCorrection` in `atlassian-real.ts`)
 * ALWAYS re-wraps whatever plain text it is given as a SINGLE paragraph, a
 * SINGLE text node — this is a pre-existing property of `correctText` itself
 * (the only description-replace primitive this codebase has), not something
 * this function introduces. Any rich ADF structure below the header — real
 * multiple paragraphs, headings, bullet lists, bold/italic marks — is
 * already collapsed to plain text by `adfToText` before this function ever
 * sees it, and was already collapsed the same way for every `correct_worker`
 * call that has ever run in this fleet. So "preserve everything below the
 * header, byte for byte" is honoured at the granularity this codebase's one
 * write primitive actually offers: the FLATTENED PLAIN TEXT below the header
 * is preserved character-for-character, untouched, never re-derived or
 * summarized — this function slices `text`, it never re-generates it. A
 * freshly-filed orphan (the overwhelmingly common case this function acts
 * on) round-trips perfectly regardless: `fileWhereItBelongs` itself builds
 * the whole description as ONE plain string handed to `adf()`, which
 * produces exactly one paragraph, one text node — so `adfToText` recovers
 * that exact string with no loss to begin with, and there is nothing this
 * function's own rewrite could newly destroy.
 */
async function retireOrphanHeader(
  ops: AtlassianOps,
  issue: unknown,
  workerKey: string,
  callerKey: string,
): Promise<{ retired: boolean; message: string } | undefined> {
  const text = adfToText(descriptionOf(issue) as Parameters<typeof adfToText>[0]);
  if (!text.startsWith(ORPHAN_HEADER_OPEN_LINE)) return undefined;

  if (text.indexOf(ORPHAN_HEADER_OPEN_LINE, 1) !== -1) {
    return {
      retired: false,
      message: `${workerKey}'s [ORPHAN] header opening line appears more than once in its description — refusing to guess which occurrence is the real header; the description is UNCHANGED. Needs a human or correct_worker fix.`,
    };
  }

  const closeIdx = text.indexOf(ORPHAN_HEADER_CLOSE_LINE);
  if (closeIdx === -1) {
    return {
      retired: false,
      message: `${workerKey}'s description starts with the [ORPHAN] header's opening line but its closing line is missing — looks hand-edited; refusing to guess where the header ends, the description is UNCHANGED.`,
    };
  }

  const headerBlock = text.slice(0, closeIdx + ORPHAN_HEADER_CLOSE_LINE.length);
  const filerMatch = /^Filed by: (.+)$/m.exec(headerBlock);
  const filerKey = filerMatch?.[1]?.trim() || "an earlier filer";

  const afterHeader = text.slice(headerBlock.length);
  const rest = afterHeader.startsWith("\n\n---\n\n") ? afterHeader.slice("\n\n---\n\n".length) : afterHeader.replace(/^\n+/, "");

  // HISTORICAL, TIME-INVARIANT WORDING ONLY — see this function's own doc
  // comment ("THE SUCCESSOR IS ITSELF A REGISTERED HEADER") for why: this
  // records that an adoption EVENT happened, at a timestamp, never a
  // present-tense claim about who owns the ticket now — so it never goes
  // stale and needs no withdrawal path of its own.
  const successor = [
    ADOPTED_HEADER_OPEN_LINE,
    `Adopted by: ${callerKey} on ${new Date().toISOString()}.`,
    `Originally filed by: ${filerKey}; the retired [ORPHAN] header (its full text, including the destination it named) is preserved in the ${HEADER_WITHDRAWN_MARKER} comment on this ticket, not repeated here.`,
  ].join("\n");
  const newText = rest ? `${successor}\n\n---\n\n${rest}` : successor;

  const archiveBody = [
    `the [ORPHAN] header below was retired because ${workerKey} now has a boss (${callerKey}) — adopt_worker replaced it with a truthful successor line in the description; everything below the header was preserved unchanged.`,
    "--- retired header ---",
    headerBlock,
  ].join("\n\n");
  try {
    await ops.addComment(workerKey, tagComment(callerKey, `${HEADER_WITHDRAWN_MARKER} ${archiveBody}`));
  } catch (e) {
    return {
      retired: false,
      message: `found ${workerKey}'s stale [ORPHAN] header but the archive comment failed to post (${(e as Error).message}) — refusing to rewrite the description without first preserving the retired text; the header is UNCHANGED. Safe to retry (e.g. on the next adopt_worker call, or by hand with correct_worker).`,
    };
  }

  try {
    await ops.correctText(workerKey, { description: newText });
  } catch (e) {
    return {
      retired: false,
      message: `archived ${workerKey}'s retired [ORPHAN] header (see the ${HEADER_WITHDRAWN_MARKER} comment) but the description rewrite failed (${(e as Error).message}) — one harmless extra comment now sits on ${workerKey}; its description is UNCHANGED. Safe to retry.`,
    };
  }

  return {
    retired: true,
    message: `${workerKey}'s stale [ORPHAN] header was retired (archived under ${HEADER_WITHDRAWN_MARKER}) and replaced with a truthful successor line naming its new boss (${callerKey}); everything below the header was preserved unchanged.`,
  };
}

/**
 * THE RETROACTIVE QUESTION (BUTCHR-151/BUTCHR-157 Requirement 4), ANSWERED
 * EXPLICITLY: tickets adopted BEFORE this fix landed may still carry a stale
 * `[ORPHAN]` header — `retireOrphanHeader` only ever runs from inside
 * `adopt_worker`/`adopt_worker`'s project-caller sibling, so a ticket that
 * was already adopted under the old code path will not have this function
 * run against it again on its own. DECIDED: NOT repaired retroactively by
 * this change, and this is a deliberate declaration, not an oversight left
 * for someone to notice the way `butchr:orphan`'s missing withdrawal path
 * itself was:
 *   1. The one CONCRETELY KNOWN instance in this corpus (BUTCHR-144) is
 *      already fixed — repaired by hand with `correct_worker`, recorded in
 *      its own `[correction]` comment, specifically BECAUSE no machine path
 *      existed yet. This ticket's own fix does not need to re-repair it.
 *   2. There is no cheap, reliable way to FIND every other stale-header
 *      ticket in the corpus: `butchr:orphan` is already withdrawn on every
 *      one of them (that is the whole reason the header alone is stale — the
 *      label side of BUTCHR-108/BUTCHR-137 already worked), so no saved JQL
 *      filter can select "ticket adopted with a leftover header" — finding
 *      one requires a full-text description scan across the whole project,
 *      an unbounded, un-scoped read this ticket's own definition of done
 *      does not ask for and this Task's own scope does not include running.
 *   3. Retroactively rewriting an unknown, unbounded set of OTHER tickets'
 *      descriptions from inside a single Task's scope — tickets this Task
 *      does not own, outside its own Implements chain — is exactly the kind
 *      of wide-blast-radius action a worker in this fleet does not take
 *      unilaterally; if a bulk sweep is ever wanted, it is its own bounded
 *      unit of work (a script or a follow-up ticket, filed with
 *      `file_where_it_belongs` if warranted), not a side effect buried in
 *      this one.
 * This declaration is the answer this Requirement asks for, stated where a
 * reader of the code lands (here) and repeated in this ticket's changelog
 * fragment — silently shipping "the header medium is closed" while an
 * unknown number of stale headers remain would be exactly the fresh cached
 * assertion this epic exists to stop producing.
 */

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
  guardShortProse("file_where_it_belongs", "summary", input.summary);

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
