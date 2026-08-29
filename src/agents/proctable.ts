import { readdirSync, readFileSync, readlinkSync } from "node:fs";

/** One process's identity, as far as staleness detection needs it. */
export interface ProcessEntry {
  pid: number;
  ppid: number;
  cwd: string;
  argv: string[];
}

const basename = (p: string): string => p.replace(/\\/g, "/").split("/").pop() ?? p;
const isClaude = (p: ProcessEntry): boolean => basename(p.argv[0] ?? "") === "claude";

/**
 * Pick the claude process running an agent's workspace, given its `cwd`
 * (== the dir spawn built it in) and a snapshot of the process table.
 * Returns null when none is found — that is UNKNOWN, not stale: a just-spawned
 * pane whose shell hasn't exec'd claude yet, or a claude that already exited,
 * must be left alone (a fresh respawn must never itself be respawned every
 * poll — the 7-leaked-workspaces-in-2-minutes shape, CHANGELOG 0.5.6).
 */
export function selectClaudeProcess(cwd: string, table: readonly ProcessEntry[]): ProcessEntry | null {
  // claude's own children (the Bash tool, MCP servers) share its cwd but are
  // never claude processes themselves — filtering on basename(argv[0]) keeps
  // them out, while tolerating a bun/node wrapper in front of the real binary.
  const candidates = table.filter((p) => p.cwd === cwd && isClaude(p));
  if (candidates.length <= 1) return candidates[0] ?? null;
  const byPid = new Map(table.map((p) => [p.pid, p]));
  // Two claude processes sharing a cwd: take the one whose parent is NOT
  // itself a claude process (the outermost one), not an arbitrary match.
  const outermost = candidates.find((p) => {
    const parent = byPid.get(p.ppid);
    return !parent || !isClaude(parent);
  });
  return outermost ?? candidates[0]!;
}

/**
 * Read {pid, ppid, cwd, argv} for every process this user can see by walking
 * /proc. Entries owned by another user (EACCES) — or that vanish mid-walk
 * (ESRCH/ENOENT) — are skipped SILENTLY: several butchr daemons for
 * different users can share a host, each only able to read its own agents.
 */
export async function realProcessTable(): Promise<ProcessEntry[]> {
  const out: ProcessEntry[] = [];
  let pids: string[];
  try {
    pids = readdirSync("/proc").filter((p) => /^\d+$/.test(p));
  } catch {
    return out;
  }
  for (const pid of pids) {
    try {
      const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8");
      const argv = cmdline.split("\0").filter((s) => s.length);
      if (!argv.length) continue; // kernel threads and the like carry no argv
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const afterComm = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const ppid = Number(afterComm[1]);
      const cwd = readlinkSync(`/proc/${pid}/cwd`);
      out.push({ pid: Number(pid), ppid, cwd, argv });
    } catch {
      continue;
    }
  }
  return out;
}
