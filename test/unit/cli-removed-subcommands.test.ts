/**
 * local/ui — `butchr link` and `butchr session` went with managed links and
 * managed sessions. They, and any other unknown subcommand, must be refused
 * before the daemon starts anything. Each case runs the real entry point in a
 * throwaway home with no .env, so nothing here can reach a real config.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "butchr-cli-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));

async function run(...args: string[]) {
  const proc = Bun.spawn(["bun", "--no-env-file", join(import.meta.dir, "../../src/daemon/index.ts"), ...args], {
    cwd: home,
    env: { PATH: process.env.PATH ?? "", HOME: home, XDG_CONFIG_HOME: join(home, ".config"), BUTCHR_PORT: "1", HERDR_SOCKET: join(home, "no-herdr.sock") },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  return { code, stderr };
}

describe("butchr: removed and unknown subcommands", () => {
  test("link and session say what they went with, exit 2, and start nothing", async () => {
    for (const [sub, why] of [["link", "managed links"], ["session", "managed sessions"]] as const) {
      const { code, stderr } = await run(sub, "list");
      expect(code).toBe(2);
      expect(stderr).toContain(`butchr ${sub}: removed along with ${why}.`);
    }
    // Nothing of butchr's was created: no config dir, settings or rules file. (Bun itself may cache under the temp HOME.)
    expect(existsSync(join(home, ".config", "butchr"))).toBe(false);
  }, 30_000);

  test("an unknown subcommand is refused with the usage", async () => {
    const { code, stderr } = await run("nope");
    expect(code).toBe(2);
    expect(stderr).toContain('butchr: unknown command "nope"');
  }, 30_000);
});
