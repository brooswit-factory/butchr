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

// ---- director 2026-10-06 items 4-6 ----
import { handleJiraTokenWrite } from "../../src/web/setup-api.js";
import { createSetupCodeManager } from "../../src/setup/setup-code.js";
import { buildSetupModeViewDeps } from "../../src/daemon/setup-mode.js";
import { writeSetting, SettingProvidedByEnvironmentError } from "../../src/settings/write-settings.js";
import { MAX_AGENTS_HARD_MAX, loadSettingsFile } from "../../src/settings/settings-file.js";
import { buildSettingEntries } from "../../src/web/settings-api.js";
import { writeFileSync, mkdirSync, chmodSync } from "node:fs";

describe("rate limits only count after a correct setup code (item 5)", () => {
  const okFetch = (async () => new Response(JSON.stringify({ accountId: "acc-1", displayName: "A" }), { status: 200 })) as never;
  test("three wrong codes spend no limiter budget; the correct code then succeeds; only a limited correct code sees 429", async () => {
    const mgr = createSetupCodeManager();
    const home = mkdtempSync(join(tmpdir(), "butchr-gate-"));
    let gateCalls = 0;
    let allow = true;
    const rateGate = () => { gateCalls++; return allow ? ({ ok: true } as const) : ({ ok: false, error: "rate limited", retryAfterSeconds: 7 } as const); };
    const deps = { setupCode: mgr, path: join(home, "secrets", "atlassian-token"), env: { BUTCHR_JIRA_IDENTITY_FILE: join(home, "id.json") }, fetchFn: okFetch };
    const input = { site: "https://x.atlassian.net", email: "a@b.c", token: "tok" };
    try {
      const code = mgr.mint();
      for (let i = 0; i < 3; i++) expect((await handleJiraTokenWrite({ ...input, setupCode: "WRONGWRONGWRO" }, deps, { requireEnvCheck: false, rateGate })).status).toBe(400);
      expect(gateCalls).toBe(0);
      const ok = await handleJiraTokenWrite({ ...input, setupCode: code }, deps, { requireEnvCheck: false, rateGate });
      expect(ok.status).toBe(200);
      expect(gateCalls).toBe(1);
      allow = false;
      const code2 = mgr.mint();
      const limited = await handleJiraTokenWrite({ ...input, setupCode: code2 }, deps, { requireEnvCheck: false, rateGate });
      expect(limited.status).toBe(429);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});

describe("setup mode restarts itself after a successful setup (item 6)", () => {
  test("success -> onSetupComplete + body.restarting; failure or non-durable identity -> no restart", async () => {
    const home = mkdtempSync(join(tmpdir(), "butchr-restart-"));
    try {
      const okFetch = (async () => new Response(JSON.stringify({ accountId: "acc-1", displayName: "A" }), { status: 200 })) as never;
      let completed = 0;
      const env = { HOME: home, XDG_CONFIG_HOME: join(home, "cfg"), BUTCHR_SECRETS_DIR: join(home, "secrets") };
      const { viewDeps, setupCodeManager } = buildSetupModeViewDeps(0, env, () => {}, okFetch, () => { completed++; });
      const input = { site: "https://x.atlassian.net", email: "a@b.c", token: "tok" };
      const bad = await viewDeps.setupJiraWrite!({ ...input, setupCode: "NOPENOPENOPEN" });
      expect(bad.ok).toBe(false);
      expect(completed).toBe(0);
      const good = await viewDeps.setupJiraWrite!({ ...input, setupCode: setupCodeManager.mint() });
      expect(good.ok).toBe(true);
      expect((good as { body: { restarting?: boolean } }).body.restarting).toBe(true);
      expect(completed).toBe(1);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});

describe("settings: env wins (409), hard maximum, loader agrees (item 4)", () => {
  test("PUT of an env-set key is refused with SettingProvidedByEnvironmentError; blank env counts as unset; editable is false for env rows", () => {
    const home = mkdtempSync(join(tmpdir(), "butchr-set-"));
    try {
      const env = { XDG_CONFIG_HOME: home, HOME: home, BUTCHR_MAX_AGENTS: "24" } as Record<string, string | undefined>;
      expect(() => writeSetting("BUTCHR_MAX_AGENTS", "10", false, env as never)).toThrow(SettingProvidedByEnvironmentError);
      expect(() => writeSetting("BUTCHR_MAX_AGENTS", "10", false, { ...env, BUTCHR_MAX_AGENTS: "  " } as never)).not.toThrow();
      const rows = buildSettingEntries(env, env, {});
      expect(rows.find((r) => r.key === "BUTCHR_MAX_AGENTS")!.editable).toBe(false);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
  test("the hard maximum refuses even with confirm; a confirmed value up to it survives the loader", () => {
    expect(() => writeSetting("BUTCHR_MAX_AGENTS", String(MAX_AGENTS_HARD_MAX + 1), true, { XDG_CONFIG_HOME: "/nonexistent-x", HOME: "/nonexistent-x" } as never)).toThrow();
    const home = mkdtempSync(join(tmpdir(), "butchr-load-"));
    try {
      const env = { XDG_CONFIG_HOME: home, HOME: home } as Record<string, string | undefined>;
      mkdirSync(join(home, "butchr"), { recursive: true });
      writeSetting("BUTCHR_MAX_AGENTS", "80", true, env as never);
      const loaded = loadSettingsFile(env as never);
      expect(loaded.values.BUTCHR_MAX_AGENTS).toBe("80");
      expect(loaded.problems).toEqual([]);
      void writeFileSync; void chmodSync;
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
