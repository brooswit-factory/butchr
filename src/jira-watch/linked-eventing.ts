/**
 * linked-eventing.ts — BUTCHR-436 (epic BUTCHR-421, story 2/4 of 4): makes a
 * change to a Jira-kind link discovered by story 1
 * (`discoverLinkedItems`/`capLinkedItems`, src/resources/linked-discovery.ts)
 * actually cause exactly one coalesced, rate-capped channel nudge to the
 * OWNING resource's agent — the mechanism this story exists to build. This
 * module only ever watches `issuelink`/`parent`/`jira-key`-kind targets
 * (already free — they ride the same `search()` fields story 1 uses) plus,
 * when a rule opts into `linkedRemoteLinks`, a Jira remote link that
 * resolves to a `.../browse/<KEY>` URL on this site (via
 * `jiraBrowseKey`) — a genuinely separate REST call per opted-in owning
 * resource, never fetched otherwise.
 *
 * BUTCHR-437 (epic BUTCHR-421, story 3/4) WIDENED THIS MODULE to ALSO drive
 * the three lightweight external pollers (Confluence page, GitHub issue/PR,
 * general webpage — `src/jira-watch/external-poll.ts`) over links
 * `descriptionItems` (src/resources/linked-discovery.ts) finds in a
 * resource's DESCRIPTION TEXT, gated by the new `linkedDescriptionLinks`
 * knob (independent of `linkedRemoteLinks`, which stays Jira-remote-link-only
 * — a non-Jira remote link is still out of scope, unchanged from story 2).
 * Every seam this widening touches is called out at its own site below
 * ("BUTCHR-437"); everything else in this file is story 2's, unmodified.
 *
 * SCOPE, UPDATED (BUTCHR-469 — the paragraph below is intentionally no
 * longer what it once said; see git history if the earlier "descoped"
 * framing is wanted): child/project-member discovery, deferred in BUTCHR-436
 * for lack of a live `jira-project` resourceProvider, now HAS one
 * (BUTCHR-425/BUTCHR-444, PR #407) and is implemented here as
 * `ProjectLinkedEventingMatch` — a second, `JiraIssue`-free match shape
 * `runTick` accepts via its own optional third parameter, reusing the EXACT
 * SAME coalescer/rate-cap/notify below with no forked delivery path.
 * `jiraKindLinkedItems` below was deliberately kept a per-MATCH function
 * returning a plain `LinkedItem[]`, exactly so this project-member source
 * could be unioned in without rework — see `ProjectLinkedEventingMatch`'s
 * own doc comment for the full design (member-discovery watermark, managed
 * links, and the member/managed-link dedup and removal-tracking rules).
 *
 * FACTORY-53/FACTORY-71 (epic FACTORY-51): a THIRD source of
 * `ProjectLinkedEventingMatch`es, alongside the `jira-project` owner above —
 * a managed-session agent that opts one or more Jira projects into this same
 * machinery via its own `linkedEventingProjects` field
 * (src/resources/session-definition.ts). Built by
 * `sessionDefinitionProjectMatches` (src/rules/session-definition-type.ts),
 * never here — this module stays ignorant of managed-session definitions
 * entirely, exactly as it already stays ignorant of `jira-project`'s own
 * `ProjectMatch` shape (src/rules/jira-project-type.ts). The one seam this
 * addition needed INSIDE this module is `ProjectLinkedEventingMatch.notifyAgentKey`
 * (see its own doc comment) — everything else, including the opt-in gate
 * (`m.rule.linkedEventing === true`) and the rate cap, is reused completely
 * unchanged: a managed-session match's `rule` is a fixed, shared, non-editable
 * `Rule`-shaped value with `linkedEventing: true` (naming a project in
 * `linkedEventingProjects` already IS the opt-in — there is no separate
 * per-session boolean to carry), so this module never needed a second,
 * looser gate.
 *
 * ONE HOP ONLY (epic decision, not re-litigated here either): a linked
 * item's OWN further links are never chased. This module only ever diffs
 * the target's own status/summary/updated/labels (Jira-kind) or its own
 * external fingerprint (BUTCHR-437's three kinds), never re-runs discovery
 * against it.
 *
 * PER-TICK COALESCING: every changed/unreadable/removed link — Jira-kind AND
 * (BUTCHR-437) the three external kinds alike — for ONE owning resource,
 * found in ONE poll tick, becomes exactly one `{ linked: { events } }`
 * NotifyReason and one `deps.notify` call — never one per link.
 * `runResourceLoop`'s own generic changedPrimary/changedRelated mechanism
 * (src/daemon/loop.ts) is deliberately NOT reused for this: it decides and
 * delivers per (changed key, watcher) pair, which is exactly the
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
 * BUTCHR-437: `baselines` below is ONE Map holding a discriminated union
 * (`Baseline` — a `"jira"` snapshot or an `"external"` fingerprint) rather
 * than two parallel stores, per this ticket's own instruction to EXTEND the
 * existing per-(owner,target) baseline shape rather than add a second one.
 * A Jira-kind target (a Jira issue key) and an external target (a URL, or a
 * canonical `owner/repo#n` GitHub ref) never collide in that shared
 * `${owner} ${target}` key space, so the two variants never contend for the
 * same entry. Deliberately NO cross-owner dedup of external fetches (unlike
 * the Jira-kind path's one shared batched search): each owner's external
 * poll is CONDITIONAL on that owner's OWN last-seen fingerprint (an ETag/
 * Last-Modified sent as `If-None-Match`/`If-Modified-Since`), and two owners
 * watching the same external target can legitimately hold DIFFERENT
 * baselines (e.g. one was rate-capped last tick and never advanced) — a
 * shared fetch could only carry one owner's conditional headers and would
 * risk answering "unchanged" to the other owner's genuinely stale baseline.
 * Costed and accepted for this fleet's scale; noted in the PR as a real
 * (if unlikely at this scale) source of duplicate external requests when
 * several owners share one target.
 *
 * RATE CAP AND "DELAYED, NOT LOST": a capped tick's per-(owner,target)
 * baselines and its owner's removed-link watch set are deliberately left
 * UNADVANCED (see `runTick`'s own `advance` closures below) — so the next
 * allowed tick re-runs the exact same comparison against the exact same
 * stale baseline and re-derives the same outstanding diff (plus anything
 * that changed again since), rather than needing a separate pending-event
 * queue. This is the same "advance state only once genuinely delivered"
 * discipline `own-writes.ts`'s own ledger uses for a different problem.
 * BUTCHR-437: `lastExternalPollAt` (this story's own poll-cadence gate,
 * below) is DELIBERATELY NOT part of this "advance only on success"
 * discipline — it records that an external fetch was ATTEMPTED this tick,
 * independent of whether this tick's eventual notify gets rate-capped,
 * because re-fetching sooner than `linkedPollIntervalMs` would not change
 * the outcome either way and would defeat the entire reason the knob exists
 * (bounding how often a real network call goes out per owner).
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
 * BUTCHR-437: the three external kinds follow the IDENTICAL rule, using the
 * SAME `unreadableOwners` store — a 404/403/DNS-failure/unsupported-host/
 * refused-redirect on a Confluence/GitHub/webpage target is "unreadable" in
 * exactly the sense this comment already describes for a Jira-kind target,
 * and a transient failure (5xx/timeout/network error) is handled by the
 * SAME "skip this item this tick, no advance" discipline the Jira-kind
 * search-failure path below already established — see `external-poll.ts`'s
 * own top comment for why a response over the size cap is transient too,
 * never "unreadable".
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
 * only delayed, exactly like a rate-capped tick. This applies ONLY to the
 * Jira-kind batched search (a single shared call whose failure says nothing
 * about any one target) — an external poller's per-target failure is
 * necessarily scoped to that one target already (see above), so it skips
 * just that item, not the whole tick.
 *
 * FACTORY-137 (task 2/2 of story FACTORY-22) — PUSH MODE, added on top of
 * everything above without changing any of it when unconfigured (AC1's own
 * "byte-identical to today" requirement, proven by every existing test in
 * this file's own test siblings passing UNMODIFIED):
 *
 * D1 HINT, NOT STATE. A Catamorbius notification never updates a baseline
 * directly — it only marks a watch key dirty (`markDirty`, called by the
 * daemon's push controller, `src/catamorbius/push-controller.ts`). A dirty
 * target is then fetched through the EXACT SAME fetchers, diffed against
 * the EXACT SAME baseline, by the EXACT SAME code as a regular tick — never
 * a second webhook-payload-to-snapshot path. Duplicates and out-of-order
 * delivery are harmless by construction because the diff is idempotent.
 *
 * D2 COVERAGE. A (target, owner) pair is COVERED iff: the target maps to a
 * Catamorbius watch key (`../catamorbius/mapping.ts` — only jira-kind and
 * github-issue/github-pr items ever do; Confluence/webpage/filesystem/
 * jira-project stay polling-only, unconditionally, forever), its provider is
 * enabled (`deps.push.isProviderEnabled`), and the connection is covering
 * right now (`deps.push.isCoveringNow` — live, or reconnecting within grace;
 * see the push controller for the full state machine). A covered target is
 * fetched in a pass only if it has no baseline yet (for ANY of its owners),
 * OR is dirty, OR its TTL has expired, OR a resync is pending — otherwise it
 * is SKIPPED: no fetch at all, and (T1) the per-item diff loop below treats
 * a skipped item as skipped, never "unreadable".
 *
 * D3 PROMPT PASS. `runDirtyPass()` re-runs the SAME per-owner fetch/diff/
 * notify pipeline as `runTick`, restricted to whatever is currently dirty
 * or resync-pending, reusing the LAST `runTick` call's own already-computed
 * `ownerEntries`/`perOwnerItems`/etc. (`lastPassContext` below) — no fresh
 * discovery (no member search, no remote-links call, no managed-link
 * listing). Serialized against `runTick` via `serialize()` below (a plain
 * promise-chain mutex) so the two can never double-diff the same baselines.
 *
 * D4 TTL. `ttlLastRefreshAt`, keyed by WATCH KEY (not raw target — two
 * items with different raw targets but the same watch key, e.g. a
 * github-issue and a github-pr sharing one number, share one TTL clock,
 * exactly like they already share one watch key everywhere else). Reset on
 * every SETTLED fetch of a covered target (ok, not-modified, or unreadable —
 * never a transient error, never a failed batch).
 *
 * D5 DISCONNECT/GRACE/RESYNC. Owned by the push controller, not this module
 * — `deps.push.isCoveringNow()` already encodes "live, or reconnecting
 * within grace"; `requestResync()` (called by the controller on a resync
 * signal, or on reconnecting after having been live before) sets a sticky
 * `resyncPending` flag that forces every currently covered target into the
 * next pass regardless of dirty/TTL state, and is cleared only once a pass
 * runs WHILE covering with no search failure (never consumed by a pass that
 * ran while nothing was covered).
 *
 * D6 DEDUP/DEBOUNCE. Transport-level dedup (recent CloudEvent ids, a
 * seq-monotonic guard) lives in the push controller, one layer up — by the
 * time `markDirty` is called here, D1's own idempotent diff is the
 * correctness guarantee regardless. The trailing debounce (D6's own "N
 * notifications become one fetch") lives HERE, in `runDirtyPass` itself
 * (see its own doc comment) — every `markDirty` call is instant and cheap;
 * only the resulting PASS is debounced.
 *
 * D7 MISSED-BY-STREAM. A genuine change found by a TTL- or resync-forced
 * fetch of a target that was NOT dirty at fetch start is delivered as the
 * exact same `LinkedChangeEvent` polling would produce — provenance is
 * logged (one rate-limited WARNING, name-only, never payload contents) and
 * counted (`stats().streamMissed`), never carried in the event itself.
 *
 * T1-T12 (this ticket's own named traps) are each called out at their own
 * fix site below, by name, so a reviewer can find them directly.
 */
import type { JiraComment, JiraIssue, JiraRemoteLink } from "../atlassian/types.js";
import type { Rule } from "../rules/rules.js";
import type { LinkedChangeEvent, NotifyReason } from "../resources/types.js";
import { capLinkedItems, descriptionItems, discoverLinkedItems, jiraBrowseKey, type LinkedItem, type LinkedItemKind } from "../resources/linked-discovery.js";
import { jiraProjectOwnerRef, jiraWorkItemOwnerRef, managedLinkedItems, nativeJiraRefs } from "../resources/link-reconcile.js";
import type { LinkStore } from "../resources/link-store.js";
import { watchKeyForResource, type WatchKey } from "../catamorbius/mapping.js";
import { isDaemonLabelOnlyDiff, excludeBookkeepingComments } from "./diff.js";
import { watchedKeys } from "./routes.js";
import { rateCappedSuppressedLine } from "./suppressed-log.js";
import {
  pollConfluencePage, pollFilesystem, pollGithubLink, pollWebpage,
  type ConfluencePollDeps, type FilesystemPollDeps, type GithubConditionalDeps, type PollVerdict, type WebpagePollDeps,
} from "./external-poll.js";

/** The minimal shape this module needs from one owning resource's match — structurally satisfied by `RuleMatch` (src/rules/resource-type.ts) without importing it, avoiding a value/type import cycle between that module and this one. */
export interface LinkedEventingMatch {
  agentKey: string;
  rule: Rule;
  issue: JiraIssue;
}

/**
 * BUTCHR-469: a `jira-project` owning resource's own match shape — no
 * `JiraIssue` (a project has none of its own); `projectKey` names the Jira
 * project this owner watches. The project-owner analogue of
 * `LinkedEventingMatch` — reuses the EXACT SAME `runTick` (coalescer, rate
 * cap, notify) via `runTick`'s own optional third parameter, never a forked
 * delivery path (the DoD's own instruction). Two item sources feed a
 * project owner's watch, both unioned into the same per-(owner,target)
 * diff/notify machinery `jiraKindLinkedItems`/`managedLinkedItems` already
 * feed for an issue owner:
 *
 * 1. MEMBER DISCOVERY: `project = <projectKey> AND updated >= "-<N>m"` (a
 *    JQL RELATIVE date literal, never an absolute one — see `runTick`'s own
 *    per-project-owner item gathering for why: it lets Jira itself resolve
 *    "N minutes ago" in whatever timezone it likes, so this module never has
 *    to reproduce that computation or risk skewing it), one watermark per
 *    project owner (`createLinkedEventingState`'s own `projectWatermarks`
 *    map, in-memory only — reset by a daemon restart, same "in-memory,
 *    lost-on-restart" shape `baselines`/`watchSets` already have).
 *    NO HISTORICAL FLOOD: a project owner's FIRST sighting (no watermark
 *    yet — true on first tick and after every restart) seeds the watermark
 *    to "now" and searches NOTHING that tick; only from the next tick
 *    onward does the search run at all. DELAYED, NOT LOST: the watermark
 *    only actually advances (`runTick`'s own deferred `toAdvance` — this
 *    owner's `advance()` closure) once this tick's events are genuinely
 *    delivered or safely consumed (not rate-capped away, not lost to a
 *    search failure or to `maxLinkedItems` capping a member away — see
 *    "CAPPING" below) — a failed member search leaves it unadvanced, fails
 *    open, is logged, and never blocks any other owner or this owner's OWN
 *    managed-link source.
 *    A MEMBER'S FIRST APPEARANCE IS ITSELF THE CHANGE: unlike a managed or
 *    native link (silently seeded on first sighting, since simply being
 *    watched carries no implication that it just changed), the window
 *    search above only EVER returns a target whose `updated` is at or after
 *    the watermark — so a member target with no existing per-(owner,target)
 *    baseline is reported as a genuine event (`"updated since <watermark>"`,
 *    or a real field diff if a later tick's re-appearance already has one
 *    to diff against), never seeded silently. Silently seeding it would
 *    swallow the very change that made it appear in the search at all —
 *    permanently, since it may never satisfy a later `updated >= <window>`
 *    again if nothing further changes it. See `runTick`'s own
 *    `memberTargetsByOwner` for the per-item mechanism.
 *    CAPPING: a MANAGED link `maxLinkedItems` capped away is safe to drop
 *    for just this tick (the full managed-link collection is re-listed
 *    every tick regardless of any cap, so a capped one is simply a
 *    candidate again next tick). A MEMBER capped away is NOT, unless it is
 *    already stale (baselined, nothing new): it only appeared because it
 *    fell inside this tick's watermark window, and once the watermark
 *    advances past that window it may never reappear. So a FRESH-OR-CHANGED
 *    member capped away holds this owner's ENTIRE watermark advance for the
 *    tick (not merely its own item) — the next tick re-runs the identical
 *    window. `ORDER BY updated ASC` alone does NOT prevent starvation here
 *    (an already-delivered member's own `updated` never moves, so it keeps
 *    sorting right back to the front of the still-over-inclusive held
 *    window) — every member candidate is additionally RANKED by whether it
 *    already has a matching baseline, so a genuinely fresh-or-changed
 *    member always wins a scarce slot over an already-known, unchanged one.
 *    This makes the backlog drain monotonically under sustained cap
 *    pressure, never starve a tail forever. See `runTick`'s own
 *    `freshOrChangedMembers`/`freshOrChangedTargets`.
 * 2. MANAGED LINKS: `brooswit.butchr.links` (FACTORY-8's project-property
 *    link store), reconciled via the SAME `managedLinkedItems` FACTORY-9
 *    already built for an issue owner, with `nativeRefs: []` (a project has
 *    no structural native links of its own — no issuelinks/parent) so
 *    every managed link is "managed"-origin and watched. A failed
 *    link-store read fails open (logged), independent of member discovery.
 *
 * DEDUP: a target that is BOTH a project member and a managed-link target
 * is de-duplicated to ONE `LinkedItem`/ONE event line per tick (first
 * occurrence wins, same convention `discoverLinkedItems` itself already
 * uses).
 *
 * REMOVAL TRACKING IS SCOPED TO MANAGED LINKS ONLY: a member issue that
 * simply falls outside the current watermark window (nothing changed
 * recently) is NOT "no longer linked" — it is still a project member,
 * just not recently touched — so member-sourced items never participate in
 * `runTick`'s watch-set-based removal detection; only managed-link-sourced
 * items do (a genuine removal from `brooswit.butchr.links` still fires
 * "no longer linked", exactly as it does for an issue owner's managed
 * links). See `runTick`'s own `managedTargetsByOwner`/`trackedKept`.
 *
 * COMMENT EVENTS: a "comment event" for a project owner is the SAME
 * per-target comment-cursor diff FACTORY-9 already built for any Jira-kind
 * linked target (`JiraSnapshot.commentCursor`, `deps.comments`), applied
 * uniformly to both member issues and managed-link targets — reusing the
 * existing mechanism unchanged rather than inventing a new "project
 * comment" concept (Jira itself has none; see `docs/provider-capabilities.md`).
 */
export interface ProjectLinkedEventingMatch {
  agentKey: string;
  rule: Rule;
  projectKey: string;
  /**
   * FACTORY-53/FACTORY-71: the REAL agent this match's coalesced nudge is
   * delivered to, when it differs from `agentKey` above. Every existing
   * `jira-project` caller leaves this absent — for that owner, the watched
   * project's own identity IS both the state-owning key and the notified
   * agent, so `agentKey` is used for both, byte-identical to pre-FACTORY-71
   * behaviour (see `runTick`'s own `ownerEntries` construction below).
   *
   * A managed-session agent that opts into one or more Jira projects via
   * `linkedEventingProjects` (src/resources/session-definition.ts) needs
   * `agentKey` to be a synthetic, per-(session, project) identity instead:
   * every map in `runTick` below (`baselines`, `watchSets`, `turns`,
   * `projectWatermarks`, ...) is keyed by `agentKey` ALONE, so a session
   * opted into more than one project — feeding two matches that both used
   * the session's own real agent key as `agentKey` — would have the second
   * project's per-tick state silently OVERWRITE the first's in every one of
   * those maps, permanently losing that project's watch. Giving each
   * (session, project) pair its own `agentKey` keeps their state
   * independent (own watermark, own rate-cap bucket); this field then says
   * where the resulting nudge actually goes — the session's own real agent
   * key, which is also what `herd.nudge`'s own freeze check
   * (`instanceFreezeStore.assertRunnable`) is keyed on, so a frozen session
   * is never nudged regardless of which project's watch fired. See
   * `sessionDefinitionProjectMatches` (src/rules/session-definition-type.ts)
   * for the one caller that sets this.
   */
  notifyAgentKey?: string;
}

/** Of every kind `discoverLinkedItems` can produce, only these are Jira-kind for THIS module's Jira-diffing path (Confluence/GitHub/webpage are BUTCHR-437's, driven by the external-poll.ts path below). */
const JIRA_DISCOVERY_KINDS = new Set<LinkedItemKind>(["issuelink", "parent", "jira-key"]);

/**
 * BUTCHR-437: the kinds `external-poll.ts` knows how to poll via a per-item
 * fetch — everything `descriptionLinkedItems` below can ever return, PLUS
 * (FACTORY-9) `"filesystem"`, which `descriptionLinkedItems` never produces
 * (see `LinkedItemKind`'s own doc comment, src/resources/linked-discovery.ts)
 * but which reuses this EXACT polling/cadence/baseline machinery unchanged —
 * `pollExternalItem` below is what actually dispatches `"filesystem"` to
 * `pollFilesystem` rather than an HTTP-shaped poller.
 */
const EXTERNAL_DISCOVERY_KINDS = new Set<LinkedItemKind>(["confluence", "github-issue", "github-pr", "webpage", "filesystem"]);

/**
 * FACTORY-137 (D2): the Catamorbius provider a coverage-eligible item's
 * watch key belongs to, or `null` for a kind Catamorbius has no adapter for
 * (Confluence/webpage/filesystem — `jira-project` never reaches here at all,
 * it has no `LinkedItem` kind of its own). Reuses `../catamorbius/mapping.ts`'s
 * own `watchKeyForResource` — the ONE identity model this ticket's own goal
 * statement requires ("a consumer of a change event cannot tell which
 * mechanism produced it" starts with never inventing a second identity for
 * the same resource).
 */
function pushWatchKeyFor(item: LinkedItem): { key: WatchKey; provider: "jira" | "github" } | null {
  if (JIRA_DISCOVERY_KINDS.has(item.kind)) {
    const key = watchKeyForResource({ kind: "jira-key", target: item.target });
    return key ? { key, provider: "jira" } : null;
  }
  if (item.kind === "github-issue" || item.kind === "github-pr") {
    const key = watchKeyForResource({ kind: item.kind, target: item.target });
    return key ? { key, provider: "github" } : null;
  }
  return null;
}

/**
 * One match's Jira-kind linked items: issuelinks/parent/description-derived
 * keys (always — free, already-fetched data), plus, when `remoteLinks` is
 * given (i.e. the caller's rule opted into `linkedRemoteLinks`), every
 * remote link that resolves to a `.../browse/<KEY>` URL on this site. A
 * remote link that ISN'T a Jira browse URL (a GitHub PR, a webpage, a
 * Confluence page) is silently excluded here — out of scope for THIS
 * function (`descriptionItems`' own scan already covers non-Jira
 * description URLs, and BUTCHR-437's `descriptionLinkedItems` below feeds
 * those to the external pollers; a non-Jira REMOTE link, specifically,
 * stays out of scope even after BUTCHR-437 — see `linkedDescriptionLinks`'s
 * own doc comment on `Rule`, src/rules/rules.ts, for why). De-duplicated by
 * target, first occurrence wins (issuelink/parent/description-derived beats
 * a remote link resolving to the same key) — the same convention
 * `discoverLinkedItems` itself already uses.
 *
 * BUTCHR-472: a target `watchedKeys(match.issue.issuelinks)`
 * (`src/jira-watch/routes.ts`) already routes for THIS SAME owning key via
 * the pre-existing `related:` notify path — an Implements link with the
 * other end on the IMPLEMENTER side (`otherEnd === "outward"`), i.e. a boss
 * hearing what implements it — is excluded here, of whatever `LinkedItem`
 * kind it happens to surface as (issuelink/parent/jira-key/remote-link),
 * so this module never re-derives and re-notifies the SAME (owner, target)
 * pair `related:` already delivers independently. Both paths read off the
 * SAME `watchedKeys` function (never a second, possibly-drifting
 * definition of "already routed"). This is deliberately NOT symmetric:
 * `watchedKeys` only ever returns the outward/implementer side, so a
 * worker's own Implements link to ITS boss (`otherEnd === "inward"`, the
 * reverse direction `routes.ts` itself documents as excluded from
 * `related:`) is never in this set and is therefore untouched — see this
 * ticket's PR for why that direction is left exactly as it was.
 */
export function jiraKindLinkedItems(match: LinkedEventingMatch, remoteLinks: readonly JiraRemoteLink[] | undefined): LinkedItem[] {
  const routedByRelated = new Set(watchedKeys(match.issue.issuelinks ?? []));
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
    if (seen.has(item.target) || routedByRelated.has(item.target)) continue;
    seen.add(item.target);
    out.push(item);
  }
  return out;
}

/**
 * BUTCHR-437: one match's Confluence/GitHub-issue/GitHub-PR/webpage links
 * found in DESCRIPTION TEXT ALONE (`descriptionItems`,
 * src/resources/linked-discovery.ts) — never issuelinks/parent (which can
 * only ever be Jira-kind) and never a Jira remote link (out of scope — see
 * `jiraKindLinkedItems`'s own doc comment above). Callers gate this behind
 * `rule.linkedDescriptionLinks === true`; this function itself does not
 * consult the rule, mirroring `jiraKindLinkedItems`'s own "caller decides
 * whether to call me at all" shape for `linkedRemoteLinks`.
 */
export function descriptionLinkedItems(match: LinkedEventingMatch): LinkedItem[] {
  return descriptionItems(match.issue.description ?? "").filter((i) => EXTERNAL_DISCOVERY_KINDS.has(i.kind));
}

/**
 * FACTORY-9: `commentCursor` is the newest comment id (`null` if the target
 * has no comments), populated ONLY when `LinkedEventingDeps.comments` is
 * wired — `undefined` means "not checked this tick" (the dep is omitted, or
 * this tick's fetch for this target failed and fails OPEN, same discipline
 * every other per-item fetch in this module already uses). A comment-count/
 * latest-id compare therefore only ever fires between two ticks that BOTH
 * checked (see `commentChangedBetween` below) — never a false positive from
 * comparing "unchecked" against a real value.
 */
interface JiraSnapshot { status: string; summary: string; updated: string; labels: readonly string[]; commentCursor: string | null | undefined }
/** BUTCHR-437: the discriminated union `baselines` below stores — see this module's own top comment ("ONE Map holding a discriminated union") for why this replaced the story-2-only `Snapshot` alias. */
type Baseline = { kind: "jira"; snapshot: JiraSnapshot } | { kind: "external"; fingerprint: string };

const snapshotOf = (i: JiraIssue, commentCursor?: string | null): JiraSnapshot => ({ status: i.status, summary: i.summary, updated: i.updated, labels: i.labels, commentCursor });
/** A minimal fake `JiraIssue`, shaped only well enough for `isDaemonLabelOnlyDiff` (status/summary/labels) — never returned to a caller, never compared on any other field. */
const asIssue = (key: string, s: JiraSnapshot): JiraIssue => ({ key, status: s.status, summary: s.summary, updated: s.updated, labels: [...s.labels], issuetype: "", assignee: null, parent: null });

/** FACTORY-9: `true` only when BOTH snapshots actually checked comments (neither `commentCursor` is `undefined`) AND the newest comment id differs — see `JiraSnapshot.commentCursor`'s own doc comment for why "unchecked" never compares as a change. */
function commentChangedBetween(before: JiraSnapshot, after: JiraSnapshot): boolean {
  return before.commentCursor !== undefined && after.commentCursor !== undefined && before.commentCursor !== after.commentCursor;
}

function changeDetail(before: JiraSnapshot, after: JiraSnapshot): string {
  if (before.status !== after.status) return `status changed from "${before.status}" to "${after.status}"`;
  // FACTORY-9: checked before the generic summary/"updated" fallback — a new
  // (or removed) comment is a specific, actionable fact worth naming, not
  // just folded into a bare "updated" the way it silently was before this
  // story added comment detection to this snapshot. BUTCHR-351 precedent
  // (`src/agents/change-nudge.ts`'s own `reasonClause`): `null` means the
  // newest comment slot is now empty — a deletion, not an addition.
  if (commentChangedBetween(before, after)) return after.commentCursor === null ? "had a comment removed" : "got a new comment";
  if (before.summary !== after.summary) return "summary changed";
  return "updated";
}

/** BUTCHR-437: the agent-facing detail phrase for a genuine external-kind change — `before`/`after` are the two opaque fingerprints (see `external-poll.ts`'s own doc comment); only Confluence's is human-meaningful (a version NUMBER), so only that kind names the two values. */
function externalChangeDetail(kind: LinkedItemKind, before: string, after: string): string {
  if (kind === "confluence") return `version changed from ${before} to ${after}`;
  if (kind === "webpage") return "changed";
  if (kind === "filesystem") return "changed"; // FACTORY-9: an mtime+size fingerprint is opaque, same as webpage's hash fallback
  return "updated"; // github-issue / github-pr — an ETag is opaque, no meaningful before/after text to show
}

/** BUTCHR-437: `unreadable`, or `unreadable (<status>)` when the poller actually got an HTTP status back — see `external-poll.ts`'s own `PollVerdict` doc comment for when `httpStatus` is and isn't present. Reuses the EXACT `linkedChangeNudge`/`notifyReasonTag` rendering path unchanged (BUTCHR-436's shared formatter already takes a free-text `detail` per event — see src/agents/change-nudge.ts) — this only changes what TEXT this module puts in that field, never the formatter itself, so the existing Jira-kind `unreadable` line (still bare, no status — Jira's batched search never carries one) is untouched. */
function unreadableDetail(httpStatus: number | undefined): string {
  return httpStatus === undefined ? "unreadable" : `unreadable (${httpStatus})`;
}

/** A sliding hour — the unit `maxLinkedTurnsPerHour` is denominated in. */
const SLIDING_WINDOW_MS = 60 * 60_000;

/**
 * BUTCHR-471 (epic BUTCHR-446): the two default caps applied wherever a cap
 * is READ (never at rule-parse time — see `effectiveMaxLinkedItems`/
 * `effectiveMaxLinkedTurnsPerHour` below), so no linked-eventing owner kind
 * (a `jira-work` rule, a `jira-project` rule, or a managed session opted in
 * via `linkedEventingProjects`) can run uncapped. An explicit
 * `maxLinkedTurnsPerHour`/`maxLinkedItems` on a rule always wins over the
 * default, in both directions (looser or tighter) — these constants only
 * fill in for a rule that leaves the field absent.
 *
 * Sourced from BUTCHR-450/BUTCHR-468's phase-2 measurement (window
 * 2026-09-25T18:39:27Z to ~2026-09-26T18:44Z, both Servy daemons, every
 * enabled `jira-work` rule already running with `maxLinkedTurnsPerHour: 2`
 * and `maxLinkedItems: 25`): delivered linked turns per agent per hour
 * stayed inside the cap in organic operation — median 2, p95 2, max 4, with
 * both buckets above 2 being daemon-restart artifacts (a restart resets
 * every agent's sliding window), observed independently on both daemons.
 * Nothing measured supports a looser default, and spend was never obtained
 * (admin-agentcost did not answer two requests), so there is no argument for
 * anything looser either. An operator can still raise or lower either value
 * per rule via the existing fields.
 */
export const DEFAULT_MAX_LINKED_TURNS_PER_HOUR = 2;
/** See `DEFAULT_MAX_LINKED_TURNS_PER_HOUR`'s own doc comment for where this number comes from. */
export const DEFAULT_MAX_LINKED_ITEMS = 25;

/** The turn-rate cap `runTick` actually enforces for one linked-eventing owner's rule — an explicit `rule.maxLinkedTurnsPerHour` always wins; absent falls back to `DEFAULT_MAX_LINKED_TURNS_PER_HOUR` (BUTCHR-471). Never `undefined`: unlike `capLinkedItems`'s own `max` parameter, there is deliberately no "uncapped" value this can resolve to. */
export function effectiveMaxLinkedTurnsPerHour(rule: Rule): number {
  return rule.maxLinkedTurnsPerHour ?? DEFAULT_MAX_LINKED_TURNS_PER_HOUR;
}

/** The item cap `runTick` actually enforces for one linked-eventing owner's rule — an explicit `rule.maxLinkedItems` always wins; absent falls back to `DEFAULT_MAX_LINKED_ITEMS` (BUTCHR-471). Never `undefined` for an OPTED-IN owner (every call site below only ever calls this from inside `opted`/`projectOpted`, both pre-filtered to `rule.linkedEventing === true`) — `capLinkedItems`'s own `max === undefined` ⇒ uncapped contract is unchanged; this function simply never hands it `undefined`. */
export function effectiveMaxLinkedItems(rule: Rule): number {
  return rule.maxLinkedItems ?? DEFAULT_MAX_LINKED_ITEMS;
}

/** FACTORY-137: how often the D7 "the event stream missed a change" WARNING may log, per instance — rate-limited (D7's own words), never per-occurrence; the counter (`stats().streamMissed`) is NEVER rate-limited, only the log line is. Not configurable: this is a log-noise bound, not a behavioural knob the ticket's own tunable list names. */
const STREAM_MISSED_LOG_COOLDOWN_MS = 60_000;

export interface LinkedEventingDeps {
  /** The SAME batched-search seam every other Jira-kind fetch in this codebase already uses (`RuleResourceDeps.search`) — ONE `key in (...)` call per tick covers every opted-in owner's Jira-kind linked targets combined, never one call per linked item. */
  search: (jql: string) => Promise<JiraIssue[]>;
  /** `AtlassianClient#remoteLinks` — called ONLY for a match whose rule has `linkedRemoteLinks: true`, never otherwise (BUTCHR-436's own knob contract: zero remote-link calls for a non-opted-in resource). Optional; omitted, no rule can ever opt into remote links (treated the same as a rule that doesn't). */
  remoteLinks?: (key: string) => Promise<JiraRemoteLink[]>;
  /** Own-write echo suppression — `createOwnWriteLedger#shouldSuppress` (src/jira-watch/own-writes.ts), called with the LINKED item's own key and the OWNING agent as watcher, so an agent's edit to something it links suppresses only for that agent, exactly as `LoopDeps.suppress` already documents for owned resources. Optional; omitted, nothing is ever suppressed as an echo. Jira-kind only — an external target has no own-write concept here (BUTCHR-437 does not extend echo suppression to Confluence/GitHub/webpage). */
  suppress?: (key: string, updated: string, watcher: string) => boolean;
  /** The exact delivery seam every other notify in this codebase already uses — see this module's own top comment for why this is "UNCHANGED IN SHAPE". */
  notify: (agentKey: string, about: string, reason: NotifyReason) => void | Promise<void>;
  log?: (line: string) => void;
  /** Injectable clock, for a deterministic rate-cap test. Defaults to `Date.now`. */
  now?: () => number;
  /** BUTCHR-437: `AtlassianClient#confluencePageVersion` — called ONLY for a match whose rule has `linkedDescriptionLinks: true` AND whose description names at least one Confluence page URL. Optional; omitted, every Confluence-kind item resolves `"error"` (skipped, retried next due tick, never reported unreadable) — the same "omitted means the feature silently never runs" shape `remoteLinks` above already has. */
  confluenceVersion?: ConfluencePollDeps["getVersion"];
  /** BUTCHR-437: the GitHub conditional-GET client `external-poll.ts`'s `pollGithubLink` needs. Optional; omitted, every GitHub-issue/PR-kind item resolves `"error"` the same way an omitted `confluenceVersion` does. */
  github?: GithubConditionalDeps;
  /** BUTCHR-437: the webpage conditional-GET client `external-poll.ts`'s `pollWebpage` needs. Optional; omitted, every webpage-kind item resolves `"error"` the same way an omitted `confluenceVersion` does. */
  webpage?: WebpagePollDeps;
  /** FACTORY-9: `external-poll.ts`'s `pollFilesystem` needs. Optional; omitted, every `filesystem`-kind item resolves `"error"` the same way an omitted `confluenceVersion` does — the same "omitted dep ⇒ feature silently never runs" shape every other optional dep here already has. */
  filesystem?: FilesystemPollDeps;
  /**
   * FACTORY-9 (epic FACTORY-3, story 3/3): the FACTORY-4 butchr-managed link
   * store (`src/resources/link-store.ts`) — reconciled, per opted-in owner,
   * against that owner's own native Jira links (`nativeJiraRefs`,
   * `src/resources/link-reconcile.ts`) via `mergeEffectiveLinks`, so a
   * managed-only link becomes a NEW watched item this tick (see
   * `managedLinkedItems`'s own doc comment for the full contract). Optional;
   * omitted, no managed link is ever reconciled into a watcher — the SAME
   * "omitted dep ⇒ feature silently never runs" shape as `remoteLinks`/
   * `confluenceVersion`/`github`/`webpage` above, so every existing
   * caller/test that doesn't wire this is completely unaffected.
   */
  linkStore?: LinkStore;
  /**
   * FACTORY-9: a Jira-kind target's own recent comments, newest first — the
   * SAME shape `IssueResourceDeps.comments` (`src/resources/issue.ts`)
   * already uses for an OWN issue's comment-based notify reason, reused here
   * so a LINKED Jira-kind target's snapshot (`JiraSnapshot.commentCursor`)
   * can positively distinguish "a new comment landed" from a bare `updated`
   * bump that could be caused by any other field this module doesn't
   * otherwise diff (priority, due date, …). ONE extra REST call per DISTINCT
   * Jira-kind target per tick (Jira has no batched comments endpoint,
   * unlike the shared `key in (...)` status/summary/updated/labels search
   * above) — a genuinely new per-tick cost, same shape `remoteLinks`
   * (BUTCHR-436) already accepted for the same reason. Optional; omitted,
   * `commentCursor` is never populated and every Jira-kind snapshot behaves
   * exactly as it did before this story (comment-driven changes still show
   * as a bare "updated", same as today).
   */
  comments?: (key: string) => Promise<readonly JiraComment[]>;
  /**
   * FACTORY-137 (D2): the read-only coverage query the daemon's Catamorbius
   * push controller exposes (`src/catamorbius/push-controller.ts`'s
   * `coverage`) — a minimal shape satisfied structurally, never imported,
   * for the same reason `LinkedEventingMatch`'s own doc comment gives
   * (avoiding a value/type import cycle). Optional; omitted (every existing
   * caller/test), push mode never activates for this tick — every
   * coverage-eligible item is treated exactly as if it were uncovered,
   * byte-identical to pre-FACTORY-137 behaviour.
   */
  push?: {
    isProviderEnabled(provider: "jira" | "github"): boolean;
    isCoveringNow(): boolean;
    ttlMsFor(provider: "jira" | "github"): number;
    /** D6: how long `runDirtyPass()` waits for more dirty marks before actually running a pass. */
    debounceMs(): number;
  };
  /** FACTORY-137: injected timer for `runDirtyPass`'s own debounce — same "injected, never global" contract every other timer/clock in this codebase already follows. Optional; omitted, the real global `setTimeout`/`clearTimeout` are used (every existing caller/test — this pair is only ever read when `push` is also configured). */
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

/** FACTORY-137 (AC7): this instance's OWN push-mode counters — see this module's "PUSH MODE" section for why these live per-instance (baselines are per instance) while the connection-level counters (notifications received, unmapped, deduped, degrades, resyncs) live on the push controller instead (`src/catamorbius/push-controller.ts`'s `stats()`). */
export interface LinkedEventingPushStats {
  dirtyMarks: number;
  onDemandPasses: number;
  ttlRefreshes: number;
  streamMissed: number;
}

export interface LinkedEventingState {
  /**
   * Runs one poll tick's worth of linked-change eventing over `matches` —
   * every rule-matched owning resource this poll, whatever their
   * `linkedEventing` setting (this function filters to `true` itself, same
   * as `logLinkedDiscovery` does for its own unconditional discovery pass).
   * Never throws on a fetch failure (batched search, a per-resource
   * remote-links call, or — BUTCHR-437 — one external poller call) — every
   * one fails open, logged once (Jira-kind) or simply skipped (external —
   * see this module's own top comment), so one broken linked item or one
   * down remote-links/external call never blocks every OTHER owner's tick,
   * nor even this SAME owner's other links. Awaited to completion (every
   * `notify` call included) before returning, so a caller's own try/catch
   * (see `createRuleResourceType`) sees a failure from `notify` itself, not
   * a dangling promise.
   *
   * BUTCHR-469: `projectMatches` is a third, OPTIONAL parameter — every
   * existing call site (and every existing test) that passes only
   * `(matches, deps)` keeps compiling and behaving byte-for-byte
   * identically (defaults to `[]`, filtered to nothing). See
   * `ProjectLinkedEventingMatch`'s own doc comment for what it adds and
   * `createJiraProjectResourceType` (src/rules/jira-project-type.ts) for the
   * one caller that supplies it.
   *
   * FACTORY-137 (D3): serialized against `runDirtyPass()` — see this
   * module's own `serialize()` helper.
   */
  runTick(matches: readonly LinkedEventingMatch[], deps: LinkedEventingDeps, projectMatches?: readonly ProjectLinkedEventingMatch[]): Promise<void>;
  /** FACTORY-137: called by the daemon's push controller when a Catamorbius event concerns this instance's watch key. Safe to call whether or not push mode is configured for this instance's own `runTick` deps (a mark that never matches a covered item is simply cleared, uncounted-toward-anything-fetched, the next time a pass considers it — see T9). */
  markDirty(key: WatchKey): void;
  /** FACTORY-137 (D5): marks every currently covered target resync-pending — the next pass (regular or on-demand) force-fetches all of them, once, then returns to skipping. */
  requestResync(): void;
  /**
   * FACTORY-137 (D3): re-runs the SAME pipeline as `runTick`, restricted to
   * this instance's own dirty/resync-pending targets, reusing the LAST
   * `runTick` call's own matches/deps (no fresh discovery). A no-op
   * (resolves immediately) if `runTick` has never run, or if nothing is
   * dirty/pending once the debounce settles. Debounced (D6): repeated calls
   * within `deps.push.debounceMs()` collapse into ONE actual pass, and every
   * caller's promise resolves once that one pass completes. Serialized
   * against `runTick`.
   */
  runDirtyPass(): Promise<void>;
  /** FACTORY-137 (AC7): this instance's own push-mode counters. */
  stats(): LinkedEventingPushStats;
}

/**
 * BUTCHR-437 (PR #401 review round 1): runs `tasks` through `fn` with AT
 * MOST `limit` in flight at once, never fully sequential (which let ONE
 * slow external poll — up to `WEBPAGE_MAX_REDIRECTS + 1` hops deep,
 * `external-poll.ts`'s own review-round-1 fix bounds each ITEM's own wait,
 * but a tick with many items still summed their waits one after another)
 * stall every OTHER item's, and every OTHER owner's, poll for this tick.
 * Order of `results` matches `tasks`, regardless of finish order. A single
 * `fn` rejection is NOT caught here — every caller in this module hands
 * `fn` a function that already resolves to a verdict object and never
 * throws (see `pollExternalItem` below), so this stays a plain concurrency
 * limiter, not an error-handling layer.
 */
async function mapLimit<T, R>(tasks: readonly T[], limit: number, fn: (task: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(tasks.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= tasks.length) return;
      results[i] = await fn(tasks[i]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

/** BUTCHR-437 (PR #401 review round 1): how many external polls (across every owner, every kind, combined) `runTick` runs concurrently — bounds the tick's own wall-clock cost without needing a full async task queue. */
const EXTERNAL_POLL_CONCURRENCY = 8;

/** BUTCHR-437: dispatches one already-discovered external-kind item to its own poller (`external-poll.ts`), threading the PRIOR fingerprint through for a genuine conditional GET (GitHub/webpage) — see `LinkedEventingDeps`'s own doc comments for what an omitted dep resolves to. Never throws — every branch below, and every poller it calls, resolves a `PollVerdict` (including `"error"`) instead. */
async function pollExternalItem(item: LinkedItem, priorFingerprint: string | undefined, deps: LinkedEventingDeps): Promise<PollVerdict> {
  // PR #401 review round 2: this function is `mapLimit`'s own `fn`, and
  // `mapLimit`'s doc comment says its `fn` never throws — every poller it
  // calls is now written to hold that invariant itself (see
  // `external-poll.ts`'s `readCapped`, `pollConfluencePage`, `pollGithubLink`
  // — every one already resolves `"error"` rather than rejecting), but this
  // try/catch is the belt to that suspenders: a poller that regresses on
  // that contract, or a bug in the dispatch below, must never let ONE
  // owner's ONE bad link throw `runTick`'s `Promise.all` and lose the
  // WHOLE tick's notifies for EVERY owner (Jira-kind changes included) —
  // exactly the failure mode round 2 found live in `readCapped`.
  try {
    if (item.kind === "confluence") {
      if (!deps.confluenceVersion) return { status: "error" };
      return await pollConfluencePage(item.target, { getVersion: deps.confluenceVersion });
    }
    if (item.kind === "github-issue" || item.kind === "github-pr") {
      if (!deps.github) return { status: "error" };
      return await pollGithubLink({ kind: item.kind, target: item.target }, priorFingerprint ?? null, deps.github);
    }
    if (item.kind === "webpage") {
      if (!deps.webpage) return { status: "error" };
      return await pollWebpage(item, priorFingerprint, deps.webpage);
    }
    if (item.kind === "filesystem") {
      if (!deps.filesystem) return { status: "error" };
      return await pollFilesystem(item.target, deps.filesystem);
    }
    return { status: "error" }; // unreachable — EXTERNAL_DISCOVERY_KINDS only ever produces the kinds above
  } catch (e) {
    deps.log?.(`  WARNING: [linked-eventing] external poll threw for ${item.kind} ${item.target}: ${(e as Error)?.message ?? e}`);
    return { status: "error" };
  }
}

/**
 * BUTCHR-469: how many whole minutes ago `watermark` was, for a JQL
 * RELATIVE date literal (`updated >= "-<N>m"`). Deliberately RELATIVE, never
 * an absolute `"yyyy-MM-dd HH:mm"` literal: Jira resolves an unqualified
 * absolute JQL date-time in the REQUESTING ACCOUNT's own configured
 * timezone, which this daemon does not know and must not guess at — a
 * relative literal sidesteps that entirely, since Jira itself computes
 * "N minutes before now" server-side. `Math.ceil`, never `round` or
 * `floor`, and a floor of 1: rounding UP means the window is always at
 * least as wide as the true elapsed time (over-inclusive, never
 * under-inclusive) — a redundant re-check of an already-seen, unchanged
 * issue costs nothing (the per-target baseline diff below silently no-ops
 * it), while under-covering could silently miss a genuine change. The
 * minimum of 1 guarantees a non-degenerate window even when `now` and
 * `watermark` are the same poll tick's own two timestamps a few
 * milliseconds apart.
 */
function jqlRelativeMinutesSince(watermark: number, now: number): number {
  return Math.max(1, Math.ceil((now - watermark) / 60_000));
}

/** A fresh, empty linked-eventing state — one instance per daemon lifetime (mirrors `createLinkedDiscoveryTracker`/`createOwnWriteLedger`'s own "one instance, closed over, reused every poll" shape). */
export function createLinkedEventingState(): LinkedEventingState {
  const baselines = new Map<string, Baseline>();
  const watchSets = new Map<string, Map<string, string>>();
  const unreadableOwners = new Map<string, Set<string>>();
  const turns = new Map<string, number[]>();
  // BUTCHR-437: last time (per owner) this state actually ATTEMPTED an
  // external-kind poll — see this module's own top comment ("delayed, not
  // lost") for why this is intentionally NOT part of the rate-cap's
  // "advance only on success" discipline.
  const lastExternalPollAt = new Map<string, number>();
  // BUTCHR-469: per-project-owner member-discovery watermark (ms since
  // epoch, this daemon's own clock) — see `ProjectLinkedEventingMatch`'s own
  // doc comment for the full "no historical flood, delayed not lost"
  // contract. In-memory only, same as every other map here: lost on daemon
  // restart, which is exactly what makes the "first sighting" branch below
  // also cover a restart, not only a genuinely new project owner.
  const projectWatermarks = new Map<string, number>();
  const baselineKey = (owner: string, target: string): string => `${owner} ${target}`;

  // FACTORY-137 PUSH MODE — every map below is this instance's OWN (D9:
  // baselines are per instance, so dirty/TTL/resync state is too).
  const dirty = new Set<WatchKey>();
  // T3: a per-key generation counter, bumped on every `markDirty` — lets a
  // pass tell whether a key it's about to credit as "delivered this pass"
  // is STILL the same dirty request it snapshotted at fetch start, so a
  // notification arriving mid-fetch is never silently cleared unseen.
  const dirtyGen = new Map<WatchKey, number>();
  let resyncPending = false;
  /** D4: last SETTLED-fetch time per watch key (shared across every raw target that maps to the same key). */
  const ttlLastRefreshAt = new Map<WatchKey, number>();
  const pushStats: LinkedEventingPushStats = { dirtyMarks: 0, onDemandPasses: 0, ttlRefreshes: 0, streamMissed: 0 };
  let lastStreamMissedLogAt = -Infinity;

  /** D3: the LAST `runTick` call's own discovery output — replayed by `runDirtyPass` without re-discovering anything. `undefined` until `runTick` has run at least once. */
  let lastPassContext: PassContext | undefined;

  // D3: serializes runTick and runDirtyPass against EACH OTHER — a plain
  // promise-chain mutex (not a queue with its own scheduling policy): each
  // call's own work is appended after whatever is already running,
  // regardless of which of the two functions scheduled it, so overlapping
  // executions can never double-diff the same baselines.
  let serialTail: Promise<void> = Promise.resolve();
  function serialize<T>(fn: () => Promise<T>): Promise<T> {
    const result = serialTail.then(fn, fn);
    serialTail = result.then(() => undefined, () => undefined);
    return result;
  }

  // D6: `runDirtyPass`'s own trailing debounce — every caller within the
  // window shares the ONE resulting pass's promise.
  let pendingDirtyPass: Promise<void> | undefined;
  let debounceTimerHandle: unknown;

  interface PassContext {
    ownerEntries: ReadonlyArray<{ agentKey: string; rule: Rule; label: string; notifyAgentKey: string }>;
    perOwnerItems: ReadonlyMap<string, readonly LinkedItem[]>;
    managedTargetsByOwner: ReadonlyMap<string, ReadonlySet<string>>;
    memberTargetsByOwner: ReadonlyMap<string, ReadonlySet<string>>;
    usedWatermarkByOwner: ReadonlyMap<string, number>;
    nextProjectWatermark: ReadonlyMap<string, number>;
    memberFetchedByKey: ReadonlyMap<string, JiraIssue>;
    // FACTORY-833 (replayed onto main): an owner whose remote-link or
    // managed-link fetch threw during THIS discovery — see the
    // removal-detection skip in `runOwnerPass` for why. Carried through
    // `PassContext` exactly like every other discovery-time fact above, so
    // an on-demand pass (which never re-runs discovery — D3's own contract)
    // replays the SAME last-known fetch-failure set instead of assuming
    // everything succeeded.
    linkFetchFailedOwners: ReadonlySet<string>;
    deps: LinkedEventingDeps;
  }

  /**
   * FACTORY-137: the shared fetch/diff/notify tail every `runTick` call
   * ends with, and every `runDirtyPass` call runs directly (no discovery).
   * `restrict`, when given, is the exact set of watch keys this pass may
   * touch — everything else in `ctx.perOwnerItems` is left completely
   * alone (not diffed, not removed, not baseline-touched): `runTick`
   * itself still relies on the FULL `kept` list for watch-set/removal
   * bookkeeping (see `trackedKept` below), so restricting what gets FETCHED
   * must never restrict what `advance()` commits to `watchSets`.
   */
  async function runOwnerPass(ctx: PassContext, restrict: ReadonlySet<WatchKey> | undefined): Promise<void> {
    const { ownerEntries, perOwnerItems, managedTargetsByOwner, deps } = ctx;
    const now = deps.now ?? Date.now;
    const push = deps.push;

    // The subset of `kept` that participates in watch-set/removal
    // tracking: everything, for an issue owner (unchanged pre-BUTCHR-469
    // behaviour). For a project owner, only its MANAGED-link items — see
    // `ProjectLinkedEventingMatch`'s own doc comment.
    const trackedKept = (agentKey: string, kept: readonly LinkedItem[]): LinkedItem[] => {
      const managedTargets = managedTargetsByOwner.get(agentKey);
      return managedTargets ? kept.filter((i) => managedTargets.has(i.target)) : [...kept];
    };

    // FACTORY-137 (D2): watch key + owning agent keys for every
    // coverage-eligible raw target across every owner — computed
    // unconditionally (cheap, pure) so the rest of this function can stay
    // ignorant of whether push is even configured.
    const watchKeyOfTarget = new Map<string, WatchKey>();
    const providerOfTarget = new Map<string, "jira" | "github">();
    const ownersOfTarget = new Map<string, Set<string>>();
    for (const entry of ownerEntries) {
      for (const item of perOwnerItems.get(entry.agentKey) ?? []) {
        const wk = pushWatchKeyFor(item);
        if (!wk) continue;
        watchKeyOfTarget.set(item.target, wk.key);
        providerOfTarget.set(item.target, wk.provider);
        let owners = ownersOfTarget.get(item.target);
        if (!owners) { owners = new Set(); ownersOfTarget.set(item.target, owners); }
        owners.add(entry.agentKey);
      }
    }

    // D2: which watch keys are ACTUALLY covered right now — empty unless
    // `deps.push` is configured. Independent of `restrict`.
    const coveredNow = new Set<WatchKey>();
    if (push) {
      for (const [target, wk] of watchKeyOfTarget) {
        const provider = providerOfTarget.get(target)!;
        if (push.isProviderEnabled(provider) && push.isCoveringNow()) coveredNow.add(wk);
      }
    }

    // T3: snapshot which watch keys are dirty, and their generation, BEFORE
    // this pass fetches anything — used both to decide what's "forced" and
    // to decide, at settle time, what's safe to clear.
    const dirtyAtStart = new Set(dirty);
    const dirtyGenAtStart = new Map(dirtyGen);
    const resyncActiveThisPass = resyncPending;

    // D4: which covered watch keys are forced by TTL expiry specifically
    // (as opposed to dirty/resync/first-sighting) — used only to count
    // `stats().ttlRefreshes`, never to decide inclusion (that's `coverageSkip`
    // below, which already folds TTL in).
    const ttlForced = new Set<WatchKey>();

    // D2: which covered watch keys are safe to SKIP entirely this pass —
    // ALWAYS empty when `restrict` is given (an on-demand pass never skips
    // what it was asked to touch; it simply never looks at anything else).
    const coverageSkip = new Set<WatchKey>();
    if (push && !restrict) {
      for (const [target, wk] of watchKeyOfTarget) {
        if (!coveredNow.has(wk)) continue;
        if (resyncActiveThisPass) continue; // forced
        if (dirtyAtStart.has(wk)) continue; // forced
        const provider = providerOfTarget.get(target)!;
        const lastRefresh = ttlLastRefreshAt.get(wk);
        const ttlExpired = lastRefresh === undefined || now() - lastRefresh >= push.ttlMsFor(provider);
        if (ttlExpired) {
          if (lastRefresh !== undefined) ttlForced.add(wk); // a genuine periodic refresh, not "never fetched while covered before"
          continue; // forced
        }
        const owners = ownersOfTarget.get(target)!;
        let allBaselined = true;
        for (const owner of owners) if (!baselines.has(baselineKey(owner, target))) { allBaselined = false; break; }
        if (!allBaselined) continue; // forced: first sighting for at least one owner
        coverageSkip.add(wk);
      }
    }

    const ignoredByRestrict = (item: LinkedItem): boolean => {
      if (!restrict) return false;
      const wk = watchKeyOfTarget.get(item.target);
      return !wk || !restrict.has(wk);
    };

    /** D4: settle (reset TTL, count a genuine TTL refresh) a covered target that was just fetched, regardless of outcome (ok/unreadable both count as "settled" per D4). Never called for an uncovered target. */
    const settleTtl = (target: string): void => {
      const wk = watchKeyOfTarget.get(target);
      if (!wk || !coveredNow.has(wk)) return;
      ttlLastRefreshAt.set(wk, now());
      if (ttlForced.has(wk)) pushStats.ttlRefreshes += 1;
    };

    /** D7: a genuine change found on a covered target that was NOT dirty at fetch start — the stream should have told us and didn't. Logs once per cooldown window, counts every time. */
    const noteIfStreamMissed = (target: string, kindLabel: string): void => {
      const wk = watchKeyOfTarget.get(target);
      if (!wk || !coveredNow.has(wk) || dirtyAtStart.has(wk)) return;
      pushStats.streamMissed += 1;
      const nowMs = now();
      if (nowMs - lastStreamMissedLogAt < STREAM_MISSED_LOG_COOLDOWN_MS) return;
      lastStreamMissedLogAt = nowMs;
      const provider = providerOfTarget.get(target) ?? "unknown";
      deps.log?.(`  WARNING: [catamorbius] the event stream missed a change (${kindLabel}, provider ${provider}) — found by a TTL/resync refresh instead`);
    };

    // ONE combined batched fetch for every Jira-kind linked target across
    // every opted owner this tick — never one call per linked item, never
    // one per owner. BUTCHR-437: filtered to Jira-kind targets only.
    // BUTCHR-469 (review round 1 fix): a target already fetched by a
    // project owner's own member-discovery search THIS SAME REGULAR TICK is
    // excluded — `ctx.memberFetchedByKey` holds that tick's own fresh
    // member objects, so re-fetching them via this generic key-in call
    // would be a redundant second fetch for data already in hand.
    //
    // FACTORY-137 review round 2 (P2) fix: that dedup is ONLY valid for a
    // genuine regular tick (`!restrict`). `ctx` for an on-demand pass
    // (`restrict` set) is `lastPassContext` — the PRIOR regular tick's own
    // `PassContext`, reused WITHOUT rediscovery per D3's own "no fresh
    // discovery calls" contract. Its `memberFetchedByKey` is therefore a
    // STALE snapshot from that prior tick, not "already fetched this
    // pass". Skipping a dirty member target's fetch here because it
    // appears in that stale map would silently diff it against its own
    // stale snapshot, find nothing, clear the dirty mark, and wait for the
    // next regular project tick to ever notice — the exact "never skip
    // without a trustworthy answer" discipline this module otherwise holds
    // everywhere else. So: apply the member-dedup only when NOT restricted;
    // an on-demand pass always re-fetches a dirty/resync-pending member
    // through this SAME generic batched call instead (no discovery call is
    // added — this is the ordinary per-tick Jira-kind fetch every target
    // already goes through, just no longer skipped for a member specifically
    // because of now-stale data).
    // FACTORY-137 (D2/T1): a covered, skippable target is excluded too —
    // see `coverageSkip` above; the per-item loop below treats it as
    // SKIPPED, never "unreadable".
    const allTargets = new Set<string>();
    for (const [agentKey, items] of perOwnerItems) {
      void agentKey;
      for (const i of items) {
        if (!JIRA_DISCOVERY_KINDS.has(i.kind) || (!restrict && ctx.memberFetchedByKey.has(i.target))) continue;
        if (ignoredByRestrict(i)) continue;
        const wk = watchKeyOfTarget.get(i.target);
        if (wk && coverageSkip.has(wk)) continue;
        allTargets.add(i.target);
      }
    }
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
    // for any opted owner's JIRA-KIND linked targets — see this module's
    // own top comment ("SEARCH FAILURE SKIPS THE WHOLE TICK"). No events,
    // no notify, no baseline/watch-set/unreadable-state advance for ANY
    // kind this tick. FACTORY-137: resyncPending/TTL are correspondingly
    // left untouched too — a failed fetch never "settles" anything.
    if (searchFailed) return;
    // Review round 3 (P2, continued): `ctx.memberFetchedByKey` must NOT seed
    // `byKey` for an on-demand pass either, not just the fetch-exclusion
    // above — same staleness, a different symptom. A dirty member that was
    // deleted/became unreadable is correctly INCLUDED in `allTargets` now
    // (the `!restrict` gate above), but Jira's batched search silently
    // OMITS an unreadable/nonexistent key rather than returning an error
    // for it (this module's own documented contract — see the `!issue`
    // branch below). If `byKey` still fell back to the member's OLD cached
    // object for that same key, the per-item loop would never see `!issue`
    // at all: it would treat the stale object as still readable, settle
    // its TTL, and clear the dirty mark with the unreadable transition
    // never reported. So an on-demand pass's `byKey` is seeded ONLY from
    // this pass's own fresh `fetched` results — a member target that drops
    // out (no row returned) correctly resolves to `undefined` and hits the
    // ordinary unreadable path below. A genuine regular tick (`!restrict`)
    // keeps reusing `ctx.memberFetchedByKey` exactly as before (that data
    // is fresh THIS tick, not stale).
    const byKey = new Map<string, JiraIssue>([...(restrict ? [] : ctx.memberFetchedByKey), ...fetched.map((i) => [i.key, i] as const)]);

    // FACTORY-9: newest comment id per DISTINCT Jira-kind target actually
    // returned by the batched search above — one extra REST call per
    // target (Jira has no batched comments endpoint), bounded the SAME way
    // the external pollers below already bound theirs (`mapLimit`,
    // `EXTERNAL_POLL_CONCURRENCY`). Only wired when `deps.comments` is
    // present; a target NOT returned by the batched search (unreadable
    // this tick) is never queried here either — nothing to attribute a
    // comment to. A per-target failure fails OPEN (logged, left absent
    // from the map) rather than failing the whole tick, same discipline
    // `pollExternalItem` already applies — `commentCursor` simply stays
    // `undefined` ("not checked") for that one target this tick; see
    // `JiraSnapshot.commentCursor`'s own doc comment for why that never
    // false-positives as a change.
    const commentCursorByTarget = new Map<string, string | null>();
    if (deps.comments) {
      const targets = [...byKey.keys()];
      const cursors = await mapLimit(targets, EXTERNAL_POLL_CONCURRENCY, async (key): Promise<string | null | undefined> => {
        try {
          // FACTORY-865: filtered the same way src/resources/issue.ts's
          // own fetchComments is — a butchr `[butchr:*]` bookkeeping
          // comment on a LINKED target must not move this cursor either,
          // or it defeats the `!commentChanged && isDaemonLabelOnlyDiff(...)`
          // gate below exactly the way it defeated the issue tier's own
          // suppression (see diff.ts's WAKE_MARKERS doc comment).
          const comments = excludeBookkeepingComments(await deps.comments!(key));
          return comments[0]?.id ?? null;
        } catch (e) {
          deps.log?.(`  WARNING: [linked-eventing] comment fetch failed for ${key}: ${(e as Error)?.message ?? e}`);
          return undefined;
        }
      });
      targets.forEach((key, i) => { const c = cursors[i]; if (c !== undefined) commentCursorByTarget.set(key, c); });
    }

    // Removed-link candidates, against each owner's watch set as of the
    // LAST poll this ran for it — read before anything below mutates that
    // set. Compared against `trackedKept(kept)` where `kept` is the FULL
    // per-owner item list (never restricted) — an on-demand pass's
    // `restrict` only ever narrows what gets FETCHED, never what counts as
    // "still linked", so removal detection is naturally a no-op during an
    // on-demand pass (nothing changed in `kept` since the last `runTick`
    // that built it).
    const removedByOwner = new Map<string, LinkedChangeEvent[]>();
    for (const entry of ownerEntries) {
      // FACTORY-833 (replayed onto main): an owner whose remote-link or
      // managed-link fetch threw during the LAST discovery that built this
      // `PassContext` (`ctx.linkFetchFailedOwners`) gets NO removal
      // detection this pass — that fetch's own previously-tracked targets
      // are simply absent from `kept` because the read failed, not because
      // anything was actually unlinked, and `kept` carries no way to tell
      // those two apart from here. Skipping removal-detection ONLY (every
      // other per-item change/comment/unreadable check below still runs
      // normally, and for a project owner member discovery is untouched —
      // it never depends on the link store) is the narrowest fix for the
      // false "no longer linked" FACTORY-833 reports: a broken managed-link
      // store must still fail open for everything ELSE an owner's tick does
      // (see linked-eventing-project.test.ts's own "fails open ... without
      // blocking ... member discovery" case), just not for a claim this
      // tick cannot actually back up. `watchSets` below still advances to
      // this tick's (fetch-failure-shrunk) `kept` only when NOT skipped
      // this way — see the `advanceByOwner` closure below for the matching
      // half of this fix.
      if (ctx.linkFetchFailedOwners.has(entry.agentKey)) continue;
      const prevSet = watchSets.get(entry.agentKey);
      const kept = perOwnerItems.get(entry.agentKey) ?? [];
      if (!prevSet) continue;
      const keptTargets = new Set(trackedKept(entry.agentKey, kept).map((i) => i.target));
      const gone: LinkedChangeEvent[] = [];
      for (const [target, kind] of prevSet) if (!keptTargets.has(target)) gone.push({ target, kind, detail: "no longer linked" });
      if (gone.length) removedByOwner.set(entry.agentKey, gone);
    }

    // BUTCHR-437 (PR #401 review round 1): poll-cadence gate for the THREE
    // EXTERNAL pollers, decided per owner BEFORE any of them are actually
    // polled — the Jira-kind batched search above stays free/every-tick.
    // FACTORY-137: irrelevant for any watch-key-covered item (jira has none
    // of these; github-issue/pr bypass this gate entirely — see below) but
    // still computed/recorded unconditionally for confluence/webpage/
    // filesystem and any NOT-actually-covered github item, byte-identical
    // to pre-FACTORY-137 behaviour.
    const dueForExternalByOwner = new Map<string, boolean>();
    for (const entry of ownerEntries) {
      const interval = entry.rule.linkedPollIntervalMs;
      const lastPoll = lastExternalPollAt.get(entry.agentKey);
      const due = interval === undefined || lastPoll === undefined || now() - lastPoll >= interval;
      dueForExternalByOwner.set(entry.agentKey, due);
      if (due) lastExternalPollAt.set(entry.agentKey, now());
    }

    interface ExternalTask { agentKey: string; item: LinkedItem; bkey: string; priorFingerprint: string | undefined }
    const externalTasks: ExternalTask[] = [];
    for (const entry of ownerEntries) {
      const due = dueForExternalByOwner.get(entry.agentKey) === true;
      for (const item of perOwnerItems.get(entry.agentKey) ?? []) {
        if (JIRA_DISCOVERY_KINDS.has(item.kind)) continue;
        if (ignoredByRestrict(item)) continue;
        const wk = watchKeyOfTarget.get(item.target);
        if (wk) {
          // FACTORY-137 (T8): a covered github-issue/github-pr item bypasses
          // `linkedPollIntervalMs` entirely in BOTH directions — never
          // fetched while skippable (even if `due`), always fetched when
          // forced (dirty/TTL/resync/first-sighting), regardless of `due`.
          // A push-triggered fetch is event-driven and bounded by the
          // debounce, not by this cadence knob (decision recorded in
          // docs/catamorbius-push.md).
          if (coverageSkip.has(wk)) continue;
          if (!coveredNow.has(wk) && !due) continue; // has a watch key but isn't actually covered right now (provider disabled / not connected) -> old cadence-gated behaviour
        } else if (!due) continue; // confluence / webpage / filesystem, or a github item not opted into push at all: unchanged cadence gate
        const bkey = baselineKey(entry.agentKey, item.target);
        const beforeRaw = baselines.get(bkey);
        const priorFingerprint = beforeRaw?.kind === "external" ? beforeRaw.fingerprint : undefined;
        externalTasks.push({ agentKey: entry.agentKey, item, bkey, priorFingerprint });
      }
    }
    const externalVerdicts = new Map<string, PollVerdict>();
    if (externalTasks.length) {
      const verdicts = await mapLimit(externalTasks, EXTERNAL_POLL_CONCURRENCY, (t) => pollExternalItem(t.item, t.priorFingerprint, deps));
      externalTasks.forEach((t, i) => externalVerdicts.set(t.bkey, verdicts[i]!));
    }

    const eventsByOwner = new Map<string, LinkedChangeEvent[]>();
    const advanceByOwner = new Map<string, () => void>();
    // FACTORY-137 (T4): every watch key this pass actually TOUCHED (fetched
    // or considered-and-skipped is irrelevant here — only a genuine fetch
    // attempt counts), and which owners reference it — used at the very end
    // to decide whether a dirty mark is safe to clear (only once EVERY
    // owner of that target has genuinely advanced this pass, never merely
    // "fetched").
    const touchedOwnersByKey = new Map<WatchKey, Set<string>>();
    const noteTouched = (target: string, agentKey: string): void => {
      const wk = watchKeyOfTarget.get(target);
      if (!wk) return;
      let owners = touchedOwnersByKey.get(wk);
      if (!owners) { owners = new Set(); touchedOwnersByKey.set(wk, owners); }
      owners.add(agentKey);
    };

    for (const entry of ownerEntries) {
      const kept = perOwnerItems.get(entry.agentKey) ?? [];
      const wasUnreadable = unreadableOwners.get(entry.agentKey) ?? new Set<string>();
      const removedThisTick = removedByOwner.get(entry.agentKey) ?? [];
      const triggering: LinkedChangeEvent[] = [...removedThisTick];
      const stillUnreadable: LinkedChangeEvent[] = [];
      const toAdvance: Array<() => void> = [];
      const nowUnreadable = new Set<string>();
      const dueForExternal = dueForExternalByOwner.get(entry.agentKey) === true;

      // FACTORY-9 ("drops its cached snapshot so a later re-add does not
      // produce a spurious change"): a removed target's baseline is
      // deleted, not merely left stale.
      for (const ev of removedThisTick) {
        toAdvance.push(() => {
          baselines.delete(baselineKey(entry.agentKey, ev.target));
          unreadableOwners.get(entry.agentKey)?.delete(ev.target);
        });
      }

      for (const item of kept) {
        if (JIRA_DISCOVERY_KINDS.has(item.kind)) {
          if (ignoredByRestrict(item)) continue;
          const wk = watchKeyOfTarget.get(item.target);
          if (wk && coverageSkip.has(wk)) continue; // T1: skipped by design, never "unreadable"
          const issue = byKey.get(item.target);
          if (!issue) {
            // Requested in this tick's batched fetch but not returned —
            // Jira's `key in (...)` silently omits an unreadable/nonexistent
            // key rather than erroring per-key. Only a fresh transition into
            // unreadable triggers; already-known-unreadable is context only.
            nowUnreadable.add(item.target);
            noteTouched(item.target, entry.agentKey);
            settleTtl(item.target); // D4: "unreadable" is a settled outcome too
            const event: LinkedChangeEvent = { target: item.target, kind: item.kind, detail: "unreadable" };
            if (wasUnreadable.has(item.target)) stillUnreadable.push(event);
            else triggering.push(event);
            continue;
          }
          noteTouched(item.target, entry.agentKey);
          settleTtl(item.target);
          if (wasUnreadable.has(item.target)) toAdvance.push(() => unreadableOwners.get(entry.agentKey)?.delete(item.target));
          const snap = snapshotOf(issue, commentCursorByTarget.get(item.target));
          const bkey = baselineKey(entry.agentKey, item.target);
          const beforeRaw = baselines.get(bkey);
          const before = beforeRaw?.kind === "jira" ? beforeRaw.snapshot : undefined;
          if (!before) {
            // BUTCHR-469 (review round 1 fix): a MEMBER-sourced target with
            // no baseline is NOT a neutral "first sighting" — see this
            // owner's own doc comment.
            if (ctx.memberTargetsByOwner.get(entry.agentKey)?.has(item.target)) {
              const watermark = ctx.usedWatermarkByOwner.get(entry.agentKey);
              const detail = watermark === undefined ? "updated" : `updated since ${new Date(watermark).toISOString()}`;
              triggering.push({ target: item.target, kind: item.kind, detail });
              toAdvance.push(() => baselines.set(bkey, { kind: "jira", snapshot: snap }));
              continue;
            }
            toAdvance.push(() => baselines.set(bkey, { kind: "jira", snapshot: snap })); // first sighting: seed silently, no event
            continue;
          }
          const commentChanged = commentChangedBetween(before, snap);
          const changed = before.status !== snap.status || before.summary !== snap.summary || before.updated !== snap.updated || commentChanged;
          if (!changed) continue;
          if (!commentChanged && isDaemonLabelOnlyDiff(asIssue(item.target, before), asIssue(item.target, snap))) {
            toAdvance.push(() => baselines.set(bkey, { kind: "jira", snapshot: snap })); // real move, but daemon-label-only
            continue;
          }
          if (deps.suppress?.(item.target, snap.updated, entry.agentKey)) {
            toAdvance.push(() => baselines.set(bkey, { kind: "jira", snapshot: snap })); // own-write echo
            continue;
          }
          noteIfStreamMissed(item.target, item.kind);
          triggering.push({ target: item.target, kind: item.kind, detail: changeDetail(before, snap) });
          toAdvance.push(() => baselines.set(bkey, { kind: "jira", snapshot: snap }));
          continue;
        }

        // BUTCHR-437: EXTERNAL kind (confluence / github-issue / github-pr / webpage).
        if (ignoredByRestrict(item)) continue;
        const wkExt = watchKeyOfTarget.get(item.target);
        if (wkExt && coverageSkip.has(wkExt)) continue; // T1 analogue for a covered github item
        const consideredThisPass = wkExt ? coveredNow.has(wkExt) || dueForExternal : dueForExternal;
        if (!consideredThisPass) continue;
        const bkey = baselineKey(entry.agentKey, item.target);
        const beforeRaw = baselines.get(bkey);
        const before = beforeRaw?.kind === "external" ? beforeRaw : undefined;
        const verdict = externalVerdicts.get(bkey);
        if (!verdict) continue; // not actually polled this pass (e.g. `due` was false and it wasn't a covered/forced item)
        if (verdict.status === "error") continue; // transient — untouched this tick
        noteTouched(item.target, entry.agentKey);
        settleTtl(item.target);
        if (verdict.status === "unreadable") {
          nowUnreadable.add(item.target);
          const event: LinkedChangeEvent = { target: item.target, kind: item.kind, detail: unreadableDetail(verdict.httpStatus) };
          if (wasUnreadable.has(item.target)) stillUnreadable.push(event);
          else triggering.push(event);
          continue;
        }
        if (wasUnreadable.has(item.target)) toAdvance.push(() => unreadableOwners.get(entry.agentKey)?.delete(item.target));
        if (verdict.status === "not-modified") continue;
        if (!before) {
          toAdvance.push(() => baselines.set(bkey, { kind: "external", fingerprint: verdict.fingerprint }));
          continue;
        }
        if (verdict.fingerprint === before.fingerprint) continue;
        noteIfStreamMissed(item.target, item.kind);
        triggering.push({ target: item.target, kind: item.kind, detail: externalChangeDetail(item.kind, before.fingerprint, verdict.fingerprint) });
        toAdvance.push(() => baselines.set(bkey, { kind: "external", fingerprint: verdict.fingerprint }));
      }

      if (nowUnreadable.size) {
        toAdvance.push(() => {
          const set = unreadableOwners.get(entry.agentKey) ?? new Set<string>();
          for (const t of nowUnreadable) set.add(t);
          unreadableOwners.set(entry.agentKey, set);
        });
      }

      if (triggering.length) eventsByOwner.set(entry.agentKey, [...triggering, ...stillUnreadable]);
      advanceByOwner.set(entry.agentKey, () => {
        for (const fn of toAdvance) fn();
        // FACTORY-833 (replayed onto main, review round 1): an owner whose
        // remote-link or managed-link fetch failed this tick must NOT have
        // its watch set overwritten here — `kept` this tick is already
        // shrunk by that failure, and committing it as the new watch set
        // would silently adopt the shrunk membership as ground truth: a
        // genuine removal that happened during the SAME failed tick would
        // never surface, and any OTHER target from an unrelated,
        // successfully-read source that was also removed this exact tick
        // would be lost the same way, since `removedByOwner`'s own skip
        // above never computed it either. Leaving the watch set exactly as
        // it was means the NEXT successful tick's `prevSet` is still the
        // last genuinely observed membership, so a removal that occurred
        // during the failure window is correctly caught then, once. Every
        // other `toAdvance` closure above (baselines for whatever WAS
        // successfully read this tick) still runs normally.
        if (!ctx.linkFetchFailedOwners.has(entry.agentKey)) {
          watchSets.set(entry.agentKey, new Map(trackedKept(entry.agentKey, kept).map((i) => [i.target, i.kind])));
        }
        const wm = ctx.nextProjectWatermark.get(entry.agentKey);
        if (wm !== undefined) projectWatermarks.set(entry.agentKey, wm);
      });
    }

    const advancedOwners = new Set<string>();
    for (const entry of ownerEntries) {
      const advance = advanceByOwner.get(entry.agentKey)!;
      const events = eventsByOwner.get(entry.agentKey);
      if (!events?.length) { advance(); advancedOwners.add(entry.agentKey); continue; }
      // BUTCHR-471 (replayed onto main): never `undefined` — an explicit
      // `rule.maxLinkedTurnsPerHour` always wins, absent falls back to
      // `DEFAULT_MAX_LINKED_TURNS_PER_HOUR`, so this block now always runs
      // (no owner kind can run uncapped).
      const max = effectiveMaxLinkedTurnsPerHour(entry.rule);
      const history = (turns.get(entry.agentKey) ?? []).filter((t) => now() - t < SLIDING_WINDOW_MS);
      if (history.length >= max) {
        turns.set(entry.agentKey, history);
        // BUTCHR-471: `entry.notifyAgentKey`, NOT `entry.agentKey` — for a
        // managed-session owner, `agentKey` is the synthetic per-(session,
        // project) STATE key, which embeds a literal NUL byte that must
        // never reach a journal write (see src/daemon/log-sink.ts's own
        // flatten). `entry.label` still keeps the project/issue identifiable.
        deps.log?.(rateCappedSuppressedLine(entry.label, entry.notifyAgentKey, history.length, max));
        continue; // NOT advanced — next allowed tick re-detects everything still outstanding
      }
      history.push(now());
      turns.set(entry.agentKey, history);
      await deps.notify(entry.notifyAgentKey, entry.notifyAgentKey, { linked: { events } });
      advance();
      advancedOwners.add(entry.agentKey);
    }

    // FACTORY-137 (T4): a dirty mark is cleared only once EVERY owner that
    // references its target has genuinely advanced this pass (not merely
    // been fetched) — a rate-capped owner leaves it dirty, so the next pass
    // re-derives the outstanding diff for that owner too, exactly the
    // "delayed, not lost" discipline every other piece of state here
    // already has.
    for (const wk of dirtyAtStart) {
      if (dirtyGen.get(wk) !== dirtyGenAtStart.get(wk)) continue; // T3: a newer mark arrived mid-pass — never clear it
      const owners = touchedOwnersByKey.get(wk);
      if (owners && [...owners].every((o) => advancedOwners.has(o))) {
        dirty.delete(wk);
        dirtyGen.delete(wk);
      }
      // An untouched dirty key (nobody currently watches it — T9/D6 "ignored,
      // counted") is safe to clear unconditionally: there is no owner whose
      // advance it could ever be waiting on.
      else if (!owners) {
        dirty.delete(wk);
        dirtyGen.delete(wk);
      }
    }

    // D5: resyncPending survives until a pass has actually forced the fetch
    // of every covered target WHILE covered — never consumed by a pass that
    // ran while nothing was covered, and never by a failed batch.
    if (resyncActiveThisPass && !searchFailed && push?.isCoveringNow()) resyncPending = false;
  }

  return {
    async runTick(matches, deps, projectMatches = []) {
      await serialize(async () => {
        const now = deps.now ?? Date.now;
        const opted = matches.filter((m) => m.rule.linkedEventing === true);
        const projectOpted = projectMatches.filter((m) => m.rule.linkedEventing === true);
        if (!opted.length && !projectOpted.length) return;

        const perOwnerItems = new Map<string, LinkedItem[]>();
        // BUTCHR-469: which of a PROJECT owner's kept targets came from its
        // MANAGED links specifically — the only subset that may ever
        // participate in "no longer linked" removal detection below. Absent
        // (an issue owner) means "everything in `kept` is removal-tracked",
        // unchanged pre-BUTCHR-469 behaviour — see `trackedKept` above.
        const managedTargetsByOwner = new Map<string, Set<string>>();
        // BUTCHR-469 (review round 1 fix): which of a project owner's kept
        // targets came from the MEMBER-DISCOVERY search THIS TICK — the
        // only subset for which a missing baseline must be reported as a
        // genuine change rather than seeded silently.
        const memberTargetsByOwner = new Map<string, Set<string>>();
        // BUTCHR-469 (review round 1 fix): the watermark actually USED for
        // this tick's member search, per owner.
        const usedWatermarkByOwner = new Map<string, number>();
        // BUTCHR-469 (review round 1 fix): every JiraIssue the
        // member-discovery search(es) already fetched, THIS TICK, across
        // every project owner — reused directly as the shared batched-
        // fetch's own data instead of re-requesting the same keys.
        const memberFetchedByKey = new Map<string, JiraIssue>();
        // BUTCHR-469: this tick's own project-watermark advance, deferred
        // exactly like every other piece of state here — committed only
        // inside a genuinely-delivered-or-consumed owner's own `advance()`.
        const nextProjectWatermark = new Map<string, number>();
        // FACTORY-833 (replayed onto main): an owner whose remote-links or
        // managed-link fetch threw THIS TICK — see the removal-detection
        // skip in `runOwnerPass` for why. Without this, a transient failure
        // of either fetch silently yields `[]` for just that source, that
        // source's previously-tracked targets vanish from `kept`, and
        // removal detection (which only ever sees `kept`, not WHY a target
        // is missing from it) reports a false "no longer linked" for
        // something that never actually changed.
        const linkFetchFailedOwners = new Set<string>();

        for (const m of opted) {
          let remoteLinks: JiraRemoteLink[] | undefined;
          if (m.rule.linkedRemoteLinks === true && deps.remoteLinks) {
            try {
              remoteLinks = await deps.remoteLinks(m.issue.key);
            } catch (e) {
              deps.log?.(`  WARNING: [linked-eventing] remote-links fetch failed for ${m.agentKey} (${m.issue.key}): ${(e as Error)?.message ?? e}`);
              linkFetchFailedOwners.add(m.agentKey);
            }
          }
          // FACTORY-9: this owner's butchr-MANAGED links (FACTORY-4),
          // reconciled against its own native Jira links so a target
          // already covered by `jiraItems` below is never double-watched.
          // Fails open: one owner's broken link store must never block any
          // other owner's tick.
          let managedItems: LinkedItem[] = [];
          if (deps.linkStore) {
            try {
              managedItems = await managedLinkedItems(jiraWorkItemOwnerRef(m.issue), nativeJiraRefs(m.issue), deps.linkStore, deps.log);
            } catch (e) {
              deps.log?.(`  WARNING: [linked-eventing] managed-link fetch failed for ${m.agentKey} (${m.issue.key}): ${(e as Error)?.message ?? e}`);
              linkFetchFailedOwners.add(m.agentKey);
            }
          }
          // BUTCHR-437: description-derived Confluence/GitHub/webpage items
          // are combined with Jira-kind items BEFORE `maxLinkedItems` caps,
          // so the cap applies uniformly across every kind for this
          // resource — never a separate per-kind budget.
          const jiraItems = jiraKindLinkedItems(m, remoteLinks);
          const externalItems = m.rule.linkedDescriptionLinks === true ? descriptionLinkedItems(m) : [];
          const { kept } = capLinkedItems([...jiraItems, ...externalItems, ...managedItems], effectiveMaxLinkedItems(m.rule));
          perOwnerItems.set(m.agentKey, kept);
        }

        // BUTCHR-469: a project owner's own two item sources — see
        // `ProjectLinkedEventingMatch`'s own doc comment for the full
        // design. Member items come back already as `LinkedItem`s, so they
        // ride the EXACT SAME shared batched fetch / diff / comment-cursor
        // machinery below with zero special-casing — this loop's only job
        // is DISCOVERY, exactly like `jiraKindLinkedItems` is for an issue
        // owner.
        for (const m of projectOpted) {
          const priorWatermark = projectWatermarks.get(m.agentKey);
          let memberItems: LinkedItem[] = [];
          // BUTCHR-469 (review round 2 fix): the targets among THIS tick's
          // member candidates that genuinely need a slot — no baseline yet,
          // or a real field change against their existing one.
          let freshOrChangedMembers: LinkedItem[] = [];
          if (priorWatermark === undefined) {
            // First sighting: seed the watermark to now and search NOTHING
            // this tick — searching this project's full unwatermarked
            // history here would flood every member ever touched.
            nextProjectWatermark.set(m.agentKey, now());
          } else {
            const searchStartedAt = now();
            try {
              const minutes = jqlRelativeMinutesSince(priorWatermark, searchStartedAt);
              const members = await deps.search(`project = ${m.projectKey} AND updated >= "-${minutes}m" ORDER BY updated ASC`);
              // BUTCHR-469 (review round 2 fix): partition into "genuinely
              // needs a slot" vs. "already known, nothing new" — a stale
              // member only reappears here because the window is
              // deliberately over-inclusive, never because anything
              // changed.
              const staleMembers: LinkedItem[] = [];
              for (const issue of members) {
                const item: LinkedItem = { kind: "jira-key", target: issue.key };
                // Reused directly by the shared batched fetch below instead
                // of a second `key in (...)` call for the same key.
                memberFetchedByKey.set(issue.key, issue);
                const beforeRaw = baselines.get(baselineKey(m.agentKey, issue.key));
                const before = beforeRaw?.kind === "jira" ? beforeRaw.snapshot : undefined;
                const looksUnchanged = before !== undefined && before.updated === issue.updated;
                (looksUnchanged ? staleMembers : freshOrChangedMembers).push(item);
              }
              memberItems = [...freshOrChangedMembers, ...staleMembers];
              usedWatermarkByOwner.set(m.agentKey, priorWatermark);
              // Captured BEFORE the search ran, not after — see this
              // function's own earlier comment on the race this avoids.
              nextProjectWatermark.set(m.agentKey, searchStartedAt);
            } catch (e) {
              deps.log?.(`  WARNING: [linked-eventing] project-member search failed for ${m.agentKey} (${m.projectKey}), skipping member discovery this tick: ${(e as Error)?.message ?? e}`);
              // Fails open: no member items this tick, watermark NOT
              // advanced — delayed, not lost, and this owner's OWN
              // managed-link source below is unaffected.
            }
          }

          // FACTORY-8/FACTORY-9: this project's own managed links, reconciled
          // via the SAME `managedLinkedItems` an issue owner already uses —
          // `nativeRefs: []` because a project has no structural native
          // links of its own. Fails open, independent of the member search
          // above.
          let managedItems: LinkedItem[] = [];
          if (deps.linkStore) {
            try {
              managedItems = await managedLinkedItems(jiraProjectOwnerRef(m.projectKey), [], deps.linkStore, deps.log);
            } catch (e) {
              deps.log?.(`  WARNING: [linked-eventing] managed-link fetch failed for ${m.agentKey} (${m.projectKey}): ${(e as Error)?.message ?? e}`);
              linkFetchFailedOwners.add(m.agentKey);
            }
          }
          managedTargetsByOwner.set(m.agentKey, new Set(managedItems.map((i) => i.target)));

          // De-duplicated by target, first occurrence wins — an issue that
          // is both a member and a managed-link target must yield ONE item,
          // never two. BUTCHR-469 (review round 2 fix): genuinely
          // fresh/changed members rank FIRST, stale/already-known members
          // rank LAST, so a persistently-at-cap project's scarce slots
          // always go to whatever still needs one.
          const seen = new Set<string>();
          const combinedProjectItems: LinkedItem[] = [];
          for (const item of [...memberItems, ...managedItems]) {
            if (seen.has(item.target)) continue;
            seen.add(item.target);
            combinedProjectItems.push(item);
          }
          const { kept: projectKept, skipped: projectSkipped } = capLinkedItems(combinedProjectItems, effectiveMaxLinkedItems(m.rule));
          perOwnerItems.set(m.agentKey, projectKept);
          memberTargetsByOwner.set(m.agentKey, new Set(memberItems.map((i) => i.target)));

          // BUTCHR-469 (review round 1 fix, refined in round 2): a MANAGED
          // link skipped by the cap is safe to lose just this tick. A
          // member skipped by the cap is NOT safe the same way UNLESS it is
          // already stale — so this checks `freshOrChangedMembers`
          // specifically, never the full member set. Holding the watermark
          // means the next tick re-runs the SAME window; as soon as no
          // fresh-or-changed member is skipped, the watermark resumes
          // advancing normally.
          const freshOrChangedTargets = new Set(freshOrChangedMembers.map((i) => i.target));
          if (projectSkipped.some((i) => freshOrChangedTargets.has(i.target))) {
            nextProjectWatermark.delete(m.agentKey);
            deps.log?.(`  WARNING: [linked-eventing] project-member cap: ${m.agentKey} (${m.projectKey}) has more changed members than maxLinkedItems (${effectiveMaxLinkedItems(m.rule)}) allows this tick; watermark held so the skipped member(s) are retried next tick, not lost`);
          }
        }

        // BUTCHR-469: from here on, an issue owner and a project owner are
        // handled UNIFORMLY — the coalescer, rate cap and notify below never
        // fork on which kind of match produced an owner's items.
        // FACTORY-53/FACTORY-71: `notifyAgentKey` defaults to `agentKey` for
        // an issue owner and for any project owner that leaves it unset.
        const ownerEntries: Array<{ agentKey: string; rule: Rule; label: string; notifyAgentKey: string }> = [
          ...opted.map((m) => ({ agentKey: m.agentKey, rule: m.rule, label: m.issue.key, notifyAgentKey: m.agentKey })),
          ...projectOpted.map((m) => ({ agentKey: m.agentKey, rule: m.rule, label: m.projectKey, notifyAgentKey: m.notifyAgentKey ?? m.agentKey })),
        ];

        const ctx: PassContext = { ownerEntries, perOwnerItems, managedTargetsByOwner, memberTargetsByOwner, usedWatermarkByOwner, nextProjectWatermark, memberFetchedByKey, linkFetchFailedOwners, deps };
        lastPassContext = ctx;
        await runOwnerPass(ctx, undefined);
      });
    },

    markDirty(key: WatchKey): void {
      dirty.add(key);
      dirtyGen.set(key, (dirtyGen.get(key) ?? 0) + 1);
      pushStats.dirtyMarks += 1;
    },

    requestResync(): void {
      resyncPending = true;
    },

    runDirtyPass(): Promise<void> {
      if (pendingDirtyPass) return pendingDirtyPass;
      const debounceMs = lastPassContext?.deps.push?.debounceMs() ?? 0;
      const setTimeoutFn = lastPassContext?.deps.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
      const clearTimeoutFn = lastPassContext?.deps.clearTimeout ?? ((h: unknown) => clearTimeout(h as never));
      pendingDirtyPass = new Promise<void>((resolve) => {
        const fire = (): void => {
          debounceTimerHandle = undefined;
          serialize(async () => {
            if (!lastPassContext) return;
            const active = new Set<WatchKey>(dirty);
            if (resyncPending && lastPassContext.deps.push) {
              // D5: resync forces EVERY currently covered target, not just
              // the dirty ones.
              for (const items of lastPassContext.perOwnerItems.values()) {
                for (const item of items) {
                  const wk = pushWatchKeyFor(item);
                  if (!wk) continue;
                  if (lastPassContext.deps.push.isProviderEnabled(wk.provider) && lastPassContext.deps.push.isCoveringNow()) active.add(wk.key);
                }
              }
            }
            if (active.size === 0) return;
            pushStats.onDemandPasses += 1;
            await runOwnerPass(lastPassContext, active);
          }).then(
            () => { pendingDirtyPass = undefined; resolve(); },
            () => { pendingDirtyPass = undefined; resolve(); },
          );
        };
        if (debounceMs <= 0) fire();
        else debounceTimerHandle = setTimeoutFn(fire, debounceMs);
      });
      void clearTimeoutFn; // referenced for symmetry/testability; nothing here ever needs to CANCEL the debounce early
      return pendingDirtyPass;
    },

    stats(): LinkedEventingPushStats {
      return { ...pushStats };
    },
  };
}
