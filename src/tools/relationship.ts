import type { AtlassianOps } from "./atlassian.js";
import { findBossKey, ensureDoc, type DocResult } from "./docs.js";
import { EXEMPT_LABEL } from "../agents/parked.js";

/** Role -> Atlassian accountId, the same shape `jira_create_issue` staffs by (src/tools/defs.ts's `AssigneeRoles`). Duplicated here as a structural type, not imported, so this module has no runtime dependency on defs.ts (which imports THIS module to wire the tools) — see defs.ts for the wiring direction. */
export interface Roles {
  story?: string;
  task?: string;
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

function noRoleMsg(verb: string, issuetype: "Story" | "Task"): string {
  const envVar = issuetype === "Story" ? "BUTCHR_ASSIGNEE_STORY" : "BUTCHR_ASSIGNEE_TASK";
  return `${verb}: no assignee for a ${issuetype} — set ${envVar} (an Atlassian accountId) on this daemon, or adopt/create it with an explicit assignee via jira_assign/jira_create_issue`;
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

/** An Epic's children are Stories, a Story's children are Tasks. A Task is the bottom of the hierarchy — no child type. */
const CHILD_TYPE: Record<string, "Story" | "Task"> = { Epic: "Story", Story: "Task" };

async function assertOwnWorker(ops: AtlassianOps, verb: string, callerKey: string, workerKey: string): Promise<void> {
  const issue = await ops.getIssue(workerKey);
  const boss = findBossKey(issue);
  if (boss !== callerKey) {
    throw new Error(`${verb}: ${workerKey} is not one of ${callerKey}'s own workers (its Implements link points to ${boss ?? "no boss at all"}, not ${callerKey}) — refusing`);
  }
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
  implements: string;
  doc: DocResult;
  disposition: Disposition["kind"];
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
  const rollback = async (why: string): Promise<never> => {
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
        ? `new_worker: ${why} — ticket ${key} has been rolled back (deleted); nothing survives.`
        : `new_worker: ${why} — ticket ${key} COULD NOT be rolled back (${deleteError}); this daemon's credential may lack DELETE_ISSUES on this project (measured absent as of BUTCHR-35 — granting it upgrades this path to true atomicity with no code change). Ticket ${key} SURVIVES and needs manual cleanup.`,
    );
  };

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

  return { key, implements: callerKey, doc, disposition: disposition.kind };
}

/** Worker -> In Progress. Refuses a key that is not one of the caller's own workers. The call that actually staffs an agent; also reactivates a shelved worker and sends an In Review worker back to work. */
export async function startWorker(ops: AtlassianOps, callerKey: string, workerKey: string): Promise<unknown> {
  await assertOwnWorker(ops, "start_worker", callerKey, workerKey);
  return ops.transition(workerKey, "In Progress");
}

/** Worker -> Done. Refuses a key that is not one of the caller's own workers. A worker never finishes itself — see submit_to_boss; the review hop is the point. */
export async function finishWorker(ops: AtlassianOps, callerKey: string, workerKey: string): Promise<unknown> {
  await assertOwnWorker(ops, "finish_worker", callerKey, workerKey);
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
 */
export async function adoptWorker(ops: AtlassianOps, roles: Roles, callerKey: string, workerKey: string, disposition: Disposition): Promise<AdoptWorkerResult> {
  if (disposition.kind === "shelve" && !disposition.reason.trim()) {
    throw new Error("adopt_worker: a \"shelve\" disposition requires a non-empty reason — an activation condition nobody wrote down is indistinguishable six weeks later from a ticket somebody forgot");
  }

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

  const linkedCorrectly = existingBoss === callerKey;
  const assignedCorrectly = assigneeAccountIdOf(issue) === role;
  const currentStatus = statusOf(issue);
  const dispositionAlreadyApplied =
    disposition.kind === "start" ? currentStatus === "In Progress" : currentStatus === "To Do" && labelsOf(issue).includes(EXEMPT_LABEL);
  const alreadyAdopted = linkedCorrectly && assignedCorrectly && dispositionAlreadyApplied;

  if (!alreadyAdopted) {
    if (!assignedCorrectly) await ops.assign(workerKey, role);
    if (!linkedCorrectly) await ops.linkIssues(workerKey, callerKey, "Implements");
  }

  const doc = await ensureDoc(ops, workerKey);

  if (!alreadyAdopted && !dispositionAlreadyApplied) {
    if (disposition.kind === "start") {
      await ops.transition(workerKey, "In Progress");
    } else {
      // Label before transition — see shelveWorker's comment for why.
      await ops.addLabels(workerKey, [EXEMPT_LABEL]);
      if (currentStatus !== "To Do") await ops.transition(workerKey, "To Do");
      await ops.addComment(workerKey, tagComment(callerKey, disposition.reason));
    }
  }

  return { key: workerKey, alreadyAdopted, doc, disposition: disposition.kind };
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

/** Comments on the CALLER'S OWN ticket. No key parameter, by design — see the glossary page's "known hazard, kept deliberately" note. */
export async function reportToBoss(ops: AtlassianOps, callerKey: string, text: string): Promise<unknown> {
  return ops.addComment(callerKey, tagComment(callerKey, text));
}

/**
 * Same channel as report_to_boss, but marked `[ask]` right after the
 * identity tag — greppable, so a boss can find its workers' unanswered
 * questions without reading every comment. Asking does NOT change the
 * asker's status.
 */
export async function askBoss(ops: AtlassianOps, callerKey: string, text: string): Promise<unknown> {
  return ops.addComment(callerKey, tagComment(callerKey, `${ASK_MARKER} ${text}`));
}

/** The caller's OWN ticket -> In Review. No arguments at all — the one transition an agent is always entitled to make about itself. */
export async function submitToBoss(ops: AtlassianOps, callerKey: string): Promise<unknown> {
  return ops.transition(callerKey, "In Review");
}
