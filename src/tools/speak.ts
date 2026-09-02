import type { AtlassianOps } from "./atlassian.js";
import { projectRootDoc } from "./docs.js";
import { isProjectId } from "../resources/id.js";

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
 * A KNOWN HAZARD THIS FUNCTION DOES NOT SOLVE, STATED RATHER THAN FIXED —
 * per the epic's explicit instruction on BUTCHR-71, this is written down and
 * then left alone: a PROJECT calling this posts a Confluence COMMENT on its
 * own root doc, and "the root doc received a comment" is one of the THREE
 * WAKE EVENTS the project resource type (BUTCHR-67) will wake a project on.
 * Left alone, a project's own `report_to_boss`/`ask_boss` call would wake
 * ITSELF, in a loop. This fleet's own-write ledger
 * (src/jira-watch/own-writes.ts) exists for exactly this class of problem —
 * BUT it records JIRA writes keyed by issue; a project's root-doc comment is
 * a CONFLUENCE write, a different write surface the existing ledger does
 * not cover today. And because a Confluence comment does NOT bump the
 * page's own version (measured live by the epic on BUTCHR-62, 2026-09-01:
 * version 5 before, 5 after a comment), comment-watching and
 * version-watching are two SEPARATE polls — so this self-wake risk travels
 * specifically on the COMMENT poll BUTCHR-67 will build, not the version
 * one. BUTCHR-67 owns solving this; it is written down here, precisely,
 * so that story inherits the hazard instead of discovering it live.
 */
export async function speakOnOwnChannel(ops: AtlassianOps, callerKey: string, taggedText: string): Promise<unknown> {
  if (isProjectId(callerKey)) {
    const doc = await projectRootDoc(ops, callerKey);
    return ops.commentOnPage(doc.id, `<p>${escapeStorageText(taggedText)}</p>`);
  }
  return ops.addComment(callerKey, taggedText);
}

/** Minimal escaping for plain text dropped into a storage-format XHTML paragraph — the same three characters `confluence_create_page`'s own guidance warns a caller to pass raw, unescaped, in the other direction (this function is what does that escaping FOR text we didn't ask the caller to format). */
function escapeStorageText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
