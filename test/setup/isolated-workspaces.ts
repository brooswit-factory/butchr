/**
 * Test preload (bunfig.toml `[test] preload`): no test may resolve the real
 * default workspace root. `workspaceRoot()` falls back to
 * `~/butchr-workspaces` when BUTCHR_WORKSPACES is unset, so a test that
 * builds a workspace, spawns through the herd, or computes the capture dir
 * without setting it would write into live agent workspaces.
 *
 * The test process gets one fresh temp root, set before any test module is
 * imported (describe bodies capture `workspaceRoot()` at load time) and put
 * back before and after every test — even when a test deleted or overwrote
 * the variable. A test that sets its own root still wins while it runs. The
 * root is removed after the last test.
 */
import { afterAll, afterEach, beforeEach } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// On macOS os.tmpdir() is /var/folders/..., and /var is a symlink to
// /private/var. Code that realpaths a root (filesystem discovery, session
// definitions) or refuses symlinked paths (Drovr's native transcript reader)
// then disagrees with the unresolved path a test built from it. os.tmpdir()
// reads TMPDIR on every call, so resolving it once here gives every test a real
// path. A no-op wherever the temp dir is already real (Linux /tmp).
process.env.TMPDIR = realpathSync(tmpdir());

export const testWorkspaceRoot = mkdtempSync(join(tmpdir(), "butchr-test-workspaces-"));

const isolate = (): void => { process.env.BUTCHR_WORKSPACES = testWorkspaceRoot; };
isolate();
beforeEach(isolate);
afterEach(isolate);
afterAll(() => rmSync(testWorkspaceRoot, { recursive: true, force: true }));
