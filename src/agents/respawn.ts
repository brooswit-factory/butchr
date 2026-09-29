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
