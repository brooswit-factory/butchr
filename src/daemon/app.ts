import { Elysia } from "elysia";
import { thatch } from "@brooswit/thatch";
import { liveView } from "../web/view.js";

/**
 * One process, one HTTP server: the MCP endpoint agents connect to (`/mcp`) and
 * the read-only live view. Agents identify the issue they work on with an
 * `x-issue` header at connect; the daemon addresses channel events by it.
 */
export function buildApp() {
  const { plugin, mcp } = thatch({
    serverInfo: { name: "butchr", version: "0" },
    // Every agent connecting must say which issue it is working on.
    auth: (req) => Boolean(req.headers.get("x-issue")),
  });
  const app = new Elysia().use(plugin).use(liveView(mcp));
  return { app, mcp };
}

/** Push an update to whichever agent(s) say they are working `issueKey`. */
export function notifyIssue(mcp: ReturnType<typeof buildApp>["mcp"], issueKey: string, content: string) {
  return mcp.sendAll({ content, meta: { issue: issueKey } }, { where: (c) => c.headers["x-issue"] === issueKey });
}
