import { Elysia } from "elysia";
import type { McpHandle } from "@brooswit/thatch";

/**
 * The read-only live view: what agents are connected and which issue each says
 * it is working on (from its `x-issue` connect header). No control here — the
 * webapp only observes.
 */
export function liveView(mcp: McpHandle) {
  return new Elysia()
    .get("/health", () => ({ ok: true }))
    .get("/agents", () =>
      mcp.connections.list().map((c) => ({
        id: c.id,
        issue: c.headers["x-issue"] ?? null,
        connectedAt: c.connectedAt,
      })),
    );
}
