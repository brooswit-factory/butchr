bump: minor
### Added
- Antigravity as an explicit single-provider, per-role, or ordered-fallback factory choice.
- A workspace-aware stdio MCP bridge with separate identities for simultaneous workers and validated service-user registration.

### Changed
- Delegate exact-workspace unattended preparation and Antigravity launch flags to Drovr.
- Keep Claude-only quota detection and avoid Claude channel delivery to Antigravity clients.
- Refuse new AGY launches when the bridge is misconfigured or other global MCP identities would be inherited.
