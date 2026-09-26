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
 */
import type { JiraComment, JiraIssue, JiraRemoteLink } from "../atlassian/types.js";
import type { Rule } from "../rules/rules.js";
import type { LinkedChangeEvent, NotifyReason } from "../resources/types.js";
import { capLinkedItems, descriptionItems, discoverLinkedItems, jiraBrowseKey, type LinkedItem, type LinkedItemKind } from "../resources/linked-discovery.js";
import { jiraProjectOwnerRef, jiraWorkItemOwnerRef, managedLinkedItems, nativeJiraRefs } from "../resources/link-reconcile.js";
import type { LinkStore } from "../resources/link-store.js";
import { isDaemonLabelOnlyDiff } from "./diff.js";
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
 * occurrence wins, same convention `discoverLinkedItems` already uses).
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
   */
  runTick(matches: readonly LinkedEventingMatch[], deps: LinkedEventingDeps, projectMatches?: readonly ProjectLinkedEventingMatch[]): Promise<void>;
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

  return {
    async runTick(matches, deps, projectMatches = []) {
      const now = deps.now ?? Date.now;
      const opted = matches.filter((m) => m.rule.linkedEventing === true);
      const projectOpted = projectMatches.filter((m) => m.rule.linkedEventing === true);
      if (!opted.length && !projectOpted.length) return;

      const perOwnerItems = new Map<string, LinkedItem[]>();
      // BUTCHR-469: which of a PROJECT owner's kept targets came from its
      // MANAGED links specifically — the only subset that may ever
      // participate in "no longer linked" removal detection below. Absent
      // (an issue owner) means "everything in `kept` is removal-tracked",
      // unchanged pre-BUTCHR-469 behaviour — see `trackedKept` below.
      const managedTargetsByOwner = new Map<string, Set<string>>();
      // BUTCHR-469 (review round 1 fix): which of a project owner's kept
      // targets came from the MEMBER-DISCOVERY search THIS TICK — the only
      // subset for which a missing baseline must be reported as a genuine
      // change rather than seeded silently. See the per-item diff loop's own
      // comment on `!before` for why: `project = <key> AND updated >=
      // "-<N>m"` only ever returns a target that has ALREADY changed since
      // the watermark, so a member's first appearance IS the change, not a
      // neutral "now I know about this link" the way a managed/native link's
      // first sighting is.
      const memberTargetsByOwner = new Map<string, Set<string>>();
      // BUTCHR-469 (review round 1 fix): the watermark actually USED for
      // this tick's member search, per owner — carried through to the
      // per-item diff loop purely to phrase a first-appearance event's
      // detail text ("updated since <watermark>"). Absent for an owner on
      // its very first sighting (no search ran) or on a failed search.
      const usedWatermarkByOwner = new Map<string, number>();
      // BUTCHR-469 (review round 1 fix): every JiraIssue the member-discovery
      // search(es) already fetched, THIS TICK, across every project owner —
      // reused directly as the shared batched-fetch's own data (see
      // `byKey` below) instead of re-requesting the same keys via a second
      // `key in (...)` call. Scratch, per tick only — never persisted.
      const memberFetchedByKey = new Map<string, JiraIssue>();
      // BUTCHR-469: this tick's own project-watermark advance, deferred
      // exactly like every other piece of state here (`toAdvance` below) —
      // committed only inside a genuinely-delivered-or-consumed owner's own
      // `advance()`, never on a rate-capped or failed tick.
      const nextProjectWatermark = new Map<string, number>();

      for (const m of opted) {
        let remoteLinks: JiraRemoteLink[] | undefined;
        if (m.rule.linkedRemoteLinks === true && deps.remoteLinks) {
          try {
            remoteLinks = await deps.remoteLinks(m.issue.key);
          } catch (e) {
            deps.log?.(`  WARNING: [linked-eventing] remote-links fetch failed for ${m.agentKey} (${m.issue.key}): ${(e as Error)?.message ?? e}`);
          }
        }
        // FACTORY-9: this owner's butchr-MANAGED links (FACTORY-4), reconciled
        // against its own native Jira links (`nativeJiraRefs`) so a target
        // already covered by `jiraItems` below is never double-watched — see
        // `managedLinkedItems`'s own doc comment (src/resources/
        // link-reconcile.ts) for the full "managed-origin only" contract.
        // Fails open, same discipline as `remoteLinks` immediately above: one
        // owner's broken link store must never block any other owner's tick.
        let managedItems: LinkedItem[] = [];
        if (deps.linkStore) {
          try {
            managedItems = await managedLinkedItems(jiraWorkItemOwnerRef(m.issue), nativeJiraRefs(m.issue), deps.linkStore, deps.log);
          } catch (e) {
            deps.log?.(`  WARNING: [linked-eventing] managed-link fetch failed for ${m.agentKey} (${m.issue.key}): ${(e as Error)?.message ?? e}`);
          }
        }
        // BUTCHR-437: description-derived Confluence/GitHub/webpage items are
        // combined with Jira-kind items BEFORE `maxLinkedItems` caps, so the
        // cap applies uniformly across every kind for this resource — never a
        // separate per-kind budget. FACTORY-9: managed-link items join the
        // SAME combined array, same uniform cap.
        const jiraItems = jiraKindLinkedItems(m, remoteLinks);
        const externalItems = m.rule.linkedDescriptionLinks === true ? descriptionLinkedItems(m) : [];
        const { kept } = capLinkedItems([...jiraItems, ...externalItems, ...managedItems], m.rule.maxLinkedItems);
        perOwnerItems.set(m.agentKey, kept);
      }

      // BUTCHR-469: a project owner's own two item sources — see
      // `ProjectLinkedEventingMatch`'s own doc comment for the full design.
      // Member items come back already as `LinkedItem`s (kind "jira-key",
      // one of `JIRA_DISCOVERY_KINDS`), so they ride the EXACT SAME shared
      // batched fetch / diff / comment-cursor machinery below with zero
      // special-casing — this loop's only job is DISCOVERY, exactly like
      // `jiraKindLinkedItems` is for an issue owner.
      for (const m of projectOpted) {
        const priorWatermark = projectWatermarks.get(m.agentKey);
        let memberItems: LinkedItem[] = [];
        // BUTCHR-469 (review round 2 fix): the targets among THIS tick's
        // member candidates that genuinely need a slot — no baseline yet, or
        // a real field change against their existing one. Populated below;
        // used both to rank the cap (fresh/changed first) and to decide
        // whether a capped-away member actually costs anything (see
        // `freshOrChangedTargets` at the bottom of this loop iteration).
        let freshOrChangedMembers: LinkedItem[] = [];
        if (priorWatermark === undefined) {
          // First sighting (true on the very first tick, and again after
          // every daemon restart, since this state is in-memory only): seed
          // the watermark to now and search NOTHING this tick — searching
          // this project's full unwatermarked history here would flood
          // every member ever touched. See this owner's own doc comment.
          nextProjectWatermark.set(m.agentKey, now());
        } else {
          const searchStartedAt = now();
          try {
            const minutes = jqlRelativeMinutesSince(priorWatermark, searchStartedAt);
            // `ORDER BY updated ASC`: a REQUEST for the oldest-first order,
            // but NOT what actually protects a capped tail from starvation —
            // see the fresh/stale partition just below for that (review
            // round 2 found that ordering ALONE still starves the tail,
            // since an already-delivered member that keeps re-matching this
            // deliberately over-inclusive window sorts right back to the
            // front next tick).
            const members = await deps.search(`project = ${m.projectKey} AND updated >= "-${minutes}m" ORDER BY updated ASC`);
            // BUTCHR-469 (review round 2 fix): partition into "genuinely
            // needs a slot" vs. "already known, nothing new" — a stale
            // member only reappears here because the window is deliberately
            // over-inclusive (`jqlRelativeMinutesSince`'s own doc comment),
            // never because anything changed. Without this split, a
            // persistently-at-cap project would let an already-delivered
            // member re-consume the one scarce slot every tick forever
            // (ORDER BY updated ASC sorts it right back to the front, since
            // its own `updated` never moves) while a genuinely still-pending
            // member starves — exactly review round 2's own reproduction.
            // `updated` alone (not the full snapshot) is the freshness
            // check: comment-only changes always bump `updated` too (see
            // `JiraSnapshot.commentCursor`'s own doc comment), so this needs
            // no separate comment lookup to stay a reasonable proxy — this
            // is a RANKING heuristic, not a correctness gate; the real diff
            // (including comment-cursor) still runs unconditionally on
            // whatever wins a slot below.
            const staleMembers: LinkedItem[] = [];
            for (const issue of members) {
              const item: LinkedItem = { kind: "jira-key", target: issue.key };
              // Reused directly by the shared batched fetch below instead of
              // a second `key in (...)` call for the same key (review round
              // 1) — this search already returned full issue data.
              memberFetchedByKey.set(issue.key, issue);
              const beforeRaw = baselines.get(baselineKey(m.agentKey, issue.key));
              const before = beforeRaw?.kind === "jira" ? beforeRaw.snapshot : undefined;
              const looksUnchanged = before !== undefined && before.updated === issue.updated;
              (looksUnchanged ? staleMembers : freshOrChangedMembers).push(item);
            }
            memberItems = [...freshOrChangedMembers, ...staleMembers];
            usedWatermarkByOwner.set(m.agentKey, priorWatermark);
            // Captured BEFORE the search ran, not after: a member updated
            // WHILE the search was in flight still has `updated` at or after
            // this timestamp, so the NEXT tick's `>=` window still covers it
            // — capturing after the search would risk missing exactly that
            // race window.
            nextProjectWatermark.set(m.agentKey, searchStartedAt);
          } catch (e) {
            deps.log?.(`  WARNING: [linked-eventing] project-member search failed for ${m.agentKey} (${m.projectKey}), skipping member discovery this tick: ${(e as Error)?.message ?? e}`);
            // Fails open: no member items this tick, watermark NOT advanced
            // (no entry in `nextProjectWatermark`) — delayed, not lost, and
            // this owner's OWN managed-link source below is unaffected.
          }
        }

        // FACTORY-8/FACTORY-9: this project's own managed links
        // (`brooswit.butchr.links`), reconciled via the SAME
        // `managedLinkedItems` an issue owner already uses — `nativeRefs: []`
        // because a project has no structural native links of its own, so
        // every managed link here is "managed"-origin and watched. Fails
        // open, independent of the member search above.
        let managedItems: LinkedItem[] = [];
        if (deps.linkStore) {
          try {
            managedItems = await managedLinkedItems(jiraProjectOwnerRef(m.projectKey), [], deps.linkStore, deps.log);
          } catch (e) {
            deps.log?.(`  WARNING: [linked-eventing] managed-link fetch failed for ${m.agentKey} (${m.projectKey}): ${(e as Error)?.message ?? e}`);
          }
        }
        managedTargetsByOwner.set(m.agentKey, new Set(managedItems.map((i) => i.target)));

        // De-duplicated by target, first occurrence wins — an issue that is
        // both a member and a managed-link target must yield ONE item,
        // never two (DoD: no duplicate event lines). BUTCHR-469 (review
        // round 2 fix): genuinely fresh/changed members rank FIRST (ahead of
        // managed links, which are never starved by a cap — see below),
        // stale/already-known members rank LAST, so a persistently-at-cap
        // project's scarce slots always go to whatever still needs one.
        // Combined BEFORE `maxLinkedItems` caps, same uniform-cap convention
        // the issue-owner loop above already uses.
        const seen = new Set<string>();
        const combinedProjectItems: LinkedItem[] = [];
        for (const item of [...memberItems, ...managedItems]) {
          if (seen.has(item.target)) continue;
          seen.add(item.target);
          combinedProjectItems.push(item);
        }
        const { kept: projectKept, skipped: projectSkipped } = capLinkedItems(combinedProjectItems, m.rule.maxLinkedItems);
        perOwnerItems.set(m.agentKey, projectKept);
        memberTargetsByOwner.set(m.agentKey, new Set(memberItems.map((i) => i.target)));

        // BUTCHR-469 (review round 1 fix, refined in round 2): a MANAGED
        // link skipped by the cap is safe to lose just this tick —
        // `managedLinkedItems` re-lists the FULL managed-link collection
        // every tick regardless of any cap, so a skipped one is simply a
        // candidate again next tick, no different from how an issue owner's
        // own capped-away link already behaves. A member skipped by the cap
        // is NOT safe the same way UNLESS it is already stale (baselined,
        // nothing new): a fresh-or-changed member skipped this tick only
        // appeared because it fell inside the current watermark window, and
        // once the watermark advances past that window it may never
        // reappear — silently losing it, not merely delaying it. Round 2's
        // own finding: checking ANY member (not just fresh/changed ones)
        // held the watermark forever once at least one member existed at
        // all, which is exactly what let an already-delivered member
        // re-consume the scarce slot every tick — so this checks
        // `freshOrChangedMembers` specifically, never the full member set.
        // Holding the watermark (never committing this tick's
        // `nextProjectWatermark` entry) means the next tick re-runs the SAME
        // window; as soon as no fresh-or-changed member is skipped (either
        // none are, or the backlog has fully drained), the watermark
        // resumes advancing normally.
        const freshOrChangedTargets = new Set(freshOrChangedMembers.map((i) => i.target));
        if (projectSkipped.some((i) => freshOrChangedTargets.has(i.target))) {
          nextProjectWatermark.delete(m.agentKey);
          deps.log?.(`  WARNING: [linked-eventing] project-member cap: ${m.agentKey} (${m.projectKey}) has more changed members than maxLinkedItems (${m.rule.maxLinkedItems}) allows this tick; watermark held so the skipped member(s) are retried next tick, not lost`);
        }
      }

      // BUTCHR-469: from here on, an issue owner and a project owner are
      // handled UNIFORMLY — the coalescer, rate cap and notify below never
      // fork on which kind of match produced an owner's items. `label` is
      // only ever used for a log line (`rateCappedSuppressedLine`); every
      // other decision reads `perOwnerItems`/`managedTargetsByOwner` by
      // `agentKey` alone.
      const ownerEntries: Array<{ agentKey: string; rule: Rule; label: string }> = [
        ...opted.map((m) => ({ agentKey: m.agentKey, rule: m.rule, label: m.issue.key })),
        ...projectOpted.map((m) => ({ agentKey: m.agentKey, rule: m.rule, label: m.projectKey })),
      ];
      // The subset of `kept` that participates in watch-set/removal
      // tracking: everything, for an issue owner (unchanged pre-BUTCHR-469
      // behaviour — every item it discovers is a real, structural or
      // managed link that can genuinely be "removed"). For a project owner,
      // only its MANAGED-link items: a member item aging out of the
      // watermark window is not a removal (the issue is still a project
      // member, just not recently touched) — see `ProjectLinkedEventingMatch`'s
      // own doc comment.
      const trackedKept = (agentKey: string, kept: readonly LinkedItem[]): LinkedItem[] => {
        const managedTargets = managedTargetsByOwner.get(agentKey);
        return managedTargets ? kept.filter((i) => managedTargets.has(i.target)) : [...kept];
      };

      // ONE combined batched fetch for every Jira-kind linked target across every opted owner this tick — never one call per linked item, never one per owner. BUTCHR-437: filtered to Jira-kind targets only — external-kind targets never ride this call (see this module's own top comment for why they are polled individually instead). BUTCHR-469 (review round 1 fix): a target already fetched by a project owner's own member-discovery search this tick (`memberFetchedByKey`) is excluded here — that search already returned full, fresh issue data, so re-requesting the same key via `key in (...)` would be a redundant second Jira call for data already in hand.
      const allTargets = new Set<string>();
      for (const items of perOwnerItems.values()) for (const i of items) if (JIRA_DISCOVERY_KINDS.has(i.kind) && !memberFetchedByKey.has(i.target)) allTargets.add(i.target);
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
      // kind this tick (external-kind items are skipped too, even though
      // their own fetch never ran — a partial tick that reports external
      // changes while silently dropping every Jira-kind one would be its own
      // kind of misleading): the next tick's fetch, if it succeeds, diffs
      // against the SAME unadvanced state and re-derives whatever was
      // genuinely outstanding, so nothing is lost, only delayed, exactly
      // like a rate-capped tick. This intentionally ALSO discards a
      // successful member-discovery search's own already-fetched data for
      // this same tick — a partial tick that reports member changes while
      // dropping every managed/native-link one would be its own kind of
      // misleading. Nothing is lost here either: every project owner's
      // watermark advance is committed only inside `advance()` further
      // below, which this early `return` never reaches, so the next tick's
      // member search re-derives the SAME window (plus anything new) rather
      // than skipping past whatever this tick already (uncommitted-ly) saw.
      if (searchFailed) return;
      const byKey = new Map<string, JiraIssue>([...memberFetchedByKey, ...fetched.map((i) => [i.key, i] as const)]);

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
            const comments = await deps.comments!(key);
            return comments[0]?.id ?? null;
          } catch (e) {
            deps.log?.(`  WARNING: [linked-eventing] comment fetch failed for ${key}: ${(e as Error)?.message ?? e}`);
            return undefined;
          }
        });
        targets.forEach((key, i) => { const c = cursors[i]; if (c !== undefined) commentCursorByTarget.set(key, c); });
      }

      // Removed-link candidates, against each owner's watch set as of the LAST poll this ran for it — read before anything below mutates that set. BUTCHR-469: compared against `trackedKept`, not raw `kept` — see that helper's own doc comment for why a project owner's member-sourced items must never surface here.
      const removedByOwner = new Map<string, LinkedChangeEvent[]>();
      for (const entry of ownerEntries) {
        const prevSet = watchSets.get(entry.agentKey);
        if (!prevSet) continue;
        const keptTargets = new Set(trackedKept(entry.agentKey, perOwnerItems.get(entry.agentKey)!).map((i) => i.target));
        const gone: LinkedChangeEvent[] = [];
        for (const [target, kind] of prevSet) if (!keptTargets.has(target)) gone.push({ target, kind, detail: "no longer linked" });
        if (gone.length) removedByOwner.set(entry.agentKey, gone);
      }

      // BUTCHR-437 (PR #401 review round 1): poll-cadence gate for the THREE
      // EXTERNAL pollers, decided per owner BEFORE any of them are actually
      // polled — the Jira-kind batched search above stays free/every-tick,
      // exactly as story 2 left it. `linkedPollIntervalMs` absent means
      // "every tick", the same "absent = uncapped" convention
      // `maxLinkedItems`/`maxLinkedTurnsPerHour` already use. Recorded
      // IMMEDIATELY (an attempt, not an outcome) — see this module's own top
      // comment for why this is deliberately outside the rate-cap's
      // "advance only on success" discipline.
      const dueForExternalByOwner = new Map<string, boolean>();
      for (const entry of ownerEntries) {
        const interval = entry.rule.linkedPollIntervalMs;
        const lastPoll = lastExternalPollAt.get(entry.agentKey);
        const due = interval === undefined || lastPoll === undefined || now() - lastPoll >= interval;
        dueForExternalByOwner.set(entry.agentKey, due);
        if (due) lastExternalPollAt.set(entry.agentKey, now());
      }

      // BUTCHR-437 (PR #401 review round 1): every due owner's external-kind
      // items, across every owner, polled CONCURRENTLY (bounded by
      // `EXTERNAL_POLL_CONCURRENCY`) rather than one at a time inside the
      // per-owner loop below — see `mapLimit`'s own doc comment for why a
      // sequential await here would let one slow/stalled item hold up every
      // other item's and every other owner's tick. Results are looked up by
      // `bkey` in the synchronous per-owner loop below, mirroring how the
      // Jira-kind path already looks its own batched-search results up by
      // key via `byKey`.
      interface ExternalTask { agentKey: string; item: LinkedItem; bkey: string; priorFingerprint: string | undefined }
      const externalTasks: ExternalTask[] = [];
      for (const entry of ownerEntries) {
        if (!dueForExternalByOwner.get(entry.agentKey)) continue;
        for (const item of perOwnerItems.get(entry.agentKey)!) {
          if (JIRA_DISCOVERY_KINDS.has(item.kind)) continue;
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

      for (const entry of ownerEntries) {
        const kept = perOwnerItems.get(entry.agentKey)!;
        const wasUnreadable = unreadableOwners.get(entry.agentKey) ?? new Set<string>();
        const removedThisTick = removedByOwner.get(entry.agentKey) ?? [];
        const triggering: LinkedChangeEvent[] = [...removedThisTick];
        const stillUnreadable: LinkedChangeEvent[] = [];
        const toAdvance: Array<() => void> = [];
        const nowUnreadable = new Set<string>();
        const dueForExternal = dueForExternalByOwner.get(entry.agentKey) === true;

        // FACTORY-9 (ticket scope item 2, "drops its cached snapshot so a
        // later re-add does not produce a spurious change"): a removed
        // target's baseline is deleted, not merely left stale — WITHOUT
        // this, `baselines` (which nothing else in this module ever prunes;
        // see this module's own top comment on unbounded growth for a
        // DIFFERENT, still-accepted case: an owner that stops appearing in
        // `opted` entirely) would keep the pre-removal snapshot around
        // forever, so a LATER re-add of the same link would diff the fresh
        // fetch against a stale, possibly long-out-of-date baseline —
        // firing a spurious "changed" event instead of silently reseeding
        // like any other first sighting. Gated behind the SAME `advance()`
        // as every other per-item state change (`toAdvance`), so a
        // rate-capped tick's removal is delayed, not lost, exactly like
        // every other event this module coalesces.
        for (const ev of removedThisTick) {
          toAdvance.push(() => {
            baselines.delete(baselineKey(entry.agentKey, ev.target));
            unreadableOwners.get(entry.agentKey)?.delete(ev.target); // same leak, same fix: a re-added target must not inherit a stale unreadable/readable transition state
          });
        }

        for (const item of kept) {
          if (JIRA_DISCOVERY_KINDS.has(item.kind)) {
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
            if (wasUnreadable.has(item.target)) toAdvance.push(() => unreadableOwners.get(entry.agentKey)?.delete(item.target)); // became readable again
            const snap = snapshotOf(issue, commentCursorByTarget.get(item.target));
            const bkey = baselineKey(entry.agentKey, item.target);
            const beforeRaw = baselines.get(bkey);
            const before = beforeRaw?.kind === "jira" ? beforeRaw.snapshot : undefined;
            if (!before) {
              // BUTCHR-469 (review round 1 fix): a MEMBER-sourced target with
              // no baseline is NOT a neutral "first sighting" to seed
              // silently the way a managed/native link is — the
              // member-discovery search (`project = <key> AND updated >=
              // "-<N>m"`) only ever returns a target that has ALREADY
              // changed since the watermark, so its first appearance IS the
              // change. Silently seeding it here would swallow that change
              // forever (the exact bug this fix addresses — reproduced by a
              // real Jira window search, which never re-returns an
              // unchanged issue the way this module's own OLD fake test
              // double did). A target that is ALSO a managed link, or that
              // already has a baseline from an earlier tick, is unaffected —
              // this branch only ever runs when `before` is genuinely
              // absent.
              if (memberTargetsByOwner.get(entry.agentKey)?.has(item.target)) {
                const watermark = usedWatermarkByOwner.get(entry.agentKey);
                const detail = watermark === undefined ? "updated" : `updated since ${new Date(watermark).toISOString()}`;
                triggering.push({ target: item.target, kind: item.kind, detail });
                toAdvance.push(() => baselines.set(bkey, { kind: "jira", snapshot: snap }));
                continue;
              }
              toAdvance.push(() => baselines.set(bkey, { kind: "jira", snapshot: snap })); // first sighting: seed silently, no event (commentCursor included — see JiraSnapshot's own doc comment)
              continue;
            }
            // FACTORY-9: `commentChangedBetween` catches a comment add/removal
            // defensively even on the (currently theoretical) chance `updated`
            // doesn't move with it; in practice a comment write always bumps
            // `updated` too, so this is belt-and-suspenders, not the primary trigger.
            const commentChanged = commentChangedBetween(before, snap);
            const changed = before.status !== snap.status || before.summary !== snap.summary || before.updated !== snap.updated || commentChanged;
            if (!changed) continue;
            // FACTORY-9: `isDaemonLabelOnlyDiff` only ever inspects
            // status/summary/labels — it has no idea a comment also
            // changed. Gated OFF whenever `commentChanged` is true so a
            // genuine new/removed comment landing in the SAME tick as an
            // unrelated daemon-label move (e.g. agent:working->agent:blocked)
            // is never silently swallowed as "just label noise" — a real
            // comment is never daemon-label-only.
            if (!commentChanged && isDaemonLabelOnlyDiff(asIssue(item.target, before), asIssue(item.target, snap))) {
              toAdvance.push(() => baselines.set(bkey, { kind: "jira", snapshot: snap })); // real move, but daemon-label-only — not a real change here either
              continue;
            }
            if (deps.suppress?.(item.target, snap.updated, entry.agentKey)) {
              toAdvance.push(() => baselines.set(bkey, { kind: "jira", snapshot: snap })); // own-write echo
              continue;
            }
            triggering.push({ target: item.target, kind: item.kind, detail: changeDetail(before, snap) });
            toAdvance.push(() => baselines.set(bkey, { kind: "jira", snapshot: snap }));
            continue;
          }

          // BUTCHR-437: EXTERNAL kind (confluence / github-issue / github-pr /
          // webpage) — for an issue owner, only ever reachable when
          // `entry.rule.linkedDescriptionLinks === true` (see how `kept` is
          // built above); for a project owner, only ever reachable via a
          // managed link to an external target (BUTCHR-469 — project owners
          // have no description to scan). Skipped entirely off its own poll
          // cadence either way. Already polled (concurrently, bounded) in
          // the pre-pass above — this is a synchronous lookup, exactly like
          // the Jira-kind branch's own `byKey.get` above.
          if (!dueForExternal) continue;
          const bkey = baselineKey(entry.agentKey, item.target);
          const beforeRaw = baselines.get(bkey);
          const before = beforeRaw?.kind === "external" ? beforeRaw : undefined;
          const verdict = externalVerdicts.get(bkey)!;
          if (verdict.status === "error") continue; // transient — this item untouched this tick, next due tick retries against the same unadvanced baseline
          if (verdict.status === "unreadable") {
            nowUnreadable.add(item.target);
            const event: LinkedChangeEvent = { target: item.target, kind: item.kind, detail: unreadableDetail(verdict.httpStatus) };
            if (wasUnreadable.has(item.target)) stillUnreadable.push(event);
            else triggering.push(event);
            continue;
          }
          if (wasUnreadable.has(item.target)) toAdvance.push(() => unreadableOwners.get(entry.agentKey)?.delete(item.target)); // became readable again
          if (verdict.status === "not-modified") continue; // the server itself confirmed no change — fingerprint unchanged by definition, nothing to advance beyond the unreadable-recovery above
          if (!before) {
            toAdvance.push(() => baselines.set(bkey, { kind: "external", fingerprint: verdict.fingerprint })); // first sighting: seed silently, no event
            continue;
          }
          if (verdict.fingerprint === before.fingerprint) continue; // unchanged (a server with no conditional-GET support still answered 200 with the same content)
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

        // Still-unreadable context only ever rides a message some OTHER
        // trigger already earns — an unreadable-only tick with no transition
        // sends nothing (see this module's own top comment).
        if (triggering.length) eventsByOwner.set(entry.agentKey, [...triggering, ...stillUnreadable]);
        advanceByOwner.set(entry.agentKey, () => {
          for (const fn of toAdvance) fn();
          watchSets.set(entry.agentKey, new Map(trackedKept(entry.agentKey, kept).map((i) => [i.target, i.kind])));
          // BUTCHR-469: commit this tick's project-watermark advance too,
          // deferred exactly like every other piece of state above — never
          // on a rate-capped tick (the loop below only calls `advance()`
          // once a tick is genuinely delivered or has nothing to deliver).
          // A no-op for an issue owner (never present in this map).
          const wm = nextProjectWatermark.get(entry.agentKey);
          if (wm !== undefined) projectWatermarks.set(entry.agentKey, wm);
        });
      }

      for (const entry of ownerEntries) {
        const advance = advanceByOwner.get(entry.agentKey)!;
        const events = eventsByOwner.get(entry.agentKey);
        if (!events?.length) { advance(); continue; }
        const max = entry.rule.maxLinkedTurnsPerHour;
        if (max !== undefined) {
          const history = (turns.get(entry.agentKey) ?? []).filter((t) => now() - t < SLIDING_WINDOW_MS);
          if (history.length >= max) {
            turns.set(entry.agentKey, history);
            deps.log?.(rateCappedSuppressedLine(entry.label, entry.agentKey, history.length, max));
            continue; // NOT advanced — next allowed tick re-detects everything still outstanding
          }
          history.push(now());
          turns.set(entry.agentKey, history);
        }
        // Advanced only AFTER a successful notify (review round 1, non-
        // blocking note): a throwing notify leaves this owner's state
        // unadvanced too, so "delayed, not lost" holds for a notify failure
        // the same way it already does for a capped tick. (`lastExternalPollAt`
        // is the one exception — see this module's own top comment.)
        await deps.notify(entry.agentKey, entry.agentKey, { linked: { events } });
        advance();
      }
    },
  };
}
