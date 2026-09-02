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
 * BUTCHR-182 (implements BUTCHR-176): also asserts the build/currency
 * section this ticket adds — real, from THIS run's own git state, not a
 * fixture. Whatever verdict this checkout actually produces (current, stale,
 * diverged, or unknown) is fine; what would make this FAIL is: the section
 * being silently absent (never-throws must not become never-says), a
 * `current` verdict rendered without the base's own freshness (Requirement
 * 2 — the ticket's own bug, one level down, inside its own fix), or an
 * `unknown` verdict whose text contains the literal word `CURRENT` (the
 * un-collapsibility guarantee).
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

  if (!environment.includes("## Build identity & currency")) throw new Error(`emitted ground truth lacks the build/currency section entirely — never-throws must not become never-says:\n${environment}`);
  const currencyLine = environment.match(/^- currency: (CURRENT|STALE|DIVERGED|UNKNOWN).*$/m);
  if (!currencyLine) throw new Error(`emitted ground truth has a build/currency heading but no recognizable "- currency: ..." line:\n${environment}`);
  console.log(`OK: build/currency section present, verdict line: ${currencyLine[0]}`);

  if (currencyLine[1] === "CURRENT") {
    // Requirement 2: current may never render without the base's own
    // freshness — an undeterminable freshness must have produced `unknown`
    // instead, never reached this branch.
    if (!/comparison base: .*last updated \S+/.test(environment)) {
      throw new Error(`verdict is CURRENT but the base's own freshness is not rendered (Requirement 2 — a false CURRENT is this ticket's own bug, one level down):\n${environment}`);
    }
    console.log("OK: CURRENT verdict carries the comparison base's own freshness (Requirement 2)");
  }

  if (currencyLine[1] === "UNKNOWN" && environment.includes("- currency: CURRENT")) {
    throw new Error(`verdict is UNKNOWN but the text ALSO contains a CURRENT currency line — unknown must never be collapsible to current:\n${environment}`);
  }

  if (!environment.includes("this daemon")) throw new Error(`build/currency section does not speak in the first person about THIS daemon (Requirement 3):\n${environment}`);
  console.log("OK: build/currency section speaks in the first person about this daemon (Requirement 3)");

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
