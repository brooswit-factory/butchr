import { DEFAULT_RESUME_CONTEXT_CUTOFF } from "../rules/rules.js";
import { claudeTranscriptExists, estimateTranscriptTokens, invalidatePersistedSessionId, workspaceSessionId } from "./workspace.js";
import { classifyStop, clearStopCause, workspaceStopCause } from "./stop-cause.js";

export const RESPAWN_MARKER = "[butchr:respawn]";

/**
 * The one-time ticket notice posted right after a stale respawn whose
 * session was LOST (a fresh Claude Code session with no memory of the
 * interrupted one) — so the agent is pointed back at the ticket, the only
 * place its in-flight state survived. `reason` is either a checkArgv()
 * reason string ("argv lacks --flag value, ...", the leading "argv lacks "
 * stripped so it reads naturally inline) or, since FACTORY-314, a plain-
 * English reason for a resume attempt that could not go ahead (e.g.
 * "session lost: session id could not be determined") — either shape reads
 * naturally in the sentence below.
 */
export function respawnComment(issue: string, reason: string, atIso: string): string {
  const argvReason = reason.startsWith("argv lacks ");
  const because = argvReason
    ? `its process argv lacked ${reason.replace(/^argv lacks /, "")} (typically a herdr server restart restoring the pane as a bare \`claude --resume\`)`
    : reason;
  return `${RESPAWN_MARKER} ${issue}'s agent was restarted by the daemon at ${atIso}: ${because}. This session is fresh — re-read your ticket; your previous session's in-flight state lives on the ticket, not in memory.`;
}

export const RESUME_MARKER = "[butchr:resume]";

/**
 * FACTORY-314, worded generally by FACTORY-470/472 — the ticket notice
 * posted after `herd.resumeInPlace()` succeeds, whether that relaunch was
 * for a model/effort-only change or (FACTORY-470/472) a herdr-restored pane
 * relaunched with butchr's full flag set: either way the SAME Claude
 * session (same session id) continued rather than starting fresh.
 * Deliberately NEVER says "re-read your ticket" — that instruction is
 * exactly wrong for an agent that still holds its own conversation.
 */
export function resumePreservedComment(issue: string, atIso: string): string {
  return `${RESUME_MARKER} ${issue}'s agent was relaunched by the daemon at ${atIso} on the same session, with its current launch settings (model, effort, permission-mode, mcp-config, and channels) applied. Its session was PRESERVED — this is the SAME conversation, resumed with the current settings. Nothing was lost, and your ticket has not changed; carry on exactly where you left off.`;
}

export const RESPAWN_RESUME_MARKER = "[butchr:respawn-resume]";

/**
 * FACTORY-916 (epic FACTORY-843, story FACTORY-850) — the THIRD ticket
 * notice this story adds, posted after an UNINTENDED-stop respawn resumed
 * its prior Claude session (`--resume <id>`) via an ordinary fresh spawn —
 * as opposed to `herd.resumeInPlace()`'s own same-pane relaunch, which
 * `resumePreservedComment` above already covers. Neither existing marker
 * fits this case:
 *  - `respawnComment` (above) is flatly wrong here — it says "This session
 *    is fresh", which is false; the conversation IS preserved.
 *  - `resumePreservedComment` (above) is ALSO wrong here, in the opposite
 *    direction: it deliberately says "your ticket has not changed; carry
 *    on exactly where you left off" — right for `resumeInPlace()` (the
 *    agent never stopped running; nothing on its ticket could have moved
 *    in the gap), but wrong here, where the agent's PROCESS died and was
 *    gone for however long the daemon took to notice and respawn it — the
 *    ticket or its brief may genuinely have changed in that gap (a boss's
 *    `tell_worker`, a `correct_worker`, another agent's comment). FACTORY-
 *    843 requires this case to say BOTH things at once: the session is the
 *    agent's own prior conversation (so it should not re-introduce itself
 *    or re-plan from scratch), AND it must re-read its ticket before
 *    acting, because unlike `resumeInPlace()` this agent was genuinely
 *    offline for a stretch.
 */
export function respawnResumedComment(issue: string, atIso: string): string {
  return `${RESPAWN_RESUME_MARKER} ${issue}'s agent crashed or was restarted and was respawned by the daemon at ${atIso}, resuming its PRIOR Claude session (${issue}'s own prior conversation, not a fresh one) — nothing in that conversation was lost. UNLIKE an ordinary resume, this agent's process was actually gone for a time: re-read your ticket before acting, since its status, brief, or comments may have changed while you were down.`;
}

/** One `decideRespawnResume` input/outcome pair, named so every non-resume branch logs the SAME literal reason string a test can assert on. */
export const RESUME_DECISION_REASON = {
  flagOff: "flag off",
  intentional: "stop was intentional",
  noSessionId: "no persisted session id",
  transcriptMissing: "transcript missing",
  overCutoff: (estimatedTokens: number, cutoff: number) => `over cutoff (estimated ~${estimatedTokens} tokens > ${cutoff})`,
} as const;

export interface RespawnResumeDecisionInput {
  /** This workspace's own directory (`workspaceDirFor(spec.key)`/`buildWorkspace`'s return) — both the stop-cause marker and the session-id/transcript files below live here. */
  dir: string;
  /** `SpawnSpec.resumeOnRespawn` — `Rule.resumeOnRespawn` passthrough; absent means ON. */
  resumeOnRespawn?: boolean;
  /** `SpawnSpec.resumeContextCutoff` — absent means `DEFAULT_RESUME_CONTEXT_CUTOFF`. */
  resumeContextCutoff?: number;
  /** `SpawnSpec.ticketStatus`/`ticketLabels` — fed straight into `classifyStop`. */
  ticketStatus?: string;
  ticketLabels?: readonly string[];
  /** Overrides `homedir()` for `claudeTranscriptExists`/`estimateTranscriptTokens` — test-only seam, same shape those two functions already take. */
  home?: string;
}

export interface RespawnResumeDecision {
  /** Set only when every condition held — the caller should emit `--resume <id>` for this launch. */
  resumeSessionId?: string;
  /** Set on every OTHER outcome — the one greppable reason this respawn is starting fresh instead. Absent iff `resumeSessionId` is set. */
  reason?: string;
}

/**
 * FACTORY-916 (epic FACTORY-843, story FACTORY-850) — THE spawn-path
 * decision this story exists to add: given one Claude workspace about to
 * be (re)spawned, decide whether it should `--resume` its prior session or
 * start fresh, and why. Pure over its explicit inputs plus three cheap,
 * already-fail-safe filesystem reads (`workspaceStopCause`, `workspaceSessionId`,
 * `claudeTranscriptExists`/`estimateTranscriptTokens` — none of them parse
 * the (potentially large) transcript itself, see `estimateTranscriptTokens`'s
 * own doc comment) — no Jira or herdr call of its own.
 *
 * ALSO performs this story's step 6 (DoD): clears/supersedes this
 * workspace's durable stop-cause marker, every time this is called — see
 * `clearStopCause`'s own doc comment (src/agents/stop-cause.ts) for the gap
 * this closes (a `stand_down` marker that would otherwise suppress resume
 * forever after a later genuine crash) and why THIS function, called from
 * the one place in the spawn path that knows "a spawn/resume is actually
 * happening", is where that clear belongs. The clear happens AFTER reading
 * the marker into `stopCause` below, never before: clearing first would
 * make every call here read as "no marker", i.e. always `unintended`,
 * which would both defeat the intentional-stop check this function exists
 * to honour AND destroy the one piece of state `classifyStop` needs to
 * tell a deliberate `stand_down` apart from a real crash. Called
 * unconditionally — even when the flag is off or no respawn ultimately
 * resumes — because the marker's own staleness risk (see `clearStopCause`)
 * is about ANY later spawn of this workspace, not only one that happens to
 * resume.
 */
export function decideRespawnResume(input: RespawnResumeDecisionInput): RespawnResumeDecision {
  const stopCause = workspaceStopCause(input.dir);
  clearStopCause(input.dir);
  if (input.resumeOnRespawn === false) return { reason: RESUME_DECISION_REASON.flagOff };
  const classification = classifyStop({ stopCause, ticketStatus: input.ticketStatus ?? "", ticketLabels: input.ticketLabels ?? [] });
  if (classification === "intentional") return { reason: RESUME_DECISION_REASON.intentional };
  const sessionId = workspaceSessionId(input.dir);
  if (!sessionId) return { reason: RESUME_DECISION_REASON.noSessionId };
  if (!claudeTranscriptExists(input.dir, sessionId, input.home)) {
    // Stale: a persisted id whose transcript is gone will never become
    // resumable again on its own — invalidate now rather than leave the
    // next spawn to rediscover the same dead end (mirrors the FACTORY-314
    // discovery-failure branch's own `invalidatePersistedSessionId` call,
    // src/agents/herd.ts).
    invalidatePersistedSessionId(input.dir);
    return { reason: RESUME_DECISION_REASON.transcriptMissing };
  }
  const cutoff = input.resumeContextCutoff ?? DEFAULT_RESUME_CONTEXT_CUTOFF;
  const estimatedTokens = estimateTranscriptTokens(input.dir, sessionId, input.home);
  // `estimatedTokens === undefined` only via a stat-failure race against the
  // `claudeTranscriptExists` check immediately above (the file existed,
  // then vanished) — vanishingly rare, and resuming is the safe side to
  // fall to: the transcript existed a moment ago, and a wrong resume here
  // is bounded by the cutoff this estimate exists to enforce in the first
  // place, same "unintended/resume is the cheap direction to be wrong in"
  // reasoning `classifyStop`'s own doc comment argues.
  if (estimatedTokens !== undefined && estimatedTokens > cutoff) return { reason: RESUME_DECISION_REASON.overCutoff(estimatedTokens, cutoff) };
  return { resumeSessionId: sessionId };
}
