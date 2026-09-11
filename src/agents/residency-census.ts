import { join, dirname, basename } from "node:path";
import type { results } from "@brooswit/herdr-sdk";

/**
 * BUTCHR-287 — the live second source of truth the spawn guard needs to
 * survive cold start (see src/agents/residency-guard.ts for the per-poll
 * orchestration, and herd.ts's `HerdrHerd.residency()`/`residentIssues()`
 * for the herdr I/O that supplies this module's inputs). Holds only the
 * PURE parts, same split reap.ts already establishes for the reaper (see
 * that file's own top comment):
 *   1. `panesFor` — pure ownership join (a pane's `cwd` equals this
 *      issue's own workspace directory), no herdr I/O, no `agent.list()`
 *      involvement at all. Used by `HerdrHerd.residency(candidates)`, the
 *      guard's own per-candidate consumer.
 *   2. `groupOwnedPanes` — the same ownership convention applied in the
 *      OTHER direction: given every pane herdr reports, recover the full
 *      set of issue-owned panes with no candidate list supplied at all.
 *      Used by `HerdrHerd.residentIssues()`, the minimal reusable shape
 *      (`Promise<readonly string[]>`, no args) a future consumer could
 *      point at — see that method's own doc comment for why this ticket
 *      builds but does not wire it.
 *   3. `aggregateVerdict` — pure combination of each of an issue's panes'
 *      OWN live/dead/unknown verdict (from `HerdrHerd`'s existing
 *      `paneVerdict`, the same `processInfo`/`isClaude` check
 *      `closeStranded` already uses as the reaper's decisive safety layer)
 *      into one verdict for the issue. Shared by both consumers above.
 *
 * WHY THIS IS INDEPENDENT OF `agent.list()`, AND WHAT REMAINS UNVERIFIED:
 * a pane's `cwd` is not an agent-registry fact — `buildWorkspace()`
 * (workspace.ts) derives an issue's workspace directory from
 * `workspaceRoot()`/`spec.key` once, at spawn time, and herdr's
 * `pane.list()` reports a pane's `cwd` back untouched. `pane.processInfo`
 * is a PROCESS-TABLE read, already trusted by this codebase as the
 * reaper's own decisive layer. Neither call goes through `agent.list()`
 * for either half.
 *
 * What is NOT independently verified (could not be, from outside herdr,
 * which ships as a binary): whether `pane.list()`/`pane.processInfo()`
 * share an internal registry with `agent.list()` and could in principle go
 * blind at the same instant. THIS QUESTION IS STILL OPEN — an earlier
 * candidate answer (that the incident's six `agent_pane_busy` rejections
 * proved herdr's pane side stayed readable while its agent list went
 * blind) was raised on this ticket and then WITHDRAWN as backwards: the
 * rejected panes and the live agents' panes are disjoint sets (a rejected
 * pane is the brand-new one `workspace.create` just returned, never an
 * existing agent's pane), and BUTCHR-242's own harness reproduces
 * `agent_pane_busy` on throwaway workspaces with no other agent anywhere
 * in the fleet — a rejection that fires with nothing to collide with is
 * not evidence something was there to collide with. DO NOT READ INTENT
 * INTO AN ERROR STRING: it says what the callee refused, not what the
 * callee knew.
 *
 * THIS IS TWO SEPARATE QUESTIONS, NOT ONE — CONFLATING THEM OVERSTATES
 * WHAT THIS MODULE CLOSES (review finding, PR #297 round 1):
 *   1. Can `pane.processInfo`'s VERDICT about a given pane be a projection
 *      of the agent registry? No — it is a process-table read, and this
 *      codebase already trusts it as the reaper's own decisive layer. This
 *      half is genuinely independent of `agent.list()`, regardless of how
 *      question 2 lands.
 *   2. Can `pane.list()` fail to ENUMERATE a pane that exists — go blind
 *      the way `agent.list()` demonstrably did? UNVERIFIED, and THIS
 *      GUARD'S COLD-START COVERAGE DEPENDS ON THE ANSWER. If `pane.list()`
 *      returns successfully but omits a live issue's panes, `panesFor`
 *      returns `[]`, `aggregateVerdict([])` returns `"vacant"` BY DESIGN
 *      (correctly — see that function's own doc comment: a pre-first-spawn
 *      issue must read vacant, or this guard would withhold every issue's
 *      very first spawn), and the guard spawns. THE ORIGINAL DEFECT
 *      REPRODUCES — silently, because `"vacant"` is a confident answer,
 *      never an `"unknown"` the fleet-wide branch (residency-guard.ts)
 *      could withhold on.
 *
 * SO: this guard closes the cold-start case PROVIDED `pane.list()` still
 * enumerates panes when `agent.list()` is blind. That precondition is
 * unverified. If herdr's pane enumeration goes blind at the same instant
 * as its agent registry, every affected candidate reads `"vacant"` and
 * this guard degrades SILENTLY to today's behaviour rather than failing
 * loudly — the "looks complete and is not" failure this ticket exists to
 * avoid, now stated rather than glossed over. Closing THAT case would need
 * either a herdr-side signal distinguishing "no panes here" from "cannot
 * enumerate panes right now", or a residency source outside herdr
 * entirely — this module does not attempt either.
 *
 * THE ASYMMETRY THIS CREATES, RESOLVED DELIBERATELY: `HerdrHerd.residentIssues()`
 * (herd.ts) THROWS rather than returning `[]` on a `pane.list()` failure —
 * its own doc comment names why: a bare `[]` would be indistinguishable
 * from "genuinely nothing is resident," the same confident-zero hazard
 * this whole ticket exists to close. `HerdrHerd.residency(candidates)`
 * resolves the identical hazard the OTHER way, on purpose: a caught
 * `pane.list()` failure there reports every candidate `"unknown"`, not
 * `[]`/vacant, so residency-guard.ts's fleet-wide branch can still
 * withhold on it. Both are correct for what they promise; neither one
 * closes the gap above, which is about `pane.list()` SUCCEEDING with an
 * incomplete answer, not about it failing outright.
 */

export type PaneVerdict = "live" | "dead" | "unknown";
export type ResidencyVerdict = "resident" | "vacant" | "unknown";

/**
 * This issue's own panes, by the SAME ownership convention `buildWorkspace()`
 * writes: `cwd === join(root, issue)`. Pure; no I/O. Mirrors reap.ts's
 * `strandedCandidates` ownership half, keyed on an issue directly rather
 * than joined against `workspace.list()`'s labels — residency only needs
 * "is there a live claude at this issue's own directory", never a
 * workspace id to close, so there is nothing here for `workspace.list()`
 * to add.
 */
export function panesFor(issue: string, panes: readonly results.PaneInfo[], root: string): readonly results.PaneInfo[] {
  const expectedCwd = join(root, issue);
  return panes.filter((p) => p.cwd === expectedCwd);
}

/**
 * The inverse join: every pane whose `cwd` sits DIRECTLY under `root` (the
 * same `buildWorkspace()` convention `panesFor` checks in one direction),
 * grouped by the issue key its cwd's basename names — no candidate list
 * needed, because the panes THEMSELVES name their own owner. A pane whose
 * cwd is missing, or is under `root` but nested deeper than one level (not
 * a shape `buildWorkspace()` ever produces), is simply not grouped under
 * anything — same "ownership not proven, never a candidate" discipline
 * `strandedCandidates` (reap.ts) already applies. Pure; no I/O.
 */
export function groupOwnedPanes(panes: readonly results.PaneInfo[], root: string): ReadonlyMap<string, readonly results.PaneInfo[]> {
  const out = new Map<string, results.PaneInfo[]>();
  for (const p of panes) {
    if (!p.cwd || dirname(p.cwd) !== root) continue;
    const issue = basename(p.cwd);
    const arr = out.get(issue);
    if (arr) arr.push(p);
    else out.set(issue, [p]);
  }
  return out;
}

/**
 * Combine each of an issue's panes' own verdict into one residency
 * verdict. "resident" the instant ANY pane is "live" — a single live
 * claude proves occupancy regardless of what any other pane says.
 * "vacant" only if EVERY pane came back definitively "dead" — same
 * all-or-nothing discipline `HerdrHerd.workspaceVerdict` already applies
 * for the reaper's own close decision, so a single ambiguous pane can
 * never be outvoted into a false "vacant". No panes at all (this issue
 * owns no pane this poll) is "vacant", not "unknown" — there is nothing
 * there to be unsure about, and a pre-first-spawn issue must read as
 * vacant or the guard would withhold every issue's very first spawn.
 */
export function aggregateVerdict(paneVerdicts: readonly PaneVerdict[]): ResidencyVerdict {
  if (!paneVerdicts.length) return "vacant";
  let allDead = true;
  for (const v of paneVerdicts) {
    if (v === "live") return "resident";
    if (v === "unknown") allDead = false;
  }
  return allDead ? "vacant" : "unknown";
}
