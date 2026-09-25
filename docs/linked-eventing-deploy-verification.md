# Linked-change eventing deploy verification (BUTCHR-439, story BUTCHR-430, epic BUTCHR-421)

**STATUS: DRAFT / IN PROGRESS — this file is a skeleton being filled in as the
verification proceeds. Sections marked PENDING have not happened yet. Do not
read this as a finished record.**

Answers the epic's Done-when clause: "The deploy is verified in the journals
with a real linked-item change delivering exactly one turn to its query-based
agent," plus a no-regression check that an owned resource's own change still
delivers a turn exactly as before the epic.

## Scope and what this does NOT claim

This is a Claude-agent-delivery-only verification (HARD CONSTRAINT 4 on
BUTCHR-439) — the notify path does not reach Codex agents (BUTCHR-359,
pre-existing, not re-tested here). This document only speaks to the Jira-kind
linked path (issuelinks/parent/description-key/remote-links), verified via a
`Relates` issue-link change — the Confluence/GitHub/webpage pollers (story 3,
BUTCHR-428) and `linkedDescriptionLinks`/`linkedRemoteLinks` are NOT exercised
here.

## 1. Deploy — CONFIRMED

Requested by the epic (BUTCHR-421) through the director to admin-assembly
(BUTCHR-421 comments 24065, 24073). Deployed commit:
`aff46dd28fb4fb3eafcbae4996fd6062e2831591` (`main`, PR #402 merge —
"Merge pull request #402 from brooswit-factory/BUTCHR-428"). Rollback
commit: `460e13d5e782d26084b5e96cf02ca5ff82422cb0` (both daemons' prior
build).

Verified independently by this task's own agent (BUTCHR-439), not copied
from another agent's report:

- `git -C ~/code/brooswit-factory/butchr merge-base --is-ancestor
  8718891162928e637e97c68faaaab84bc6cadb1c aff46dd28...` — BUTCHR-426's
  merge is an ancestor of the deployed commit. Exit 0 (true).
- Same check against `2ab17983bf713bd8382c31c5b85a5799d37019b8`
  (BUTCHR-427's merge) — also an ancestor. Exit 0 (true).
- `aff46dd`'s own commit message is literally the BUTCHR-428 merge.
- Falsifier that did NOT fire: either check above returning non-zero would
  mean the deployed sha does not actually contain that story's code despite
  a matching-looking sha string; this is why ancestry was checked rather
  than trusting the sha alone.

Daemon build/currency, checked two ways per daemon:

| Daemon | Port | `/health` build.sha | `/health` currency | Journal evidence |
|---|---|---|---|---|
| booswrit | 7718 | `aff46dd28fb4fb3eafcbae4996fd6062e2831591` | `current` | own journal, `journalctl --user -u butchr.service`, local time: restart at 07:36:46 PDT, "build aff46dd2 (git-at-start, clean) version=0.15.5 pid=1280152" |
| wroosbit | 7717 | `aff46dd28fb4fb3eafcbae4996fd6062e2831591` | `current` | not readable by this agent (see §5); reported by BUTCHR-430 (whose own daemon this is) at pid 1281685, restart 07:39:05 PDT |

**STALENESS TRAP note (HARD CONSTRAINT 3 on BUTCHR-439):** this workspace's
own `ENVIRONMENT.md` snapshot, taken at workspace-build time, reported
booswrit's daemon as STALE (build `460e13d5`, 9 commits behind `main`,
missing even story 1). That snapshot predates the deploy above and was
correctly treated as a workspace-build-time artifact, not live truth — the
live `/health` check above supersedes it. Anyone re-reading this later:
re-check `/health` yourself rather than trusting either number as current.

## 2. Opt-in — CONFIRMED, on wroosbit only

Rule added to `/home/wroosbit/.config/butchr-new/resource-rules.json`
(assembly-applied, not by any task/story agent — HARD CONSTRAINT 1):

```json
{
  "id": "linked-eventing-verify-430",
  "enabled": true,
  "resourceProvider": "jira-work",
  "query": "key = BUTCHR-441",
  "brief": "Throwaway verification target for BUTCHR-421/BUTCHR-430 (linked-change eventing deploy verification). Acknowledge any nudge and do no other work. This rule and its target tickets are removed after verification.",
  "agentPreferences": [{"harness": "claude"}],
  "linkedEventing": true,
  "maxLinkedItems": 5,
  "maxLinkedTurnsPerHour": 2
}
```

Pre-change state: this rule did not exist before. wroosbit's rules file
otherwise carries `stories`, `subtasks`, `github-issues` (disabled),
`zendesk-tickets` (disabled) — none touched.

Loaded at the SAME restart that brought wroosbit onto `aff46dd` (07:39:05
PDT) — required, because these `linked*` fields are unknown to the prior
build (`460e13d5`) and `loadRules` throws on an unknown field, which would
have crash-looped the daemon had the rule been applied before the code that
understands it.

Target tickets (created by the epic/director, not by this task's agent):
BUTCHR-441 (owner, Task, assigned to the director's account — deliberately
not Story/Sub-task and not either service account, so it cannot match
wroosbit's `stories`/`subtasks` rules) and BUTCHR-442 (linked to 441 via a
`Relates` issue link).

## 3. Step C — the real linked change: PENDING, scheduled

**Not yet done.** Plan: the epic makes ONE summary edit on BUTCHR-442 (not a
status transition, so it can't be picked up by any staffing rule). This
task's agent does not make the change and does not touch BUTCHR-441/442.

Blocking condition hit: `maxLinkedTurnsPerHour: 2` was exhausted by two REAL
but UNINTENDED linked-change deliveries (07:39:42 and 07:39:53 PDT) caused
by BUTCHR-441's own description mentioning BUTCHR-430 and BUTCHR-421 (both
under active discussion for this very verification) — every ongoing comment
on either ticket registers as a linked change to 441 and immediately re-hits
the cap. The epic has no tool to edit a Jira issue description, so the
mentions cannot be removed from BUTCHR-441 (BUTCHR-430 comment 24095).

**Fixed schedule instead (BUTCHR-430 comment 24095):**
- The used slots free on schedule at ~07:39:42/07:39:53 PDT + 1 hour
  (~08:39:42/08:39:53 PDT) — a suppressed tick does not extend or reset the
  rate-limiter's own window (confirmed from source: state only advances on
  an actual sent notify, never on a capped/suppressed one).
- **Expected FIRST delivery — a catch-up, NOT the test:** the still-
  outstanding accumulated 430/421 changes are expected to deliver as one
  coalesced `[notify] ... (linked:N)` on the first poll tick after the
  window frees (~08:39:42-58 PDT). This must NOT be mistaken for the
  BUTCHR-442 test delivery — it is expected, unrelated noise, and will be
  recorded as such, not counted toward the acceptance criteria.
- The epic makes the real BUTCHR-442 summary edit at a fixed time:
  **08:41:30 PDT (15:41:30Z)**.
- **Expected SECOND delivery — the actual test:** exactly one
  `[notify] ... (linked:N)` shortly after 08:41:30 PDT is the pass
  condition for Step D.
- Both BUTCHR-430 and this task's agent stay silent on BUTCHR-430 and
  BUTCHR-421 from window-clear until ~08:46 PDT (a comment on either ticket
  would itself consume a freed notify slot on BUTCHR-441). This task's own
  ticket, BUTCHR-439, is NOT linked to BUTCHR-441, so comments here are
  safe and are how this task's agent will keep reporting during the window.

## 4. Step D — exactly one turn, no duplicate: PENDING

Grep patterns settled in advance (BUTCHR-439 comment 24090, approved in
comment 24091):

1. Linked-change delivery: `[notify] jira-work:linked-eventing-verify-430:BUTCHR-441 ← BUTCHR-441 (linked:` — each match is one coalesced delivery.
2. Rate-cap suppression (exclude from the count, but report if present in-window): `[notify-suppressed]` naming this agent, `arm=rate-capped`.
3. Corroboration only, not proof of causation: `[linked-discovery]` lines for this agent with `target=BUTCHR-442`.
4. State corroboration: `[labels]`/`[spawn]`/`[admission` lines naming BUTCHR-441 or its agent key.

**Why the `[notify]` line cannot name BUTCHR-442 by itself** (traced to
source, `src/daemon/index.ts`'s `notifyRuleAgent` + `src/jira-watch/linked-eventing.ts`):
the linked-eventing tick calls `deps.notify(m.agentKey, m.agentKey,
{linked:{events}})` — both the "issue" and "about" arguments are BUTCHR-441's
OWN agent key. `notifyRuleAgent` computes `aboutIssue = resourceKeyOf(about)`,
which always decodes back to BUTCHR-441 regardless of which linked item
actually changed. So attribution to BUTCHR-442 specifically is TEMPORAL
(edit timestamp vs. delivery timestamp, with no other real change in the
window) rather than textual — recorded here so a future reader doesn't
assume the log line itself names the item.

Cadence correction from the ticket's own text: the Jira-kind linked path
(which covers a `Relates` link) is not gated by `linkedPollIntervalMs` (that
knob only gates the three EXTERNAL pollers — Confluence/GitHub/webpage). It
runs on the ordinary jira-work resource-loop tick, hard-coded
`intervalMs: 15_000` in `src/daemon/index.ts` — confirmed identical on both
daemons (same binary/build). So the real expected cadence is ~15s, not the
5-minute default the ticket text assumed.

Journal-access note: this task's agent (booswrit, port 7718) has no OS-level
read access to wroosbit's journal or config
(`journalctl --user -u butchr.service -M wroosbit@` → "Operation not
permitted"; `/home/wroosbit/.config/butchr-new/` is mode 700). BUTCHR-430,
whose own daemon IS wroosbit's, captures and pastes the raw journal text;
this document will attribute it accordingly rather than imply independent
access that doesn't exist.

**PASS criteria (from BUTCHR-430 comment 24091):** exactly one `(linked:`
delivery to BUTCHR-441 in the capture window (10s before the edit to at
least 3 minutes after the first matching delivery — several multiples of
the ~15s poll interval), and no `[notify-suppressed]` for it. **FAIL:**
zero, or two or more. Any BUTCHR-430/421-sourced activity still landing in
the window makes the count ambiguous and must be flagged as such, not
smoothed over.

## 5. Step E — no-regression on BUTCHR-441's own change: PENDING

Plan: the epic makes one real ordinary change on BUTCHR-441 itself (e.g. a
status transition or comment), after the linked check, and this task's
agent counts the delivery the same way.

Technical note (to be confirmed against the actual journal, not asserted as
settled): `maxLinkedTurnsPerHour` is enforced entirely inside
`createLinkedEventingState().runTick()`, which is only ever invoked for the
`{linked:...}` notify shape. Ordinary own-ticket-change detection (status/
comment/label diffing) is a separate, pre-existing code path that calls
`notifyRuleAgent` directly with a non-`linked` reason and never touches the
linked-eventing rate-cap counter. If true, the regression check should not
be blocked by the linked-eventing rate cap regardless of how many linked
slots are used — but this is a hypothesis pending confirmation against real
journal lines, not a certainty.

## 6. Step F — revert: PENDING

Fast/no-restart revert: delete BUTCHR-441 (its query then matches nothing,
the agent stops). Full clean revert: remove the rule object from wroosbit's
rules file and restart wroosbit's daemon. Both go through the epic/assembly,
not this task's agent. Final cleanup: delete BUTCHR-441 and BUTCHR-442.

## 7. Honesty statement

As of this draft, no linked change has been made on BUTCHR-442, no journal
evidence exists for it, and nothing has been counted as a pass or fail. The
two early linked deliveries to BUTCHR-441 (07:39:42, 07:39:53 PDT) were
caused by its description accidentally mentioning BUTCHR-430/421, not by any
planned test — they are noise being cleaned up before the real test, and are
not being counted toward the acceptance criteria.
