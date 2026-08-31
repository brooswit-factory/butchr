/**
 * Manual/operator check — NOT wired into `bun run check` (it needs a live
 * herdr and a real `claude` binary; a CI gate that spawns agents is not
 * something that gets approved here).
 *
 * Spawns one real, throwaway claude agent through this branch's own
 * spawnArgs()/buildWorkspace() path via a live herdr, reads back the
 * OS-reported argv of the resulting claude process (the same
 * `pane.processInfo` source herd.ts's staleness check uses), and asserts
 * `--effort high` is present. This checks the process that actually came
 * up, not the array spawnArgs() merely claims to return.
 *
 * Cleans up the pane and the scratch workspace afterward, even on failure.
 * Never touches ~/butchr-workspaces or the live butchr daemon (systemd
 * butchr.service) — it only asks herdr, over its own socket, to start one
 * extra pane.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HerdrClient } from "@brooswit/herdr-sdk";
import { buildWorkspace, type SpawnSpec } from "../src/agents/workspace.js";
import { spawnArgs } from "../src/agents/argv.js";

// Not a real Jira issue key, so the live daemon's reconcile loop (which
// only ever looks at real issue keys) can never adopt, nudge, or respawn it.
const THROWAWAY_KEY = "EFFORTCHK";

const socketPath = process.env.HERDR_SOCKET_PATH;
const herdr = new HerdrClient(socketPath ? { socketPath } : {});

const scratchRoot = mkdtempSync(join(tmpdir(), "butchr-verify-effort-"));
let workspaceId: string | undefined;
let paneId: string | undefined;

async function pollForArgv(pane: string, timeoutMs: number): Promise<string[] | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await herdr.pane.processInfo({ pane_id: pane }).catch(() => undefined);
    const info = (r as { process_info?: { foreground_processes?: Array<{ argv?: string[] | null; name?: string | null }> } } | undefined)
      ?.process_info;
    const proc = info?.foreground_processes?.find((p) => (p.argv?.[0] ?? p.name ?? "").replace(/\\/g, "/").split("/").pop() === "claude");
    if (proc?.argv) return proc.argv;
    await new Promise((res) => setTimeout(res, 1000));
  }
  return undefined;
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
  const spec: SpawnSpec = { key: THROWAWAY_KEY, issuetype: "task", summary: "verify --effort argv (scratch, not a real ticket)", parent: null };
  // The MCP URL is deliberately unreachable: this checks argv, not whether
  // the throwaway agent can actually talk to a butchr daemon.
  const dir = buildWorkspace(spec, "http://127.0.0.1:1/mcp");
  const args = spawnArgs(spec, dir);
  console.log("spawnArgs():", JSON.stringify(args));

  const created = await herdr.workspace.create({ label: `verify-effort-${THROWAWAY_KEY.toLowerCase()}`, cwd: dir });
  workspaceId = created.workspace.workspace_id;
  paneId = created.root_pane.pane_id;
  console.log(`herdr workspace ${workspaceId}, pane ${paneId}`);

  await herdr.agent.start({ pane_id: paneId, name: `verify-effort-${THROWAWAY_KEY.toLowerCase()}`, kind: "claude", args });

  const argv = await pollForArgv(paneId, 30_000);
  if (!argv) throw new Error("claude process never reported argv within 30s");
  console.log("observed argv:", JSON.stringify(argv));

  const i = argv.indexOf("--effort");
  if (i === -1 || argv[i + 1] !== "high") throw new Error(`observed argv lacks --effort high: ${JSON.stringify(argv)}`);
  console.log("OK: observed process argv carries --effort high");
}

main()
  .then(() => cleanup())
  .then(() => process.exit(0))
  .catch(async (e) => {
    console.error("FAILED:", e);
    await cleanup();
    process.exit(1);
  });
