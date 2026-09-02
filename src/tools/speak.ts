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

/** Minimal escaping for plain text dropped into a storage-format XHTML paragraph — the same three characters `confluence_create_page`'s own guidance warns a caller to pass raw, unescaped, in the other direction (this function is what does that escaping FOR text we didn't ask the caller to format). */
function escapeStorageText(text: string): string {
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
