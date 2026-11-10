/**
 * Test preload (bunfig.toml `[test] preload`): drovr's real `startManagedAgent`
 * (once the pin advances past drovr PR #100, FACTORY-1041) gates every launch
 * on `checkCanonicalMode` resolving "raw"/"unsupported" for the pane's
 * reported `shell_pid` — read from a `{type: "pane_process_info",
 * process_info: {shell_pid, ...}}` reply to `client.pane.processInfo` (the
 * `type` tag matters: `agent-start.ts`'s own `shellPid` lookup requires
 * `info?.type === "pane_process_info"` before it even looks at
 * `process_info.shell_pid`, the same discriminator the real herdr SDK's
 * `ResponseResult` union uses). None of this suite's fake herdr clients run a
 * real shell or tag their replies this way, so without an override every
 * launch across EVERY test file that constructs a `HerdrHerd` and drives a
 * real spawn/resume would poll the full `canonicalModeTimeoutMs` (5s) bound
 * and then genuinely fail.
 *
 * Patching every fixture's `pane.processInfo` individually (dozens of inline
 * clients across more than ten test files, almost all predating this ticket)
 * would be both huge and fragile. Patching `startManagedAgent` itself
 * instead, universally and ONCE for the whole run (here, not per-file), needs
 * only one seam: wrap the CLIENT it's given so a missing/untagged
 * `processInfo` reply falls back to a synthetic `shell_pid`-bearing one, and
 * always supply a fast `checkCanonicalMode` default. A fixture that already
 * returns a validly-tagged reply (because it cares about the REAL `shell_pid`
 * value for its own assertions) passes through unchanged — spread order
 * below, the real reply first, synthetic only as a fallback. Same for
 * `checkCanonicalMode`: a test that threads its own through `HerdrHerd`'s own
 * constructor seam (reaching here as `options.checkCanonicalMode`) still
 * wins over this default.
 *
 * Installed here (a `[test] preload` module, loaded before any test file) so
 * every file in the run gets it with no per-file setup/teardown, and so there
 * is no `atlassian-real.test.ts`-style cross-file leak to guard against: this
 * mock is meant to be the live one for the ENTIRE process, every file, not a
 * per-test override that must be undone before the next file runs.
 */
import { mock } from "bun:test";

const realDrovr = { ...(await import("@brooswit/drovr")) };
mock.module("@brooswit/drovr", () => ({
  ...realDrovr,
  startManagedAgent: (client: { pane?: { processInfo?: (p: { pane_id: string }) => Promise<unknown> } }, params: unknown, options: Record<string, unknown> = {}) => {
    const originalProcessInfo = client?.pane?.processInfo;
    const patchedClient = {
      ...client,
      pane: {
        ...client?.pane,
        processInfo: async (p: { pane_id: string }) => {
          if (typeof originalProcessInfo === "function") {
            try {
              const reply = await originalProcessInfo(p);
              if (reply && (reply as { type?: string }).type === "pane_process_info") return reply;
            } catch { /* fall through to the synthetic reply below */ }
          }
          return { type: "pane_process_info" as const, process_info: { pane_id: p.pane_id, shell_pid: 1, foreground_processes: [] } };
        },
      },
    };
    return (realDrovr.startManagedAgent as (...args: unknown[]) => unknown)(patchedClient, params, { checkCanonicalMode: async () => "raw" as const, ...options });
  },
}));
