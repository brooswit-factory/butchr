/**
 * Butchr's configuration, parsed from the environment once at startup.
 *
 * The Atlassian credential is a classic API token used as HTTP Basic auth
 * (`email:token`). The token is read from `ATLASSIAN_TOKEN`, or — preferred —
 * from a file named by `ATLASSIAN_TOKEN_FILE`, so it never has to sit in the
 * process environment or a shell history.
 */
export interface Config {
  atlassian: { site: string; email: string; token: string };
  /** Port the daemon serves the MCP endpoint and the live-view webapp on. */
  port: number;
  /** herdr socket; defaults to herdr's own default when unset. */
  herdrSocket?: string;
  /** Terminal-emulator prefix for opening an agent shell; detected at startup if unset. */
  terminalPrefix?: string[];
  /**
   * GitHub PR discovery (pr:* labels). Both a token and at least one org are
   * required — an unscoped GitHub search spans all of GitHub, not just ours —
   * so this is present only when BOTH GITHUB_TOKEN_FILE and
   * BUTCHR_GITHUB_ORGS are set; otherwise pr:* discovery is skipped entirely.
   */
  github?: { token: string; orgs: string[] };
  /**
   * KAN-804/807: minutes an active ticket's agent must sit idle/done,
   * continuously since first observed running, with zero comments from this
   * account, before it's surfaced as `agent:stalled` — a swallowed kickoff
   * "idle since spawn, never spoke" must never look like a finished agent.
   */
  stalledMinutes: number;
}

export interface ConfigEnv {
  ATLASSIAN_SITE?: string | undefined;
  ATLASSIAN_EMAIL?: string | undefined;
  ATLASSIAN_TOKEN?: string | undefined;
  ATLASSIAN_TOKEN_FILE?: string | undefined;
  BUTCHR_PORT?: string | undefined;
  HERDR_SOCKET?: string | undefined;
  BUTCHR_TERMINAL?: string | undefined;
  GITHUB_TOKEN_FILE?: string | undefined;
  BUTCHR_GITHUB_ORGS?: string | undefined;
  BUTCHR_STALLED_MINUTES?: string | undefined;
}

/** `readFile` is injected so config parsing stays pure and testable. */
export function loadConfig(env: ConfigEnv, readFile: (path: string) => string): Config {
  const site = required(env.ATLASSIAN_SITE, "ATLASSIAN_SITE").replace(/\/+$/, "");
  const email = required(env.ATLASSIAN_EMAIL, "ATLASSIAN_EMAIL");
  const token = env.ATLASSIAN_TOKEN_FILE
    ? readFile(env.ATLASSIAN_TOKEN_FILE).trim()
    : required(env.ATLASSIAN_TOKEN, "ATLASSIAN_TOKEN (or ATLASSIAN_TOKEN_FILE)");
  if (!token) throw new Error("Atlassian token is empty");

  const port = env.BUTCHR_PORT ? Number(env.BUTCHR_PORT) : 7717;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`BUTCHR_PORT is not a valid port: ${env.BUTCHR_PORT}`);

  const githubToken = env.GITHUB_TOKEN_FILE ? readFile(env.GITHUB_TOKEN_FILE).trim() : undefined;
  const githubOrgs = env.BUTCHR_GITHUB_ORGS ? env.BUTCHR_GITHUB_ORGS.split(",").map((o) => o.trim()).filter(Boolean) : [];
  const github = githubToken && githubOrgs.length ? { token: githubToken, orgs: githubOrgs } : undefined;

  const stalledMinutes = env.BUTCHR_STALLED_MINUTES ? Number(env.BUTCHR_STALLED_MINUTES) : 10;
  if (!Number.isFinite(stalledMinutes) || stalledMinutes <= 0) throw new Error(`BUTCHR_STALLED_MINUTES is not a positive number: ${env.BUTCHR_STALLED_MINUTES}`);

  return {
    atlassian: { site, email, token },
    port,
    stalledMinutes,
    ...(env.HERDR_SOCKET ? { herdrSocket: env.HERDR_SOCKET } : {}),
    ...(env.BUTCHR_TERMINAL ? { terminalPrefix: env.BUTCHR_TERMINAL.trim().split(/\s+/).filter(Boolean) } : {}),
    ...(github ? { github } : {}),
  };
}

function required(v: string | undefined, name: string): string {
  if (!v || !v.trim()) throw new Error(`Missing required config: ${name}`);
  return v.trim();
}

/** Never logs a token value; use this to describe a config safely. */
export const describeConfig = (c: Config): string =>
  `site=${c.atlassian.site} email=${c.atlassian.email} token=***(${c.atlassian.token.length} chars) port=${c.port} ` +
  `github=${c.github ? `orgs=${c.github.orgs.join(",")} token=***(${c.github.token.length} chars)` : "disabled"} ` +
  `stalledMinutes=${c.stalledMinutes}`;
