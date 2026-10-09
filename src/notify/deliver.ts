import type { SessionLimitRefusal } from "@brooswit/drovr";
import type { NudgeResult } from "../agents/herd.js";

/**
 * FACTORY-893/FACTORY-894 — the shape `notifyAgent`'s `sendAll(...)` already
 * resolves to (src/daemon/app.ts). Declared here, not imported from there, so
 * this module never needs a live `McpHandle` to be unit tested: every seam
 * passes a `pushChannel` closure that happens to call the real `notifyAgent`,
 * but this gate only ever looks at the plain object it resolves to.
 */
export interface ChannelPushResult {
  sent: string[];
  refused: Array<{ id: string; reason: string }>;
}

export interface NotifyDeliveryDeps {
  /**
   * Push the notice over the agent's dev channel. Every seam passes exactly
   * `() => notifyAgent(mcp, agent, aboutIssue, msg)` — AWAITED and CONSULTED
   * here, never fired-and-forgotten the way the old per-seam pairing did.
   */
  pushChannel: () => Promise<ChannelPushResult>;
  /** The prompt-typed fallback — every seam passes exactly `() => herd.nudge(agent, msg)`. */
  nudgePrompt: () => Promise<NudgeResult>;
}

export type NotifyDelivery =
  | { via: "channel" }
  | { via: "prompt"; fallbackReason: string; delivered: boolean; refusal?: SessionLimitRefusal };

/**
 * THE gate every delivery seam must route through (FACTORY-893/FACTORY-894).
 * Replaces the old per-seam pairing:
 *
 *   void notifyAgent(mcp, agent, aboutIssue, msg).catch(...);   // result discarded
 *   const outcome = await herd.nudge(agent, msg).catch(...);    // unconditional
 *
 * UNDER-DELIVERY IS A DEADLOCK; OVER-DELIVERY IS ONLY NOISE — so every
 * ambiguous or failed read of the channel's own availability falls back to
 * the prompt. "Delivered on the channel" is the ONLY way to skip the
 * prompt, and it requires a POSITIVE claim: a non-empty `sent` list with at
 * least one id that is not ALSO in `refused` (defensive — the real
 * `sendAll` never puts one id in both, but this gate does not trust that
 * invariant blindly). A push that throws, a push whose `sent` comes back
 * empty, and a push whose every `sent` id is also `refused` all count as
 * "channel unavailable" and fall back, exactly like a push that never
 * resolves to a known-good read at all.
 */
export async function deliverNotice(deps: NotifyDeliveryDeps): Promise<NotifyDelivery> {
  let push: ChannelPushResult | undefined;
  let pushError: string | undefined;
  try {
    push = await deps.pushChannel();
  } catch (e) {
    pushError = e instanceof Error ? e.message : String(e);
  }

  const delivered = push ? push.sent.filter((id) => !push!.refused.some((r) => r.id === id)) : [];
  if (push && delivered.length > 0) return { via: "channel" };

  const fallbackReason = pushError !== undefined
    ? `channel push threw: ${pushError}`
    : push === undefined
      ? "channel availability unknown"
      : push.sent.length === 0
        ? "no channel attached"
        : "channel reported sent but every connection was also refused";

  const outcome = await deps.nudgePrompt().catch((): NudgeResult => ({ delivered: false }));
  return { via: "prompt", fallbackReason, delivered: outcome.delivered, ...(outcome.refusal ? { refusal: outcome.refusal } : {}) };
}

/**
 * The ONE place the `[notify]` audit phrase is decided, so every seam's log
 * line agrees on what "delivered", "fell back" and "neither" actually mean.
 * Each seam still composes its own line (they differ in which identifiers
 * they name), but all of them end with this phrase.
 */
export function renderNotifyDelivery(d: NotifyDelivery): string {
  if (d.via === "channel") return "Claude channel delivered";
  const base = `Claude channel unavailable (${d.fallbackReason}), fell back to prompt`;
  if (d.refusal) {
    return `${base}: refused (session limit, resets ${d.refusal.resetsAt !== null ? new Date(d.refusal.resetsAt).toISOString() : "unknown"})`;
  }
  return `${base}: prompt ${d.delivered ? "delivered" : "refused/absent"}`;
}
