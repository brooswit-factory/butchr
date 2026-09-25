/**
 * The daemon-shutdown/crash backstop for a leaked Rocket.Chat account
 * (BUTCHR-412) — `docs/rocketchat-accounts.md`'s "Wiring" section, and
 * `./account-lifecycle.ts`'s own top comment, both point here for the SLOW,
 * crash-safe half of release recovery (the FAST half, a release retried
 * within the same daemon's next poll, is `account-lifecycle.ts`'s
 * `retryPendingReleases`). Runs on a timer, independent of any rule loop's
 * own poll (`src/daemon/index.ts` wires it: once at startup, then
 * periodically).
 *
 * WHY THIS IS ITS OWN MODULE, NOT INLINE IN THE DAEMON ENTRY FILE (BUTCHR-412
 * review, round 1, blocking finding 1): a first pass called
 * `AccountManager.reconcileOrphans` against a single `herd.runningIssues()`
 * snapshot and released whatever it reported absent. That is unsafe:
 * `HerdrHerd.byIssue()` (src/agents/herd.ts), which `runningIssues()` is
 * built on, deliberately DROPS an id from its map — reports it as NOT
 * running — whenever two live panes currently share that id's workspace
 * path (`map.delete(issue); ambiguous.add(issue)`, the ordinary overlap
 * during a respawn or a quota-recovery pane replacement) or whenever the
 * matched pane isn't the lifecycle's own currently-tracked one. A genuinely
 * live, healthy agent can read as "not running" on `runningIssues()` for
 * reasons that have nothing to do with whether it is actually there —
 * exactly the single-snapshot false positive that first pass could act on
 * destructively (delete the RC user, revoke its token) with no test anyone
 * had written to catch it.
 *
 * TWO INDEPENDENT SAFETY LAYERS FIX THIS, NEITHER ONE ALONE SUFFICIENT:
 *
 * 1. **A real per-pane liveness check, not `agent.list()` presence.**
 *    `HerdrHerd.residentIssues()` groups panes by workspace directory
 *    (`groupOwnedPanes`, src/agents/residency-census.ts) rather than
 *    requiring a UNIQUE pane per id the way `byIssue()` does, and its
 *    `aggregateVerdict` reads "resident" the instant ANY owned pane shows a
 *    live claude process — "a single ambiguous pane can never be outvoted
 *    into a false vacant" (that function's own doc comment; the exact
 *    two-panes-one-ambiguous shape is pinned directly in
 *    `test/unit/residency-census.test.ts`'s `aggregateVerdict(["dead",
 *    "live", "unknown"])` case). This closes the ambiguous-pane hazard by
 *    construction: the SAME situation that makes `byIssue()` drop an id
 *    from `runningIssues()` is exactly the situation `residentIssues()`
 *    still correctly reports as resident. `residentIssues()` also THROWS
 *    rather than reporting `[]` on a `pane.list()` failure (its own doc
 *    comment: a bare `[]` would be indistinguishable from "genuinely
 *    nothing is resident") — caught here and treated as "observed nothing
 *    this round," never as "everything is gone."
 * 2. **A minimum record age, and a two-consecutive-sweep grace, before ANY
 *    release.** `residentIssues()` still answers "unknown" (never
 *    "resident") for the first seconds of a brand-new spawn, before its pane
 *    reports a recognisable foreground process — a genuinely live, but
 *    freshly-created, agent. `MIN_RECORD_AGE_MS` (comfortably longer than
 *    any real spawn's pane-registration window — `KICKOFF_VERIFY_MS` is 12s,
 *    src/agents/herd.ts) keeps a record younger than that out of
 *    consideration entirely, and `MIN_OBSERVATIONS` (2) additionally
 *    requires the SAME id to read as a candidate on two SEPARATE sweep
 *    calls before it is ever released — at this sweep's own cadence (30
 *    minutes, src/daemon/index.ts), a window no ordinary respawn or
 *    pane-replacement plausibly spans twice.
 *
 * NEVER RELEASES ON AN UNRELIABLE READ: a `residentIssues()` OR
 * `reconcileOrphans` rejection this round leaves every tracked streak
 * untouched (never reset, never advanced) and releases nothing — the next
 * successful sweep simply continues counting from where it left off, so a
 * transient herdr hiccup costs a delay, never a false release.
 */
import type { AccountManager } from "../accounts/manager.js";

const MIN_OBSERVATIONS = 2;
/** Comfortably longer than KICKOFF_VERIFY_MS (12s, src/agents/herd.ts) — see this module's own top comment, safety layer 2. */
const MIN_RECORD_AGE_MS = 10 * 60_000;

export interface AccountOrphanSweepDeps {
  now: () => number;
  /** `AccountManager.reconcileOrphans` — this sweep's only source of candidates; never anything from `Herd`/`HerdrHerd` directly. */
  reconcileOrphans: AccountManager["reconcileOrphans"];
  /**
   * A REAL per-pane liveness check — `HerdrHerd.residentIssues()` in
   * production, never `Herd.runningIssues()`/`agent.list()` presence alone.
   * See this module's own top comment for why that distinction is the whole
   * point. Rejects rather than reporting `[]` on failure; this sweep treats
   * a rejection as "observed nothing reliable this round," never as
   * "everything is gone."
   */
  residentIssues: () => Promise<readonly string[]>;
  /** `AccountLifecycleHooks.release` (`./account-lifecycle.ts`), reason always `"stop"` — a sweep-confirmed absence is a genuine stop, not a respawn. Already never throws (queues its own retry internally) — this sweep still wraps the call defensively in case a future implementation does not share that contract. */
  release: (agentKey: string, reason: "stop") => Promise<void>;
  log?: (line: string) => void;
}

export interface AccountOrphanSweep {
  /** One sweep. Never throws — every failure mode (an unreliable read, a release failure) is logged and swallowed; see this module's own top comment. */
  sweep(): Promise<void>;
}

export function createAccountOrphanSweep(deps: AccountOrphanSweepDeps): AccountOrphanSweep {
  const streak = new Map<string, number>();
  const log = (line: string) => deps.log?.(line);

  async function sweep(): Promise<void> {
    let resident: Set<string>;
    try {
      resident = new Set(await deps.residentIssues());
    } catch (e) {
      log(`WARNING: [account] orphan sweep skipped this round — residentIssues() failed: ${(e as Error)?.message ?? e}`);
      return;
    }
    let candidates: Awaited<ReturnType<AccountManager["reconcileOrphans"]>>;
    try {
      candidates = await deps.reconcileOrphans((agentKey) => resident.has(agentKey));
    } catch (e) {
      log(`WARNING: [account] orphan sweep failed: ${(e as Error)?.message ?? e}`);
      return;
    }

    const candidateKeys = new Set(candidates.map((r) => r.agentKey));
    // Prune first: an id no longer a candidate (resident again, or its
    // record is simply gone) loses its streak entirely — same "prune on any
    // disappearance" discipline ReapGuard/RespawnGuard/CrashLoopTracker
    // already share elsewhere in this codebase.
    for (const key of [...streak.keys()]) if (!candidateKeys.has(key)) streak.delete(key);

    for (const record of candidates) {
      const age = deps.now() - Date.parse(record.createdAt);
      if (!(age >= MIN_RECORD_AGE_MS)) continue; // too young to trust an absence reading yet — an unparseable createdAt (NaN age) fails this check too, never sweeping
      const count = (streak.get(record.agentKey) ?? 0) + 1;
      if (count < MIN_OBSERVATIONS) {
        streak.set(record.agentKey, count);
        continue;
      }
      streak.delete(record.agentKey);
      try {
        await deps.release(record.agentKey, "stop");
      } catch (e) {
        log(`WARNING: [account] orphan sweep release failed for ${record.agentKey}: ${(e as Error)?.message ?? e}`);
      }
    }
  }

  return { sweep };
}
