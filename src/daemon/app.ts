import { Elysia } from "elysia";
import { thatch } from "@brooswit/thatch";
import { liveView, type ViewDeps } from "../web/view.js";
import type { ToolDef } from "@brooswit/thatch";
import { preIdentityRefusalLine } from "../tools/outcome.js";

/**
 * One process, one HTTP server: the MCP endpoint agents connect to (`/mcp`) and
 * the read-only live view. Agents identify the issue they work on with an
 * `x-issue` header at connect; the daemon addresses channel events by it.
 *
 * `log` defaults to `console.error`, the same convention `atlassianTools`
 * (src/tools/defs.ts) already uses for its own audit/outcome lines — so both
 * this daemon's per-call `[tools2]` records and this gate's own pre-identity
 * `[tools2]` record land on the SAME stream, in the SAME journal.
 */
export function buildApp(view: ViewDeps, tools: Record<string, ToolDef<any>> = {}, log: (line: string) => void = console.error) {
  const { plugin, mcp } = thatch({
    serverInfo: { name: "butchr", version: "0" },
    tools,
    // Every agent connecting must say which issue it is working on. BUTCHR-341
    // (B): before this change, a connection refused here (no `x-issue`) left
    // NO record anywhere — @brooswit/thatch returns the 401 itself, with no
    // log line of any kind (see src/tools/outcome.ts's own doc comment for
    // where that was confirmed). Record it here, in butchr's own code, since
    // this `auth` closure IS butchr's own code, not the framework's.
    auth: (req) => {
      const identified = Boolean(req.headers.get("x-issue"));
      if (!identified) log(preIdentityRefusalLine());
      return identified;
    },
  });
  const app = new Elysia().use(plugin).use(liveView(mcp, view));
  return { app, mcp };
}

/** Push an update to whichever agent(s) say they are working `issueKey`. */
export function notifyIssue(mcp: ReturnType<typeof buildApp>["mcp"], issueKey: string, content: string) {
  return mcp.sendAll({ content, meta: { issue: issueKey } }, { where: (c) => c.headers["x-issue"] === issueKey });
}
