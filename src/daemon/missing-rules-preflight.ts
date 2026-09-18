/**
 * Startup preflight: refuse to run with NO rules file while rule agents are
 * still live.
 *
 * A missing rules file means zero rules, and every rule loop still owns its
 * provider's agents, so the first poll would stop EVERY live rule agent. That
 * is the right reading of "the operator removed every rule", but a missing
 * file on restart is far more often an accident: a changed HOME or
 * XDG_CONFIG_HOME in the unit, a renamed path, a deleted file. Stopping the
 * whole fleet for that is the wrong failure. So when the file is missing and
 * rule agents are running, the daemon names them and exits; the operator
 * restores the file, or stops the agents deliberately.
 *
 * With no rule agents running, a missing file stays what it always was: zero
 * rules, nothing staffed. A present file with fewer rules still stops the
 * agents of rules it no longer has — that is an explicit edit, not an accident.
 *
 * Read-only: this lists herdr agents and nothing else. A failed list fails
 * closed — "could not check" is not "none running".
 */
import { ruleAgentIdOfWorkspacePath, workspaceRoot } from "../agents/workspace.js";
import type { PreflightAgent } from "./legacy-preflight.js";

export type MissingRulesPreflight = { ok: true } | { ok: false; message: string };

export async function missingRulesPreflight(
  rulesPath: string,
  list: () => Promise<readonly PreflightAgent[]>,
  root: string = workspaceRoot(),
): Promise<MissingRulesPreflight> {
  let agents: readonly PreflightAgent[];
  try { agents = await list(); }
  catch (e) {
    return { ok: false, message: `startup preflight could not list herdr agents to check for live rule agents: ${(e as Error)?.message ?? e}. Refusing to start with no rules file at ${rulesPath}: zero rules would stop any rule agent still running. Start herdr and retry.` };
  }
  const live = agents
    .map((a) => ({ id: ruleAgentIdOfWorkspacePath(a.cwd, root), pane: a.pane_id ?? null }))
    .filter((a): a is { id: string; pane: string | null } => a.id !== null);
  if (!live.length) return { ok: true };
  return {
    ok: false,
    message: [
      `startup preflight: no rules file at ${rulesPath}, but ${live.length} rule agent(s) are running. Refusing to start.`,
      ...live.map((a) => `  ${a.id}: pane ${a.pane ?? "?"}`),
      "Zero rules would stop every one of them on the first poll. A missing file is usually an accident (a changed HOME, XDG_CONFIG_HOME or BUTCHR_RULES_FILE).",
      "Restore the rules file (or point BUTCHR_RULES_FILE at it) and start again. To retire these agents on purpose, use a rules file without their rules, or stop them yourself first.",
    ].join("\n"),
  };
}
