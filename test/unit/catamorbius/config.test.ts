import { describe, expect, test } from "bun:test";
import { loadCatamorbiusConfig, type CatamorbiusConfigEnv } from "../../../src/catamorbius/config.js";

const readFile = (files: Record<string, string>) => (path: string): string => {
  if (!(path in files)) throw new Error(`ENOENT: ${path}`);
  return files[path]!;
};

describe("loadCatamorbiusConfig: off by default", () => {
  test("undefined when CATAMORBIUS_URL is unset, regardless of other vars", () => {
    expect(loadCatamorbiusConfig({}, readFile({}))).toBeUndefined();
    expect(loadCatamorbiusConfig({ CATAMORBIUS_WATCHDOG_MS: "9999" }, readFile({}))).toBeUndefined();
  });
});

describe("loadCatamorbiusConfig: enabled", () => {
  test("reads the token from the file named by CATAMORBIUS_TOKEN_FILE, trimmed; never from a bare env var", () => {
    const env: CatamorbiusConfigEnv = { CATAMORBIUS_URL: "http://localhost:3000", CATAMORBIUS_TOKEN_FILE: "/secrets/cata" };
    const cfg = loadCatamorbiusConfig(env, readFile({ "/secrets/cata": "abc123\n" }));
    expect(cfg?.token).toBe("abc123");
  });
  test("strips a trailing slash from the base URL", () => {
    const env: CatamorbiusConfigEnv = { CATAMORBIUS_URL: "http://localhost:3000/", CATAMORBIUS_TOKEN_FILE: "/t" };
    const cfg = loadCatamorbiusConfig(env, readFile({ "/t": "tok" }));
    expect(cfg?.baseUrl).toBe("http://localhost:3000");
  });
  test("defaults: watchdog 45000 (3x the gateway's documented 15000ms heartbeat default), backoff base 1000, cap 60000, probe timeout 5000", () => {
    const env: CatamorbiusConfigEnv = { CATAMORBIUS_URL: "http://localhost:3000", CATAMORBIUS_TOKEN_FILE: "/t" };
    const cfg = loadCatamorbiusConfig(env, readFile({ "/t": "tok" }));
    expect(cfg).toEqual({ baseUrl: "http://localhost:3000", token: "tok", watchdogMs: 45000, backoffBaseMs: 1000, backoffCapMs: 60000, probeTimeoutMs: 5000 });
  });
  test("every tunable is overridable", () => {
    const env: CatamorbiusConfigEnv = {
      CATAMORBIUS_URL: "https://cata.example.com",
      CATAMORBIUS_TOKEN_FILE: "/t",
      CATAMORBIUS_WATCHDOG_MS: "20000",
      CATAMORBIUS_BACKOFF_BASE_MS: "500",
      CATAMORBIUS_BACKOFF_CAP_MS: "30000",
      CATAMORBIUS_PROBE_TIMEOUT_MS: "2000",
    };
    const cfg = loadCatamorbiusConfig(env, readFile({ "/t": "tok" }));
    expect(cfg).toEqual({ baseUrl: "https://cata.example.com", token: "tok", watchdogMs: 20000, backoffBaseMs: 500, backoffCapMs: 30000, probeTimeoutMs: 2000 });
  });
});

describe("loadCatamorbiusConfig: fails loudly, once enabled", () => {
  const base: CatamorbiusConfigEnv = { CATAMORBIUS_URL: "http://localhost:3000" };
  test("URL set but no token file", () => {
    expect(() => loadCatamorbiusConfig(base, readFile({}))).toThrow(/CATAMORBIUS_TOKEN_FILE/);
  });
  test("token file empty", () => {
    expect(() => loadCatamorbiusConfig({ ...base, CATAMORBIUS_TOKEN_FILE: "/t" }, readFile({ "/t": "   " }))).toThrow(/empty/);
  });
  test("malformed URL", () => {
    expect(() => loadCatamorbiusConfig({ CATAMORBIUS_URL: "not a url", CATAMORBIUS_TOKEN_FILE: "/t" }, readFile({ "/t": "tok" }))).toThrow(/valid URL/);
  });
  test("non-http(s) URL scheme", () => {
    expect(() => loadCatamorbiusConfig({ CATAMORBIUS_URL: "ftp://example.com", CATAMORBIUS_TOKEN_FILE: "/t" }, readFile({ "/t": "tok" }))).toThrow(/http\(s\)/);
  });
  for (const name of ["CATAMORBIUS_WATCHDOG_MS", "CATAMORBIUS_BACKOFF_BASE_MS", "CATAMORBIUS_BACKOFF_CAP_MS", "CATAMORBIUS_PROBE_TIMEOUT_MS"] as const) {
    test(`${name}: non-numeric throws`, () => {
      const env = { ...base, CATAMORBIUS_TOKEN_FILE: "/t", [name]: "not-a-number" } as CatamorbiusConfigEnv;
      expect(() => loadCatamorbiusConfig(env, readFile({ "/t": "tok" }))).toThrow(new RegExp(name));
    });
    test(`${name}: zero or negative throws`, () => {
      const env = { ...base, CATAMORBIUS_TOKEN_FILE: "/t", [name]: "0" } as CatamorbiusConfigEnv;
      expect(() => loadCatamorbiusConfig(env, readFile({ "/t": "tok" }))).toThrow(new RegExp(name));
    });
  }
  test("backoff cap below base throws", () => {
    const env: CatamorbiusConfigEnv = { ...base, CATAMORBIUS_TOKEN_FILE: "/t", CATAMORBIUS_BACKOFF_BASE_MS: "5000", CATAMORBIUS_BACKOFF_CAP_MS: "1000" };
    expect(() => loadCatamorbiusConfig(env, readFile({ "/t": "tok" }))).toThrow(/must be >=/);
  });
});
