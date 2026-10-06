import { describe, expect, test } from "bun:test";
import { resolveEffectiveJiraEnv } from "../../src/config/effective-env.js";
import { writeJiraIdentity, type JiraIdentityFileIo } from "../../src/setup/jira-identity-file.js";

function fakeIdentityIo(seed?: { site: string; email: string }) {
  const files = new Map<string, { content: string; isSymlink: boolean }>();
  const io: JiraIdentityFileIo = {
    readFile: (p) => files.get(p)?.content,
    mkdir: () => {},
    modeOf: (p) => (files.has(p) ? 0o600 : undefined),
    isSymlink: (p) => files.get(p)?.isSymlink ?? false,
    writeTempExclusive: (p, text) => files.set(p, { content: text, isSymlink: false }),
    rename: (tmp, dest) => { const v = files.get(tmp); if (v) { files.delete(tmp); files.set(dest, v); } },
    removeQuiet: (p) => { files.delete(p); },
  };
  if (seed) writeJiraIdentity(seed, "/env/.config/butchr/jira-identity.json", io);
  return io;
}

const BASE_ENV = { XDG_CONFIG_HOME: "/env/.config" };

describe("resolveEffectiveJiraEnv", () => {
  test("env already fully specifies site/email/token: passes through completely unchanged, never even reads the identity file", () => {
    let readCalls = 0;
    const io: JiraIdentityFileIo = { ...fakeIdentityIo(), readFile: (p) => { readCalls++; return undefined; } };
    const env = { ...BASE_ENV, ATLASSIAN_SITE: "https://x.atlassian.net", ATLASSIAN_EMAIL: "a@b.c", ATLASSIAN_TOKEN: "t" };
    const result = resolveEffectiveJiraEnv(env, { identityIo: io });
    expect(result).toEqual(env);
    expect(readCalls).toBe(0);
  });

  test("env has nothing: falls back to the persisted identity for site/email, and the managed token path when it exists", () => {
    const io = fakeIdentityIo({ site: "https://persisted.atlassian.net", email: "persisted@b.c" });
    const result = resolveEffectiveJiraEnv({ ...BASE_ENV }, { identityIo: io, managedTokenFileExists: () => true });
    expect(result.ATLASSIAN_SITE).toBe("https://persisted.atlassian.net");
    expect(result.ATLASSIAN_EMAIL).toBe("persisted@b.c");
    expect(result.ATLASSIAN_TOKEN_FILE).toContain("atlassian-token");
  });

  test("env wins PER-FIELD: an env-provided site is kept even when the identity file has a different one", () => {
    const io = fakeIdentityIo({ site: "https://persisted.atlassian.net", email: "persisted@b.c" });
    const result = resolveEffectiveJiraEnv({ ...BASE_ENV, ATLASSIAN_SITE: "https://env.atlassian.net" }, { identityIo: io, managedTokenFileExists: () => true });
    expect(result.ATLASSIAN_SITE).toBe("https://env.atlassian.net");
    expect(result.ATLASSIAN_EMAIL).toBe("persisted@b.c"); // email still falls back
  });

  test("no managed token file on disk: ATLASSIAN_TOKEN_FILE is left unset, never guessed", () => {
    const io = fakeIdentityIo({ site: "https://x.atlassian.net", email: "a@b.c" });
    const result = resolveEffectiveJiraEnv({ ...BASE_ENV }, { identityIo: io, managedTokenFileExists: () => false });
    expect(result.ATLASSIAN_TOKEN_FILE).toBeUndefined();
  });

  test("an env-provided ATLASSIAN_TOKEN is never overridden by the managed file path, even when that file exists", () => {
    const io = fakeIdentityIo({ site: "https://x.atlassian.net", email: "a@b.c" });
    const result = resolveEffectiveJiraEnv({ ...BASE_ENV, ATLASSIAN_TOKEN: "env-token" }, { identityIo: io, managedTokenFileExists: () => true });
    expect(result.ATLASSIAN_TOKEN).toBe("env-token");
    expect(result.ATLASSIAN_TOKEN_FILE).toBeUndefined();
  });

  test("an already-set ATLASSIAN_TOKEN_FILE is kept as-is, never replaced by the managed path", () => {
    const io = fakeIdentityIo({ site: "https://x.atlassian.net", email: "a@b.c" });
    const result = resolveEffectiveJiraEnv({ ...BASE_ENV, ATLASSIAN_TOKEN_FILE: "/custom/path" }, { identityIo: io, managedTokenFileExists: () => true });
    expect(result.ATLASSIAN_TOKEN_FILE).toBe("/custom/path");
  });

  test("no identity file and no env site/email: both stay unset (never guessed), so isAtlassianConfigured correctly reports unconfigured", () => {
    const io = fakeIdentityIo();
    const result = resolveEffectiveJiraEnv({ ...BASE_ENV }, { identityIo: io });
    expect(result.ATLASSIAN_SITE).toBeUndefined();
    expect(result.ATLASSIAN_EMAIL).toBeUndefined();
  });

  test("never mutates the input env object", () => {
    const io = fakeIdentityIo({ site: "https://x.atlassian.net", email: "a@b.c" });
    const env = { ...BASE_ENV };
    const snapshot = { ...env };
    resolveEffectiveJiraEnv(env, { identityIo: io, managedTokenFileExists: () => true });
    expect(env).toEqual(snapshot);
  });

  test("a malformed identity file degrades to unset (never thrown), surfaced via onWarn", () => {
    const io: JiraIdentityFileIo = { ...fakeIdentityIo(), readFile: () => "{not json" };
    const warnings: string[] = [];
    const result = resolveEffectiveJiraEnv({ ...BASE_ENV }, { identityIo: io, onWarn: (w) => warnings.push(w) });
    expect(result.ATLASSIAN_SITE).toBeUndefined();
    expect(warnings).toHaveLength(1);
  });
});
