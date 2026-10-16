import { describe, expect, test } from "bun:test";
import { loadCatamorbiusFullConfig, loadCatamorbiusPushKnobs, type CatamorbiusPushConfigEnv } from "../../../src/catamorbius/push-config.js";

const readFile = (files: Record<string, string>) => (path: string): string => {
  if (!(path in files)) throw new Error(`ENOENT: ${path}`);
  return files[path]!;
};

describe("loadCatamorbiusPushKnobs", () => {
  test("defaults: no providers, ttl 600000, no per-provider override, grace 60000, debounce 2000", () => {
    expect(loadCatamorbiusPushKnobs({})).toEqual({ providers: [], ttlMs: 600_000, ttlMsByProvider: {}, graceMs: 60_000, debounceMs: 2_000 });
  });
  test("parses a comma-separated provider list, de-duplicated", () => {
    expect(loadCatamorbiusPushKnobs({ CATAMORBIUS_PROVIDERS: "jira, github, jira" }).providers).toEqual(["jira", "github"]);
  });
  test("unknown provider name throws loudly", () => {
    expect(() => loadCatamorbiusPushKnobs({ CATAMORBIUS_PROVIDERS: "bitbucket" })).toThrow(/CATAMORBIUS_PROVIDERS/);
  });
  test("per-provider TTL override", () => {
    const knobs = loadCatamorbiusPushKnobs({ CATAMORBIUS_TTL_MS: "100000", CATAMORBIUS_TTL_JIRA_MS: "50000" });
    expect(knobs.ttlMs).toBe(100_000);
    expect(knobs.ttlMsByProvider).toEqual({ jira: 50_000 });
  });
  for (const name of ["CATAMORBIUS_TTL_MS", "CATAMORBIUS_TTL_JIRA_MS", "CATAMORBIUS_TTL_GITHUB_MS", "CATAMORBIUS_GRACE_MS", "CATAMORBIUS_DEBOUNCE_MS"] as const) {
    test(`${name}: zero or negative throws`, () => {
      expect(() => loadCatamorbiusPushKnobs({ [name]: "0" } as CatamorbiusPushConfigEnv)).toThrow(new RegExp(name));
    });
    test(`${name}: non-numeric throws`, () => {
      expect(() => loadCatamorbiusPushKnobs({ [name]: "nope" } as CatamorbiusPushConfigEnv)).toThrow(new RegExp(name));
    });
  }
});

describe("loadCatamorbiusFullConfig: D9 off-by-default", () => {
  const log = (): void => {};
  test("undefined when CATAMORBIUS_URL is unset", () => {
    expect(loadCatamorbiusFullConfig({}, readFile({}), log)).toBeUndefined();
  });
  test("undefined when CATAMORBIUS_URL is set but no provider is enabled", () => {
    const env: CatamorbiusPushConfigEnv = { CATAMORBIUS_URL: "http://localhost:3000", CATAMORBIUS_TOKEN_FILE: "/t" };
    expect(loadCatamorbiusFullConfig(env, readFile({ "/t": "tok" }), log)).toBeUndefined();
  });
  test("enabled once a provider is named", () => {
    const env: CatamorbiusPushConfigEnv = { CATAMORBIUS_URL: "http://localhost:3000", CATAMORBIUS_TOKEN_FILE: "/t", CATAMORBIUS_PROVIDERS: "jira" };
    const full = loadCatamorbiusFullConfig(env, readFile({ "/t": "tok" }), log);
    expect(full?.catamorbius.baseUrl).toBe("http://localhost:3000");
    expect(full?.push.providers).toEqual(["jira"]);
  });
});

describe("loadCatamorbiusFullConfig: token-read failure vs. every other malformed value (ticket item B1)", () => {
  test("an unreadable token file disables the feature with one WARNING, never throws", () => {
    const lines: string[] = [];
    const env: CatamorbiusPushConfigEnv = { CATAMORBIUS_URL: "http://localhost:3000", CATAMORBIUS_TOKEN_FILE: "/missing", CATAMORBIUS_PROVIDERS: "jira" };
    const result = loadCatamorbiusFullConfig(env, readFile({}), (l) => lines.push(l));
    expect(result).toBeUndefined();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/WARNING.*\[catamorbius\].*token file could not be read/);
  });
  test("a missing CATAMORBIUS_TOKEN_FILE variable still throws loudly (a config mistake, not a read failure)", () => {
    const env: CatamorbiusPushConfigEnv = { CATAMORBIUS_URL: "http://localhost:3000", CATAMORBIUS_PROVIDERS: "jira" };
    expect(() => loadCatamorbiusFullConfig(env, readFile({}), () => {})).toThrow(/CATAMORBIUS_TOKEN_FILE/);
  });
  test("an empty token still throws loudly (malformed content, not a read failure)", () => {
    const env: CatamorbiusPushConfigEnv = { CATAMORBIUS_URL: "http://localhost:3000", CATAMORBIUS_TOKEN_FILE: "/t", CATAMORBIUS_PROVIDERS: "jira" };
    expect(() => loadCatamorbiusFullConfig(env, readFile({ "/t": "   " }), () => {})).toThrow(/empty/);
  });
  test("a malformed URL still throws loudly", () => {
    const env: CatamorbiusPushConfigEnv = { CATAMORBIUS_URL: "not a url", CATAMORBIUS_TOKEN_FILE: "/t", CATAMORBIUS_PROVIDERS: "jira" };
    expect(() => loadCatamorbiusFullConfig(env, readFile({ "/t": "tok" }), () => {})).toThrow(/valid URL/);
  });
  test("a malformed numeric knob still throws loudly", () => {
    const env: CatamorbiusPushConfigEnv = { CATAMORBIUS_URL: "http://localhost:3000", CATAMORBIUS_TOKEN_FILE: "/t", CATAMORBIUS_PROVIDERS: "jira", CATAMORBIUS_TTL_MS: "0" };
    expect(() => loadCatamorbiusFullConfig(env, readFile({ "/t": "tok" }), () => {})).toThrow(/CATAMORBIUS_TTL_MS/);
  });
  test("an unknown provider name still throws loudly", () => {
    const env: CatamorbiusPushConfigEnv = { CATAMORBIUS_URL: "http://localhost:3000", CATAMORBIUS_TOKEN_FILE: "/t", CATAMORBIUS_PROVIDERS: "bitbucket" };
    expect(() => loadCatamorbiusFullConfig(env, readFile({ "/t": "tok" }), () => {})).toThrow(/CATAMORBIUS_PROVIDERS/);
  });
});
