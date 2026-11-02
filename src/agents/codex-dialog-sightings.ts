/**
 * FACTORY-425 (implements FACTORY-419): host-side counting of Codex
 * unrecognised-dialog sightings per fingerprint — drovr's `fingerprint` on
 * `UnrecognisedCodexPane` (`@brooswit/drovr` >= 0.16.4,
 * `dist/codex-permission-approval.d.ts`) names the SHAPE of an
 * approval-looking Codex screen drovr could not classify into `command` /
 * `file-edit` / `mcp-tool`; nothing counted those sightings before this file.
 *
 * SCOPE, deliberately narrow (FACTORY-415/FACTORY-419's own scope
 * correction): this module only OBSERVES and COUNTS. It never decides what a
 * Codex dialog means, never classifies, and never answers/presses anything —
 * it is driven exclusively by `scanPendingCodexApprovals`'s read-only scan
 * (never `approveCodexApproval`/`autoAnswerCodexApprovals`, both of which can
 * press keys for a RECOGNISED dialog — out of scope here on purpose). A diff
 * that changes which Codex dialogs get answered does not belong in this file.
 *
 * PRECEDENT SEARCHED FOR AND NOT FOUND: the ticket names two building blocks
 * to mirror, "dialog-watch" (admin-assembly side) and
 * "dialog-sightings.ndjson" (advisor-agentvelocity side). Neither name
 * appears anywhere in this repo — current tree, full-text grep, or
 * `git log --all -S` history search all came back empty. The closest actual
 * Claude-side precedent in butchr today is `escalation-loop.ts`'s
 * `markManagedSessionStalled`/`managedSessionStalled` map (FACTORY-45): it
 * dedupes a dialog to one log line per (pane, fingerprint) EPISODE, surfaced
 * via a `/health` sibling field (`managedSessionEscalations`) and a
 * greppable journal marker (`docs/managed-sessions.md`'s "Two detectors, one
 * mark"). That mechanism tracks CURRENT per-pane stall state, though — it has
 * no persistent per-fingerprint AGGREGATE count anywhere (its rate-cap
 * counter, `countedFingerprints` in the same file, is in-memory-only and
 * reset by nothing ever reading it back). So there was no existing
 * aggregate-count-by-fingerprint surface to converge with for EITHER vendor;
 * this file is a new one for Codex, built as closely as possible to the same
 * episode-dedup idea and the same `/health`-field + journal-marker surface
 * convention `managedSessionEscalations`/`credentialDeathAlert`
 * (`src/agents/login-expired-alert.ts`) already established.
 *
 * EPISODE, NOT POLL: `scanPendingCodexApprovals` has no push/hook API the way
 * drovr's Claude-side `createBlockingEscalationWatcher` does — it is a plain
 * scan, called on a timer (`src/daemon/index.ts`), and returns the FULL
 * current `unrecognised` list on every call. Counting every call's entries
 * would count POLLS. Instead, `onScan` tracks the fingerprint each pane was
 * last seen showing and increments a fingerprint's aggregate count only when
 * a pane's tracked fingerprint actually CHANGES (no entry -> some fingerprint,
 * or fingerprint A -> fingerprint B) — the same "new episode" test
 * `markManagedSessionStalled` uses (`prior?.fp === fp` short-circuits a
 * repeat). A pane that stops appearing in `unrecognised` (dialog cleared,
 * pane gone) has its tracked fingerprint forgotten, so the SAME fingerprint
 * reappearing later on that pane is correctly counted as a new episode, not
 * folded into the old one.
 */
export const CODEX_UNRECOGNISED_MARKER = "[codex-unrecognised]";

/** One `UnrecognisedCodexPane` entry from a `scanPendingCodexApprovals` poll — only the fields this module needs. */
export interface CodexUnrecognisedSighting {
  paneId: string;
  /** Names the dialog's SHAPE, not the individual sighting — see this file's own header. */
  fingerprint: string;
  excerpt: string;
}

/**
 * Aggregate record for one fingerprint. `count` is sightings (episodes), a
 * LOWER BOUND on how often that dialog shape actually occurred — drovr's
 * Codex fingerprint hashes the pane's last 16 lines rather than a parsed
 * (question, options) pair, so the SAME on-screen shape in a different
 * session can fingerprint differently (over-splits, never collides — see
 * `dist/codex-permission-approval.d.ts`'s own `fingerprint` doc comment).
 * NEVER present this `count` as an authoritative total.
 */
export interface CodexDialogSighting {
  fingerprint: string;
  /** Sightings (episodes) of this fingerprint since this daemon started tracking it — a lower bound, not an authoritative total; see this interface's own doc comment. */
  count: number;
  /** The FIRST excerpt seen for this fingerprint, kept verbatim and never overwritten by a later sighting — enough for a human to eyeball two fingerprints and see they are the same dialog. */
  excerpt: string;
  /** ISO timestamp this fingerprint was first sighted. */
  firstSeen: string;
  /** ISO timestamp this fingerprint was most recently sighted. */
  lastSeen: string;
}

export interface CodexDialogSightingsDeps {
  log: (line: string) => void;
  now: () => number;
}

export interface CodexDialogSightingsTracker {
  /** Feed one poll's full `unrecognised` list — see this file's own header for the episode-vs-poll dedup this performs. */
  onScan(unrecognised: readonly CodexUnrecognisedSighting[]): void;
  /** Every fingerprint sighted since this daemon started tracking, in first-sighted order — the exact value to surface as `/health`'s `codexUnrecognisedDialogSightings` sibling field. */
  sightings(): readonly CodexDialogSighting[];
}

export function createCodexDialogSightingsTracker(deps: CodexDialogSightingsDeps): CodexDialogSightingsTracker {
  // Which fingerprint each pane was last seen showing — the episode-dedup
  // state. A pane absent from this poll's `unrecognised` list is dropped
  // from this map at the end of `onScan`, so its next sighting (even of the
  // SAME fingerprint) reads as a new episode, matching
  // `managedSessionStalled`'s clear-then-remark behaviour.
  const paneFingerprints = new Map<string, string>();
  // Persistent aggregate, keyed by fingerprint — never cleared by a pane
  // going away; this is the count itself.
  const byFingerprint = new Map<string, { count: number; excerpt: string; firstSeen: string; lastSeen: string }>();

  function onScan(unrecognised: readonly CodexUnrecognisedSighting[]): void {
    const seenPanes = new Set<string>();
    for (const u of unrecognised) {
      seenPanes.add(u.paneId);
      if (paneFingerprints.get(u.paneId) === u.fingerprint) continue; // same open episode, already counted
      paneFingerprints.set(u.paneId, u.fingerprint);

      const nowIso = new Date(deps.now()).toISOString();
      const existing = byFingerprint.get(u.fingerprint);
      if (existing) {
        existing.count += 1;
        existing.lastSeen = nowIso;
        deps.log(`${CODEX_UNRECOGNISED_MARKER} fingerprint ${u.fingerprint} sighted again on pane ${u.paneId} (count now ${existing.count})`);
      } else {
        byFingerprint.set(u.fingerprint, { count: 1, excerpt: u.excerpt, firstSeen: nowIso, lastSeen: nowIso });
        deps.log(`${CODEX_UNRECOGNISED_MARKER} new fingerprint ${u.fingerprint} first sighted on pane ${u.paneId}: ${JSON.stringify(u.excerpt)}`);
      }
    }
    for (const paneId of [...paneFingerprints.keys()]) {
      if (!seenPanes.has(paneId)) paneFingerprints.delete(paneId);
    }
  }

  function sightings(): readonly CodexDialogSighting[] {
    return [...byFingerprint.entries()].map(([fingerprint, s]) => ({ fingerprint, ...s }));
  }

  return { onScan, sightings };
}
