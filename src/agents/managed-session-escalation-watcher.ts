/**
 * FACTORY-45 Part B, review fix (PR #451, 834a492): `createBlockingEscalationWatcher`
 * (`@brooswit/drovr` >= 0.15.0) is not observation-only — for every Claude
 * pane on the fleet it also PRESSES keys (`agent.sendKeys`) for the
 * `startup` dialogs it recognises (trust, development-channels,
 * auto-mode-onboarding, and its own speculative `fullscreen-renderer`
 * matcher). Wiring the real herdr client straight into `watcher.poll()`
 * would give Butchr a SECOND, independent auto-answerer running every 5s
 * on every pane alongside `watchPrompts`/`chooseStartupAnswer` — and the
 * reviewer's own scenario is concrete, not hypothetical: startup dialogs
 * arrive in sequence (trust, then development-channels), a slow redraw can
 * let both answerers read the SAME still-visible dialog, and the second
 * answerer's keys then land on the NEXT dialog instead — `trust`'s own
 * down+enter on a "No, exit" / "Yes, I trust this folder" menu moves to
 * `Exit` and confirms it, killing the launch. Butchr's answering policy is
 * also out of THIS ticket's scope: Part B exists to receive drovr's
 * unknown-dialog escalations, not to add a second answerer.
 *
 * The fix: this module hands drovr's watcher a client whose `sendKeys` is
 * unconditionally a no-op — `list`/`read` pass through to the real client
 * untouched, so drovr's own detection/classification (and so its escalation
 * hook) works exactly as documented, but nothing it recognises is ever
 * pressed. Butchr's OWN `chooseStartupAnswer` (`src/agents/prompt.ts`)
 * remains the SOLE answerer for every pane, unchanged by this ticket — see
 * `docs/managed-sessions.md`'s "Two detectors, one mark" section.
 *
 * Factored out of `src/daemon/index.ts` into its own small, exported
 * function specifically so the no-op wiring is independently testable with
 * a fake client, rather than only provable by reading the daemon's own
 * wiring code.
 */
import { createBlockingEscalationWatcher, type AutoHandleOutcome, type BlockingEscalationWatcher, type DrovrClient, type ScanBlockingPromptsOptions } from "@brooswit/drovr";
import type { Escalator } from "./escalation-loop.js";

/** The read half of drovr's own `EscalationClient` — never `sendKeys`, which this module always overrides; see this file's own header for why. */
export type ManagedSessionEscalationReadClient = { agent: Pick<DrovrClient["agent"], "list" | "read" | "sendKeys"> };

export interface ManagedSessionEscalationWatcher {
  /** One pass over every Claude pane herdr reports — see `BlockingEscalationWatcher.poll`'s own doc comment (`@brooswit/drovr`) for the "never call concurrently on the same instance" contract this inherits unchanged. */
  poll(client: ManagedSessionEscalationReadClient, options?: ScanBlockingPromptsOptions): Promise<AutoHandleOutcome[]>;
}

/**
 * Wires drovr's host-neutral escalation hook to the SAME minimal
 * managed-session escalation `Escalator.onBlocked`'s own Butchr-detected
 * path already builds (`onDrovrUnknownDialog`/`onDrovrDialogResolved`,
 * `src/agents/escalation-loop.ts`) — with `sendKeys` permanently replaced
 * by a no-op, regardless of what the caller's own client provides for it,
 * so drovr's watcher can detect and escalate but never press.
 */
export function createManagedSessionEscalationWatcher(
  escalator: Pick<Escalator, "onDrovrUnknownDialog" | "onDrovrDialogResolved">,
): ManagedSessionEscalationWatcher {
  const watcher: BlockingEscalationWatcher = createBlockingEscalationWatcher({
    onUnknownDialog: (escalation) => escalator.onDrovrUnknownDialog(escalation),
    onDialogResolved: (resolved) => escalator.onDrovrDialogResolved(resolved),
  });
  return {
    poll: (client, options) =>
      watcher.poll({ agent: { list: client.agent.list, read: client.agent.read, sendKeys: async () => ({ type: "ok" }) } }, options),
  };
}
