import { accessSync, constants, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentConfig } from "../agents/argv.js";
import { workspaceRoot } from "../agents/workspace.js";

export function registrationMatches(value: unknown, root: string, executable: string, bun: string): boolean {
  if (!value || typeof value !== "object" || !("mcpServers" in value)) return false;
  const servers = value.mcpServers;
  if (!servers || typeof servers !== "object" || !("butchr" in servers)) return false;
  // AGY has no verified per-launch override: do not inherit another agent's identity.
  if (Object.entries(servers).some(([name, config]) => name !== "butchr"
    && (!config || typeof config !== "object" || !("disabled" in config) || config.disabled !== true))) return false;
  const entry = servers.butchr;
  if (!entry || typeof entry !== "object" || !("command" in entry) || !("args" in entry)) return false;
  if ("disabled" in entry && entry.disabled !== false && entry.disabled !== undefined) return false;
  if ("url" in entry || "serverUrl" in entry) return false;
  const args = entry.args;
  if (!Array.isArray(args) || args.some(arg => typeof arg !== "string")) return false;
  const expected = ["--workspace-root", resolve(root)];
  return (entry.command === executable && JSON.stringify(args) === JSON.stringify(expected))
    || (entry.command === bun && JSON.stringify(args) === JSON.stringify([executable, ...expected]));
}

export function bridgeExecutable(): string {
  const current = fileURLToPath(import.meta.url);
  return basename(current) === "butchr.js"
    ? join(dirname(current), "butchr-mcp.js")
    : resolve(dirname(current), "../../dist/butchr-mcp.js");
}

/** Read only the service user's registration; never log its contents. */
export function inventoryAgyMcp(
  agent: AgentConfig,
  log: (line: string) => void,
  probe: () => boolean = () => {
    const executable = bridgeExecutable();
    accessSync(executable, constants.X_OK);
    return registrationMatches(
      JSON.parse(readFileSync(join(homedir(), ".gemini/config/mcp_config.json"), "utf8")),
      workspaceRoot(), executable, process.execPath,
    );
  },
): AgentConfig {
  if (![agent.provider, ...(agent.providers ?? []), ...Object.values(agent.roleProviders ?? {}).flat()].includes("agy")) return agent;
  try {
    if (probe()) {
      const ready = { ...agent };
      delete ready.agySpawnBlocked;
      return ready;
    }
  } catch { /* Missing and malformed registrations are equally unavailable. */ }
  const reason = "Antigravity Butchr MCP bridge is unavailable or misconfigured; new AGY spawns disabled. Configure the service user's butchr stdio registration and restart Butchr.";
  log(reason);
  return { ...agent, agySpawnBlocked: reason };
}
