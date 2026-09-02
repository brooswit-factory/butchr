# The tier-to-identity mapping: the DECISION

**Decided 2026-09-02, by BUTCHR-125 (Task tier), for BUTCHR-104 (Story tier) /
BUTCHR-100 (Epic tier — "The fleet's identity model").**

**A fresh measurement beats this page.** This document states a decision and
its residue as of the date above; the facts it is built on — account
assignments, role-map contents, open-PR state — are deployment configuration
and drift independently of any code change. Re-run the checks named inline
before trusting a row here.

**This document's companion is [`docs/identity-model.md`](./identity-model.md)**,
BUTCHR-99/BUTCHR-106's *measurement* record — dated per-claim, "measured, when,
from where." This page is a different genre: a *decision*, dated as a whole,
with costs and residue attached. Where this page states a fact also stated
there, it is a re-verification, not a duplication, and every re-check below
came out consistent with that file — no disagreement is being silently
overwritten here. `docs/identity-model.md` now points back at this page (see
its final section).

---

## 0. Re-verification this page is built on (2026-09-02, this session)

Same method as `docs/identity-model.md` D2: compare `assignee.accountId` of
the boss ticket against `assignee.accountId` of the worker ticket, read fresh
with `jira_get_issue` (never `jira_search` — it omits issue links and
priority entirely).

*Falsification, stated in advance:* an equal accountId on any "cross-account"
row below, or an unequal accountId on the "same-account" row, would refute
the inventory this decision is built on. None of that was found.

| ticket | type | creator | assignee |
|---|---|---|---|
| `BUTCHR-100` | Epic | `e160cf60` ("boos writ", project tier) | `619ec5ec` ("Wroos Bit") |
| `BUTCHR-104` | Story | `619ec5ec` (BUTCHR-100, its Epic) | `e160cf60` |
| `BUTCHR-125` (this ticket) | Task | `e160cf60` (BUTCHR-104, its Story) | `619ec5ec` |
| `BUTCHR-62` | Epic | (human filer) | `619ec5ec` |
| `BUTCHR-96` | Task, adopted by `BUTCHR-62` | `e160cf60` (BUTCHR-68, its original filer) | `619ec5ec` |

- project → epic: `e160cf60` → `619ec5ec` — **cross-account**, re-confirmed.
- epic → story: `619ec5ec` → `e160cf60` — **cross-account**, re-confirmed.
- story → task: `e160cf60` → `619ec5ec` — **cross-account**, re-confirmed
  (this is my own ticket).
- epic → task (`BUTCHR-62` → `BUTCHR-96`, the real `adopt_worker` shortcut):
  `619ec5ec` → `619ec5ec` — **same-account**, re-confirmed on the same real
  ticket pair `docs/identity-model.md` cites (not a fresh instance — none has
  occurred since; re-reading the same pair is still a live check, since
  either accountId could in principle have been reassigned since).

**GitHub-layer positive confirmation, now closed out** — `docs/identity-model.md`
left one cell explicitly open ("the definitive end-to-end positive
confirmation is an accepted APPROVE… pending"). Re-checked this session:
`gh pr view 172 --json reviewDecision,reviews` → `reviewDecision: APPROVED`,
with `booswrit` recorded as both `CHANGES_REQUESTED` (twice) and, finally,
`APPROVED` on a `wroosbit`-authored PR. Story→Task now has both a live
`REQUEST_CHANGES` and a live `APPROVE` from the cross-account reviewer,
first-hand. `gh pr view 170 --json reviewDecision,state` still shows
`reviewDecision: ""` on a merged PR — consistent with the self-review refusal
already on record (no formal GitHub review was ever recordable there; the
Jira `[review]` comment is the only durable verdict, per BUTCHR-96's own
ticket history).

**Mechanism, re-confirmed by reading the code in this checkout** (grep the
symbols yourself rather than trusting a line number from this page — they
move):

- `adoptWorker`'s non-project path (`src/tools/relationship.ts`, inside
  `adoptWorker`) resolves the role as
  `issuetype === "Story" ? roles.story : roles.task` — a pure function of the
  **adopted ticket's own type**. It does not read `callerKey` for anything
  except confirming the adopted ticket isn't already someone else's worker.
  There is no tier-based gating on `adopt_worker` at all — `requireCaller`
  gates only three verbs by caller shape (`submit_to_boss`,
  `finish_without_a_boss`, `file_where_it_belongs`), named explicitly in its
  own comment; `adopt_worker` is not one of them.
- `newWorker`'s child-type map (`CHILD_TYPE` in the same file) is
  `{ Epic: "Story", Story: "Task" }`. **An Epic's own `new_worker` call can
  never produce a Task.** The only route by which an Epic ever becomes a
  Task's boss is `adopt_worker` on an existing (orphan) Task.
- The same file's idempotency check inside `adoptWorker`
  (`assignedCorrectly = assigneeAccountIdOf(issue) === role`) compares the
  ticket's current assignee against that same type-derived constant — it is
  built on the same "identity is a pure function of issuetype" premise, and
  is one of the things Deliverable 2 below identifies as needing to change
  under Direction B.

---

## 1. The triangle argument — CONFIRMED

Modeling `{project, epic, story, task}` as vertices and each real review hop
as an edge forbidding shared accounts, the minimum account count is the
graph's chromatic number. The three chain hops (`project–epic`,
`epic–story`, `story–task`) form a path, which is 2-colourable — and that is
exactly what is deployed: `project`/`story` = `e160cf60`, `epic`/`task` =
`619ec5ec`, alternating. The three chain hops are cross-account **by
construction of that alternation**, not by three independent lucky draws.

**The load-bearing premise, named before any count is cited: is the
`adopt_worker` shortcut edge (`epic–task`) depended-upon, or merely
permitted?** If merely permitted, the graph collapses to the 2-colourable
path and 2 accounts are provably sufficient — which is exactly what is
deployed today. If depended-upon, `epic`, `story`, and `task` become
pairwise-adjacent (`epic–story` and `story–task` from the chain,
`epic–task` from the shortcut) — a triangle, chromatic number 3, and 2
accounts are provably insufficient under *any* allocation.

**I rely on the "depended-upon" premise, for two independent reasons, one
structural and one empirical — re-verified this session, not merely cited:**

1. **Structural**: since `new_worker` from an Epic can only ever produce a
   Story (`CHILD_TYPE.Epic === "Story"`, confirmed above), `adopt_worker` on
   an orphan Task is not one of several ways an Epic acquires a Task — it is
   the *only* way. If an Epic can acquire a Task worker at all, this is the
   one and only path it uses.
2. **Empirical**: `BUTCHR-96` (a real orphan Task, filed by `BUTCHR-68`) was
   adopted by `BUTCHR-62` (a real Epic) "in the ordinary course of clearing
   orphans," per that ticket's own history — re-read this session, not
   inferred. It produced a real PR (#170) and a real, production
   `gh pr review --approve` refusal ("Can not approve your own pull
   request"). Nothing about that sequence used an unusual or discouraged
   code path; an orphan Task existing at a moment when only Epic-tier agents
   are free to adopt it is an ordinary scheduling fact of this fleet, not a
   contrived edge case manufactured to make a point.

**A third reason, arriving after this section was first drafted, and
stronger than either of the first two: this is no longer a single
occurrence.** `BUTCHR-115` (a real Epic, `619ec5ec`) adopted `BUTCHR-105` (a
real orphan Task, also `619ec5ec` once staffed) today, 2026-09-02, in the
identical "fix this before granting a permission" ordinary course — producing
PR #178 and the identical live refusal, `gh pr review --approve` → "Can not
approve your own pull request." Re-confirmed this session: `BUTCHR-105`'s
assignee is `619ec5ec`, its boss link is to `BUTCHR-115` (Epic, also
`619ec5ec`). **Two independent occurrences, different epics, different
workers, same collision, same refusal text, hours apart.** A premise this
document is attacking ("is the shortcut ordinary, or contrived?") is much
harder to sustain against two independent live instances than one — this is
evidence about exactly the premise Deliverable 1 turns on, not decoration.

**Conclusion: the triangle is CONFIRMED.** `epic ≠ task` is a constraint the
fleet depends on, `{epic, story, task}` are pairwise-adjacent, and the
fleet's current 2-account deployment is provably insufficient to cover all
three simultaneously — which is exactly what the epic→task row above shows,
live, twice.

*Falsification, stated in advance and still open:* this premise would be
refuted by a future code change that makes `adopt_worker` refuse cross-tier
adoption (making the shortcut structurally unreachable, not merely
undesirable), or by a demonstration that Epic-tier agents never actually
receive orphan Tasks to adopt in this fleet's real scheduling (contradicted
today by `BUTCHR-96`). Watch for either before re-citing "3" from this page.

Including `project`: it is pairwise-adjacent to `epic` only on current
evidence — `adoptProjectWorker`'s own code (confirmed by reading it this
session) refuses any adopted type but `Epic` for a project caller, so a
`project–story` or `project–task` edge is foreclosed by code, not merely
unobserved. `project` does not raise the chromatic number past 3: it can
reuse `epic`'s off-triangle colour (`story`'s account, or a distinct one),
exactly as it already does today (`project` and `story` both `e160cf60`).

---

## 2. The recommended mapping, with its residue named

Two directions were on the table; a third was invited. I recommend
**Direction B — staff by hop, not by type** — over Direction A, and reconcile
this recommendation against `.env.example`'s merged (Direction A) guidance
in §4.

### Direction A — add a third identity (rejected as the primary recommendation, see below)

**What it does:** set `BUTCHR_ASSIGNEE_EPIC`, on the daemon serving the
project tier, to a fourth Atlassian accountId distinct from
`BUTCHR_ASSIGNEE_STORY`, `BUTCHR_ASSIGNEE_TASK`, and that daemon's own
project-lead identity. No code change; no tool behaviour changes.

**What it fixes:** epic→task becomes cross-account by construction — the
one row that is same-account today.

**What it does NOT fix — the residue, stated plainly:** same-issuetype peer
adoption (`story ≠ story`, `task ≠ task`). `adopt_worker`'s non-project path
assigns the adopted ticket by **its own type**, full stop, regardless of who
the adopting caller is. A Story adopting an orphan Story always resolves the
orphan to `roles.story` — the adopting Story's own account, by definition,
since both are Stories. **No number of type-keyed accounts closes this gap,
because a role always agrees with its own tier's account.** This is not
observed on a real ticket yet (recorded as not-currently-reachable in
practice, not given an invented live verdict), but it is reachable today
with no code change, by the same `adopt_worker` call already in ordinary
use.

**Cost:** one new Atlassian account, one operator action (see §4), zero code
risk.

### Direction B — staff by hop, not by type (RECOMMENDED)

**What it does:** change `adopt_worker`'s (and `new_worker`'s) role
resolution from a pure function of the ticket's own issuetype to a function
that also depends on the calling boss's own account — concretely, in a
2-account pool, assign the adopted/created ticket to **whichever of the
fleet's two configured accounts the caller is not.** Today's `roles.story`
and `roles.task` already resolve into the same 2-account pool
(`e160cf60`/`619ec5ec`), so for the *current* deployment this is a
resolution-order change, not a new configuration surface.

**What it fixes — all of it, not just the observed collision:**

- epic→task: the adopted Task's account becomes "not the epic caller's own
  account" — `619ec5ec` (today's epic account) ≠ its own value, so the
  adopted Task lands on `e160cf60` instead. Cross-account by construction.
- **story→story and task→task — the residue Direction A cannot touch at
  all.** Because the rule keys on the *caller's* account rather than the
  *ticket's* type, a Story (account `e160cf60`) adopting an orphan Story no
  longer resolves the orphan to `roles.story` (`e160cf60`, same as the
  caller) — it resolves to "not `e160cf60`," i.e. `619ec5ec`. Cross-account
  by construction, for the first time. **This is the one property Direction
  A structurally cannot deliver at any account count, and it is why I
  recommend B over A** despite B's larger code footprint.
- The three existing chain hops and project→epic are unaffected: each
  already resolves to "the account that differs from its boss," so B
  reproduces today's live values exactly for those four hops.

**Cost — named in full, not asserted away:**

1. Code changes to `adoptWorker`'s and `newWorker`'s role-resolution logic
   (`src/tools/relationship.ts`, the `roles.story`/`roles.task` lines inside
   each), and the project-caller paths (`newProjectWorker`,
   `adoptProjectWorker`) separately — the project caller's own "account" is
   this daemon's own Atlassian credential, not a member of the
   STORY/TASK/EPIC pool, so it needs its own resolution rule, not a drop-in
   reuse of the issue-caller logic.
2. The idempotency check inside `adoptWorker`
   (`assignedCorrectly = assigneeAccountIdOf(issue) === role`, confirmed at
   §0 above) compares against the same value being changed — it must be
   updated in the same change, or a re-adoption call will see a mismatch
   against its OLD expectation and re-write an assignment that was already
   correct under the new rule.
3. **Two other call sites still key on type alone, and updating them is NOT
   included in this recommendation — they are named as residue of the
   recommendation, for whoever implements it to decide:** `jira_create_issue`'s
   legacy ASSIGNMENT rule (`src/tools/defs.ts`, `p.issuetype === "Story" ?
   roles.story : roles.task`) and `file_where_it_belongs`
   (`src/tools/relationship.ts`, the identical pattern). Both are
   "DEPRECATED … RETAINED PERMANENTLY, no deprecation clock" per this
   codebase's own alias policy (`atlassianTools`'s doc comment) — they are
   not going away on their own. Left unchanged, a ticket staffed through
   either of these two verbs would land on the OLD type-keyed account,
   inconsistent with `new_worker`/`adopt_worker`'s new caller-relative rule
   — silently reopening the exact class of gap this document exists to
   close, for exactly those two paths. Whoever implements B must decide
   whether to update these two in the same change or document them as
   deliberate exceptions; this document does not decide it.
4. **Does not generalise past 2 accounts without further design.** "The
   account that differs from the caller" is unambiguous only when the pool
   has exactly two members. If a third account is ever added to this pool
   (including, ironically, if Direction A's epic account were layered on
   top), B needs a real per-hop assignment policy — a fixed rotation, or an
   explicit hop→account table — not "the other one," which becomes
   ambiguous. Not a blocker today; a trap for whoever revisits this once the
   fleet grows past two identities.
5. This is a change to a "documented, load-bearing staffing rule"
   (`jira_create_issue`'s own tool description currently states "a Story or
   a Task is assigned BY ROLE from its issuetype") — the operator-facing
   documentation of that rule needs updating alongside the code, which is a
   more visible change than Direction A's config-only fix.

**Residue after B, given costs 1–3 above are carried through:** none among
the five hops this document tracks. If cost #3 is left undone (the two
legacy verbs untouched), the residue is exactly "any ticket staffed through
`jira_create_issue` or `file_where_it_belongs` instead of
`new_worker`/`adopt_worker`" — narrower than today's residue, but not zero,
and worth stating rather than assuming away.

### Why B over A, stated as a decision rather than a preference

Direction A is lower-risk (no code, already drafted into `.env.example`'s
incoming guidance — see §4 for that conflict) but caps out at fixing one row
of five and *cannot*, at any account count, fix the other two
(`story ≠ story`, `task ≠ task`) — the ticket that convened this decision is
explicit that a recommendation which doesn't name that is "a preference, not
a decision." Direction B costs a real code change and leaves two legacy
verbs as named residue if not also updated, but is the only direction on the
table that closes the peer-adoption gap at all, at zero new accounts. Given
this epic's stated generalisation — *"An identity model is not a mapping of
tiers to accounts. It is a mapping of tiers to accounts that can do what
that tier does"* — the type-keyed premise A leaves standing is the same
premise that produced today's gap; B removes it instead of adding an account
around it.

### Workarounds already rejected — not new here, restated for completeness

- **Approving from the other account's credentials** — manufactures a
  second identity that does not exist, defeating the point of the
  separation. Still rejected.
- **Recording the verdict only as a PR comment** — honest, and already this
  fleet's fallback for the one hop that cannot be fixed today (BUTCHR-96's
  `[review]` Jira line), but produces no GitHub approval, so branch
  protection and anything keyed on `reviewDecision` sees an unreviewed PR.
  Not a substitute for a real fix, still just the honest fallback.
- **Refusing to adopt Tasks (or Stories) at all** — recreates the orphan
  problem `adopt_worker` exists to solve, and no agent in this fleet may
  change a role variable, so a refusal its recipient cannot act on is a
  wall, not a guard (BUTCHR-103's framing, still correct).

---

## 3. The capability half — per tier, MEASURED / CITED / INFERRED

*An identity model is not a mapping of tiers to accounts. It is a mapping of
tiers to accounts that can do what that tier does.* Nothing today verifies
the second half at spawn or startup — stated plainly, see the close of this
section.

| tier | account | load-bearing capability | status | vantage |
|---|---|---|---|---|
| **Task** (me, `BUTCHR-125`) | `619ec5ec` | push a branch; open a PR; comment on own ticket; transition own ticket; write own Confluence doc | **MEASURED, this session** — see the list below, each one an actual call made in the ordinary course of this ticket, not a synthetic probe | first-hand |
| **Epic** (`BUTCHR-100`, today) | `619ec5ec` — **the same account as Task, today** | staff a Story via `new_worker`; review/approve a Story's PR; approve/merge its own worker's Task PR (the collision this document is about) | Covered by my own Task-tier probe today **only because of the collision** — not a separate measurement. **This convenience is itself an artefact of the same-account gap, and stops being true the instant either recommendation in §2 is applied**: once Epic and Task are cross-account (Direction A or B), a Task-tier probe no longer says anything about the Epic account, and this row goes back to needing its own first-hand measurement. That sentence matters more than the row. | first-hand today, non-transferable |
| **Story** (`BUTCHR-104`) | `e160cf60` | Jira create+assign+link+transition+Confluence-page-create (one `new_worker` call, staffing this ticket); `gh api user`; `git push -u` | **MEASURED by BUTCHR-104**, in its own session, ordinary course of staffing this ticket — all succeeded per its own report. The GitHub approve-and-merge capability on this ticket's own PR is exercised at review time; BUTCHR-104 reports that outcome on this ticket via `tell_worker` either way, not yet known as of this writing. | CITED here, first-hand at the source |
| **Project** (`BUTCHR`, project lead) | `e160cf60` | `check_in()` → `advanceProjectWatermark` (`src/resources/project.ts`) → a Jira **project property** write via `ops.setProjectProperty`, which requires Jira's "Administer Projects" permission — a mechanism and a required permission, stated to survive the internals moving, not pinned to one revision | **REFUSED**: `403 Forbidden — "You cannot edit the configuration of this project."` Project lead does not confer Jira "Administer Projects." Out of my reach to probe — not my account. Per this ticket's own scope, I am not acting on this 403, not recommending its resolution, and not treating it as a precondition for anything above. The defect the 403 masked (a fail-open read spread as the base of that same full-value replace) was BUTCHR-105/PR #178, which **has merged** into this branch — confirmed this session by grepping this checkout: `advanceProjectWatermark` now reads via `getProjectPropertyOrNull` rather than a bare `.catch()`. That fix changes what happens if the write is ever reached; it does not touch the 403 itself, and does not change the capability-gap finding — the write path and its required permission are exactly as stated in this row, before and after #178. | CITED from the project tier's own report on `BUTCHR-100` |

**My own Task-tier measurements, this session, each a real call made in the
ordinary course of doing this ticket, not a synthetic test:**

- `git push -u origin BUTCHR-125` — succeeded (see §5/PR link below).
- Opened this ticket's PR via `gh pr create` — succeeded.
- `report_to_boss` (a comment on my own ticket, `BUTCHR-125`) — succeeded,
  same channel this decision is reported through.
- `submit_to_boss` (transition `BUTCHR-125` → In Review) — succeeded, the
  final act of this ticket.
- `set_doc` on my own Confluence page, retitled off its `[unwritten]`
  marker — succeeded (this ticket's DoD item 7).

**Nothing today verifies any row of this table at spawn or startup.** Both
of this epic's central findings — the epic↔task account collision (§1–2) and
the project tier's capability gap (this section) — would have been caught
before any work was done if something did. **Whether to build such a check
is not this ticket's call**; it is named here as a candidate for BUTCHR-100
to route, not built. (BUTCHR-103/BUTCHR-110, merged separately — see §4 —
already builds an *identity*-collision check at staffing time; it does not
check capability, only account equality, and is not being duplicated here.)

---

## 4. The operator-executable change proposal

**This is a proposal. Nothing in this section has been executed. No
`BUTCHR_ASSIGNEE_*` value, account, or permission has been changed, created,
or granted by this ticket.**

### How this reads against `.env.example`, now that #177 has merged and this story owns the block

PR #177 (`BUTCHR-103`/`BUTCHR-110`) **merged** 2026-09-02T08:03:38Z (verified
this session: `gh pr view 177 --json state,mergedAt`). It rewrote the
`.env.example` `BUTCHR_ASSIGNEE_EPIC` guidance block to state the full
constraint set (must differ from project-lead, from `BUTCHR_ASSIGNEE_STORY`,
and from `BUTCHR_ASSIGNEE_TASK`) and directs an operator to "pick a fourth,
genuinely distinct Atlassian accountId" — **Direction A**, and, as landed,
still without naming the peer-adoption residue.

**BUTCHR-100 ruled on this explicitly** (relayed via `BUTCHR-104`): #177's
text is correct for the code that exists today, merges as-is, and is
*incomplete* rather than wrong — and **this story owns completing that
block.** Per that ruling, this ticket's own PR (into `BUTCHR-104`) adds a
paragraph directly under `.env.example`'s `BUTCHR_ASSIGNEE_EPIC` guidance —
appended after BUTCHR-110's text, not editing it — stating: (a) the residue
Direction A cannot close (same-issuetype peer adoption, at any account
count) exactly as §2 states it, and (b) that this document recommends
Direction B instead, which that file's constraint-set language cannot
express (it only ever configures type-keyed accounts), and points here for
the full accounting. The same PR also adds a staffing-time and startup-time
identity-**collision** report (record, never refuse) — a different
mechanism than what §3 says is missing (that check verifies account
*equality*, not account *capability*).

The proposal below is written both ways — B (my recommendation) and A (what
`.env.example` already says, now completed rather than contradicted) —
because an operator may reasonably apply
A first as the immediate, zero-code fix for the one collision that has
actually broken a live review, while B is implemented and reviewed
separately.

### Direction A (config-only, matches `.env.example`'s merged guidance)

1. **Variable:** `BUTCHR_ASSIGNEE_EPIC`.
2. **Which daemon:** the daemon that serves the **project tier's** own
   `new_worker`/`adopt_worker` calls for Epics — this is the daemon that
   actually stamps a new Epic's account, per the mechanism `docs/identity-model.md`
   establishes (staffing time, boss's daemon, not the ticket's own later
   daemon). `docs/identity-model.md` D1/H2 identifies this, at the time of
   its own measurement, as the daemon owned by Unix user `booswrit`
   (port `7718`) — **CITED from that document, not measured by me; I run on
   the other daemon (`wroosbit`, port `7717`) and cannot read `booswrit`'s
   process. Confirm this is still the daemon serving the project tier from
   your own vantage before acting** — `ps -eo pid,user,args | grep 'bun run
   src/daemon'` cross-referenced against which Unix user's workspace is
   running the live `BUTCHR` (project) agent, exactly as `docs/identity-model.md`
   §D1/H2 did.
   Setting this on `wroosbit`'s daemon (mine) would have **no effect**: that
   daemon has never been observed serving a project caller, and this
   variable is only read at Epic-staffing time by whichever daemon a project
   caller's `new_worker`/`adopt_worker` call actually lands on.
3. **To which value:** a new Atlassian accountId, distinct from
   `BUTCHR_ASSIGNEE_STORY` (`712020:e160cf60-...`), `BUTCHR_ASSIGNEE_TASK`
   (`712020:619ec5ec-...`), and that daemon's own project-lead identity
   (currently `e160cf60` also — see §0/§3). **I am not inventing this
   accountId**; it must be a genuinely new Atlassian account the operator
   creates or already holds, distinct from all three.
4. **Order:**
   a. Confirm no `new_worker`/`adopt_worker`(Epic) call, and no
      project-tier review action (`finish_worker`/`tell_worker` on a live
      Epic PR), is in flight on the target daemon — see the change-window
      hazard below for why.
   b. Set `BUTCHR_ASSIGNEE_EPIC` to the new accountId in that daemon's env
      source (`.env` or equivalent).
   c. Restart that daemon's `butchr.service` user unit (as the `booswrit`
      Unix user, or whichever user is confirmed in step 2):
      `systemctl --user restart butchr.service`.
   d. Verify (below).
5. **Verify, with the check and its failure condition stated:**
   - **Env check** (as the daemon's own Unix user, immediately after
     restart): `tr '\0' '\n' < /proc/<new-pid>/environ | grep
     BUTCHR_ASSIGNEE_EPIC` must show the new accountId. *Fails if*: the line
     is absent, or still shows the old value — means the restart did not
     pick up the new `.env`, or the wrong daemon was restarted.
   - **Functional check**: the next Epic actually staffed (created or
     adopted) by the project tier after this restart — read its
     `assignee.accountId` via `jira_get_issue`. *Fails if*: it still equals
     `619ec5ec` (Task's account) or `e160cf60` (Story/project's account) —
     means the env change did not reach the code path that staffs Epics
     (stale process, or the wrong daemon).
   - **End-to-end check, not to be forced**: the next real `adopt_worker`
     call where an Epic adopts an orphan Task should show the Epic's and
     Task's accounts differing, and (in the ordinary course of that Epic
     later reviewing that Task's PR) a real GitHub approval should succeed
     where it would previously have been refused. Per this document's own
     §0 caution (and `docs/identity-model.md`'s own stated policy), **do not
     manufacture this by adopting a real, unreviewed ticket purely to test
     it** — let it happen in the ordinary course and record the outcome
     when it does.

**What breaks in the wrong order, stated explicitly:** `new_worker`'s
four-step create/link/disposition/doc sequence (`src/tools/relationship.ts`)
runs inside a single process; killing that process mid-sequence (by
restarting the daemon while a call is in flight) can leave a ticket created
but not linked, or linked but not transitioned — an inconsistent state the
function's own rollback logic cannot fully protect against once the process
executing it is gone, per its own doc comment's stated failure modes.
Similarly, a project-tier `finish_worker`/`tell_worker` approving a live
Epic PR mid-restart drops that in-flight MCP call. Restarting during a quiet
window (step 4a) is not optional ceremony — it is what keeps this a
zero-downtime config change instead of a corrupted mid-write.

### Direction B (code change — sketch only; the actual patch is a separate, reviewed change, not this document)

1. **What changes, where:** `adoptWorker`/`newWorker`'s role resolution
   (`src/tools/relationship.ts`) and the idempotency check inside
   `adoptWorker` (same file) — see §2 for the full list of call sites and
   the two legacy verbs named as residue.
2. **No `BUTCHR_ASSIGNEE_*` variable changes** — B is a code change to
   *resolution logic*, not a new config value. The existing
   `BUTCHR_ASSIGNEE_STORY`/`BUTCHR_ASSIGNEE_TASK` values are reused as the
   2-member pool B resolves against.
3. **Order:** implement, review, merge, deploy to both daemons (the change
   is in shared code, so both `wroosbit`'s and `booswrit`'s daemons pick it
   up on their next restart/deploy — no daemon-specific env edit is
   involved, unlike Direction A).
4. **Verify:** the next `adopt_worker` call on a same-issuetype orphan
   (Story-adopts-Story or Task-adopts-Task) — currently not observed on any
   real ticket — should show the adopted ticket's account differing from
   the adopting caller's. *Fails if*: it still matches, meaning the new
   resolution logic did not actually change the assignment for that path.
5. Precise before/after values for existing hops (to confirm no regression):
   re-run the §0 table after deploying B; every row currently cross-account
   must remain cross-account, and the epic→task row must flip from
   same-account to cross-account.

This sketch is offered so BUTCHR-100 can route it as a concrete follow-up if
Direction B is accepted; **it is not a patch, and this ticket does not
implement it.**

---

## 5. Every hop's final status

| hop | today (measured, §0) | status |
|---|---|---|
| project → epic | cross-account (`e160cf60` ≠ `619ec5ec`) | **Cross-account by design.** Deployed as one half of the 2-colour alternation over the chain path. Acceptable as-is: no recommendation in this document changes it. Would become unacceptable if a future `adopt_worker`/`new_worker` change ever let a project-tier call land an Epic on the project's own credential — nothing today does. |
| epic → story | cross-account (`619ec5ec` ≠ `e160cf60`) | **Cross-account by design.** Same alternation. Acceptable as-is, unaffected by either recommended direction. |
| story → task | cross-account (`e160cf60` ≠ `619ec5ec`), live-confirmed at the GitHub layer for both `CHANGES_REQUESTED` and, as of this session's re-check, `APPROVED` (PR #172) | **Cross-account by design, and the strongest-evidenced row in this table.** Acceptable as-is. |
| epic → task (the `adopt_worker` shortcut) | **same-account** (`619ec5ec` = `619ec5ec`), real, live, **twice**: `BUTCHR-62`/`BUTCHR-96`/PR #170, and `BUTCHR-115`/`BUTCHR-105`/PR #178 | **Not acceptable as a permanent status quo.** As of `BUTCHR-103`/`BUTCHR-110` (PR #177, merged), the collision is no longer silent — it is recorded loudly (result field, audit line, ticket comment) at the moment of staffing — but it is still **unresolved**: the review hop still cannot produce a real GitHub approval. The record-of-review procedure for this hop while it stays unresolved is §6. A recommended fix is named in §2/§4 (Direction B, or A as an interim); it is acceptable to leave unresolved only until one of those is executed, and becomes unacceptable the moment a real Epic-tier review is blocked on it again without an operator having acted. |
| story → story, task → task (peer adoption) | same-account by construction under the current type-keyed rule; not observed on a real ticket, reachable today with no code change | **Not acceptable as a permanent status quo, and the sharper of the two gaps**: unlike epic→task, **no account addition (Direction A) can ever close this row**, at any account count — the type-keyed rule guarantees it. It is acceptable to leave it exactly as long as it is *named*, as it now is here, and unacceptable the moment a real Story-adopts-Story or Task-adopts-Task ticket surfaces this in production without Direction B (or an equivalent caller-aware rule) already having been decided on. Record-of-review procedure while unresolved: §6, same as epic→task. |

**Every row above that is not "cross-account by design" is a collapsed
hop, and §6 below states what its record of review looks like and how a
later reader tells it apart from an unreviewed merge — required next to
this table, not an afterthought.**

---

## 6. What a collapsed hop leaves behind, so a later reader can tell

There is no branch protection on `main`. A PR on a collapsed hop reports
`MERGEABLE` and merges with `reviewDecision: ""` — **identical, after the
fact, to a PR nobody thought to review.** "Known, documented, and
deliberately accepted" is not satisfied if the acceptance leaves no trace a
later reader can find. This section names the materials that already exist
for this; **nothing here is built by this ticket.**

For **every hop this document records as collapsed or deliberately
accepted** — today, epic→task, and structurally, same-issuetype peer
adoption — the record of review is, and should be documented as, exactly
these three artefacts, all of which already exist and none of which this
ticket adds code for:

1. **BUTCHR-103/BUTCHR-110's shipped staffing-time check (PR #177, merged)**
   writes a durable comment on the worker's own ticket, and an `IDENTITY
   COLLISION:` audit line on the daemon's log, at the moment a collision is
   staffed — automatically, before any review is attempted. That comment is
   the first marker: it exists whether or not anyone later tries to review
   the PR, so its presence on a ticket is itself evidence the collision was
   caught at staffing time, not missed.
2. **The `[review] APPROVED/CHANGES_REQUESTED <pr-url> @ <sha>` line on the
   worker's own ticket** (this fleet's existing convention, per BUTCHR-73)
   is append-only and cannot follow a branch the way `reviews[].commit.oid`
   can (see the Merge Protocol caveat this document inherits). It holds the
   verdict and the exact sha **even where GitHub itself holds no formal
   approval at all** — exactly the case a collapsed hop produces. This is
   the second marker, and the one a later reader should treat as
   authoritative when `reviewDecision` is empty: an empty `reviewDecision`
   plus a present `[review] APPROVED ... @ <sha>` ticket line means
   "reviewed, verdict recorded, GitHub could not hold the badge because of
   the collision" — a documented consequence. An empty `reviewDecision`
   with **no** such line means "not reviewed" — a real gap.
3. **The honest-refusal procedure**, demonstrated twice, live, on real
   PRs — `BUTCHR-62` on PR #170 and, today, `BUTCHR-115` on PR #178 (see §1):
   on a `gh pr review --approve` refusal, post the substantive verdict as a
   PR comment at the exact head sha, post the same as a `[review]` ticket
   line, and tell the worker in writing not to wait for a green badge that
   cannot arrive. This is the procedure to prescribe for every future
   collapsed hop, not a one-off workaround — **count it as "refused and
   routed around honestly," not as "quietly approved from the wrong
   account."** The workaround this document already rejects (§2) is
   approving from the *other* account's credentials; recording the verdict
   as a ticket/PR comment when GitHub refuses the badge is the accepted
   alternative, not the rejected one — the two are easy to conflate and are
   opposite recommendations.

**What this does not do, named rather than built:** none of the above makes
a collapsed hop's `reviewDecision` non-empty, and none of it stops a
collapsed-hop PR from being technically `MERGEABLE`/`CLEAN` on a repo with
no branch protection. If a further change is warranted — branch protection
on `main` requiring a passing review-adjacent check, or some other way to
make an unreviewed-looking merge visible as reviewed-but-collapsed — **that
is a candidate for BUTCHR-100 to route, not a decision or a change this
ticket makes.** Branch protection is a repository-settings change, out of
reach the same way a `BUTCHR_ASSIGNEE_*` value is.

**Why this is permanent, not transitional:** whichever direction is applied
from §2/§4, at least one hop remains not-cross-account —
same-issuetype peer adoption is structurally unfixable by any allocation.
The three-artefact procedure above is therefore the fleet's permanent
operating procedure for whatever hop its identity model cannot close, not a
stopgap to retire once Direction A or B ships.

---

## Provenance

Written 2026-09-02, Task tier, `BUTCHR-125`, host and daemon per this
workspace's own `ENVIRONMENT.md` (not restated here — read your own, not
this page's, per this ticket's own instruction against citing another
agent's environment as fact). Every MEASURED claim above is a command run in
this session; every CITED claim names its source and is not re-asserted as
first-hand. Re-run the checks in §0 before trusting this page — that rule
applies to this document exactly as `docs/identity-model.md` states it for
itself.
