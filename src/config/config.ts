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
}

export interface ConfigEnv {
  ATLASSIAN_SITE?: string | undefined;
  ATLASSIAN_EMAIL?: string | undefined;
  ATLASSIAN_TOKEN?: string | undefined;
  ATLASSIAN_TOKEN_FILE?: string | undefined;
  BUTCHR_PORT?: string | undefined;
  HERDR_SOCKET?: string | undefined;
  BUTCHR_TERMINAL?: string | undefined;
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

  return {
    atlassian: { site, email, token },
    port,
    ...(env.HERDR_SOCKET ? { herdrSocket: env.HERDR_SOCKET } : {}),
    ...(env.BUTCHR_TERMINAL ? { terminalPrefix: env.BUTCHR_TERMINAL.trim().split(/\s+/).filter(Boolean) } : {}),
  };
}

function required(v: string | undefined, name: string): string {
  if (!v || !v.trim()) throw new Error(`Missing required config: ${name}`);
  return v.trim();
}

/** Never logs the token; use this to describe a config safely. */
export const describeConfig = (c: Config): string =>
  `site=${c.atlassian.site} email=${c.atlassian.email} token=***(${c.atlassian.token.length} chars) port=${c.port}`;
