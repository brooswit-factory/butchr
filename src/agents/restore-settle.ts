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
 */
export class RestoreSettleGate {
  private readonly boundMs: number;
  private readonly now: () => number;
  private readonly log: ((line: string) => void) | undefined;
  private readonly hasResumableTranscript: (spec: SpawnSpec) => boolean;

  private settled = false;
  private episodeStartedAt: number | undefined;
  private lastRunning: ReadonlySet<string> | undefined;
  /** Ids ever held this episode, including ones later resolved by `running` catching up (resumed). */
  private everHeld = new Set<string>();
  /** Ids CURRENTLY held — still absent from `running`, still waiting. */
  private held = new Set<string>();

  constructor(opts: RestoreSettleGateOptions = {}) {
    this.boundMs = opts.boundMs ?? DEFAULT_BOUND_MS;
    this.now = opts.now ?? Date.now;
    this.log = opts.log;
    this.hasResumableTranscript = opts.hasResumableTranscript ?? hasResumableTranscript;
  }

  /**
   * Filter this poll's fresh-spawn candidates. `running` is this SAME poll's
   * `herd.runningIssues()` result (already resolved by `reconcileNow` —
   * never re-fetched here, so a rejecting `runningIssues()` still throws out
   * of `reconcileNow` before this is ever reached, exactly as today). `specs`
   * resolves a candidate id to its `SpawnSpec`, for `hasResumableTranscript`.
   *
   * Returns `candidates` unchanged for every candidate with no resumable
   * transcript, always. Once settled (by stability or by bound), returns
   * `candidates` unchanged for everything — the gate is permanently open for
   * the rest of this process's life.
   */
  filter(candidates: readonly string[], running: readonly string[], specs: ReadonlyMap<string, SpawnSpec>): readonly string[] {
    if (this.settled) return candidates;

    const runningSet = new Set(running);
    // An EMPTY listing never counts as "stable" — see this class's doc
    // comment. Only a non-empty listing that repeats unchanged is evidence
    // herdr's restore has actually settled; emptiness repeating is just the
    // unresolved hazard persisting.
    const stableSincePrevPoll = runningSet.size > 0 && this.lastRunning !== undefined && setsEqual(this.lastRunning, runningSet);
    this.lastRunning = runningSet;

    const resumableHeldCandidates = candidates.filter((id) => {
      if (runningSet.has(id)) return false;
      const spec = specs.get(id);
      return !!spec && this.hasResumableTranscript(spec);
    });

    if (this.everHeld.size === 0 && resumableHeldCandidates.length === 0) {
      // Nothing has ever needed gating — an ordinary poll, not a cold-boot
      // settle episode. Stays un-settled (a later poll may still start one)
      // but there is nothing to hold or log this poll.
      return candidates;
    }

    if (this.episodeStartedAt === undefined) this.episodeStartedAt = this.now();
    for (const id of resumableHeldCandidates) {
      this.everHeld.add(id);
      this.held.add(id);
    }
    // An id picked up by `running` since it was first held was resumed by
    // the ordinary stale/resumeInPlace path (FACTORY-470/472/491/500/501) —
    // resolved, not fresh-spawned; stop holding it.
    for (const id of [...this.held]) if (runningSet.has(id)) this.held.delete(id);

    const boundExceeded = this.now() - this.episodeStartedAt >= this.boundMs;
    if (!stableSincePrevPoll && !boundExceeded) {
      // Still settling: hold every currently-held id out of this poll's
      // spawn candidates; let anything else (never held) through unchanged.
      return candidates.filter((id) => !this.held.has(id));
    }

    this.settled = true;
    const fresh = [...this.held];
    const resumed = this.everHeld.size - fresh.length;
    if (boundExceeded && !stableSincePrevPoll) {
      this.log?.(`WARNING: [restore-settle] bounded wait of ${this.boundMs}ms exceeded before herdr's restore settled — falling back to fresh-spawn for ${fresh.length} definition(s): ${fresh.join(", ") || "(none)"}`);
    }
    this.log?.(`[restore-settle] ${resumed} resumed, ${fresh.length} fresh`);
    this.held.clear();
    return candidates;
  }
}

function setsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}
