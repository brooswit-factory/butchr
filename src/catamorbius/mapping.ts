/**
 * FACTORY-134 (task 1/2 of story FACTORY-22): pure mapping between butchr's
 * watched resources and Catamorbius CloudEvents. Zero I/O — every function
 * here is a total, synchronous function over data the caller already has.
 * Built on the existing provider-capability model (`../resources/
 * capabilities.ts`'s `catamorbiusPush`), not a parallel table: a resource
 * this module maps is exactly a resource whose `CapabilityRef` supports
 * `catamorbiusPush` (see that module's MATRIX — `jira-work-item`,
 * `github-issue`, `github-pr`; nothing else).
 *
 * WIRE CONTRACT THIS MODULE IS VERIFIED AGAINST (re-verify at your own
 * checkout — see docs/catamorbius-push.md for the full citation and any
 * divergence found): the gateway's README "The event format contract"
 * section, and its GitHub/Jira subsections, at commit
 * d147fbe292b721711300a9fac0c50e0e23b7163a of brooswit-factory/catamorbius.
 *
 * NORMALIZED WATCH KEY FORMAT: `jira:<ISSUE-KEY>` (uppercase) or
 * `github:<owner>/<repo>#<number>` (lowercase owner/repo — the same
 * canonical form `formatGithubIssueRef` produces). Deliberately ONE github
 * key shape for BOTH `github-issue` and `github-pr` resources — see trap
 * (c) below.
 *
 * TRAPS THIS MODULE HANDLES, EACH WITH ITS OWN INVARIANT TEST
 * (mapping.test.ts):
 *
 * (a) CASE. butchr canonicalizes GitHub refs to lowercase owner/repo
 *     (`formatGithubIssueRef`). The gateway's CloudEvent `subject` carries
 *     GitHub's `full_name` in ITS real casing (mixed-case orgs/repos are
 *     legal on GitHub). `watchKeysForEvent` lower-cases the owner/repo it
 *     parses out of `subject` before formatting the watch key, so a
 *     mixed-case-repo resource and its mixed-case-repo event agree on the
 *     same lower-case key. No server-side `subject` filter is used for
 *     this reason: an exact-match filter built from butchr's lower-cased
 *     ref would silently miss the gateway's real-cased subject. The client
 *     (task 1) subscribes to one unfiltered (or type-prefix-filtered only)
 *     stream and this module does the subject matching client-side instead.
 *
 * (b) JIRA COMMENTS/WORKLOGS. The gateway's README documents that it does
 *     not know whether a `comment_*`/`worklog_*` payload carries a
 *     top-level `issue` object (Atlassian's own docs never say). When it
 *     does, the gateway's own `subject` is already the issue key, and the
 *     first branch below handles it directly. When it doesn't, `subject`
 *     falls back to a project/sprint/version/board id (or is absent) and
 *     this module ALSO checks `data.raw.body.issue.key` defensively, in
 *     case a future adapter revision carries the issue only in the body —
 *     today's fixtures (`comment-created-without-issue.json` et al.) have
 *     neither, so that path yields `[]` (unmapped) for them, same as the
 *     project-key-subject case: unmapped is a normal, non-error outcome,
 *     never thrown.
 *
 * (c) ISSUE VS PR. A GitHub `subject` of `owner/repo#n` never says whether
 *     `n` is an issue or a pull request — GitHub issues and PRs share one
 *     per-repo number counter. Rather than guess, this module maps BOTH a
 *     `github-issue` and a `github-pr` resource with the same owner/repo/
 *     number to the identical `github:owner/repo#n` watch key, and an
 *     event's `owner/repo#n` subject always produces that same single key.
 *     A caller that must distinguish issue from PR needs a side channel
 *     this module deliberately does not provide (e.g. an API call) — no
 *     such distinction exists on the wire.
 *
 * (d) PUSH / REPO-LEVEL EVENTS. `owner/repo@ref` (push) and a bare
 *     `repository.full_name` subject (repo-level events) concern no
 *     watched issue or PR: `watchKeysForEvent` returns `[]` for both,
 *     unmapped, never an error.
 *
 * (e) TENANT SCOPING (`source`). The gateway's `source` narrows the tenant
 *     — a Jira site host (`//jira/<host>`) or a GitHub owner-derived value
 *     (`//github/<owner-login-or-"unknown">`, NOT necessarily the same
 *     `owner` segment carried in `subject` — see the gateway README's own
 *     `source`-derivation notes for GitHub and Jira). DECISION: this
 *     module does NOT check `source` against any configured site/org list.
 *     Reasons: (1) a pure mapping function has no config to check against
 *     — site/org allowlisting is a deployment fact, not a wire-format
 *     fact; (2) `source` is a coarser, less reliable identity than the
 *     `owner`/`repo`/site-host already embedded in `subject` and in the
 *     resource's own ref — narrowing on it risks FALSE NEGATIVES (e.g. the
 *     GitHub `//github/unknown` fallback source on an owner-less delivery
 *     would wrongly exclude a real, mappable event). A caller that only
 *     wants events from its own configured Atlassian site / GitHub orgs
 *     can filter on `source` itself, one layer up, using the raw
 *     `CatamorbiusCloudEvent.source` this module leaves untouched on its
 *     input and never needs to inspect.
 */
import { formatGithubIssueRef, parseGithubIssueRef } from "../resources/github-issue-ref.js";
import { isIssueKey } from "../resources/id.js";

/**
 * A watched resource in the shape linked-eventing's own item kinds carry
 * (`src/resources/linked-discovery.ts`'s `LinkedItem` — `{kind, target}` —
 * for `jira-key`/`github-issue`/`github-pr`) OR the equivalent structured
 * `ResourceRef`-shaped identity (`{provider, key}` / `{provider, owner,
 * repo, number}`). Both forms are accepted so a caller can pass either a
 * raw `LinkedItem` off `discoverLinkedItems` or a typed `ResourceRef`
 * without first converting one into the other.
 */
export type WatchableResource =
  | { provider: "jira-work-item"; key: string }
  | { provider: "github-issue"; owner: string; repo: string; number: number }
  | { provider: "github-pr"; owner: string; repo: string; number: number }
  | { kind: "jira-key"; target: string }
  | { kind: "github-issue"; target: string }
  | { kind: "github-pr"; target: string };

/** The normalized, provider-agnostic key this module's two functions agree on. */
export type WatchKey = string;

const JIRA_PREFIX = "jira:";
const GITHUB_PREFIX = "github:";

/**
 * The minimal shape `watchKeysForEvent` needs off a Catamorbius CloudEvent —
 * a local mirror of the gateway's own `CloudEvent` (its `src/events/
 * types.ts`), narrowed to the fields this module reads. Never imports the
 * gateway's package: butchr consumes the wire format, not the gateway's
 * source tree.
 */
export interface CatamorbiusCloudEvent {
  source: string;
  subject?: string | undefined;
  data?: { raw?: { body?: unknown } };
}

/** `{owner, repo, number}` triple every GitHub-shaped input below normalizes to before formatting. */
function githubTriple(resource: { owner: string; repo: string; number: number }): { owner: string; repo: string; number: number } | null {
  const parsed = parseGithubIssueRef(`${resource.owner.toLowerCase()}/${resource.repo.toLowerCase()}#${resource.number}`);
  return parsed;
}

/**
 * A watched resource's normalized watch key, or `null` when the resource's
 * provider does not support `catamorbiusPush` (see `capabilitiesOf`) or the
 * identity itself is malformed. Never throws.
 */
export function watchKeyForResource(resource: WatchableResource): WatchKey | null {
  if ("kind" in resource) {
    switch (resource.kind) {
      case "jira-key": {
        const upper = resource.target.toUpperCase();
        return isIssueKey(upper) ? `${JIRA_PREFIX}${upper}` : null;
      }
      case "github-issue":
      case "github-pr": {
        const ref = parseGithubIssueRef(resource.target.toLowerCase());
        return ref ? `${GITHUB_PREFIX}${formatGithubIssueRef(ref)}` : null;
      }
      default: {
        const exhaustive: never = resource;
        return exhaustive;
      }
    }
  }
  switch (resource.provider) {
    case "jira-work-item": {
      const upper = resource.key.toUpperCase();
      return isIssueKey(upper) ? `${JIRA_PREFIX}${upper}` : null;
    }
    case "github-issue":
    case "github-pr": {
      const triple = githubTriple(resource);
      return triple ? `${GITHUB_PREFIX}${formatGithubIssueRef(triple)}` : null;
    }
    default: {
      const exhaustive: never = resource;
      return exhaustive;
    }
  }
}

/** Parses a GitHub `owner/repo#n` subject (case as GitHub spells it) into the lower-cased watch key it concerns, or `[]` if the subject isn't that shape (push/`@ref`, bare repo, unparseable). */
function githubSubjectWatchKeys(subject: string): WatchKey[] {
  const m = /^([^/]+)\/([^/#@]+)#([0-9]+)$/.exec(subject);
  if (!m) return [];
  const [, owner, repo, number] = m as unknown as [string, string, string, string];
  const ref = parseGithubIssueRef(`${owner.toLowerCase()}/${repo.toLowerCase()}#${number}`);
  return ref ? [`${GITHUB_PREFIX}${formatGithubIssueRef(ref)}`] : [];
}

/** `data.raw.body.issue.key`, defensively — see trap (b) in this module's header. `null` for anything else, never throws. */
function jiraIssueKeyFromBody(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const issue = (body as Record<string, unknown>).issue;
  if (typeof issue !== "object" || issue === null) return null;
  const key = (issue as Record<string, unknown>).key;
  if (typeof key !== "string") return null;
  const upper = key.toUpperCase();
  return isIssueKey(upper) ? upper : null;
}

/**
 * The watch key(s) a Catamorbius CloudEvent concerns — `[]` for an event
 * about no watched issue or PR (push, repo-level, project-level, or
 * unmapped Jira events; see traps (b)/(d) above). Never throws. Today
 * always at most one key (no fan-out shape exists in the current wire
 * contract), but returns an array so a future many-subjects event needs no
 * signature change here.
 */
export function watchKeysForEvent(event: CatamorbiusCloudEvent): WatchKey[] {
  if (event.source.startsWith("//github/")) {
    return event.subject ? githubSubjectWatchKeys(event.subject) : [];
  }
  if (event.source.startsWith("//jira/")) {
    if (event.subject) {
      const upper = event.subject.toUpperCase();
      if (isIssueKey(upper)) return [`${JIRA_PREFIX}${upper}`];
    }
    const key = jiraIssueKeyFromBody(event.data?.raw?.body);
    return key ? [`${JIRA_PREFIX}${key}`] : [];
  }
  return [];
}
