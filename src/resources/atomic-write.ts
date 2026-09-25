/**
 * BUTCHR-454 — a temp-file-then-rename write, shared by every writer of a
 * session-definition manifest (`butchr session create`, and the freeze/
 * unfreeze manifest rewrite in `session-freeze.ts`). The daemon polls the
 * definitions directory every `MANAGED_SESSIONS_POLL_MS` (`session-
 * definitions-loop.ts`) and treats a half-written/truncated file as an
 * invalid definition (`searchSessionDefinitions`, `src/rules/session-
 * definition-type.ts`) — a plain `writeFile` is visible to a concurrent
 * poll mid-write; `rename` on the same filesystem is atomic, so a poll
 * either sees the old content or the new, never a partial one.
 *
 * The temp file is written into the SAME directory as `path` (never
 * `os.tmpdir()`): `rename` is only atomic within one filesystem/mount, and
 * the definitions directory may not share one with the system temp dir.
 */
import { rename, unlink, writeFile as fsWriteFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

export async function writeFileAtomic(path: string, contents: string): Promise<void> {
  const tmp = join(dirname(path), `.${randomUUID()}.tmp`);
  await fsWriteFile(tmp, contents, "utf8");
  try {
    await rename(tmp, path);
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw e;
  }
}
