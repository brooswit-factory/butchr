/**
 * FACTORY-453 (implementing FACTORY-337, epic FACTORY-330): resolves the
 * `:agentKey` path parameter of `GET /agents/:agentKey/pty` to a live pane,
 * the SAME way `src/resources/resource-lookup.ts` resolves an `agentKey` for
 * `/resources/for-url` — over the already-polled `DashboardResponse.rows`
 * snapshot, never a fresh provider call. Kept deliberately separate from
 * that module: this one matches a single, exact agent key given by the
 * caller, not "every agent for a resource".
 *
 * Refusal wording reuses `src/terminal/open.ts`'s `attachRefusalMessage` for
 * the "well-formed key, but names no live pane" case (the ticket's own
 * "existing refusal reason" requirement) — literally the same function and
 * the same "unknown-pane" message text, just handed the agent key in place
 * of a pane id, since both are "the thing the caller named that isn't one of
 * this daemon's own live things". A malformed key has no such analog in
 * `open.ts` (that module never receives anything but an already-known pane
 * id), so it gets its own, new refusal here rather than forcing a mismatched
 * reuse.
 */
import { decodeAnyAgentKey } from "../rules/agent-key.js";
import type { DashboardRow } from "../agents/dashboard.js";
import { attachRefusalMessage } from "./open.js";

export type PtyAttachRefusal = { reason: "malformed-key"; key: string } | { reason: "unknown-pane"; agentKey: string };

export function ptyAttachRefusalMessage(r: PtyAttachRefusal): string {
  switch (r.reason) {
    case "malformed-key":
      return `not a valid agent key: ${r.key}`;
    case "unknown-pane":
      return attachRefusalMessage({ reason: "unknown-pane", pane: r.agentKey });
  }
}

export type PtyAttachResolution = { ok: true; pane: string } | { ok: false; refusal: PtyAttachRefusal };

/**
 * Order is deliberate, same reasoning as `resolveAttach` in `./open.ts`: a
 * key that doesn't even decode is refused before anything else is asked
 * about it, so a malformed/attacker-supplied key is never told "not live"
 * as though it were otherwise a real, recognized key.
 */
export function resolvePtyPane(agentKey: string, rows: readonly DashboardRow[]): PtyAttachResolution {
  if (!decodeAnyAgentKey(agentKey)) return { ok: false, refusal: { reason: "malformed-key", key: agentKey } };
  const row = rows.find((r) => r.resourceKey === agentKey);
  if (!row || row.kind !== "agent") return { ok: false, refusal: { reason: "unknown-pane", agentKey } };
  return { ok: true, pane: row.pane };
}

/**
 * Re-checked on every poll tick of an already-open socket (see
 * `./pty-bridge.ts`) to decide whether the pane the socket attached to is
 * still live — reading the SAME snapshot as the initial resolve above, never
 * a fresh call, so an active socket costs this daemon no extra polling of
 * its own beyond the pane reads it already needs for output.
 */
export function isPaneStillLive(agentKey: string, pane: string, rows: readonly DashboardRow[]): boolean {
  const row = rows.find((r) => r.resourceKey === agentKey);
  return row?.kind === "agent" && row.pane === pane;
}
