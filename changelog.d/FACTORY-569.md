bump: patch

### Fixed

- **Windows CI (`windows` job) regressed from 324 to 461 test failures after
  FACTORY-558 (part of the FACTORY-555 native-Windows effort) made
  filesystem/session-definition path validation platform-aware.** The new
  failures were never product bugs — they were test FIXTURES hardcoding
  POSIX absolute-path literals (`/home/x/...`, `/w/...`) that the now
  platform-aware production code correctly rejects once the suite actually
  runs on `win32`. Added a test helper, `absPath` (`test/helpers/abs-path.ts`,
  mirroring `pathModuleFor`'s injectable-`platform` pattern), that returns a
  platform-native absolute path for a logical name — `absPath("home", "x")`
  is `/home/x` on posix (byte-identical to the literal it replaces) and
  `C:\home\x` on win32 — and used it across the affected fixtures.
- **`scripts/load/inventory.ts`'s `loadableFiles` mixed OS-native and
  POSIX separators**, the single largest Windows failure (216 of the 461):
  it built each file's identity from `node:path`'s `relative()`, which
  returns a backslash-separated string on win32, then treated that string as
  `/`-separated everywhere downstream (`loadTestPathFor`'s split, and the
  generated test's own ES module import specifier, which must always be
  `/`-separated regardless of host OS). Normalized to `/` once, at the
  source, instead of leaving each caller to assume a separator that was
  sometimes wrong.
- **A handful of tests asserted POSIX file-permission bits** (`stat().mode &
  0o777`, or a real `chmod` expected to enforce owner/group/other
  semantics) that NTFS has no equivalent of. Skipped on `win32` with
  `test.skipIf`/an inline platform guard and a one-line reason, matching
  this suite's existing `skipIf` convention (`test/unit/listen.test.ts`,
  `test/unit/mcp-loopback.test.ts`).
- **`definitionBasenameProblem` (`src/resources/session-archive.ts`) missed
  two Windows-only path-escape shapes**: a drive-relative name (`C:a.json`,
  no separator at all, resolves against drive `C:`'s own current directory
  rather than the archive/active dir) and an NTFS Alternate Data Stream
  name (`a.json:hidden`, a different underlying file). Both contain a bare
  `:`, which its existing `/`/`\` check didn't cover; a bare `:` anywhere in
  a caller-supplied basename is now rejected on every OS (this check gates
  `archiveSessionDefinition`/`unarchiveSessionDefinition`, so the fix is a
  small, targeted `src/` change alongside the otherwise fixture-only scope
  of this ticket).
