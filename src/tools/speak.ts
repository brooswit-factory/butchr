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
 */
export async function speakOnOwnChannel(ops: AtlassianOps, callerKey: string, taggedText: string): Promise<unknown> {
  if (isProjectId(callerKey)) {
    const doc = await projectRootDoc(ops, callerKey);
    const created = (await ops.commentOnPage(doc.id, `<p>${escapeStorageText(taggedText)}</p>`)) as { id?: string } | undefined;
    if (created?.id) {
      await advanceProjectWatermark(ops, callerKey, { comment: created.id }).catch(() => {});
    }
    return created;
  }
  return ops.addComment(callerKey, taggedText);
}

/** Minimal escaping for plain text dropped into a storage-format XHTML paragraph — the same three characters `confluence_create_page`'s own guidance warns a caller to pass raw, unescaped, in the other direction (this function is what does that escaping FOR text we didn't ask the caller to format). */
function escapeStorageText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
