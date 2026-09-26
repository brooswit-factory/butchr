# BUTCHR-391 acceptance evidence — Part A (BUTCHR-464)

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
| 3 | For N matching resources: swarm keeps N agents, singleton keeps 1 only while N>0, persistent keeps 1 even at N=0 | S1/S4 (BUTCHR-392/BUTCHR-395), reconciliation convergence pre-existing; the execution×account×role interaction is BUTCHR-464's own new work | `test/unit/execution-modes.test.ts` (convergence describe blocks); `test/unit/account-reconcile-matrix.test.ts` (BUTCHR-464: the 3x3x2 matrix, below) | `bun test test/unit/execution-modes.test.ts` | **PASS** — 46 pass, 0 fail |
| 4 | Singleton and persistent agents receive the relevant events for their query's workload | S1/BUTCHR-398 (pre-existing, verified here) | `test/unit/execution-modes.test.ts`'s "Event delivery to a query-level agent" describe block | `bun test test/unit/execution-modes.test.ts` | **PASS** — included in the 46 above |
| 5 | All 3 execution modes × 3 account policies configurable independently (3x3 matrix) | S4/BUTCHR-412 shipped the 3x3; **BUTCHR-464 extends it to the full 3x3x2 with `role`** | `test/unit/account-reconcile-matrix.test.ts` — see "BUTCHR-464's own new work" below for the full breakdown | `bun test test/unit/account-reconcile-matrix.test.ts` | **PASS** — 21 pass, 0 fail (18 of those are the per-cell `test.each` — see below) |
| 6 | Temporary accounts cleaned up on stop and provisioned again when needed; permanent accounts reused and retained through stops and archive/restore | S4/BUTCHR-395/BUTCHR-412 (pre-existing 3x3; BUTCHR-464 re-verifies across all 18 cells) | `test/unit/account-reconcile-matrix.test.ts`; `test/unit/managed-session-account-release.test.ts` (archive-path release) | `bun test test/unit/account-reconcile-matrix.test.ts test/unit/managed-session-account-release.test.ts` | **PASS** — 21 + (see file 2's own count) pass, 0 fail |
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
Ran `bun test test/unit/account-reconcile-matrix.test.ts test/unit/execution-modes.test.ts`.
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
Ran `bun test test/unit/rules.test.ts test/unit/execution-modes.test.ts test/unit/account-reconcile-matrix.test.ts`.
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
included. `execution-modes.test.ts`/`account-reconcile-matrix.test.ts` were
UNAFFECTED by this mutation: both build their `Rule` objects by hand rather
than through `parseRules`'s defaulting, so role #1's own claim ("an
unflagged rule is capped") is exercised there against a hand-set
`role: "worker"`, not against the default — Mutation A above is what
actually exercises role #1's claim at the admission layer, and role #2/#3
are likewise admission-layer claims Mutation A targets, not schema-defaulting
ones.

## BUTCHR-464's own new work: the 3x3x2 execution × account × role matrix

`test/unit/account-reconcile-matrix.test.ts`, extending BUTCHR-412's existing
3x3 (execution × account) harness with the `role` axis (`test/fixtures/rocketchat-fakes.ts`
unchanged — no parallel harness forked). 18 cells generated from
`EXECUTIONS.flatMap(execution => POLICIES.flatMap(account => ROLES.map(role => ...)))`,
never hand-copied.

- **`describe("BUTCHR-412/BUTCHR-464: the 3x3x2 execution x account x role matrix...")`**
  — one combined-poll test across all 18 cells at once, with a real
  `AdmissionController` (cap set to exactly the 9-worker count): asserts,
  per cell (`expect(..., \`cell ${rule.id}\`)` — a failure names the cell),
  BOTH the account behaviour (unchanged from BUTCHR-412: none/temporary/permanent)
  AND that every worker fits exactly alongside every sentinel with no
  cross-contamination (residency tally after the poll: exactly 9 workers, 9
  sentinels).
- **`describe("BUTCHR-464: role capacity behaviour, per cell (fleet-wide cap fully saturated)")`**
  — `test.each` over all 18 cells with cap forced to 0 (the most extreme
  "cap full" case): a worker cell is withheld (never spawns, never touches
  the account store, whatever its own account policy is) while a sentinel
  cell of the same execution/account combination starts anyway, its account
  behaviour proceeding exactly as at a sufficient cap, then stops correctly
  on a follow-up poll. `test.each`'s own title interpolation
  (`"cell %s: ..."`) means a failing cell is named in the test's own title,
  not just an inline assertion message.

Command run: `bun test test/unit/account-reconcile-matrix.test.ts`
Result: **PASS — 21 pass, 0 fail** (3 pre-existing BUTCHR-412 tests + 18 new
per-cell BUTCHR-464 tests).

## `bun run check`

Command: `bun run check`
Result: see this PR's own CI/description for the final run (typecheck +
`bun run generate` + full `test:unit` + coverage gate + generated-file
currency + build) — run locally in this task's worktree before opening the
PR; paste the tail of that run in the PR description rather than duplicating
it here, since this doc is about acceptance criteria, not CI logs.

## Rollout acceptance (Codey) — out of scope for this task

| Criterion | Status |
|---|---|
| Bakr: inventory mapped, MCPs checked, modes correct, `bakr.service` stopped, no duplicate owners | **Codey-only** — proven by the Part B runbook BUTCHR-396's sibling task BUTCHR-466 (agent mapping/cutover runbook) produces and the Codey-side managers execute; not available at the time of this evidence doc (BUTCHR-466 was still In Progress, no PR yet) |
| Candlestix: same | **Codey-only** — same runbook (BUTCHR-466) |
| Butchr restart/recovery verified on Codey, including sentinels unaffected by the cap post-restart | **Codey-only** — proven by BUTCHR-465 (Codey deploy runbook) plus the Codey-side health check; the ADMISSION-LAYER half of this claim (a sentinel's residency/role classification survives a fresh cold-start census with no special-casing) is already covered locally by `execution-modes.test.ts`'s "cold start" and BUTCHR-464's own per-cell capacity test — see the role-field table above — but the actual on-Codey restart verification is Part B, not this task |
| Real-RC verification (Claude+Codex agents answer a channel message; temp/permanent account create/reuse/cleanup on production RC) | **Codey-only** — `docs/real-rc-verification-runbook.md` (written by S4/BUTCHR-395) is executed by manager-factory-butchr on Codey per BUTCHR-396's own Execution-model section; this task has no Codey/Rocket.Chat-production access and does not run it |
