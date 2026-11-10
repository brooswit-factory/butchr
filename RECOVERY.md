This branch integrates the recovered authority source with current main and fixes authoritative rule-OFF reconciliation. Releases and per-host deployments require the gates in `docs/recovery-rule-off-rollout.md`.

The original 342 inputs (299 application, 43 SDK) were recovered and hash-verified locally. The public payload excludes private Git history, credentials, native conversations, runtime state, permits, receipts, host-specific operational records and opaque dependency archives. Terminal parser specimens use synthetic replacements; parser assertions remain intact. Private service links use an example domain.

Use Bun 1.3.11 and Node 20.20.2. Clone the approved Drovr recovery next to this checkout as `../drovr`, pinned to `76920cd0a64cf6d7cc1ea895f23a7fad9ee2fc87`:

```sh
git clone https://github.com/brooswit-factory/drovr.git ../drovr
git -C ../drovr checkout 76920cd0a64cf6d7cc1ea895f23a7fad9ee2fc87
(cd ../drovr && bun install --frozen-lockfile --ignore-scripts && bun run build)
(cd ../drovr/legacy-events && bun install --frozen-lockfile --ignore-scripts && bun run build)
bun install --frozen-lockfile --ignore-scripts
bun run typecheck
bun run typecheck:web
bun run build
```

Local validation: backend and web builds, both application typechecks, SDK source-module parity (150/150 and 152/152), 112 SDK tests and 503 focused application/parser/operator tests passed. Builds report their actual current Git identity; they do not impersonate the preserved dirty source revision.

Two integration tests requiring an external private server checkout and one host-definition example test are excluded from this recovery payload. Their originals remain preserved locally. Existing public files outside the source overlay retain the main-branch baseline. The inherited project suite, release gate, sibling-checkout build and spawn smoke remain enforced by CI. Do not interpret focused checks as full-project release certification.

Continue development from these public branches on the destination development machine. No original-host workspace, cache path or original archive is needed by the documented build.

Integration repairs preserve current-main provider/credential/dashboard APIs and full lifecycle/readback briefs. CI checks out both repositories as siblings and builds SDK commit `76920cd0a64cf6d7cc1ea895f23a7fad9ee2fc87` before installing Butchr. Registry dependencies were already outside the application's coverage scope; the sibling SDK is excluded on that same basis, with the application source/operator coverage gate and 90% threshold unchanged.

Rule OFF reconciliation runs before discovery fencing. It requires current authenticated authority, an explicit disabled rule, known exact rule ownership and a fresh complete worker census. Every destructive RPC retains the numeric generation lease. Missing/invalid configuration, disconnects, uncertain inventory, stale leases and partial handoffs preserve workers. Master pause remains a pause. Human and legacy local session workers are outside this sweep.

Staged provider handoff uses a distinct deterministic transaction target name while the source remains live. Exact pane/native identity, full history import and acknowledged commit continue to govern retirement. The real-Herdr CI smoke verifies conflicting names are rejected and both source and staged target survive until cleanup.
