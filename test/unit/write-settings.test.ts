import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_AGENTS_CEILING } from "../../src/settings/settings-file.js";
import { SettingsWriteRefusedError, restoreSettingsBackup, writeSetting } from "../../src/settings/write-settings.js";
import type { SettingsFileEnv } from "../../src/settings/settings-file.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "butchr-write-settings-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function env(): SettingsFileEnv {
  return { XDG_CONFIG_HOME: dir };
}

function filePath(): string {
  return join(dir, "butchr", "settings.json");
}

describe("writeSetting: validation", () => {
  test("a non-allowlisted key: throws, writes nothing", () => {
    expect(() => writeSetting("BUTCHR_PORT", "7717", false, env())).toThrow(SettingsWriteRefusedError);
    expect(() => statSync(join(dir, "butchr"))).toThrow();
  });

  test("an out-of-range value: throws with needsConfirm, writes nothing", () => {
    try {
      writeSetting("BUTCHR_MAX_AGENTS", String(MAX_AGENTS_CEILING + 1), false, env());
      throw new Error("expected writeSetting to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(SettingsWriteRefusedError);
      expect((e as SettingsWriteRefusedError).needsConfirm).toBe(true);
    }
    expect(() => statSync(join(dir, "butchr"))).toThrow();
  });

  test("confirm:true allows a write past the ceiling", () => {
    const over = String(MAX_AGENTS_CEILING + 1);
    const result = writeSetting("BUTCHR_MAX_AGENTS", over, true, env());
    expect(result.value).toBe(over);
  });
});

describe("writeSetting: first write", () => {
  test("creates the file at mode 0600, directory at 0700, no backup", () => {
    const result = writeSetting("BUTCHR_MAX_AGENTS", "12", false, env());
    expect(result.backupPath).toBeNull();
    expect(statSync(filePath()).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "butchr")).mode & 0o777).toBe(0o700);
    expect(JSON.parse(readFileSync(filePath(), "utf8"))).toEqual({ BUTCHR_MAX_AGENTS: "12" });
  });

  test("never a symlink at the destination", () => {
    writeSetting("BUTCHR_MAX_AGENTS", "12", false, env());
    expect(lstatSync(filePath()).isSymbolicLink()).toBe(false);
  });
});

describe("writeSetting: subsequent writes", () => {
  test("a second key is added alongside the first, preserving it", () => {
    writeSetting("BUTCHR_MAX_AGENTS", "12", false, env());
    writeSetting("BUTCHR_AGENT_PROVIDER", "codex", false, env());
    const doc = JSON.parse(readFileSync(filePath(), "utf8"));
    expect(doc).toEqual({ BUTCHR_MAX_AGENTS: "12", BUTCHR_AGENT_PROVIDER: "codex" });
  });

  test("overwriting the same key replaces its value", () => {
    writeSetting("BUTCHR_MAX_AGENTS", "12", false, env());
    writeSetting("BUTCHR_MAX_AGENTS", "20", false, env());
    const doc = JSON.parse(readFileSync(filePath(), "utf8"));
    expect(doc).toEqual({ BUTCHR_MAX_AGENTS: "20" });
  });

  test("creates a backup of the previous file, byte-identical to what it replaced", () => {
    writeSetting("BUTCHR_MAX_AGENTS", "12", false, env());
    const before = readFileSync(filePath(), "utf8");
    const result = writeSetting("BUTCHR_MAX_AGENTS", "20", false, env());
    expect(result.backupPath).not.toBeNull();
    expect(readFileSync(result.backupPath!, "utf8")).toBe(before);
  });

  test("a validation failure after a file exists leaves the original byte-for-byte untouched and writes no backup", () => {
    writeSetting("BUTCHR_MAX_AGENTS", "12", false, env());
    const before = readFileSync(filePath(), "utf8");
    expect(() => writeSetting("BUTCHR_MAX_AGENTS", "not-a-number", false, env())).toThrow();
    expect(readFileSync(filePath(), "utf8")).toBe(before);
    const entries = readdirSync(join(dir, "butchr"));
    expect(entries).toEqual(["settings.json"]);
  });
});

describe("writeSetting: lock contention", () => {
  test("a live holder of .settings.lock refuses a concurrent write", () => {
    mkdirSync(join(dir, "butchr"), { recursive: true, mode: 0o700 });
    const lockPath = join(dir, "butchr", ".settings.lock");
    const fd = openSync(lockPath, "wx");
    writeSync(fd, `${process.pid}:fake-token`);
    closeSync(fd);
    expect(() => writeSetting("BUTCHR_MAX_AGENTS", "12", false, env())).toThrow(/locked by another writer/);
  });
});

describe("restoreSettingsBackup", () => {
  test("restores a previous value, itself creating a fresh backup of the state just before the restore", () => {
    writeSetting("BUTCHR_MAX_AGENTS", "12", false, env());
    const afterFirst = readFileSync(filePath(), "utf8");
    const second = writeSetting("BUTCHR_MAX_AGENTS", "20", false, env());
    restoreSettingsBackup(second.backupId!, env());
    expect(readFileSync(filePath(), "utf8")).toBe(afterFirst);
  });

  test("an invalid backup id is refused before any path is built from it", () => {
    expect(() => restoreSettingsBackup("../../etc/passwd", env())).toThrow(/invalid backup id/);
  });

  test("a non-existent backup id is refused", () => {
    writeSetting("BUTCHR_MAX_AGENTS", "12", false, env());
    expect(() => restoreSettingsBackup("20260101T000000Z", env())).toThrow(/no backup/);
  });
});
