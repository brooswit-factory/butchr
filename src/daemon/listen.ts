/**
 * Where the daemon's HTTP server (MCP, /health, dashboard) listens.
 *
 * Measured on Bun 1.3.11 + Elysia: `app.listen(port)` binds `*:port` (every
 * interface, IPv4 and IPv6) while `server.hostname` still reports
 * "localhost". The MCP endpoint serves write-capable Jira, Confluence and
 * GitHub tools with no authentication beyond caller-asserted identity
 * headers, so it must never be reachable off-host.
 *
 * Loopback only, with no opt-in: every client (agent MCP configs, the stdio
 * bridge, Drovr/Herdr launches) dials `http://localhost:<port>`, and nothing
 * in the deployment reaches the daemon from another machine.
 */
export const DAEMON_HOSTNAME = "127.0.0.1";

export const listenOptions = (port: number): { port: number; hostname: string } => ({ port, hostname: DAEMON_HOSTNAME });
