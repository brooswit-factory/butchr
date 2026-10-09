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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DrovrClient } from "@brooswit/drovr";
import { buildWorkspace, type SpawnSpec } from "../src/agents/workspace.js";
import { spawnArgs, controlCharStartArgs } from "../src/agents/argv.js";

// Not a real Jira issue key, so a live daemon's own reconcile loop (which
// only ever looks at real issue keys) can never adopt, nudge, or respawn it.
const THROWAWAY_KEY = "SPAWNSMOKE";

const socketPath = process.env.HERDR_SOCKET_PATH;
const herdr = new DrovrClient(socketPath ? { socketPath } : {});

const scratchRoot = mkdtempSync(join(tmpdir(), "butchr-ci-spawn-smoke-"));
let workspaceId: string | undefined;
let paneId: string | undefined;

/**
 * Whether ANY foreground process is running in the pane — deliberately not
 * matched by name. The stub at scripts/ci-fixtures/claude is a shebang
 * script; whether herdr's pty reports its `comm`/`argv[0]` as "claude" or
 * as its interpreter is a kernel/shell detail this script has no need to
 * depend on. "a foreground process exists" is already the real claim this
 * script needs: herdr accepted the real kickoff argv AND actually spawned
 * something from it, not just that the RPC returned.
 */
async function pollForForegroundProcess(pane: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await herdr.pane.processInfo({ pane_id: pane }).catch(() => undefined);
    const info = (r as { process_info?: { foreground_processes?: Array<{ argv?: string[] | null; name?: string | null }> } } | undefined)?.process_info;
    if ((info?.foreground_processes?.length ?? 0) > 0) return true;
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

  const started = await pollForForegroundProcess(paneId, 15_000);
  if (!started) throw new Error("agent.start accepted the argv, but no foreground process ever reported as running within 15s");
  console.log("OK: herdr accepted the real kickoff argv and started a real process");
}

main()
  .then(() => cleanup())
  .then(() => process.exit(0))
  .catch(async (e) => {
    console.error("FAILED:", e);
    await cleanup();
    process.exit(1);
  });
