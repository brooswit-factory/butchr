import type { AtlassianOps } from "./atlassian.js";
import { projectRootDoc } from "./docs.js";
import { isProjectId } from "../resources/id.js";
import { advanceProjectWatermark } from "../resources/project.js";

/**
 * WHERE A RESOURCE SPEAKS — named and required by the epic (BUTCHR-62, ruled
 * on BUTCHR-71): an ISSUE speaks on its own ticket (a Jira comment, via
 * `ops.addComment`). A PROJECT speaks on its own ROOT DOC (a Confluence
 * footer comment, via `ops.commentOnPage`) — a project is not an issue and
 * has no ticket to comment on at all. This is the one seam that decides
 * which, so the answer lives in exactly one place rather than being
 * re-decided inside every verb that needs it.
 *
 * `report_to_boss`/`ask_boss` (src/tools/relationship.ts) are this seam's
 * first callers, but it is exported here, standalone, so anything OUTSIDE
 * the relationship verbs can reach it too — in particular the daemon-side
 * blocked-dialog escalation path (src/agents/escalation-loop.ts), which
 * today posts its `[butchr:blocked]` notice to a blocked agent's own
 * TICKET and is therefore broken for a project caller (no ticket at all).
 * FIXING THAT PATH IS NOT THIS TICKET'S — BUTCHR-62 is routing it
 * separately; this only exposes the seam for whoever does that work.
 *
 * `taggedText` is passed through UNCHANGED to whichever channel is chosen —
 * identity-tagging (`[CALLER-KEY] …`) and the `[ask]` marker are the
 * caller's job (`src/tools/relationship.ts`'s `tagComment`/`ASK_MARKER`),
 * not this seam's; a project caller gets the exact same tag/marker
 * convention an issue caller does; only the destination differs. For a
 * project caller, the text is wrapped as a single storage-format paragraph
 * before being posted — `ops.commentOnPage` takes storage-format XHTML, and
 * `taggedText` here is always plain text.
 *
 * HAZARD 1, CLOSED HERE (BUTCHR-67/BUTCHR-81) — was a known-but-unfixed risk
 * left by BUTCHR-71: a PROJECT calling this posts a Confluence COMMENT on
 * its own root doc, and "the root doc received a comment" is one of the
 * project resource type's three wake triggers (src/resources/project.ts).
 * Left alone, a project's own `report_to_boss`/`ask_boss` call would wake
 * ITSELF, in a loop. The fix is NOT the Jira-keyed own-write ledger
 * (src/jira-watch/own-writes.ts) — MEASURED unusable for a project key (its
 * `search("key IN (...)")` silently returns empty for a bare project key)
 * — it is a WATERMARK: immediately after `commentOnPage` succeeds, this
 * function advances that project's `wake.comment` watermark
 * (src/resources/project.ts's `advanceProjectWatermark`) to the id
 * `commentOnPage` just returned. The very next poll's discovery read sees
 * that comment already caught up, so neither `verdictFor` nor `eventRules`
 * counts it as a pending trigger. A FOREIGN comment never calls this
 * function, so it is never watermarked here and still wakes the project —
 * the failure condition this fix must not also swallow (see
 * test/unit/project-resource-type.test.ts). The watermark write is
 * fail-open (a rejected write is caught, not thrown): the comment itself
 * already succeeded by the time this runs, and a secondary bookkeeping
 * failure must never surface as a failed `report_to_boss`/`ask_boss` call.
 *
 * BUTCHR-105's REQUIREMENT-2 DECISION, recorded here rather than left as an
 * oversight: the swallow itself is KEPT — the argument just above (a
 * comment that already succeeded must not fail the caller over bookkeeping)
 * still holds and this ticket does not overturn it. What changes is that
 * the failure is no longer SILENT: it is logged via `log` (the same
 * `console.error`-by-default seam `atlassianTools` already uses for its own
 * audit lines — journalctl-visible, this daemon's existing convention for
 * a fail-open write, e.g. `src/daemon/index.ts`'s own-write read-back
 * WARNING). This is "make the failure visible without making it fatal",
 * one of the three answers the ticket names as acceptable. Why not remove
 * the swallow instead: `check_in` already surfaces this same failure by
 * NOT swallowing it, and doing that here too would fail every
 * `report_to_boss`/`ask_boss` call whenever only the watermark write is
 * down — including the exact moment a blocked agent is using one of them to
 * escalate, which is the single worst call to fail on a bookkeeping error.
 * MEASURED motivation for logging rather than staying silent (BUTCHR-115's
 * own doc): while this write was failing (403 — the project-tier account
 * lacked project-write permission), the project nudged itself every five
 * minutes and no signal anywhere said why; a log line is what closes that
 * gap, and there is no ticket/doc channel to report to instead that would
 * not itself depend on this same watermark write succeeding.
 */
export async function speakOnOwnChannel(
  ops: AtlassianOps,
  callerKey: string,
  taggedText: string,
  log: (line: string) => void = console.error,
): Promise<unknown> {
  if (isProjectId(callerKey)) {
    const doc = await projectRootDoc(ops, callerKey);
    const created = (await ops.commentOnPage(doc.id, `<p>${escapeStorageText(taggedText)}</p>`)) as { id?: string } | undefined;
    if (created?.id) {
      await advanceProjectWatermark(ops, callerKey, { comment: created.id }).catch((e) =>
        log(`  WARNING: [speakOnOwnChannel] self-wake watermark advance failed for ${callerKey} (comment ${created.id}): ${(e as Error)?.message ?? e} — comment posted; project may nudge itself on it next poll`),
      );
    }
    return created;
  }
  return ops.addComment(callerKey, taggedText);
}

/**
 * Minimal escaping for plain text dropped into a storage-format XHTML
 * paragraph — the same three characters `confluence_create_page`'s own
 * guidance warns a caller to pass raw, unescaped, in the other direction
 * (this function is what does that escaping FOR text we didn't ask the
 * caller to format). EXPORTED (BUTCHR-185/BUTCHR-215) so `tell_peer`
 * (src/tools/relationship.ts) can reuse this exact escaper instead of
 * writing a second one that could drift from it — `unwrapStorageParagraph`
 * below is this escaper's exact inverse, and the two must never disagree.
 */
export function escapeStorageText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * BUTCHR-124 review (PR #180, CHANGES_REQUESTED @ 1be6208): the exact inverse
 * of `speakOnOwnChannel`'s PROJECT branch — undoes the `<p>${escapeStorageText
 * (text)}</p>` wrapping so a caller reading a project's own comments back
 * (via `ops.getPageComments`, which returns raw storage-format XHTML) sees
 * the same plain text `speakOnOwnChannel` was originally given. Exported
 * because reading back what this seam wrote is not this ticket's alone —
 * escalation-loop.ts's sustained-unresponsive dedupe is the first caller,
 * but any future project-tier read-back (BUTCHR-95/BUTCHR-84 included) needs
 * the SAME inverse, not a second one that can drift from `escapeStorageText`.
 *
 * Decodes in the OPPOSITE order `escapeStorageText` encodes in (`&` first,
 * then `<`, then `>`): `&gt;` first, `&lt;`, `&amp;` last — the encoder never
 * double-escapes, so decoding in reverse undoes it exactly. Tolerant of a
 * body that ISN'T `<p>...</p>`-wrapped (falls through unwrapped, still
 * unescaped) — a foreign comment on the same page need not carry this
 * module's own write shape.
 */
export function unwrapStorageParagraph(body: string): string {
  const m = /^<p>([\s\S]*)<\/p>$/.exec(body.trim());
  const inner = m ? m[1]! : body;
  return inner.replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&");
}

/** A read from a resource's own channel, id-comparable with `escalation-helper.ts`'s `CommentRow` (structurally identical — no shared import needed; see this function's own doc comment for why). */
export interface CommentRow { id: string; body: string; created: string }

/**
 * BUTCHR-141/§2.6 — the read half symmetric to `speakOnOwnChannel` above,
 * EXTRACTED from `src/daemon/index.ts` (a MOVE, not a rewrite: same
 * behaviour, dependencies injected instead of closed over module-scope
 * `ops`/`atlassian`). Before this extraction the function lived as an
 * unexported local in `index.ts`, a file that bootstraps a real
 * Atlassian/herdr daemon (`process.exit` on missing config) at import — so
 * its own representation-bug history (see below) could only ever be tested
 * by hand-reproducing its two mapping lines in a unit test, never by
 * importing and exercising the REAL reader. That gap is what let a
 * representation defect through two independent reviewers (BUTCHR-129) —
 * this extraction is what makes the real reader importable, so a test can
 * exercise it against a body a REAL `speakOnOwnChannel` call produced
 * instead.
 *
 * THERE MUST BE EXACTLY ONE OF THESE IN THE CODEBASE — an issue's Jira
 * comments for an issue key; a project's Confluence root-doc FOOTER comments
 * for a project key, via the SAME `projectRootDoc` resolution
 * `speakOnOwnChannel`'s own project branch uses. NOT `ops.getIssueComments`:
 * that op deliberately returns `{id}` only (see its own doc comment on
 * `AtlassianOps`) and every caller's dedupe needs `body` to find its own
 * marker — `issueComments` is injected instead so this module stays
 * dependency-free of any specific Jira client. A project id has no ticket at
 * all (measured live: `GET /rest/api/3/issue/BUTCHR` -> 404) — and even
 * setting that failure aside, an ISSUE-shaped read would still be the WRONG
 * RESOURCE for a project (its speech is a Confluence footer comment on its
 * root doc, not a Jira comment) — so a project id resolves its root doc the
 * same way `speakOnOwnChannel` does and reads footer comments via
 * `ops.getPageComments`, called with exactly ONE id (`doc.id`, resolved
 * fresh from THIS project's own property read) — never the batch `?id=A&id=B`
 * form (`getPageComments`'s own doc comment: MEASURED to return HTTP 200
 * while silently ignoring the id filter, two pages holding two comments
 * coming back with 16 results spanning 10 unrelated pageIds). A 2xx here is
 * evidence about the transport, not proof of reading the right resource —
 * the single-id, path-scoped call is what makes that true anyway, not a
 * post-hoc check on the response. Deliberately never catches here either:
 * both branches reject on failure exactly as written, so each caller's own
 * fail-closed handling sees a real rejection rather than a laundered empty
 * result.
 *
 * `created` (BUTCHR-171, correcting the paragraph this replaces): mapped
 * from `ops.getPageComments`' own `created` field when present — sourced
 * from the footer comment's `version.createdAt` (see `AtlassianOps.
 * getPageComments`'s doc comment for what that timestamp actually measures
 * and the last-edited-vs-created distinction it accepts). Falls back to
 * `""` ONLY for the row-level case where the underlying read genuinely
 * carried no timestamp — never to `Date.now()`/`deps.now()`, which would
 * make an unverifiable row look definitively CURRENT instead of merely
 * UNKNOWN. `""` is not self-enforcing on its own (`Date.parse("")` is
 * `NaN`, and an unguarded `NaN < x` is always `false` — a caller that
 * compares it directly gets the SAME pass-through `now()` would have
 * given, a defect this ticket's review caught and closed at the one
 * consumer, escalation-loop.ts's recency filter, which now checks
 * `Number.isNaN(...)` explicitly rather than relying on that comparison by
 * accident). This mapping's job is only to make "unavailable" and "just
 * now" DISTINGUISHABLE values; a consumer still has to choose to tell them
 * apart.
 *
 * ORDERING (BUTCHR-171): `getPageComments` requests no `sort` (see its own
 * doc comment) and this function no longer trusts its return order —
 * `results` is sorted here, newest-first by NUMERIC comment id, before
 * mapping. Confluence footer-comment ids are monotonically increasing
 * platform-wide (MEASURED live, `src/resources/project.ts`'s
 * `newestCommentId` doc comment; INHERITED here, not independently
 * re-measured). Id order, not `created`, is what settles this: `created`
 * can be `""` per-row (see above) and is a last-edited time even when
 * present, neither of which a stable total order can be built on, while a
 * platform-monotonic id can. This is a POST-CONDITION this function
 * enforces itself, not a request the API is trusted to honour — it holds
 * even if `getPageComments`'s own return order changes.
 *
 * UNWRAPPING (BUTCHR-129, found at PR #180 review, CHANGES_REQUESTED @
 * 1be6208): `getPageComments` requests `bodyFormat: "storage"` and returns
 * raw storage-format XHTML — the SAME wrapped-and-escaped shape
 * `speakOnOwnChannel` writes (`<p>${escapeStorageText(text)}</p>`, above),
 * not the plain text a caller posted. Read literally, a row's body starts
 * with `<p>[butchr:frozen]` or `<p>[butchr:unresponsive]`, not the bare
 * marker — the exact string `findMarked` (escalation-helper.ts) anchors on
 * with `startsWith(marker)`, so restart-adoption silently never matched on
 * the project tier for EITHER caller until this unwrap was applied. Fixed by
 * `unwrapStorageParagraph`, this file's own exported inverse of the wrapping
 * it writes — kept in the SAME module so this can never drift from
 * `escapeStorageText`.
 *
 * THIS IS RULE 2b'S THIRD FORM (right resource, right call, wrong
 * REPRESENTATION) — a fixture that hands back plain text for both tiers is
 * faithful to `CommentRow`'s TYPE and still disagrees with what this real
 * reader produces in exactly the dimension `findMarked` anchors on; that
 * shape of fixture is what let this defect through two reviews before
 * BUTCHR-129.
 */
export function createOwnChannelComments(
  ops: AtlassianOps,
  issueComments: (key: string) => Promise<readonly CommentRow[]>,
): (key: string) => Promise<CommentRow[]> {
  return async function ownChannelComments(key: string): Promise<CommentRow[]> {
    if (isProjectId(key)) {
      const doc = await projectRootDoc(ops, key);
      const { results } = await ops.getPageComments(doc.id);
      return [...results]
        .sort((a, b) => Number(b.id) - Number(a.id))
        .map((r) => ({ id: r.id, body: unwrapStorageParagraph(r.body), created: r.created ?? "" }));
    }
    return [...(await issueComments(key))];
  };
}
