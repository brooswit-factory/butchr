/**
 * linked-discovery-log.ts — BUTCHR-429 (implementing BUTCHR-426, story 1/4 of
 * epic BUTCHR-421): the greppable log record of a resource's discovered link
 * set (`src/resources/linked-discovery.ts`'s `LinkedItem[]`), so stories 2/3
 * (Jira-link eventing, then Confluence/GitHub/webpage pollers) can grep this
 * tag to see discovery already working before either of them adds any new
 * behaviour. This module owns ONLY the log-line shape and the "did the set
 * change since I last logged it for this resource" gate — the discovery
 * itself is `linked-discovery.ts`'s pure parse, unaffected by anything here.
 *
 * WHY GATED ON CHANGE, NOT LOGGED UNCONDITIONALLY EVERY POLL: discovery is a
 * cost-free pure parse (no new API call either way), but an UNCHANGED link
 * set logged every poll would dwarf this journal exactly the way
 * `suppressed-log.ts`'s own top comment measured for its two omitted arms —
 * a resource with a stable link set otherwise produces one identical line
 * per poll forever. `createLinkedDiscoveryTracker` below is a per-daemon,
 * in-memory (never persisted — a restart re-logs every resource's current
 * set once, which is correct: a fresh daemon has no history to compare
 * against) fingerprint cache, one entry per resource id, so a genuinely
 * unchanged set logs nothing after its first poll and any real change (a
 * link added, removed, or — via `maxLinkedItems` — newly capped) logs again
 * immediately.
 */

/** The one tag every line this module emits carries — see `SUPPRESSED_TAG` (src/jira-watch/suppressed-log.ts) for the identical reasoning: a brand-new tag, so no existing reader can be confused by it. */
export const LINKED_DISCOVERY_TAG = "[linked-discovery]";

/** The minimal shape this module needs from a discovered link — see `LinkedItem` (src/resources/linked-discovery.ts), which this is structurally compatible with. */
export interface LoggedLinkedItem {
  kind: string;
  target: string;
}

/**
 * One line per link — `kind=`/`target=` in that fixed order (AC-style,
 * matching `suppressed-log.ts`'s `key=`/`watcher=`/`arm=` convention), plus
 * `skipped=true` for an item `maxLinkedItems` capped out rather than a
 * separate line shape, so one `grep '\[linked-discovery\]'` finds the whole
 * discovered set and `grep 'skipped=true'` narrows to only what was capped.
 * `target` is always a Jira key, a `owner/repo#n` GitHub ref, or a URL —
 * never free text a link's creator wrote (a remote link's title, say), so
 * unlike `[tools2]`'s `msg=`, nothing here needs `sanitizeField`-style
 * flattening; the log sink (`src/daemon/log-sink.ts`) is still the backstop
 * against a raw newline forging a second line, exactly as for every other
 * emitter.
 */
export function formatLinkedDiscoveryLines(resourceId: string, kept: readonly LoggedLinkedItem[], skipped: readonly LoggedLinkedItem[]): string[] {
  return [
    ...kept.map((i) => `${LINKED_DISCOVERY_TAG} ${resourceId} kind=${i.kind} target=${i.target} skipped=false`),
    ...skipped.map((i) => `${LINKED_DISCOVERY_TAG} ${resourceId} kind=${i.kind} target=${i.target} skipped=true`),
  ];
}

function fingerprintOf(kept: readonly LoggedLinkedItem[], skipped: readonly LoggedLinkedItem[]): string {
  const ser = (items: readonly LoggedLinkedItem[]) => items.map((i) => `${i.kind}:${i.target}`).join(",");
  return `${ser(kept)}|${ser(skipped)}`;
}

/**
 * A per-daemon tracker of the last-logged link set per resource id.
 * `changed` is TRUE (and records the new fingerprint) the first time a
 * resource id is seen, and any time `(kept, skipped)` differs from what was
 * last recorded for it — by kind+target set and kept/skipped split, not by
 * order. Deliberately does not itself call `log`: a caller decides whether
 * and how to emit (see `createRuleResourceType`, src/rules/resource-type.ts,
 * for the one wired caller as of this ticket).
 */
export function createLinkedDiscoveryTracker(): { changed(resourceId: string, kept: readonly LoggedLinkedItem[], skipped: readonly LoggedLinkedItem[]): boolean } {
  const last = new Map<string, string>();
  return {
    changed(resourceId, kept, skipped) {
      const fp = fingerprintOf(kept, skipped);
      if (last.get(resourceId) === fp) return false;
      last.set(resourceId, fp);
      return true;
    },
  };
}
