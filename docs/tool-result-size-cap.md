# Tool-result size cap on the butchr MCP surface — measurement (BUTCHR-234, for BUTCHR-229/BUTCHR-228)

Answers, by direct measurement wherever possible, the five questions
BUTCHR-229 set: which layer imposes the "exceeds maximum allowed tokens"
cap seen on large tool results, what unit it is measured in, whether butchr
can configure it, which verbs on this MCP surface can hit it (reads,
writes, and non-doc verbs alike), and whether any agent has been silently
affected by it.

**Every number in this document is a snapshot.** It was taken on one host,
through one Claude Code CLI build, on 2026-09-02/03, against a corpus that
grows every session. Re-derive, don't trust — each measurement below names
the exact command and the falsifier that would have refuted it.

## Do this before trusting anything below

This document cites paths, line numbers, and a specific CLI binary version.
All three drift. Before relying on any of them:

- Resolve **your own** daemon's host/port/unit/journal command from **your
  own workspace's `ENVIRONMENT.md`** — never from this document or from any
  ticket. More than one butchr daemon can run on a host under different
  Unix users; a guessed unit returns a real journal for the wrong daemon,
  not an error.
- Resolve the **running** daemon's pid and working tree live
  (`systemctl --user show butchr.service -p MainPID --value`, then
  `readlink -f /proc/<pid>/cwd`) rather than trusting any pid recorded in a
  workspace snapshot — the daemon restarts, and a workspace's
  `ENVIRONMENT.md` is written once and never refreshed.
- Verify any `src/...:<line>` citation in **your own checkout at your own
  commit** — this document's citations are pinned to butchr commit
  `7831e019f97ac86a831c34ca2c697a6539d8d8b6` (my `BUTCHR-234` branch, cut
  from `BUTCHR-229`) and will drift.
- Verify the Claude Code CLI version this document's binary analysis used
  (`echo $CLAUDE_CODE_EXECPATH`, or the binary's own embedded `// Version:`
  string) — a different CLI build can behave differently. Mine was
  **2.1.258**.

## Method note on the CLI binary

Two of the findings below (Q1's harness attribution, Q2's mechanism, Q3's
configurability) come from `strings`/`grep`/Python-byte-offset inspection
of my own locally-installed Claude Code CLI binary
(`/home/wroosbit/.local/share/claude/versions/2.1.258`, an executable I
already run every tool call through). This is static analysis of my own
client software to explain its own observed behavior toward me, not
analysis of a third party's system. Every claim from it is cross-checked
against a live reproduction where one exists, and marked separately where
it isn't.

---

## Q1 — Which layer imposes the cap

**MEASURED: the calling harness (the Claude Code CLI), above both the
butchr daemon and its MCP transport.** Four independent pieces of
evidence, each with its own falsifier:

**(a) The daemon's own transport dependency contains no size-limit logic
at all.** `@brooswit/thatch` v0.6.0 (the package `package.json` declares
and the version actually present in the running daemon's
`node_modules`) compiles to 10,512 bytes across `dist/*.js`. Command:
`grep -rniE 'maxlength|maxsize|max_|truncat|bytelength|token' <thatch dist dir>`.
**Falsifier: any match would mean the transport package at least has the
vocabulary for a size cap.** Result: zero matches, checked both in
`index.js` alone and recursively across every `.js` file under `dist/`.

**(b) butchr's own tool code contains no generic result-size cap either.**
`grep -rniE 'maxlength|truncat|\bsize\b|limit' src/tools/*.ts` (my worktree,
commit `7831e019`) turns up only Jira/Confluence **field**-length guards —
`JIRA_DESCRIPTION_CHAR_LIMIT = 32767`, `JIRA_SUMMARY_CHAR_LIMIT = 255`,
`JIRA_COMMENT_CHAR_LIMIT = 32767` (`src/tools/relationship.ts:1230,1231,1316`
— verify yourself, these drift). These guard **outbound writes against
Atlassian's own API limits** and are two orders of magnitude smaller than
the cap this document is about; they are not it. **Falsifier: a generic
result-size check unrelated to a specific Jira/Confluence field would
refute "the daemon has no such logic"; none was found.**

**(c) A direct call to the daemon, bypassing the CLI harness entirely,
returns the full oversized result with no error.** I opened an MCP session
straight against the daemon's own HTTP endpoint
(`http://localhost:7717/mcp`, resolved from my own `ENVIRONMENT.md`) with
`curl`, independent of the Claude Code CLI:

```
curl -sS -X POST http://localhost:7717/mcp \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -H "x-issue: BUTCHR-234" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize", ...}'
# -> mcp-session-id header returned
curl -sS -X POST http://localhost:7717/mcp -H "mcp-session-id: <id>" ... \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"set_doc","arguments":{"body":"<85,000-char synthetic string>","title":"..."}}}'
```

The daemon answered **HTTP 200**, a well-formed JSON-RPC result, with the
**entire 85,000-character body echoed back verbatim** in `result.content[0].text`
(raw response 85,454 bytes; parsed and confirmed the tail of the echoed
body matches what was sent, byte for byte). No truncation, no error, no
size-based refusal anywhere in this path. **Falsifier: an HTTP error, a
truncated body, or any `exceeds maximum` text in this raw response would
mean the daemon itself enforces a cap; none appeared.** This is first-party
evidence that neither the daemon nor thatch caps a **write** result either
— see Q4 for how this connects to `set_doc`.

**(d) The exact error text and file-spooling behavior are compiled into
the CLI binary and reference paths the daemon cannot see.** Locating the
literal substring `exceeds maximum allowed tokens` in
`/home/wroosbit/.local/share/claude/versions/2.1.258` (Python, byte-offset
context extraction — `grep -a` mangles this binary's long lines) finds the
exact function that builds the message I reproduced live:

```js
function Imt(e,n,r,o,d){
  let y = `Error: result (${...} characters ...) exceeds maximum allowed tokens. Output has been saved to ${e}.\nFormat: ${r}\n`;
  ...
}
```

and a second function (`Ofe`) building the softer
`<persisted-output>Output too large (X). Full output saved to: Y ... Preview (first Z): ...`
wrapper (see Q2). Both reference **my own local filesystem path**
(`~/.claude/projects/.../tool-results/...`) — a path the butchr daemon,
running as a different OS process with no access to my home directory's
Claude Code state, cannot construct or write to. **Falsifier: if this text
existed only in butchr's own source or in thatch, that would attribute it
to the daemon side; it exists only in the CLI binary.**

**(e) The daemon's own journal treats a call that later got capped
exactly like one that didn't — it never differentiates.** From my own
workspace's `ENVIRONMENT.md`: host `servyboi`, unit `butchr.service`,
`journalctl --user -u butchr.service`. The line for my own capped call:

```
Sep 02 13:42:28 servyboi bun[338538]:   [tools] BUTCHR-234 → get_doc BUTCHR
```

— byte-for-byte the same log shape as every uncapped `get_doc` call by
other agents in the same window (`BUTCHR-228 → get_doc BUTCHR`,
`BUTCHR-216 → get_doc BUTCHR`, `BUTCHR-217 → get_doc BUTCHR-217 (self)`).
I also grepped two hours of journal around my own capped calls for
`exceed|token|truncat|error|fail` (excluding the unrelated
`[reconcile]`/`[crashloop]` lines): zero matches tied to any of them.
**Falsifier, stated before running it (per the ticket's own instruction):
a journal line naming this call with an error/exceed/truncate tag would
be direct evidence the daemon itself failed the call; none appeared, at
this log verbosity.** I note explicitly: this is **not** proof the daemon
"saw success" in some richer sense — its journal simply doesn't log
per-call response size or content at all, for *any* call, capped or not,
so this evidence is consistent with "the daemon never fails" but doesn't
independently establish it the way (a)–(d) do. (c) is the strongest single
piece of evidence here, because it is the only one that doesn't depend on
absence-of-a-log-line reasoning.

**What would still make this stronger:** a controlled read through the
daemon HTTP endpoint directly (mirroring the `set_doc` probe in (c)) for a
**large read**, not just the large write I tested. I did not run this — the
read side is already covered more directly by (a), (b), (d), and (e)
together, and I judged the marginal evidence not worth a fifth live probe
against production data. Anyone re-verifying this should feel free to add
it.

---

## Q2 — What the cap is measured in, and how many behaviours there are

### There are (at least) two distinct oversize behaviours, confirmed both by static analysis and by my own live reproductions

**MEASURED, live, this session** (host `servyboi`, CLI 2.1.258, all same
session so nothing here is cross-host):

| # | verb / call | inner content size (chars / bytes) | shape observed |
|---|---|---|---|
| 1 | `get_doc(key="BUTCHR")` | 81,032 / 81,076 | **ERROR** — "Error: result (...) exceeds maximum allowed tokens" |
| 2 | `jira_get_issue(BUTCHR-234)`, early in session (6 comments) | 50,125 / 50,269 | **PREVIEW** — "Output too large (50.5KB). ... Preview (first 2KB): ..." |
| 3 | `jira_get_issue(BUTCHR-234)`, after 1 more correction (7 comments) | 55,701 / 55,859 | **PREVIEW** |
| 4 | `jira_get_issue(BUTCHR-234)`, after branch-creation comment (9 comments) | 79,310 / 79,554 | **ERROR** |
| 5 | `jira_get_issue(BUTCHR-234)`, after 1 more correction (10 comments) | 121,358 / 121,774 | **ERROR** |
| 6 | `jira_search(project=BUTCHR order by created desc, maxResults=50)` | 756,302 / 759,877 | **ERROR** |
| 7 | `confluence_search_pages(titleContains="a", limit=100)` | small, not spooled | inline, no cap hit |
| 8 | `get_doc(key="BUTCHR-228")` | ~5–6 KB | inline, no cap hit |

Method for rows 1–6: read the spooled file directly
(`wc -c -m <file>` for byte/char counts; for the two PREVIEW rows the
spooled file is a JSON array of content blocks — I parsed it with Python
and measured the **inner `text` field**, not the outer array-with-indentation
wrapper, to get an apples-to-apples figure against the ERROR rows, which
spool the raw MCP response text with no wrapper). **Falsifier: if the
spooled file were truncated, incomplete, or invalid JSON, that would mean
the daemon itself sent partial data; every file here parsed cleanly and
the reported char count matched the file's own length exactly** (e.g. row
1's file is exactly 81,032 Python-`len()` characters, matching the error
text's "81,032 characters" precisely).

This is the same two-shape pattern BUTCHR-216 established under a
controlled experiment (same host/harness/verb/session/object, size varied
by one added comment) and reported via BUTCHR-229's correction on this
ticket (comment 18910) — bracket **(56,239, 61,376] characters** — and
which I independently read again in BUTCHR-228's own root doc
(`get_doc(key="BUTCHR-228")`, live, this session), which states the
identical bracket and the same characters-vs-bytes divergence caveat
(61,376 chars vs 61,550 bytes there). **I want to be precise about what
"independently" means here: both citations trace back to the same one
BUTCHR-216 experiment — this is repeated citation of one data point, not
two separate replications.** My own rows 2–5 above are a second,
uncontrolled data point (uncontrolled because my ticket's comment growth
was incidental to doing this work, not a deliberate size-only variation)
that is **consistent with, but does not tighten,** BUTCHR-216's bracket:
my last PREVIEW (55,701 chars) sits just under their bracket's low end,
and my first ERROR (79,310 chars) sits well above their bracket's high
end — both compatible with a real boundary of ~56–61K chars, neither
narrows it further.

**Two distinct message-formatting code paths exist in the CLI binary,
matching the two observed shapes** (static analysis, `2.1.258`):
- `Ofe()` builds the `<persisted-output>Output too large (X). Full output
  saved to: Y\n\nPreview (first 2000): ...` wrapper — the **PREVIEW** shape.
  It rounds the size to KB (`Bt()`) and always includes exactly the first
  2,000 characters of preview content (`bOe = 2000`).
- `Imt()` builds the `Error: result (X characters across N lines) exceeds
  maximum allowed tokens...` message — the **ERROR** shape. It reports an
  *exact* character count, never rounded.

**This exact-vs-rounded distinction is itself a trap** (the same one
BUTCHR-229's correction on this ticket flagged, independently, from the
BUTCHR-216 side): assembling a table from the harness's own printed
strings silently mixes an exact character count against a rounded KB
figure. I avoided it above by reading the spooled files directly rather
than trusting the printed "(50.5KB)"/"(56.1KB)" strings.

**Is the PREVIEW/ERROR choice itself one mechanism or two?** MEASURED:
there are two distinct compiled functions producing two distinct
presentations (above). REASONED, not independently re-derived by me
beyond citing BUTCHR-216's controlled experiment: the *selection* between
them is primarily size-driven, with a boundary in the ~56–61K character
range, not tied to which verb produced the result — BUTCHR-216's own
report of `jira_search` producing **both** shapes at different sizes is
the strongest evidence for this, and my own data (rows 2–5, one verb,
monotonically growing, PREVIEW then ERROR, never the reverse) is
consistent with it. I did not myself construct a deliberate,
monotonic-size-only experiment beyond what my ticket's incidental growth
already provided — **that is a gap**: what would close it is what
BUTCHR-216 already did (repeat one call against one growing object,
varying nothing else) run once more, independently, to convert "consistent
with" into a second controlled replication.

I traced part of the mechanism inside `Imt()` itself: it takes a `d`
parameter describing line-count/max-line-length shape, and branches on
whether `d.count > 1 && d.maxLen <= k` (where `k` derives from a
token-based file-read budget, see Q3) to decide **how** to word the
error's chunking guidance — this affects message wording, not (as far as I
traced) the PREVIEW-vs-ERROR shape selection itself. **I did not find, and
did not have time to find, the exact comparison that selects `Ofe` vs
`Imt`** — this remains not established by me beyond the size-driven
account above.

### The unit

**MEASURED, on the MCP path** (which is the only path this document
measured — see the scope note below): the quantity actually compared
against the threshold is a
**character count**, not a byte count and not a real tokenizer's token
count. Every error message reports "N characters," and in every case I
checked, N exactly equals the Python `len()` (Unicode codepoint count,
≈ JS UTF-16 code-unit count for this corpus, which is BMP-only) of the
spooled file — not its byte length. Byte length is always somewhat larger
in this corpus (e.g. row 1: 81,032 chars vs 81,076 bytes; row 4: 79,310
vs 79,554; row 6: 756,302 vs 759,877) because of em dashes and other
non-ASCII punctuation common in this project's prose. Since the reported
number tracks the character count exactly and not the byte count, a
byte-based remedy and a character-based remedy are **not** interchangeable
here — a body that stays under a character cap can still be well over the
equivalent byte cap, or vice versa, depending on how much non-ASCII prose
it contains.

**REASONED (static analysis, not independently verified by toggling
config):** the limit is *configured* and *named* in terms of tokens
(`MAX_MCP_OUTPUT_TOKENS`, default 25,000 — see Q3) and then converted to a
character budget via a hardcoded heuristic multiplier found in the binary:
`function _ee(){ return c()*4 }` (a flat 4-characters-per-token estimate,
not a real tokenizer), and separately, the function that builds the exact
error message I reproduced computes
`k = Math.floor(uX().maxTokens * 4 * 0.8)` (an 80%-margin variant of the
same 4x heuristic, keyed off a **different** token budget — the file-read
one, see Q3). **I flag explicitly that I could not make either formula's
arithmetic match my own measured bracket cleanly:** 25,000 × 4 = 100,000
and 25,000 × 4 × 0.8 = 80,000 are both well outside the ~56–61K character
boundary BUTCHR-216 measured under control and I corroborated loosely.
Either a different token budget is in effect than the 25,000 default (a
remote feature flag can override it — see Q3 — and I have no way to
inspect flag values from outside the CLI process), or the true trigger
condition is not the simple formula I read, or there's a third piece of
logic I did not locate. **So: the mechanism (token-budget, converted to a
character budget via a small multiplier) is well-evidenced; the exact
formula and threshold currently in effect is NOT established by me.** What
would establish it: deliberately set `MAX_MCP_OUTPUT_TOKENS` to a small
known value (e.g. 500) in the environment that launches `claude`, repeat
BUTCHR-216's controlled growing-object experiment, and confirm the
boundary moves proportionally.

### ⚠ Scope of the unit finding: the MCP path only — another path is governed by BYTES

*(Added by BUTCHR-229 at integration, from its own measurement. Everything
above in Q2 is BUTCHR-234's work and is unchanged; this subsection exists
because the unit claim above would otherwise read as universal, and it is
not. No part of BUTCHR-234's measurement is retracted or amended.)*

**This document measured the MCP path. It is not the only capped path, and
the unit is not the same on all of them.** MEASURED by BUTCHR-229, on its
own host, 2026-09-03, against plain **Bash** output — which never reaches
butchr, the daemon, or MCP at all:

| characters | bytes | shape |
|---|---|---|
| 9,990 | 29,970 | inline |
| 30,000 | 30,000 | inline |
| 30,001 | 30,001 | preview (spooled) |
| 11,000 | 33,000 | preview (spooled) |

Commands: `python3 -c "import sys; sys.stdout.write('a'*30000)"` and
`python3 -c "import sys; sys.stdout.write('—'*11000)"`.

**On that path the governing quantity is BYTES, not characters:** 30,000
characters returned inline while 11,000 characters spooled. Only the
multi-byte rows can discriminate — in pure ASCII the two quantities are
identical, so no ASCII experiment can tell them apart, and every ASCII row
above is non-discriminating by construction. *Falsifier: if 11,000
em-dashes had returned inline, or 9,990 em-dashes (29,970 bytes) had
spooled, the byte reading would be dead.* Neither happened.

That is a **different budget** from the one measured above, which is
consistent with Q3's finding of two separate environment variables
(`MAX_MCP_OUTPUT_TOKENS` vs `CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS`).

**What this means for anyone choosing a unit for a size bound:** do not
carry "the unit is a character count" across path boundaries. Establish
the unit for the path you are actually bounding. In this corpus the two
quantities diverge by a real margin — em dashes and arrows are everywhere
— so picking the wrong one is wrong by more than a rounding error.

**Not established:** whether the ~30,000-byte Bash threshold and the MCP
threshold are the same underlying mechanism with different budgets, or two
mechanisms. All MCP observations here sit far above 30,000 bytes, so
nothing in this document distinguishes them. What would settle it: an MCP
call whose result size can be tuned near 30,000 bytes.

---

## Q3 — Whether the cap is configurable, and by whom

**MEASURED (static analysis, CLI 2.1.258) — configurable, but only on the
calling-harness side, via environment variables read by the CLI process
itself:**

- `MAX_MCP_OUTPUT_TOKENS` — read directly (`a.MAX_MCP_OUTPUT_TOKENS` in the
  binary, where `a` is an env-var accessor), else a remote feature flag
  (`tengu_velvet_ibis`'s `.mcp_tool` field — a server-side experiment flag
  I cannot read the value of from outside the CLI process), else a
  hardcoded default of 25,000 (tokens). This name also appears in what
  looks like the binary's own allowlist of env vars a `settings.json`
  `env` block is permitted to set (grouped with `MCP_TOOL_TIMEOUT`,
  `MCP_TIMEOUT`, `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT`).
- `CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS` — same pattern, else a
  different remote flag (`tengu_amber_wren`'s `.maxTokens`/`.maxSizeBytes`),
  else the same 25,000-token default. This is the one the exact error
  message I reproduced (`Imt()`) actually keys off, via a helper (`uX()`)
  shared with the CLI's own local-file-read size guard.

**MEASURED, checked in my own session:** neither env var is set —
`env | grep -iE 'mcp|token|max.*output|claude'` shows only unrelated
`CLAUDE_CODE_*` session-identity variables (`CLAUDE_CODE_SESSION_ID`,
`CLAUDE_CODE_BRIDGE_SESSION_ID`, etc.), and `~/.claude/settings.json` has
no `env` block at all. So everything measured above ran against
whatever the CLI's defaults (and any remote feature-flag override I
cannot see) currently resolve to.

**MEASURED, from source, in my own worktree at commit `7831e019`:**
butchr's own code has no config surface for this at all — no env var, no
config field, nothing in `src/config/config.ts` or `src/tools/*.ts`
governs a generic result-size limit (only the unrelated,
much-smaller Jira field-length constants from Q1(b)). The MCP transport
dependency (`@brooswit/thatch` v0.6.0) is equally bare, per Q1(a).

**Conclusion, directly answering the redirect question this ticket exists
to settle: the cap is harness-side, and butchr has no lever to raise it.**
The only remedy available to butchr is "return less, honestly" — matching
what BUTCHR-228's own root doc independently concludes (I read it live,
this session, via `get_doc(key="BUTCHR-228")`): *"the daemon is not the
failing layer... butchr cannot raise it — 'return less' is the only
remedy available."*

**NOT established by me:** I did not verify this live by actually setting
either env var and relaunching a session — this session's `claude` process
was already running with a fixed environment at the time I discovered
this, and restarting mid-ticket to test it felt like more disruption than
the marginal evidence was worth. What would establish it: launch a fresh
`claude` session with `MAX_MCP_OUTPUT_TOKENS=500` (or similar) set before
the process starts, repeat a call that currently returns inline (e.g.
`get_doc(key="BUTCHR-228")`, ~5–6KB, currently uncapped), and confirm it
now gets capped.

---

## Q4 — Blast radius: which verbs can exceed the cap (reads, writes, and non-doc verbs)

Surface enumerated from the tool registry in my own worktree,
`src/tools/defs.ts`, commit `7831e019f97ac86a831c34ca2c697a6539d8d8b6`
(verify the line numbers yourself before trusting them — they drift).
32 verbs total.

| Verb | Kind | Result shape (source) | Exceeds cap? | Evidence |
|---|---|---|---|---|
| `get_doc` (project key) | doc read | full page body echoed | **YES, in practice** | MEASURED — row 1 above, ERROR shape, 81,032 chars |
| `get_doc` (ticket key, small doc) | doc read | full page body echoed | not in this instance | MEASURED — `get_doc(BUTCHR-228)`, ~5–6KB, inline |
| `get_doc` (ticket key, large doc) | doc read | full page body echoed | in principle, untested at scale | REASONED — same code path (`src/tools/docs.ts:getDoc`/`getProjectDoc`) as the project-key case that does exceed; a boss reading a large worker doc at review time is the scenario the ticket flags as load-bearing, and I did not have a large enough ticket doc on hand to reproduce it directly |
| `jira_get_issue` | non-doc read | full description + **all** comments | **YES, in practice, on an ordinary ticket** | MEASURED — rows 2–5 above; this is the most important single row: my own ticket, an ordinary task with 6→10 routine comments, crossed from PREVIEW to ERROR shape purely from normal coordination traffic, not from any unusually large document |
| `jira_search` | non-doc read | full description of **every matching issue** | **YES, in practice** | MEASURED — row 6, 756,302 chars from a 50-result broad search; mechanism (returns full description per hit, not a summary) inherited from BUTCHR-228's root doc and consistent with the size I measured for 50 results of typically-long butchr ticket descriptions |
| `get_doc_comments` | doc read (project only) | full comment bodies, unbounded collection | **not testable by me** | REFUSED for my (issue) caller identity — MEASURED, direct call: `"get_doc_comments: refusing an issue caller..."`. This verb is PROJECT-caller-only by design; I cannot reproduce its size behavior from this ticket's identity. The originating epic (per this ticket's own inherited text) reported it also spools on a large root doc, which I did **not** independently verify — flagged here as unverified, not as established |
| `list_peers` | non-doc read (project only) | small collection of project key/name pairs | **not testable by me, and unlikely to matter if it were** | REFUSED for my caller identity, same reason as above — MEASURED refusal. REASONED unlikely to exceed even for a project caller: only ~9 live spaces/projects were visible via `confluence_search_pages` in this estate, so even an unbounded collection of that shape would be small |
| `confluence_search_pages` | non-doc read | `{id, title, webui}` per hit, capped at `limit` (max 100) | no, in this test | MEASURED — `limit:100, titleContains:"a"` returned 100 hits inline, no spool. REASONED bounded by design generally: each hit is three short strings, not a body |
| `confluence_get_page` | doc read (non-ticket pages) | full page body (deprecated alias of `get_doc`) | in principle, untested directly | REASONED — its own description says it returns "storage body," the same unbounded shape as `get_doc`; not independently measured by me this session |
| `confluence_list_spaces` | non-doc read | list of spaces | very unlikely | REASONED — same ~9-space estate as above |
| `set_doc` | doc **write** | **echoes the full written body back** — confirmed at the source line, not merely reported: `src/tools/docs.ts:249` (`setProjectDoc`) and `:449` (`setDoc`) both literally `return { id, url, title, body }` reusing the caller's own input variable | **YES, at the daemon level; harness-level not independently confirmed on the normal call path** | MEASURED (source): the echo is real, not a report from someone else in the chain. MEASURED (daemon): a direct 85,000-char write via `curl`, bypassing the CLI harness, returned the full echo with no cap at the daemon (Q1(c)). REASONED, high confidence but not independently reproduced through the normal tool-call path: the CLI harness's cap operates on the generic MCP result content array regardless of which tool produced it or whether it came from a read or a write (per the `Imt`/`Ofe` code read in Q2, which takes generic content, not a tool name) — a `set_doc` result of comparable size to the `get_doc` result that already failed (row 1, 81,032 chars) would be expected to hit the same cap. I chose the daemon-bypass test specifically to avoid leaving a large synthetic body sitting in my own live ticket doc for any length of time (restored the original placeholder immediately after), and to avoid the output-token cost of typing an 80K+ character tool-call argument inline in this session. |
| `confluence_create_page` | doc write (non-ticket pages) | Confluence API response, **no `bodyFormat` requested** on the create call (`src/tools/atlassian-real.ts:120-126`) | unlikely | REASONED — unlike `set_doc`, this does not construct its return value from the caller's input; it forwards whatever the bare Confluence API returns, and the API call requests no body representation back, so the response is expected to be small (id/version/metadata) |
| `confluence_update_page` | doc write (non-ticket pages) | same pattern — `orOk(r, {ok:true, id})`, `r` from an API call with no `bodyFormat` requested (`src/tools/atlassian-real.ts:157-168`) | unlikely | REASONED, same basis as above |
| `jira_add_comment` | write | ack + comment text bounded by `JIRA_COMMENT_CHAR_LIMIT = 32767` | no | REASONED — source-confirmed constant, well under the ~56–61K character boundary |
| `jira_create_issue` | write | ack; `description` bounded by `JIRA_DESCRIPTION_CHAR_LIMIT = 32767` | no | REASONED, same basis |
| `jira_link_issues` | write | `{ok, from, to, type}` — no body echo (`src/tools/defs.ts:180-196`) | no | REASONED — verified the handler's return shape directly; nothing unbounded in it |
| `jira_transition`, `jira_set_priority`, `jira_assign` | write | small acks | no | REASONED, same basis as `jira_link_issues` — checked their handlers carry no doc/body echo |
| `correct_worker` | write | archive comment explicitly chunked to stay under `JIRA_COMMENT_CHAR_LIMIT` (`src/tools/relationship.ts:1409-1481`) | no | REASONED — the chunking logic exists precisely to keep this bounded |
| `tell_worker`, `report_to_boss`, `ask_boss`, `tell_peer` | write (post a comment) | comment text, same `JIRA_COMMENT_CHAR_LIMIT` | no | REASONED, same basis |
| `new_worker`, `start_worker`, `shelve_worker`, `adopt_worker`, `finish_worker`, `prioritize_worker`, `check_in`, `submit_to_boss`, `finish_without_a_boss` | write | small acks | no | REASONED — none of these construct a return value from a large stored document or from unbounded caller input |
| `file_where_it_belongs` | write | creates a ticket; description bounded by `JIRA_DESCRIPTION_CHAR_LIMIT` | no | REASONED, same basis as `jira_create_issue` |

### Q4(a) — Is the cap a property of RESULTS generally, or of doc verbs specifically?

**MEASURED: a property of results generally, not a doc-verb problem.**
`jira_get_issue` and `jira_search` are both non-doc verbs — neither reads
or writes a ticket's Confluence doc — and both were **directly measured**
to exceed the cap this session (rows 4–6 above). This is not a "several
things failed, therefore general" inference from unrelated failures; it's
the same mechanism (a large JSON result, spooled by the harness) hitting
two verbs whose only shared property with `get_doc` is "the result can be
arbitrarily large," not "the result is a document body." I varied the
property that actually distinguishes them (doc-ness) by directly testing
two non-doc verbs, not by assuming.

### Q4(b) — The severity asymmetry between a failed read and a "succeeded while reporting an error" write

One sentence, as requested: a failed read costs the caller nothing it
didn't already not have — it knows it got nothing, and any response to
that is safe — but `set_doc`'s confirmed echo-the-input shape (Q4's
`set_doc` row) means a write that is large enough to trip this cap can
**succeed at the daemon while the caller is told it failed**, and in a
corpus where nothing is ever archived, both a blind retry (re-issuing a
full-body replace) and an assume-failed-and-reconstruct-from-a-stale-read
response are destructive — a finding BUTCHR-228's own root doc reaches
independently and states more sharply: *"the only correct response is to
disbelieve the result, which is the one response no protocol teaches."*

---

## Q5 — Whether any agent has already been silently affected

**A clean partial answer, not a complete one: I found the originating
incident, confirmed it was reported rather than silently absorbed, and did
not find broader evidence either way.**

**MEASURED:** the daemon journal on my own host (`servyboi`,
`butchr.service`) contains the exact originating call this whole ticket
chain traces back to:

```
Sep 02 13:32:50 servyboi bun[338538]:   [tools] BUTCHR-228 → get_doc BUTCHR
```

immediately followed, in the same window, by `BUTCHR-228 → get BUTCHR-216`,
`→ comment BUTCHR-216`, `→ new_worker disposition=start` (filing
BUTCHR-229), `→ new_worker disposition=shelve` (×2, filing BUTCHR-230/232),
and `→ set_doc BUTCHR-228 (retitle ...)`. **This is direct evidence BUTCHR-228
was not silently affected**: it hit the cap, and rather than proceeding as
though its read had returned nothing (or everything), it read the spooled
file, understood what happened, and spawned this entire investigation
chain — the opposite of the silent-failure mode this question worries
about.

**MEASURED, first-person:** I hit the same PREVIEW-shape truncation myself
this session (rows 2–3 above) on my own ticket, and did not proceed on the
2KB preview — I read the spooled file directly with a shell tool, per the
CLI's own guidance text, and used the full content. This is one
concrete instance of the failure mode being **avoided**, not evidence it
never happens.

**Not established, and here is what would establish it:** I did not find,
and did not have time to exhaustively search for, an instance of an agent
proceeding on a truncated PREVIEW as though it were complete — the failure
mode Q5 is actually worried about is precisely the quiet one, where an
agent never comments on it because it doesn't notice, so absence of a
comment is not evidence of absence here. A targeted search across the
daemon's history for docs/tickets that read as authoritative but disagree
with what the underlying page actually contains (the kind of drift a
silently-truncated read would produce) would be a stronger check than
anything I ran; I did not run it. Additionally: a roughly **7.5-hour
fleet-wide becalming** (a separate, already-tracked daemon defect owned by
BUTCHR-207/210, per BUTCHR-229's correction on this ticket and BUTCHR-228's
own root doc) sits across part of this window — any journal gap in that
range reflects the becalming, not evidence about this cap, and I did not
mistake one for the other in the search above, but I also did not have
time to rule out subtler effects inside the becalming window.

---

## What this document deliberately does not establish

- The exact numeric threshold currently in effect (Q2) — the mechanism
  (token budget → character budget via a small hardcoded multiplier) is
  well-evidenced from the CLI binary; the precise formula and value is
  not, because my own measured bracket doesn't cleanly match the simplest
  reading of that formula, and I did not toggle the governing env var to
  test it directly.
- Whether `set_doc` actually gets capped by the CLI harness on a **normal**
  (non-bypassed) large write — I measured the daemon side directly and the
  source-level echo shape directly, and reasoned from there, but did not
  run the harness-path write itself (see the `set_doc` row in Q4 for why).
- The exact code-level decision point that selects PREVIEW-shape vs
  ERROR-shape presentation (Q2) — I found the two presentation functions,
  not the selector between them.
- `get_doc_comments`'s and `list_peers`'s actual size behavior — both
  refuse an issue-tier caller by design; testing them requires a
  project-tier identity I don't have on this ticket.
- Whether any agent has been silently affected beyond the one originating
  incident I found and confirmed was *not* silent (Q5).
- **Any capped path other than the MCP one.** This document measured the
  MCP path only. At least one other path exists and is governed by a
  *different unit*: plain Bash output caps at **30,000 bytes**, where the
  governing quantity is bytes rather than characters (BUTCHR-229's
  measurement, added at integration — see the scope subsection in Q2).
  Whether the two are one mechanism with different budgets or two
  mechanisms is **not established**; nothing here distinguishes them,
  because every MCP observation in this document sits far above 30,000
  bytes.

---

## Recommendations to the sibling stories

*(Recommendations, not findings — offered because they came up naturally
while measuring; not acted on here, per this ticket's scope.)*

- **BUTCHR-230** (bounding `get_doc`'s read): since the cap is
  character-measured and harness-side (Q1–Q3), and butchr cannot raise it,
  any read-side remedy has to be "return less, honestly" — e.g. a
  size-aware summary/pagination contract — rather than any attempt to
  request a larger budget. The ~56–61K character boundary (BUTCHR-216's
  bracket, not independently tightened here) is a reasonable order-of-magnitude
  target for a single inline response, but should be re-measured against
  whatever CLI version is current at implementation time, not hardcoded
  from this document.
- **BUTCHR-232** (structural bound / index+child-pages): worth checking
  early whether restructuring a large project root doc into an index with
  linked child pages changes `jira_search`'s exposure too — `jira_search`
  degrades independently of any doc restructuring (Q4(a)), so BUTCHR-232's
  fix, however good, will not touch that verb.
- **BUTCHR-235** (write result shape): this document's `set_doc` row
  (Q4) and Q4(b) both corroborate what its own scope already targets —
  the echoed-body shape is real at the source level (`src/tools/docs.ts:249,449`),
  not merely reported secondhand.
- **General:** any fix that changes a tool's description should ship the
  description change in the same PR as the behavior change — a stale
  description advertising old behavior would reproduce exactly the kind
  of silent-drift failure mode Q5 is about, one level up.

---

## Appendix — raw commands, for re-derivation

```sh
# Reproduce the get_doc project-root-doc failure (row 1):
#   call get_doc(key="<project key>") through your own MCP session

# Measure a spooled file's exact character/byte counts:
wc -c -m <spooled-file>          # bytes, then chars (GNU wc order: lines chars bytes when -c -m -l given)
python3 -c "print(len(open('<f>').read()))"       # chars (Unicode codepoints)
python3 -c "print(len(open('<f>','rb').read()))"  # bytes

# Resolve the live daemon (never trust a workspace ENVIRONMENT.md snapshot's pid):
systemctl --user show butchr.service -p MainPID --value
readlink -f /proc/<pid>/cwd
git -C <that path> log -1 --format='%H %ci %s'

# Grep the MCP transport dependency for size-limit logic (from the daemon's own node_modules):
grep -rniE 'maxlength|maxsize|max_|truncat|bytelength|token' <path>/node_modules/@brooswit/thatch/dist

# Grep the CLI binary for the exact error template (Python, not grep -a — the binary's lines are too long):
python3 -c "
import re
data = open('<claude CLI binary path>','rb').read()
for m in re.finditer(re.escape(b'exceeds maximum allowed tokens'), data):
    print(data[max(0,m.start()-1200):m.start()+400].decode('utf-8','replace'))
"
```
