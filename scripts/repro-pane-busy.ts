/**
 * Manual/operator script (BUTCHR-268) — NOT wired into `bun run check`, same
 * reasoning as its precedents (verify-workspace-ground-truth.ts,
 * verify-spawn-effort.ts, reap-dry-run.ts): it needs a real live herdr to
 * prove anything, and a CI gate that hammers herdr with throwaway
 * workspaces is not something that gets approved here.
 *
 * Reproduces the create-then-start readiness race directly against
 * `HerdrClient` — `workspace.create` → (optional gap) → `agent.start` with
 * `args: ["--version"]` (exits immediately; the point is only whether
 * `agent.start` gets past herdr's "available shell" precondition, never to
 * start a real agent) → close. Only an `agent_pane_busy`-coded HerdrError
 * counts as a reproduction; a timeout (`isTimeout`) or any other rejection
 * is reported separately — see BUTCHR-268's ticket, "Distinguish the two
 * failure shapes."
 *
 * HARNESS HYGIENE (BUTCHR-268 DoD item 7): this harness's own leftover
 * workspaces were found, on the herd this task actually runs on, to be the
 * single largest consumer of that herd's pane pool — because an agent
 * killed mid-run (e.g. a herdr-server restart and respawn wave) never
 * reaches a `finally`. So cleanup happens BOTH at startup (sweepResidue(),
 * called first thing in main() — catches every prior run's leak regardless
 * of how it died) AND at the end of a normal run (also sweepResidue(), plus
 * each trial's own per-pane close). Every candidate is verified against a
 * fresh `agent.list()` before being closed, so a real agent is never
 * closed — this predicate is independent of, and does not touch,
 * BUTCHR-111's reap.ts ownership predicate (pane cwd under the workspace
 * root): this harness's panes sit at a scratch cwd OUTSIDE that root by
 * design, which is exactly why that reaper cannot and must not be the one
 * cleaning these up.
 *
 * Usage:
 *   bun run scripts/repro-pane-busy.ts sweep
 *     Reclaim-only: sweep residue, report before/after counts, exit. Run
 *     this alone first on a herd you suspect has a backlog.
 *
 *   bun run scripts/repro-pane-busy.ts gaps [--trials=8] [--gaps=0,50,150,300,600,1200]
 *     The rate-table reproduction: N trials at each gap value, sequential,
 *     one at a time. Default gaps/trials match BUTCHR-268's own table.
 *
 *   bun run scripts/repro-pane-busy.ts concurrency [--trials=5] [--levels=1,2,3]
 *     N simultaneous create+start pairs at gap 0, for each level.
 *
 *   bun run scripts/repro-pane-busy.ts fixed [--trials=8]
 *     DoD item 4's "after" measurement: replays `HerdrHerd`'s OWN
 *     readiness-wait-and-retry (src/agents/herd.ts's `startWithReadinessRetry`,
 *     same exported constants, not a copy) at gap=0 — the worst case the
 *     `gaps` rate table found. The direct counterpart to `gaps`' own
 *     `gap=0ms` row: run both, same trial count, and diff the busy ratios.
 *
 * Every run sweeps residue first (positive control included — see
 * `positiveControl()`) and again at the end, and prints created-vs-closed
 * as a ratio, never a bare "cleaned up".
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HerdrClient, HerdrError, isTimeout } from "@brooswit/herdr-sdk";
import { PANE_READY_WAIT_MS, PANE_BUSY_MAX_RETRIES } from "../src/agents/herd.js";

// Label prefixes this ticket's harness runs (this session's and prior ones)
// are known to have used. Deliberately scoped to BUTCHR-268's own
// conventions, per the ticket: "sweep by your own label prefixes... I do
// not want you guessing at anything outside them."
const RESIDUE_LABEL_PREFIXES = ["repro-268", "err-check", "repro"];
const HARNESS_LABEL_PREFIX = "repro-268";

const herdr = new HerdrClient({});

/**
 * "A herd you cannot see returns a confident zero, not an error." Confirm
 * THIS agent's own agent appears in THIS herdr's agent.list before trusting
 * any count this script reports. Aborts loudly rather than silently
 * reporting zeros for a herd this process cannot actually see.
 */
async function positiveControl(): Promise<void> {
  const key = process.env.BUTCHR_TICKET_KEY?.toLowerCase();
  const { agents } = await herdr.agent.list();
  console.log(`positive control: agent.list returned ${agents.length} agent(s)`);
  if (agents.length === 0) {
    throw new Error(
      "positive control FAILED: agent.list returned zero agents — this is either an idle herd " +
        "(unlikely if you're reading this from an agent pane) or this process cannot see the herd " +
        "it thinks it's talking to. Do not trust any count below until this passes.",
    );
  }
  if (key) {
    const mine = agents.some((a) => (a.name ?? "").toLowerCase().includes(key));
    console.log(`positive control: own agent (${key}) ${mine ? "FOUND" : "NOT FOUND"} in agent.list`);
  }
}

async function liveWorkspaceIds(): Promise<Set<string>> {
  const { agents } = await herdr.agent.list();
  return new Set(agents.map((a) => a.workspace_id));
}

interface SweepReport {
  candidates: number;
  closed: number;
  skippedLive: number;
  failed: number;
}

/**
 * Reclaims this harness's own residue by label, verifying every candidate
 * against a FRESH live-agent list before closing it — a real agent is never
 * closed. Never touches a workspace whose label doesn't match
 * RESIDUE_LABEL_PREFIXES (never guesses outside this harness's own
 * conventions).
 */
async function sweepResidue(): Promise<SweepReport> {
  const [{ workspaces }, live] = await Promise.all([herdr.workspace.list(), liveWorkspaceIds()]);
  const candidates = workspaces.filter((w) => RESIDUE_LABEL_PREFIXES.some((p) => w.label.startsWith(p)));
  let closed = 0;
  let skippedLive = 0;
  let failed = 0;
  for (const w of candidates) {
    if (live.has(w.workspace_id)) {
      skippedLive++;
      continue;
    }
    try {
      await herdr.workspace.close({ workspace_id: w.workspace_id });
      closed++;
    } catch (e) {
      failed++;
      console.error(`sweep: failed to close ${w.workspace_id} (label=${w.label}):`, e);
    }
  }
  return { candidates: candidates.length, closed, skippedLive, failed };
}

function reportSweep(when: string, r: SweepReport): void {
  console.log(
    `sweep (${when}): candidates=${r.candidates} closed=${r.closed} skippedLive=${r.skippedLive} failed=${r.failed}`,
  );
}

type TrialOutcome = "ok" | "busy" | "timeout" | "error";

/** One create -> (gap) -> start -> close cycle. Never leaves a pane open, even on failure. */
async function runOneTrial(cwd: string, label: string, gapMs: number): Promise<TrialOutcome> {
  const created = await herdr.workspace.create({ label, cwd });
  const rp = (created as { root_pane?: unknown }).root_pane;
  const paneId = typeof rp === "string" ? rp : (rp as { pane_id?: string })?.pane_id;
  if (!paneId) throw new Error(`workspace.create for ${label} returned no root pane`);
  try {
    if (gapMs > 0) await new Promise((res) => setTimeout(res, gapMs));
    await herdr.agent.start({ pane_id: paneId, name: label, kind: "claude", args: ["--version"] });
    return "ok";
  } catch (e) {
    if (e instanceof HerdrError && e.code === "agent_pane_busy") return "busy";
    if (isTimeout(e)) return "timeout";
    console.error(`trial ${label} (gap=${gapMs}ms) non-busy error:`, e);
    return "error";
  } finally {
    await herdr.pane.close(paneId).catch(() => {});
  }
}

/**
 * The "after" side of DoD item 4's before/after ratio: same create -> start
 * -> close shape as `runOneTrial`, but replaying `HerdrHerd`'s OWN fix
 * (`startWithReadinessRetry` in src/agents/herd.ts) — same constants,
 * imported from there rather than copied, so this can't silently drift from
 * what actually ships. Always at gap=0 (the worst case the rate table
 * found): a wait before every attempt, retried only on `agent_pane_busy`, up
 * to `PANE_BUSY_MAX_RETRIES` times. An outcome of "busy" here means the fix
 * did not save the attempt within its own retry budget — a real, reportable
 * miss, not a harness bug.
 */
async function runFixedTrial(cwd: string, label: string): Promise<TrialOutcome> {
  const created = await herdr.workspace.create({ label, cwd });
  const rp = (created as { root_pane?: unknown }).root_pane;
  const paneId = typeof rp === "string" ? rp : (rp as { pane_id?: string })?.pane_id;
  if (!paneId) throw new Error(`workspace.create for ${label} returned no root pane`);
  try {
    for (let attempt = 0; ; attempt++) {
      await new Promise((res) => setTimeout(res, PANE_READY_WAIT_MS));
      try {
        await herdr.agent.start({ pane_id: paneId, name: label, kind: "claude", args: ["--version"] });
        return "ok";
      } catch (e) {
        const busy = e instanceof HerdrError && e.code === "agent_pane_busy";
        if (busy && attempt < PANE_BUSY_MAX_RETRIES) continue;
        if (busy) return "busy";
        if (isTimeout(e)) return "timeout";
        console.error(`fixed-trial ${label} non-busy error:`, e);
        return "error";
      }
    }
  } finally {
    await herdr.pane.close(paneId).catch(() => {});
  }
}

interface RateRow {
  label: string;
  attempts: number;
  busy: number;
  timeout: number;
  error: number;
  ok: number;
}

function printRow(r: RateRow): void {
  console.log(
    `${r.label}\tattempts=${r.attempts}\tagent_pane_busy=${r.busy}/${r.attempts}\ttimeout=${r.timeout}\terror=${r.error}\tok=${r.ok}`,
  );
}

async function runGapSweep(cwd: string, gaps: number[], trials: number): Promise<RateRow[]> {
  const rows: RateRow[] = [];
  let n = 0;
  for (const gap of gaps) {
    const row: RateRow = { label: `gap=${gap}ms`, attempts: 0, busy: 0, timeout: 0, error: 0, ok: 0 };
    for (let i = 0; i < trials; i++) {
      const label = `${HARNESS_LABEL_PREFIX}-gap${gap}-${n++}`;
      const outcome = await runOneTrial(cwd, label, gap);
      row.attempts++;
      row[outcome]++;
    }
    printRow(row);
    rows.push(row);
  }
  return rows;
}

/** DoD item 4's "after" row: the fix, at gap=0, repeated — the direct counterpart to the "before" `gap=0ms` row from `runGapSweep`. */
async function runFixedSweep(cwd: string, trials: number): Promise<RateRow> {
  const row: RateRow = { label: "fixed (gap=0ms, with readiness retry)", attempts: 0, busy: 0, timeout: 0, error: 0, ok: 0 };
  for (let i = 0; i < trials; i++) {
    const outcome = await runFixedTrial(cwd, `${HARNESS_LABEL_PREFIX}-fixed-${i}`);
    row.attempts++;
    row[outcome]++;
  }
  printRow(row);
  return row;
}

async function runConcurrencySweep(cwd: string, levels: number[], trials: number): Promise<RateRow[]> {
  const rows: RateRow[] = [];
  let n = 0;
  for (const level of levels) {
    const row: RateRow = { label: `concurrency=${level}`, attempts: 0, busy: 0, timeout: 0, error: 0, ok: 0 };
    for (let batch = 0; batch < trials; batch++) {
      const outcomes = await Promise.all(
        Array.from({ length: level }, () => runOneTrial(cwd, `${HARNESS_LABEL_PREFIX}-conc${level}-${n++}`, 0)),
      );
      for (const outcome of outcomes) {
        row.attempts++;
        row[outcome]++;
      }
    }
    printRow(row);
    rows.push(row);
  }
  return rows;
}

function parseIntList(s: string | undefined, fallback: number[]): number[] {
  if (!s) return fallback;
  return s.split(",").map((x) => Number.parseInt(x.trim(), 10));
}

function flagValue(name: string): string | undefined {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  return arg?.slice(name.length + 3);
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? "gaps";
  await positiveControl();

  const before = await sweepResidue();
  reportSweep("startup", before);

  if (mode === "sweep") {
    console.log("mode=sweep: reclaim-only, no trials run.");
    return;
  }

  const scratch = mkdtempSync(join(tmpdir(), "butchr-repro-268-"));
  let createdCount = 0;
  let closedCount = 0;
  try {
    if (mode === "gaps") {
      const gaps = parseIntList(flagValue("gaps"), [0, 50, 150, 300, 600, 1200]);
      const trials = Number.parseInt(flagValue("trials") ?? "8", 10);
      console.log(`mode=gaps gaps=[${gaps.join(",")}] trials=${trials}`);
      const rows = await runGapSweep(scratch, gaps, trials);
      createdCount = rows.reduce((s, r) => s + r.attempts, 0);
      closedCount = createdCount; // runOneTrial's own finally closes every pane it creates
    } else if (mode === "concurrency") {
      const levels = parseIntList(flagValue("levels"), [1, 2, 3]);
      const trials = Number.parseInt(flagValue("trials") ?? "5", 10);
      console.log(`mode=concurrency levels=[${levels.join(",")}] trials=${trials}`);
      const rows = await runConcurrencySweep(scratch, levels, trials);
      createdCount = rows.reduce((s, r) => s + r.attempts, 0);
      closedCount = createdCount;
    } else if (mode === "fixed") {
      const trials = Number.parseInt(flagValue("trials") ?? "8", 10);
      console.log(`mode=fixed trials=${trials} (DoD item 4's "after": HerdrHerd's own retry, at gap=0)`);
      const row = await runFixedSweep(scratch, trials);
      createdCount = row.attempts;
      closedCount = createdCount;
    } else {
      throw new Error(`unknown mode "${mode}" — expected sweep|gaps|concurrency|fixed`);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  console.log(`this run: workspaces created=${createdCount} closed=${closedCount} (ratio ${closedCount}/${createdCount})`);

  const after = await sweepResidue();
  reportSweep("end-of-run", after);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("FAILED:", e);
    process.exit(1);
  });
