# The agent model

Decided 2026-08-25. This is the plan of record for how butchr agents work per
ticket type. Build order at the bottom.

## The hierarchy

| type | role | model |
|---|---|---|
| **Epic** | Master of its domain — typically one project/repo. Creates stories to accomplish high-level ideas. Reviews story PRs into `main`. | fable |
| **Story** | Takes a high-level idea and decomposes it into tasks. Keeps decomposing until its branch is complete and clean, then PRs its branch → `main` and moves itself to In Review until the **epic** reviews. | opus |
| **Task** | Accomplishes one unit of work. Task *types* differ in their initial step and acceptance criteria (below). Moves itself to In Review until the **story** reviews. | sonnet |

Spawning is untouched by type: **assignment + status (In Progress / In Review)
decide whether an agent runs** — issuetype only decides which brief, model, and
duties it gets.

## The branch tree mirrors the ticket tree

```
main
└── KAN-<story>            the story's branch
    ├── KAN-<taskA>        each code task: a worktree + branch named by its key
    └── KAN-<taskB>
```

- A **code task** starts by creating a worktree named after its Jira key inside
  the workspace; it ends with a **PR from its key-branch into the story's
  key-branch**, and the ticket In Review until the story agent reviews.
- A **research task** starts from a `draft.md`; it ends as a **Confluence doc**,
  and the ticket In Review until the story agent reviews.
- A **story** ends with a **PR from its key-branch into `main`**, In Review
  until the epic reviews.

## Briefs and the kickoff cascade

- `briefs/` in this repo: `epic.md`, `story.md`, `task-code.md`,
  `task-research.md` (+ `default.md`). Short — the role model, the tools that
  actually exist, the handoff conventions. Growth is a smell; the old briefs
  hit 4,880 lines by accreting workarounds for delivery failures this
  architecture doesn't have.
- A generic `CLAUDE.md` that says: *read `brief.md` and follow it.*
- On spawn, butchr creates the agent's workspace directory, copies `CLAUDE.md`
  + the right brief in as `brief.md` (interpolated: key, summary, parent,
  repo), and starts the herdr workspace with `cwd` = that directory — Claude
  Code auto-reads `CLAUDE.md` from cwd.
- The kickoff prompt is one line: **"follow your CLAUDE.md"** — which cascades
  into the brief.

## Tools: the daemon MCP is a thin proxy

The thatch server's tools proxy the **de-facto SDKs** — `jira.js` and
`confluence.js` — executed daemon-side with the shared credential (agents never
hold the token; attribution is free via each connection's `x-issue`). No
scoping machinery: any agent may call any tool; the daemon logs who did what.

## Review flow over the existing loop

No supervision machinery. The watch loop already notifies the agent on a
changed issue; it additionally notifies the **parent's** agent, so a task
moving to In Review nudges its story, and a story moving to In Review nudges
its epic. Review = the supervisor reads the child's PR/doc, requests changes
(comment → child's agent is nudged) or accepts (merge the PR / approve the
doc, move the child to Done).

## Open questions (to settle before building)

1. **Where does a task's *type* (code vs research) live?** Proposal: a label
   (`code`, `research`), defaulting to code when absent. Alternative: parse
   from summary/description.
2. **Where does an epic's repo mapping live?** "Master of one repo" needs
   KEY→repo. Proposal: a line in the epic's description
   (`repo: github.com/org/name`), inherited by its stories/tasks.
3. **Who merges a reviewed PR?** Story merges task PRs into its branch; epic
   merges story PRs into main — or does the human hold the main merge?
4. **Workspace location + lifecycle**: proposal `~/butchr-workspaces/<KEY>/`,
   removed when the ticket leaves the active statuses (worktrees pruned).

## Build order

1. **Daemon tools** — jira.js/confluence.js proxied through thatch (nothing
   works until agents have hands).
2. **Workspace builder + briefs** — CLAUDE.md, the five briefs, interpolation,
   `workspace.create({cwd})`, the kickoff prompt.
3. **Per-type models** — `--model` from a type table (epic=fable, story=opus,
   task=sonnet).
4. **Parent notification** — extend the diff/notify loop with the parent field.
5. **Repo mapping + worktree conventions** in the code-task brief.
