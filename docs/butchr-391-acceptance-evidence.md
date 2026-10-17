# BUTCHR-391 acceptance evidence — Part A (BUTCHR-464)

> **Status on `local/ui`:** a historical record. Managed sessions and
> Rocket.Chat support have since been removed, so rows 1–2 and the former
> rows 5–6 (the account axis: execution × account policy, temporary and
> permanent account cleanup) describe features butchr no longer has. The
> account rows are dropped below, and the matrix test is now
> `test/unit/execution-role-matrix.test.ts` (execution × role); the pass
> counts quoted below are from the original run.

Scope: **Part A only** — the automated acceptance matrix and role-field tests
owned by BUTCHR-464 (implements story BUTCHR-396, epic BUTCHR-391). Every row
below was verified live in this task's own worktree by actually running the
named command; a row marked "Codey-only" is Part B (BUTCHR-396's other
tasks, BUTCHR-465/BUTCHR-466, executed by the Codey-side managers per
BUTCHR-396's own execution-model constraint — this task has no Codey access
and does not touch live daemons/config) and is NOT verified here. Commands
below were run from the repo root of this task's own worktree; a reviewer on
a different checkout should re-run them rather than trust the pasted numbers
verbatim (this repo's own house convention — see this repo's `CLAUDE.md`/task
briefs on not asserting facts a reader can't verify from their own checkout).

## Brief acceptance criteria (Confluence 36896769) and epic BUTCHR-391 description

| # | Criterion (brief / epic) | Owning work | Evidence | Command run | Result |
|---|---|---|---|---|---|
| 1 | Baker-style directory agents and Candlestix-style managed sessions run through Butchr using filesystem resources | S2/BUTCHR-393, S3/BUTCHR-394 (pre-existing, verified here) | `test/unit/filesystem.test.ts`, `test/unit/filesystem-ref.test.ts`; design in `docs/managed-sessions.md` | `bun test test/unit/filesystem.test.ts test/unit/filesystem-ref.test.ts` | **PASS** — 85 pass, 0 fail |
| 2 | Managed definitions can be frozen, unfrozen, archived, and restored through the CLI; archived definitions no longer keep their agents running | S3/BUTCHR-394 (pre-existing, verified here) | `test/unit/session-cli.test.ts`, `test/unit/session-freeze.test.ts`, `test/unit/session-freeze-tools.test.ts`, `test/unit/session-archive.test.ts`, `test/unit/session-definition-manage.test.ts` | `bun test test/unit/session-cli.test.ts test/unit/session-freeze.test.ts test/unit/session-freeze-tools.test.ts test/unit/session-archive.test.ts test/unit/session-definition-manage.test.ts` | **PASS** — 138 pass, 0 fail |
| 3 | For N matching resources: swarm keeps N agents, singleton keeps 1 only while N>0, persistent keeps 1 even at N=0 | S1/S4 (BUTCHR-392/BUTCHR-395), reconciliation convergence pre-existing; the execution×role interaction is BUTCHR-464's own new work | `test/unit/execution-modes.test.ts` (convergence describe blocks); `test/unit/account-reconcile-matrix.test.ts` (BUTCHR-464: the 3x3x2 matrix, below) | `bun test test/unit/execution-modes.test.ts` | **PASS** — 46 pass, 0 fail |
| 4 | Singleton and persistent agents receive the relevant events for their query's workload | S1/BUTCHR-398 (pre-existing, verified here) | `test/unit/execution-modes.test.ts`'s "Event delivery to a query-level agent" describe block | `bun test test/unit/execution-modes.test.ts` | **PASS** — included in the 46 above |
| 7 | Query selection stays configurable, with no fixed Jira status/tag/assignee rule introduced by this work | S2/BUTCHR-393 (schema-level, pre-existing) | **NOT COVERED by a dedicated automated test.** Verified by code inspection instead: `Rule.query` (`src/rules/rules.ts:199`) is a plain `string`, and the `jira-work` provider imposes no additional validation on it (`parseRules`'s per-provider `if`/`else if` chain, `src/rules/rules.ts:399-404`, has no `jira-work` branch — jira-work's query is trimmed and passed through as-is). The pre-existing `ISSUE_JQL`/`TODO_WORKER_JQL` constants (`src/resources/issue.ts`) are a SEPARATE, unrelated mechanism (the fleet's own bootstrap discovery of which tickets to consider staffing at all, consumed by `src/agents/abandoned.ts`/`src/daemon/index.ts`) — they are not read by, or wired into, the rules-query feature this criterion is about. This is an absence-of-a-hardcoded-filter property; there is no positive automated assertion for it in this codebase today, and writing one is out of this task's scope (it would need to be a rule against ADDING such a filter, e.g. a grep-based guard, which nobody has asked for). | `grep -n "query:" src/rules/rules.ts` / `grep -n "ISSUE_JQL\|TODO_WORKER_JQL" src/**/*.ts` (inspection, not a pass/fail test) | **NOT COVERED — architectural property, verified by inspection only** |

## Sentinel/worker role-field tests (BUTCHR-391 epic decision, BUTCHR-396's own DoD, restated on BUTCHR-464)

All four of these already exist, shipped under S1/BUTCHR-392+BUTCHR-398 —
verified live here by (a) running them and (b) two independent mutations of
the production code that each kill exactly the tests they should, proving
they are not decoration. BUTCHR-464 did not need to add new tests for these
four (doing so would have forked a second, redundant harness for behaviour
this repo already tests directly) — it instead independently re-verified the
existing coverage as part of this task's own acceptance evidence.

| # | Required behaviour | Existing test | Command | Result |
|---|---|---|---|---|
| 1 | An unflagged rule (`role` defaulting to `"worker"`) IS capped when the cap is full | `test/unit/execution-modes.test.ts:443` — `"an unflagged rule's agents behave identically to today: counted, withheld exactly as before"` | `bun test test/unit/execution-modes.test.ts -t "unflagged rule"` | **PASS** |
| 2 | A `role: "sentinel"` rule starts even with the cap full | `test/unit/execution-modes.test.ts:450` — `"a sentinel is never withheld — admitted even at/over the cap, while workers around it are still rationed"` | `bun test test/unit/execution-modes.test.ts -t "sentinel is never withheld"` | **PASS** |
| 3 | Workers are never blocked by sentinels (a resident sentinel doesn't consume the worker budget; sentinels start regardless of how full the worker cap is) | `test/unit/execution-modes.test.ts:458` — `"a sentinel never counts toward residency..."` and `:466` — `"sentinels start even when workers are withheld at the cap"` | `bun test test/unit/execution-modes.test.ts -t "sentinel"` | **PASS** |
| 4 | Existing rule files with no `role` key keep their cap unchanged (no migration) | `test/unit/rules.test.ts:263` — `"a pre-change rules document (no role) loads unchanged, plus the worker default — no example/shipped rules file needs to opt in"` | `bun test test/unit/rules.test.ts -t "pre-change rules document"` | **PASS** |

### Mutation testing (proving these are not decoration)

Both mutations were applied directly to the production source, the affected
test files re-run, then the source was reverted (confirmed clean via `git
status --short` showing only the intended test-file change afterward).

**Mutation A — make sentinels count toward the cap** (`src/agents/admission.ts`,
inside `createAdmissionController`): changed
```
const sentinelCandidates = candidates.filter((id) => roleOf(id) === "sentinel");
const workerCandidates = candidates.filter((id) => roleOf(id) !== "sentinel");
```
to
```
const sentinelCandidates: readonly string[] = [];
const workerCandidates = candidates;
```
Ran `bun test test/unit/execution-role-matrix.test.ts test/unit/execution-modes.test.ts`.
**Result: exactly the sentinel-dependent tests failed** — both pre-existing
(`execution-modes.test.ts`: "a sentinel is never withheld...", "sentinels
start even when workers are withheld at the cap") and BUTCHR-464's own new
9 sentinel-role cells in the per-cell capacity `test.each` (e.g. `cell
swarm-none-sentinel`, `cell singleton-permanent-sentinel`, ...), plus the
combined-poll matrix test (a worker cell came up un-spawned because the 9
sentinels now consumed the shared budget). Every worker-only test kept
passing, as expected — this mutation only breaks role #2/#3 above.

**Mutation B — flip the default role polarity** (`src/rules/rules.ts`, in
`parseRules`'s field-filling step): changed
```
role: (role as AgentRole | undefined) ?? "worker",
```
to
```
role: (role as AgentRole | undefined) ?? "sentinel",
```
Ran `bun test test/unit/rules.test.ts test/unit/execution-modes.test.ts test/unit/execution-role-matrix.test.ts`.
**Result: exactly 7 tests failed, all in `rules.test.ts`, none in the other
two files** —
`"default reader: absent file is missing, present file parses, a directory
throws"`, `"accepts every optional setting and normalises"`, `"omitted
optionals stay absent; enabled/execution/account/role default to
true/swarm/none/worker"`, `"a pre-change rules document (no
execution/account) loads unchanged..."`, `"defaults to worker when absent:
today's behaviour, exactly"` (role #4's own test), `"a pre-change rules
document (no role) loads unchanged..."` (role #4 above), and
`"a pre-change rules document (none of the five set) loads unchanged..."`
(the unrelated linked-eventing-knobs compatibility test) — every assertion
in that file that checks the FULL set of filled-in defaults at once, `role`
included. `execution-modes.test.ts`/`execution-role-matrix.test.ts` were
UNAFFECTED by this mutation: both build their `Rule` objects by hand rather
than through `parseRules`'s defaulting, so role #1's own claim ("an
unflagged rule is capped") is exercised there against a hand-set
`role: "worker"`, not against the default — Mutation A above is what
actually exercises role #1's claim at the admission layer, and role #2/#3
are likewise admission-layer claims Mutation A targets, not schema-defaulting
ones.

## BUTCHR-464's own new work: the execution × role matrix

Originally a 3x3x2 execution × account × role matrix
(`test/unit/account-reconcile-matrix.test.ts`). The account axis was the
Rocket.Chat account policy; Rocket.Chat support has since been removed, so
the file is now `test/unit/execution-role-matrix.test.ts`, with 6 cells
generated from `EXECUTIONS.flatMap(execution => ROLES.map(role => ...))`,
never hand-copied.

- **`describe("BUTCHR-464: role capacity behaviour, per cell (fleet-wide cap fully saturated)")`**
  — `test.each` over every cell with the cap forced to 0 (the most extreme
  "cap full" case): a worker cell is withheld (never spawns) while a
  sentinel cell of the same execution mode starts anyway, then stops
  correctly on a follow-up poll. `test.each`'s own title interpolation
  (`"cell %s: ..."`) means a failing cell is named in the test's own title,
  not just an inline assertion message.

## `bun run check`

Command: `bun run check`
Result: **PASS** — preflight OK; `bun run generate` clean; `bun run typecheck`
clean; `test/unit` + `test/load` = 4220 pass, 0 fail, 52401 `expect()` calls
across 346 files; coverage gate OK at 96.43% lines (13150/13637) / 95.60%
functions (2175/2275), minimum 90%; `test/load matches its sources`; build
produced `dist/butchr.js` (sha=5a829ea95cd854b415389da0bd3550b776cf54c4) and
`dist/butchr-mcp.js`. Run in this task's own worktree at commit 274f300.

## Rollout acceptance (Codey) — out of scope for this task

| Criterion | Status |
|---|---|
| Bakr: inventory mapped, MCPs checked, modes correct, `bakr.service` stopped, no duplicate owners | **Codey-only** — proven by `docs/codey-migration-runbook.md` (BUTCHR-396's sibling task BUTCHR-466, agent mapping/staged definitions/cutover runbook) executed by the Codey-side managers; this task does not execute it and makes no claim about its review/merge state — see BUTCHR-466 for current status |
| Candlestix: same | **Codey-only** — same runbook, `docs/codey-migration-runbook.md` (BUTCHR-466) |
| Butchr restart/recovery verified on Codey, including sentinels unaffected by the cap post-restart | **Codey-only** — proven by `docs/codey-deploy-runbook.md` (BUTCHR-396's sibling task BUTCHR-465, Codey Butchr deploy/restart runbook with automatic rollback) plus the Codey-side health check; this task makes no claim about that runbook's own review/merge state — see BUTCHR-465 for current status. The ADMISSION-LAYER half of this claim (a sentinel's residency/role classification survives a fresh cold-start census with no special-casing) is already covered locally by `execution-modes.test.ts`'s "cold start" and BUTCHR-464's own per-cell capacity test — see the role-field table above — but the actual on-Codey restart verification is Part B, not this task |
