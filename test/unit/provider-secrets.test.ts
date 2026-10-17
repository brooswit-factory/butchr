/**
 * local/ui — the Zendesk and Trello credentials (`src/setup/provider-secrets.ts`):
 * where they live, how a candidate is tested, the verified atomic write, the
 * startup fill-in, and the two non-secret settings.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { managedSecretPath, testTrelloBoard, testTrelloCredentials, testZendeskToken, writeVerifiedSecrets, type IdentityTest } from "../../src/setup/provider-secrets.js";
import { managedCredentialPath, resolveCredentialTarget } from "../../src/setup/secret-target.js";
import { resolveEffectiveProviderSecretsEnv } from "../../src/config/effective-env.js";
import { validateSettingValue } from "../../src/settings/settings-file.js";
import type { FetchLike } from "../../src/setup/jira-token-write.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "butchr-provider-secrets-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function recordingFetch(respond: (url: string, init: RequestInit) => Response | Promise<Response>): FetchLike & { calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return respond(url, init);
  }) as FetchLike & { calls: typeof calls };
  fn.calls = calls;
  return fn;
}

describe("where the Zendesk and Trello credentials live", () => {
  test("managed defaults sit beside the other secrets, and BUTCHR_SECRETS_DIR moves them all", () => {
    expect(managedSecretPath("zendesk-oauth-token", { HOME: "/h" })).toBe("/h/.config/butchr/secrets/zendesk-oauth-token");
    expect(managedSecretPath("trello-token", { XDG_CONFIG_HOME: "/x" })).toBe("/x/butchr/secrets/trello-token");
    expect(managedCredentialPath("trello-key", { BUTCHR_SECRETS_DIR: "/s" })).toBe("/s/trello-api-key");
  });

  test("an env-named file is the target; otherwise the managed file, set or not", () => {
    expect(resolveCredentialTarget("zendesk", { ZENDESK_OAUTH_TOKEN_FILE: "/etc/zd" }, () => true)).toMatchObject({ source: "env-file", path: "/etc/zd", fileEnvKey: "ZENDESK_OAUTH_TOKEN_FILE", managed: false, readOnlyReason: null });
    expect(resolveCredentialTarget("trello-token", { HOME: "/h" }, () => false)).toMatchObject({ source: "unset", path: "/h/.config/butchr/secrets/trello-token", fileEnvKey: "TRELLO_TOKEN_FILE", managed: true });
    expect(resolveCredentialTarget("trello-key", { HOME: "/h" }, () => true)).toMatchObject({ source: "secrets-file", fileEnvKey: "TRELLO_API_KEY_FILE" });
    expect(resolveCredentialTarget("zendesk", { ZENDESK_OAUTH_TOKEN_FILE: "relative/zd" }).readOnlyReason).toContain("absolute path");
  });

  test("the startup fill-in points each unset env var at its managed file when that exists, and never overrides the env", () => {
    const env = { HOME: "/h", TRELLO_TOKEN_FILE: "/mine/trello" };
    const exists = (p: string) => p.endsWith("zendesk-oauth-token") || p.endsWith("trello-api-key") || p.endsWith("secrets/trello-token");
    const out = resolveEffectiveProviderSecretsEnv(env, { managedTokenFileExists: exists });
    expect(out).toMatchObject({ ZENDESK_OAUTH_TOKEN_FILE: "/h/.config/butchr/secrets/zendesk-oauth-token", TRELLO_API_KEY_FILE: "/h/.config/butchr/secrets/trello-api-key", TRELLO_TOKEN_FILE: "/mine/trello" });
    expect(resolveEffectiveProviderSecretsEnv({ HOME: "/h" }, { managedTokenFileExists: () => false })).toEqual({ HOME: "/h" });
    expect(env).toEqual({ HOME: "/h", TRELLO_TOKEN_FILE: "/mine/trello" });
  });

  test("the subdomain and board id are allowlisted settings with strict validation", () => {
    expect(validateSettingValue("ZENDESK_SUBDOMAIN", " acme ")).toEqual({ ok: true, normalized: "acme" });
    expect(validateSettingValue("ZENDESK_SUBDOMAIN", "acme.zendesk.com").ok).toBe(false);
    expect(validateSettingValue("ZENDESK_SUBDOMAIN", "evil.com/x?").ok).toBe(false);
    expect(validateSettingValue("TRELLO_BOARD_ID", "0123456789abcdef01234567")).toEqual({ ok: true, normalized: "0123456789abcdef01234567" });
    expect(validateSettingValue("TRELLO_BOARD_ID", "abc123").ok).toBe(false);
  });
});

describe("testing a candidate", () => {
  test("Zendesk: users/me with a Bearer token, never following a redirect; the user's id and email come back", async () => {
    const fetchFn = recordingFetch(() => json(200, { user: { id: 42, email: "agent@acme.example", name: "Agent" } }));
    expect(await testZendeskToken("acme", "zd-token", fetchFn)).toEqual({ ok: true, id: "42", label: "agent@acme.example" });
    expect(fetchFn.calls[0]!.url).toBe("https://acme.zendesk.com/api/v2/users/me.json");
    expect(fetchFn.calls[0]!.init).toMatchObject({ method: "GET", redirect: "error" });
    expect((fetchFn.calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer zd-token");
  });

  test("Zendesk: an anonymous user, a 401, a redirect and a network failure are each a fixed-string failure", async () => {
    expect(await testZendeskToken("acme", "t", recordingFetch(() => json(200, { user: { id: null, name: "Anonymous user" } })))).toEqual({ ok: false, reason: "unauthorized" });
    expect(await testZendeskToken("acme", "t", recordingFetch(() => json(401, { error: "Couldn't authenticate you" })))).toEqual({ ok: false, reason: "unauthorized" });
    expect(await testZendeskToken("acme", "t", recordingFetch(() => { throw new TypeError("unexpected redirect to https://x?token=t"); }))).toEqual({ ok: false, reason: "redirect" });
    expect(await testZendeskToken("acme", "t", recordingFetch(() => { throw new TypeError("fetch failed https://x?token=t"); }))).toEqual({ ok: false, reason: "network" });
  });

  test("Trello: members/me with the key and token as query parameters; the member id and username come back", async () => {
    const fetchFn = recordingFetch(() => json(200, { id: "5abc", username: "butchr-bot" }));
    expect(await testTrelloCredentials("k1", "t1", fetchFn)).toEqual({ ok: true, id: "5abc", label: "butchr-bot" });
    const url = new URL(fetchFn.calls[0]!.url);
    expect([url.origin + url.pathname, url.searchParams.get("key"), url.searchParams.get("token")]).toEqual(["https://api.trello.com/1/members/me", "k1", "t1"]);
    expect(await testTrelloCredentials("k1", "bad", recordingFetch(() => new Response("invalid token", { status: 401 })))).toEqual({ ok: false, reason: "unauthorized" });
  });

  test("Trello board: its name, or not-found", async () => {
    expect(await testTrelloBoard("0123456789abcdef01234567", "k", "t", recordingFetch(() => json(200, { name: "Support" })))).toEqual({ ok: true, name: "Support" });
    expect(await testTrelloBoard("0123456789abcdef01234567", "k", "t", recordingFetch(() => new Response("not found", { status: 404 })))).toEqual({ ok: false, reason: "not-found" });
  });
});

describe("writeVerifiedSecrets", () => {
  const ok = (id: string, label = id): IdentityTest => ({ ok: true, id, label });

  test("tests the candidate first, then writes every file owner-only, in order, creating a managed directory at 0700", async () => {
    const secrets = join(dir, "secrets");
    const files = [{ path: join(secrets, "trello-api-key"), value: "key-1", createDir: true }, { path: join(secrets, "trello-token"), value: "tok-1", createDir: true }];
    const seen: string[][] = [];
    const out = await writeVerifiedSecrets(files, async (values) => { seen.push([...values]); return ok("m1", "bot"); }, { provider: "Trello" });
    expect(out).toEqual({ ok: true, label: "bot", rotated: false });
    expect(seen).toEqual([["key-1", "tok-1"]]);
    expect(readFileSync(files[0]!.path, "utf8")).toBe("key-1");
    expect(readFileSync(files[1]!.path, "utf8")).toBe("tok-1");
    expect(statSync(files[1]!.path).mode & 0o777).toBe(0o600);
    expect(statSync(secrets).mode & 0o777).toBe(0o700);
  });

  test("a failing candidate writes nothing", async () => {
    const path = join(dir, "zendesk-oauth-token");
    const out = await writeVerifiedSecrets([{ path, value: "bad", createDir: false }], async () => ({ ok: false, reason: "unauthorized" }), { provider: "Zendesk" });
    expect(out).toEqual({ ok: false, reason: "test-failed", error: "Zendesk rejected the credentials (401/403)" });
    expect(existsSync(path)).toBe(false);
  });

  test("replacing working credentials with another account's is refused; the same account rotates", async () => {
    const path = join(dir, "zendesk-oauth-token");
    writeFileSync(path, "old", { mode: 0o600 });
    const byValue = async ([v]: readonly string[]) => (v === "old" ? ok("1", "me@acme") : v === "same" ? ok("1", "me@acme") : ok("2", "other@acme"));
    expect(await writeVerifiedSecrets([{ path, value: "other", createDir: false }], byValue, { provider: "Zendesk" })).toEqual({ ok: false, reason: "identity-mismatch", currentLabel: "me@acme", candidateLabel: "other@acme" });
    expect(readFileSync(path, "utf8")).toBe("old");
    expect(await writeVerifiedSecrets([{ path, value: "same", createDir: false }], byValue, { provider: "Zendesk" })).toEqual({ ok: true, label: "me@acme", rotated: true });
    expect(readFileSync(path, "utf8")).toBe("same");
  });

  test("a current value that's simply revoked doesn't block the replacement; one that can't be checked does", async () => {
    const path = join(dir, "t");
    writeFileSync(path, "revoked", { mode: 0o600 });
    const revoked = async ([v]: readonly string[]): Promise<IdentityTest> => (v === "revoked" ? { ok: false, reason: "unauthorized" } : ok("9"));
    expect((await writeVerifiedSecrets([{ path, value: "fresh", createDir: false }], revoked, { provider: "Zendesk" })).ok).toBe(true);
    writeFileSync(path, "unreachable", { mode: 0o600 });
    const down = async ([v]: readonly string[]): Promise<IdentityTest> => (v === "unreachable" ? { ok: false, reason: "network" } : ok("9"));
    expect(await writeVerifiedSecrets([{ path, value: "fresh2", createDir: false }], down, { provider: "Zendesk" })).toMatchObject({ ok: false, reason: "current-unverifiable" });
    expect(readFileSync(path, "utf8")).toBe("unreachable");
  });

  test("never writes through a symlink, and a too-open existing file comes back 0600", async () => {
    const real = join(dir, "real");
    writeFileSync(real, "x");
    const link = join(dir, "link");
    symlinkSync(real, link);
    expect(await writeVerifiedSecrets([{ path: link, value: "v", createDir: false }], async () => ok("1"), { provider: "Trello" })).toEqual({ ok: false, reason: "destination-symlink", path: link });
    expect(readFileSync(real, "utf8")).toBe("x");
    const open = join(dir, "open");
    writeFileSync(open, "");
    chmodSync(open, 0o644);
    mkdirSync(join(dir, "unused"));
    expect((await writeVerifiedSecrets([{ path: open, value: "v", createDir: false }], async () => ok("1"), { provider: "Trello" })).ok).toBe(true);
    expect(statSync(open).mode & 0o777).toBe(0o600);
  });
});
