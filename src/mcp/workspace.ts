import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { decodeAgentKey } from "../rules/agent-key.js";

/**
 * The global registration is shared; identity is local to each MCP child.
 * Two workspace shapes are accepted: a legacy direct child of the root
 * (`<root>/<ISSUE>`, identity = the directory name) and a rule-engine
 * workspace (`<root>/<provider>/<rule>/<ISSUE>`), whose metadata must also
 * name the agent key the path encodes.
 */
export function bridgeWorkspace(root: string, cwd: string): { url: URL; identity: string; agent?: string } {
  const directory = realpathSync(cwd);
  const rel = relative(realpathSync(root), directory);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("Not a factory workspace");
  const segments = rel.split(sep);
  const agent = segments.length === 3 ? segments.join(":") : undefined;
  const decoded = agent === undefined ? null : decodeAgentKey(agent);
  if (segments.length !== 1 && !decoded) throw new Error("Not a factory workspace");
  const expectedIssue = decoded ? decoded.resourceId : segments[0];
  const value: unknown = JSON.parse(readFileSync(join(directory, ".butchr-agy.json"), "utf8"));
  if (!value || typeof value !== "object" || !("issue" in value) || !("mcpUrl" in value)
    || typeof value.issue !== "string" || value.issue !== expectedIssue
    || !/^[A-Za-z0-9_-]+$/.test(value.issue) || typeof value.mcpUrl !== "string"
    || (decoded ? !("agent" in value) || value.agent !== agent : "agent" in value)) {
    throw new Error("Invalid factory workspace identity");
  }
  const url = new URL(value.mcpUrl);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("Invalid factory MCP endpoint");
  }
  return { url, identity: value.issue, ...(decoded ? { agent: agent! } : {}) };
}
