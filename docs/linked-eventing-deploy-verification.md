# Linked-change eventing deploy verification (BUTCHR-439, story BUTCHR-430, epic BUTCHR-421)

**STATUS: Steps A-E complete and PASS. Step F (revert) is the epic's and
admin-assembly's action, tracked separately, not gating this record.**

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
| wroosbit | 7717 | `aff46dd28fb4fb3eafcbae4996fd6062e2831591` | `current` | not readable by this agent (see §5); TWO restarts, per BUTCHR-430's own journal capture (`journalctl --user -u butchr.service`, wroosbit's own daemon): (1) 07:36:47 PDT, pid 1280277 — `rules from .../resource-rules.json: 2 enabled (stories, subtasks)` and `build aff46dd2 ... pid=1280277` — on `aff46dd` WITHOUT the new rule; (2) 07:39:04 PDT, pid 1281685 — `rules from ...: 3 enabled (stories, subtasks, linked-eventing-verify-430)` — the restart that actually loaded it, after the rules file was edited in between (mtime 07:37) |

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

**Correction (BUTCHR-430's PR #403 review, from wroosbit's own journal
capture):** loaded at a SECOND, SEPARATE restart — not the same one that
brought wroosbit onto `aff46dd` as an earlier revision of this document
incorrectly stated. wroosbit's daemon restarted twice: first at 07:36:47
PDT (pid 1280277), which brought the daemon onto `aff46dd` but with the
rules file still at its pre-change 2-enabled-rule state (`stories`,
`subtasks`) — the rules file was only edited to append the new rule AFTER
this restart had already happened (mtime 07:37 PDT). A second restart at
07:39:04 PDT (pid 1281685) then picked up the edited file (3 enabled rules,
including `linked-eventing-verify-430`). Both restarts ran `aff46dd` code
throughout — the crash-hazard ordering that actually mattered (the code
must understand `linked*` fields before the rules file containing them is
ever read) was still respected; it just took two restarts rather than one
to get there.

Target tickets (created by the epic/director, not by this task's agent):
BUTCHR-441 (owner, Task, assigned to the director's account — deliberately
not Story/Sub-task and not either service account, so it cannot match
wroosbit's `stories`/`subtasks` rules) and BUTCHR-442 (linked to 441 via a
`Relates` issue link).

## 3. Step C — the real linked change: DONE (deviated from plan, harmlessly)

The epic made the change on BUTCHR-442 at **~08:51:07 PDT (15:51:07Z)**:
a **status TRANSITION, To Do → Done** — not the originally-planned summary
edit, because the epic has no summary-edit tool. This still satisfies the
ticket's own Step C wording ("a genuine field/status edit"). The edit also
slipped from the originally scheduled 08:41:30 PDT to ~08:51 PDT.

**Rate-cap complication actually encountered:** `maxLinkedTurnsPerHour: 2`
was exhausted by two REAL but UNINTENDED linked deliveries at 07:39:42 and
07:39:53 PDT, caused by BUTCHR-441's own description mentioning BUTCHR-430
and BUTCHR-421 (both under active discussion for this very verification).
The epic has no tool to edit a Jira issue description, so those mentions
could not be removed. A fixed silent-window schedule was used instead
(BUTCHR-430 comments 24095/24101): stay off BUTCHR-430/421 from window-free
until the edit, so the freed slot(s) aren't immediately re-consumed by
unrelated noise.

**Open, UNRESOLVED anomaly, recorded honestly rather than smoothed over:**
the two suppressed 07:40-07:48 changes were expected, per the module's own
design comment ("delayed, not lost — the next allowed tick re-runs the
exact same comparison... and re-derives the same outstanding diff"), to
redeliver as a coalesced catch-up once the rate window freed (~08:39:42/53
PDT). **No such catch-up ever appeared.** `[notify-suppressed] ... arm=
rate-capped` lines appear only 07:40:15-08:00:31, then stop entirely —
no more suppression lines, and no delivery, all the way through the 08:51
test. Traced from source (this task's agent): `baselines`/`watchSets`/
`unreadableOwners` in `src/jira-watch/linked-eventing.ts` have no TTL or
pruning; `SLIDING_WINDOW_MS` is a true `60 * 60_000`; the rate-capped
suppression line is logged unconditionally on every capped tick per
`suppressed-log.ts`'s own doc comment (no sampling). None of that explains
the stop. **This is a discrepancy between the module's own stated invariant
and observed behavior, not yet root-caused** — recommended as a follow-up
investigation (a candidate for `file_where_it_belongs`), not something this
record resolves. It does not change the PASS verdict below, because the
442 test delivery is independently identifiable by content and timing (see
next section) regardless of what happened to the unrelated 430/421
staleness.

## 4. Step D — exactly one turn for the BUTCHR-442 change, no duplicate: **PASS**

**Evidence sourcing, stated plainly:** all raw journal/transcript text below
was captured and pasted by BUTCHR-430 (whose own daemon IS wroosbit's,
pid 1281685) — this task's agent has no OS-level read access to wroosbit's
journal or config (`journalctl --user -u butchr.service -M wroosbit@` →
"Operation not permitted"; `/home/wroosbit/.config/butchr-new/` is mode
700, confirmed by this task's agent directly). **BUTCHR-430 is the only
source; no independent second source was obtained.** This task's agent's
own contribution is the source-level analysis and the grep-pattern/
attribution methodology, not the raw capture itself.

**Build/rule-load proof (captured by BUTCHR-430, 08:55:16 PDT):**
```
/health -> {"sha":"aff46dd28fb4fb3eafcbae4996fd6062e2831591","pid":1281685,"startedAt":"2026-09-25T14:39:05.612Z","currency":"current"}
Sep 25 07:39:05 servyboi bun[1281685]: butchr: rules from /home/wroosbit/.config/butchr-new/resource-rules.json: 3 enabled (stories, subtasks, linked-eventing-verify-430)
[linked-discovery] jira-work:linked-eventing-verify-430:BUTCHR-441 kind=issuelink target=BUTCHR-442 skipped=false
(plus kind=jira-key targets BUTCHR-430 and BUTCHR-421)
Sep 25 07:39:34 ... [spawn] jira-work:linked-eventing-verify-430:BUTCHR-441 succeeded — pane w39:p1 origin=spawn
```

**Every `[notify] ...linked-eventing-verify-430:BUTCHR-441` line for the
entire life of the rule (07:39 → 08:55:16 PDT), verbatim, per BUTCHR-430 —
"nothing else; no duplicates":**
```
07:39:42 ← BUTCHR-441 (linked:1): Claude channel attempted (Codex excluded), prompt delivered   [BUTCHR-430 (jira-key): updated]
07:39:53 ← BUTCHR-441 (linked:1): same text                                                     [BUTCHR-421 (jira-key): updated]
08:51:23 ← BUTCHR-441 (linked:1): same text   [enqueued 15:51:15.696Z: "BUTCHR-442 (issuelink): status changed from \"To Do\" to \"Done\""]   <- THE TEST
08:51:38 ← BUTCHR-441 (linked:1): same text   [enqueued 15:51:30.670Z: "BUTCHR-430 (jira-key): updated"]                                     <- NOISE (the epic's own report comment 24100 on BUTCHR-430, posted 08:51:18.6 PDT)
```
`[notify-suppressed] ... arm=rate-capped count=2 max=2` appears only
07:40:15-08:00:31; none after, and none around the 08:51 deliveries.
Journal timestamp trails the agent-side enqueue time by ~8s (processing
latency, not a duplicate).

**Exact grep pattern used:** `[notify] jira-work:linked-eventing-verify-430:BUTCHR-441 ← BUTCHR-441 (linked:` over the full life of the rule. **Count: 4 total, not 1** — but only ONE of the four is attributable to the BUTCHR-442 edit.

**Attribution method (why 08:51:23 is THE test and 08:51:38 is not), stated
because the log line structurally cannot name the changed item:** traced to
source — `deps.notify(m.agentKey, m.agentKey, {linked:{events}})` passes
BUTCHR-441's own agent key as BOTH the "issue" and "about" argument, so
`notifyRuleAgent`'s `aboutIssue = resourceKeyOf(about)` always decodes back
to BUTCHR-441, never the item that actually changed. Attribution is
therefore TEMPORAL, using the agent-side session transcript's own enqueue
timestamps (which DO carry the actual event description, from
`linkedChangeNudge`'s message text) rather than the journal line alone:
- The BUTCHR-442 status transition happened at 15:51:07Z (per the epic's
  own comment 24100). The 08:51:23 PDT delivery's agent-transcript payload,
  enqueued 15:51:15.696Z (~8.7s after the edit — consistent with one
  15s-cadence poll tick catching it), explicitly reads "BUTCHR-442
  (issuelink): status changed from "To Do" to "Done"". This is the test.
- The 08:51:38 PDT delivery, enqueued 15:51:30.670Z, explicitly reads
  "BUTCHR-430 (jira-key): updated" — caused by the epic's own comment 24100
  on BUTCHR-430 (posted 08:51:18.6 PDT, itself reporting the 442 edit) being
  picked up as a fresh linked change to 430. This is noise from the
  reporting process itself, not a second delivery of the 442 test, and is
  excluded from the pass/fail count for that reason — confirmed by content,
  not assumed by timing alone.

**Cadence:** the rule sets no `linkedPollIntervalMs`; the Jira-kind path
(covers a `Relates`/issuelink target) is not gated by it at all — it runs
on the ordinary jira-work resource-loop tick, hard-coded
`intervalMs: 15_000` in `src/daemon/index.ts`, identical on both daemons
(same build). Observed ~8-16s delivery latency after each real change
matches this exactly.

**No-duplicate check:** quiet interval 08:51:38 → 08:55:16 (BUTCHR-430's
capture time) with no further `[notify]` or `[notify-suppressed]` for this
agent — well over one further full poll interval (~14+ ticks at 15s
cadence).

**PASS/FAIL statement:** exactly ONE `[notify] ... (linked:1)` delivery is
attributable to the BUTCHR-442 change (08:51:23 PDT, content-matched to the
edit), with no duplicate of it over a further multi-minute window. **A FAIL
would have looked like:** zero deliveries in the post-edit window (mechanism
didn't fire), or two-or-more deliveries whose transcript content BOTH
reference the BUTCHR-442 change (a real duplicate, as opposed to the
442-unrelated 08:51:38 noise actually observed). Neither fail condition is
present. **PASS.**

## 5. Step E — no-regression on BUTCHR-441's own change: **PASS**

Cause: a comment posted directly on BUTCHR-441 itself at 2026-09-25T15:56:57.875Z
(08:56:57.875 PDT) — not on 430/421/442 (per the epic's comment 24104 on
BUTCHR-430). Captured by BUTCHR-430 at 08:57:28 and 09:00:07 PDT (again, the
only source).

**The only `[notify] ...linked-eventing-verify-430:BUTCHR-441` line since
08:56:00, verbatim:**
```
Sep 25 08:57:09 servyboi bun[1281685]:   [notify] jira-work:linked-eventing-verify-430:BUTCHR-441 ← BUTCHR-441 (reason: not determinable — comments not checked this poll): Claude channel attempted (Codex excluded), prompt delivered
```
This is a NON-`linked:` reason shape — the ordinary own-ticket path,
unchanged from pre-epic behavior — delivered ~11s after the change.
Agent-side transcript: enqueued 15:57:01.641Z (~3.8s after the change),
`<channel source="butchr" issue="BUTCHR-441">` message plus a plain-text
copy at 15:57:03.367Z, two acknowledgements ("Nudge received" /
"Nudge received again") — the SAME one-notify/two-acknowledgement shape as
the linked deliveries (see below).

**Quiet interval:** 08:57:09 → 09:00:07 PDT, exactly one own-change
`[notify]`, no duplicate — well over one further poll interval.

**Cap independence, confirmed both from source and empirically:** this
delivery went out cleanly while the linked rate cap was still 2/2 (used by
the two 08:51 deliveries above) — `[notify-suppressed] ... arm=rate-capped
count=2 max=2` lines continued at 08:56:15/30/45, 08:57:15 and two more
before 09:00:07, caused by pending (unrelated) BUTCHR-430 activity, and were
suppressed as expected. Traced to source: `maxLinkedTurnsPerHour` is
enforced entirely inside `createLinkedEventingState().runTick()`, which is
invoked only for the `{linked:...}` notify shape; ordinary own-ticket-change
detection is a separate, pre-existing code path (`notifyRuleAgent` called
directly with a non-`linked` reason) that never touches the linked-eventing
rate-cap counter. The empirical evidence and the source agree: **the
linked-eventing rate cap does not gate, and was not intended to gate, the
ordinary own-change notify path. No regression. PASS.**

## 5a. Incidental finding: the "two acknowledgements per notify" shape is pre-existing, not linked-eventing's

Both the 08:51:23 linked delivery and the 08:57:09 own-change delivery
produced, on the agent side, ONE `<channel source="butchr">` message plus
one plain-text copy of the same content, and two acknowledgement responses
with two separate `turn_duration` entries. Traced to source:
`notifyRuleAgent` (`src/daemon/index.ts`) always performs TWO pushes per
call, regardless of `reason` — `notifyAgent(mcp, agent, aboutIssue, msg)`
(an MCP `sendAll` push; this is the `<channel>` block) and, separately,
`herd.nudge(agent, msg)` (a direct pane-write of the same text as a plain
prompt) — while logging exactly ONE `[notify]` line either way. This is
long-standing, pre-existing dual-delivery behavior, unrelated to and
unmodified by this epic; confirmed both from source and from this task
agent's own first-hand experience receiving butchr notifications throughout
this very verification (every one arrived the same dual-channel way).
**"Exactly one turn" is therefore correctly measured as exactly one
`[notify]` journal line / one `deps.notify` call — not as "exactly one
agent-visible message"; two agent-visible artifacts per single logical
notify is normal and expected, not evidence of a duplicate.** The epic
ruled on exactly this reading (BUTCHR-430 comment 24104): "exactly one
notify/delivery" is the accepted definition of "exactly one turn" for this
verification's own acceptance criteria.

## 6. Step F — revert: PENDING (not this task's action)

Fast/no-restart revert: delete BUTCHR-441 (its query then matches nothing,
the agent stops). Full clean revert: remove the rule object from wroosbit's
rules file and restart wroosbit's daemon. Both go through the epic and
admin-assembly, not this task's agent — tracked on BUTCHR-421/430, not
gating this record or this PR. Final cleanup: delete BUTCHR-441 and
BUTCHR-442.

## 7. Honesty statement

Steps A, B, D and E are PASS, independently reasoned about by this task's
agent from primary evidence, though the raw journal capture for Steps D/E
came from a single source (BUTCHR-430) that this task's agent could not
independently corroborate (documented access limitation, not an oversight).
Step C happened but deviated from the original plan (status transition
instead of summary edit; ~10 minutes later than scheduled) — recorded
honestly rather than glossed over. One genuine anomaly (the missing 430/421
catch-up delivery, §3) is flagged as unresolved and recommended for
separate follow-up, since it does not change this record's own pass/fail
verdicts but should not be silently dropped either. Step F (revert) has not
happened as of this PR and is explicitly not this task's action to take.
