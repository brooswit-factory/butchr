import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redactUrlUserinfo } from "../../src/web/settings-api.js";
import { validateSettingValue } from "../../src/settings/settings-file.js";

// agentsafety A2 review (2026-10-06) items 1-3, against the REAL daemon entry (not a re-assembled view).
function freePort(): number {
  const s = Bun.serve({ port: 0, fetch: () => new Response("") });
  const p = s.port as number;
  s.stop(true);
  return p;
}

async function spawnEntry(extraEnv: Record<string, string>, port: number) {
  const home = mkdtempSync(join(tmpdir(), "butchr-setup-entry-"));
  const proc = Bun.spawn(["bun", "src/daemon/index.ts"], {
    cwd: join(import.meta.dir, "../.."),
    env: { PATH: process.env.PATH ?? "", HOME: home, XDG_CONFIG_HOME: join(home, "cfg"), BUTCHR_PORT: String(port), BUTCHR_SECRETS_DIR: join(home, "secrets"), ...extraEnv },
    stdout: "pipe", stderr: "pipe",
  });
  return { proc, home };
}

describe("real daemon entry: setup mode", () => {
  test("a fresh install (no Atlassian state at all) STAYS UP in setup mode and /health answers 503 setupMode", async () => {
    const port = freePort();
    const { proc, home } = await spawnEntry({}, port);
    try {
      let res: Response | undefined;
      for (let i = 0; i < 60 && !res; i++) {
        if (proc.exitCode !== null) break;
        try { res = await fetch(`http://127.0.0.1:${port}/health`); } catch { await Bun.sleep(250); }
      }
      expect(proc.exitCode).toBeNull();
      expect(res?.status).toBe(503);
      expect((await res!.json() as { setupMode?: boolean }).setupMode).toBe(true);
      await Bun.sleep(1500);
      expect(proc.exitCode).toBeNull(); // still up after the 1.4 s the old process.exit(1) fired at
    } finally {
      proc.kill();
      await proc.exited;
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);

  test("PARTIAL Atlassian config (site+email, no token) exits 1 loudly instead of a quiet setup mode", async () => {
    const port = freePort();
    const { proc, home } = await spawnEntry({ ATLASSIAN_SITE: "https://example.atlassian.net", ATLASSIAN_EMAIL: "a@example.com" }, port);
    try {
      const code = await Promise.race([proc.exited, Bun.sleep(15_000).then(() => "timeout" as const)]);
      expect(code).toBe(1);
      expect(await new Response(proc.stderr).text()).toContain("Missing required config");
    } finally {
      proc.kill();
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("poison model value", () => {
  test("flag-shaped, multi-line, NUL, spaced and oversized models are refused; ordinary ones accepted", () => {
    for (const bad of ["--dangerously-skip-permissions", "opus\n--mcp-config /tmp/evil.json", "a\0b", "opus 4", "a".repeat(65)]) {
      expect(validateSettingValue("BUTCHR_AGENT_MODEL", bad, false).ok).toBe(false);
    }
    for (const good of ["opus", "claude-opus-5-5", "gpt-5.1-codex", "anthropic/claude-sonnet-5-5:fast"]) {
      expect(validateSettingValue("BUTCHR_AGENT_MODEL", good, false).ok).toBe(true);
    }
  });
  test("redactUrlUserinfo is linear on a 64 KB run of scheme characters", () => {
    const t = performance.now();
    redactUrlUserinfo("a".repeat(64_000));
    expect(performance.now() - t).toBeLessThan(250);
    expect(redactUrlUserinfo("see https://u:pw@host/x and ftp://v@h")).toBe("see https://[redacted]@host/x and ftp://[redacted]@h");
  });
});
