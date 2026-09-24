/**
 * Startup preflight: refuse to run while agents from the pre-rules layout
 * (`<workspace root>/<ISSUE>`) are still live.
 *
 * No rule loop owns such an agent (`ownsId` never matches a bare issue key),
 * so none can stop or respawn it, yet the admission census counts every
 * resident pane against `BUTCHR_MAX_AGENTS`. Running beside them would
 * silently shrink or oversubscribe the cap. Adopting them would rewrite their
 * identity. So the daemon names them and exits; the operator stops them.
 *
 * Read-only: this lists herdr agents and nothing else. It never stops,
 * closes, or touches a workspace directory. A failed list fails closed —
 * "could not check" is not "none running".
 */
import { decodeAnyAgentKey } from "../rules/agent-key.js";
import { agentIdOfWorkspacePath, workspaceRoot } from "../agents/workspace.js";

export interface PreflightAgent { pane_id?: string | null; cwd?: string | null }

export interface LegacyAgent { id: string; pane: string | null; cwd: string }

/**
 * Live agents working in a one-deep legacy workspace. Uses `decodeAnyAgentKey`
 * (BUTCHR-397), not the per-resource-only `decodeAgentKey`: a query-level
 * agent's three-deep workspace must never be flagged legacy and block
 * startup just because it names no single resource.
 */
export function legacyAgents(agents: readonly PreflightAgent[], root: string = workspaceRoot()): LegacyAgent[] {
  const out: LegacyAgent[] = [];
  for (const a of agents) {
    const id = agentIdOfWorkspacePath(a.cwd, root);
    if (id && !decodeAnyAgentKey(id)) out.push({ id, pane: a.pane_id ?? null, cwd: a.cwd! });
  }
  return out;
}

export type LegacyPreflight = { ok: true } | { ok: false; message: string };

export async function legacyAgentPreflight(list: () => Promise<readonly PreflightAgent[]>, root: string = workspaceRoot()): Promise<LegacyPreflight> {
  let agents: readonly PreflightAgent[];
  try { agents = await list(); }
  catch (e) {
    return { ok: false, message: `startup preflight could not list herdr agents to check for legacy workspace agents: ${(e as Error)?.message ?? e}. Refusing to start: live legacy agents would count against BUTCHR_MAX_AGENTS with no loop to manage them. Start herdr and retry.` };
  }
  const legacy = legacyAgents(agents, root);
  if (!legacy.length) return { ok: true };
  return {
    ok: false,
    message: [
      `startup preflight: ${legacy.length} agent(s) still running in legacy flat workspaces under ${root}. Refusing to start.`,
      ...legacy.map((a) => `  ${a.id}: pane ${a.pane ?? "?"} in ${a.cwd}`),
      "No rule loop owns these agents, so none would stop or respawn them, yet each counts against BUTCHR_MAX_AGENTS.",
      "Butchr does not stop or adopt them. Stop each one yourself (for example `herdr pane close <pane>`), then start the daemon again.",
      "Their workspace directories are kept on disk; nothing there is deleted or rewritten.",
    ].join("\n"),
  };
}
