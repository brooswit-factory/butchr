import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  jiraIdentityFilePath, readJiraIdentity, writeJiraIdentity, defaultJiraIdentityFileIo,
  type JiraIdentityFileIo,
} from "../../src/setup/jira-identity-file.js";

function fakeIo(initial?: { content: string; isSymlink?: boolean }) {
  const files = new Map<string, { content: string; isSymlink: boolean }>();
  const dirs = new Set<string>();
  const path = "/home/u/.config/butchr/jira-identity.json";
  if (initial) files.set(path, { content: initial.content, isSymlink: initial.isSymlink ?? false });
  const io: JiraIdentityFileIo = {
    readFile: (p) => files.get(p)?.content,
    mkdir: (dir) => { dirs.add(dir); },
    modeOf: (p) => (dirs.has(p) ? 0o755 : (files.has(p) ? 0o600 : undefined)),
    isSymlink: (p) => files.get(p)?.isSymlink ?? false,
    writeTempExclusive: (p, text) => { if (files.has(p)) throw Object.assign(new Error("EEXIST"), { code: "EEXIST" }); files.set(p, { content: text, isSymlink: false }); },
    rename: (tmp, dest) => { const v = files.get(tmp); if (!v) throw new Error("no temp file"); files.delete(tmp); files.set(dest, v); },
    removeQuiet: (p) => { files.delete(p); },
  };
  return { io, files, path, dirs };
}

describe("jiraIdentityFilePath", () => {
  test("resolves under XDG_CONFIG_HOME/butchr, or BUTCHR_JIRA_IDENTITY_FILE override", () => {
    expect(jiraIdentityFilePath({ XDG_CONFIG_HOME: "/xdg" })).toBe("/xdg/butchr/jira-identity.json");
    expect(jiraIdentityFilePath({ BUTCHR_JIRA_IDENTITY_FILE: "/custom.json" })).toBe("/custom.json");
  });
});

describe("readJiraIdentity", () => {
  test("absent file: undefined, no warning", () => {
    const { io, path } = fakeIo();
    const warnings: string[] = [];
    expect(readJiraIdentity(path, io, (w) => warnings.push(w))).toBeUndefined();
    expect(warnings).toHaveLength(0);
  });
  test("a valid file: returns the trimmed {site, email}", () => {
    const { io, path } = fakeIo({ content: JSON.stringify({ site: " https://x.atlassian.net ", email: " a@b.c " }) });
    expect(readJiraIdentity(path, io)).toEqual({ site: "https://x.atlassian.net", email: "a@b.c" });
  });
  test("malformed JSON: undefined, with a warning naming the path", () => {
    const { io, path } = fakeIo({ content: "{not json" });
    const warnings: string[] = [];
    expect(readJiraIdentity(path, io, (w) => warnings.push(w))).toBeUndefined();
    expect(warnings[0]).toContain(path);
  });
  test("a JSON array (not an object): undefined, with a warning", () => {
    const { io, path } = fakeIo({ content: "[1,2,3]" });
    const warnings: string[] = [];
    expect(readJiraIdentity(path, io, (w) => warnings.push(w))).toBeUndefined();
    expect(warnings).toHaveLength(1);
  });
  test("missing/blank site or email fields: undefined, with a warning", () => {
    const { io: io1, path } = fakeIo({ content: JSON.stringify({ site: "", email: "a@b.c" }) });
    expect(readJiraIdentity(path, io1)).toBeUndefined();
    const { io: io2 } = fakeIo({ content: JSON.stringify({ site: "https://x.atlassian.net" }) });
    expect(readJiraIdentity(path, io2)).toBeUndefined();
  });
  test("a symlinked identity file: refused outright, never read, with a warning", () => {
    const { io, path } = fakeIo({ content: JSON.stringify({ site: "s", email: "e" }), isSymlink: true });
    const warnings: string[] = [];
    expect(readJiraIdentity(path, io, (w) => warnings.push(w))).toBeUndefined();
    expect(warnings[0]).toContain("symlink");
  });
});

describe("writeJiraIdentity", () => {
  test("writes {site, email} atomically, mode 0600 (via writeTempExclusive), creates the dir at 0700 only if absent", () => {
    const { io, files, path, dirs } = fakeIo();
    writeJiraIdentity({ site: "https://x.atlassian.net", email: "a@b.c" }, path, io);
    expect(JSON.parse(files.get(path)!.content)).toEqual({ site: "https://x.atlassian.net", email: "a@b.c" });
    expect(dirs.has("/home/u/.config/butchr")).toBe(true);
  });
  test("refuses a symlinked destination outright, writes nothing", () => {
    const { io, files, path } = fakeIo({ content: "old", isSymlink: true });
    expect(() => writeJiraIdentity({ site: "s", email: "e" }, path, io)).toThrow(/symlink/);
    expect(files.get(path)!.content).toBe("old");
  });
  test("a write-time failure cleans up the temp file and rethrows", () => {
    const io: JiraIdentityFileIo = { ...fakeIo().io, writeTempExclusive: () => { throw new Error("ENOSPC"); } };
    let removed = false;
    io.removeQuiet = () => { removed = true; };
    expect(() => writeJiraIdentity({ site: "s", email: "e" }, "/p/jira-identity.json", io)).toThrow("ENOSPC");
    expect(removed).toBe(true);
  });
  test("round-trips through readJiraIdentity", () => {
    const { io, path } = fakeIo();
    writeJiraIdentity({ site: "https://x.atlassian.net", email: "a@b.c" }, path, io);
    expect(readJiraIdentity(path, io)).toEqual({ site: "https://x.atlassian.net", email: "a@b.c" });
  });
});

describe("defaultJiraIdentityFileIo (real filesystem)", () => {
  test("round-trips a real write + read, refuses a real symlink, against a scratch temp dir", () => {
    const dir = mkdtempSync(join(tmpdir(), "jira-identity-test-"));
    try {
      const io = defaultJiraIdentityFileIo();
      const path = join(dir, "sub", "jira-identity.json");
      expect(io.readFile(path)).toBeUndefined();
      writeJiraIdentity({ site: "https://x.atlassian.net", email: "a@b.c" }, path, io);
      expect(readJiraIdentity(path, io)).toEqual({ site: "https://x.atlassian.net", email: "a@b.c" });
      expect(io.modeOf(path)).toBe(0o600);

      const link = join(dir, "a-link.json");
      writeFileSync(join(dir, "real.json"), "{}");
      symlinkSync(join(dir, "real.json"), link);
      expect(io.isSymlink(link)).toBe(true);
      expect(() => writeJiraIdentity({ site: "s", email: "e" }, link, io)).toThrow(/symlink/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
