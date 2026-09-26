/**
 * FACTORY-9 (implements FACTORY-6, epic FACTORY-3, story 3/3): wires
 * FACTORY-4's link model (`resource-ref.ts`, `managed-links.ts`,
 * `link-store.ts`) into the EXISTING BUTCHR-436/437 linked-eventing notify
 * path (`src/jira-watch/linked-eventing.ts`) — no second notification
 * mechanism. See `docs/resource-links.md` for the merge/dedup contract this
 * module is built on, and that same doc's own "What FACTORY-5/FACTORY-6
 * should consume" section for the stable surface reused here unchanged.
 *
 * SCOPE, TODAY: the only live OWNER this daemon staffs through
 * `createRuleResourceType` is a `jira-work-item` (`RuleMatch`,
 * src/rules/resource-type.ts) — FACTORY-5's `jira-project` resource type is
 * a DIFFERENT, not-yet-merged resource type entirely (its own poll loop),
 * so this module's owner-side functions are jira-work-item-specific. The
 * TARGET side is provider-agnostic (`resourceRefToLinkedItem` below covers
 * every `ResourceRefProvider` FACTORY-4 defines), so a future jira-project
 * (or any other) owner can reuse `managedLinkedItems` unchanged once it
 * exists — nothing here assumes the owner is a Jira work item beyond
 * `nativeJiraRefs`'s own signature.
 *
 * WHY NATIVE ISN'T FETCHED VIA `ProviderAdapter.nativeLinks`: for a
 * jira-work-item owner, its own issuelinks/parent are ALREADY on the
 * `JiraIssue` `searchRules` fetched this poll (`SEARCH_FIELDS`,
 * src/atlassian/client.ts) — the exact "zero new API calls" reasoning
 * `src/resources/linked-discovery.ts`'s own top comment already establishes
 * for `jiraKindLinkedItems`. Re-deriving the same data through an async
 * `ProviderAdapter.nativeLinks(ref)` call would mean a SECOND Jira fetch per
 * owner per tick for data already in hand — `nativeJiraRefs` below reads it
 * directly instead. `ProviderAdapter` (`provider-adapter.ts`) stays the
 * documented extension point for a FUTURE provider whose native links
 * genuinely need a live fetch by ref alone (nothing here constructs one,
 * same as before this story).
 *
 * WHY THE EXISTING `jiraKindLinkedItems`/`descriptionLinkedItems` OUTPUT IS
 * NEVER RE-DERIVED FROM THE MERGE: those two functions already produce the
 * finer-grained kinds (`issuelink`/`parent`/`remote-link`/`jira-key`/
 * `confluence`/`github-issue`/`github-pr`/`webpage`) existing tests pin
 * verbatim (`test/unit/linked-eventing.test.ts`). Routing a jira-work-item's
 * OWN native links through `mergeEffectiveLinks` and back out would flatten
 * all of them to one generic kind, breaking that pinned reporting. Instead,
 * `managedLinkedItems` below calls `mergeEffectiveLinks(native, managed)`
 * ONLY to learn which `origin` each managed link has, then emits a
 * `LinkedItem` ONLY for the `"managed"`-origin ones — a target already
 * `"native"` or `"both"` is already represented by `jiraKindLinkedItems`'s
 * own output, unchanged, so runTick.ts's caller simply concatenates both
 * arrays with no duplicate watcher for the same target.
 */
import type { JiraIssue } from "../atlassian/types.js";
import { isIssueKey } from "./id.js";
import type { LinkedItem, LinkedItemKind } from "./linked-discovery.js";
import { mergeEffectiveLinks } from "./managed-links.js";
import { listLinks, type LinkStore } from "./link-store.js";
import { canonicalKey, type ResourceRef } from "./resource-ref.js";
import { formatGithubIssueRef } from "./github-issue-ref.js";

/** This owner's own `jira-work-item` `ResourceRef` — the identity `listLinks`/`mergeEffectiveLinks` key managed/native links against. */
export function jiraWorkItemOwnerRef(issue: Pick<JiraIssue, "key">): ResourceRef {
  return { provider: "jira-work-item", key: issue.key };
}

/**
 * BUTCHR-469: a `jira-project` OWNER's own `ResourceRef` — the FACTORY-5/
 * FACTORY-8 counterpart of `jiraWorkItemOwnerRef` above, now that a project
 * is a live owner too (`ProjectLinkedEventingMatch`,
 * src/jira-watch/linked-eventing.ts). `listLinks`/`mergeEffectiveLinks`
 * route this ref's canonical key (`jira-project:<KEY>`) to the Jira
 * project-property-backed store (`createJiraProjectLinkStore`, via
 * `createRoutingLinkStore`) — a project has no structural native links of
 * its own (no issuelinks/parent), so a caller always passes `nativeRefs: []`
 * for this ref, and every managed link on it is "managed"-origin.
 */
export function jiraProjectOwnerRef(key: string): ResourceRef {
  return { provider: "jira-project", key };
}

/**
 * `issue`'s STRUCTURAL native links only — `issuelinks` and `parent` — as
 * `jira-work-item` `ResourceRef`s, de-duplicated by canonical key and
 * excluding `issue`'s own key (a resource cannot link to itself, per
 * `docs/resource-links.md`'s Decision 8; Jira data that somehow did would
 * otherwise poison `mergeEffectiveLinks`'s dedup with a self-referential
 * entry). Deliberately NOT remote links or description-derived mentions —
 * those are opt-in, cost-gated features of `jiraKindLinkedItems`/
 * `descriptionLinkedItems` (`src/jira-watch/linked-eventing.ts`), not
 * unconditional "native" discovery in FACTORY-4's sense (provider-native
 * structural links a search already returns for free). A key not shaped
 * like a Jira issue key (defensive; Jira's own data is always well-formed)
 * is silently skipped, never thrown.
 */
export function nativeJiraRefs(issue: Pick<JiraIssue, "key" | "issuelinks" | "parent">): ResourceRef[] {
  const keys: string[] = [...(issue.issuelinks ?? []).map((l) => l.key), ...(issue.parent ? [issue.parent] : [])];
  const out: ResourceRef[] = [];
  const seen = new Set<string>();
  for (const key of keys) {
    if (!isIssueKey(key) || key === issue.key) continue;
    const ref: ResourceRef = { provider: "jira-work-item", key };
    const canon = canonicalKey(ref);
    if (seen.has(canon)) continue;
    seen.add(canon);
    out.push(ref);
  }
  return out;
}

/**
 * `ref`'s own `LinkedItem` kind/target, reusing the EXISTING kind taxonomy
 * so a managed link to a target this codebase already knows how to watch
 * rides the SAME diffing/polling path a natively- or description-discovered
 * link of that kind already uses — never a parallel mechanism:
 * - `jira-work-item` → `"jira-key"` (the existing Jira-kind batched-search
 *   diff in `linked-eventing.ts`, now also comment-aware — see this
 *   module's own doc comment there).
 * - `confluence-page` → `"confluence"`: `target` is the BARE page id (the
 *   ref's own canonical form), not a URL — `pollConfluencePage`
 *   (`src/jira-watch/external-poll.ts`) accepts either, FACTORY-9's own
 *   addition to that function.
 * - `github-issue` → `"github-issue"`: `target` is the canonical
 *   `owner/repo#n` string, the SAME identity `pollGithubLink` already
 *   expects — no adaptation needed. (FACTORY-4 has no distinct `github-pr`
 *   ResourceRef provider — GitHub's issue/PR numbers share one per-repo
 *   namespace, and a managed `github-issue` link to a PR number still polls
 *   correctly via `pollGithubLink`'s own `kind: "github-issue"` REST path,
 *   which reads `/issues/<n>` — GitHub serves a PR through that same
 *   endpoint too, just without PR-specific fields this poller never reads.)
 * - `webpage` → `"webpage"`: `target` is the ref's own normalized URL,
 *   already exactly what `pollWebpage` expects.
 * - `filesystem` → `"filesystem"` (FACTORY-9's new kind/poller, see
 *   `external-poll.ts`'s own `pollFilesystem`).
 * - `jira-project` → `null`, an EXPLICIT, DOCUMENTED SCOPE GAP: no live
 *   Jira API call exists anywhere in this codebase to fetch a PROJECT's own
 *   change signature (`search()` is issue-JQL-shaped; there is no
 *   project-level `updated`/comment-count endpoint wired here), and
 *   FACTORY-5 (the story that would give a `jira-project` a live agent to
 *   even ask for one) is not merged. Reconciling a `jira-project` as an
 *   OWNER is FACTORY-5's own resource type, untouched by this module,
 *   which only ever runs for a `jira-work-item` owner (see this module's
 *   own top comment). A `jira-project` managed-link TARGET is therefore
 *   silently excluded from every owner's watch set — never a crash, and no
 *   different in effect from an omitted `ProviderAdapter.changeToken` per
 *   that interface's own doc comment ("a provider with nothing native to
 *   discover ... may omit it entirely").
 */
export function resourceRefToLinkedItem(ref: ResourceRef): LinkedItem | null {
  switch (ref.provider) {
    case "jira-work-item": return { kind: "jira-key", target: ref.key };
    case "confluence-page": return { kind: "confluence", target: ref.pageId };
    case "github-issue": return { kind: "github-issue", target: formatGithubIssueRef(ref) };
    case "webpage": return { kind: "webpage", target: ref.url };
    case "filesystem": return { kind: "filesystem", target: ref.path };
    case "jira-project": return null;
    default: return null; // unreachable for a well-formed ResourceRef; defensive, never thrown
  }
}

/** Every kind `resourceRefToLinkedItem` can produce — used by `linked-eventing.ts` to route a managed-link item to the right diff/poll path, same as it already does for `jiraKindLinkedItems`/`descriptionLinkedItems` output. */
export const MANAGED_LINK_KINDS: ReadonlySet<LinkedItemKind> = new Set(["jira-key", "confluence", "github-issue", "webpage", "filesystem"]);

/**
 * `ownerRef`'s butchr-MANAGED links (`store`), merged against `nativeRefs`
 * (see `nativeJiraRefs` above) purely to learn each managed link's
 * `origin` — only a `"managed"`-origin (i.e. NOT already covered by native
 * discovery) link becomes a NEW `LinkedItem` here; `"native"`/`"both"` are
 * already represented by the caller's own separate native-discovery items
 * (see this module's own top comment for why). A managed link this build
 * cannot map to a watchable kind (today, only `jira-project` — see
 * `resourceRefToLinkedItem`) is skipped and logged ONCE per (owner, target)
 * per call via `log`, never thrown; a store read failure propagates to the
 * caller, which already wraps this in its own try/catch (mirroring every
 * other per-owner fetch in `linked-eventing.ts`'s `runTick`).
 */
export async function managedLinkedItems(
  ownerRef: ResourceRef,
  nativeRefs: readonly ResourceRef[],
  store: LinkStore,
  log?: (line: string) => void,
): Promise<LinkedItem[]> {
  const managed = await listLinks(store, ownerRef);
  const effective = mergeEffectiveLinks(nativeRefs, managed);
  const out: LinkedItem[] = [];
  for (const link of effective) {
    if (link.origin !== "managed") continue;
    const item = resourceRefToLinkedItem(link.ref);
    if (item) { out.push(item); continue; }
    log?.(`  WARNING: [link-reconcile] managed link ${canonicalKey(ownerRef)} -> ${canonicalKey(link.ref)}: unsupported target kind, not watched`);
  }
  return out;
}
