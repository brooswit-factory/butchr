Merged Butchr PR [#825](https://github.com/brooswit-factory/butchr/pull/825) integrates the recovered authority source with current main and fixes authoritative rule-OFF reconciliation. Releases and per-host deployments require the gates in `docs/recovery-rule-off-rollout.md`.

The original 342 inputs (299 application, 43 SDK) were recovered and hash-verified locally. The public payload excludes private Git history, credentials, native conversations, runtime state, permits, receipts, host-specific operational records and opaque dependency archives. Terminal parser specimens use synthetic replacements; parser assertions remain intact. Private service links use an example domain.

Use Bun 1.3.11 and Node 20.20.2. From an empty parent directory, clone both repositories as siblings and detach at the verified commits. The SDK is pinned to the same commit used by CI; the Butchr merge commit has exactly the reviewed source tree. Neither checkout requires a recovery branch to remain present.

```sh
git clone https://github.com/brooswit-factory/drovr.git drovr
git -C drovr checkout --detach 4df054e3767d2af6568346daae0d29e85ed11d61
git clone https://github.com/brooswit-factory/butchr.git butchr
git -C butchr checkout --detach 2962b6141096abb9553fc8bad6b5c63f18ddace3
(cd drovr && bun install --frozen-lockfile --ignore-scripts && bun run build)
(cd drovr/legacy-events && bun install --frozen-lockfile --ignore-scripts && bun run build)
cd butchr
bun install --frozen-lockfile --ignore-scripts
bun run typecheck
bun run typecheck:web
bun run build
```

Local validation: backend and web builds, both application typechecks, SDK source-module parity (150/150 and 152/152), 112 SDK tests and 503 focused application/parser/operator tests passed. Builds report their actual current Git identity; they do not impersonate the preserved dirty source revision.

Two integration tests requiring an external private server checkout and one host-definition example test are excluded from this recovery payload. Their originals remain preserved locally. Existing public files outside the source overlay retain the main-branch baseline. The inherited project suite, release gate, sibling-checkout build and spawn smoke remain enforced by CI. Do not interpret focused checks as full-project release certification.

Continue development from the public repositories on the destination development machine; create a new branch from the pinned checkout before editing. No original-host workspace, cache path or original archive is needed by the documented build.

Integration repairs preserve current-main provider/credential/dashboard APIs and full lifecycle/readback briefs. CI checks out both repositories as siblings and builds SDK commit `4df054e3767d2af6568346daae0d29e85ed11d61` before installing Butchr. Registry dependencies were already outside the application's coverage scope; the sibling SDK is excluded on that same basis, with the application source/operator coverage gate and 90% threshold unchanged.

Rule OFF reconciliation runs before discovery fencing. It requires current authenticated authority, an explicit disabled rule, known exact rule ownership and a fresh complete worker census. Every destructive RPC retains the numeric generation lease. Missing/invalid configuration, disconnects, uncertain inventory, stale leases and partial handoffs preserve workers. Master pause remains a pause. Human and legacy local session workers are outside this sweep.

The reviewed Butchr source tree passed [all four CI jobs](https://github.com/brooswit-factory/butchr/actions/runs/41392065694): 8,073 tests passed, zero failed and one skipped. Line coverage was 91.49% and function coverage 91.44%. Drovr's pinned source passed [its CI](https://github.com/brooswit-factory/drovr/actions/runs/41382973751). The merged trees match those reviewed heads. Merge and build validation do not establish installation on any host.
