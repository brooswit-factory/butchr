/**
 * Manual/operator script (BUTCHR-245) — NOT wired into `bun run check`, same
 * reasoning as its precedents (verify-workspace-ground-truth.ts,
 * verify-spawn-effort.ts): it needs a real live herdr to prove anything.
 *
 * Runs this branch's own decision path (`strandedCandidates` + the
 * `HerdrHerd.closeStranded` live-process verdict, reap.ts/herd.ts) against
 * whatever herdr this process's own `herdr` CLI/socket resolves to — i.e.
 * THIS agent's own herd, never a value copied from a ticket. Prints, for
 * every candidate the pure ownership join finds, its workspace id, label,
 * panes, each pane's cwd, and the live-process verdict that decides whether
 * it would be reaped.
 *
 * Default mode is DRY RUN: closes nothing, ever. Pass `--execute` to
 * actually close every candidate whose verdict is "dead" — never run that
 * flag before the dry-run output has been cross-checked and posted.
 */
import { HerdrClient } from "@brooswit/herdr-sdk";
import { strandedCandidates } from "../src/agents/reap.js";
import { workspaceRoot } from "../src/agents/workspace.js";
import { HerdrHerd } from "../src/agents/herd.js";

const execute = process.argv.includes("--execute");
const herdr = new HerdrClient({});
const herd = new HerdrHerd(herdr, "http://localhost:0/mcp"); // mcpUrl unused by strandedCandidates/closeStranded

async function main() {
  const root = workspaceRoot();
  const [{ workspaces }, { panes }, { agents }] = await Promise.all([
    herdr.workspace.list(),
    herdr.pane.list(),
    herdr.agent.list(),
  ]);
  console.log(`workspaceRoot: ${root}`);
  console.log(`workspaces=${workspaces.length} panes=${panes.length} agents=${agents.length}`);

  const candidates = strandedCandidates(workspaces, panes, agents, root);
  console.log(`candidates (owned + agentless): ${candidates.length}`);

  const panesById = new Map(panes.map((p) => [p.pane_id, p]));
  let dead = 0, live = 0, unknown = 0;
  for (const c of candidates) {
    const cwds = c.paneIds.map((id) => panesById.get(id)?.cwd ?? "?");
    // probeVerdict makes the SAME processInfo calls HerdrHerd.closeStranded()
    // would make, purely to print the verdict — never to decide the close.
    // The actual close (--execute only) goes back through closeStranded()
    // itself, so the real safety layer is the one exercised, not a copy of it.
    const verdict = await probeVerdict(herdr, c.paneIds);
    const didClose = execute && verdict === "dead" && await herd.closeStranded(c);
    if (verdict === "dead") dead++;
    else if (verdict === "live") live++;
    else unknown++;
    console.log(`  ${c.workspaceId}\t${c.label}\tpanes=[${c.paneIds.join(",")}]\tcwd=[${cwds.join(",")}]\tverdict=${verdict}${didClose ? " CLOSED" : ""}`);
  }
  console.log(`verdicts: dead=${dead} live=${live} unknown=${unknown}${execute ? ` (closed=${dead})` : " (DRY RUN — nothing closed)"}`);
}

/** Mirrors HerdrHerd's private paneVerdict/workspaceVerdict exactly, for dry-run printing only (no close). */
async function probeVerdict(herdr: HerdrClient, paneIds: readonly string[]): Promise<"live" | "dead" | "unknown"> {
  if (!paneIds.length) return "unknown";
  let allDead = true;
  for (const paneId of paneIds) {
    let info: { foreground_processes?: Array<{ argv?: string[] | null; name?: string | null }> } | undefined;
    try {
      info = (await herdr.pane.processInfo({ pane_id: paneId }) as { process_info?: typeof info }).process_info;
    } catch {
      allDead = false;
      continue;
    }
    const procs = info?.foreground_processes;
    if (!procs || procs.length === 0) { allDead = false; continue; }
    const isClaude = procs.some((p) => {
      const base = (s: string) => s.replace(/\\/g, "/").split("/").pop() ?? s;
      return base(p.argv?.[0] ?? "") === "claude" || base(p.name ?? "") === "claude";
    });
    if (isClaude) return "live";
  }
  return allDead ? "dead" : "unknown";
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
