import { Elysia } from "elysia";
import type { McpHandle } from "@brooswit/thatch";
import { PAGE } from "./page.js";

export interface AgentState { issue: string; status: string; summary: string }

export interface ViewDeps {
  /** The active agents to show (herdr-managed, with status). */
  state: () => Promise<AgentState[]>;
  /** Open the agent's shell in a terminal. Returns whether it launched. */
  open: (issue: string) => Promise<{ ok: boolean; error?: string }>;
}

/** The live view: the page, its data (/state), the connected-agents feed (/agents), and the open action. */
export function liveView(mcp: McpHandle, deps: ViewDeps) {
  return new Elysia()
    .get("/", () => new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } }))
    .get("/health", () => ({ ok: true }))
    .get("/state", () => deps.state())
    .get("/agents", () => mcp.connections.list().map((c) => ({ id: c.id, issue: c.headers["x-issue"] ?? null, connectedAt: c.connectedAt })))
    .post("/agents/:issue/open", async ({ params, set }) => {
      const r = await deps.open(decodeURIComponent(params.issue));
      if (!r.ok) { set.status = 409; return { ok: false, error: r.error ?? "could not open" }; }
      return { ok: true };
    });
}
