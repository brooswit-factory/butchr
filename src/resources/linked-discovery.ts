/**
 * BUTCHR-429 (implementing BUTCHR-426, story 1/4 of epic BUTCHR-421): pure
 * parse of a resource's OWN already-fetched data into a typed, de-duplicated
 * set of linked items — Jira `issuelinks` (every type, both directions),
 * `parent`, Jira remote links, and Jira/Confluence/GitHub/webpage URLs found
 * in description text. Zero I/O, zero new API calls: every function here
 * takes data a caller already has in hand.
 *
 * WHAT IS AND ISN'T "ALREADY FETCHED", VERIFIED AGAINST THIS REPO AT THIS
 * TICKET'S OWN COMMIT (re-verify before relying on this if it's drifted):
 * - `issuelinks` and `parent` ARE already on every `JiraIssue` a rule's
 *   `search()` returns — `SEARCH_FIELDS` (src/atlassian/client.ts) includes
 *   both, specifically so a per-poll consumer (e.g. `bossKeyFrom`,
 *   src/resources/issue.ts) needs no second per-issue call. `issuelinkItems`/
 *   `parentItems` below are safe to call on every poll's data for free.
 * - Jira remote links are NOT part of `search()`'s fields — they are a
 *   separate REST endpoint (`AtlassianClient#remoteLinks`, one call per
 *   issue) that no `jira-work` poll path calls today. `remoteLinkItems`
 *   below is a pure parser over `JiraRemoteLink[]`, ready for a caller that
 *   already has that array (e.g. `src/resources/jira-idea.ts`'s
 *   `linkedGithubIssues`, which already narrows the same endpoint's result
 *   to GitHub-issue-shaped links for jira-idea's own related-discovery) —
 *   this module adds NO new fetch to obtain it.
 * - An issue's description is likewise NOT part of `search()`'s fields —
 *   only the single-issue detail fetch (`AtlassianClient#issue`) carries it,
 *   and that fetch runs only on-demand (e.g. `jira-idea.ts`'s `get`), never
 *   during a routine poll. `descriptionItems` below is a pure parser over a
 *   PLAIN-TEXT string (Jira's ADF is already flattened by `adfToText` before
 *   it reaches any caller of `AtlassianClient#issue` — see that method — so
 *   nothing here needs to understand ADF itself), ready for a caller that
 *   already has description text in hand.
 *
 * See this ticket's PR/doc for exactly where each of these is wired at
 * runtime today, and where it is exposed-but-unwired pending a future story.
 */
import type { IssueLink, JiraRemoteLink } from "../atlassian/types.js";
import { isIssueKey } from "./id.js";
import { formatGithubIssueRef, githubIssueRefFromUrl, githubPrRefFromUrl } from "./github-issue-ref.js";

export type LinkedItemKind =
  | "issuelink"
  | "parent"
  | "remote-link"
  | "jira-key"
  | "confluence"
  | "github-issue"
  | "github-pr"
  | "webpage";

/**
 * One discovered link. `target` is the stable identity `discoverLinkedItems`
 * de-dupes on: a Jira issue key for `issuelink`/`parent`/`jira-key`, a URL
 * for `remote-link`/`confluence`/`webpage`, and the canonical `owner/repo#n`
 * (`formatGithubIssueRef`) for `github-issue`/`github-pr` — the same
 * identity this codebase already uses for a GitHub issue's own resource id,
 * so a linked GitHub issue's target matches its `github-issue` agent key
 * verbatim.
 */
export interface LinkedItem {
  kind: LinkedItemKind;
  target: string;
}

/** Jira `issuelinks`: every type, both directions — unlike `src/jira-watch/routes.ts`'s `watchedKeys`, nothing here is filtered to `Implements`. */
export function issuelinkItems(links: readonly IssueLink[]): LinkedItem[] {
  return links.map((l) => ({ kind: "issuelink" as const, target: l.key }));
}

/** Jira's native `parent` (e.g. an Epic) — see `JiraIssue.parent`'s own doc comment for why this fleet's own hierarchy uses `Implements` instead and this field is usually null here; other Jira sites and issue types do carry it. */
export function parentItems(parent: string | null | undefined): LinkedItem[] {
  return parent ? [{ kind: "parent" as const, target: parent }] : [];
}

/** Every Jira remote issue link, as a target URL — see this module's own top comment for where the input array comes from at runtime. */
export function remoteLinkItems(links: readonly JiraRemoteLink[]): LinkedItem[] {
  return links.map((l) => ({ kind: "remote-link" as const, target: l.url }));
}

/** A bare Jira issue key, anywhere in text (not only inside a URL) — reuses `isIssueKey` (src/resources/id.ts), the same charset `src/tools/docs.ts`'s doc-binding path already treats as "shaped like an issue key", rather than a third regex disagreeing with the two that module's own doc comment already warns about. */
const KEY_CANDIDATE_RE = /\b[A-Z][A-Z0-9_]*-[0-9]+\b/g;

/** Any `http(s)://` URL, trimmed of common trailing prose punctuation (`.`, `,`, closing brackets/quotes, …) picked up by an unanchored match — never a bare filesystem path, which has no scheme to match at all. */
const URL_CANDIDATE_RE = /https?:\/\/[^\s<>"'`\[\]]+/g;
const TRAILING_PUNCT_RE = /[.,;:!?)\]}'"]+$/;

function stripTrailingPunct(raw: string): string {
  let url = raw;
  for (let prev = ""; prev !== url; ) { prev = url; url = url.replace(TRAILING_PUNCT_RE, ""); }
  return url;
}

const ATLASSIAN_CLOUD_HOST_RE = /\.atlassian\.net$/;

/**
 * Classifies one already-extracted URL, most-specific kind first, so a URL
 * is classified exactly ONCE: a Jira browse URL is `jira-key` (never also
 * `webpage`), a Confluence page URL is `confluence`, a GitHub issue/PR URL is
 * `github-issue`/`github-pr` (reusing `githubIssueRefFromUrl`/
 * `githubPrRefFromUrl`, which are mutually exclusive by path already), and
 * everything else that is genuinely `http(s)` falls to the `webpage`
 * catch-all. Returns `null` for a non-`http(s)` scheme or an unparseable
 * string (never thrown).
 */
function classifyUrl(rawUrl: string): LinkedItem | null {
  const url = stripTrailingPunct(rawUrl);
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (ATLASSIAN_CLOUD_HOST_RE.test(u.hostname)) {
    const browse = /^\/browse\/([^/]+)\/?$/.exec(u.pathname);
    if (browse && isIssueKey(browse[1]!)) return { kind: "jira-key", target: browse[1]! };
    if (u.pathname.startsWith("/wiki/")) return { kind: "confluence", target: url };
  }
  const issueRef = githubIssueRefFromUrl(url);
  if (issueRef) return { kind: "github-issue", target: formatGithubIssueRef(issueRef) };
  const prRef = githubPrRefFromUrl(url);
  if (prRef) return { kind: "github-pr", target: formatGithubIssueRef(prRef) };
  return { kind: "webpage", target: url };
}

/**
 * Every link findable in free-form description text (already flattened to
 * plain text — see this module's own top comment): bare Jira keys, Jira
 * browse URLs, Confluence page URLs, GitHub issue/PR URLs, and a generic
 * `http(s)` webpage catch-all. A local filesystem path (`/etc/passwd`,
 * `C:\Users\x`, a relative path) never matches anything here — every
 * classifier requires either the Jira-key charset or a literal `http(s)://`
 * scheme, neither of which a filesystem path has.
 */
export function descriptionItems(description: string): LinkedItem[] {
  const items: LinkedItem[] = [];
  for (const m of description.matchAll(KEY_CANDIDATE_RE)) {
    if (isIssueKey(m[0])) items.push({ kind: "jira-key", target: m[0] });
  }
  for (const m of description.matchAll(URL_CANDIDATE_RE)) {
    const item = classifyUrl(m[0]);
    if (item) items.push(item);
  }
  // De-duped here too, not only in `discoverLinkedItems`: a Jira browse URL's
  // own key (e.g. `.../browse/BUTCHR-426`) is found by BOTH the bare-key scan
  // above and the URL scan below, which would otherwise report `BUTCHR-426`
  // twice from this one function alone.
  return dedupeByTarget(items);
}

/** Everything `discoverLinkedItems` can be given — each field independently optional so a caller supplies only what it actually already has (see this module's own top comment for which fields a live `jira-work` poll has today). */
export interface LinkedDiscoverySource {
  issuelinks?: readonly IssueLink[] | undefined;
  parent?: string | null | undefined;
  remoteLinks?: readonly JiraRemoteLink[] | undefined;
  description?: string | undefined;
}

/**
 * The combined, de-duplicated link set for one resource: `issuelinks`, then
 * `parent`, then remote links, then description-derived links, in that
 * order — the order `capLinkedItems` below caps against, so when a
 * `maxLinkedItems` cap bites, the earlier (structured, cheaper-to-confirm)
 * kinds are kept over later (free-text-derived) ones. De-dup is by `target`
 * alone, first occurrence wins: the SAME Jira key reached via an `issuelink`
 * AND a bare mention in the description collapses to one `issuelink` entry,
 * never two.
 */
export function discoverLinkedItems(source: LinkedDiscoverySource): LinkedItem[] {
  return dedupeByTarget([
    ...issuelinkItems(source.issuelinks ?? []),
    ...parentItems(source.parent ?? null),
    ...remoteLinkItems(source.remoteLinks ?? []),
    ...descriptionItems(source.description ?? ""),
  ]);
}

/** `items`, de-duplicated by `target` alone — first occurrence (and its `kind`) wins. */
function dedupeByTarget(items: readonly LinkedItem[]): LinkedItem[] {
  const seen = new Set<string>();
  const out: LinkedItem[] = [];
  for (const item of items) {
    if (seen.has(item.target)) continue;
    seen.add(item.target);
    out.push(item);
  }
  return out;
}

/** `items`, capped at `max` (a positive integer) — the first `max` in `items`' own order are `kept`, the rest are `skipped`, NEVER silently dropped. `max === undefined` (the knob absent) means uncapped: everything is `kept`, nothing is ever `skipped`. */
export function capLinkedItems(items: readonly LinkedItem[], max: number | undefined): { kept: LinkedItem[]; skipped: LinkedItem[] } {
  if (max === undefined || items.length <= max) return { kept: [...items], skipped: [] };
  return { kept: items.slice(0, max), skipped: items.slice(max) };
}
