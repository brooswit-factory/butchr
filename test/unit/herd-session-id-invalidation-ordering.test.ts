// FACTORY-418 (fixed inside FACTORY-411/FACTORY-424's PR, not its own — see
// that ticket for why it's routed here). On `main` before this fix,
// `HerdrHerd.startProviders` only called `invalidatePersistedSessionId()` in
// the discovery poll's FAILURE branch, reached only once the whole bounded
// poll (`SESSION_DISCOVERY_ATTEMPTS` retries) had completed. A daemon death,
// or a non-ENOENT filesystem error thrown mid-poll, meant that branch was
// never reached at all — so a stale session id (and its still-present
// transcript, from a PRIOR launch of the same workspace) survived on disk. A
// later `resumeInPlace()` would then find that stale id, find its transcript
// still sitting in the same per-cwd project folder (`claudeTranscriptExists`
// is a bare `existsSync`), and `--resume` it: silently reviving a DIFFERENT,
// already-finished conversation while reporting the session "PRESERVED".
//
// This test simulates the interruption using the SAME seam the constructor
// already documents as "Injectable wait, for tests" (`HerdrHerd`'s 3rd
// constructor arg): the poll's own `await this.wait(SESSION_DISCOVERY_POLL_MS)`
// between attempts throws instead of resolving, standing in for either a
// daemon dying mid-poll or a filesystem error interrupting it — either way,
// nothing after that point in the loop ever runs. Against the PRE-FIX
// ordering (invalidate only in the unreached post-poll failure branch) this
// test FAILS: the stale id and its transcript both survive, and
// `resumeInPlace()` wrongly reports "resumed". Against the FIX (invalidate
// unconditionally, before the poll begins) it PASSES. This is deliberately a
// DIFFERENT interruption point than the existing "FACTORY-314 (epic review,
// round 3)" test in herd.test.ts, which exercises the poll completing
// normally and finding nothing — that test passes both before and after this
// fix and proves nothing about it; this one is the one that actually
// distinguishes the two orderings.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { HerdrHerd, SESSION_DISCOVERY_POLL_MS } from "../../src/agents/herd.js";
import { workspaceDirFor, workspaceRoot, workspaceSessionId, persistDiscoveredSessionId } from "../../src/agents/workspace.js";
import { encodeAgentKey } from "../../src/rules/agent-key.js";

/**
 * Same shape as `fakeHerdr` in herd.test.ts (kept in sync deliberately,
 * not re-exported from there — it's a local test fixture, not part of that
 * file's public surface). Deliberately never writes a Claude transcript —
 * this launch's OWN discovery attempt(s) find nothing, exactly like a real
 * launch whose first poll attempt loses the race against Claude's own
 * transcript-file creation.
 */
function fakeHerdr(agents: Array<{ name?: string; pane_id: string; cwd?: string | undefined; workspace_id?: string }>) {
  const started: any[] = [];
  let createdCwd: string | undefined; let createdWorkspaceId = "w9";
  const client = {
    agent: {
      list: async () => ({ agents: agents.map((a) => {
        const cwd = a.cwd ?? (a.name?.startsWith("butchr-") ? join(workspaceRoot(), a.name.slice("butchr-".length).toUpperCase()) : undefined);
        const workspace_id = a.workspace_id ?? "w9";
        return cwd ? { ...a, agent: "claude", cwd, workspace_id } : { ...a, workspace_id };
      }) }),
      start: async (p: any) => { started.push(p); agents.push({ name: p.name, pane_id: p.pane_id, cwd: createdCwd, workspace_id: createdWorkspaceId }); },
    },
    pane: { close: async () => {}, read: async () => ({ read: { text: "" } }) },
    workspace: {
      create: async (p: any) => { createdCwd = p.cwd; return { root_pane: { pane_id: `${createdWorkspaceId}:p1` } }; },
      rename: async () => ({}),
      reportMetadata: async () => ({}),
    },
  };
  return { client: client as any, started };
}

test("FACTORY-418: the discovery poll being interrupted mid-poll (daemon death / fs error) still invalidates a stale persisted session id from a prior launch — resumeInPlace() never resumes it", async () => {
  const previous = process.env.BUTCHR_WORKSPACES;
  const root = mkdtempSync(join(tmpdir(), "herd-418-"));
  process.env.BUTCHR_WORKSPACES = root;
  const home = mkdtempSync(join(tmpdir(), "claude-home-418-"));
  try {
    const key = encodeAgentKey({ resourceProvider: "jira-work", ruleId: "jira-work", resourceId: "FACTORY-909" });
    const cwd = workspaceDirFor(key);
    // A PRIOR launch of this same workspace discovered and persisted S1, and
    // its transcript is still on disk — exactly the precondition the
    // classification doc (docs/session-field-reload-classification.md)
    // names as the trigger for this whole trap.
    const staleId = "stale-session-from-a-prior-launch";
    const projectDir = join(home, ".claude", "projects", resolve(cwd).replace(/[^a-zA-Z0-9]/g, "-"));
    mkdirSync(projectDir, { recursive: true });
    const staleTranscript = join(projectDir, `${staleId}.jsonl`);
    writeFileSync(staleTranscript, "{}");
    // Firmly backdate it — `discoverClaudeSessionId` filters candidates by
    // `created >= launchStartedAt` (birthtime, falling back to mtime), and
    // relying on plain wall-clock ordering between this write and the
    // launch a few lines below risks the two landing in the same clock
    // tick, which would make this test's own fixture race exactly the
    // "picks the wrong, OLDER transcript" trap `discoverClaudeSessionId`'s
    // own doc comment names — not the ordering this test exists to check.
    const wellInThePast = new Date(Date.now() - 60_000);
    utimesSync(staleTranscript, wellInThePast, wellInThePast);
    persistDiscoveredSessionId(cwd, staleId);

    const f = fakeHerdr([]);
    // Throws ONLY on the discovery poll's own inter-attempt wait (its
    // distinctive `SESSION_DISCOVERY_POLL_MS` argument) — every OTHER
    // `this.wait` call in the launch path (e.g. drovr's own pane-readiness
    // polling, reached before this point) must keep resolving normally, or
    // the injected failure would land upstream of the launch succeeding at
    // all, rather than inside the discovery poll this test targets.
    // Interrupts the bounded discovery poll after its first (unsuccessful)
    // attempt, before it can ever reach the "poll completed, found nothing"
    // branch.
    const interruptedWait = async (ms: number) => {
      if (ms === SESSION_DISCOVERY_POLL_MS) throw new Error("simulated daemon death / fs error mid-poll");
    };
    const herd = new HerdrHerd(f.client, "http://x/mcp", interruptedWait, undefined, undefined, undefined, async () => ({ HOME: home }));
    const spec = { key, issuetype: "Task" as const, summary: "s", parent: null };

    await expect(herd.spawn(spec)).rejects.toThrow("simulated daemon death / fs error mid-poll");
    expect(f.started).toHaveLength(1); // the launch itself succeeded — only the POST-launch discovery poll was interrupted

    // The stale id must be GONE — never left behind because an interrupted
    // poll never reached the old "only invalidate on failure" branch.
    expect(workspaceSessionId(cwd)).toBeUndefined();

    const outcome = await herd.resumeInPlace(spec);
    expect(outcome).toBe("unresumable"); // never silently resumes S1's finished conversation
  } finally {
    if (previous === undefined) delete process.env.BUTCHR_WORKSPACES; else process.env.BUTCHR_WORKSPACES = previous;
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
