import { workspaceDirFor, workspaceSessionId, claudeTranscriptExists, type SpawnSpec } from "./workspace.js";

/**
 * FACTORY-710/FACTORY-708/FACTORY-704 — whether `spec` has a transcript on
 * disk that a resume could actually reattach to. Deliberately the SAME two
 * checks `resumeInPlace()` itself uses to decide `"unresumable"` vs. a real
 * attempt (`herd.ts`, `workspaceSessionId(cwd)` then `claudeTranscriptExists`)
 * — a definition this returns `true` for is exactly a definition that would
 * lose its conversation if fresh-spawned instead of resumed. `workspaceDirFor`
 * (not a running pane's own cwd, which doesn't exist yet for a spawn
 * candidate) is the same deterministic per-key path `herd.spawn()` itself
 * resolves a workspace at, so this agrees with the real spawn regardless of
 * whether an agent has ever run for this key before.
 */
export function hasResumableTranscript(spec: SpawnSpec): boolean {
  const dir = workspaceDirFor(spec.key);
  const sessionId = workspaceSessionId(dir);
  if (!sessionId) return false;
  return claudeTranscriptExists(dir, sessionId);
}

export interface RestoreSettleGateOptions {
  /**
   * Bounded wait, ms, before giving up on a settle and falling back to
   * today's fresh-spawn behaviour for whatever is still held. See
   * `Config.restoreSettleBoundMs` (src/config/config.ts) for the production
   * default and its reasoning.
   */
  boundMs?: number;
  /** Clock seam for tests — defaults to `Date.now`. */
  now?: () => number;
  /** Free-text daemon log line. Optional; omitted, the gate stays silent. */
  log?: (line: string) => void;
  /**
   * Seam for tests — defaults to the real `hasResumableTranscript` (above),
   * which reads from disk. Overriding this lets a test exercise the gate's
   * own hold/stability/bound logic without touching the filesystem at all;
   * the real function is exercised separately by its own direct tests.
   */
  hasResumableTranscript?: (spec: SpawnSpec) => boolean;
}

const DEFAULT_BOUND_MS = 60_000;

/**
 * FACTORY-710 — the settle gate: before fresh-spawning any definition that
 * HAS a resumable transcript on disk, wait until herdr's restore has
 * settled (its restored-pane listing stable across two consecutive polls),
 * bounded by `boundMs` past which it gives up and falls back to today's
 * fresh-spawn behaviour. A definition with NO resumable transcript is never
 * held — it has nothing to lose by spawning fresh, so delaying it would
 * only slow down a cold boot for no safety gained.
 *
 * ONE INSTANCE PER DAEMON PROCESS (same "one instance per loop" discipline
 * `RespawnGuard`/`ResumeDeferGuard` already follow) — this is specifically a
 * COLD-BOOT condition: the gate resolves (by stability or by bound) at most
 * once per process lifetime and never re-arms itself afterward, so a herdr
 * restart LATER in this same daemon's life is not re-gated. Re-arming would
 * require distinguishing "herdr's restore settling after MY OWN start" from
 * "herdr itself restarting out from under me", which is a different, harder
 * problem this ticket does not take on — see FACTORY-704's own triage
 * comment for why an in-process gate, not a boot-order fix, is the right
 * layer regardless.
 *
 * The settle signal is NOT independently observable from herdr's API: there
 * is no call that answers "is your restore done" on its own — only
 * `agent.list()` (`herd.runningIssues()`), which reads identically whether
 * nothing is running or the restore merely hasn't populated it yet (see
 * `HerdrHerd.byIssue()`'s own doc comment). Stability across two consecutive
 * polls, with a hard bound, is the documented fallback the ticket itself
 * allows for exactly this case — this gate does not invent a richer signal
 * herdr cannot actually provide.
 *
 * FACTORY-710 review round 1: an EMPTY listing must never count as the
 * "stable" half of that signal on its own. `herd.runningIssues()` reads
 * `[]` identically whether nothing is running or herdr's restore simply
 * hasn't populated it yet (the exact ambiguity this whole gate exists to
 * resolve — see `HerdrHerd.byIssue()`'s doc comment) — so two consecutive
 * empty polls are the WEAKEST possible evidence of settling, not the
 * strongest: `[] == []` is trivially true on every poll before herdr has
 * listed anything at all. Treating that as "stable" let the gate buy
 * exactly one poll interval and then release straight into the cold-boot
 * hazard it was built to close. A non-empty listing that repeats is real
 * evidence (herdr said something, twice); an empty one that repeats is no
 * evidence at all. Only the bounded wait, not stability, may release a
 * held candidate while the listing is empty.
 *
 * FACTORY-710 review round 2: a NON-empty listing can be just as false a
 * signal, if the ids in it are there because THIS process put them there.
 * `filter()` lets plain (no-transcript) candidates spawn immediately every
 * poll; herdr's `agent.list()` then reports those same ids right back on
 * the very next poll, because they are now genuinely running panes herdr
 * manages — indistinguishable, by id alone, from a pane herdr itself
 * restored. Two polls of "only the pane I spawned a moment ago" is not
 * herdr's restore settling, it is butchr watching its own actions reflected
 * back at it — yet `stableSincePrevPoll` would read exactly like real
 * settling and release every held resumable candidate straight into the
 * hazard the empty-listing fix above already closed for the emptier case.
 * So every id this gate has itself returned from `filter()` — spawned,
 * resumed-and-passed-through, or fresh-spawned on settle, in this or any
 * earlier poll — is remembered in `selfReleasedIds` and subtracted from
 * `running` before the empty/stable checks run. Only ids herdr listed on
 * its own are evidence of herdr's restore progressing; the raw (unfiltered)
 * `running` set is still used everywhere this class asks "is THIS SPECIFIC
 * held id now running" (resumed-detection, and `hasResumableTranscript`'s
 * own exclusion check), since that question is about the id itself, not
 * about what it implies for the stability signal.
 *
 * FACTORY-713/FACTORY-704 — PER-SCOPE STATE. `filter()` takes a `scope`
 * (default `DEFAULT_SCOPE`), and every field below that used to be a single
 * value for the whole gate (`settled`, `episodeStartedAt`, `lastRunning`,
 * `everHeld`, `held`, `selfReleasedIds`) is now keyed by that scope in
 * `episodes`, lazily created on first use. This is "one instance per daemon
 * process" (the class's own long-standing discipline, directly above) —
 * NOT "one instance per loop" — but each loop's settle decision is
 * independent of every other loop's.
 *
 * This exists because the literal reading of "one shared instance" — a
 * single un-scoped set of the fields above, shared by the issue loop and
 * the managed-sessions loop — makes the gate behave WORSE than no gate at
 * all. `runResourceLoop` hands this class a `running` array already scoped
 * to that loop's own ids (`scopedHerd`'s `ownsId` filter, src/daemon/loop.ts)
 * — the issue loop's and the managed-sessions loop's `running` sets are
 * always disjoint. Both loops poll on the same 15s cadence, so they
 * interleave rather than coincide. A single shared `lastRunning` would
 * therefore alternate between two disjoint sets almost every poll:
 * `setsEqual` is false essentially always, so the gate would never settle
 * by stability — only ever via the 60s bounded wait — on EVERY boot,
 * holding every resumable definition for the full bound before
 * fresh-spawning exactly what it exists to protect. A single shared
 * `settled` is worse still: it latches permanently once EITHER loop
 * resolves, silently opening the gate for the other loop before that one
 * has observed anything of its own. Keying `episodes` by scope gives each
 * loop its own `lastRunning`/`settled`/`everHeld`/`held`/`selfReleasedIds`,
 * so a comparison is never made between one loop's `running` and another's,
 * and one loop's progress can never release another loop's held
 * candidates — while still being the one object the daemon constructs once
 * per boot, which is what "decide the settle once per boot" actually asked
 * for.
 */
export class RestoreSettleGate {
  private readonly boundMs: number;
  private readonly now: () => number;
  private readonly log: ((line: string) => void) | undefined;
  private readonly hasResumableTranscript: (spec: SpawnSpec) => boolean;

  private readonly episodes = new Map<string, Episode>();

  constructor(opts: RestoreSettleGateOptions = {}) {
    this.boundMs = opts.boundMs ?? DEFAULT_BOUND_MS;
    this.now = opts.now ?? Date.now;
    this.log = opts.log;
    this.hasResumableTranscript = opts.hasResumableTranscript ?? hasResumableTranscript;
  }

  private episodeFor(scope: string): Episode {
    let episode = this.episodes.get(scope);
    if (!episode) {
      episode = {
        settled: false,
        episodeStartedAt: undefined,
        lastRunning: undefined,
        everHeld: new Set<string>(),
        held: new Set<string>(),
        selfReleasedIds: new Set<string>(),
      };
      this.episodes.set(scope, episode);
    }
    return episode;
  }

  /**
   * Filter this poll's fresh-spawn candidates for `scope` (default
   * `DEFAULT_SCOPE` — every caller before FACTORY-713 passed no scope at
   * all, and omitting it still works unchanged for a single-loop caller).
   * `running` is this SAME poll's `herd.runningIssues()` result, already
   * scoped to THIS CALLER's own ids (already resolved by `reconcileNow` —
   * never re-fetched here, so a rejecting `runningIssues()` still throws out
   * of `reconcileNow` before this is ever reached, exactly as today). `specs`
   * resolves a candidate id to its `SpawnSpec`, for `hasResumableTranscript`.
   *
   * Two different scopes never interact: each keeps its own stability
   * comparison, its own settle latch, and its own self-released-id set —
   * see this class's own doc comment for why a single shared set of that
   * state across two independently-polling loops is actively harmful.
   *
   * Returns `candidates` unchanged for every candidate with no resumable
   * transcript, always. Once `scope` has settled (by stability or by
   * bound), returns `candidates` unchanged for everything in that scope —
   * permanently open for the rest of this process's life, for that scope
   * only.
   */
  filter(candidates: readonly string[], running: readonly string[], specs: ReadonlyMap<string, SpawnSpec>, scope: string = DEFAULT_SCOPE): readonly string[] {
    const ep = this.episodeFor(scope);
    if (ep.settled) return candidates;

    const rawRunningSet = new Set(running);
    // Ids THIS gate has itself released (spawned, resumed-and-passed-
    // through, or fresh-spawned on an earlier settle) must not count as
    // settle evidence — see this class's doc comment (review round 2).
    // Only ids herdr listed on its own are real evidence.
    const runningSet = new Set([...rawRunningSet].filter((id) => !ep.selfReleasedIds.has(id)));
    // An EMPTY (post-exclusion) listing never counts as "stable" — see this
    // class's doc comment. Only a non-empty listing that repeats unchanged
    // is evidence herdr's restore has actually settled; emptiness repeating
    // is just the unresolved hazard persisting.
    const stableSincePrevPoll = runningSet.size > 0 && ep.lastRunning !== undefined && setsEqual(ep.lastRunning, runningSet);
    ep.lastRunning = runningSet;

    const resumableHeldCandidates = candidates.filter((id) => {
      if (rawRunningSet.has(id)) return false;
      const spec = specs.get(id);
      return !!spec && this.hasResumableTranscript(spec);
    });

    if (ep.everHeld.size === 0 && resumableHeldCandidates.length === 0) {
      // Nothing has ever needed gating — an ordinary poll, not a cold-boot
      // settle episode. Stays un-settled (a later poll may still start one)
      // but there is nothing to hold or log this poll.
      for (const id of candidates) ep.selfReleasedIds.add(id);
      return candidates;
    }

    if (ep.episodeStartedAt === undefined) ep.episodeStartedAt = this.now();
    for (const id of resumableHeldCandidates) {
      ep.everHeld.add(id);
      ep.held.add(id);
    }
    // An id picked up by `running` since it was first held was resumed by
    // the ordinary stale/resumeInPlace path (FACTORY-470/472/491/500/501) —
    // resolved, not fresh-spawned; stop holding it. Uses the RAW set: this
    // asks about one specific id, not about what the overall listing implies.
    for (const id of [...ep.held]) if (rawRunningSet.has(id)) ep.held.delete(id);

    const boundExceeded = this.now() - ep.episodeStartedAt >= this.boundMs;
    if (!stableSincePrevPoll && !boundExceeded) {
      // Still settling: hold every currently-held id out of this poll's
      // spawn candidates; let anything else (never held) through unchanged.
      const result = candidates.filter((id) => !ep.held.has(id));
      for (const id of result) ep.selfReleasedIds.add(id);
      return result;
    }

    ep.settled = true;
    const fresh = [...ep.held];
    const resumed = ep.everHeld.size - fresh.length;
    if (boundExceeded && !stableSincePrevPoll) {
      this.log?.(`WARNING: [restore-settle${scope === DEFAULT_SCOPE ? "" : `:${scope}`}] bounded wait of ${this.boundMs}ms exceeded before herdr's restore settled — falling back to fresh-spawn for ${fresh.length} definition(s): ${fresh.join(", ") || "(none)"}`);
    }
    this.log?.(`[restore-settle${scope === DEFAULT_SCOPE ? "" : `:${scope}`}] ${resumed} resumed, ${fresh.length} fresh`);
    ep.held.clear();
    for (const id of candidates) ep.selfReleasedIds.add(id);
    return candidates;
  }
}

/** Scope used by every caller that doesn't pass one — unchanged log-line shape for the gate's original (pre-FACTORY-713) single-loop caller. */
const DEFAULT_SCOPE = "default";

interface Episode {
  settled: boolean;
  episodeStartedAt: number | undefined;
  lastRunning: ReadonlySet<string> | undefined;
  /** Ids ever held this episode, including ones later resolved by `running` catching up (resumed). */
  everHeld: Set<string>;
  /** Ids CURRENTLY held — still absent from `running`, still waiting. */
  held: Set<string>;
  /**
   * Every id this gate has itself returned from `filter()` so far for this
   * scope (spawned immediately, resumed-and-passed-through, or released on
   * settle) — see this class's own doc comment (review round 2). Excluded
   * from `running` before the empty/stable checks so butchr's own spawns
   * never masquerade as herdr's restore progress.
   */
  selfReleasedIds: Set<string>;
}

function setsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}
