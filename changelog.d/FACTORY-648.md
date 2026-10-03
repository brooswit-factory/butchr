bump: patch

### Fixed

- Release notes no longer cut a changelog bullet down to its first line. A bullet wrapped over several lines in a `changelog.d/` fragment is now kept whole in the GitHub Release body and in `CHANGELOG.md`. The first real release from the new workflow (v0.19.0) lost the rest of its one bullet, so its notes were corrected by hand.
