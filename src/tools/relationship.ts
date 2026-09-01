import type { AtlassianOps } from "./atlassian.js";
import { findBossKey, ensureDoc, JIRA_KEY_RE, type DocResult } from "./docs.js";
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

/**
 * Returns the fetched issue (not just void) so callers that need it for a
 * follow-up decision — `startWorker`/`finishWorker` checking for a stale
 * `EXEMPT_LABEL` — reuse this fetch instead of paying for a second one. A
 * worker that was never shelved must cost exactly what it cost before this
 * check existed.
 */
async function assertOwnWorker(ops: AtlassianOps, verb: string, callerKey: string, workerKey: string): Promise<unknown> {
  const issue = await ops.getIssue(workerKey);
  const boss = findBossKey(issue);
  if (boss !== callerKey) {
    throw new Error(`${verb}: ${workerKey} is not one of ${callerKey}'s own workers (its Implements link points to ${boss ?? "no boss at all"}, not ${callerKey}) — refusing`);
  }
  return issue;
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

  const doc = await ensureDoc(ops, workerKey);

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

/** `butchr:orphan` — makes "show me every undirected ticket" a one-line JQL filter. Never combined with `EXEMPT_LABEL`: see fileWhereItBelongs's doc comment for why an orphan can never trip the parked-ticket detector. */
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
 * makes it discoverable (a saved JQL filter).
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
