import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "../../src/resources/atomic-write.js";

describe("writeFileAtomic", () => {
  test("writes a new file with the given contents", async () => {
    const dir = await mkdtemp(join(tmpdir(), "butchr-atomic-write-"));
    const path = join(dir, "a.json");
    await writeFileAtomic(path, '{"x":1}\n');
    expect(await readFile(path, "utf8")).toBe('{"x":1}\n');
  });

  test("overwrites an existing file's contents wholesale", async () => {
    const dir = await mkdtemp(join(tmpdir(), "butchr-atomic-write-"));
    const path = join(dir, "a.json");
    await writeFileAtomic(path, '{"x":1}\n');
    await writeFileAtomic(path, '{"x":2}\n');
    expect(await readFile(path, "utf8")).toBe('{"x":2}\n');
  });

  test("leaves no stray temp file behind in the target directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "butchr-atomic-write-"));
    await writeFileAtomic(join(dir, "a.json"), "content\n");
    const entries = await readdir(dir);
    expect(entries).toEqual(["a.json"]);
  });

  test("a write into a non-existent directory rejects and never leaves a temp file to be cleaned up (nothing to rename)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "butchr-atomic-write-"));
    await expect(writeFileAtomic(join(dir, "missing-subdir", "a.json"), "x")).rejects.toThrow();
    expect(await readdir(dir)).toEqual([]);
  });
});
