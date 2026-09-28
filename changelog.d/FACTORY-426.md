---
bump: patch
---

### Fixed

- The FACTORY-312/FACTORY-314 resume-in-place mechanism now actually runs in production. `scopedHerd` (`src/daemon/loop.ts`) — the one wrapper the daemon's real reconcile call site goes through — explicitly delegates each `Herd` member instead of spreading, and had never listed `resumeInPlace` (or `providerOf`): `herd.resumeInPlace` was silently `undefined` inside the wrapper, so a genuine band-crossing model/effort change (e.g. resolved effort medium→max) always fell through to a full stop+respawn, discarding the conversation, despite FACTORY-314's own regression suite passing (those tests called `reconcileNow` directly, bypassing `scopedHerd` entirely). `resumeInPlace` is now forwarded, and made a REQUIRED member of the `Herd` interface (previously optional) so a future member added to `Herd` and omitted from `scopedHerd`'s explicit list fails to compile instead of silently no-op-ing in production. `providerOf` is also now forwarded, though it stays optional (no current caller reaches it through `scopedHerd`).
