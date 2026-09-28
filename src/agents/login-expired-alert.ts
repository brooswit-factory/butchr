/**
 * FACTORY-363/FACTORY-397: butchr's consuming half of drovr's
 * `createLoginExpiredWatcher` (`@brooswit/drovr` >= 0.16.3,
 * `src/login-expired-escalation.ts`). Two incidents (2026-09-26/27) left 13
 * panes dead for 13-22 hours, twice, because every existing alarm is either
 * gated on `agent_status === "blocked"` (a login-expired pane reads
 * done/idle) or routed through `onNoPrompt`'s consecutive-poll debounce — see
 * FACTORY-357's diagnosis. This module is a THIRD, deliberately independent
 * consumer of drovr's escalation hooks, wired directly in `src/daemon/index.ts`
 * on its own poll loop — never through `createManagedSessionEscalationWatcher`
 * (`src/agents/managed-session-escalation-watcher.ts`), whose sink
 * (`escalator.onDrovrUnknownDialog`) is a deliberate no-op for a KEYED pane
 * (`deps.managedSessionOf(paneId)` resolving to `null`). Both real incidents
 * (FACTORY-314/w1T, FACTORY-324/w1V) were on keyed panes — routing through
 * that wrapper would have dropped exactly the panes this story exists to
 * catch. See `test/unit/login-expired-alert.test.ts`'s "keyed pane" test.
 *
 * There is no answer for an expired OAuth token, and every recovery lever
 * butchr already has (`[butchr:stall]`, `[butchr:unresponsive]`) is
 * agent-mediated — waking an agent means resuming a Claude session, which
 * cannot make an API call either while the credential is dead. So this
 * alert's own delivery is NOT a Jira comment, an `ANSWER`-shaped affordance,
 * or anything else that needs an agent to relay or act on it. It is:
 *
 *   1. A distinct, greppable journal line (`CREDENTIAL_DEATH_MARKER`,
 *      `deps.log` — plain process stdout, captured by systemd/journald,
 *      readable with `journalctl` by a human with no Claude session at all)
 *      on open AND on clear (see `docs/credential-death-alert.md`).
 *   2. A sibling `/health` field (`credentialDeathAlert`, see
 *      `src/daemon/health.ts`), the same "additive, absent when nothing to
 *      report, never flips `ok`" pattern `managedSessionEscalations` already
 *      uses — a plain HTTP GET a human (or an uptime checker) can curl
 *      without any agent or Claude API call in the path.
 *
 * Both survive a dead credential because neither one is Claude: the journal
 * line is written by the daemon's own Node/Bun process to its stdout, and
 * `/health` is served by the daemon's own HTTP listener — see this module's
 * own doc comment on `CredentialDeathAlert` for why the SAME reasoning
 * applies to why this can never carry an `ANSWER`-parseable fingerprint.
 */
import { hostname } from "node:os";

/**
 * Distinct from `UNRESPONSIVE_MARKER` (`[butchr:unresponsive]`,
 * `src/agents/escalation-loop.ts`) and from the routine `[prompts] <pane>
 * blocked with no parseable dialog: ...` debug line neither of which named
 * this condition during the entire first 13-hour incident (FACTORY-357's
 * own measurement: those were the ONLY places the words "Login expired"
 * appeared). Never carries an `ANSWER `-prefixed line or a fingerprint a
 * directive parser could mistake for one — see `CredentialDeathAlert`'s own
 * doc comment.
 */
export const CREDENTIAL_DEATH_MARKER = "[butchr:credential-dead]";

/** Everything a `/health` reader or a journal line needs, and nothing more — see this module's own header for why there is no answer/fingerprint field here. */
export interface CredentialDeathAlert {
  /** This daemon's own hostname (`node:os` `hostname()` — the same value `docs/ground-truth.md`'s "host:" line reports), naming WHICH daemon is affected. */
  host: string;
  /** ISO timestamp this host-wide episode was first opened. */
  since: string;
  /**
   * The most recent transcript text drovr actually matched, quoted
   * verbatim. NEVER a message this module asserts itself — the installed
   * Claude Code binary emits at least five distinct credential-death
   * strings (FACTORY-357's measurement) and drovr's watcher does not
   * distinguish which one occurred; hardcoding one here would silently stop
   * matching a future or differently-worded failure.
   */
  detail: string;
  /** Panes CURRENTLY contributing an unresolved login-expired episode to this host-wide alert — see `onLoginExpiredResolved`'s own doc comment for how a pane leaves this set. */
  paneIds: readonly string[];
}

/** What a clear (host episode closing) logs — always paired with the `reason` that closed it, per criterion 12: an "alert cleared" line that omits WHY reproduces the exact ambiguity this whole story exists to remove. */
export interface CredentialRecoveredEvent {
  host: string;
  /** Always `"recovered"` — see `onLoginExpiredResolved`'s doc comment for why this is the only reason that can ever close the alert. */
  reason: "recovered";
  /** How long the host-wide episode was open, in milliseconds. */
  openForMs: number;
}

export interface CredentialDeathAlertDeps {
  log: (line: string) => void;
  now: () => number;
  /** Defaults to `node:os`'s `hostname()`; injectable for tests, never for production behaviour. */
  host?: string;
}

/**
 * The subset of drovr's `LoginExpiredEscalationHook` this tracker consumes —
 * matches `@brooswit/drovr`'s own shape exactly so a caller can pass this
 * object straight to `createLoginExpiredWatcher` as the hook.
 */
export interface CredentialDeathTracker {
  onLoginExpired(escalation: { paneId: string; detail: string }): void;
  onLoginExpiredResolved(resolved: { paneId: string; reason: "recovered" | "pane-gone" | "superseded" }): void;
  /** Current host-wide alert, or `undefined` when none is open — the exact value to surface as `/health`'s `credentialDeathAlert` sibling field. */
  current(): CredentialDeathAlert | undefined;
}

/**
 * Collapses N simultaneous/successive `onLoginExpired` calls (13 panes dying
 * from one dead credential, or one pane retrying over and over) into ONE
 * host-wide episode, per drovr's own `docs/blocking-escalation.md`
 * "Host-wide blast radius" guidance: open on the first `onLoginExpired`
 * while none is open (fires the alert immediately — never debounced, per
 * criterion 2), track every pane currently contributing to it, and close
 * ONLY once every pane in that set has resolved with `reason: "recovered"`.
 *
 * Deliberately does NOT key the episode's identity to `paneIds`'s specific
 * membership surviving intact — a pane can vanish and reappear under a new
 * pane id (the respawn-churn FACTORY-357 measured, `w6Z:p1` -> `w74:p1`)
 * and the host-wide episode is unaffected: `onLoginExpired` just adds
 * whatever paneId shows up next, `pane-gone` just removes whichever one
 * disappeared, and closing depends only on the surviving set's contents,
 * never on any one pane's continuous identity (criterion 5).
 *
 * "Rate-cap without ever swallowing the first alert" (criterion 6) is
 * satisfied structurally rather than by a time-windowed cap: the very FIRST
 * `onLoginExpired` of a brand-new episode is never gated on anything (there
 * is nothing to check yet — no episode is open), so it can never be
 * swallowed; every subsequent `onLoginExpired` while an episode is already
 * open is a silent no-op on the ALERT (it still updates `detail`/`paneIds`
 * bookkeeping) rather than a second journal line/health flap — which is
 * exactly the "one escalate/resolve pair per retry on a dead pane" churn
 * criterion 6 describes tolerating. A generic time-windowed `RateCap`
 * (`src/agents/escalation-helper.ts`) was deliberately NOT reused here: a
 * window can still swallow a legitimate SECOND episode's first alert if it
 * starts inside the window following a first episode's close, which is
 * precisely the failure criterion 6 forbids; collapsing on episode
 * boundaries instead never swallows a new episode's first alert, only
 * true intra-episode duplicates.
 */
export function createCredentialDeathTracker(deps: CredentialDeathAlertDeps): CredentialDeathTracker {
  const host = deps.host ?? hostname();
  // `hadRecovery` is the closing evidence itself: true only once some pane that was
  // ACTUALLY a member of `panes` at the time has resolved with `reason: "recovered"`.
  // Closing on `panes.size === 0` alone (the FACTORY-357/PR#529 defects) is wrong in
  // both directions — it can stay stuck open forever after a genuine recovery (every
  // OTHER pane then departs via "pane-gone", which never re-checks the empty set),
  // and it can be tricked into closing a live alert by a stray "recovered" for a
  // paneId this tracker never tracked (an untracked delete is a no-op, so the set
  // was already empty from "pane-gone" departures alone — nothing recovered).
  // `hadRecovery` fixes both: it is set ONLY when `panes.delete(paneId)` actually
  // removed a tracked member on a "recovered" event, and closing requires both the
  // set being empty AND this flag — so an episode that empties out via "pane-gone"
  // alone never closes, exactly preserving that deliberate invariant.
  let episode: { since: number; detail: string; panes: Set<string>; hadRecovery: boolean } | undefined;

  function onLoginExpired(escalation: { paneId: string; detail: string }): void {
    if (!episode) {
      episode = { since: deps.now(), detail: escalation.detail, panes: new Set(), hadRecovery: false };
      deps.log(
        `${CREDENTIAL_DEATH_MARKER} ${host}: Claude Code's own credential appears dead (pane ${escalation.paneId}: "${escalation.detail}"). ` +
          `This is a HOST-WIDE alert, not a per-ticket one — every pane on this daemon is likely affected. ` +
          `No agent on this host can fix or acknowledge this: the remedy is a human doing an interactive browser /login for this daemon's account.`,
      );
    }
    episode.detail = escalation.detail;
    episode.panes.add(escalation.paneId);
  }

  function onLoginExpiredResolved(resolved: { paneId: string; reason: "recovered" | "pane-gone" | "superseded" }): void {
    if (!episode) return;
    if (resolved.reason === "superseded") return; // same still-live pane, new episode follows immediately — not evidence of anything, and never removed from the set
    if (resolved.reason === "pane-gone") {
      episode.panes.delete(resolved.paneId); // bookkeeping only — pane churn is not credential recovery
    } else {
      // resolved.reason === "recovered": evidence the credential itself is back, but
      // ONLY when this paneId was actually a tracked member — a stray "recovered" for
      // an untracked paneId must contribute nothing (see `hadRecovery`'s doc above).
      if (episode.panes.delete(resolved.paneId)) episode.hadRecovery = true;
    }
    if (episode.panes.size === 0 && episode.hadRecovery) {
      const openForMs = deps.now() - episode.since;
      deps.log(`${CREDENTIAL_DEATH_MARKER} ${host}: cleared — credential recovered (reason: recovered), open for ${Math.round(openForMs / 1000)}s`);
      episode = undefined;
    }
  }

  function current(): CredentialDeathAlert | undefined {
    if (!episode) return undefined;
    return { host, since: new Date(episode.since).toISOString(), detail: episode.detail, paneIds: [...episode.panes] };
  }

  return { onLoginExpired, onLoginExpiredResolved, current };
}
