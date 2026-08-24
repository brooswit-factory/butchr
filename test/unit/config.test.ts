import { describe, expect, test } from "bun:test";
import { loadConfig, describeConfig } from "../../src/config/config.js";

const noRead = () => { throw new Error("should not read"); };
const base = { ATLASSIAN_SITE: "https://x.atlassian.net/", ATLASSIAN_EMAIL: "a@b.c", ATLASSIAN_TOKEN: "tok" };

describe("loadConfig", () => {
  test("parses a full env; trims trailing slash; default port 7717", () => {
    const c = loadConfig(base, noRead);
    expect(c.atlassian).toEqual({ site: "https://x.atlassian.net", email: "a@b.c", token: "tok" });
    expect(c.port).toBe(7717);
    expect(c.herdrSocket).toBeUndefined();
  });
  test("reads the token from a file when ATLASSIAN_TOKEN_FILE is set", () => {
    const c = loadConfig({ ...base, ATLASSIAN_TOKEN: undefined, ATLASSIAN_TOKEN_FILE: "/t" }, (p) => { expect(p).toBe("/t"); return "filetok\n"; });
    expect(c.atlassian.token).toBe("filetok");
  });
  test("honours BUTCHR_PORT and HERDR_SOCKET", () => {
    const c = loadConfig({ ...base, BUTCHR_PORT: "9000", HERDR_SOCKET: "/s.sock" }, noRead);
    expect(c.port).toBe(9000); expect(c.herdrSocket).toBe("/s.sock");
  });
  test("throws on missing site/email/token and on a bad port", () => {
    expect(() => loadConfig({ ...base, ATLASSIAN_SITE: undefined }, noRead)).toThrow(/ATLASSIAN_SITE/);
    expect(() => loadConfig({ ...base, ATLASSIAN_EMAIL: "" }, noRead)).toThrow(/ATLASSIAN_EMAIL/);
    expect(() => loadConfig({ ...base, ATLASSIAN_TOKEN: undefined }, noRead)).toThrow(/ATLASSIAN_TOKEN/);
    expect(() => loadConfig({ ...base, ATLASSIAN_TOKEN_FILE: "/t" }, () => "  \n")).toThrow(/empty/);
    expect(() => loadConfig({ ...base, BUTCHR_PORT: "notaport" }, noRead)).toThrow(/BUTCHR_PORT/);
  });
  test("describeConfig never leaks the token value", () => {
    const d = describeConfig(loadConfig({ ...base, ATLASSIAN_TOKEN: "s3cr3t-VALUE" }, noRead));
    expect(d).not.toContain("s3cr3t-VALUE"); expect(d).toContain("***"); expect(d).toContain("12 chars");
  });
});
