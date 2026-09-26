/**
 * FACTORY-64: pure rendering of the systemd user-unit text this story
 * installs inside WSL — `butchr.service` (reusing the same unit NAME this
 * repo's own `docs/codey-deploy-runbook.md` already assumes for the Linux
 * host path, so an operator who knows one recognises the other) plus
 * `herdr.service` and its `LimitNOFILE` drop-in, matching the shape
 * reported for the hand-built zippy host (FACTORY-58 comment, relayed on
 * this ticket's own ADDENDUM — reproduced here as the shape to aim for,
 * not verified against that live host).
 *
 * These are template strings, not a real unit's negotiated content — no
 * network, no filesystem, no `systemctl`. `cli.ts` is what actually writes
 * the result under `~/.config/systemd/user/` and reloads the user manager.
 */

export interface ButchrUnitOptions {
  /** Absolute path to the butchr checkout this unit runs (e.g. `~/.local/share/butchr/runtime-<short-sha>`, expanded). Source-run mode, same shape `docs/codey-deploy-runbook.md` §1.1 documents for the Linux host: `ExecStart=bun run src/daemon/index.ts`, no separate build step. */
  workingDirectory: string;
  /** Absolute path to the `bun` binary this unit should exec — a transient/user-manager unit's own PATH is not guaranteed to include it (the same PATH trap `scripts/deploy/watchdog.ts`'s own doc comment names for its `systemd-run` command). */
  bunBin: string;
  /**
   * Absolute paths to `EnvironmentFile=` sources, in order — the zippy
   * report names two: a credentials file (`butchr.env`) and a
   * managed-session-provider file (`managed-sessions.env`). Each is
   * rendered with a leading `-` (`EnvironmentFile=-<path>`) so a MISSING
   * file is a normal, silent no-op for systemd rather than a unit that
   * refuses to start — this script creates both empty (0600) when absent
   * (see `cli.ts`), but that ordering (unit written before the operator
   * has necessarily filled in real credentials) must never itself be a
   * startup failure.
   */
  environmentFiles: string[];
  /** Description= line. Defaults to a generic, host-agnostic string. */
  description?: string;
}

export function renderButchrUnit(opts: ButchrUnitOptions): string {
  const description = opts.description ?? "Butchr daemon (WSL host)";
  const envLines = opts.environmentFiles.map((f) => `EnvironmentFile=-${f}`).join("\n");
  return `[Unit]
Description=${description}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${opts.workingDirectory}
${envLines}
ExecStart=${opts.bunBin} run src/daemon/index.ts
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
}

export interface HerdrUnitOptions {
  /** Absolute path to the herdr binary (e.g. `~/.local/bin/herdr`, expanded). */
  herdrBin: string;
  description?: string;
}

export function renderHerdrUnit(opts: HerdrUnitOptions): string {
  const description = opts.description ?? "herdr (WSL host)";
  return `[Unit]
Description=${description}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${opts.herdrBin} serve
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
}

export interface HerdrLimitNofileDropinOptions {
  /** Matches the zippy report's "LimitNOFILE drop-in" alongside herdr.service — herdr holds one pane/pty per running agent, so the default per-process fd limit (often 1024) is worth raising explicitly rather than discovering the ceiling live during a busy fleet. */
  limit?: number;
}

export function renderHerdrLimitNofileDropin(opts: HerdrLimitNofileDropinOptions = {}): string {
  const limit = opts.limit ?? 65536;
  return `[Service]
LimitNOFILE=${limit}
`;
}
