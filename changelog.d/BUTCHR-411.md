bump: minor

### Added

- A rule can bind its agent(s) to additional MCP servers beyond butchr's own
  (`Rule.mcpServers`), each flagged `channel: true|false`. A `channel: true`
  binding adds its own `--dangerously-load-development-channels=server:<name>`
  flag for Claude (`server:butchr` always stays first) so Claude receives
  that server's push notifications with no polling substitute — the exact
  mechanism `server:butchr` already relies on, generalized to any MCP
  channel server (e.g. Candlestix's shared `mud-mcp` HTTP bridge). Every
  binding also lands in `mcp.json` (Claude) or the launch's `mcpServers`
  (Codex, tools only — Codex has no development-channel concept). A rule
  with no `mcpServers` is unaffected: byte-identical argv/mcp.json, and
  `staleIssues()` does not respawn any existing agent on deploy. A bound
  server's optional `headersEnvVar` (never a literal header value in the
  rules file) is resolved only into a Claude workspace's `mcp.json`, chmod
  0600 whenever it carries one; a Codex agent never receives bound-server
  headers at all, since Codex would otherwise put them in cleartext on its
  own process command line. See `docs/mcp-server-bindings.md`.
