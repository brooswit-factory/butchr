import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileNexusManifestPublisher } from "../../src/accounts/nexus-manifest.js";

describe("createFileNexusManifestPublisher (BUTCHR-412)", () => {
  test("publishes a full snapshot, 0600, sorted by account name, never a token value", async () => {
    const dir = mkdtempSync(join(tmpdir(), "butchr-nexus-manifest-"));
    try {
      const path = join(dir, "manifest.json");
      const publisher = createFileNexusManifestPublisher(path);
      await publisher.publish([
        { account: "butchr_b", tokenFile: "/tokens/butchr_b.token" },
        { account: "butchr_a", tokenFile: "/tokens/butchr_a.token" },
      ]);
      const body = JSON.parse(readFileSync(path, "utf8"));
      expect(body).toEqual([
        { account: "butchr_a", tokenFile: "/tokens/butchr_a.token" },
        { account: "butchr_b", tokenFile: "/tokens/butchr_b.token" },
      ]);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      // A token VALUE never appears — only account names and file paths.
      expect(readFileSync(path, "utf8")).not.toMatch(/tok-/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("an empty entry list still publishes (an empty array, not a missing file)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "butchr-nexus-manifest-empty-"));
    try {
      const path = join(dir, "manifest.json");
      await createFileNexusManifestPublisher(path).publish([]);
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("a later publish REPLACES the file entirely — a full snapshot, never an append", async () => {
    const dir = mkdtempSync(join(tmpdir(), "butchr-nexus-manifest-replace-"));
    try {
      const path = join(dir, "manifest.json");
      const publisher = createFileNexusManifestPublisher(path);
      await publisher.publish([{ account: "butchr_a", tokenFile: "/tokens/butchr_a.token" }]);
      await publisher.publish([{ account: "butchr_c", tokenFile: "/tokens/butchr_c.token" }]);
      const body = JSON.parse(readFileSync(path, "utf8"));
      expect(body).toEqual([{ account: "butchr_c", tokenFile: "/tokens/butchr_c.token" }]); // butchr_a is gone, not merged in
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("writes are atomic (temp file + rename): no leftover temp file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "butchr-nexus-manifest-atomic-"));
    try {
      const path = join(dir, "manifest.json");
      await createFileNexusManifestPublisher(path).publish([{ account: "butchr_a", tokenFile: "/tokens/butchr_a.token" }]);
      expect(readdirSync(dir)).toEqual(["manifest.json"]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  // BUTCHR-412 review round 3, non-blocking finding: the directory itself
  // (not just the file) should be 0700, created only when this call actually
  // makes it — a pre-existing directory's own mode is left untouched.
  test("creates its own directory at 0700 when absent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "butchr-nexus-manifest-dirmode-"));
    try {
      const nested = join(dir, "nested", "manifest.json");
      await createFileNexusManifestPublisher(nested).publish([]);
      expect(statSync(join(dir, "nested")).mode & 0o777).toBe(0o700);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("a pre-existing directory's mode is left untouched", async () => {
    const dir = mkdtempSync(join(tmpdir(), "butchr-nexus-manifest-dirmode-existing-"));
    try {
      const path = join(dir, "manifest.json"); // dir itself already exists (mkdtempSync's own default mode)
      const before = statSync(dir).mode & 0o777;
      await createFileNexusManifestPublisher(path).publish([]);
      expect(statSync(dir).mode & 0o777).toBe(before);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
