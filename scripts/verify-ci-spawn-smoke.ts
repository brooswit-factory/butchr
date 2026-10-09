/**
 * FACTORY-892 (4): the CI gate `scripts/verify-spawn-effort.ts` explicitly
 * says isn't approved for a live-Claude spawn — this one needs no Claude
 * account, no Codex account, and no network beyond the herdr socket
 * already running in CI (see .github/workflows/ci.yml, job
 * `spawn-smoke`). It starts a REAL agent, through a REAL herdr, with the
 * REAL kickoffFor()/spawnArgs() output this repo would actually send — the
 * one thing a unit test (which only inspects the array `spawnArgs()`
 * returns, never hands it to herdr) cannot catch: herdr's own
 * `agent.start` rejecting an argument it cannot shell-quote
 * (`invalid_agent_argument`), which is exactly how FACTORY-735/739 broke
 * every spawn in production. `kind: "claude"` runs whatever executable
 * named `claude` is on PATH — in CI that's the stub at
 * `scripts/ci-fixtures/claude` (installed to `/usr/local/bin/claude` by
 * the `spawn-smoke` job, see .github/workflows/ci.yml), never the real
 * Claude Code CLI — so this proves herdr ACCEPTED the real argv and
 * started a real process, not that a real agent session came up.
 *
 * Cleans up the pane and the scratch workspace afterward, even on failure.
 */
import { existsSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DrovrClient } from "@brooswit/drovr";
import { buildWorkspace, type SpawnSpec } from "../src/agents/workspace.js";
import { spawnArgs, controlCharStartArgs } from "../src/agents/argv.js";

// Not a real Jira issue key, so a live daemon's own reconcile loop (which
// only ever looks at real issue keys) can never adopt, nudge, or respawn it.
const THROWAWAY_KEY = "SPAWNSMOKE";

// FACTORY-891 review (PR #722): the thing that makes this assertion
// FALSIFIABLE. "a foreground process exists" is not — a pty-backed pane's
// own interactive shell already satisfies that, whether or not herdr ever
// spawned the stub. scripts/ci-fixtures/claude touches this exact path
// before it sleeps, so its presence proves THIS process ran — nothing
// weaker, and nothing that depends on how herdr reports a process's own
// name/argv[0] (a kernel/shell detail, see that stub's own doc comment).
const sentinelEnv = process.env.BUTCHR_CI_SPAWN_SMOKE_SENTINEL;
if (!sentinelEnv) throw new Error("BUTCHR_CI_SPAWN_SMOKE_SENTINEL must be set (see .github/workflows/ci.yml, job spawn-smoke)");
// Narrowed to a real `string` (not `string | undefined`) here, once — a
// conditional narrowing above would not survive capture by the closures
// below (pollForStubToRun, cleanup), so this const's own declared type does.
const SENTINEL: string = sentinelEnv;
if (existsSync(SENTINEL)) unlinkSync(SENTINEL); // defend against a stale file from a previous run on a reused runner

const socketPath = process.env.HERDR_SOCKET_PATH;
const herdr = new DrovrClient(socketPath ? { socketPath } : {});

const scratchRoot = mkdtempSync(join(tmpdir(), "butchr-ci-spawn-smoke-"));
let workspaceId: string | undefined;
let paneId: string | undefined;

/**
 * Polls for the sentinel file the stub touches before it sleeps (see
 * SENTINEL's own comment above for why that, and not "a foreground process
 * exists", is the actual proof). Logs `foreground_processes` on every poll
 * regardless of outcome — kept PERMANENTLY, not just on failure: it is the
 * diagnostic whoever debugs this job next will want, per FACTORY-891's
 * review.
 */
async function pollForStubToRun(pane: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await herdr.pane.processInfo({ pane_id: pane }).catch(() => undefined);
    const info = (r as { process_info?: { foreground_processes?: unknown[] } } | undefined)?.process_info;
    console.log("pane.processInfo foreground_processes:", JSON.stringify(info?.foreground_processes ?? null));
    if (existsSync(SENTINEL)) return true;
    await new Promise((res) => setTimeout(res, 500));
  }
  return false;
}

async function cleanup(): Promise<void> {
  if (paneId) await herdr.pane.close(paneId).catch((e) => console.error("cleanup: pane.close failed:", e));
  // Closing the pane above already tears down a workspace left with no
  // panes, so a "workspace not found" here just means cleanup already
  // happened — not a leak.
  if (workspaceId) {
    await herdr.workspace
      .close({ workspace_id: workspaceId })
      .catch((e) => {
        if (!(e instanceof Error && e.message.includes("workspace_not_found"))) console.error("cleanup: workspace.close failed:", e);
      });
  }
  rmSync(scratchRoot, { recursive: true, force: true });
  if (existsSync(SENTINEL)) unlinkSync(SENTINEL);
}

async function main(): Promise<void> {
  process.env.BUTCHR_WORKSPACES = scratchRoot;
  const spec: SpawnSpec = { key: THROWAWAY_KEY, issuetype: "task", summary: "CI spawn smoke test (scratch, not a real ticket)", parent: null };
  // The MCP URL is deliberately unreachable: this checks that herdr accepts
  // and starts the real argv, not whether the throwaway agent can actually
  // talk to a butchr daemon.
  const dir = buildWorkspace(spec, "http://127.0.0.1:1/mcp");
  const args = spawnArgs(spec, dir);
  console.log("spawnArgs():", JSON.stringify(args));

  // The exact regression check: FACTORY-735/739 put a literal "\n\n" into
  // args[0], which herdr rejects before ever trying to spawn anything. A
  // local assertion here (as opposed to only the unit tests) keeps this
  // script a true end-to-end check of "the real kickoff reaches herdr
  // clean", not just a smoke test of herdr spawning.
  const controlChars = controlCharStartArgs(args);
  if (controlChars.length > 0) throw new Error(`spawnArgs() produced control characters herdr would reject: ${JSON.stringify(controlChars)}`);

  const created = await herdr.workspace.create({ label: `ci-spawn-smoke-${THROWAWAY_KEY.toLowerCase()}`, cwd: dir });
  workspaceId = created.workspace.workspace_id;
  paneId = created.root_pane.pane_id;
  console.log(`herdr workspace ${workspaceId}, pane ${paneId}`);

  // This call is the actual regression surface: FACTORY-735/739 made this
  // reject with invalid_agent_argument for EVERY spawn in production. If it
  // throws here, this script fails loudly and CI goes red — the whole
  // point of FACTORY-892 step (4).
  await herdr.agent.start({ pane_id: paneId, name: `ci-spawn-smoke-${THROWAWAY_KEY.toLowerCase()}`, kind: "claude", args });

  const started = await pollForStubToRun(paneId, 15_000);
  if (!started) throw new Error(`agent.start accepted the argv, but the stub never touched its sentinel (${SENTINEL}) within 15s`);
  console.log("OK: herdr accepted the real kickoff argv and actually ran the stub");
}

main()
  .then(() => cleanup())
  .then(() => process.exit(0))
  .catch(async (e) => {
    console.error("FAILED:", e);
    await cleanup();
    process.exit(1);
  });
