import { describe, expect, test } from "bun:test";
import { RESPAWN_MARKER, RESPAWN_RESUME_MARKER, RESUME_MARKER, respawnComment, respawnResumedComment, resumePreservedComment } from "../../src/agents/respawn.js";

describe("respawnComment", () => {
  test("begins exactly with the [butchr:respawn] tag and names the issue, time, and missing flags", () => {
    const c = respawnComment("KAN-783", "argv lacks --permission-mode bypassPermissions, --mcp-config /w/mcp.json", "2026-08-29T01:30:00.000Z");
    expect(c.startsWith(RESPAWN_MARKER)).toBe(true);
    expect(c).toContain("KAN-783's agent was restarted by the daemon at 2026-08-29T01:30:00.000Z");
    expect(c).toContain("--permission-mode bypassPermissions, --mcp-config /w/mcp.json");
    expect(c).not.toContain("argv lacks --permission-mode bypassPermissions, --mcp-config /w/mcp.json"); // the "argv lacks" prefix reads naturally inline instead
    expect(c).toContain("This session is fresh — re-read your ticket");
  });

  // FACTORY-314: a resumeInPlace() attempt that could not go ahead
  // ("unresumable") falls back to today's stop-then-fresh-spawn with a
  // plain-English reason, not a checkArgv() "argv lacks ..." string — must
  // still read naturally and still tell the (genuinely fresh) agent to
  // re-read its ticket, since this path really did lose the session.
  test("a plain-English (non-'argv lacks') reason reads naturally and still says the session is fresh", () => {
    const c = respawnComment("KAN-900", "session lost: session id could not be determined", "2026-09-26T17:00:00.000Z");
    expect(c.startsWith(RESPAWN_MARKER)).toBe(true);
    expect(c).toContain("KAN-900's agent was restarted by the daemon at 2026-09-26T17:00:00.000Z: session lost: session id could not be determined.");
    expect(c).toContain("This session is fresh — re-read your ticket");
  });
});

describe("resumePreservedComment", () => {
  test("begins with the [butchr:resume] tag, names the issue and time, and NEVER tells the agent to re-read its ticket", () => {
    const c = resumePreservedComment("KAN-783", "2026-09-26T17:00:00.000Z");
    expect(c.startsWith(RESUME_MARKER)).toBe(true);
    expect(c).toContain("KAN-783's agent was relaunched by the daemon at 2026-09-26T17:00:00.000Z");
    expect(c).toContain("PRESERVED");
    expect(c).not.toContain("re-read your ticket");
    expect(c).not.toContain(RESPAWN_MARKER);
  });
});

// FACTORY-916: the third wording — neither existing marker fits a respawn
// that resumed its prior Claude session via an ordinary fresh spawn (as
// opposed to resumeInPlace()'s same-pane relaunch), because the agent's
// process genuinely WAS gone for a time (unlike resumeInPlace()'s own
// still-running pane) even though its conversation was preserved.
describe("respawnResumedComment", () => {
  test("begins with its OWN [butchr:respawn-resume] tag — neither respawnComment's nor resumePreservedComment's — names the issue and time, says the session was resumed, AND tells the agent to re-read its ticket", () => {
    const c = respawnResumedComment("KAN-950", "2026-10-09T05:41:00.000Z");
    expect(c.startsWith(RESPAWN_RESUME_MARKER)).toBe(true);
    expect(c).not.toContain(RESPAWN_MARKER);
    expect(c).not.toContain(RESUME_MARKER);
    expect(c).toContain("KAN-950's agent");
    expect(c).toContain("2026-10-09T05:41:00.000Z");
    // Says the conversation was preserved...
    expect(c).toContain("resuming its PRIOR Claude session");
    expect(c).not.toContain("This session is fresh"); // wrong here — the conversation IS preserved
    // ...but, unlike resumePreservedComment, still requires a ticket re-read.
    expect(c).toContain("re-read your ticket");
    expect(c).not.toContain("your ticket has not changed"); // resumePreservedComment's own wording — wrong here, the agent WAS actually gone
  });
});
