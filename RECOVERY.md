This draft branch recovers the application source corresponding to the frozen build census. It does not contain the requested rule bug fix, a release, or a deployment.

The original 342 inputs (299 application, 43 SDK) were recovered and hash-verified locally. The public payload excludes private Git history, credentials, native conversations, runtime state, permits, receipts, host-specific operational records and opaque dependency archives. Terminal parser specimens use synthetic replacements; parser assertions remain intact. Private service links use an example domain.

Use Bun 1.3.11 and Node 20.20.2. Clone the approved Drovr recovery next to this checkout as `../drovr`, pinned to `4df054e3767d2af6568346daae0d29e85ed11d61`:

```sh
git clone --branch codex/portable-source-recovery-20261102 https://github.com/brooswit-factory/drovr.git ../drovr
git -C ../drovr checkout 4df054e3767d2af6568346daae0d29e85ed11d61
(cd ../drovr && bun install --frozen-lockfile --ignore-scripts && bun run build)
(cd ../drovr/legacy-events && bun install --frozen-lockfile --ignore-scripts && bun run build)
bun install --frozen-lockfile --ignore-scripts
bun run typecheck
bun run typecheck:web
bun run build
```

Local validation: backend and web builds, both application typechecks, SDK source-module parity (150/150 and 152/152), 112 SDK tests and 503 focused application/parser/operator tests passed. Builds report their actual current Git identity; they do not impersonate the preserved dirty source revision.

Two integration tests requiring an external private server checkout and one host-definition example test are excluded from this recovery payload. Their originals remain preserved locally. Existing public files outside the source overlay retain the main-branch baseline. The complete inherited project suite, release gate and CI sibling-checkout setup still require integration review. Do not interpret focused checks as a full-project release certification.

Continue integration and the separate bug fix from these public branches on the destination development machine. No original-host workspace, cache path or original archive is needed by the documented build.

Integration repairs preserve current-main provider/credential/dashboard APIs and full lifecycle/readback briefs. CI checks out both repositories as siblings and builds SDK commit `4df054e3767d2af6568346daae0d29e85ed11d61` before installing Butchr. Registry dependencies were already outside the application's coverage scope; the sibling SDK is excluded on that same basis, with the application source/operator coverage gate and 90% threshold unchanged.

