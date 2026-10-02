bump: patch

### Changed
- `release.yml` (still disabled) now computes the next version from the latest `v*` git tag plus the highest `changelog.d/` fragment bump since that tag, and creates a tag + GitHub Release directly — no bot commit to `main`, no `package.json` or `CHANGELOG.md` write, no npm. `scripts/release/release.ts --dry-run` prints what the next release would be without creating anything; `ci.yml`'s `release-gate` job runs it informationally on every PR.
