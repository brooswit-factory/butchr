/**
 * local/ui — the Status page's wording, as pure functions of `/health`
 * (`src/daemon/health.ts`): how long butchr has been up, which build it runs,
 * how that build compares with upstream, and its loops in plain words.
 */
import type { BuildReport } from "../../../src/agents/build-identity.js";
import type { CurrencyReport } from "../../../src/daemon/currency.js";
import type { ComponentHealth, ResourceLoopReport } from "../../../src/daemon/health.js";
import type { AdmissionSnapshot } from "../../../src/agents/admission.js";

/** A rough duration: "under a minute", "12 min", "3 h 5 min", "2 days 4 h". */
export function durationText(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"}${hours % 24 ? ` ${hours % 24} h` : ""}`;
}

/** "up 3 h 5 min", or `null` when the start time doesn't parse. */
export function uptimeText(startedAt: string, now: number): string | null {
  const started = Date.parse(startedAt);
  return Number.isFinite(started) ? `up ${durationText(now - started)}` : null;
}

/** The running build: its short sha, saying so when it has uncommitted changes or no known sha. */
export function buildText(build: Pick<BuildReport, "sha" | "shaDirty" | "shaUnknownReason">): string {
  if (!build.sha) return `unknown${build.shaUnknownReason ? ` (${build.shaUnknownReason})` : ""}`;
  return `${build.sha.slice(0, 8)}${build.shaDirty ? ", with uncommitted changes" : ""}`;
}

const baseName = (ref: string): string => ref.replace(/^refs\/remotes\//, "").replace(/^refs\/heads\//, "");

/**
 * How the running build compares with the upstream branch butchr tracks. A
 * build that's only ahead is our own work on top of it; "behind" is said only
 * when it's ahead by exactly 0 (`CurrencyVerdict`'s own rule).
 */
export function upstreamText(currency: CurrencyReport | undefined): string | null {
  if (!currency) return null;
  const v = currency.verdict;
  if (v.status === "unknown") return `can't compare with upstream: ${v.reason}`;
  const base = baseName(v.base.ref);
  if (v.status === "current") return `up to date with ${base}`;
  const { commitsAhead: ahead, commitsBehind: behind } = v;
  const plural = (n: number) => `${n} commit${n === 1 ? "" : "s"}`;
  if (ahead === 0 && behind !== null) return `${plural(behind)} behind ${base}`;
  if (behind === 0 && ahead !== null) return `${plural(ahead)} ahead of ${base}`;
  if (ahead !== null && behind !== null) return `${plural(ahead)} ahead of and ${plural(behind)} behind ${base}`;
  return `differs from ${base}`;
}

/** The agent count `/health` carries: "1 of 8 slots in use", sentinels added when there are any. */
export function agentsText(a: Pick<AdmissionSnapshot, "cap" | "residency" | "sentinels">): string {
  if (a.residency === null) return `not counted yet, cap ${a.cap}`;
  const sentinels = a.sentinels ? `, plus ${a.sentinels} sentinel${a.sentinels === 1 ? "" : "s"}` : "";
  return `${a.residency} of ${a.cap} slots in use${sentinels}`;
}

const COMPONENT_LABELS: Readonly<Record<string, string>> = {
  pollLoop: "Ticket poll",
  notify: "Notifications",
  permissionAnswer: "Permission answers",
};

/** A liveness component's name in words; one butchr adds later keeps its own name. */
export function componentLabel(name: string): string {
  return COMPONENT_LABELS[name] ?? name;
}

export function componentStateText(c: Pick<ComponentHealth, "state" | "staleForMs">): string {
  if (c.state === "ok") return "ok";
  if (c.state === "starting") return "starting";
  return `stale for ${durationText(c.staleForMs)}`;
}

export interface LoopSummary {
  /** Loops with rules to run, in `/health`'s order. */
  running: { name: string; ok: boolean; text: string }[];
  /** Loops that run nothing, with why. */
  off: { name: string; reason: string }[];
}

/** Each rule-provider loop as running (with how it's doing) or off (with why). */
export function loopSummary(loops: readonly ResourceLoopReport[] | undefined): LoopSummary {
  const running: LoopSummary["running"] = [];
  const off: LoopSummary["off"] = [];
  for (const l of loops ?? []) {
    if (!l.enabled) {
      off.push({ name: l.name, reason: l.disabledReason ?? "off" });
      continue;
    }
    const text = l.lastError && l.consecutiveFailures > 0
      ? `failing (${l.consecutiveFailures} in a row): ${l.lastError.message}`
      : componentStateText(l);
    running.push({ name: l.name, ok: l.ok, text });
  }
  return { running, off };
}
