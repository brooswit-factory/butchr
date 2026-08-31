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
function statusOf(issue: unknown): string | undefined {
  return (issue as { fields?: { status?: { name?: string } } })?.fields?.status?.name;
}
function projectKeyOf(issue: unknown): string | undefined {
  return (issue as { fields?: { project?: { key?: string } } })?.fields?.project?.key;
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
 * Creates a worker one tier below `callerKey`: infers the child's issue
 * type from the caller's own type, the assignee from `roles`, the project
 * from the caller's, and the doc's parent from the caller's own doc. Writes,
 * in order: (1) create the ticket — WITH the shelve exemption label already
 * on it if disposition is "shelve", so that write never has to happen
 * separately; (2) link the new ticket to `callerKey` (Implements, outward);
 * (3) ensure its doc, nested under the caller's; (4) apply the disposition
 * (transition to In Progress, or — for shelve — the reason comment; the
 * label already landed in step 1).
 *
 * ATOMICITY, HONESTLY: rule (a) ("creates the ticket, the doc, links both
 * directions, or it fails and leaves nothing") is NOT reachable here. It was
 * directed as a compensating rollback keyed on an issue-delete op, and
 * BUTCHR-35 measured that THIS DAEMON'S CREDENTIAL CANNOT DELETE A JIRA
 * ISSUE (`DELETE_ISSUES` is refused with a 403 on this project — see the
 * comment trail on that ticket). So a failure at step 2, 3 or 4 leaves the
 * ticket from step 1 in place, permanently — there is no way to undo it from
 * here. What this DOES guarantee: every failure names the surviving ticket
 * key so it's never a silent orphan, and — when the doc from step 3 exists
 * (i.e. only a LATER step failed) — it is rolled back via `ops.deletePage`
 * (Confluence page deletes DO work on this credential; MEASURED, BUTCHR-35),
 * since a half-made page with nobody able to find it is worse than one that
 * was never created. This is reported as a finding on BUTCHR-35/BUTCHR-25;
 * do not read this comment as the settled design.
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
    throw new Error(
      callerType === "Task"
        ? `new_worker: ${callerKey} is a Task — a Task is the bottom of this hierarchy and has no worker beneath it; new_worker can only be called by an Epic or a Story`
        : `new_worker: ${callerKey}'s issue type ("${callerType ?? "unknown"}") has no defined child type — new_worker can only be called by an Epic or a Story`,
    );
  }
  const role = childType === "Story" ? roles.story : roles.task;
  if (!role) throw new Error(noRoleMsg("new_worker", childType));
  const projectKey = projectKeyOf(callerIssue);
  if (!projectKey) throw new Error(`new_worker: could not read ${callerKey}'s own project key — refusing rather than guessing`);

  // (1) create — the shelve label, if any, lands HERE, not as a follow-up write.
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
  if (!key) throw new Error("new_worker: create response carried no issue key — refusing to link or create a doc against nothing");

  const survives = (extra: string) =>
    `new_worker: ticket ${key} was created and survives (this daemon's credential cannot delete Jira issues — see BUTCHR-35). ${extra}`;

  // (2) link — outward from the new child to the caller, never the reverse.
  try {
    await ops.linkIssues(key, callerKey, "Implements");
  } catch (e) {
    throw new Error(survives(`The Implements link to ${callerKey} failed (${(e as Error).message}) — link it by hand or with jira_link_issues(from: "${key}", to: "${callerKey}").`));
  }

  // (3) ensure the doc, nested under the caller's own.
  let doc: DocResult;
  try {
    doc = await ensureDoc(ops, key);
  } catch (e) {
    throw new Error(survives(`It is linked to ${callerKey}, but its doc failed to create/bind (${(e as Error).message}) — check ${key} by hand; a Confluence page under ${callerKey}'s doc may or may not exist.`));
  }

  // (d) Deleting a page created two seconds ago as the rollback of a failed
  // creation is not archiving a record, it is refusing to leave a half-made
  // one — the ticket that page documented already exists at this point (step
  // 1 succeeded), so this is NOT the doc convention's rule (d) ("nothing is
  // archived") in disguise; that rule protects real history, and a page
  // whose creation failed a moment later never became real history. Without
  // this rollback and this comment both, a half-made page silently
  // accumulates on every disposition failure below, AND the next reader who
  // finds a rollback delete without this reasoning is liable to "fix" it by
  // removing the rollback, bringing the orphan-page class straight back.
  const rollbackDoc = async (extra: string): Promise<never> => {
    try {
      await ops.deletePage(doc.id);
      throw new Error(survives(`Its Confluence page (${doc.id}) has been rolled back (deleted). ${extra}`));
    } catch (e) {
      if ((e as Error).message.startsWith("new_worker:")) throw e;
      throw new Error(survives(`Its Confluence page (${doc.id}) COULD NOT be rolled back either (${(e as Error).message}) — both the ticket and the page survive. ${extra}`));
    }
  };

  // (4) disposition — start transitions; shelve's label already landed in
  // step 1, so only the reason comment remains.
  if (disposition.kind === "start") {
    try {
      await ops.transition(key, "In Progress");
    } catch (e) {
      return rollbackDoc(`The disposition transition to In Progress failed (${(e as Error).message}).`);
    }
  } else {
    try {
      await ops.addComment(key, tagComment(callerKey, disposition.reason));
    } catch (e) {
      return rollbackDoc(`The shelve reason comment failed to post (${(e as Error).message}); the exemption label is already on the ticket from creation.`);
    }
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
  await ops.transition(workerKey, "To Do");
  await ops.addLabels(workerKey, [EXEMPT_LABEL]);
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
 * and ensures its doc. IDEMPOTENT — if `workerKey` is already correctly
 * adopted by `callerKey` (assignee/link already correct), the assign/link
 * steps and the disposition are skipped entirely and this changes nothing;
 * `ensureDoc` still runs unconditionally as a no-op-when-already-present
 * safety net, in case a prior partial adoption left the ticket linked but
 * undocumented. Refuses a ticket already linked to a DIFFERENT boss.
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

  const alreadyAdopted = existingBoss === callerKey;
  if (!alreadyAdopted) {
    const issuetype = issuetypeOf(issue) as "Story" | "Task" | undefined;
    if (issuetype !== "Story" && issuetype !== "Task") {
      throw new Error(`adopt_worker: ${workerKey}'s issue type ("${issuetype ?? "unknown"}") cannot be adopted as a worker — only a Story or a Task can be`);
    }
    const role = issuetype === "Story" ? roles.story : roles.task;
    if (!role) throw new Error(noRoleMsg("adopt_worker", issuetype));
    await ops.assign(workerKey, role);
    await ops.linkIssues(workerKey, callerKey, "Implements");
  }

  const doc = await ensureDoc(ops, workerKey);

  if (!alreadyAdopted) {
    if (disposition.kind === "start") {
      await ops.transition(workerKey, "In Progress");
    } else {
      await ops.transition(workerKey, "To Do");
      await ops.addLabels(workerKey, [EXEMPT_LABEL]);
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
