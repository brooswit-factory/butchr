# changelog.d/ — per-PR changelog fragments

Every PR that touches a gated file (`src/`, `schema/`, or `package.json`) must
add exactly one new fragment here: `changelog.d/<TICKET>.md`. One file per PR
means two concurrent PRs never touch the same line of the same file — nothing
to rebase away, no discarded approvals. Do **not** append to a shared
`## [Unreleased]` section instead; that reintroduces the exact conflict this
scheme exists to remove.

The release workflow collates every fragment present on `main` at merge time,
computes the version from their declared bump levels, writes it into
`package.json` and a dated `## [x.y.z] - YYYY-MM-DD` heading in
`CHANGELOG.md`, and deletes the fragments it consumed. **Do not** bump
`package.json`'s version or add a dated CHANGELOG heading yourself — the
release gate rejects both.

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
