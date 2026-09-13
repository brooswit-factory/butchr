# Antigravity Worker Isolation

Butchr delegates Antigravity home preparation to Drovr. Each workspace path
maps to a separate home under `$XDG_STATE_HOME/butchr/agy-homes/`, defaulting
to `~/.local/state/butchr/agy-homes/`. Herdr receives this HOME when it creates
the workspace. Provider preference remains controlled by the usual ordered
provider configuration.

The home contains exact-path workspace trust and a single stdio MCP server:
the built Butchr bridge. The bridge derives project or issue identity from
the workspace metadata. Personal MCP registrations, including USRR's YAPPR
connection, are not inherited or modified. Build `dist/butchr-mcp.js` before
starting the daemon; a missing bridge disables new Antigravity launches.

Local validation demonstrated that the installed Antigravity CLI can run
with an isolated HOME and the existing machine authentication. This is not
a guarantee for another machine: authenticate there and verify a read-only
MCP call before assigning production work. No credentials are copied into
the generated home by Butchr or Drovr.
