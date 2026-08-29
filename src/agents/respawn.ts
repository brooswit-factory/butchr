export const RESPAWN_MARKER = "[butchr:respawn]";

/**
 * The one-time ticket notice posted right after a stale respawn. `reason` is
 * a checkArgv() reason string ("argv lacks --flag value, ..."); the leading
 * "argv lacks " is stripped so it reads naturally inline. A fresh Claude
 * Code session has no memory of the interrupted one, so the agent is pointed
 * back at the ticket — the only place its in-flight state survived.
 */
export function respawnComment(issue: string, reason: string, atIso: string): string {
  const missing = reason.replace(/^argv lacks /, "");
  return `${RESPAWN_MARKER} ${issue}'s agent was restarted by the daemon at ${atIso}: its process argv lacked ${missing} (typically a herdr server restart restoring the pane as a bare \`claude --resume\`). This session is fresh — re-read your ticket; your previous session's in-flight state lives on the ticket, not in memory.`;
}
