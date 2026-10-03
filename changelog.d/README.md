# changelog.d/ — per-PR changelog fragments

Every PR that touches a gated file (`src/`, `schema/`, `package.json`, or `briefs/`) must
add exactly one new fragment here: `changelog.d/<TICKET>.md`. One file per PR
means two concurrent PRs never touch the same line of the same file — nothing
to rebase away, no discarded approvals. Do **not** append to a shared
`## [Unreleased]` section instead; that reintroduces the exact conflict this
scheme exists to remove.

The release workflow (`.github/workflows/release.yml`, still disabled —
FACTORY-627) computes the next version at MERGE time from the latest `v*`
git tag plus the HIGHEST declared bump among the fragments added since that
tag, tags that commit, and creates a GitHub Release with notes built from
those fragments. There is **no commit to `main`**: `package.json`'s
`version` and `CHANGELOG.md` are never written by the release workflow, and
fragments are never deleted — a fragment simply stops counting once a tag
is made at or after it (see `scripts/release/git.ts`'s
`fragmentsAddedSince`). **Do not** bump `package.json`'s version or add a
dated CHANGELOG heading yourself — the release gate rejects both.

## Format

```
bump: minor

### Added
- a thing this PR adds

### Fixed
- a bug this PR fixes
```

- First line: `bump: major` / `bump: minor` / `bump: patch` — see
  `CHANGELOG.md`'s `## Versioning` section for what each level means.
- Followed by `### <Section>` blocks (`BREAKING`, `Added`, `Changed`,
  `Fixed`, `Removed` — same names `CHANGELOG.md` uses) with `- ` bullets.
- A `### BREAKING` section requires `bump: major`, and `bump: major` requires
  a `### BREAKING` section — the gate checks both directions.
- If your PR changes `schema/herdr-api.schema.json`, declare at least
  `bump: minor`.

A PR with no gated changes needs no fragment.
