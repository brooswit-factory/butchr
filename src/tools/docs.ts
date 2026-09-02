import { isApiError } from "confluence.js/core";
import type { AtlassianOps } from "./atlassian.js";

/** The fixed remote-link globalId that carries the ticket -> doc binding. */
export const DOC_LINK_GLOBAL_ID = "butchr:doc";
/** Confluence label prefix carrying the doc -> ticket binding back. */
export const DOC_LABEL_PREFIX = "butchr-ticket-";
/** Marks a freshly created doc as obviously provisional (rule (e): staleness-that-reads-as-authoritative is the failure mode). */
const PROVISIONAL_MARKER = "[unwritten]";
// Confluence's own title limit isn't consistently documented (255 shows up most often); this
// stays comfortably under any figure actually enforced rather than chasing the exact number.
const MAX_TITLE_LEN = 200;
// A depth cap, not a visited-set: a genuine Implements cycle would recurse forever without one,
// and any real boss chain in this fleet is a handful of hops (task -> story -> epic).
const MAX_BOSS_DEPTH = 20;

/** `[A-Z][A-Z0-9_]*-[0-9]+` — any valid Jira key. The lowercase round-trip (KEY -> label -> KEY) is lossless only for keys shaped like this. */
export const JIRA_KEY_RE = /^[A-Z][A-Z0-9_]*-[0-9]+$/;

function assertValidKey(key: string, who: string): void {
  if (!JIRA_KEY_RE.test(key)) {
    throw new Error(`${who}: "${key}" is not a valid Jira key (expected [A-Z][A-Z0-9_]*-[0-9]+) — refusing rather than emitting a label that can't be inverted back to it`);
  }
}

/** `butchr-ticket-<key lowercased>`. Refuses a key the label couldn't losslessly invert back from. */
export function labelForKey(key: string): string {
  assertValidKey(key, "labelForKey");
  return `${DOC_LABEL_PREFIX}${key.toLowerCase()}`;
}

function isProvisional(title: string): boolean {
  return title.startsWith(PROVISIONAL_MARKER);
}

function provisionalTitle(key: string, summary: string): string {
  const base = `${PROVISIONAL_MARKER} ${key} — ${summary}`;
  return base.length > MAX_TITLE_LEN ? `${base.slice(0, MAX_TITLE_LEN - 1)}…` : base;
}

/**
 * The opening line of a freshly created doc. The ticket hyperlink here is an
 * AFFORDANCE for a human reader, NOT THE MECHANISM — the real ticket<->doc
 * binding is the remote link (out) plus the Confluence label (back). Deleting
 * this line, or this whole paragraph, must break nothing; that asymmetry is
 * the entire difference between this design and the prose convention the
 * design page records rejecting for the project-to-space link.
 *
 * IT ALSO CARRIES THE ONLY POINTER TO ASSIST, AND THAT IS DELIBERATE. The
 * assistant documents the estate in a Confluence space (ASSIST) that nothing
 * routed an agent to, and the operator's reason for adding this is the same
 * one this whole epic rests on: knowledge that exists but is never read is
 * not knowledge, and a library nobody is sent to is a diary. This paragraph
 * is the ONLY text the tool itself ever authors, and it is read exactly once,
 * by an agent that has just been born and knows nothing — which makes it the
 * one place a pointer is certain to land.
 *
 * Link the SPACE plus a couple of durable entry points, never a list of
 * pages: an enumeration here goes stale silently and this file is the last
 * place anyone would look to fix it. The space's own index is the list. The
 * two pages linked below were each read before being cited (the cold-start
 * page, the obvious-looking choice, is written for the ASSISTANT operating
 * the fleet, not for a worker agent on a ticket — pointing a newborn worker
 * at it would have been plausible and wrong).
 *
 * This text is TRANSIENT BY DESIGN: the first `set_doc` replaces the whole
 * body, pointer included. That is correct and not a leak to engineer around —
 * by then the agent has read it, and the doc's job has changed from
 * orienting its author to recording what happened.
 */
function provisionalBody(key: string, ticketUrl: string, site: string): string {
  const assist = `${site}/wiki/spaces/ASSIST`;
  return (
    `<p>This doc was created together with <a href="${ticketUrl}">${key}</a>. It has not been written yet and is not a record of anything.</p>` +
    `<p><strong>New here?</strong> The assistant documents this estate — how work is created, routed and reviewed, how the fleet is run, and where it has failed before — in ` +
    `<a href="${assist}/overview">the ASSIST space</a>. Two places to start: ` +
    `<a href="${assist}/pages/12714016">The factory, end to end: how a ticket becomes shipped code</a>, and ` +
    `<a href="${assist}/pages/12386388">Working agreements between the assistant and the agents</a>. ` +
    `Every page there carries the date it was last verified, and the space's own rule is that when a page disagrees with a measurement you just took, the measurement wins.</p>`
  );
}

/**
 * Exported (BUTCHR-35, approved by BUTCHR-27): the Implements link direction
 * is the single most commonly inverted fact in this fleet — on the
 * implementer, the boss is the INWARD side — and one shared reader means one
 * place to be wrong and one place to fix, instead of five relationship verbs
 * (src/tools/relationship.ts) each growing their own version of this read.
 */
export function findBossKey(issue: unknown): string | null {
  const links = (issue as { fields?: { issuelinks?: unknown[] } })?.fields?.issuelinks ?? [];
  for (const l of links as Array<{ type?: { name?: string }; inwardIssue?: { key?: string } }>) {
    // On the IMPLEMENTER (this ticket), its boss appears as `inwardIssue` — see
    // src/atlassian/types.ts's IssueLink doc comment for the live evidence.
    if (l?.type?.name === "Implements" && l.inwardIssue?.key) return l.inwardIssue.key;
  }
  return null;
}

/** Jira's issue `self` URL (`https://site/rest/api/3/issue/…`) with the API suffix stripped, for building a human browse link. */
function siteFromSelf(self: unknown): string | null {
  const s = typeof self === "string" ? self : undefined;
  if (!s) return null;
  const i = s.indexOf("/rest/api/");
  return i === -1 ? null : s.slice(0, i);
}

function pageIdFromUrl(url: string): string | null {
  const m = /\/pages\/(\d+)(?:\/|$)/.exec(url);
  return m?.[1] ?? null;
}

export interface DocResult {
  id: string;
  url: string;
  title: string;
  body: string;
}

export type GetDocResult = { found: false } | ({ found: true } & DocResult);

async function readLinkedPage(ops: AtlassianOps, key: string): Promise<DocResult | null> {
  const link = await ops.getRemoteLink(key, DOC_LINK_GLOBAL_ID);
  const url = link?.object?.url;
  if (!url) return null;
  const id = pageIdFromUrl(url);
  if (!id) return null;
  const page = (await ops.getPage(id)) as { title?: string; body?: { storage?: { value?: string } } } | undefined;
  return {
    id,
    url,
    title: page?.title ?? link?.object?.title ?? "",
    body: page?.body?.storage?.value ?? "",
  };
}

/**
 * Pure read: does `key` already have a doc? NEVER creates one, for the
 * caller's own ticket or any other. On a miss, returns `{ found: false }`
 * — not an error, not a lazily-manufactured page — so an agent can tell
 * "no page" from "empty page" from "call failed". (Reversed from this
 * ticket's original draft, which had the arg-less form create lazily; the
 * settled spec — https://wroosbit.atlassian.net/wiki/spaces/BUTCHR/pages/12484678
 * — makes get_doc the one verb here that writes nothing at all.)
 */
export async function getDoc(ops: AtlassianOps, key: string): Promise<GetDocResult> {
  assertValidKey(key, "get_doc");
  const doc = await readLinkedPage(ops, key);
  return doc ? { found: true, ...doc } : { found: false };
}

/**
 * Resolves a PROJECT's doc: the page named by that project's `butchr`
 * entity property, at `rootDoc.id` — reusing `getProjectProperty`, the same
 * reader `ensureDoc` already calls below, rather than adding a second one.
 * NEVER CREATES A PAGE: a project's root doc always already exists (every
 * live product project, and ASSIST, is provisioned with one ahead of any
 * project agent running — BUTCHR-62's own doc), so unlike `ensureDoc` there
 * is no create/nest/label step here at all, for either `getProjectDoc` or
 * `setProjectDoc` below. A missing property or missing `rootDoc.id` is a
 * REFUSAL naming the project and what's missing, never a fallback to
 * creating a page or to a space default — creating a stray page here would
 * be unrecoverable in a corpus where nothing is ever archived.
 */
export async function projectRootDoc(ops: AtlassianOps, projectKey: string): Promise<DocResult> {
  let prop: { rootDoc?: { id?: string } } | undefined;
  try {
    prop = (await ops.getProjectProperty(projectKey, "butchr")) as typeof prop;
  } catch (e) {
    throw new Error(`project ${projectKey}: "butchr" entity property is unreadable — refusing rather than guessing a root doc (${(e as Error).message})`);
  }
  const rootDocId = prop?.rootDoc?.id;
  if (!rootDocId) {
    throw new Error(`project ${projectKey}: "butchr" entity property is missing rootDoc.id — refusing rather than falling back to a space default`);
  }
  const page = (await ops.getPage(rootDocId)) as { title?: string; body?: { storage?: { value?: string } }; _links?: { base?: string; webui?: string } } | undefined;
  return {
    id: rootDocId,
    url: `${page?._links?.base ?? ""}${page?._links?.webui ?? ""}`,
    title: page?.title ?? "",
    body: page?.body?.storage?.value ?? "",
  };
}

/** Pure read of a PROJECT's root doc — the project-caller counterpart to `getDoc`. Never creates one; see `projectRootDoc`'s own doc comment. */
export async function getProjectDoc(ops: AtlassianOps, projectKey: string): Promise<GetDocResult> {
  const doc = await projectRootDoc(ops, projectKey);
  return { found: true, ...doc };
}

/**
 * Full-body replace of a PROJECT's root doc — the project-caller counterpart
 * to `setDoc`. NEVER calls `ensureDoc`: a root doc always already exists
 * (see `projectRootDoc`), so there is no create/nest/label path here, only
 * resolve-then-replace. Unlike `setDoc`, `title` stays optional even on the
 * very first call: the `[unwritten]` provisional-title gate is an ISSUE-doc
 * concept (a freshly created per-ticket page needs a real title before it
 * can stop looking unwritten) — a root doc is provisioned ahead of time with
 * a real title already, so there is no provisional state to graduate out of.
 */
export async function setProjectDoc(ops: AtlassianOps, projectKey: string, body: string, title?: string): Promise<DocResult> {
  const doc = await projectRootDoc(ops, projectKey);
  await ops.updatePage({ id: doc.id, body, ...(title ? { title } : {}) });
  return { id: doc.id, url: doc.url, title: title ?? doc.title, body };
}

/**
 * Exhaustive scan of `parentId`'s DIRECT children for one labelled
 * `label` — step 3 of ensureDoc.
 *
 * THIS MUST NEVER BE A CQL LABEL SEARCH, even though CQL is one call and
 * obviously tidier. MEASURED live: immediately after creating a page
 * carrying a fresh label, a CQL search for that label returned ZERO hits,
 * while a direct read of the same page's labels — and a direct listing of
 * its parent's children — both returned it instantly. Confluence's CQL
 * index is asynchronous; direct reads are not. A CQL-based step 3 passes
 * every test a human writes slowly by hand and fails exactly in the
 * situation it exists for — a retry seconds after a partial failure — by
 * reporting "no doc" and creating a SECOND page. Rule (d) (no archiving)
 * makes that duplicate permanent.
 *
 * THIS MUST ALSO NEVER STOP AT ONE PAGE OF CHILDREN. `getChildPages` is
 * cursor-paginated (MEASURED live: a `limit`-bounded call came back with
 * `_links.next` set whenever more children existed); a single unpaginated
 * call is the CQL bug wearing a different hat — silently partial on a
 * parent with more children than one page, reporting "no doc" and creating
 * a permanent duplicate. So this follows `nextCursor` to exhaustion.
 */
async function findLabelledChild(ops: AtlassianOps, parentId: string, label: string): Promise<string | null> {
  let cursor: string | undefined;
  do {
    const { results, nextCursor } = await ops.getChildPages(parentId, cursor);
    for (const child of results) {
      const labels = await ops.getPageLabels(child.id);
      if (labels.includes(label)) return child.id;
    }
    cursor = nextCursor;
  } while (cursor);
  return null;
}

/**
 * Ensures `key` has a doc, creating one (recursively, nested under its
 * boss's doc) if it doesn't, and returns it. Called from exactly ONE place:
 * set_doc's write path — get_doc is a pure read and never calls this.
 *
 * `ensureDoc(key)`:
 *   (0) read the project property -> { spaceKey, rootDocId }
 *   (1) read the `butchr:doc` remote link on the ticket. Present -> return its page. [direct read, immediately consistent]
 *   (2) resolve the boss via the Implements link; recurse to get the parent page id; no boss -> parent = rootDocId.
 *   (3) list the parent's children (exhaustively — see findLabelledChild) and check each child's labels for `butchr-ticket-<key>`. Found -> adopt it, skip to (5).
 *   (4) create the page under that parent WITH THE LABEL in the same API call.
 *   (5) upsert the remote link (idempotent by globalId).
 *
 * WHAT THIS MAKES TRUE, AND WHAT IT DOESN'T: this makes doc creation
 * CONVERGENT under retry, not ATOMIC. Rule (a)'s full promise — ticket, doc,
 * and both links, or nothing at all — is BUTCHR-28's problem (creating the
 * ticket itself), not this function's: ensureDoc only ever runs against a
 * ticket that already exists. What IS true here is what each partial
 * failure of THIS function leaves behind, and why a retry always converges:
 *   - fail at 0,1,2,3 -> reads only. NOTHING written.
 *   - fail at 4 -> Confluence's create is one transaction. Either no page at
 *     all, or a page already nested, already labelled, and therefore ALREADY
 *     DISCOVERABLE BY STEP 3 on the next call. There is no half-made page.
 *   - fail at 5 -> the page exists; the ticket has no link to it yet. The
 *     next call re-runs: step 3 finds the page (by its label, exhaustively),
 *     step 5 completes. The idempotent upsert means a retry cannot make a
 *     second link; step 3 means it cannot make a second page.
 * So the only survivable partial state across SEQUENTIAL retries is exactly
 * the one step 3 exists to recover, and a retry converges. Nothing to roll
 * back, so there is no delete op here and none should be added.
 *
 * THE RACE THAT SEQUENTIAL CONVERGENCE DOESN'T COVER: two callers running
 * this concurrently can both pass step 3 (nothing found yet) and both reach
 * step 4. Confluence enforces unique page titles per space, and the
 * provisional title is DETERMINISTIC from the issue key, so the loser's
 * create 400s ("a page with this title already exists") INSTEAD OF making a
 * duplicate — MEASURED live, twice in a row. That 400 is treated as "someone
 * else just won the race", triggering one bounded re-scan of step 3 (not a
 * fatal error) to adopt the winner's page. This is DEFENSE IN DEPTH ON TOP
 * OF the exhaustive-pagination fix above, not a replacement for it: the
 * title guard only holds while the title is still the provisional,
 * key-derived one — once an agent retitles its doc, a stale/duplicate
 * provisional-titled create would no longer collide with it, and only the
 * exhaustive children scan still catches that case.
 */
export async function ensureDoc(ops: AtlassianOps, key: string, depth = 0): Promise<DocResult> {
  assertValidKey(key, "ensureDoc");
  if (depth > MAX_BOSS_DEPTH) {
    throw new Error(`ensureDoc: boss chain for ${key} is more than ${MAX_BOSS_DEPTH} hops deep — refusing rather than risking an Implements-link cycle looping forever`);
  }

  // (1) direct read, immediately consistent.
  const existing = await readLinkedPage(ops, key);
  if (existing) return existing;

  // (0) project property -> space + root doc, keyed off THIS key's project prefix.
  const projectKey = key.split("-")[0]!;
  let prop: { space?: { key?: string }; rootDoc?: { id?: string } } | undefined;
  try {
    prop = (await ops.getProjectProperty(projectKey, "butchr")) as typeof prop;
  } catch (e) {
    throw new Error(`ensureDoc: project entity property "butchr" is unreadable for project ${projectKey} — refusing rather than guessing a space/root doc (${(e as Error).message})`);
  }
  const spaceKey = prop?.space?.key;
  const rootDocId = prop?.rootDoc?.id;
  if (!spaceKey || !rootDocId) {
    throw new Error(`ensureDoc: project entity property "butchr" for project ${projectKey} is missing space.key or rootDoc.id — refusing rather than falling back to Confluence's implicit space default`);
  }

  // (2) resolve the boss via Implements; recurse for the parent page, or bottom out at the root doc.
  //
  // VERIFIED FOR BUTCHR-71's CONTRACT 2, NOT ASSUMED: an Epic created by a
  // PROJECT caller (src/tools/relationship.ts's `newWorker` project branch)
  // gets NO Implements link at all — a project/epic relationship is
  // membership, not a link — so `findBossKey` on such an Epic returns `null`
  // exactly like any other bossless ticket, and `parentId` bottoms out at
  // `rootDocId` here. `rootDocId` was just read (step 0) from the SAME
  // project's `butchr` property the Epic's own `projectKey` (`key.split("-")[0]`
  // above) belongs to — the project that created it. So the epic's doc nests
  // under that project's own root doc with NO second code path: this branch
  // already does the right thing for a project-created Epic, unchanged.
  const issue = await ops.getIssue(key);
  const bossKey = findBossKey(issue);
  const parentId = bossKey ? (await ensureDoc(ops, bossKey, depth + 1)).id : rootDocId;

  const summary = (issue as { fields?: { summary?: string } })?.fields?.summary ?? key;
  const title = provisionalTitle(key, summary);
  const label = labelForKey(key);
  const ticketSite = siteFromSelf((issue as { self?: unknown })?.self);
  const ticketUrl = ticketSite ? `${ticketSite}/browse/${key}` : `/browse/${key}`;

  // (3) exhaustive scan for an already-existing (fail-at-5) page.
  let pageId = await findLabelledChild(ops, parentId, label);

  if (!pageId) {
    // (4) create, with the label, in the same call.
    try {
      const created = await ops.createPageWithLabel({ spaceKey, parentId, title, body: provisionalBody(key, ticketUrl, ticketSite ?? ""), label });
      pageId = created.id;
    } catch (e) {
      // RACE GUARD (defense in depth — see the function doc comment above):
      // a concurrent ensureDoc(key) may have created the page between our
      // step-3 scan and this create, and Confluence's title-uniqueness 400 is
      // the server telling us that happened — so ANY 400 here re-scans once
      // rather than failing outright or retrying the create into a loop. Most
      // 400s reaching this branch genuinely are the title collision, but a
      // malformed body or a bad parentId would also 400 and land here; the
      // re-scan is harmless either way (it just won't find anything to
      // adopt), so the message below doesn't assert which one happened.
      if (isApiError(e) && e.status === 400) {
        const adopted = await findLabelledChild(ops, parentId, label);
        if (!adopted) throw new Error(`ensureDoc: create for ${key} failed with 400 (possibly a title collision with a concurrent creator) and a re-scan of parent ${parentId} still found no page labelled "${label}" — giving up rather than looping (${(e as Error).message})`);
        pageId = adopted;
      } else {
        throw e;
      }
    }
  }

  const page = (await ops.getPage(pageId)) as { title?: string; body?: { storage?: { value?: string } }; _links?: { base?: string; webui?: string } } | undefined;
  const finalTitle = page?.title ?? title;
  const finalUrl = `${page?._links?.base ?? `${ticketSite ?? ""}/wiki`}${page?._links?.webui ?? ""}`;

  // (5) upsert the remote link — idempotent by globalId, so a retry can never make a second link.
  await ops.upsertRemoteLink(key, DOC_LINK_GLOBAL_ID, "documented by", { title: finalTitle, url: finalUrl });

  return { id: pageId, url: finalUrl, title: finalTitle, body: page?.body?.storage?.value ?? "" };
}

/**
 * Full-body replace of the CALLER'S OWN doc (`key` is always the caller's
 * own — see defs.ts; there is no key parameter on set_doc at all). Ensures
 * the doc exists first (the only call site of ensureDoc), then writes.
 *
 * While the doc's title still carries the `[unwritten]` provisional marker,
 * `title` is REQUIRED: an agent cannot write real content and leave the page
 * reading as unwritten. Once titled, `title` is optional and omitting it
 * keeps the current title.
 *
 * TITLE CHANGE -> RE-UPSERT THE LINK. `ensureDoc` already upserted the
 * `butchr:doc` remote link once, but it did so with the title the page had
 * AT THAT MOMENT — the provisional one, on first write. If `updatePage`
 * changes the title and nothing else touches the link, the Jira ticket's
 * human-visible web link is stuck reading "[unwritten] …" forever, even
 * after the doc is genuinely written — exactly the stale-reads-as-
 * authoritative failure rule (f) names, and on the half of the binding a
 * human actually looks at (PR #112 review). The upsert is idempotent by
 * globalId (see ensureDoc's step 5 comment), so re-calling it here can never
 * create a second link — it only refreshes the one that already exists.
 * Only do this when the title actually changed: a body-only write touches
 * nothing the link displays, and an unconditional upsert would bump the
 * ticket's `updated` on every doc write, waking a boss for a non-event.
 */
export async function setDoc(ops: AtlassianOps, key: string, body: string, title?: string): Promise<DocResult> {
  const doc = await ensureDoc(ops, key);
  if (isProvisional(doc.title) && !title) {
    throw new Error(`set_doc: ${key}'s doc still has its provisional title ("${doc.title}") — pass \`title\` with a real, outcome-shaped title. You cannot write real content and leave the page reading as unwritten.`);
  }
  await ops.updatePage({ id: doc.id, body, ...(title ? { title } : {}) });
  const finalTitle = title ?? doc.title;
  if (title && title !== doc.title) {
    await ops.upsertRemoteLink(key, DOC_LINK_GLOBAL_ID, "documented by", { title: finalTitle, url: doc.url });
  }
  return { id: doc.id, url: doc.url, title: finalTitle, body };
}
