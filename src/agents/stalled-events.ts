import type { EventRules, NotifyReason } from "../resources/types.js";

export interface StalledNotice { key: string; at: number }
export interface StallObservation {
  key: string;
  minutes: number;
  stalled: boolean;
  activity?: number;
}

/** In-memory intervals only. No counters, files, Jira metadata, or delivery channel. */
export class StalledEvents {
  private active = new Map<string, { next: number; activity: number; interval: number; notice?: StalledNotice }>();
  private recipients = new Map<string, number>();
  constructor(private now: () => number = Date.now) {}
  observe(o: StallObservation): StalledNotice | undefined {
    if (!Number.isFinite(o.minutes) || o.minutes <= 0) throw new Error("stalled interval must be positive");
    if (!o.stalled) { this.forget(o.key); return; }
    const now = this.now(), interval = o.minutes * 60_000;
    let state = this.active.get(o.key);
    if (!state) {
      state = { next: now, activity: -Infinity, interval };
      this.active.set(o.key, state);
    }
    if (state.interval !== interval) {
      state.interval = interval;
      state.next = Math.max(state.notice ? state.notice.at + interval : now, state.activity + interval);
    }
    if (o.activity !== undefined && o.activity > state.activity) {
      state.activity = o.activity;
      state.next = Math.max(state.next, o.activity + interval);
      if (o.activity + interval > now) delete state.notice;
    }
    if (now < state.next) return state.notice;
    state.next = now + interval;
    state.notice = { key: o.key, at: now };
    return state.notice;
  }
  pending(notice: StalledNotice, recipient: string): boolean {
    return this.recipients.get(JSON.stringify([notice.key, recipient])) !== notice.at;
  }
  acknowledge(notice: StalledNotice, recipient: string): void {
    this.recipients.set(JSON.stringify([notice.key, recipient]), notice.at);
  }
  forget(key: string): void { this.active.delete(key); }
}

/** A due interval is an internal updated event, not a fictional Jira update.
 * It enters the same changedPrimary/changedRelated + decide contract as any
 * ordinary change, without a comment, label toggle, or separate wake channel. */
export function withStalledEvents<T>(base: EventRules<T>, events: StalledEvents,
  idOf: (resource: T) => string,
  observe: (resource: T) => Promise<StallObservation | undefined>,
  forgetObservation?: (id: string) => void,
): EventRules<T> {
  let previous = new Map<string, string>();
  return {
    async poll(prev, next) {
      const notices = new Map<string, StalledNotice>();
      const current = new Map<string, string>();
      for (const resource of [...next.primary, ...next.related.map((r) => r.issue)]) {
        const id = idOf(resource);
        if (current.has(id)) continue;
        const observation = await observe(resource);
        if (!observation) continue;
        current.set(id, observation.key);
        const notice = events.observe(observation);
        if (notice) notices.set(id, notice);
      }
      for (const [id, key] of previous) if (!current.has(id)) { events.forget(key); forgetObservation?.(id); }
      previous = current;
      const ordinary = await base.poll(prev, next);
      return {
        changedPrimary: [...new Set([...ordinary.changedPrimary, ...next.primary.map(idOf).filter((id) => notices.has(id))])],
        changedRelated: [...new Set([...ordinary.changedRelated, ...next.related.map((r) => idOf(r.issue)).filter((id) => notices.has(id))])],
        async decide(key, recipient, space) {
          const notice = notices.get(key);
          const routed = space === "primary" ? recipient === key : next.related.some((r) => idOf(r.issue) === key && r.watchers.includes(recipient));
          if (notice && routed && events.pending(notice, recipient)) {
            events.acknowledge(notice, recipient);
            return { deliver: true, reason: { stalled: notice } satisfies NotifyReason };
          }
          if (!(space === "primary" ? ordinary.changedPrimary : ordinary.changedRelated).includes(key)) return { deliver: false };
          const verdict = await ordinary.decide(key, recipient, space);
          // The shared epoch replaces the former entry-only wake; cleanup
          // still follows the ordinary label filter.
          if (verdict.deliver && verdict.reason && "stalled" in verdict.reason) return { deliver: false };
          return verdict;
        },
      };
    },
  };
}
