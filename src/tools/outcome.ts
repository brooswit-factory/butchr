import type { ToolDef } from "@brooswit/thatch";

/**
 * BUTCHR-341 (implementing BUTCHR-316): marks a thrown Error as a DELIBERATE
 * guard refusal — a guard in defs.ts/relationship.ts/docs.ts chose NOT to
 * proceed (a bad argument, a caller that isn't allowed to do this, a
 * precondition it refuses to guess past) — as opposed to an unexpected
 * failure. `withOutcomeRecording` below classifies a thrown/rejected value
 * by this TYPE (`instanceof Refusal`), never by string-matching the
 * message: a message can be reworded at any time without anyone noticing it
 * silently broke a classifier; a type check cannot drift the same way.
 *
 * WHERE THE LINE IS DRAWN (a judgment call, made explicit here because nothing
 * else states it): every pre-condition/validation guard in the tool layer —
 * "not one of your own workers", "no assignee configured for this role", "a
 * disposition needs a non-empty reason", "this connection has no x-issue",
 * the whole `destinationRefusal` family, etc. — throws a `Refusal`. An
 * ops.* (Jira/Confluence/herdr) failure surfacing through a handler (a
 * network error, a 400 Jira itself returned, a write that didn't land)
 * stays a plain `Error`, classified `error` — even where Jira's own answer
 * was itself a kind of refusal (e.g. "no transition available"): that
 * distinction lives one layer down, in what the EXTERNAL system decided,
 * not in what butchr's own guard decided, and blurring the two would mix
 * two very different failure populations back together. So does a
 * "we already committed to this action and a LATER step in it failed"
 * narration — new_worker's post-create doc/link failure, correct_worker's
 * archive-comment failure, file_where_it_belongs' post-create notice/doc
 * failure, ensureDoc's give-up-after-a-failed-create case (docs.ts) — these
 * read like guards in prose ("refusing", "giving up") but the ticket this
 * call represents was NOT rejected: something was already written, and a
 * required follow-up step broke. That is an unexpected outcome needing
 * attention, not a deliberate no. The one line that DOES stay `refused`
 * despite wrapping a caught failure is a guard that refuses to act on an
 * UNRELIABLE READ (projectRootDoc/ensureDoc's "'butchr' entity property is
 * unreadable — refusing rather than guessing") — nothing was attempted or
 * committed there; the guard chose not to proceed without trustworthy
 * information, the same shape as every other precondition guard.
 *
 * WHAT A MISCLASSIFICATION WOULD LOOK LIKE: a genuine bug wrapped in
 * `Refusal` by mistake would undercount `error` and overcount `refused` —
 * reading as "callers keep tripping a guard" when the truth is "the code is
 * broken." A guard's own throw left as a plain `Error` would do the
 * opposite — a legitimate, working guard would look like flakiness. Both
 * directions are why every one of this repo's `throw new Error(...)` sites
 * in the tool layer was read individually for this change rather than
 * converted by a blanket pattern — see the PR description for the
 * file-by-file accounting of which sites became `Refusal` and which stayed
 * `Error`, and why.
 */
export class Refusal extends Error {}

/**
 * BUTCHR-341: the tag for the per-call OUTCOME record, deliberately DISTINCT
 * from the pre-existing `[tools]` tag (src/tools/defs.ts's own `audit`
 * helper) rather than a version marker appended to it — same reasoning
 * `ADMISSION2_TAG` (src/agents/admission.ts) already documents: journals
 * outlive deploys, so a reader (human or `scripts/audit-alias-calls.ts`)
 * must be able to tell which instrument produced a line from the line's own
 * shape, without knowing when this shipped. THIS IS NOT BACKWARD
 * COMPATIBILITY — the old `[tools]` line is not being replaced or reshaped;
 * it keeps firing, unchanged, BEFORE the verb runs, exactly as before (see
 * `withOutcomeRecording`'s own doc comment for why both lines are kept).
 * `[tools2]` is a NEW, second, independent tag; `test/unit/outcome.test.ts`
 * pins, bidirectionally, that `parseAliasAuditLine` (src/tools/alias-audit.ts,
 * which reads the OLD `[tools]` line and is consumed by
 * `scripts/audit-alias-calls.ts` — BUTCHR-35's alias-removal evidence chain)
 * never matches a `[tools2]` line, and `parseOutcomeLine` below never matches
 * an old `[tools]` line, against VERBATIM examples of each.
 *
 * WHAT A MISSING `[tools2]` LINE MEANS, for a given time window on THIS
 * daemon: no tool-call handler ran to completion (resolved OR threw) on
 * this daemon in that window, AND no connection was refused here for
 * missing `x-issue` either (see `preIdentityRefusalLine` below — that path
 * emits under this SAME tag). It does NOT mean "this verb was never called,
 * full stop" — see the cross-daemon limit immediately below.
 *
 * THE CROSS-DAEMON LIMIT (BUTCHR-316's own (C)): a host can run more than
 * one butchr daemon, under different Unix users and different Atlassian
 * accounts (confirmed live — see this repo's own agent-facing docs). THIS
 * daemon's journal sees only the calls made TO IT. No emission change, here
 * or anywhere else, can ever fix that — it is not a bug, it is what "one
 * process's own stderr" structurally is. So: this journal is authoritative
 * only for ITS OWN daemon. For "was verb X ever called on ticket Y, by
 * anyone, anywhere" — the cross-daemon question — the authoritative record
 * is the Jira/Confluence artefact the verb itself writes (a comment, a
 * transition, a link), not this journal. In the vocabulary
 * `scripts/audit-alias-calls.ts` already established: "no line in this
 * journal" means "not called on THIS daemon", never "not called" anywhere.
 *
 * WHAT THIS RECORD CANNOT SEE: a call whose arguments fail the tool's own
 * input schema (a zod shape) is rejected by the `@modelcontextprotocol/sdk`
 * layer `@brooswit/thatch` sits on — `McpServer`'s `_createRegisteredTool`
 * calls `safeParseAsync` against the schema and throws an `McpError` BEFORE
 * ever invoking the registered callback (confirmed by reading
 * `node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js` at this
 * repo's resolved version — see the PR for the exact line). Neither the old
 * `[tools]` line nor this one ever runs for that call: both live inside
 * `def.handler`, called only once the SDK's own validation already passed.
 * Whether that SDK layer logs the rejection anywhere itself was NOT
 * determined — nothing in `@brooswit/thatch`'s own code (confirmed: no
 * try/catch, no console call, no error hook around tool registration or
 * dispatch — see `withOutcomeRecording`'s doc comment) intercepts it, and
 * this ticket did not trace further into the SDK's own error path. A
 * malformed request the HTTP/transport layer rejects before reaching
 * `@brooswit/thatch`'s own fetch handler at all is the same kind of gap,
 * one layer further out.
 */
export const OUTCOME_TAG = "[tools2]";

/** The one outcome vocabulary this record ever writes — see `Refusal`'s own doc comment for where `refused` vs. `error` is decided. */
export type Outcome = "ok" | "refused" | "error";

/**
 * The caller field (B) writes when a connection is refused before any
 * `x-issue` was ever read — deliberately NOT a bare `?` (today's `[tools]`
 * line's own placeholder for a missing header, which reads exactly like a
 * parse failure of a line that DID have an identity). This is angle-bracketed
 * specifically so it can never collide with a real Jira/project key (which
 * this corpus's own key shape, `[A-Z][A-Z0-9_]*-[0-9]+` — see
 * `src/tools/docs.ts`'s `JIRA_KEY_RE` — never contains `<`/`>`), so "we never
 * learned who this was" stays distinguishable from any real identity, present
 * or malformed.
 */
export const UNKNOWN_CALLER = "<no-identity>";

/** Message field cap (characters, post newline-flattening) — bounded per the ticket's Requirement 3; long enough for a useful refusal/error message, short enough that one bad message can't blow out journal volume. */
const MAX_MESSAGE_CHARS = 300;
/** Structured-field cap — far more generous than any real caller/verb/target needs; exists only to bound a field this code does not fully control (e.g. a caller identity or an args value), never expected to bite in practice. */
const MAX_FIELD_CHARS = 120;

/**
 * Requirement 3 (the sibling-review defect this ticket names by number):
 * every structured field must sit BEFORE the unbounded free-text message,
 * and the message itself must never contain a literal newline — a
 * multi-line message would otherwise strand `outcome=`/`target=`/etc. on a
 * SEPARATE journal line from its own tag, and a line-oriented reader (this
 * one, or a human `grep`) would silently undercount. Newlines are REPLACED
 * (not stripped outright) with a visible ` ⏎ ` marker — belt and braces:
 * stripping alone can accidentally weld two words together with no space
 * between them; a visible marker keeps the message readable AND keeps it on
 * one line. Applied to caller/verb/target too (cheap, and none of them are
 * fully under this code's control — a caller identity or an args value
 * could in principle carry whitespace).
 */
function sanitizeField(raw: string, maxChars: number): string {
  const flattened = raw.replace(/\r\n|\r|\n/g, " ⏎ ").replace(/\s+/g, (m) => (m.includes("⏎") ? m : "_"));
  return flattened.length > maxChars ? `${flattened.slice(0, maxChars)}…` : flattened;
}

function boundMessage(raw: string): string {
  const flattened = raw.replace(/\r\n|\r|\n/g, " ⏎ ");
  return flattened.length > MAX_MESSAGE_CHARS ? `${flattened.slice(0, MAX_MESSAGE_CHARS)}…` : flattened;
}

interface OutcomeFields {
  caller: string;
  verb?: string | undefined;
  target?: string | undefined;
  outcome: Outcome;
  message?: string | undefined;
}

function buildLine(f: OutcomeFields): string {
  const parts = [`caller=${sanitizeField(f.caller, MAX_FIELD_CHARS)}`];
  if (f.verb !== undefined) parts.push(`verb=${sanitizeField(f.verb, MAX_FIELD_CHARS)}`);
  if (f.target !== undefined) parts.push(`target=${sanitizeField(f.target, MAX_FIELD_CHARS)}`);
  parts.push(`outcome=${f.outcome}`);
  const head = `${OUTCOME_TAG} ${parts.join(" ")}`;
  return f.message !== undefined ? `${head} msg=${boundMessage(f.message)}` : head;
}

/**
 * Best-effort target extraction, generic over EVERY tool by construction
 * (the whole point of wrapping once where `tools` is assembled rather than
 * hand-editing each of the 34 tool definitions — see `withOutcomeRecording`'s
 * own doc comment). Reads ONLY `key`, `from`+`to`, or `id` — the shapes this
 * repo's own tool inputs actually use for "the thing this call is about"
 * (`jira_get_issue`/`jira_add_comment`/`jira_transition`/`jira_set_priority`/
 * `jira_assign`/relationship verbs use `key`; `jira_link_issues` uses
 * `from`+`to`; `confluence_get_page`/`confluence_update_page` use `id`).
 * DELIBERATELY never reads a free-text field (`text`, `body`, `description`,
 * `summary`, `reason`, `why`, `destination`, `jql`, `cql`, …) — this is what
 * keeps target extraction safe under the ticket's OUT-OF-SCOPE "do not log
 * message bodies" rule even though it runs generically over every tool's
 * raw arguments: it is not a redaction step, it simply never looks at those
 * fields in the first place. A tool with none of `key`/`from`+`to`/`id`
 * (confluence_list_spaces, jira_search, the no-argument relationship verbs
 * that always act on the caller's own ticket) logs no `target=` at all
 * rather than a guessed or invented one — the caller field already answers
 * "whose call this is" for those.
 */
function extractTarget(args: unknown): string | undefined {
  if (args && typeof args === "object") {
    const a = args as Record<string, unknown>;
    if (typeof a.key === "string" && a.key) return a.key;
    if (typeof a.from === "string" && a.from && typeof a.to === "string" && a.to) return `${a.from}→${a.to}`;
    if (typeof a.id === "string" && a.id) return a.id;
  }
  return undefined;
}

function classify(err: unknown): Outcome {
  return err instanceof Refusal ? "refused" : "error";
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * (B): the ONE line `src/daemon/app.ts`'s own `auth` gate writes when a
 * connection is refused before any `x-issue` was ever read — before this
 * change, that 401 produced NO record at all (confirmed: `@brooswit/thatch`
 * returns it with no log line of any kind — see `Refusal`'s sibling doc
 * comments and the PR for the exact source read). Carries ONLY `caller` and
 * `outcome` — never an invented `verb=`/`target=`: at the point this fires,
 * no tool call has been made yet, so there is neither a verb nor a target to
 * report, and inventing placeholders for them would be a fabricated field,
 * not a recorded fact.
 */
export function preIdentityRefusalLine(): string {
  return buildLine({
    caller: UNKNOWN_CALLER,
    outcome: "refused",
    message: "connection refused before identity: request carried no x-issue header",
  });
}

/**
 * (A): wraps EVERY `ToolDef.handler` in `tools`, applied ONCE where
 * `src/tools/defs.ts`'s `atlassianTools()` assembles its returned object —
 * the seam BUTCHR-316 pointed at: `tools` is a plain `Record<string,
 * ToolDef>` butchr itself builds, so wrapping it once here reaches every
 * verb by construction, rather than 34 hand-edited call sites (34 chances to
 * miss one path).
 *
 * EXACTLY ONE RECORD PER CALL, ON EVERY PATH — the property this exists to
 * guarantee. A handler can fail in four distinct shapes; this wrapper covers
 * all four with two mechanisms, not one:
 *   - throws SYNCHRONOUSLY (before returning anything, ever) — caught by the
 *     `try`/`catch` around the `def.handler(...)` CALL ITSELF, not just its
 *     result. A wrapper that only did `Promise.resolve(def.handler(...))`
 *     would MISS this case: the exception is thrown during evaluation of
 *     that expression, before `Promise.resolve` ever runs.
 *   - returns a value that later REJECTS (an async handler, or one that
 *     returns a Promise it built by hand) — caught by the rejection arm of
 *     `Promise.resolve(result).then(onOk, onFail)`.
 *   - returns a plain, non-Promise value — `Promise.resolve(value)` wraps it
 *     into a resolved Promise either way, so the SAME `.then(onOk, ...)` arm
 *     records `ok` regardless of whether the handler was sync or async. The
 *     framework layer (`@brooswit/thatch`) already does `await
 *     def.handler(...)`, which accepts a plain value exactly as it accepts a
 *     Promise — wrapping every handler to now always return a Promise
 *     changes nothing about what the framework receives.
 *   - throws INSIDE a `.then()` callback further down a handler's own promise
 *     chain (e.g. `ops.linkIssues(...).then((r) => { ... throw ... })`) —
 *     this is not a special case at all: a `.then()` callback's own throw
 *     REJECTS the Promise that `.then()` call returns, which is exactly the
 *     Promise `result` above refers to, so it surfaces through the SAME
 *     rejection arm as a direct `Promise.reject`. No extra handling needed;
 *     confirmed by the wrapper's own mutation-tested coverage of this shape.
 *
 * The existing pre-operation `[tools]` line (`defs.ts`'s own `audit` helper)
 * is KEPT, unchanged, firing BEFORE the verb runs exactly as it always has —
 * this wrapper adds a SECOND, independent record after, it does not replace
 * the first. Two reasons, argued in the PR: (i) `scripts/audit-alias-calls.ts`
 * parses the OLD `[tools]` line via `parseAliasAuditLine`
 * (`src/tools/alias-audit.ts`) for BUTCHR-35's alias-removal evidence chain —
 * removing or reshaping that line breaks live tooling; (ii) a call that never
 * returns (a hung handler, a process killed mid-call) leaves a pre-line with
 * no matching outcome line, which is the ONLY way this journal can ever show
 * a started-but-unfinished call — losing the pre-line would lose that
 * visibility entirely, not just move it.
 */
export function withOutcomeRecording(
  tools: Record<string, ToolDef<any>>,
  log: (line: string) => void,
): Record<string, ToolDef<any>> {
  const wrapped: Record<string, ToolDef<any>> = {};
  for (const [name, def] of Object.entries(tools)) {
    wrapped[name] = {
      ...def,
      handler: (args: unknown, c: { headers: Readonly<Record<string, string>> }) => {
        const caller = c.headers["x-issue"] ?? UNKNOWN_CALLER;
        const target = extractTarget(args);
        const record = (outcome: Outcome, err?: unknown) => {
          log(
            buildLine({
              caller,
              verb: name,
              target,
              outcome,
              ...(err !== undefined ? { message: messageOf(err) } : {}),
            }),
          );
        };
        let result: unknown;
        try {
          result = def.handler(args as never, c as never);
        } catch (err) {
          record(classify(err), err);
          throw err;
        }
        return Promise.resolve(result).then(
          (value) => {
            record("ok");
            return value;
          },
          (err) => {
            record(classify(err), err);
            throw err;
          },
        );
      },
    };
  }
  return wrapped;
}

/** Recovered fields from one `[tools2]` line — pure, no filesystem/subprocess, fixturable against literal strings (same discipline `parseAliasAuditLine` already follows). */
export interface ParsedOutcomeLine {
  caller: string;
  verb: string | null;
  target: string | null;
  outcome: Outcome;
  message: string | null;
}

const OUTCOME_LINE_RE = /\[tools2\]\s+caller=(\S+)(?:\s+verb=(\S+))?(?:\s+target=(\S+))?\s+outcome=(ok|refused|error)(?:\s+msg=(.*))?/;

/**
 * BUTCHR-343 blocker 2: the OLD `[tools]` line (`defs.ts`'s own `audit`
 * helper) echoes caller-supplied free text verbatim (`jira_search`'s `jql`,
 * `confluence_search_pages`'s `cql`, page titles, a `why`, a `destination`,
 * …) with no attempt to bound or escape it beyond a length slice. Since
 * `OUTCOME_LINE_RE` matches ANYWHERE in a line rather than only at its own
 * start (needed because a real journald prefix precedes every genuine
 * `[tools2]` line too — see this function's own doc comment), any OLD line
 * whose echoed free text happens to CONTAIN a well-formed
 * `[tools2] … outcome=ok` fragment parsed, before this guard, as a genuine
 * outcome record for a call that never happened — see
 * `test/unit/butchr-343-forged-embedded-tags.test.ts` for a fragment
 * produced by the real `jira_search` handler itself, not a hand fixture.
 *
 * THE FIX, AND WHY THIS SHAPE: a genuine `[tools2]` line is always written
 * by `buildLine` (above) as the FIRST thing on the line — nothing this
 * code controls ever puts an OLD `[tools]` tag before it. The OLD line, by
 * contrast, is always written by `defs.ts`'s own `audit` helper as
 * `  [tools] <issue> → <what>` — its `[tools]` tag is always the line's own
 * first token, so any embedded `[tools2]` fragment inside `<what>` can only
 * ever appear AFTER that `[tools]` tag, never before it. So: if an OLD
 * `[tools]` tag appears anywhere before this match's own `[tools2]`, the
 * match is embedded free text inside someone else's record, not this
 * line's own tag — reject it. This is the anchor-by-precedence option the
 * PR#347 reviewer named, chosen over a positional regex anchor tied to
 * journald's own prefix shape (timestamp/host/pid), which this module does
 * not own and should not have to model.
 */
const OLD_TOOLS_TAG = "[tools]";

/**
 * Parses ONE line of text (typically a `journalctl` line, journald prefix
 * and all — matches ANYWHERE in the line, never anchored to its start, same
 * as `parseAliasAuditLine`) into a `ParsedOutcomeLine`, or `null` when the
 * line is not a `[tools2]` outcome record at all — including every OLD
 * `[tools]` line, verbatim or otherwise (see `OUTCOME_TAG`'s own doc comment
 * and `test/unit/outcome.test.ts`'s bidirectional pin), AND every line where
 * a `[tools2]`-shaped fragment is merely embedded inside an OLD line's own
 * echoed free text (see this function's own doc comment above, and
 * `test/unit/butchr-343-forged-embedded-tags.test.ts`).
 */
export function parseOutcomeLine(line: string): ParsedOutcomeLine | null {
  const m = line.match(OUTCOME_LINE_RE);
  if (!m) return null;
  if (line.slice(0, m.index).includes(OLD_TOOLS_TAG)) return null;
  return {
    caller: m[1]!,
    verb: m[2] ?? null,
    target: m[3] ?? null,
    outcome: m[4] as Outcome,
    message: m[5] ?? null,
  };
}
