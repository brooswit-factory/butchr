/**
 * Readiness review on PR #805's current head (FACTORY-137) found a real
 * shutdown regression: `src/daemon/index.ts` originally wired
 * `process.on("SIGTERM", () => catamorbiusPush.stop())` directly. Node/Bun's
 * default behaviour for SIGTERM/SIGINT is to terminate the process
 * immediately; REGISTERING any listener for that signal REPLACES that
 * default. There was no pre-existing SIGTERM/SIGINT handler anywhere in the
 * daemon before this ticket, so that default WAS the daemon's effective
 * shutdown contract — the original code silently dropped it for the whole
 * process (server, poll timers, every loop) the moment push mode was
 * enabled, while only ever cleaning up the push client itself.
 *
 * `attachProcessShutdown` (src/catamorbius/push-controller.ts) is the fix:
 * stop the controller, THEN exit. This test proves it with a REAL child
 * process receiving a REAL signal — the one thing an in-process call to the
 * handler function cannot prove, since that would never exercise whether
 * the process's own default-behaviour override actually got restored.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FIXTURE = join(import.meta.dir, "../fixtures/catamorbius-shutdown-worker.ts");
const MODULE_HREF = new URL("../../../src/catamorbius/push-controller.ts", import.meta.url).href;

async function waitForReady(proc: { stdout: ReadableStream<Uint8Array> }): Promise<void> {
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (!buf.includes("ready\n")) {
      const { value, done } = await reader.read();
      if (done) throw new Error("worker exited before signalling ready");
      buf += decoder.decode(value);
    }
  } finally {
    reader.releaseLock();
  }
}

describe("attachProcessShutdown: a REAL child process, a REAL signal", () => {
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    test(`${signal} stops the controller AND exits the process — the exact regression the readiness review found (the pre-fix handler stopped the controller but never exited)`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "butchr-catamorbius-shutdown-"));
      const logPath = join(dir, "log.txt");
      const proc = Bun.spawn(["bun", "--no-env-file", FIXTURE, MODULE_HREF, logPath], {
        stdout: "pipe", stderr: "pipe",
      });
      try {
        await waitForReady(proc);
        proc.kill(signal);
        const exitCode = await proc.exited; // hangs (test times out) if the regression is present — this process never exits on its own otherwise
        expect(exitCode).toBe(0);
        expect(readFileSync(logPath, "utf8")).toBe("stopped\n"); // cleanup ran BEFORE exit, not skipped by it
      } finally {
        if (proc.exitCode === null) proc.kill("SIGKILL");
        rmSync(dir, { recursive: true, force: true });
      }
    }, 10_000);
  }
});
