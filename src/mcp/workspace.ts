import { readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** The global registration is shared; identity is local to each MCP child. */
export function bridgeWorkspace(root: string, cwd: string) {
  const directory = realpathSync(cwd);
  if (dirname(directory) !== realpathSync(root)) throw new Error("Not a factory workspace");
  const value: unknown = JSON.parse(readFileSync(join(directory, ".butchr-agy.json"), "utf8"));
  if (!value || typeof value !== "object" || !("issue" in value) || !("mcpUrl" in value)
    || typeof value.issue !== "string" || value.issue !== basename(directory)
    || !/^[A-Za-z0-9_-]+$/.test(value.issue) || typeof value.mcpUrl !== "string") {
    throw new Error("Invalid factory workspace identity");
  }
  const url = new URL(value.mcpUrl);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("Invalid factory MCP endpoint");
  }
  return { url, identity: value.issue };
}
