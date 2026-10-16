bump: patch

### Fixed
- scripts/release/facts.ts no longer builds git commands as shell strings; every git call (`merge-base`, `diff --name-only`, `show <ref>:<file>`) now goes through `execFileSync` with an argv array, so a base ref (branch name) can never be interpreted as shell syntax.
