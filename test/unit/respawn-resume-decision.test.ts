import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { decideRespawnResume, RESUME_DECISION_REASON } from "../../src/agents/respawn.js";
import { persistDiscoveredSessionId as persistSessionId, workspaceSessionId } from "../../src/agents/workspace.js";
import { persistIntentionalStop, workspaceStopCause } from "../../src/agents/stop-cause.js";
import { DEFAULT_RESUME_CONTEXT_CUTOFF } from "../../src/rules/rules.js";

// FACTORY-916 (epic FACTORY-843, story FACTORY-850) — `decideRespawnResume`
// (src/agents/respawn.ts) is the whole spawn-path decision this ticket adds,
// written as a pure function over a workspace directory precisely so it can
// be tested directly, with no HerdrHerd/drovr/herdr plumbing — `dir` need
// not be a REAL `workspaceDirFor` path; every function it calls
// (`workspaceStopCause`/`clearStopCause`/`workspaceSessionId`/
// `claudeTranscriptExists`/`estimateTranscriptTokens`/
// `invalidatePersistedSessionId`) is a plain filesystem read/write relative
// to whatever `dir` is handed in.
describe("FACTORY-916: decideRespawnResume", () => {
  let dir: string;
  let home: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "butchr-resume-dir-"));
    home = mkdtempSync(join(tmpdir(), "butchr-resume-home-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  /** Writes a fake `<id>.jsonl` transcript of `bytes` bytes under `home`'s Claude project dir for `dir`, matching `claudeProjectDir`'s own encoding (src/agents/workspace.ts). */
  function writeTranscript(id: string, bytes: number): void {
    const projectDir = join(home, ".claude", "projects", resolve(dir).replace(/[^a-zA-Z0-9]/g, "-"));
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, `${id}.jsonl`), "x".repeat(bytes));
  }

  test("flag on (absent), unintended stop, transcript under cutoff -> resumes with the persisted session id", () => {
    persistSessionId(dir, "sess-1");
    writeTranscript("sess-1", 100);
    const decision = decideRespawnResume({ dir, ticketStatus: "In Progress", ticketLabels: [], home });
    expect(decision).toEqual({ resumeSessionId: "sess-1" });
  });

  test("flag off (explicit false) -> fresh, reason logged, even though every other condition would have resumed", () => {
    persistSessionId(dir, "sess-1");
    writeTranscript("sess-1", 100);
    const decision = decideRespawnResume({ dir, resumeOnRespawn: false, ticketStatus: "In Progress", ticketLabels: [], home });
    expect(decision).toEqual({ reason: RESUME_DECISION_REASON.flagOff });
  });

  test("intentional stop (a recorded stop-cause marker) -> fresh, reason logged", () => {
    persistIntentionalStop(dir, "stand_down");
    persistSessionId(dir, "sess-1");
    writeTranscript("sess-1", 100);
    const decision = decideRespawnResume({ dir, ticketStatus: "In Progress", ticketLabels: [], home });
    expect(decision).toEqual({ reason: RESUME_DECISION_REASON.intentional });
  });

  test("intentional stop via ticket status Done (no marker at all) -> fresh", () => {
    persistSessionId(dir, "sess-1");
    writeTranscript("sess-1", 100);
    const decision = decideRespawnResume({ dir, ticketStatus: "Done", ticketLabels: [], home });
    expect(decision).toEqual({ reason: RESUME_DECISION_REASON.intentional });
  });

  test("intentional stop via the shelved label (no marker at all) -> fresh", () => {
    persistSessionId(dir, "sess-1");
    writeTranscript("sess-1", 100);
    const decision = decideRespawnResume({ dir, ticketStatus: "In Progress", ticketLabels: ["butchr:shelved"], home });
    expect(decision).toEqual({ reason: RESUME_DECISION_REASON.intentional });
  });

  test("unintended stop, no persisted session id at all -> fresh, reason logged", () => {
    const decision = decideRespawnResume({ dir, ticketStatus: "In Progress", ticketLabels: [], home });
    expect(decision).toEqual({ reason: RESUME_DECISION_REASON.noSessionId });
  });

  test("unintended stop, persisted session id but its transcript is missing -> fresh, invalidates the stale id", () => {
    persistSessionId(dir, "sess-1"); // no transcript file written for it
    const decision = decideRespawnResume({ dir, ticketStatus: "In Progress", ticketLabels: [], home });
    expect(decision).toEqual({ reason: RESUME_DECISION_REASON.transcriptMissing });
    expect(workspaceSessionId(dir)).toBeUndefined(); // the stale id itself was invalidated, not just skipped
  });

  test("unintended stop, transcript over the rule's own cutoff -> fresh, reason names the estimate and the cutoff", () => {
    persistSessionId(dir, "sess-1");
    writeTranscript("sess-1", 40); // 40 bytes / 4 bytes-per-token = 10 estimated tokens
    const decision = decideRespawnResume({ dir, resumeContextCutoff: 5, ticketStatus: "In Progress", ticketLabels: [], home });
    expect(decision).toEqual({ reason: RESUME_DECISION_REASON.overCutoff(10, 5) });
  });

  test("unintended stop, transcript exactly at the rule's own cutoff -> resumes (the cutoff is inclusive)", () => {
    persistSessionId(dir, "sess-1");
    writeTranscript("sess-1", 40); // -> 10 estimated tokens
    const decision = decideRespawnResume({ dir, resumeContextCutoff: 10, ticketStatus: "In Progress", ticketLabels: [], home });
    expect(decision).toEqual({ resumeSessionId: "sess-1" });
  });

  test("cutoff absent -> DEFAULT_RESUME_CONTEXT_CUTOFF applies, not Infinity", () => {
    persistSessionId(dir, "sess-1");
    // `estimateTranscriptTokens` is bytes / 4 (`BYTES_PER_TOKEN_ESTIMATE`,
    // src/agents/workspace.ts) — one byte over `(cutoff + 1) * 4` estimates
    // to exactly `cutoff + 1` tokens, one past the default.
    writeTranscript("sess-1", (DEFAULT_RESUME_CONTEXT_CUTOFF + 1) * 4);
    const decision = decideRespawnResume({ dir, ticketStatus: "In Progress", ticketLabels: [], home });
    expect(decision.resumeSessionId).toBeUndefined();
    expect(decision.reason).toContain("over cutoff");
  });

  // FACTORY-916 DoD: "A worker that stopped INTENTIONALLY, was respawned,
  // and then stopped UNINTENDEDLY (with no start_worker/adopt_worker in
  // between) DOES resume on that second respawn" — step 6's own test.
  test("marker-clearing: an intentional stop's marker is cleared by the very respawn it causes to start fresh, so a LATER genuine crash resumes instead of reading the stale marker forever", () => {
    persistIntentionalStop(dir, "stand_down");
    persistSessionId(dir, "sess-1");
    writeTranscript("sess-1", 100);

    // First respawn: the stand_down marker is still there — reads intentional, starts fresh.
    const first = decideRespawnResume({ dir, ticketStatus: "In Progress", ticketLabels: [], home });
    expect(first).toEqual({ reason: RESUME_DECISION_REASON.intentional });
    // The marker must already be gone — cleared by this same call, not by
    // some later start_worker/adopt_worker this scenario never calls.
    expect(workspaceStopCause(dir)).toBeUndefined();

    // Second respawn (simulating a GENUINE later crash, no start_worker/
    // adopt_worker(start) in between — nothing re-persisted a marker):
    // the stale "intentional" verdict must NOT persist forever.
    const second = decideRespawnResume({ dir, ticketStatus: "In Progress", ticketLabels: [], home });
    expect(second).toEqual({ resumeSessionId: "sess-1" });
  });

  test("the marker is cleared even on a flag-off outcome — the clear is unconditional, not gated on whether this respawn itself resumes", () => {
    persistIntentionalStop(dir, "stand_down");
    decideRespawnResume({ dir, resumeOnRespawn: false, ticketStatus: "In Progress", ticketLabels: [], home });
    expect(workspaceStopCause(dir)).toBeUndefined();
  });
});
