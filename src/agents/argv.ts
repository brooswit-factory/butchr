import { modelFor, type SpawnSpec } from "./workspace.js";

/**
 * The exact argv butchr spawns a claude agent with, for `spec` running in
 * `dir`. The ONE place this array is built — HerdrHerd.spawn() and the
 * staleness check both call it, so they cannot drift apart.
 *
 * The kickoff positional MUST stay first: --dangerously-load-development-channels
 * (and --mcp-config) are variadic and swallow a trailing positional as one of
 * their own entries (CHANGELOG 0.5.6).
 */
export function spawnArgs(spec: SpawnSpec, dir: string): string[] {
  return [
    "follow your CLAUDE.md",
    "--model", modelFor(spec.issuetype),
    "--permission-mode", "bypassPermissions",
    "--mcp-config", dir + "/mcp.json",
    "--dangerously-load-development-channels", "server:butchr",
  ];
}

export type ArgvCheck = { ok: true } | { ok: false; reason: string };

/**
 * Flags that must survive a herdr restore verbatim. `--model` and the
 * kickoff positional are startup-only and deliberately excluded: a
 * `modelFor()` change on deploy must not churn the whole fleet.
 */
const REQUIRED_FLAGS = ["--permission-mode", "--mcp-config", "--dangerously-load-development-channels"] as const;

function flagValue(argv: readonly string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

/**
 * Pure argv health check: does `observed` (a claude process's real argv, or
 * just its flags) carry the same butchr-owned flags as `expected` (built by
 * `spawnArgs`)? Missing/mismatched flags are named in `reason`, in
 * `REQUIRED_FLAGS` order, exactly as they'd appear on the command line —
 * that string doubles as the daemon's `[reconcile]` log line and the
 * `[butchr:respawn]` ticket notice.
 */
export function checkArgv(expected: readonly string[], observed: readonly string[]): ArgvCheck {
  const missing: string[] = [];
  for (const flag of REQUIRED_FLAGS) {
    const want = flagValue(expected, flag);
    if (want === undefined) continue; // spawnArgs always sets these; nothing to compare against
    if (flagValue(observed, flag) !== want) missing.push(`${flag} ${want}`);
  }
  return missing.length ? { ok: false, reason: `argv lacks ${missing.join(", ")}` } : { ok: true };
}
