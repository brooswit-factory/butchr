/**
 * Generic escalation-comment primitives, factored out of the parked-ticket
 * detector (BUTCHR-24, src/agents/parked.ts) so it and the existing
 * blocked-dialog escalator (src/agents/escalation-loop.ts) can eventually
 * share ONE implementation of: marker+fingerprint dedupe against existing
 * comments, and a per-key hourly rate cap. Dependency-free on purpose (no
 * imports) — trivially testable, and safe to import from either caller
 * without pulling in the other's machinery.
 *
 * NOT wired into escalation-loop.ts yet: PR #108 (BUTCHR-5) was OPEN against
 * that exact file (and escalate.ts) when BUTCHR-24 branched, so refactoring
 * it there would have conflicted with an in-flight review — #108 HAS since
 * merged (mid-BUTCHR-24), but that migration was deliberately NOT bundled
 * into BUTCHR-24's PR (a behaviour-preserving refactor of a state machine
 * that had just landed, folded into a PR that was also fixing an unrelated
 * bug, would have made both harder to review). It is tracked as a follow-up
 * under BUTCHR-13 instead. This module is written so that migration — moving
 * escalation-loop.ts's rate cap and dedupe onto these primitives — is a
 * behaviour-preserving swap, not a redesign, whenever it happens.
 */

export interface CommentRow {
  id: string;
  body: string;
  created: string;
}

/**
 * The dedupe/adoption technique `escalate()` in src/agents/escalation-loop.ts
 * uses for the blocked-dialog case, generalised: find the newest comment (of
 * `comments`, assumed newest-first — the same order `AtlassianClient.comments`
 * returns) that starts with `marker` and contains every string in `need`
 * (typically a stable fingerprint plus a stage tag) — or null if none does.
 * A daemon restart re-derives the same `need` from the same stable
 * fingerprint and finds its own prior comment here instead of re-posting it.
 */
export function findMarked(comments: readonly CommentRow[], marker: string, need: readonly string[]): CommentRow | null {
  return comments.find((c) => c.body.startsWith(marker) && need.every((s) => c.body.includes(s))) ?? null;
}

/**
 * In-memory per-key rate limiter: at most `max` posts per `windowMs`,
 * independent per key. Mirrors escalation-loop.ts's per-pane escalation
 * budget (`paneEscalations`), generalised to an arbitrary string key so a
 * caller can key it however its own escalation target is identified (a pane
 * id there; a boss ticket key here).
 */
export class RateCap {
  private readonly posts = new Map<string, number[]>();
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  /** Whether a post for `key` at `now` is currently allowed under the cap. Prunes expired entries as a side effect but does NOT record a post — call `record` only once the post actually happens. */
  allow(key: string, now: number): boolean {
    const recent = (this.posts.get(key) ?? []).filter((t) => now - t < this.windowMs);
    this.posts.set(key, recent);
    return recent.length < this.max;
  }

  /** Record that a post for `key` happened at `now` — call only once the post actually happened (never for an adopted/pre-existing comment). */
  record(key: string, now: number): void {
    const recent = this.posts.get(key) ?? [];
    recent.push(now);
    this.posts.set(key, recent);
  }
}

/** One hour, in milliseconds — the window escalation-loop.ts's rate cap uses. */
export const HOUR_MS = 60 * 60_000;

/**
 * FACTORY-607 comment 28781 (Part A) / FACTORY-609 (Part B): the director's
 * own routing defaults for a managed-session escalation, factored out here
 * (dependency-free, like the rest of this module) so BOTH `src/config/
 * config.ts` (the env-var parser, which must apply these exact values as
 * defaults) and `src/agents/escalation-loop.ts` (which falls back to these
 * when `EscalatorDeps.managedEscalationRouting` is omitted — e.g. by an
 * existing test that predates this ticket) read a SINGLE literal, never two
 * copies that could drift apart. FACTORY-607 comment 28784 item 3: this is a
 * DELIBERATE BEHAVIOUR CHANGE from what FACTORY-369 shipped — assembly's own
 * pane used to route to `@director` in `#team-admin`; it now routes to
 * `@manager-factory` in `#team-engineering` for tiers 1-2, matching the
 * director's comment 28688.
 */
export const MANAGED_ESCALATION_DEFAULTS = {
  /** Tiers 1-2 for an ordinary managed session. */
  normalMention: "@admin-assembly",
  normalRoom: "team-admin",
  /** Tiers 1-2 for the admin-assembly session's OWN pane (the self-reference case). */
  assemblyMention: "@manager-factory",
  assemblyRoom: "team-engineering",
  /** Tier 3, for every managed session (including admin-assembly's own pane). */
  directorMention: "@director",
  directorRoom: "team-engineering",
  /** Minutes after an episode's first mark before the tier-2 re-escalation. */
  tier2Minutes: 10,
  /** Minutes after an episode's first mark before the tier-3 director escalation. */
  tier3Minutes: 20,
} as const;

export type ManagedEscalationRouting = {
  normalMention: string;
  normalRoom: string;
  assemblyMention: string;
  assemblyRoom: string;
  directorMention: string;
  directorRoom: string;
  tier2Minutes: number;
  tier3Minutes: number;
};
