/**
 * Manual/operator check — NOT wired into `bun run check` (same reasoning as
 * its precedent, scripts/verify-spawn-effort.ts: it needs a real systemd
 * unit and a real journal to actually prove anything, which a CI sandbox
 * cannot promise).
 *
 * Builds a real workspace via this branch's own `buildWorkspace()` under a
 * scratch `BUTCHR_WORKSPACES` root, then checks the emitted ground truth
 * against the OS rather than against itself:
 *  - the emitted hostname must equal the OS's own `hostname` output,
 *  - if the process is under systemd, the EXACT emitted journalctl
 *    invocation is actually run and must return real entries — the
 *    strongest assertion available, because it proves the incantation
 *    works on this machine, not just that it round-trips a fixture,
 *  - if not under systemd, the emitted text must say so honestly.
 *
 * Cleans up its scratch dir in a finally. Never writes into
 * ~/butchr-workspaces and never touches the live daemon (systemd
 * butchr.service) — it never sends a request to a live mcpUrl, only parses
 * one it makes up.
 */
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildWorkspace, type SpawnSpec } from "../src/agents/workspace.js";

const scratchRoot = mkdtempSync(join(tmpdir(), "butchr-verify-ground-truth-"));

async function main(): Promise<void> {
  process.env.BUTCHR_WORKSPACES = scratchRoot;
  const spec: SpawnSpec = { key: "GROUNDTRUTHCHK", issuetype: "task", summary: "verify ground truth (scratch, not a real ticket)", parent: null };
  const dir = buildWorkspace(spec, "http://localhost:7719/mcp");
  console.log(`workspace: ${dir}`);

  const environment = readFileSync(join(dir, "ENVIRONMENT.md"), "utf8");
  console.log("ENVIRONMENT.md:\n" + environment);

  const osHostname = execSync("hostname", { encoding: "utf8" }).trim();
  if (!environment.includes(osHostname)) throw new Error(`emitted ground truth lacks the OS-reported hostname ${osHostname}`);
  console.log(`OK: emitted hostname matches \`hostname\` (${osHostname})`);

  if (!environment.includes("7719")) throw new Error("emitted ground truth lacks the port parsed from the mcpUrl (7719)");
  console.log("OK: emitted port matches the mcpUrl passed in (7719)");

  if (environment.includes("not running under a systemd unit")) {
    console.log("OK: not under systemd — emitted text says so honestly, no journal invocation to run");
    return;
  }

  const match = environment.match(/^- journalctl: (.+)$/m);
  if (!match) throw new Error(`could not find a journalctl line in emitted ground truth:\n${environment}`);
  const journalctlCommand = match[1]!;
  console.log(`running emitted invocation: ${journalctlCommand}`);
  const output = execSync(journalctlCommand, { encoding: "utf8" });
  if (output.includes("-- No entries --") || output.trim().length === 0) throw new Error(`emitted journalctl invocation returned no entries:\n${output}`);
  console.log(`OK: emitted journalctl invocation returns real entries (${output.trim().split("\n").length} lines)`);
}

main()
  .then(() => {
    rmSync(scratchRoot, { recursive: true, force: true });
    process.exit(0);
  })
  .catch((e) => {
    console.error("FAILED:", e);
    rmSync(scratchRoot, { recursive: true, force: true });
    process.exit(1);
  });
