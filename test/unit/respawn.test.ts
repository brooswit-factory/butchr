import { describe, expect, test } from "bun:test";
import { RESPAWN_MARKER, respawnComment } from "../../src/agents/respawn.js";

describe("respawnComment", () => {
  test("begins exactly with the [butchr:respawn] tag and names the issue, time, and missing flags", () => {
    const c = respawnComment("KAN-783", "argv lacks --permission-mode bypassPermissions, --mcp-config /w/mcp.json", "2026-08-29T01:30:00.000Z");
    expect(c.startsWith(RESPAWN_MARKER)).toBe(true);
    expect(c).toContain("KAN-783's agent was restarted by the daemon at 2026-08-29T01:30:00.000Z");
    expect(c).toContain("--permission-mode bypassPermissions, --mcp-config /w/mcp.json");
    expect(c).not.toContain("argv lacks --permission-mode bypassPermissions, --mcp-config /w/mcp.json"); // the "argv lacks" prefix reads naturally inline instead
    expect(c).toContain("This session is fresh — re-read your ticket");
  });
});
