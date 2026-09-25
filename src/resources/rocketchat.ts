/**
 * Rocket.Chat (RC) REST client and admin-credential loading — the RC half of
 * BUTCHR-395's account lifecycle (see `../accounts/manager.ts` for the
 * policy/persistence half this client is injected into).
 *
 * Auth is an admin (userId, authToken) PAIR, sent as `X-User-Id`/`X-Auth-Token`
 * on every request — RC has no bearer-token auth. The token is read from
 * `ROCKETCHAT_ADMIN_TOKEN_FILE` only (never `ROCKETCHAT_ADMIN_TOKEN` — there is
 * no raw-env fallback for this one, unlike Zendesk/Atlassian, because unlike
 * those this is a fresh integration with no existing deployments to keep
 * working), with the same file-permission discipline as
 * `../resources/zendesk-ticket.ts`'s `loadZendeskAuth`: a regular file, owned
 * by the daemon's user (or root), unreadable by group or other. The admin
 * user id and server URL are not secrets and are read from plain env vars.
 * Every request refuses redirects, so the token is only ever sent to the
 * configured `ROCKETCHAT_URL`.
 */
import { readFileSync, statSync } from "node:fs";
import type { FetchLike } from "../labels/pr.js";

export interface RocketChatUser {
  id: string;
  username: string;
  active: boolean;
}

export class RocketChatHttpError extends Error {
  constructor(readonly status: number, what: string) {
    super(`Rocket.Chat ${what} failed: HTTP ${status}`);
    this.name = "RocketChatHttpError";
  }
}

/** A well-formed RC response body reporting `success: false` — a request-level refusal, not a transport failure. */
export class RocketChatApiError extends Error {
  constructor(what: string, readonly rcError: string) {
    super(`Rocket.Chat ${what} failed: ${rcError}`);
    this.name = "RocketChatApiError";
  }
}

export interface RocketChatAuthEnv {
  [name: string]: string | undefined;
  ROCKETCHAT_URL?: string | undefined;
  ROCKETCHAT_ADMIN_USER_ID?: string | undefined;
  ROCKETCHAT_ADMIN_TOKEN_FILE?: string | undefined;
}

/** The filesystem facts token loading depends on, injectable for tests — same shape as `ZendeskTokenFileIo`. */
export interface RocketChatTokenFileIo {
  stat: (path: string) => { isFile(): boolean; mode: number; uid: number };
  readFile: (path: string) => string;
  /** The daemon's uid, or undefined where the platform has none. */
  uid: number | undefined;
}

const realIo: RocketChatTokenFileIo = { stat: (p) => statSync(p), readFile: (p) => readFileSync(p, "utf8"), uid: process.getuid?.() };

export type RocketChatAuth = { ok: true; url: string; adminUserId: string; adminToken: string } | { ok: false; reason: string };

/**
 * Reads Rocket.Chat admin configuration, failing closed with a reason that
 * never contains token material. Only called when an enabled rule needs an
 * RC account (`account !== "none"`), so a daemon with no such rule never
 * touches the token file — mirrors `loadZendeskAuth`'s own "dormant until
 * needed" contract exactly.
 */
export function loadRocketChatAuth(env: RocketChatAuthEnv, io: RocketChatTokenFileIo = realIo): RocketChatAuth {
  const rawUrl = env.ROCKETCHAT_URL?.trim();
  const adminUserId = env.ROCKETCHAT_ADMIN_USER_ID?.trim();
  const path = env.ROCKETCHAT_ADMIN_TOKEN_FILE?.trim();
  if (!rawUrl || !adminUserId || !path) return { ok: false, reason: "set ROCKETCHAT_URL, ROCKETCHAT_ADMIN_USER_ID and ROCKETCHAT_ADMIN_TOKEN_FILE" };
  let url: URL;
  try { url = new URL(rawUrl); } catch { return { ok: false, reason: `ROCKETCHAT_URL is not a valid URL: ${JSON.stringify(rawUrl)}` }; }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false, reason: `ROCKETCHAT_URL must be http(s): ${JSON.stringify(rawUrl)}` };
  let st: ReturnType<RocketChatTokenFileIo["stat"]>;
  try { st = io.stat(path); } catch (e) { return { ok: false, reason: `ROCKETCHAT_ADMIN_TOKEN_FILE ${path} cannot be read: ${(e as NodeJS.ErrnoException).code ?? "error"}` }; }
  if (!st.isFile()) return { ok: false, reason: `ROCKETCHAT_ADMIN_TOKEN_FILE ${path} is not a regular file` };
  if (st.mode & 0o077) return { ok: false, reason: `ROCKETCHAT_ADMIN_TOKEN_FILE ${path} is accessible to group or others (mode ${(st.mode & 0o777).toString(8)}); chmod 600 it` };
  if (io.uid !== undefined && st.uid !== io.uid && st.uid !== 0) return { ok: false, reason: `ROCKETCHAT_ADMIN_TOKEN_FILE ${path} must be owned by the daemon's user or root` };
  let token: string;
  try { token = io.readFile(path).trim(); } catch (e) { return { ok: false, reason: `ROCKETCHAT_ADMIN_TOKEN_FILE ${path} cannot be read: ${(e as NodeJS.ErrnoException).code ?? "error"}` }; }
  if (!token) return { ok: false, reason: `ROCKETCHAT_ADMIN_TOKEN_FILE ${path} is empty` };
  if (/[^\x21-\x7e]/.test(token)) return { ok: false, reason: `ROCKETCHAT_ADMIN_TOKEN_FILE ${path} must hold one token and nothing else` };
  return { ok: true, url: rawUrl.replace(/\/+$/, ""), adminUserId, adminToken: token };
}

export interface RocketChatClientDeps {
  fetchImpl: FetchLike;
  url: string;
  adminUserId: string;
  adminToken: string;
  log?: (line: string) => void;
}

/** The one Personal Access Token this client ever creates per user — a fixed, recognisable name, never a parameter. */
export const RC_MANAGED_TOKEN_NAME = "butchr-managed";

const RC_TOKEN_NOT_FOUND_RE = /token.*not.*found|not.*found.*token|no such token/i;
const RC_USER_NOT_FOUND_RE = /user not found/i;

/**
 * Whether `e` is RC's own "no such user" refusal — matched on RC's error
 * TEXT only, never a bare HTTP status. A bare 400/404 with no RC error
 * string is ambiguous (could just as well be a malformed request) and is
 * surfaced as a real error rather than silently read as "not found" — a
 * review finding on this module's first pass (BUTCHR-410).
 */
export function isRcUserNotFoundError(e: unknown): boolean {
  return e instanceof RocketChatApiError && RC_USER_NOT_FOUND_RE.test(e.rcError);
}

export interface RocketChatClient {
  /** Looks up a user by username; `null` when RC reports no such user (never thrown — a miss is an expected outcome for a fresh agent key). */
  getUserByUsername(username: string): Promise<RocketChatUser | null>;
  /** Total user count RC's own admin panel would show — the guardrail reads this before every create. */
  countUsers(): Promise<number>;
  /** Creates a new user. Never called by this client's own callers without a cap check first (see `../accounts/manager.ts`). */
  createUser(input: { username: string; name: string; email: string; password: string }): Promise<RocketChatUser>;
  /** Deletes a user outright — see `docs/rocketchat-accounts.md` for why delete, not deactivate. */
  deleteUser(userId: string): Promise<void>;
  /** Issues a fresh `RC_MANAGED_TOKEN_NAME` Personal Access Token for `userId` — the "connection material" `ensureAccount` hands a launcher. */
  generateManagedToken(userId: string): Promise<string>;
  /** Revokes the `RC_MANAGED_TOKEN_NAME` PAT for `userId`. Resolves quietly when there is none to revoke; throws on a real transport/server failure. */
  revokeManagedToken(userId: string): Promise<void>;
}

export function createRocketChatClient(deps: RocketChatClientDeps): RocketChatClient {
  const base = `${deps.url}/api/v1`;
  const headers = { "x-auth-token": deps.adminToken, "x-user-id": deps.adminUserId, accept: "application/json" };
  const request = async (path: string, what: string, init: RequestInit = {}): Promise<{ status: number; body: any }> => {
    // redirect "error": the admin token must never be carried to another URL by a redirect.
    const res = await deps.fetchImpl(`${base}${path}`, { ...init, headers: { ...headers, ...(init.headers as Record<string, string> | undefined) }, redirect: "error" });
    let body: any = null;
    try { body = await res.json(); } catch { /* some RC responses (e.g. 204) have no body */ }
    if (!res.ok) {
      const rcError = body && typeof body === "object" && typeof body.error === "string" ? body.error : null;
      throw rcError ? new RocketChatApiError(what, rcError) : new RocketChatHttpError(res.status, what);
    }
    if (body && typeof body === "object" && body.success === false) throw new RocketChatApiError(what, typeof body.error === "string" ? body.error : "unknown error");
    return { status: res.status, body };
  };
  const mapUser = (u: any): RocketChatUser => ({ id: String(u.id ?? u._id), username: String(u.username), active: u.active !== false });
  return {
    async getUserByUsername(username) {
      try {
        const { body } = await request(`/users.info?username=${encodeURIComponent(username)}`, "user lookup");
        if (!body || typeof body !== "object" || !body.user) throw new Error("Rocket.Chat user lookup returned an unexpected body");
        return mapUser(body.user);
      } catch (e) {
        if (isRcUserNotFoundError(e)) return null;
        throw e;
      }
    },
    async countUsers() {
      const { body } = await request("/users.list?count=1", "user count");
      if (!body || typeof body !== "object" || typeof body.total !== "number") throw new Error("Rocket.Chat user count returned an unexpected body");
      return body.total;
    },
    async createUser(input) {
      const { body } = await request("/users.create", "user create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: input.username, name: input.name, email: input.email, password: input.password, active: true, roles: ["user"], joinDefaultChannels: false, sendWelcomeEmail: false, verified: true }),
      });
      if (!body || typeof body !== "object" || !body.user) throw new Error("Rocket.Chat user create returned an unexpected body");
      return mapUser(body.user);
    },
    async deleteUser(userId) {
      await request("/users.delete", "user delete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ userId, confirmRelinquish: true }) });
    },
    async generateManagedToken(userId) {
      const { body } = await request("/users.generatePersonalAccessToken", "token generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId, tokenName: RC_MANAGED_TOKEN_NAME }),
      });
      if (!body || typeof body !== "object" || typeof body.token !== "string" || !body.token) throw new Error("Rocket.Chat token generate returned an unexpected body");
      return body.token;
    },
    async revokeManagedToken(userId) {
      try {
        await request("/users.removePersonalAccessToken", "token revoke", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ userId, tokenName: RC_MANAGED_TOKEN_NAME }),
        });
      } catch (e) {
        if (e instanceof RocketChatApiError && RC_TOKEN_NOT_FOUND_RE.test(e.rcError)) return;
        throw e;
      }
    },
  };
}
