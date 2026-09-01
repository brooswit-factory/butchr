# The agent model

Decided 2026-08-25 (rev 2 — the canonical-types framing). This is the plan of
record for how butchr agents work per issue type. Build order at the bottom.

## The principle

Agents are written to **complement what their issue type canonically is** in
Jira — not to impose a workflow on top of it. Epics are large finite outcomes.
Stories are deliverable increments of value. Tasks are concrete units of work.
Nothing in the model assumes the work is code: repos, documents, and systems
are all just *context*, and

> **Context flows down through tickets; results flow up through review.
> The ticket is the interface.**

An agent knows only what its ticket (and its brief) tells it. Whoever files a
ticket is responsible for putting the needed context in it — that is the
system's main skill, and the briefs teach it.

## The three agents

| type | owns | model | effort |
|---|---|---|---|
| **Epic** | One **outcome** — a large, finite initiative. Shapes it into stories, adjusts the plan as finished work teaches, guards its scope, reviews each story's result, verifies the outcome end-to-end, writes the closing summary, and **ends**. It does not own territory; if the outcome involves repos or systems, the epic is told about them in its description. | fable | high |
| **Story** | One **increment of value** — observably true when done, per its acceptance criteria. Decomposes into tasks when the work divides (each task ticket carrying its own definition of done and the context to meet it); does directly what doesn't warrant a ticket. Reviews each task's result; verifies the whole increment; then In Review for the epic. | opus | high |
| **Task** | One **unit of work** with a concrete definition of done stated on its ticket — code, research, writing, investigation, anything. Produces exactly the named artifact, comments what and where, then In Review for the story. | sonnet | high |

Every level finishes the same way: verify against acceptance criteria, hand
upward for review, end. **No agent is permanent.** Agent lifecycle mirrors
work lifecycle via the reconcile loop: active ticket ⇒ running agent.

## Conventions, not machinery

- **When the work involves a repo** (the ticket says so): branch from your
  parent's branch, PR back into it. The branch tree mirrors the ticket tree
  (`main ← story ← task`) whenever the work is code, and doesn't exist
  otherwise. **The reviewer approves; the author merges its own approved PR**
  — at both levels (story approves task PRs; epic approves the story's PR to
  main). Every formal review — Approve or Request changes — also gets one
  `[review] <verdict> <pr> @ <sha>` comment on the author's ticket (the event
  that actually wakes them), and the author verifies the last decisive
  review's own `reviews[].commit.oid` against the current head before
  merging (an approval is recorded against a sha, and the branch may have
  moved since). That check is NOT sufficient on its own: GitHub re-points
  `reviews[].commit.oid` to the merge commit whenever the branch takes a
  base-merge, so it cannot detect a head move caused by a base-merge —
  strictly better than the `reviewDecision`+`headRefOid` pair it replaced
  (which failed on every push), but not proof the base hasn't moved under
  the reviewed diff.
- **When the work is a document**: the artifact lands where the ticket says
  (e.g. Confluence); the reviewer accepts by saying so on the ticket.
- **Review** = the boss agent — reached via the Implements link, not the
  parent field — reads the child's result against what the child's ticket
  asked. Changes are requested as ticket comments — the watch loop nudges the
  child's agent.

## Briefs and the kickoff cascade

- `briefs/` in this repo: `epic.md`, `story.md`, `task.md`, `default.md`.
  Short — role model, the tools that actually exist, the conventions above.
  Growth is a smell (the old system's briefs hit 4,880 lines by accreting
  workarounds for delivery failures this architecture doesn't have).
- A generic `CLAUDE.md`: *read `brief.md` and follow it.*
- On spawn, butchr creates `~/butchr-workspaces/<KEY>/`, copies in `CLAUDE.md`
  + the type's brief as `brief.md` (interpolated: key, summary, parent), and
  starts the herdr workspace with that `cwd` — Claude Code auto-reads
  `CLAUDE.md` there. Kickoff prompt: **"follow your CLAUDE.md"**.

## Parked-ticket detection (BUTCHR-24)

A staffed child (has an assignee) left in To Do under a live (In Progress)
boss is never legitimate — nobody spawns an agent for a To Do ticket, so the
boss waits forever on events from an agent that does not exist. The daemon
detects this itself (`src/agents/parked.ts`) after `BUTCHR_PARKED_MINUTES`
(default 10) and escalates to the boss's ticket, then follows up once, then
escalates up the Implements chain if the boss still hasn't acted — arriving
at a human-owned ticket by construction, since epics are the human's
(above). A deliberately-shelved backlog item can be exempted with the
`butchr:shelved` label — any actor may set it (a human today, or an
automated shelving tool in future) — which the daemon only ever reads.

## Tools: the daemon MCP is a thin proxy

thatch tools proxy the de-facto SDKs — `jira.js` and `confluence.js` —
executed daemon-side with the shared credential. No scoping machinery; the
daemon logs which connection (`x-issue`) did what.

## Spawning

Assignment + status (In Progress / In Review) decide whether an agent runs.
Issue type decides only brief, model, and duties.

## Dissolved questions (rev 1 asked these; rev 2 removes the need)

- ~~Task types (code/research labels)~~ — a task's "type" is its ticket's own
  definition of done. One task brief.
- ~~Epic repo mapping~~ — repos are context, delivered in ticket descriptions.
- ~~Who merges~~ — the reviewer accepts in the work's own medium.

## Open

- **Workspace lifecycle**: `~/butchr-workspaces/<KEY>/` — removed when the
  ticket leaves the active statuses? (Safe for merged work; abandons
  uncommitted work with the ticket.)

## Build order

1. **Daemon tools** — jira.js/confluence.js proxied through thatch.
2. **Workspace builder + briefs** — CLAUDE.md, the four briefs, interpolation,
   `workspace.create({cwd})`, the kickoff prompt.
3. **Per-type models** — epic=opus, story=opus, task=sonnet via spawn args.
4. **Implements-link routing** — extend the diff/notify loop to route a
   ticket's events to whatever it implements (task→story→epic); the parent
   field stays membership-only and triggers no notification.
