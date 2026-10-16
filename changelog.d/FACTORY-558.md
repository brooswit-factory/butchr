bump: patch

### Fixed

- **The `filesystem`/`session-definition` absolute-path checks were POSIX-only
  (FACTORY-558, part of the FACTORY-555 native-Windows effort).**
  `filesystemQueryProblems`'s `root`, `session-definition`'s
  `workingDirectory`, and `isFilesystemResourceId`'s canonical resource-id
  shape all decided "absolute" by checking for a leading `/` and split
  segments on a literal `/` — a Windows path (`C:\Users\x`, `C:/Users/x`, a
  `~\`/`~/` home form, a UNC `\\server\share`) was rejected outright. Each
  now takes an injectable `platform: NodeJS.Platform` (defaulting to
  `process.platform`) and validates through `node:path`'s `win32`/`posix`
  module accordingly, so the exact same logic — and the exact same unit
  tests — exercise both platforms on any OS. `isFilesystemResourceId` also
  picks ONE canonical Windows spelling (backslash-separated, matching
  `realpath`'s own native output there) rather than accepting two spellings
  of the same resource. Linux/macOS behavior, error messages, and every
  pre-existing test are unchanged.
- **The `MAX_ENCODED_SEGMENT_BYTES` workspace directory-name-limit warning
  described itself in Linux-only terms** (`NAME_MAX`, "bytes") even though
  the same 255 figure is also NTFS's own per-path-component limit (255
  UTF-16 code units, which for the pure-ASCII percent-encoded name this
  check measures is the same count as UTF-8 bytes). The doc comment and the
  runtime skip-log message now say so; the limit itself is unchanged
  (nothing loosened on Linux), and this still does not cover Windows' own
  separate `MAX_PATH` total-path constraint — left for a follow-up.
