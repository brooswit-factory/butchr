bump: patch

### Fixed
- `test/unit/setup-mode-entry.test.ts` and `test/unit/seed-first-run-setup-integration.test.ts`
  spawned the real daemon entry with `cwd` set to the repo root. Bun loads a
  repo-root `.env` into a spawned child's `process.env` regardless of the
  `env` option passed to `Bun.spawn`, so a developer's real
  `ATLASSIAN_SITE`/`EMAIL`/`TOKEN_FILE` reached the spawned daemon — on any
  checkout with a configured `.env`, two `setup-mode-entry` tests failed and
  one `seed-first-run-setup-integration` test failed, and worse, the test
  could talk to a real Jira site with the operator's real token. Both spawns
  now run with `--no-env-file` and a scratch temp directory as `cwd` (never
  the repo), so there is no `.env` to find even if the flag were ever
  dropped. `setup-mode-entry.test.ts` also gained a fail-fast guard that
  probes the exact `(cwd, env, flags)` triple the real spawn uses with a
  throwaway script dumping its own `process.env`, and throws if any
  `ATLASSIAN_*` key leaks in beyond what the test itself explicitly supplied
  (GitHub #664).
