import { detectSessionLimitRefusal } from "./session-limit.js";

export interface AgentRow { pane_id: string; agent_status: string; issue: string | null }

/**
 * BUTCHR-12: a durable place to land the pane text when this module's own
 * detection is inconclusive — the recogniser might be missing a live
 * refusal, or it recognised one it can't schedule recovery for. Optional and
 * injected (not real fs) so unit tests never touch a real filesystem; the
 * fs-backed implementation lives in capture-store.ts.
 */
export interface CaptureSink {
  /** Write a capture file; resolves to the full path written (for the journal line). */
  write: (name: string, contents: string) => Promise<string>;
  /** Existing capture file names in the directory (unordered). */
  list: () => Promise<string[]>;
  remove: (name: string) => Promise<void>;
}

export interface SessionLimitWatchDeps {
  /** Every currently running butchr agent, with its herdr status and resolved issue key (null for a foreign pane). */
  list: () => Promise<AgentRow[]>;
  /** Read the detection region of a pane, ANSI stripped — same shape as prompt-watch's `read`. */
  read: (paneId: string) => Promise<string>;
  /** Close the issue's agent pane; the existing reconciler respawns it with a fresh kickoff within one poll. */
  close: (issue: string) => Promise<void>;
  now: () => number;
  log: (line: string) => void;
  /** Optional: when absent, the watcher behaves exactly as it did before BUTCHR-12 (no capture, ever). */
  captures?: CaptureSink;
}

export type Stop = () => void;

/**
 * Grace period after the printed reset time before closing the pane, not
 * zero: absorbs clock skew between the daemon's host clock and whatever
 * clock Claude printed the reset time from, plus the observation that the
 * limit isn't necessarily lifted the exact instant it prints (measured the
 * night of the incident: the agent was confirmed working ~40s after the
 * pane was closed, comfortably inside this margin).
 */
export const POST_RESET_MARGIN_MS = 2 * 60_000;

/**
 * BUTCHR-12: the two — and only two — trigger classes worth durably
 * capturing. Deliberately NOT a capture on the normal recognised-with-a-
 * reset-time path: that path is working, so capturing it would be pure
 * noise. `unrecognised` uses a cheap unanchored substring test (not the full
 * anchored "You've ..." phrase `detectSessionLimitRefusal` matches) so both
 * the straight and curly apostrophe trip it without touching the recogniser.
 */
type TriggerClass = "unrecognised" | "no-reset-time";
const CHEAP_PHRASE = /hit your session limit/i;

/** Global cap on capture files kept at once; exported so tests can assert eviction against it directly. */
export const CAPTURE_MAX_FILES = 50;

/** A real pane is ~2.5KB; this is only a backstop against something pathological. */
const MAX_CAPTURE_BYTES = 256 * 1024;

function compactUtc(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d\d\dZ$/, "Z");
}

/**
 * Recognises exactly the filenames this module writes
 * (`<ISSUE>-<trigger>-<compact-UTC-timestamp>.txt`) and captures the
 * timestamp segment. Two things depend on this, both from review on
 * BUTCHR-12: eviction must sort by the TIMESTAMP, not the whole filename —
 * a plain lexicographic sort of the full name orders by issue key first, so
 * across more than one issue it evicts the newest capture and keeps
 * seven-month-old ones — and `BUTCHR_CAPTURE_DIR` is operator-settable, so
 * `list()` can return files butchr never wrote (pointed at a shared
 * directory); eviction must never delete a file it doesn't recognise as its
 * own.
 */
const CAPTURE_NAME = /^[A-Z][A-Z0-9]*-\d+-(?:unrecognised|no-reset-time)-(\d{8}T\d{6}Z)\.txt$/;

/** Our own capture files present in the sink, oldest (by timestamp) first; anything we didn't write is excluded. */
async function ourCapturesOldestFirst(sink: CaptureSink): Promise<{ name: string; ts: string }[]> {
  const all = await sink.list();
  const ours: { name: string; ts: string }[] = [];
  for (const name of all) {
    const m = CAPTURE_NAME.exec(name);
    if (m) ours.push({ name, ts: m[1]! });
  }
  ours.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  return ours;
}

/**
 * Per-(issue, trigger class, pane incarnation) dedupe so a pane that stays
 * refused for 90 minutes across hundreds of polls yields ONE file, not
 * hundreds. Deliberately a SEPARATE map from `seen` in watchSessionLimits:
 * `seen`'s delete-on-no-refusal semantics are load-bearing for the
 * close-after-reset path and must not be overloaded with capture bookkeeping.
 */
function clearCaptured(captured: Map<string, true>, issue: string): void {
  for (const key of captured.keys()) if (key.startsWith(`${issue}|`)) captured.delete(key);
}

/**
 * Attempt one capture, honouring the per-pane dedupe and the global file
 * cap. Fail-open by construction (decision 8, BUTCHR-12): the dedupe entry
 * is set BEFORE the write is attempted, so a write failure is logged once
 * and never retried on the next poll — a permanently unwritable directory
 * produces one log line per pane, not one per poll. Never throws.
 */
async function maybeCapture(
  deps: SessionLimitWatchDeps,
  captured: Map<string, true>,
  row: AgentRow,
  trigger: TriggerClass,
  triggerDetail: string,
  text: string,
): Promise<void> {
  const sink = deps.captures;
  if (!sink) return;
  const key = `${row.issue}|${trigger}|${row.pane_id}`;
  if (captured.has(key)) return;
  captured.set(key, true);
  try {
    const capturedAt = new Date(deps.now());
    let body = text;
    let truncatedNote: string | null = null;
    if (Buffer.byteLength(body, "utf8") > MAX_CAPTURE_BYTES) {
      body = Buffer.from(body, "utf8").subarray(0, MAX_CAPTURE_BYTES).toString("utf8");
      truncatedNote = `pane text exceeded ${MAX_CAPTURE_BYTES} bytes; kept the first ${MAX_CAPTURE_BYTES}`;
    }
    const header =
      `# butchr session-limit capture\n` +
      `# issue: ${row.issue}\n` +
      `# pane: ${row.pane_id}\n` +
      `# agent_status: ${row.agent_status}\n` +
      `# captured-at: ${capturedAt.toISOString()}\n` +
      `# trigger: ${trigger} (${triggerDetail})\n` +
      (truncatedNote ? `# truncated: ${truncatedNote}\n` : "") +
      `# --- pane text follows verbatim (ANSI already stripped) ---\n` +
      `\n`;
    const name = `${row.issue}-${trigger}-${compactUtc(capturedAt.getTime())}.txt`;

    // Eviction lives here, in the watcher, not in the store, so it's
    // exercised through the injected seam with no real fs. Only OUR OWN
    // capture files count against the cap and are eligible for eviction —
    // a `BUTCHR_CAPTURE_DIR` pointed at a directory that already holds
    // something must never have those files deleted out from under it.
    let ours = await ourCapturesOldestFirst(sink);
    while (ours.length >= CAPTURE_MAX_FILES) {
      const oldest = ours[0]!;
      await sink.remove(oldest.name);
      ours = ours.slice(1);
    }
    const path = await sink.write(name, header + body);
    deps.log(`[session-limit] ${row.issue} pane ${row.pane_id} ${trigger} — pane text captured to ${path}`);
  } catch (e) {
    deps.log(`[session-limit] ${row.issue} pane ${row.pane_id} ${trigger} capture failed: ${(e as Error)?.message ?? e}`);
  }
}

/**
 * Level-triggered, not scheduled (KAN-804/807): every poll, for every agent
 * whose status is idle/done — the cheap gate, so a working or blocked agent's
 * pane is never read here — check for a session-limit refusal and, once past
 * its printed reset time plus POST_RESET_MARGIN_MS, close the pane so the
 * existing reconciler respawns the agent with a fresh kickoff. Nothing is
 * persisted: a daemon restarted at any point re-reads the same pane text and
 * reaches the same decision, which is what makes an hours-away reset
 * survivable across restarts. Before the reset, this only logs — once per
 * distinct (issue, resetsAt) pair, not every poll (the escalator's
 * dedupe-by-distinct-fingerprint in escalation-loop.ts is the local
 * precedent).
 *
 * BUTCHR-12: additionally, when `deps.captures` is supplied, durably capture
 * the full ANSI-stripped pane text on the two trigger classes documented
 * above `maybeCapture` — evidence for the NEXT recogniser miss, since a pane
 * holds no scrollback and the text is gone within hours.
 */
export function watchSessionLimits(deps: SessionLimitWatchDeps, intervalMs: number): Stop {
  // issue -> the resetsAt FIRST resolved for this refusal, and whether it's
  // been logged. Pinned deliberately: detectSessionLimitRefusal always
  // resolves to the NEXT occurrence at-or-after the `now` it's given, so
  // re-resolving fresh on every poll against an ever-advancing `now` would
  // never let `now` catch up to it — the instant real time passes today's
  // target, a fresh resolve rolls to TOMORROW's, forever staying just out of
  // reach. Pinning to the first resolution (closest to when the refusal
  // actually appeared) is what makes "close after resetsAt+margin" reachable
  // at all. Lost on a daemon restart like everything else here — a restart
  // before the reset re-derives the same future target from the pane alone;
  // a restart in the brief margin window after the reset but before this
  // poller has closed the pane is the one case that re-derives a stale
  // "tomorrow" instead and waits a full day — rare, and self-correcting.
  const seen = new Map<string, { resetsAt: number; logged: boolean }>();
  const captured = new Map<string, true>();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const tick = async (): Promise<void> => {
    try {
      const rows = await deps.list();
      for (const row of rows) {
        if (stopped) return;
        if (row.agent_status !== "idle" && row.agent_status !== "done") continue;
        if (!row.issue) continue;
        const text = await deps.read(row.pane_id);
        const phrasePresent = CHEAP_PHRASE.test(text);
        if (!phrasePresent) clearCaptured(captured, row.issue);
        const refusal = detectSessionLimitRefusal(text, new Date(deps.now()));
        if (!refusal) {
          seen.delete(row.issue);
          if (phrasePresent) await maybeCapture(deps, captured, row, "unrecognised", "phrase present, detectSessionLimitRefusal returned null", text);
          continue;
        }
        if (refusal.resetsAt === null) {
          // Conservative: never invent a reset time. An operator-visible line
          // beats silently never recovering — this pane needs a human.
          deps.log(`[session-limit] ${row.issue} pane ${row.pane_id} refused ("${refusal.raw}") but no reset time could be parsed — cannot schedule recovery, needs an operator`);
          await maybeCapture(deps, captured, row, "no-reset-time", `recognised ("${refusal.raw}"), no reset time parseable`, text);
          continue;
        }
        const entry = seen.get(row.issue) ?? { resetsAt: refusal.resetsAt, logged: false };
        seen.set(row.issue, entry);
        if (!entry.logged) {
          entry.logged = true;
          deps.log(`[session-limit] ${row.issue} pane ${row.pane_id} refused ("${refusal.raw}"), resets ${new Date(entry.resetsAt).toISOString()} — will close the pane ${POST_RESET_MARGIN_MS / 60_000}m after reset so the reconciler respawns with a fresh kickoff`);
        }
        if (deps.now() >= entry.resetsAt + POST_RESET_MARGIN_MS) {
          await deps.close(row.issue);
          seen.delete(row.issue);
        }
      }
    } catch (e) {
      deps.log(`[session-limit] poll failed: ${(e as Error)?.message ?? e}`);
    }
    if (!stopped) timer = setTimeout(() => void tick(), intervalMs);
  };
  void tick();
  return () => { stopped = true; if (timer !== undefined) clearTimeout(timer); };
}
