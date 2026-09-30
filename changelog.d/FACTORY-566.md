bump: patch

### Changed

- Dependencies: butchr now consumes drovr 0.16.5, which resolves
  `@brooswit/herdr-sdk` 0.3.0 (the `node:net` transport that speaks herdr's
  named pipe on native Windows; the previous drovr 0.16.4 resolved 0.1.3, a
  Unix-socket-only SDK, so a native Windows daemon could not reach herdr). A
  `bun` `overrides` entry pins one `@brooswit/herdr-sdk` for the whole tree,
  because the vendored `@brooswit/drovr-events` tarball still declares
  `^0.1.3` and would otherwise install a second, nested copy.
