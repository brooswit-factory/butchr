/**
 * FACTORY-1043's own acceptance criterion ("Windows CI reproduces current failure and
 * verifies fresh startup plus restart with existing identity") was never actually
 * implemented — the generic `windows` CI job (.github/workflows/ci.yml) is whole-suite
 * and `continue-on-error: true`, so it cannot fail the check on a regression here, and it
 * never starts the real daemon at all. This script does: it starts the REAL daemon
 * (`bun run src/daemon/index.ts`), against an isolated, disposable control-panel
 * directory, waits for it to reach `app.listen()` (the exact point FACTORY-1043's EPERM
 * crashed before), kills it, starts it again, and asserts the SAME deployment identity
 * was reused — then does the same for a from-scratch install to confirm distinct
 * installations get distinct identities. No herdr/agent-spawning is involved; this is
 * scoped to exactly the control-panel/deployment-identity path FACTORY-1043 touches.
 *
 * Isolation: the daemon's own control-panel/rules/workspace state is pointed at a fresh
 * temp directory, and Atlassian/GitHub are both disabled so `loadConfig` never requires
 * real credentials or touches any real provider — this never contacts a real Jira/GitHub
 * account, on Windows OR when run locally. It DOES need a real (but disposable) herdr
 * server reachable at its ordinary default socket location — the CI job starts one
 * before this script runs (see .github/workflows/ci.yml, job
 * windows-deployment-identity), exactly like the existing Linux `spawn-smoke` job's own
 * herdr server; a startup preflight in src/daemon/legacy-preflight.ts refuses to start
 * at all without one, regardless of this script's own isolation.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const READY_LINE = /butchr daemon on http:\/\//;
const READY_TIMEOUT_MS = 30_000;
const DEPLOYMENT_ID_PATTERN = /^[0-9a-f-]{36}$/;

function daemonEnv(workDir: string, port: number): Record<string, string> {
  return {
    ...process.env,
    // Isolates this daemon's own control-panel/rules/workspace state. XDG_CONFIG_HOME is
    // deliberately left at its real default: that's where the CI job's own herdr server
    // (started before this script runs) puts its socket, and where DrovrClient's default
    // looks for it too — overriding it here would make this daemon unable to find that
    // real, already-running herdr server.
    BUTCHR_CONTROL_PANEL_DIR: join(workDir, "control"),
    BUTCHR_RULES_FILE: join(workDir, "rules.json"),
    BUTCHR_WORKSPACES: join(workDir, "workspaces"),
    BUTCHR_PORT: String(port),
    BUTCHR_ATLASSIAN_ENABLED: "false",
  };
}

/** BUTCHR_RULES_FILE, unlike the default rules path, throws if it doesn't already exist. */
function ensureRulesFile(workDir: string): void {
  writeFileSync(join(workDir, "rules.json"), JSON.stringify({ rules: [] }) + "\n");
}

async function startDaemon(workDir: string, port: number): Promise<{ proc: ReturnType<typeof Bun.spawn>; output: () => string }> {
  const proc = Bun.spawn([process.execPath, "run", "src/daemon/index.ts"], {
    env: daemonEnv(workDir, port),
    stdout: "pipe",
    stderr: "pipe",
    cwd: join(import.meta.dir, ".."),
  });
  let combined = "";
  (async () => { for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) combined += new TextDecoder().decode(chunk); })();
  (async () => { for await (const chunk of proc.stderr as ReadableStream<Uint8Array>) combined += new TextDecoder().decode(chunk); })();
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (READY_LINE.test(combined)) return { proc, output: () => combined };
    if (proc.exitCode !== null) throw new Error(`daemon exited (code ${proc.exitCode}) before reaching HTTP listen. Output:\n${combined}`);
    await Bun.sleep(100);
  }
  proc.kill();
  throw new Error(`daemon did not reach HTTP listen within ${READY_TIMEOUT_MS}ms. Output so far:\n${combined}`);
}

async function stopDaemon(proc: ReturnType<typeof Bun.spawn>): Promise<void> {
  proc.kill();
  await Promise.race([proc.exited, Bun.sleep(5_000)]);
}

function deploymentIdOf(workDir: string): string {
  const text = readFileSync(join(workDir, "control", "deployment-id"), "utf8").trim();
  if (!DEPLOYMENT_ID_PATTERN.test(text)) throw new Error(`deployment-id file content is not a well-formed identity: ${JSON.stringify(text)}`);
  return text;
}

function assertNoEpermOrFsyncFailure(output: string, phase: string): void {
  if (/EPERM/.test(output) || /fsync/i.test(output)) {
    throw new Error(`${phase}: daemon output mentions EPERM/fsync — this is exactly what FACTORY-1043 fixed:\n${output}`);
  }
}

async function main() {
  // Fresh install #1: first start creates the identity; a restart must reuse it.
  const workDirA = mkdtempSync(join(tmpdir(), "butchr-ci-windows-deploy-id-a-"));
  try {
    ensureRulesFile(workDirA);
    const first = await startDaemon(workDirA, 27_801);
    assertNoEpermOrFsyncFailure(first.output(), "fresh start");
    const firstId = deploymentIdOf(workDirA);
    await stopDaemon(first.proc);

    const second = await startDaemon(workDirA, 27_802);
    assertNoEpermOrFsyncFailure(second.output(), "restart");
    const secondId = deploymentIdOf(workDirA);
    await stopDaemon(second.proc);

    if (firstId !== secondId) throw new Error(`restart did not reuse the existing deployment identity: fresh=${firstId} restart=${secondId}`);
    console.log(`OK: fresh start + restart with existing identity reuses the SAME identity (${firstId}), no EPERM/fsync failure.`);

    // Fresh install #2: a SEPARATE installation must get a DISTINCT identity.
    const workDirB = mkdtempSync(join(tmpdir(), "butchr-ci-windows-deploy-id-b-"));
    try {
      ensureRulesFile(workDirB);
      const third = await startDaemon(workDirB, 27_803);
      assertNoEpermOrFsyncFailure(third.output(), "second fresh install");
      const thirdId = deploymentIdOf(workDirB);
      await stopDaemon(third.proc);
      if (thirdId === firstId) throw new Error(`a separate installation got the SAME deployment identity as the first: ${thirdId}`);
      console.log(`OK: a second, separate installation gets a DISTINCT identity (${thirdId}).`);
    } finally {
      rmSync(workDirB, { recursive: true, force: true });
    }
  } finally {
    rmSync(workDirA, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(String(e instanceof Error ? e.stack ?? e.message : e));
  process.exit(1);
});
