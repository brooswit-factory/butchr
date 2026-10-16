import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  testCandidateJiraToken, fixedMyselfTestErrorFor, writeJiraToken, jiraTokenFilePath, defaultJiraTokenWriteIo,
  type JiraTokenWriteIo, type FetchLike,
} from "../../src/setup/jira-token-write.js";

const CANARY_TOKEN = "s3cr3t-canary-TOKEN-should-never-leak-anywhere";
const SITE = "https://x.atlassian.net";

function okFetch(accountId: string, displayName = "Someone"): FetchLike {
  return async () => new Response(JSON.stringify({ accountId, displayName }), { status: 200 });
}
function statusFetch(status: number): FetchLike {
  return async () => new Response("upstream body with secrets should never be read", { status });
}
function throwingFetch(message: string): FetchLike {
  return async () => { throw new Error(message); };
}

describe("testCandidateJiraToken", () => {
  test("2xx with a valid body: ok, extracts accountId/displayName only", async () => {
    const r = await testCandidateJiraToken({ site: SITE, email: "a@b.c", token: CANARY_TOKEN }, okFetch("acct-1", "Ada"));
    expect(r).toEqual({ ok: true, accountId: "acct-1", displayName: "Ada" });
  });
  test("falls back to accountId as displayName when displayName is missing", async () => {
    const r = await testCandidateJiraToken({ site: SITE, email: "a@b.c", token: CANARY_TOKEN }, async () => new Response(JSON.stringify({ accountId: "acct-2" }), { status: 200 }));
    expect(r).toEqual({ ok: true, accountId: "acct-2", displayName: "acct-2" });
  });
  test("401/403 -> unauthorized, never the body", async () => {
    expect(await testCandidateJiraToken({ site: SITE, email: "a", token: CANARY_TOKEN }, statusFetch(401))).toEqual({ ok: false, reason: "unauthorized" });
    expect(await testCandidateJiraToken({ site: SITE, email: "a", token: CANARY_TOKEN }, statusFetch(403))).toEqual({ ok: false, reason: "unauthorized" });
  });
  test("other non-2xx status -> other", async () => {
    expect(await testCandidateJiraToken({ site: SITE, email: "a", token: CANARY_TOKEN }, statusFetch(500))).toEqual({ ok: false, reason: "other" });
  });
  test("a 2xx body missing accountId -> other (never throws on a malformed response)", async () => {
    const r = await testCandidateJiraToken({ site: SITE, email: "a", token: CANARY_TOKEN }, async () => new Response(JSON.stringify({ foo: "bar" }), { status: 200 }));
    expect(r).toEqual({ ok: false, reason: "other" });
  });
  test("fetch throwing a redirect-shaped error -> reason 'redirect', message never surfaced", async () => {
    const r = await testCandidateJiraToken({ site: SITE, email: "a", token: CANARY_TOKEN }, throwingFetch("unexpected redirect, redirect mode is set to error"));
    expect(r).toEqual({ ok: false, reason: "redirect" });
  });
  test("a network failure/timeout -> reason 'network'", async () => {
    const r = await testCandidateJiraToken({ site: SITE, email: "a", token: CANARY_TOKEN }, throwingFetch("fetch failed"));
    expect(r).toEqual({ ok: false, reason: "network" });
  });
  test("passes redirect: 'error' explicitly, and never exposes the Authorization header to the caller", async () => {
    let seenInit: RequestInit | undefined;
    const fetchFn: FetchLike = async (_url, init) => { seenInit = init; return new Response(JSON.stringify({ accountId: "a" }), { status: 200 }); };
    const r = await testCandidateJiraToken({ site: SITE, email: "a@b.c", token: CANARY_TOKEN }, fetchFn);
    expect(seenInit?.redirect).toBe("error");
    expect(JSON.stringify(r)).not.toContain(CANARY_TOKEN);
  });
});

describe("fixedMyselfTestErrorFor", () => {
  test("every reason maps to a fixed, non-empty string with no interpolation", () => {
    for (const reason of ["unauthorized", "redirect", "network", "other"] as const) {
      expect(typeof fixedMyselfTestErrorFor(reason)).toBe("string");
      expect(fixedMyselfTestErrorFor(reason).length).toBeGreaterThan(0);
    }
  });
});

describe("jiraTokenFilePath", () => {
  test("resolves under XDG_CONFIG_HOME/butchr/secrets, or BUTCHR_SECRETS_DIR override", () => {
    expect(jiraTokenFilePath({ XDG_CONFIG_HOME: "/xdg" })).toBe("/xdg/butchr/secrets/atlassian-token");
    expect(jiraTokenFilePath({ BUTCHR_SECRETS_DIR: "/custom" })).toBe("/custom/atlassian-token");
  });
});

/** In-memory `JiraTokenWriteIo` — no real filesystem touched, and exposes exactly what was written for the "never leaks the value" assertions below. */
function fakeIo(initial?: { content: string; mode: number; isSymlink?: boolean }) {
  const files = new Map<string, { content: string; mode: number; isSymlink: boolean }>();
  const dirs = new Set<string>();
  const dirModes = new Map<string, number>();
  const path = "/home/u/.config/butchr/secrets/atlassian-token";
  if (initial) files.set(path, { content: initial.content, mode: initial.mode, isSymlink: initial.isSymlink ?? false });
  const io: JiraTokenWriteIo = {
    readFile: (p) => files.get(p)?.content,
    mkdir: (dir) => { dirs.add(dir); },
    modeOf: (p) => (dirs.has(p) ? (dirModes.get(p) ?? 0o755) : files.get(p)?.mode),
    isSymlink: (p) => files.get(p)?.isSymlink ?? false,
    writeTempExclusive: (p, text, mode) => { if (files.has(p)) throw Object.assign(new Error("EEXIST"), { code: "EEXIST" }); files.set(p, { content: text, mode, isSymlink: false }); },
    rename: (tmp, dest) => { const v = files.get(tmp); if (!v) throw new Error("no such temp file"); files.delete(tmp); files.set(dest, v); },
    removeQuiet: (p) => { files.delete(p); },
  };
  return { io, files, path, dirs };
}

describe("defaultJiraTokenWriteIo (real filesystem)", () => {
  test("readFile/mkdir/modeOf/isSymlink/writeTempExclusive/rename/removeQuiet round-trip against a real temp dir", () => {
    const dir = mkdtempSync(join(tmpdir(), "jira-token-write-test-"));
    try {
      const io = defaultJiraTokenWriteIo();
      expect(io.readFile(join(dir, "missing"))).toBeUndefined();
      expect(io.modeOf(join(dir, "missing"))).toBeUndefined();
      expect(io.isSymlink(join(dir, "missing"))).toBe(false);

      const target = join(dir, "real-file");
      writeFileSync(target, "hello", { mode: 0o600 });
      expect(io.readFile(target)).toBe("hello");
      expect(io.modeOf(target)).toBe(0o600);
      expect(io.isSymlink(target)).toBe(false);

      const link = join(dir, "a-symlink");
      symlinkSync(target, link);
      expect(io.isSymlink(link)).toBe(true);

      const sub = join(dir, "sub", "nested");
      io.mkdir(sub);
      expect(io.modeOf(sub)).toBeDefined();

      const tmp = join(dir, ".tmp-file");
      io.writeTempExclusive(tmp, "secret-value", 0o600);
      expect(io.modeOf(tmp)).toBe(0o600);
      expect(() => io.writeTempExclusive(tmp, "again", 0o600)).toThrow(); // O_EXCL refuses an existing path

      const dest = join(dir, "dest");
      io.rename(tmp, dest);
      expect(io.readFile(dest)).toBe("secret-value");

      io.removeQuiet(dest);
      expect(io.readFile(dest)).toBeUndefined();
      io.removeQuiet(join(dir, "never-existed")); // best-effort: never throws
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("writeJiraToken", () => {
  test("fresh setup (no current file): tests the candidate, writes atomically, reports rotated:false", async () => {
    const { io, files, path } = fakeIo();
    const outcome = await writeJiraToken({ site: SITE, email: "a@b.c", token: CANARY_TOKEN }, path, io, okFetch("acct-1", "Ada"));
    expect(outcome).toEqual({ ok: true, accountId: "acct-1", displayName: "Ada", rotated: false });
    expect(files.get(path)?.content).toBe(CANARY_TOKEN);
    expect(files.get(path)?.mode).toBe(0o600);
  });
  test("a failing candidate test writes nothing and reports test-failed with a fixed message (never the candidate token)", async () => {
    const { io, files, path } = fakeIo();
    const outcome = await writeJiraToken({ site: SITE, email: "a@b.c", token: CANARY_TOKEN }, path, io, statusFetch(401));
    expect(outcome).toEqual({ ok: false, reason: "test-failed", error: fixedMyselfTestErrorFor("unauthorized") });
    expect(files.has(path)).toBe(false);
  });
  test("a symlink at the destination is refused outright, before any test even runs", async () => {
    const { io, path } = fakeIo({ content: "old", mode: 0o600, isSymlink: true });
    const outcome = await writeJiraToken({ site: SITE, email: "a@b.c", token: CANARY_TOKEN }, path, io, okFetch("acct-1"));
    expect(outcome).toEqual({ ok: false, reason: "destination-symlink" });
  });
  test("rotation with the SAME accountId as the current token succeeds and reports rotated:true", async () => {
    const { io, files, path } = fakeIo({ content: "old-token", mode: 0o600 });
    let calls = 0;
    const fetchFn: FetchLike = async (_url, init) => {
      calls++;
      const auth = (init!.headers as Record<string, string>).authorization;
      const isOld = auth === `Basic ${Buffer.from("a@b.c:old-token").toString("base64")}`;
      return new Response(JSON.stringify({ accountId: "acct-SAME", displayName: isOld ? "Old" : "New" }), { status: 200 });
    };
    const outcome = await writeJiraToken({ site: SITE, email: "a@b.c", token: CANARY_TOKEN }, path, io, fetchFn);
    expect(outcome).toEqual({ ok: true, accountId: "acct-SAME", displayName: "New", rotated: true });
    expect(calls).toBe(2); // current tested, then candidate tested
    expect(files.get(path)?.content).toBe(CANARY_TOKEN);
  });
  test("rotation with a DIFFERENT accountId is refused, nothing written, and the fixed message names both ids but never either token", async () => {
    const { io, files, path } = fakeIo({ content: "old-token", mode: 0o600 });
    const fetchFn: FetchLike = async (_url, init) => {
      const auth = (init!.headers as Record<string, string>).authorization;
      const isOld = auth === `Basic ${Buffer.from("a@b.c:old-token").toString("base64")}`;
      return new Response(JSON.stringify({ accountId: isOld ? "acct-OLD" : "acct-NEW" }), { status: 200 });
    };
    const outcome = await writeJiraToken({ site: SITE, email: "a@b.c", token: CANARY_TOKEN }, path, io, fetchFn);
    expect(outcome).toEqual({ ok: false, reason: "account-mismatch", currentAccountId: "acct-OLD", candidateAccountId: "acct-NEW" });
    expect(files.get(path)?.content).toBe("old-token"); // unchanged
    expect(JSON.stringify(outcome)).not.toContain(CANARY_TOKEN);
    expect(JSON.stringify(outcome)).not.toContain("old-token");
  });
  test("a dead current token (test fails) refuses the rotation rather than guessing either way", async () => {
    const { io, files, path } = fakeIo({ content: "dead-token", mode: 0o600 });
    const fetchFn: FetchLike = async (_url, init) => {
      const auth = (init!.headers as Record<string, string>).authorization;
      const isOld = auth === `Basic ${Buffer.from("a@b.c:dead-token").toString("base64")}`;
      return isOld ? new Response("", { status: 401 }) : new Response(JSON.stringify({ accountId: "acct-NEW" }), { status: 200 });
    };
    const outcome = await writeJiraToken({ site: SITE, email: "a@b.c", token: CANARY_TOKEN }, path, io, fetchFn);
    expect(outcome).toEqual({ ok: false, reason: "current-token-unreadable", error: fixedMyselfTestErrorFor("unauthorized") });
    expect(files.get(path)?.content).toBe("dead-token");
  });
  test("creates the secrets dir at 0700 only when it did not already exist; never chmods an existing dir", async () => {
    const { io, path, dirs } = fakeIo();
    await writeJiraToken({ site: SITE, email: "a@b.c", token: CANARY_TOKEN }, path, io, okFetch("acct-1"));
    expect(dirs.has("/home/u/.config/butchr/secrets")).toBe(true);
  });
  test("a write-time filesystem failure reports write-failed and cleans up the temp file; never throws", async () => {
    const { path } = fakeIo();
    const io: JiraTokenWriteIo = {
      readFile: () => undefined,
      mkdir: () => {},
      modeOf: () => undefined,
      isSymlink: () => false,
      writeTempExclusive: () => { throw new Error("ENOSPC: no space left"); },
      rename: () => { throw new Error("should not be called"); },
      removeQuiet: () => {},
    };
    const outcome = await writeJiraToken({ site: SITE, email: "a@b.c", token: CANARY_TOKEN }, path, io, okFetch("acct-1"));
    expect(outcome.ok).toBe(false);
    expect((outcome as { reason: string }).reason).toBe("write-failed");
  });
  test("no outcome shape, on any path, ever contains the candidate token value", async () => {
    const scenarios: Array<[JiraTokenWriteIo, FetchLike]> = [
      [fakeIo().io, statusFetch(500)],
      [fakeIo({ content: "old", mode: 0o600, isSymlink: true }).io, okFetch("a")],
      [fakeIo({ content: "old", mode: 0o600 }).io, async (_u, init) => new Response(JSON.stringify({ accountId: ((init?.headers as Record<string, string> | undefined)?.authorization ?? "").includes(Buffer.from("a@b.c:old").toString("base64")) ? "A" : "B" }), { status: 200 })],
    ];
    for (const [io, fetchFn] of scenarios) {
      const outcome = await writeJiraToken({ site: SITE, email: "a@b.c", token: CANARY_TOKEN }, fakeIo().path, io, fetchFn);
      expect(JSON.stringify(outcome)).not.toContain(CANARY_TOKEN);
    }
  });
});
