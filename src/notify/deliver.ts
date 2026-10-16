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

/**
 * FACTORY-1010 — the per-rule explicit delivery choice (`Rule.notifyDeliveryMode`).
 * Mirrors the two transports `NotifyDeliveryDeps` already exposes:
 * `"channel"` sends ONLY via `pushChannel`, `"prompt"` sends ONLY via
 * `nudgePrompt`. There is no third "both" value — explicit mode never
 * doubles delivery, and never silently falls back to the other transport
 * (that silent fallback stays reserved for the ABSENT/default case, which
 * this type cannot express; see `NotifyDeliveryDeps.mode`'s own doc comment).
 */
export type NotifyDeliveryMode = "channel" | "prompt";

export interface NotifyDeliveryDeps {
  /**
   * Push the notice over the agent's dev channel. Every seam passes exactly
   * `() => notifyAgent(mcp, agent, aboutIssue, msg)` — AWAITED and CONSULTED
   * here, never fired-and-forgotten the way the old per-seam pairing did.
   */
  pushChannel: () => Promise<ChannelPushResult>;
  /** The prompt-typed fallback — every seam passes exactly `() => herd.nudge(agent, msg)`. */
  nudgePrompt: () => Promise<NudgeResult>;
  /**
   * FACTORY-1010 — the effective `Rule.notifyDeliveryMode` for the agent this
   * notice is addressed to, resolved by the caller (a rule's own agent key
   * carries exactly one owning rule — see `decodeAnyAgentKey`'s own doc
   * comment, `src/rules/agent-key.ts`). ABSENT (the default, every existing
   * seam/test before this ticket) is today's behaviour byte-for-byte:
   * channel first, falling back to the prompt on any ambiguous or failed
   * read of channel availability — see this function's own top comment.
   * `"channel"` sends ONLY via `pushChannel`; on a channel miss it returns a
   * clear non-delivery result (`{ via: "none" }`) rather than silently
   * trying the prompt. `"prompt"` sends ONLY via `nudgePrompt`, never even
   * attempting the channel push. Neither explicit value ever sends both.
   */
  mode?: NotifyDeliveryMode | undefined;
}

export type NotifyDelivery =
  | { via: "channel" }
  /**
   * FACTORY-1010 — explicit `mode: "channel"` AND it delivered. A DISTINCT
   * shape from the bare `{ via: "channel" }` above (never `explicit: false`
   * — the default/omitted-mode success case keeps the exact pre-existing
   * shape, so every `toEqual({ via: "channel" })` assertion written before
   * this ticket keeps passing byte-for-byte), so a caller/log line can tell
   * "this rule explicitly chose the channel" apart from "the channel just
   * happened to be first in line" — the gap an independent review flagged:
   * both cases used to render identically.
   */
  | { via: "channel"; explicit: true }
  | { via: "prompt"; fallbackReason: string; delivered: boolean; refusal?: SessionLimitRefusal }
  /** FACTORY-1010 — explicit `mode: "prompt"`: never touched the channel, so there is no `fallbackReason` to report (that field means "the channel was tried and lost"). */
  | { via: "prompt"; delivered: boolean; refusal?: SessionLimitRefusal }
  /** FACTORY-1010 — explicit `mode: "channel"`, and the channel was unavailable/refused/threw: a clear non-delivery result, never an alternate-transport fallback. */
  | { via: "none"; reason: string };

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
 *
 * FACTORY-1010 — the above is ALL still true, unconditionally, when
 * `deps.mode` is absent: this is the exact pre-existing gate, unchanged.
 * `deps.mode` only short-circuits that behaviour, routing through exactly
 * one transport and never the other.
 */
export async function deliverNotice(deps: NotifyDeliveryDeps): Promise<NotifyDelivery> {
  if (deps.mode === "prompt") {
    const outcome = await deps.nudgePrompt().catch((): NudgeResult => ({ delivered: false }));
    return { via: "prompt", delivered: outcome.delivered, ...(outcome.refusal ? { refusal: outcome.refusal } : {}) };
  }

  let push: ChannelPushResult | undefined;
  let pushError: string | undefined;
  try {
    push = await deps.pushChannel();
  } catch (e) {
    pushError = e instanceof Error ? e.message : String(e);
  }

  const delivered = push ? push.sent.filter((id) => !push!.refused.some((r) => r.id === id)) : [];
  if (push && delivered.length > 0) return deps.mode === "channel" ? { via: "channel", explicit: true } : { via: "channel" };

  const unavailableReason = pushError !== undefined
    ? `channel push threw: ${pushError}`
    : push === undefined
      ? "channel availability unknown"
      : push.sent.length === 0
        ? "no channel attached"
        : "channel reported sent but every connection was also refused";

  if (deps.mode === "channel") return { via: "none", reason: unavailableReason };

  const outcome = await deps.nudgePrompt().catch((): NudgeResult => ({ delivered: false }));
  return { via: "prompt", fallbackReason: unavailableReason, delivered: outcome.delivered, ...(outcome.refusal ? { refusal: outcome.refusal } : {}) };
}

/**
 * The ONE place the `[notify]` audit phrase is decided, so every seam's log
 * line agrees on what "delivered", "fell back" and "neither" actually mean.
 * Each seam still composes its own line (they differ in which identifiers
 * they name), but all of them end with this phrase.
 */
export function renderNotifyDelivery(d: NotifyDelivery): string {
  if (d.via === "channel") return "explicit" in d ? "Claude channel delivered (explicit mode)" : "Claude channel delivered";
  if (d.via === "none") return `Claude channel unavailable (${d.reason}); explicit channel-only mode, no prompt fallback attempted`;
  if (!("fallbackReason" in d)) {
    if (d.refusal) return `Direct prompt (explicit mode): refused (session limit, resets ${d.refusal.resetsAt !== null ? new Date(d.refusal.resetsAt).toISOString() : "unknown"})`;
    return `Direct prompt (explicit mode): ${d.delivered ? "delivered" : "refused/absent"}`;
  }
  const base = `Claude channel unavailable (${d.fallbackReason}), fell back to prompt`;
  if (d.refusal) {
    return `${base}: refused (session limit, resets ${d.refusal.resetsAt !== null ? new Date(d.refusal.resetsAt).toISOString() : "unknown"})`;
  }
  return `${base}: prompt ${d.delivered ? "delivered" : "refused/absent"}`;
}
