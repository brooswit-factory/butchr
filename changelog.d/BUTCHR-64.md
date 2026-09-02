bump: minor

### Added
- **A `ResourceType<T>` interface (`src/resources/types.ts`), the extension seam a second resource type plugs into.** It declares exactly four members — discovery, activation, event rules, and spawn config — and nothing else; everything not named there (spawn, argv, panes, escalation, labels, docs) stays shared across every resource type rather than being re-implemented per type.
- **The issue tier expressed as exactly one instance of `ResourceType<T>` (`src/resources/issue.ts`)**, carrying its whole notify-stage suppression stack forward with incident history intact.

### Changed
- **The poll loop and reconciler rewritten as `runResourceLoop<T>`, generic over an opaque resource id.** The loop hands a resource type an opaque snapshot and asks it what changed, rather than diffing issue-shaped fields itself — an operational shape now, not one hard-coded assumption at every call site.
- `desiredFrom`'s exported signature now takes a resource type as a second argument.

No behaviour change for the issue tier: `startLoop`, `LoopDeps`, and `RelatedIssue` deliberately keep their exact historical shape as a thin adapter over the new engine, so no existing test needed editing. Evidence for this PR is a green `bun run check` plus a positive-proof test — not a live run; live proof belongs to BUTCHR-68's deploy.

**Bump-level reasoning:** `minor`, per `CHANGELOG.md`'s own definitions. `desiredFrom`'s exported signature changed to require a second argument — that's "a change to an existing feature that breaks just that feature," which is what `bump: minor` means and is exactly what `bump: patch` ("needing no consumer code changes, or very minor ones") excludes. The new `ResourceType<T>` seam is also, independently, "a new feature" under the same `minor` definition. `major` doesn't fit: nothing here requires reimplementation by any caller — `startLoop`/`LoopDeps`/`RelatedIssue` were kept exactly as they were precisely so nothing downstream would have to change.
