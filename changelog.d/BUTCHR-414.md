bump: patch

### Removed
- **The BUTCHR-400 log-only startup warning for a `jira-work` rule with no `status` clause is gone (BUTCHR-414, story BUTCHR-399): owner reversal.** The consolidation-spec requirement it enforced ("To Do must not be staffed") was superseded — "[To Do] can be staffed if someone wants. we shouldn't ever prevent it." `src/rules/status-clause-warning.ts`, its `src/daemon/index.ts` wiring, and its unit/load tests are deleted outright; neither the warning nor any status gate ever reached a tagged release, so this is a removal, not a deprecation.

### Fixed
- **`test/unit/status-clause-warning.test.ts`'s typecheck break is moot — the file is deleted along with the feature it covered.** Its `Rule` test fixture predated BUTCHR-392/398's now-required `execution`/`account`/`role` fields; rather than patch a fixture for a feature being removed, the whole file goes with it.

### Changed
- **README "Rules file" section now frames `In Progress`/`In Review` as `docs/rules.example.json`'s default, not an enforced floor.** It no longer says `To Do`/`Done` "are excluded," that `To Do` "must not" be staffed, or that a status-less query gets a startup warning — Butchr never gates, prevents, or warns on a `jira-work` query's status clause; the query is the only place that choice lives, and an operator who wants a rule to include `To Do` (or any other status) simply writes that query. The "Where the file actually lives" and "Applying a change" paragraphs are unchanged.
- **README "Capacity naming" paragraph now names the field exactly.** BUTCHR-392/398 merged the concrete field since BUTCHR-401 wrote that paragraph: `role: "worker" | "sentinel"` (`src/rules/rules.ts`), default `"worker"`. Every rule in `docs/rules.example.json` still carries no `role` — that is the default, not a gap — and only an always-on agent is ever flagged `role: "sentinel"`. `changelog.d/BUTCHR-400.md` and `changelog.d/BUTCHR-401.md` are corrected in place to match (neither the warning nor the old "concept only" capacity wording ever shipped to a release).
