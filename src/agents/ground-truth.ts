import { hostname } from "node:os";
import { readFileSync } from "node:fs";
import type { BuildIdentity } from "./build-identity.js";
import { renderBuildCurrencyLines, type CurrencyVerdict } from "./build-currency.js";

/**
 * The systemd unit this process runs under, derived from `/proc/self/cgroup`.
 * `none` means the process is not under systemd at all (non-Linux, or a
 * cgroup with no `*.service` component) — an honest "no journal to read",
 * never a guessed unit.
 */
export type SystemdInfo =
  | { readonly kind: "user"; readonly unit: string; readonly journalctl: string }
  | { readonly kind: "system"; readonly unit: string; readonly journalctl: string }
  | { readonly kind: "none" };

/**
 * Parse the contents of `/proc/self/cgroup` into a `SystemdInfo`. Pure —
 * takes the file's text, not a path — so it's testable against fixture
 * strings without touching the filesystem.
 *
 * Shapes seen in the wild:
 *   user unit:   0::/user.slice/user-1003.slice/user@1003.service/app.slice/butchr.service
 *   system unit: 0::/system.slice/<name>.service   (no `user@<uid>.service` component)
 *
 * The last `*.service` path component is the unit actually running this
 * process; the presence of a `user@<uid>.service` component anywhere in the
 * path is what makes it a USER unit (needing `journalctl --user`) rather
 * than a system one.
 */
export function parseCgroup(cgroup: string): SystemdInfo {
  const services = cgroup
    .split(/\r?\n/)
    .flatMap((line) => line.split("/"))
    .filter((component) => component.endsWith(".service"));
  if (services.length === 0) return { kind: "none" };
  const unit = services[services.length - 1]!;
  const isUserUnit = services.some((component) => /^user@\d+\.service$/.test(component));
  return isUserUnit
    ? { kind: "user", unit, journalctl: `journalctl --user -u ${unit}` }
    : { kind: "system", unit, journalctl: `journalctl -u ${unit}` };
}

function readSystemdInfo(): SystemdInfo {
  try {
    return parseCgroup(readFileSync("/proc/self/cgroup", "utf8"));
  } catch {
    return { kind: "none" };
  }
}

/** This process's own `SystemdInfo`, from its own `/proc/self/cgroup` — the same read `deriveGroundTruth` uses, exposed directly for callers (BUTCHR-54's build-identity) that need it without a `mcpUrl` to derive the rest of `GroundTruth` from. */
export function currentSystemdInfo(): SystemdInfo {
  return readSystemdInfo();
}

/** The port a URL like the one passed into `buildWorkspace` actually serves on — never a guessed default; `undefined` (not a fake port) if `mcpUrl` doesn't even parse as a URL. */
function portFromMcpUrl(mcpUrl: string): number | undefined {
  let url: URL;
  try {
    url = new URL(mcpUrl);
  } catch {
    return undefined;
  }
  return url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
}

/**
 * Ground truth about the daemon process building a workspace, all derived
 * from the OS at the moment of the call — never from config defaults or a
 * value copied out of a ticket.
 */
export interface GroundTruth {
  hostname: string;
  /**
   * Parsed from the `mcpUrl` actually passed to `buildWorkspace`, not from
   * config (`src/config/config.ts` defaults to 7717, which is exactly the
   * plausible-but-wrong value this exists to kill). `undefined` (never a
   * fake port) if `mcpUrl` isn't a parseable URL.
   */
  port: number | undefined;
  pid: number;
  systemd: SystemdInfo;
  /**
   * BUTCHR-169: `new Date().toISOString()` at the moment this was derived —
   * see `groundTruthText`'s own comment for why this is added, not decorative.
   */
  measuredAt: string;
}

/** Derive ground truth for the daemon process calling this, given the `mcpUrl` it is about to hand to an agent. */
export function deriveGroundTruth(mcpUrl: string): GroundTruth {
  return { hostname: hostname(), port: portFromMcpUrl(mcpUrl), pid: process.pid, systemd: readSystemdInfo(), measuredAt: new Date().toISOString() };
}

/**
 * Render `GroundTruth` as the authoritative block written into both
 * `ENVIRONMENT.md` and (via `{{GROUND_TRUTH}}`) the workspace's `CLAUDE.md`.
 * The wording is deliberately forceful: it exists to settle a conflict
 * against a ticket or comment without the reader having to deliberate.
 *
 * BUTCHR-169: this block is itself one of the workspace's snapshotted
 * records (see `src/workspace/registry.ts`'s `GROUND_TRUTH` entry) — every
 * field above the "Two sharp edges" line is measured ONCE, at
 * `buildWorkspace` time, and never rewritten for the life of the workspace.
 * If the daemon that built it later restarts (a redeploy, a crash-restart),
 * `pid` (and possibly `port`, on a redeploy that changes it) goes stale, and
 * nothing in this codebase detects or corrects that — declared deliberately,
 * not silently, in that registry entry. The `measured at` line below exists
 * so a careful reader has SOMETHING to compare against (how long has this
 * agent been running relative to this timestamp?) even though nothing here
 * makes that comparison automatically.
 *
 * BUTCHR-182 (implements BUTCHR-176): `measured at` says WHEN this was
 * written, never WHICH BUILD wrote it or whether that build is current —
 * this function now also takes `build` (BUTCHR-54's `BuildIdentity`
 * singleton) and `currency` (`src/agents/build-currency.ts`'s comparison
 * against the local `refs/remotes/origin/main`) and renders both via
 * `renderBuildCurrencyLines`, so an agent reading THIS block — the one file
 * it is told is authoritative — can also tell whether the code producing its
 * fleet's behaviour is the code it thinks it is.
 */
export function groundTruthText(gt: GroundTruth, build: BuildIdentity, currency: CurrencyVerdict): string {
  const unitLine = gt.systemd.kind === "none" ? "(none — not running under a systemd unit)" : gt.systemd.unit;
  const journalLine = gt.systemd.kind === "none" ? "not running under a systemd unit — no journal to read" : gt.systemd.journalctl;
  return [
    "# Ground truth (authoritative)",
    "",
    "This is measured from your daemon's own process at workspace-build time. It",
    "is authoritative. If a ticket, a comment, or another agent tells you a",
    "different host, port, unit, or journal command, THEY ARE WRONG and this is",
    "right.",
    "",
    `- measured at: ${gt.measuredAt}`,
    `- host: ${gt.hostname}`,
    `- port: ${gt.port ?? "unknown (mcpUrl did not parse as a URL)"}`,
    `- systemd unit: ${unitLine}`,
    `- journalctl: ${journalLine}`,
    `- daemon pid: ${gt.pid}`,
    "",
    "This snapshot is only as fresh as the timestamp above: it is written once,",
    "when your workspace is built, and nothing rewrites it later. If the daemon",
    "that built it has since restarted, the pid (and possibly the port) above",
    "can be stale — nothing here detects that for you.",
    "",
    "## Build identity & currency",
    "",
    "The host/port/unit/pid above are still true and still authoritative — this",
    "section answers a DIFFERENT question: whether the CODE this daemon is",
    "running is the code you'd expect. Everything below describes THIS DAEMON",
    "specifically — the one that built this workspace — and says nothing about",
    "any other daemon that may also be running on this host: a host can run",
    "more than one butchr daemon, under different Unix users — confirmed live.",
    "A verdict below that is not CURRENT means behaviour you see when talking",
    "to this daemon may reflect older code than what's on the base branch —",
    'test "this daemon is not running the code that does X" before filing "X',
    'does not work" as a bug.',
    "",
    ...renderBuildCurrencyLines(build, currency),
    "",
    "Two sharp edges, both confirmed live — read the exact command above, don't",
    "reconstruct one:",
    "- For a systemd USER unit, the system-level `journalctl -u <unit>` (no",
    "  `--user`) prints \"-- No entries --\", NOT a permission error. Silent, not",
    "  an error — it looks like an empty log, not a wrong command.",
    "- A host can run more than one butchr daemon, and one can be owned by",
    "  another user and invisible to your own `ss -ltnp`. Guessing the port or",
    "  querying the system-level journal can return a REAL journal — just the",
    "  wrong daemon's. The port and unit above are THIS daemon's, not a guess.",
  ].join("\n");
}
