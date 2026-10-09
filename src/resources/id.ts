/**
 * BUTCHR-62's binding decision, in code: a resource is identified by a
 * single opaque string carried in the existing `x-issue` MCP header. Until
 * now that string was always an issue key; a PROJECT resource's id is its
 * Jira PROJECT key (e.g. `BUTCHR`) — the header is not renamed and no
 * second header is added, only the meaning of the string widens. FACTORY-996
 * widens it a third way: a managed-session agent whose resource is a
 * Confluence page carries that page's bare numeric id (see
 * `isConfluencePageResourceId` below).
 *
 * DELIBERATELY DEPENDENCY-FREE (one import, the issue-key regex itself —
 * see below) so either sibling story (BUTCHR-64, BUTCHR-65/BUTCHR-71) can
 * import this leaf module without pulling in the rest of the tool layer.
 * FACTORY-996 adds exactly one more: `isConfluencePageRef`
 * (`./confluence-page-ref.js`), itself a leaf module (its own only import is
 * `pageIdFromUrl` from `src/tools/docs.ts`, already a transitive dependency
 * of this module) — no new external dependency surface is introduced.
 *
 * A TRAP RECORDED HERE SO IT ISN'T REDISCOVERED: this codebase has TWO
 * issue-key regexes that DISAGREE, and this module reuses exactly one of
 * them, deliberately.
 *   - `src/tools/docs.ts` exports `JIRA_KEY_RE` = `/^[A-Z][A-Z0-9_]*-[0-9]+$/`
 *     (allows an underscore in the project-prefix segment).
 *   - `src/daemon/index.ts` has a module-private `KEY_RE` =
 *     `/^[A-Z][A-Z0-9]*-\d+$/` (no underscore) — NOT exported, and NOT
 *     touched here. Unifying the two is a BEHAVIOUR CHANGE to the issue
 *     tiers' own poll-loop key matching, ruled OUT of scope for this module
 *     (BUTCHR-62, in a comment on BUTCHR-71): it belongs to BUTCHR-64's
 *     "no behaviour change for the issue tiers" criterion, not here.
 * `isIssueKey` below is built on the EXPORTED `JIRA_KEY_RE` (imported, never
 * retyped) — the more permissive of the two — because it is the one the
 * doc-binding path (`src/tools/docs.ts`) already uses to decide whether a
 * key can be losslessly inverted into a Confluence label; this module's job
 * is the same kind of question ("is this shaped like an issue key at all?"),
 * not the daemon poll loop's narrower one.
 */
import { JIRA_KEY_RE } from "../tools/docs.js";
import { isConfluencePageRef } from "./confluence-page-ref.js";

/** True when `id` is shaped like a Jira ISSUE key (`PROJECT-123`). Delegates to the codebase's one exported issue-key regex — see this file's own doc comment for why that one, and not the daemon loop's private, stricter `KEY_RE`. */
export function isIssueKey(id: string): boolean {
  return JIRA_KEY_RE.test(id);
}

/**
 * Same charset as an issue key's own project-prefix segment (`[A-Z][A-Z0-9_]*`
 * — underscore included, matching `JIRA_KEY_RE`'s prefix), with NO `-<digits>`
 * suffix. A hyphen is never valid inside this pattern, so a string matching
 * `isIssueKey` (which REQUIRES a `-<digits>` suffix) can never also match
 * this one — the two predicates are mutually exclusive by construction, not
 * by a runtime `&&` patched on afterward.
 */
const PROJECT_ID_RE = /^[A-Z][A-Z0-9_]*$/;

/** True when `id` is shaped like a Jira PROJECT key — see `PROJECT_ID_RE`'s own comment for why this can never also match `isIssueKey`. */
export function isProjectId(id: string): boolean {
  return PROJECT_ID_RE.test(id);
}

/**
 * FACTORY-996: true when `id` is shaped like a `confluence-page` resource's
 * own `x-issue` — a bare numeric Confluence page id, e.g. the one a future
 * `confluence-page` ResourceType (FACTORY-992) sets as `SpawnSpec.resource`
 * for the agent it spawns per child page (the same `resource:
 * issue.key`/`resource: resource.path`/`resource: issue.ref` shape every
 * other provider already uses — see `src/rules/resource-type.ts`,
 * `filesystem-type.ts`, `github-issue-type.ts`). DELEGATES to
 * `isConfluencePageRef` (`./confluence-page-ref.ts`) rather than retyping
 * its `/^[0-9]+$/` pattern — one definition of "is this shaped like a
 * Confluence page id" for both the links/`ResourceRef` axis that module
 * already serves and this x-issue-identity axis.
 *
 * MUTUALLY EXCLUSIVE WITH `isIssueKey`/`isProjectId` BY CONSTRUCTION, same
 * guarantee `PROJECT_ID_RE`'s own comment makes for that pair: both of
 * those REQUIRE a leading `[A-Z]`; a bare-numeric string can never start
 * with one, so no string ever satisfies this predicate and either of the
 * other two (`id.test.ts` pins this with a battery, not just an assertion
 * by inspection). It is NOT provably exclusive of a `filesystem` resource's
 * path the same structural way (nothing stops an operator from naming a
 * file `3`) — in practice every `filesystem` resource id is a realpath'd
 * ABSOLUTE path (`src/resources/filesystem.ts`'s `FilesystemResource.path`),
 * which always starts with `/` and therefore never matches `/^[0-9]+$/`
 * either, but that is a property of how paths are constructed today, not a
 * charset guarantee this function enforces the way it does for the other
 * two. Narrow callers (FACTORY-996's own managed-session Confluence read
 * path, `src/tools/defs.ts`) accept that as sufficient for THEIR scope:
 * they only ever read the caller's OWN resource id, so a same-process
 * collision between "this agent's resource is file `3`" and "this agent's
 * resource is Confluence page `3`" cannot leak one agent's read into
 * another's — there is only ever one resource behind one `x-issue` per
 * connection.
 */
export function isConfluencePageResourceId(id: string): boolean {
  return isConfluencePageRef(id);
}
