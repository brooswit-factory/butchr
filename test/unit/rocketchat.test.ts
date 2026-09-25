import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRocketChatClient,
  isRcUserNotFoundError,
  loadRocketChatAuth,
  RocketChatApiError,
  RocketChatHttpError,
  RC_MANAGED_TOKEN_NAME,
  type RocketChatTokenFileIo,
} from "../../src/resources/rocketchat.js";

// Never a real credential: every token below is a placeholder, and every request goes to a fake fetch.
const FAKE_TOKEN = "fake-rc-admin-token-for-tests";
const ADMIN_ID = "admin-id-1";
const URL_BASE = "https://chat.example.com";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

type Call = { method: string; url: string; body?: string; headers: Record<string, string>; redirect?: RequestInit["redirect"] };

describe("Rocket.Chat admin token loading", () => {
  const env = { ROCKETCHAT_URL: URL_BASE, ROCKETCHAT_ADMIN_USER_ID: ADMIN_ID, ROCKETCHAT_ADMIN_TOKEN_FILE: "/etc/butchr/rc-token" };
  const io = (over: Partial<{ isFile: boolean; mode: number; uid: number; text: string; statError: string }> = {}): RocketChatTokenFileIo => ({
    stat: () => {
      if (over.statError) throw Object.assign(new Error("nope"), { code: over.statError });
      return { isFile: () => over.isFile ?? true, mode: over.mode ?? 0o100600, uid: over.uid ?? 1000 };
    },
    readFile: () => over.text ?? `${FAKE_TOKEN}\n`,
    uid: 1000,
  });

  test("fails closed without all three settings, or a malformed URL", () => {
    expect(loadRocketChatAuth({}, io())).toEqual({ ok: false, reason: "set ROCKETCHAT_URL, ROCKETCHAT_ADMIN_USER_ID and ROCKETCHAT_ADMIN_TOKEN_FILE" });
    expect(loadRocketChatAuth({ ROCKETCHAT_URL: URL_BASE }, io())).toMatchObject({ ok: false });
    expect(loadRocketChatAuth({ ROCKETCHAT_URL: URL_BASE, ROCKETCHAT_ADMIN_USER_ID: ADMIN_ID }, io())).toMatchObject({ ok: false });
    expect(loadRocketChatAuth({ ...env, ROCKETCHAT_URL: "not a url" }, io())).toMatchObject({ ok: false, reason: expect.stringContaining("not a valid URL") });
    expect(loadRocketChatAuth({ ...env, ROCKETCHAT_URL: "ftp://chat.example.com" }, io())).toMatchObject({ ok: false, reason: expect.stringContaining("http(s)") });
  });

  test("the token file must be an owner-only regular file owned by the daemon user or root, holding one token", () => {
    expect(loadRocketChatAuth(env, io())).toEqual({ ok: true, url: URL_BASE, adminUserId: ADMIN_ID, adminToken: FAKE_TOKEN });
    expect(loadRocketChatAuth(env, io({ uid: 0, mode: 0o100400 }))).toMatchObject({ ok: true });
    const refusals: Array<[Parameters<typeof io>[0], string]> = [
      [{ mode: 0o100640 }, "group or others"],
      [{ mode: 0o100604 }, "group or others"],
      [{ uid: 1001 }, "owned by the daemon's user or root"],
      [{ isFile: false }, "not a regular file"],
      [{ statError: "ENOENT" }, "cannot be read: ENOENT"],
      [{ text: " \n" }, "is empty"],
      [{ text: `${FAKE_TOKEN} second-line` }, "one token"],
    ];
    for (const [over, why] of refusals) {
      const got = loadRocketChatAuth(env, io(over));
      expect(got).toMatchObject({ ok: false, reason: expect.stringContaining(why) });
      expect(JSON.stringify(got)).not.toContain(FAKE_TOKEN);
    }
  });

  test("reads a real owner-only file, trims a trailing slash off the URL, and refuses once group-readable", () => {
    const dir = mkdtempSync(join(tmpdir(), "butchr-rc-token-"));
    try {
      const path = join(dir, "token");
      writeFileSync(path, `${FAKE_TOKEN}\n`);
      chmodSync(path, 0o600);
      expect(loadRocketChatAuth({ ROCKETCHAT_URL: `${URL_BASE}/`, ROCKETCHAT_ADMIN_USER_ID: ADMIN_ID, ROCKETCHAT_ADMIN_TOKEN_FILE: path }))
        .toEqual({ ok: true, url: URL_BASE, adminUserId: ADMIN_ID, adminToken: FAKE_TOKEN });
      chmodSync(path, 0o640);
      expect(loadRocketChatAuth({ ROCKETCHAT_URL: URL_BASE, ROCKETCHAT_ADMIN_USER_ID: ADMIN_ID, ROCKETCHAT_ADMIN_TOKEN_FILE: path })).toMatchObject({ ok: false });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("Rocket.Chat client", () => {
  function fakeRc(handler: (path: string, method: string, body: unknown) => Response) {
    const calls: Call[] = [];
    const fetchImpl = async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ method, url, headers: init?.headers as Record<string, string>, ...(init?.redirect ? { redirect: init.redirect } : {}), ...(typeof init?.body === "string" ? { body: init.body } : {}) });
      const u = new URL(url);
      return handler(u.pathname + u.search, method, init?.body ? JSON.parse(init.body as string) : undefined);
    };
    const client = createRocketChatClient({ fetchImpl, url: URL_BASE, adminUserId: ADMIN_ID, adminToken: FAKE_TOKEN });
    return { calls, client };
  }

  test("every request carries the admin id/token pair, refuses redirects, and hits /api/v1 under the configured url", async () => {
    const { calls, client } = fakeRc((path) => path.startsWith("/api/v1/users.list") ? json({ total: 3 }) : json({}, 404));
    await client.countUsers();
    expect(calls).toHaveLength(1);
    const c = calls[0]!;
    expect(c.url).toBe(`${URL_BASE}/api/v1/users.list?count=1`);
    expect(c.headers["x-auth-token"]).toBe(FAKE_TOKEN);
    expect(c.headers["x-user-id"]).toBe(ADMIN_ID);
    expect(c.redirect).toBe("error");
  });

  test("getUserByUsername maps a found user and returns null for RC's not-found shapes, never throwing on a miss", async () => {
    const { client: found } = fakeRc((path) => path.includes("alice") ? json({ success: true, user: { _id: "u1", username: "alice", active: true } }) : json({}, 404));
    expect(await found.getUserByUsername("alice")).toEqual({ id: "u1", username: "alice", active: true });

    const { client: apiMiss } = fakeRc(() => json({ success: false, error: "User not found." }, 400));
    expect(await apiMiss.getUserByUsername("ghost")).toBeNull();

    // A bare 400/404 with no RC error string is ambiguous (could be a malformed
    // request) — this client only treats RC's own not-found TEXT as a miss,
    // never a bare status code (review finding, BUTCHR-410).
    const { client: plain400 } = fakeRc(() => json({}, 400));
    await expect(plain400.getUserByUsername("ghost")).rejects.toBeInstanceOf(RocketChatHttpError);

    const { client: otherApiError } = fakeRc(() => json({ success: false, error: "Invalid username" }, 400));
    await expect(otherApiError.getUserByUsername("bad name")).rejects.toBeInstanceOf(RocketChatApiError);

    const { client: serverDown } = fakeRc(() => json({}, 500));
    await expect(serverDown.getUserByUsername("x")).rejects.toBeInstanceOf(RocketChatHttpError);
  });

  test("countUsers reads .total and throws on an unexpected body", async () => {
    const { client: ok } = fakeRc(() => json({ total: 42 }));
    expect(await ok.countUsers()).toBe(42);
    const { client: bad } = fakeRc(() => json({ nope: true }));
    await expect(bad.countUsers()).rejects.toThrow("unexpected body");
  });

  test("createUser posts the expected shape and maps the created user, accepting either id or _id", async () => {
    const { calls, client } = fakeRc((path, method, body) => {
      expect(path).toBe("/api/v1/users.create");
      expect(method).toBe("POST");
      expect(body).toMatchObject({ username: "butchr_x", active: true, roles: ["user"] });
      return json({ success: true, user: { id: "u9", username: "butchr_x", active: true } });
    });
    const user = await client.createUser({ username: "butchr_x", name: "butchr_x", email: "butchr_x@butchr.invalid", password: "p" });
    expect(user).toEqual({ id: "u9", username: "butchr_x", active: true });
    expect(calls[0]!.headers["content-type"]).toBe("application/json");
  });

  test("createUser propagates RC's own uniqueness refusal as a typed API error naming the reason, never a silent success", async () => {
    const { client } = fakeRc(() => json({ success: false, error: "Username is already in use" }, 400));
    await expect(client.createUser({ username: "dupe", name: "dupe", email: "dupe@butchr.invalid", password: "p" })).rejects.toBeInstanceOf(RocketChatApiError);
    try {
      await client.createUser({ username: "dupe", name: "dupe", email: "dupe@butchr.invalid", password: "p" });
      throw new Error("unreached");
    } catch (e) {
      expect((e as RocketChatApiError).rcError).toBe("Username is already in use");
    }
  });

  test("deleteUser posts confirmRelinquish and the target userId", async () => {
    const { calls, client } = fakeRc((path, method, body) => {
      expect(path).toBe("/api/v1/users.delete");
      expect(method).toBe("POST");
      expect(body).toEqual({ userId: "u1", confirmRelinquish: true });
      return json({ success: true });
    });
    await client.deleteUser("u1");
    expect(calls).toHaveLength(1);
  });

  test("generateManagedToken always names RC_MANAGED_TOKEN_NAME and returns the issued token", async () => {
    const { calls, client } = fakeRc((path, _m, body) => {
      expect(path).toBe("/api/v1/users.generatePersonalAccessToken");
      expect(body).toEqual({ userId: "u1", tokenName: RC_MANAGED_TOKEN_NAME });
      return json({ success: true, token: "tok-abc" });
    });
    expect(await client.generateManagedToken("u1")).toBe("tok-abc");
    expect(calls).toHaveLength(1);
    const { client: bad } = fakeRc(() => json({ success: true }));
    await expect(bad.generateManagedToken("u1")).rejects.toThrow("unexpected body");
  });

  test("revokeManagedToken resolves quietly when RC reports no such token, but throws on a real server failure", async () => {
    const { calls, client: noToken } = fakeRc((path, _m, body) => {
      expect(path).toBe("/api/v1/users.removePersonalAccessToken");
      expect(body).toEqual({ userId: "u1", tokenName: RC_MANAGED_TOKEN_NAME });
      return json({ success: false, error: "Token not found" }, 400);
    });
    await expect(noToken.revokeManagedToken("u1")).resolves.toBeUndefined();
    expect(calls).toHaveLength(1);

    const { client: down } = fakeRc(() => json({}, 503));
    await expect(down.revokeManagedToken("u1")).rejects.toBeInstanceOf(RocketChatHttpError);

    const { client: otherApiError } = fakeRc(() => json({ success: false, error: "not authorized" }, 403));
    await expect(otherApiError.revokeManagedToken("u1")).rejects.toBeInstanceOf(RocketChatApiError);
  });

  test("isRcUserNotFoundError matches only RC's own not-found error text, never a bare status or an unrelated API error", () => {
    expect(isRcUserNotFoundError(new RocketChatApiError("x", "User not found."))).toBe(true);
    expect(isRcUserNotFoundError(new RocketChatApiError("x", "Invalid username"))).toBe(false);
    expect(isRcUserNotFoundError(new RocketChatHttpError(404, "x"))).toBe(false);
    expect(isRcUserNotFoundError(new Error("user not found"))).toBe(false);
  });

  test("no error message from this client ever contains the admin token", async () => {
    const { client } = fakeRc(() => json({}, 500));
    try { await client.countUsers(); throw new Error("unreached"); } catch (e) {
      expect((e as Error).message).not.toContain(FAKE_TOKEN);
    }
  });
});
