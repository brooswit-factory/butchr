bump: patch

### Changed

- Dependencies: butchr now consumes drovr 0.16.6, which emits Codex `--config`
  values as TOML literal strings on win32 so they survive herdr's PowerShell
  `Start-Process` argv re-parse (FACTORY-571..574).
