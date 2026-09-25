/**
 * linked-eventing.ts — BUTCHR-436 (epic BUTCHR-421, story 2/4 of 4): makes a
 * change to a Jira-kind link discovered by story 1
 * (`discoverLinkedItems`/`capLinkedItems`, src/resources/linked-discovery.ts)
 * actually cause exactly one coalesced, rate-capped channel nudge to the
 * OWNING resource's agent — the mechanism this story exists to build.
 * Confluence/GitHub/webpage link kinds are BUTCHR-428's (story 3); this
 * module only ever watches `issuelink`/`parent`/`jira-key`-kind targets
 * (already free — they ride the same `search()` fields story 1 uses) plus,
 * when a rule opts into `linkedRemoteLinks`, a Jira remote link that
 * resolves to a `.../browse/<KEY>` URL on this site (via
 * `jiraBrowseKey`) — a genuinely separate REST call per opted-in owning
 * resource, never fetched otherwise.
 *
 * SCOPE, STATED ONCE HERE (do not re-litigate — see BUTCHR-436's own ticket
 * history): child/project-member discovery (the ticket's own item 7b) is
 * DESCOPED — no live `jira-project` resourceProvider exists in the rules
 * engine today (`RESOURCE_PROVIDERS`, src/rules/agent-key.ts), so there is
 * no live agent for a project-member watch to notify. `jiraKindLinkedItems`
 * below is deliberately a per-MATCH function returning a plain `LinkedItem[]`
 * so a future project-member source (once a live project-owning agent
 * exists, likely BUTCHR-433's job) can be unioned in alongside issuelinks/
 * parent/description/remote-links with no rework to the coalescer, rate cap,
 * or delivery below — none of which know or care where an item came from.
 *
 * ONE HOP ONLY (epic decision, not re-litigated here either): a linked
 * item's OWN further links are never chased. This module only ever diffs
 * the target's own status/summary/updated/labels, never re-runs discovery
 * against it.
 *
 * PER-TICK COALESCING: every changed/unreadable/removed Jira-kind link for
 * ONE owning resource, found in ONE poll tick, becomes exactly one
 * `{ linked: { events } }` NotifyReason and one `deps.notify` call — never
 * one per link. `runResourceLoop`'s own generic changedPrimary/changedRelated
 * mechanism (src/daemon/loop.ts) is deliberately NOT reused for this: it
 * decides and delivers per (changed key, watcher) pair, which is exactly the
 * one-nudge-per-link shape this story must NOT produce. `createRuleResourceType`
 * (src/rules/resource-type.ts) instead calls `runTick` once per poll, from
 * inside its own `discovery.related` (after `reconcileNow` has already run
 * that poll, so a just-spawned owning agent is live before this ever tries
 * to nudge it), and `runTick` calls `deps.notify` directly — the SAME
 * `GenericLoopDeps.notify`/`RuleResourceDeps.notify` function every other
 * delivery in this codebase already goes through (`notifyAgent` + `herd.nudge`,
 * wired once in src/daemon/index.ts), so the actual channel-push mechanism is
 * UNCHANGED IN SHAPE — only the call site and the message shape (built by
 * `linkedChangeNudge`, src/agents/change-nudge.ts) are new.
 *
 * PER-(OWNER, TARGET) BASELINES, NOT PER-TARGET: the same linked ticket can
 * be watched by more than one owning resource (e.g. two tickets both link
 * BUTCHR-9). A per-target-only baseline would let owner A's SUCCESSFUL
 * delivery silently advance the baseline out from under owner B's still-
 * outstanding, rate-capped notification — B would never hear about a change
 * it was genuinely owed. Keying every baseline by `(owner, target)` instead
 * means each owner's own view of "what have I already been told" is
 * independent, at the cost of one baseline entry per (owner, target) pair
 * rather than per target — accepted, since this fleet's scale is small (see
 * this story's own doc for the estimated call/row counts).
 *
 * RATE CAP AND "DELAYED, NOT LOST": a capped tick's per-(owner,target)
 * baselines and its owner's removed-link watch set are deliberately left
 * UNADVANCED (see `runTick`'s own `advance` closures below) — so the next
 * allowed tick re-runs the exact same comparison against the exact same
 * stale baseline and re-derives the same outstanding diff (plus anything
 * that changed again since), rather than needing a separate pending-event
 * queue. This is the same "advance state only once genuinely delivered"
 * discipline `own-writes.ts`'s own ledger uses for a different problem.
 *
 * ACCEPTED, STATED LIMITATION: baseline/watch-set entries for an owner whose
 * rule later disables `linkedEventing` (or whose resource leaves the rules
 * engine's matched set entirely) are never pruned — unbounded, if slow,
 * growth, the same accepted shape `linked-discovery-log.ts`'s own per-
 * resource fingerprint cache already has. Not a correctness bug (a stale
 * entry is simply never read again once its owner stops appearing in
 * `opted`), only a memory-growth note for whoever eventually revisits it.
 *
 * UNREADABLE IS TRANSITION-TRIGGERED, NOT REPEATED EVERY TICK (BUTCHR-436 PR
 * #399 review round 1): a target that stays unreadable across many ticks
 * must not itself keep causing a notify on every one of them — only the
 * FIRST tick it goes unreadable (or the first tick after it was last seen
 * readable) triggers a message. `unreadableSince` below tracks, per (owner,
 * target), whether the target was unreadable as of the last ADVANCED tick.
 * A still-unreadable target with no transition is still worth SHOWING once a
 * message is already going out for some other reason (a real change, a
 * removal, or a fresh transition), so it is carried as CONTEXT alongside
 * whatever triggered that message — never as the sole reason to send one.
 *
 * SEARCH FAILURE SKIPS THE WHOLE TICK, NOT "EVERYTHING READS AS UNREADABLE"
 * (BUTCHR-436 PR #399 review round 1): the earlier shape treated a rejected
 * batched `key in (...)` fetch identically to Jira silently omitting one bad
 * key — every requested target became a false "unreadable" line, waking
 * every opted-in owner over what might be a transient timeout. A search
 * failure instead skips event-building, notify, and every state advance for
 * this tick entirely (the WARNING below still logs) — the next tick's
 * batched fetch, if it succeeds, diffs against the SAME unadvanced baselines
 * and re-derives whatever was genuinely outstanding, so nothing is lost,
 * only delayed, exactly like a rate-capped tick.
 */
import type { JiraIssue, JiraRemoteLink } from "../atlassian/types.js";
import type { Rule } from "../rules/rules.js";
import type { LinkedChangeEvent, NotifyReason } from "../resources/types.js";
import { capLinkedItems, discoverLinkedItems, jiraBrowseKey, type LinkedItem } from "../resources/linked-discovery.js";
import { isDaemonLabelOnlyDiff } from "./diff.js";
import { rateCappedSuppressedLine } from "./suppressed-log.js";

/** The minimal shape this module needs from one owning resource's match — structurally satisfied by `RuleMatch` (src/rules/resource-type.ts) without importing it, avoiding a value/type import cycle between that module and this one. */
export interface LinkedEventingMatch {
  agentKey: string;
  rule: Rule;
  issue: JiraIssue;
}

/** Of every kind `discoverLinkedItems` can produce, only these are Jira-kind for THIS story (Confluence/GitHub/webpage are BUTCHR-428's). */
const JIRA_DISCOVERY_KINDS = new Set<LinkedItem["kind"]>(["issuelink", "parent", "jira-key"]);

/**
 * One match's Jira-kind linked items: issuelinks/parent/description-derived
 * keys (always — free, already-fetched data), plus, when `remoteLinks` is
 * given (i.e. the caller's rule opted into `linkedRemoteLinks`), every
 * remote link that resolves to a `.../browse/<KEY>` URL on this site. A
 * remote link that ISN'T a Jira browse URL (a GitHub PR, a webpage, a
 * Confluence page) is silently excluded here — out of scope for this story,
 * not a bug (`descriptionItems`' own scan already covers non-Jira description
 * URLs, and story 3/BUTCHR-428 owns that surface for remote links too).
 * De-duplicated by target, first occurrence wins (issuelink/parent/
 * description-derived beats a remote link resolving to the same key) — the
 * same convention `discoverLinkedItems` itself already uses.
 */
export function jiraKindLinkedItems(match: LinkedEventingMatch, remoteLinks: readonly JiraRemoteLink[] | undefined): LinkedItem[] {
  const discovered = discoverLinkedItems({
    issuelinks: match.issue.issuelinks,
    parent: match.issue.parent,
    description: match.issue.description,
    ownKey: match.issue.key,
  }).filter((i) => JIRA_DISCOVERY_KINDS.has(i.kind));
  const remoteKeyItems: LinkedItem[] = [];
  if (remoteLinks) {
    for (const l of remoteLinks) {
      const key = jiraBrowseKey(l.url);
      if (key && key !== match.issue.key) remoteKeyItems.push({ kind: "remote-link", target: key });
    }
  }
  const seen = new Set<string>();
  const out: LinkedItem[] = [];
  for (const item of [...discovered, ...remoteKeyItems]) {
    if (seen.has(item.target)) continue;
    seen.add(item.target);
    out.push(item);
  }
  return out;
}

interface Snapshot {
  status: string;
  summary: string;
  updated: string;
  labels: readonly string[];
}

const snapshotOf = (i: JiraIssue): Snapshot => ({ status: i.status, summary: i.summary, updated: i.updated, labels: i.labels });
/** A minimal fake `JiraIssue`, shaped only well enough for `isDaemonLabelOnlyDiff` (status/summary/labels) — never returned to a caller, never compared on any other field. */
const asIssue = (key: string, s: Snapshot): JiraIssue => ({ key, status: s.status, summary: s.summary, updated: s.updated, labels: [...s.labels], issuetype: "", assignee: null, parent: null });

function changeDetail(before: Snapshot, after: Snapshot): string {
  if (before.status !== after.status) return `status changed from "${before.status}" to "${after.status}"`;
  if (before.summary !== after.summary) return "summary changed";
  return "updated";
}

/** A sliding hour — the unit `maxLinkedTurnsPerHour` is denominated in. */
const SLIDING_WINDOW_MS = 60 * 60_000;

export interface LinkedEventingDeps {
  /** The SAME batched-search seam every other Jira-kind fetch in this codebase already uses (`RuleResourceDeps.search`) — ONE `key in (...)` call per tick covers every opted-in owner's Jira-kind linked targets combined, never one call per linked item. */
  search: (jql: string) => Promise<JiraIssue[]>;
  /** `AtlassianClient#remoteLinks` — called ONLY for a match whose rule has `linkedRemoteLinks: true`, never otherwise (BUTCHR-436's own knob contract: zero remote-link calls for a non-opted-in resource). Optional; omitted, no rule can ever opt into remote links (treated the same as a rule that doesn't). */
  remoteLinks?: (key: string) => Promise<JiraRemoteLink[]>;
  /** Own-write echo suppression — `createOwnWriteLedger#shouldSuppress` (src/jira-watch/own-writes.ts), called with the LINKED item's own key and the OWNING agent as watcher, so an agent's edit to something it links suppresses only for that agent, exactly as `LoopDeps.suppress` already documents for owned resources. Optional; omitted, nothing is ever suppressed as an echo. */
  suppress?: (key: string, updated: string, watcher: string) => boolean;
  /** The exact delivery seam every other notify in this codebase already uses — see this module's own top comment for why this is "UNCHANGED IN SHAPE". */
  notify: (agentKey: string, about: string, reason: NotifyReason) => void | Promise<void>;
  log?: (line: string) => void;
  /** Injectable clock, for a deterministic rate-cap test. Defaults to `Date.now`. */
  now?: () => number;
}

export interface LinkedEventingState {
  /**
   * Runs one poll tick's worth of linked-change eventing over `matches` —
   * every rule-matched owning resource this poll, whatever their
   * `linkedEventing` setting (this function filters to `true` itself, same
   * as `logLinkedDiscovery` does for its own unconditional discovery pass).
   * Never throws on a fetch failure (batched search, or a per-resource
   * remote-links call) — both fail open, logged once, so one broken linked
   * item or one down remote-links call never blocks every OTHER owner's
   * tick. Awaited to completion (every `notify` call included) before
   * returning, so a caller's own try/catch (see `createRuleResourceType`)
   * sees a failure from `notify` itself, not a dangling promise.
   */
  runTick(matches: readonly LinkedEventingMatch[], deps: LinkedEventingDeps): Promise<void>;
}

/** A fresh, empty linked-eventing state — one instance per daemon lifetime (mirrors `createLinkedDiscoveryTracker`/`createOwnWriteLedger`'s own "one instance, closed over, reused every poll" shape). */
export function createLinkedEventingState(): LinkedEventingState {
  const baselines = new Map<string, Snapshot>();
  const watchSets = new Map<string, Map<string, string>>();
  const unreadableOwners = new Map<string, Set<string>>();
  const turns = new Map<string, number[]>();
  const baselineKey = (owner: string, target: string): string => `${owner} ${target}`;

  return {
    async runTick(matches, deps) {
      const now = deps.now ?? Date.now;
      const opted = matches.filter((m) => m.rule.linkedEventing === true);
      if (!opted.length) return;

      const perOwnerItems = new Map<string, LinkedItem[]>();
      for (const m of opted) {
        let remoteLinks: JiraRemoteLink[] | undefined;
        if (m.rule.linkedRemoteLinks === true && deps.remoteLinks) {
          try {
            remoteLinks = await deps.remoteLinks(m.issue.key);
          } catch (e) {
            deps.log?.(`  WARNING: [linked-eventing] remote-links fetch failed for ${m.agentKey} (${m.issue.key}): ${(e as Error)?.message ?? e}`);
          }
        }
        const { kept } = capLinkedItems(jiraKindLinkedItems(m, remoteLinks), m.rule.maxLinkedItems);
        perOwnerItems.set(m.agentKey, kept);
      }

      // ONE combined batched fetch for every Jira-kind linked target across every opted owner this tick — never one call per linked item, never one per owner.
      const allTargets = new Set<string>();
      for (const items of perOwnerItems.values()) for (const i of items) allTargets.add(i.target);
      let fetched: JiraIssue[] = [];
      let searchFailed = false;
      if (allTargets.size) {
        try {
          fetched = await deps.search(`key in (${[...allTargets].join(",")})`);
        } catch (e) {
          searchFailed = true;
          deps.log?.(`  WARNING: [linked-eventing] batched linked-item fetch failed for ${allTargets.size} key(s), skipping this tick for every opted-in owner: ${(e as Error)?.message ?? e}`);
        }
      }
      // A failed batched fetch means this tick has no trustworthy data at all
      // for any opted owner's linked targets — see this module's own top
      // comment ("SEARCH FAILURE SKIPS THE WHOLE TICK"). No events, no
      // notify, no baseline/watch-set/unreadable-state advance: the next
      // tick's fetch, if it succeeds, diffs against the same unadvanced state
      // and re-derives whatever was genuinely outstanding.
      if (searchFailed) return;
      const byKey = new Map(fetched.map((i) => [i.key, i]));

      // Removed-link candidates, against each owner's watch set as of the LAST poll this ran for it — read before anything below mutates that set.
      const removedByOwner = new Map<string, LinkedChangeEvent[]>();
      for (const m of opted) {
        const prevSet = watchSets.get(m.agentKey);
        if (!prevSet) continue;
        const keptTargets = new Set(perOwnerItems.get(m.agentKey)!.map((i) => i.target));
        const gone: LinkedChangeEvent[] = [];
        for (const [target, kind] of prevSet) if (!keptTargets.has(target)) gone.push({ target, kind, detail: "no longer linked" });
        if (gone.length) removedByOwner.set(m.agentKey, gone);
      }

      const eventsByOwner = new Map<string, LinkedChangeEvent[]>();
      const advanceByOwner = new Map<string, () => void>();

      for (const m of opted) {
        const kept = perOwnerItems.get(m.agentKey)!;
        const wasUnreadable = unreadableOwners.get(m.agentKey) ?? new Set<string>();
        const triggering: LinkedChangeEvent[] = [...(removedByOwner.get(m.agentKey) ?? [])];
        const stillUnreadable: LinkedChangeEvent[] = [];
        const toAdvance: Array<() => void> = [];
        const nowUnreadable = new Set<string>();

        for (const item of kept) {
          const issue = byKey.get(item.target);
          if (!issue) {
            // Requested in this tick's batched fetch but not returned — Jira's
            // `key in (...)` silently omits an unreadable/nonexistent key
            // rather than erroring per-key, so no HTTP status is available
            // here (unlike a per-resource remote-links failure, which DOES
            // carry one — see the WARNING above; that failure is about the
            // OWNER's own remote-links list, a different fact from one
            // specific linked TARGET being unreadable). Only a fresh
            // transition into unreadable triggers; a target already known
            // unreadable is carried as context only — see this module's own
            // top comment.
            nowUnreadable.add(item.target);
            const event: LinkedChangeEvent = { target: item.target, kind: item.kind, detail: "unreadable" };
            if (wasUnreadable.has(item.target)) stillUnreadable.push(event);
            else triggering.push(event);
            continue;
          }
          if (wasUnreadable.has(item.target)) toAdvance.push(() => unreadableOwners.get(m.agentKey)?.delete(item.target)); // became readable again
          const snap = snapshotOf(issue);
          const bkey = baselineKey(m.agentKey, item.target);
          const before = baselines.get(bkey);
          if (!before) {
            toAdvance.push(() => baselines.set(bkey, snap)); // first sighting: seed silently, no event
            continue;
          }
          const changed = before.status !== snap.status || before.summary !== snap.summary || before.updated !== snap.updated;
          if (!changed) continue;
          if (isDaemonLabelOnlyDiff(asIssue(item.target, before), asIssue(item.target, snap))) {
            toAdvance.push(() => baselines.set(bkey, snap)); // real move, but daemon-label-only — not a real change here either
            continue;
          }
          if (deps.suppress?.(item.target, snap.updated, m.agentKey)) {
            toAdvance.push(() => baselines.set(bkey, snap)); // own-write echo
            continue;
          }
          triggering.push({ target: item.target, kind: item.kind, detail: changeDetail(before, snap) });
          toAdvance.push(() => baselines.set(bkey, snap));
        }

        if (nowUnreadable.size) {
          toAdvance.push(() => {
            const set = unreadableOwners.get(m.agentKey) ?? new Set<string>();
            for (const t of nowUnreadable) set.add(t);
            unreadableOwners.set(m.agentKey, set);
          });
        }

        // Still-unreadable context only ever rides a message some OTHER
        // trigger already earns — an unreadable-only tick with no transition
        // sends nothing (see this module's own top comment).
        if (triggering.length) eventsByOwner.set(m.agentKey, [...triggering, ...stillUnreadable]);
        advanceByOwner.set(m.agentKey, () => {
          for (const fn of toAdvance) fn();
          watchSets.set(m.agentKey, new Map(kept.map((i) => [i.target, i.kind])));
        });
      }

      for (const m of opted) {
        const advance = advanceByOwner.get(m.agentKey)!;
        const events = eventsByOwner.get(m.agentKey);
        if (!events?.length) { advance(); continue; }
        const max = m.rule.maxLinkedTurnsPerHour;
        if (max !== undefined) {
          const history = (turns.get(m.agentKey) ?? []).filter((t) => now() - t < SLIDING_WINDOW_MS);
          if (history.length >= max) {
            turns.set(m.agentKey, history);
            deps.log?.(rateCappedSuppressedLine(m.issue.key, m.agentKey, history.length, max));
            continue; // NOT advanced — next allowed tick re-detects everything still outstanding
          }
          history.push(now());
          turns.set(m.agentKey, history);
        }
        // Advanced only AFTER a successful notify (review round 1, non-
        // blocking note): a throwing notify leaves this owner's state
        // unadvanced too, so "delayed, not lost" holds for a notify failure
        // the same way it already does for a capped tick.
        await deps.notify(m.agentKey, m.agentKey, { linked: { events } });
        advance();
      }
    },
  };
}
