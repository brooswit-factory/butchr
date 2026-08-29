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

  test("github is absent when GITHUB_TOKEN_FILE or BUTCHR_GITHUB_ORGS is missing", () => {
    expect(loadConfig(base, noRead).github).toBeUndefined();
    expect(loadConfig({ ...base, BUTCHR_GITHUB_ORGS: "acme" }, noRead).github).toBeUndefined();
    expect(loadConfig({ ...base, GITHUB_TOKEN_FILE: "/gh" }, (p) => { expect(p).toBe("/gh"); return "ghtok\n"; }).github).toBeUndefined();
  });
  test("github is populated when both are set; orgs are comma-split and trimmed", () => {
    const c = loadConfig({ ...base, GITHUB_TOKEN_FILE: "/gh", BUTCHR_GITHUB_ORGS: "acme, other-org" }, () => "ghtok\n");
    expect(c.github).toEqual({ token: "ghtok", orgs: ["acme", "other-org"] });
  });
  test("describeConfig reports github as disabled or its orgs, never the token value", () => {
    expect(describeConfig(loadConfig(base, noRead))).toContain("github=disabled");
    const d = describeConfig(loadConfig({ ...base, GITHUB_TOKEN_FILE: "/gh", BUTCHR_GITHUB_ORGS: "acme" }, () => "s3cr3t-gh-tok"));
    expect(d).not.toContain("s3cr3t-gh-tok");
    expect(d).toContain("orgs=acme");
  });

  test("stalledMinutes defaults to 10, honours BUTCHR_STALLED_MINUTES, and rejects a non-positive value", () => {
    expect(loadConfig(base, noRead).stalledMinutes).toBe(10);
    expect(loadConfig({ ...base, BUTCHR_STALLED_MINUTES: "20" }, noRead).stalledMinutes).toBe(20);
    expect(() => loadConfig({ ...base, BUTCHR_STALLED_MINUTES: "0" }, noRead)).toThrow(/BUTCHR_STALLED_MINUTES/);
    expect(() => loadConfig({ ...base, BUTCHR_STALLED_MINUTES: "nope" }, noRead)).toThrow(/BUTCHR_STALLED_MINUTES/);
  });

  test("assignees are parsed when both BUTCHR_ASSIGNEE_STORY/TASK are set", () => {
    const c = loadConfig({ ...base, BUTCHR_ASSIGNEE_STORY: "712020:story", BUTCHR_ASSIGNEE_TASK: "712020:task" }, noRead);
    expect(c.assignees).toEqual({ story: "712020:story", task: "712020:task" });
  });
  test("loadConfig does not throw when BUTCHR_ASSIGNEE_STORY/TASK are absent; roles are undefined", () => {
    const c = loadConfig(base, noRead);
    expect(c.assignees.story).toBeUndefined();
    expect(c.assignees.task).toBeUndefined();
  });
  test("describeConfig includes the resolved accountIds and names the consequence when a role is unset, never a token", () => {
    const both = describeConfig(loadConfig({ ...base, BUTCHR_ASSIGNEE_STORY: "712020:e160cf60-6480-44de-8554-af5b81c584e2", BUTCHR_ASSIGNEE_TASK: "712020:619ec5ec-2e92-492f-8979-91ccda318230" }, noRead));
    expect(both).toContain("assignees=story:712020:e160");
    expect(both).toContain("task:712020:619e");
    const none = describeConfig(loadConfig(base, noRead));
    expect(none).toContain("story:unset — Story creation will be refused");
    expect(none).toContain("task:unset — Task creation will be refused");
  });
});
