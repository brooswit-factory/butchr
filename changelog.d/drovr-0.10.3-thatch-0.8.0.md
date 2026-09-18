bump: minor

### Changed
- Bump `@brooswit/drovr` to 0.10.3: Claude agents now get their development channel as one `--dangerously-load-development-channels=server:butchr` argument; agents already running with the two-argument spelling are not treated as stale.
- Bump `@brooswit/thatch` to 0.8.0: idle MCP sessions are now reaped. Butchr keeps sessions with no notification stream for 2h (codex/agy ticket agents never open one); a session whose stream dropped is reaped after 60s.
