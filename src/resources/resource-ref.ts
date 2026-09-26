/**
 * FACTORY-7 (implementing FACTORY-4/FACTORY-3): the canonical `ResourceRef` —
 * provider + provider-native identity payload, covering exactly the six
 * kinds the epic scopes (authoritative over the handoff doc's longer example
 * list, which also names `jira-idea` and `zendesk-ticket`): `jira-work-item`,
 * `jira-project`, `confluence-page`, `github-issue`, `filesystem`, `webpage`.
 *
 * NAMING TRAP RECORDED HERE ON PURPOSE: this codebase already has a type
 * named `ResourceProvider` (`src/rules/agent-key.ts`), covering a DIFFERENT,
 * overlapping-but-not-identical set — the providers a RULE can staff an
 * agent for (`"jira-work"`, `"github-issue"`, `"jira-project"`, `"jira-idea"`,
 * `"zendesk-ticket"`). Note the string itself already differs
 * (`"jira-work"` there vs. `"jira-work-item"` here) and the member sets
 * differ (no `confluence-page`/`filesystem`/`webpage` there; no `jira-idea`/
 * `zendesk-ticket` here, per this epic's explicit six-kind scope). This
 * module's discriminant is `ResourceRefProvider`, never `ResourceProvider`,
 * so the two can be imported in the same file without collision and are
 * never confused for each other. See `docs/resource-links.md` for the fuller
 * discussion of what else in `src/resources/` this module does and doesn't
 * overlap with (`resource-link.ts`, `types.ts`'s `RelatedResource<T>`).
 *
 * SCHEMA/VERSIONING DECISION: a discriminated union on `provider`, one
 * strict interface per provider (each already independently validated by
 * its own `<provider>-ref.ts` module — reused here, not reimplemented). This
 * module itself carries no version tag; `v: 1` lives on the PERSISTED link
 * COLLECTION instead (`src/resources/link-store.ts`), per the decision that
 * a ref's shape is pinned to the collection format it's stored in, not to
 * itself individually. See that module's own header for the unknown-version/
 * unknown-provider handling this decision requires.
 *
 * CANONICAL STRING FORM DOUBLES AS THE DEDUP KEY — deliberately one
 * mechanism, not two: `formatResourceRef` already fully normalizes (case-
 * folds a Jira key, lower-cases a GitHub owner/repo, strips a webpage's
 * default port/fragment/trailing slash, …), so two refs are the same link
 * IFF their canonical strings are equal. `canonicalKey` below is a thin,
 * intent-documenting alias of `formatResourceRef` — not a second
 * normalization step — so the string a human sees in `butchr link list` is
 * exactly the string dedup/idempotency compare against.
 */
import { formatGithubIssueRef, githubIssueRefFromUrl, parseGithubIssueRef, type GithubIssueRef } from "./github-issue-ref.js";
import { formatJiraWorkItemRef, parseJiraWorkItemRef, type JiraWorkItemRef } from "./jira-work-item-ref.js";
import { formatJiraProjectRef, parseJiraProjectRef, type JiraProjectRef } from "./jira-project-ref.js";
import { formatConfluencePageRef, parseConfluencePageRef, type ConfluencePageRef } from "./confluence-page-ref.js";
import { formatFilesystemRef, parseFilesystemRef, type FilesystemRef } from "./filesystem-ref.js";
import { formatWebpageRef, parseWebpageRef, type WebpageRef } from "./webpage-ref.js";

export const RESOURCE_REF_PROVIDERS = ["jira-work-item", "jira-project", "confluence-page", "github-issue", "filesystem", "webpage"] as const;
export type ResourceRefProvider = (typeof RESOURCE_REF_PROVIDERS)[number];

export type ResourceRef =
  | ({ provider: "jira-work-item" } & JiraWorkItemRef)
  | ({ provider: "jira-project" } & JiraProjectRef)
  | ({ provider: "confluence-page" } & ConfluencePageRef)
  | ({ provider: "github-issue" } & GithubIssueRef)
  | ({ provider: "filesystem" } & FilesystemRef)
  | ({ provider: "webpage" } & WebpageRef);

function splitCanonical(input: string): { provider: string; rest: string } | null {
  const i = input.indexOf(":");
  if (i < 0) return null;
  const provider = input.slice(0, i);
  const rest = input.slice(i + 1);
  return rest.length ? { provider, rest } : null;
}

/**
 * Parses a canonical `<provider>:<id>` string (e.g. `"jira-project:BUTCHR"`,
 * `"github-issue:brooswit-factory/butchr#42"`) into a `ResourceRef`. THROWS
 * with a specific, actionable message for every failure mode — an unknown
 * provider, or a provider-shaped-but-invalid payload — per this story's own
 * "runtime validation ... that rejects malformed input with clear errors"
 * requirement. Use `tryParseResourceRef` where a non-throwing result is
 * wanted instead (e.g. skipping an unrecognised stored entry).
 */
export function parseResourceRef(input: string): ResourceRef {
  const split = splitCanonical(input);
  if (!split) throw new Error(`invalid resource reference ${JSON.stringify(input)}: expected "<provider>:<id>", e.g. "jira-project:BUTCHR"`);
  const { provider, rest } = split;
  switch (provider) {
    case "jira-work-item": {
      const ref = parseJiraWorkItemRef(rest);
      if (!ref) throw new Error(`invalid jira-work-item reference ${JSON.stringify(rest)}: expected a Jira issue key, e.g. "jira-work-item:BUTCHR-123"`);
      return { provider, ...ref };
    }
    case "jira-project": {
      const ref = parseJiraProjectRef(rest);
      if (!ref) throw new Error(`invalid jira-project reference ${JSON.stringify(rest)}: expected a Jira project key, e.g. "jira-project:BUTCHR"`);
      return { provider, ...ref };
    }
    case "confluence-page": {
      const ref = parseConfluencePageRef(rest);
      if (!ref) throw new Error(`invalid confluence-page reference ${JSON.stringify(rest)}: expected a numeric page id or a Confluence page URL, e.g. "confluence-page:123456"`);
      return { provider, ...ref };
    }
    case "github-issue": {
      // Accepts either the bare canonical "<owner>/<repo>#<number>" form
      // (already lower-case only — `parseGithubIssueRef` itself never
      // case-folds, see that module's own header) OR a full GitHub issue
      // URL, whose owner/repo `githubIssueRefFromUrl` DOES lower-case —
      // the same "bare id or URL" ergonomic already decided for
      // confluence-page above, and the only path by which a github-issue
      // ResourceRef case-folds at all.
      const ref = parseGithubIssueRef(rest) ?? githubIssueRefFromUrl(rest);
      if (!ref) throw new Error(`invalid github-issue reference ${JSON.stringify(rest)}: expected "<owner>/<repo>#<number>" or a GitHub issue URL, e.g. "github-issue:brooswit-factory/butchr#42"`);
      return { provider, ...ref };
    }
    case "filesystem": {
      const ref = parseFilesystemRef(rest);
      if (!ref) throw new Error(`invalid filesystem reference ${JSON.stringify(rest)}: expected an absolute path, e.g. "filesystem:/srv/factory/butchr"`);
      return { provider, ...ref };
    }
    case "webpage": {
      const ref = parseWebpageRef(rest);
      if (!ref) throw new Error(`invalid webpage reference ${JSON.stringify(rest)}: expected an http(s) URL, e.g. "webpage:https://example.com/resource"`);
      return { provider, ...ref };
    }
    default:
      throw new Error(`unknown resource provider ${JSON.stringify(provider)}: expected one of ${RESOURCE_REF_PROVIDERS.join(", ")}`);
  }
}

/** Non-throwing twin of `parseResourceRef` — `null` for anything invalid, including an unknown provider. */
export function tryParseResourceRef(input: string): ResourceRef | null {
  try { return parseResourceRef(input); } catch { return null; }
}

/** The canonical `<provider>:<id>` string form — see this module's header for why it is also the dedup key. Throws if `ref` is not itself valid (defensive — mirrors every `format*Ref` it delegates to). */
export function formatResourceRef(ref: ResourceRef): string {
  switch (ref.provider) {
    case "jira-work-item": return `jira-work-item:${formatJiraWorkItemRef(ref)}`;
    case "jira-project": return `jira-project:${formatJiraProjectRef(ref)}`;
    case "confluence-page": return `confluence-page:${formatConfluencePageRef(ref)}`;
    case "github-issue": return `github-issue:${formatGithubIssueRef(ref)}`;
    case "filesystem": return `filesystem:${formatFilesystemRef(ref)}`;
    case "webpage": return `webpage:${formatWebpageRef(ref)}`;
    default: {
      const exhaustive: never = ref;
      throw new Error(`unreachable: unknown resource provider ${JSON.stringify((exhaustive as { provider?: unknown })?.provider)}`);
    }
  }
}

/** Two refs are the same link iff `canonicalKey(a) === canonicalKey(b)` — see this module's header. */
export const canonicalKey = formatResourceRef;
