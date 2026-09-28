/**
 * Manual/operator script (FACTORY-118) — NOT wired into `bun run check`,
 * same reasoning as its precedents (reap-dry-run.ts, verify-spawn-effort.ts):
 * it needs a real live herdr to know which workspaces are safe to touch
 * right now (Addendum A5 — never rename under a live agent).
 *
 * Walks THIS process's own `workspaceRoot()` for every
 * `<provider>/<ruleId>/<leaf>` directory, reads each one's bookkeeping
 * stamp (if any), asks a real herdr `agent.list()` which of those
 * directories currently have a live pane's cwd, and hands all of that to
 * `planWorkspaceMigration` (src/agents/workspace-migration.ts) — the pure,
 * exhaustively unit-tested decision function this script is a thin,
 * deliberately untested-by-unit-tests driver around (same split
 * reap-dry-run.ts uses for `strandedCandidates`).
 *
 * Default mode is DRY RUN: prints the plan, migrates nothing. Pass
 * `--execute` to actually call `migrateWorkspaceLayout` for every
 * `"migrate"` line. Pass `--include-claude-settings` to also run
 * `migrateClaudeSettingsEntry` for each one (see that function's own doc
 * comment for why this is opt-in, never automatic: it touches the ONE
 * `~/.claude.json` file shared by every Claude Code session on the host).
 *
 * OPERATOR RUNBOOK (see docs/workspace-layout.md's "Deploy runbook" section
 * for the full narrative version of this):
 *   1. Deploy the new butchr build. Nothing about a normal deploy or daemon
 *      restart migrates anything by itself — an unmigrated workspace stays
 *      fully recognised at its old path (`workspaceDirFor`'s own step 2)
 *      until something calls `migrateWorkspaceLayout` for it.
 *   2. `bun run scripts/migrate-workspace-layout.ts` (dry run) — review the
 *      printed plan. Every "skip-live" line names an agent still running;
 *      that is expected and not an error.
 *   3. `bun run scripts/migrate-workspace-layout.ts --execute` — migrates
 *      every "migrate" line. Safe to re-run: idempotent, never overwrites a
 *      non-empty target, and a line already "skip-live" or "no-change"
 *      stays a no-op.
 *   4. Once the agents skipped as live in step 3 have stopped or restarted
 *      on their own (a normal Butchr respawn already lands them in their
 *      OLD, still-recognised path — nothing forces this), re-run step 3 to
 *      pick up the rest. There is no time limit: an unmigrated workspace is
 *      never treated as stale or foreign.
 *   5. `--include-claude-settings` only once you are at a quiet moment for
 *      the whole host (FACTORY-83's own deploy discipline) — it is the one
 *      step with a (narrow, real) shared-file race with other concurrent
 *      Claude Code sessions.
 */
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DrovrClient } from "@brooswit/drovr";
import { readBookkeptAgentKey, workspaceRoot } from "../src/agents/workspace.js";
import { migrateClaudeSettingsEntry, migrateWorkspaceLayout, planWorkspaceMigration, type DiscoveredLeaf } from "../src/agents/workspace-migration.js";
import { RESOURCE_PROVIDERS } from "../src/rules/agent-key.js";

const execute = process.argv.includes("--execute");
const includeClaudeSettings = process.argv.includes("--include-claude-settings");

/** Every `<root>/<provider>/<ruleId>/<leaf>` directory currently on disk — a plain three-level walk, one provider/ruleId pair at a time so a permission error or race on one rule never aborts the rest. */
function discoverLeaves(root: string): DiscoveredLeaf[] {
  const out: DiscoveredLeaf[] = [];
  for (const provider of RESOURCE_PROVIDERS) {
    const providerDir = join(root, provider);
    let ruleIds: string[];
    try { ruleIds = readdirSync(providerDir); } catch { continue; }
    for (const ruleId of ruleIds) {
      const ruleDir = join(providerDir, ruleId);
      let leaves: string[];
      try { leaves = readdirSync(ruleDir); } catch { continue; }
      for (const leaf of leaves) {
        const leafDir = join(ruleDir, leaf);
        out.push({ provider, ruleId, leaf, stampedKey: readBookkeptAgentKey(leafDir) });
      }
    }
  }
  return out;
}

async function main() {
  const root = workspaceRoot();
  const herdr = new DrovrClient({});
  const { agents } = await herdr.agent.list();
  const livePaths = new Set(agents.map((a) => a.cwd).filter((c): c is string => !!c && existsSync(c)));
  console.log(`workspaceRoot: ${root}`);
  console.log(`live agent cwds observed: ${livePaths.size}`);

  const leaves = discoverLeaves(root);
  const plan = planWorkspaceMigration(root, leaves, livePaths);
  const counts = { migrate: 0, "no-change": 0, "skip-live": 0 };
  for (const item of plan) {
    counts[item.action]++;
    if (item.action === "no-change") continue; // nothing worth a line for the common, unaffected case
    console.log(`  [${item.action}] ${item.key}\n    ${item.oldDir}\n    -> ${item.newDir}`);
  }
  console.log(`plan: migrate=${counts.migrate} skip-live=${counts["skip-live"]} no-change=${counts["no-change"]}${execute ? "" : " (DRY RUN — nothing migrated)"}`);

  if (!execute) return;
  let migrated = 0, failed = 0;
  for (const item of plan) {
    if (item.action !== "migrate") continue;
    try {
      const result = migrateWorkspaceLayout(item.key, root);
      let settingsNote = "";
      if (includeClaudeSettings && result.oldDir) {
        const settings = migrateClaudeSettingsEntry(result.oldDir, result.newDir, join(homedir(), ".claude.json"));
        settingsNote = ` claudeSettings=${settings.outcome}`;
      }
      console.log(`  MIGRATED ${item.key}: ${result.outcome}, slug=${result.slug.outcome}${settingsNote}`);
      migrated++;
    } catch (e) {
      console.error(`  FAILED ${item.key}: ${(e as Error).message}`);
      failed++;
    }
  }
  console.log(`done: migrated=${migrated} failed=${failed}`);
  if (failed > 0) process.exit(1);
}

// Guarded (unlike this repo's own reap-dry-run.ts precedent) so importing
// this file — e.g. the generated load-test smoke check, `bun run
// scripts/load/generate.ts`, that merely proves every source file is
// importable — never itself connects to a real herdr as a side effect.
if (import.meta.main) main().catch((e) => { console.error("FAILED:", e); process.exit(1); });
