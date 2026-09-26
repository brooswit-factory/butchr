/**
 * The Nexus hand-off manifest (BUTCHR-412, corrected S4 design — BUTCHR-391
 * comment 24007): the ONE file butchr ever tells Nexus about, listing, per
 * managed Rocket.Chat account, ONLY the account name and the path to the
 * 0600 file `../accounts/manager.ts` minted its token into — NEVER a token
 * value. Nexus reads this file and registers each account with rocketr;
 * butchr never talks to rocketr directly.
 *
 * BATCHED, NOT PER-AGENT (BUTCHR-391 comment 23997/24007): "each rocketr
 * registration reconnects the whole fleet" — so this file is published at
 * most once per reconcile poll (`../agents/account-lifecycle.ts`'s
 * `publishBatch`), a full snapshot each time, never appended to or written
 * once per agent start.
 *
 * 0600, same write-to-temp-then-rename discipline as
 * `../accounts/manager.ts`'s `createFileAccountStore` — a reader (Nexus,
 * running as a different process, possibly a different user) never observes
 * a partially-written file, and the mode is set on every publish (not just
 * the first, for the same "an existing file's mode survives untouched
 * otherwise" reason `buildWorkspace`'s own chmod does, `src/agents/workspace.ts`).
 */
import { chmodSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** One managed account's hand-off to Nexus: its (non-secret) name, and where its token lives. Never a token value. */
export interface NexusManifestEntry {
  account: string;
  tokenFile: string;
}

export interface NexusManifestPublisher {
  /** Replaces the manifest's entire contents with `entries` — a full snapshot, never an append. Called at most once per reconcile poll. */
  publish(entries: readonly NexusManifestEntry[]): Promise<void>;
}

/**
 * `path` is a configurable, daemon-owned location (`ROCKETCHAT_NEXUS_MANIFEST_FILE`,
 * defaulting under the workspace root — see `src/config/config.ts` — never
 * inside any agent's own workspace directory, same reasoning as
 * `createFileAccountStore`'s own default).
 */
export function createFileNexusManifestPublisher(path: string): NexusManifestPublisher {
  return {
    async publish(entries) {
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const body = JSON.stringify([...entries].sort((a, b) => a.account.localeCompare(b.account)), null, 2);
      writeFileSync(tmp, body, { mode: 0o600 });
      chmodSync(tmp, 0o600); // same belt-and-suspenders as buildWorkspace's own chmod: `mode` on writeFileSync only applies when the open() call creates the file
      try {
        renameSync(tmp, path);
      } catch (e) {
        try { unlinkSync(tmp); } catch { /* best-effort cleanup */ }
        throw e;
      }
      chmodSync(path, 0o600); // renameSync preserves the SOURCE file's mode, which is already 0600 above — this is defense in depth against a future change to that write, not dead code
    },
  };
}
