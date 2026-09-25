import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { decodeAnyAgentKey } from "../rules/agent-key.js";
import { KEY_ONLY_PROVIDERS } from "./identity.js";

/**
 * The global registration is shared; identity is local to each MCP child.
 * Two workspace shapes are accepted: a legacy direct child of the root
 * (`<root>/<ISSUE>`, identity = the directory name) and a rule-engine
 * workspace (`<root>/<provider>/<rule>/<ISSUE-or-"@query">`), whose metadata
 * must also name the agent key the path encodes. A `github-issue`,
 * `jira-idea` or `zendesk-ticket` workspace's metadata names its agent and
 * resource instead of an `issue`, and the bridge sends the agent key alone
 * (src/mcp/identity.ts).
 *
 * `decodeAnyAgentKey` (BUTCHR-397) means a query-level workspace decodes
 * here too, so it is never misread as "not a factory workspace". BUTCHR-398
 * defines its `.butchr-agy.json` shape: `{ agent, mcpUrl }` alone — no
 * `issue`/`resource` field at all (it has no single one — see
 * `buildWorkspace`, src/agents/workspace.ts), checked BEFORE the
 * `KEY_ONLY_PROVIDERS` branch since a query-level agent of ANY provider
 * (jira-work included) uses this shape, not that one.
 */
export function bridgeWorkspace(root: string, cwd: string): { url: URL; identity?: string; agent?: string } {
  const directory = realpathSync(cwd);
  const rel = relative(realpathSync(root), directory);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("Not a factory workspace");
  const segments = rel.split(sep);
  const agent = segments.length === 3 ? segments.join(":") : undefined;
  const decoded = agent === undefined ? null : decodeAnyAgentKey(agent);
  if (segments.length !== 1 && !decoded) throw new Error("Not a factory workspace");
  const value: unknown = JSON.parse(readFileSync(join(directory, ".butchr-agy.json"), "utf8"));
  if (decoded?.kind === "query") {
    if (!value || typeof value !== "object" || "issue" in value || "resource" in value
      || !("agent" in value) || value.agent !== agent || !("mcpUrl" in value) || typeof value.mcpUrl !== "string") {
      throw new Error("Invalid factory workspace identity");
    }
    return { url: endpoint(value.mcpUrl), agent: agent! };
  }
  const expectedIssue = decoded?.kind === "resource" ? decoded.resourceId : decoded ? null : segments[0];
  if (decoded && KEY_ONLY_PROVIDERS.includes(decoded.resourceProvider)) {
    if (!value || typeof value !== "object" || "issue" in value || !("agent" in value) || value.agent !== agent
      || !("resource" in value) || value.resource !== expectedIssue || !("mcpUrl" in value) || typeof value.mcpUrl !== "string") {
      throw new Error("Invalid factory workspace identity");
    }
    return { url: endpoint(value.mcpUrl), agent: agent! };
  }
  if (!value || typeof value !== "object" || !("issue" in value) || !("mcpUrl" in value)
    || typeof value.issue !== "string" || value.issue !== expectedIssue
    || !/^[A-Za-z0-9_-]+$/.test(value.issue) || typeof value.mcpUrl !== "string"
    || (decoded ? !("agent" in value) || value.agent !== agent : "agent" in value)) {
    throw new Error("Invalid factory workspace identity");
  }
  return { url: endpoint(value.mcpUrl), identity: value.issue, ...(decoded ? { agent: agent! } : {}) };
}

function endpoint(mcpUrl: string): URL {
  const url = new URL(mcpUrl);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("Invalid factory MCP endpoint");
  }
  return url;
}
