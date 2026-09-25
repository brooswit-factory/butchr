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
import type { JiraIssue, JiraRemoteLink } from "../atlassian/types.js";
import type { Rule } from "../rules/rules.js";
import type { LinkedChangeEvent, NotifyReason } from "../resources/types.js";
import { capLinkedItems, descriptionItems, discoverLinkedItems, jiraBrowseKey, type LinkedItem, type LinkedItemKind } from "../resources/linked-discovery.js";
import { isDaemonLabelOnlyDiff } from "./diff.js";
import { rateCappedSuppressedLine } from "./suppressed-log.js";
import {
  pollConfluencePage, pollGithubLink, pollWebpage,
  type ConfluencePollDeps, type GithubConditionalDeps, type PollVerdict, type WebpagePollDeps,
} from "./external-poll.js";

/** The minimal shape this module needs from one owning resource's match — structurally satisfied by `RuleMatch` (src/rules/resource-type.ts) without importing it, avoiding a value/type import cycle between that module and this one. */
export interface LinkedEventingMatch {
  agentKey: string;
  rule: Rule;
  issue: JiraIssue;
}

/** Of every kind `discoverLinkedItems` can produce, only these are Jira-kind for THIS module's Jira-diffing path (Confluence/GitHub/webpage are BUTCHR-437's, driven by the external-poll.ts path below). */
const JIRA_DISCOVERY_KINDS = new Set<LinkedItemKind>(["issuelink", "parent", "jira-key"]);

/** BUTCHR-437: the three kinds `external-poll.ts` knows how to poll — everything `descriptionLinkedItems` below can ever return. */
const EXTERNAL_DISCOVERY_KINDS = new Set<LinkedItemKind>(["confluence", "github-issue", "github-pr", "webpage"]);

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

interface JiraSnapshot { status: string; summary: string; updated: string; labels: readonly string[] }
/** BUTCHR-437: the discriminated union `baselines` below stores — see this module's own top comment ("ONE Map holding a discriminated union") for why this replaced the story-2-only `Snapshot` alias. */
type Baseline = { kind: "jira"; snapshot: JiraSnapshot } | { kind: "external"; fingerprint: string };

const snapshotOf = (i: JiraIssue): JiraSnapshot => ({ status: i.status, summary: i.summary, updated: i.updated, labels: i.labels });
/** A minimal fake `JiraIssue`, shaped only well enough for `isDaemonLabelOnlyDiff` (status/summary/labels) — never returned to a caller, never compared on any other field. */
const asIssue = (key: string, s: JiraSnapshot): JiraIssue => ({ key, status: s.status, summary: s.summary, updated: s.updated, labels: [...s.labels], issuetype: "", assignee: null, parent: null });

function changeDetail(before: JiraSnapshot, after: JiraSnapshot): string {
  if (before.status !== after.status) return `status changed from "${before.status}" to "${after.status}"`;
  if (before.summary !== after.summary) return "summary changed";
  return "updated";
}

/** BUTCHR-437: the agent-facing detail phrase for a genuine external-kind change — `before`/`after` are the two opaque fingerprints (see `external-poll.ts`'s own doc comment); only Confluence's is human-meaningful (a version NUMBER), so only that kind names the two values. */
function externalChangeDetail(kind: LinkedItemKind, before: string, after: string): string {
  if (kind === "confluence") return `version changed from ${before} to ${after}`;
  if (kind === "webpage") return "changed";
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
   */
  runTick(matches: readonly LinkedEventingMatch[], deps: LinkedEventingDeps): Promise<void>;
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
  if (item.kind === "confluence") {
    if (!deps.confluenceVersion) return { status: "error" };
    return pollConfluencePage(item.target, { getVersion: deps.confluenceVersion });
  }
  if (item.kind === "github-issue" || item.kind === "github-pr") {
    if (!deps.github) return { status: "error" };
    return pollGithubLink({ kind: item.kind, target: item.target }, priorFingerprint ?? null, deps.github);
  }
  if (item.kind === "webpage") {
    if (!deps.webpage) return { status: "error" };
    return pollWebpage(item, priorFingerprint, deps.webpage);
  }
  return { status: "error" }; // unreachable — EXTERNAL_DISCOVERY_KINDS only ever produces the three kinds above
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
        // BUTCHR-437: description-derived Confluence/GitHub/webpage items are
        // combined with Jira-kind items BEFORE `maxLinkedItems` caps, so the
        // cap applies uniformly across every kind for this resource — never a
        // separate per-kind budget.
        const jiraItems = jiraKindLinkedItems(m, remoteLinks);
        const externalItems = m.rule.linkedDescriptionLinks === true ? descriptionLinkedItems(m) : [];
        const { kept } = capLinkedItems([...jiraItems, ...externalItems], m.rule.maxLinkedItems);
        perOwnerItems.set(m.agentKey, kept);
      }

      // ONE combined batched fetch for every Jira-kind linked target across every opted owner this tick — never one call per linked item, never one per owner. BUTCHR-437: filtered to Jira-kind targets only — external-kind targets never ride this call (see this module's own top comment for why they are polled individually instead).
      const allTargets = new Set<string>();
      for (const items of perOwnerItems.values()) for (const i of items) if (JIRA_DISCOVERY_KINDS.has(i.kind)) allTargets.add(i.target);
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
      // like a rate-capped tick.
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
      for (const m of opted) {
        const interval = m.rule.linkedPollIntervalMs;
        const lastPoll = lastExternalPollAt.get(m.agentKey);
        const due = interval === undefined || lastPoll === undefined || now() - lastPoll >= interval;
        dueForExternalByOwner.set(m.agentKey, due);
        if (due) lastExternalPollAt.set(m.agentKey, now());
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
      for (const m of opted) {
        if (!dueForExternalByOwner.get(m.agentKey)) continue;
        for (const item of perOwnerItems.get(m.agentKey)!) {
          if (JIRA_DISCOVERY_KINDS.has(item.kind)) continue;
          const bkey = baselineKey(m.agentKey, item.target);
          const beforeRaw = baselines.get(bkey);
          const priorFingerprint = beforeRaw?.kind === "external" ? beforeRaw.fingerprint : undefined;
          externalTasks.push({ agentKey: m.agentKey, item, bkey, priorFingerprint });
        }
      }
      const externalVerdicts = new Map<string, PollVerdict>();
      if (externalTasks.length) {
        const verdicts = await mapLimit(externalTasks, EXTERNAL_POLL_CONCURRENCY, (t) => pollExternalItem(t.item, t.priorFingerprint, deps));
        externalTasks.forEach((t, i) => externalVerdicts.set(t.bkey, verdicts[i]!));
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
        const dueForExternal = dueForExternalByOwner.get(m.agentKey) === true;

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
            if (wasUnreadable.has(item.target)) toAdvance.push(() => unreadableOwners.get(m.agentKey)?.delete(item.target)); // became readable again
            const snap = snapshotOf(issue);
            const bkey = baselineKey(m.agentKey, item.target);
            const beforeRaw = baselines.get(bkey);
            const before = beforeRaw?.kind === "jira" ? beforeRaw.snapshot : undefined;
            if (!before) {
              toAdvance.push(() => baselines.set(bkey, { kind: "jira", snapshot: snap })); // first sighting: seed silently, no event
              continue;
            }
            const changed = before.status !== snap.status || before.summary !== snap.summary || before.updated !== snap.updated;
            if (!changed) continue;
            if (isDaemonLabelOnlyDiff(asIssue(item.target, before), asIssue(item.target, snap))) {
              toAdvance.push(() => baselines.set(bkey, { kind: "jira", snapshot: snap })); // real move, but daemon-label-only — not a real change here either
              continue;
            }
            if (deps.suppress?.(item.target, snap.updated, m.agentKey)) {
              toAdvance.push(() => baselines.set(bkey, { kind: "jira", snapshot: snap })); // own-write echo
              continue;
            }
            triggering.push({ target: item.target, kind: item.kind, detail: changeDetail(before, snap) });
            toAdvance.push(() => baselines.set(bkey, { kind: "jira", snapshot: snap }));
            continue;
          }

          // BUTCHR-437: EXTERNAL kind (confluence / github-issue / github-pr /
          // webpage) — only ever reachable when `m.rule.linkedDescriptionLinks
          // === true` (see how `kept` is built above); skipped entirely off
          // its own poll cadence. Already polled (concurrently, bounded) in
          // the pre-pass above — this is a synchronous lookup, exactly like
          // the Jira-kind branch's own `byKey.get` above.
          if (!dueForExternal) continue;
          const bkey = baselineKey(m.agentKey, item.target);
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
          if (wasUnreadable.has(item.target)) toAdvance.push(() => unreadableOwners.get(m.agentKey)?.delete(item.target)); // became readable again
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
        // the same way it already does for a capped tick. (`lastExternalPollAt`
        // is the one exception — see this module's own top comment.)
        await deps.notify(m.agentKey, m.agentKey, { linked: { events } });
        advance();
      }
    },
  };
}
