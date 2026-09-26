/**
 * BUTCHR-460 — wires `releaseAccount(agentKey, "archive")` (S4, BUTCHR-395)
 * into `butchr session archive` (S3, BUTCHR-394), daemon-side.
 *
 * WHY DAEMON-SIDE, NOT THE CLI'S OWN `onArchived` HOOK: `archiveSessionDefinition`
 * (`../resources/session-archive.js`) accepts an injected `onArchived` hook
 * for exactly this — but `butchr session archive` is a credential-free,
 * daemon-free CLI process (`../cli/session-cli.ts`'s own top comment). It
 * has no Rocket.Chat client, no account store, and no Nexus manifest
 * publisher — wiring release there would mean a SECOND process writing
 * `.butchr-rc-accounts.json` with no cross-process lock (the account
 * manager's own in-process keyed lock does not span processes — see
 * `docs/rocketchat-accounts.md`'s "Race-safety: two layers"), and the Nexus
 * hand-off manifest is only ever republished by the daemon's own per-poll
 * batch (`AccountLifecycleHooks.publishBatch`), so a CLI-side release would
 * leave a released account listed in the manifest until the daemon's next
 * unrelated batch happened to run. `archiveSessionDefinition`'s `onArchived`
 * stays a documented no-op (`../cli/session-cli.ts`'s `defaultIo()`); this
 * module is the real release path instead.
 *
 * WHY NOT THE GENERIC `plan.stop` DIFF EITHER, EVEN THOUGH THAT'S WHERE A
 * MANAGED-SESSION AGENT'S STOP ITSELF ALREADY HAPPENS: `release(id, reason)`
 * (`./account-lifecycle.js`) is deliberately "one hook, every path covered
 * by construction, not a per-mechanism special case" — `reconcileNow`
 * (`../daemon/loop.js`) calls it with a flat `"stop"` for EVERY id that
 * drops out of `desired`, regardless of why (a definition deleted outright,
 * edited invalid, frozen, OR archived). That flatness is correct for
 * STOPPING the herd process — every one of those cases is genuinely "this
 * rule no longer desires this agent" — but it cannot express the one thing
 * this ticket's own DoD asks for: an archived definition's release should
 * carry `ReleaseReason` `"archive"` (BUTCHR-410's own named entry point,
 * `releaseAccount(agentKey, "archive")` — see `docs/rocketchat-accounts.md`),
 * not the generic `"stop"`, since it's a distinct, already-modeled reason
 * that (before this ticket) no call site in this codebase ever produced
 * (`./account-lifecycle.js`'s own `ReconcileReleaseReason` doc comment).
 * `stop`/`archive` behave IDENTICALLY in `releaseAccount` itself today (both
 * unprovision a `temporary` account, retain a `permanent` one) — this is
 * purely about the audit trail (the `[account] ... released (archive)` log
 * line, and the archive-vs-stop distinction a future reader of that line, or
 * of a `WARNING: [account] ... release (archive) failed` retry-queue line,
 * would want) being honest about WHY, not a behavioural change.
 *
 * THE MECHANISM: `wireManagedSessionArchiveRelease` wraps the SAME shared
 * `AccountLifecycleHooks` instance every other provider already uses
 * (`ensure`/`retryPendingReleases`/`publishBatch` pass straight through
 * unchanged) and intercepts only `release`. For a `"stop"` call against an id
 * this loop owns (`ownsManagedSessionAgent`), it decodes the id back to the
 * ACTIVE definition path it was encoded from (`SessionDefinitionMatch.agentKey`
 * is built from `resource.path`, the file's path AT THE TIME it was still
 * eligible — see `session-definition-type.ts`'s own `searchSessionDefinitions`)
 * and checks whether a file of that EXACT basename now exists in the archive
 * directory (`sessionArchiveDir`, `../resources/session-archive.js` — the
 * ONE function every archive-directory caller resolves through, reused here
 * rather than a second ad hoc computation). A positive check is about as
 * strong a signal as a daemon-side poll can get without an IPC channel to the
 * CLI: `archive`/`unarchive` always preserve the exact original basename (the
 * identity rule `session-archive.ts`'s own top comment names), and a file
 * only ever lands there via `butchr session archive` or an operator hand-move
 * — indistinguishable from this module's own point of view, which is exactly
 * the point: this positively covers "an archive done by hand-moving a file"
 * too, something a CLI-side hook could never see. A NEGATIVE check (nothing
 * at that path in the archive directory) falls through to the ordinary
 * `"stop"` release unchanged — a deleted, invalidated, or frozen definition
 * is still released, just logged as an ordinary stop, exactly as it already
 * is for every other provider today.
 */
import { basename, dirname, join } from "node:path";
import { access } from "node:fs/promises";
import { decodeAnyAgentKey } from "../rules/agent-key.js";
import { MANAGED_SESSIONS_RULE_ID, ownsManagedSessionAgent } from "../rules/session-definition-type.js";
import { sessionArchiveDir } from "../resources/session-archive.js";
import type { SessionDefinitionsEnv } from "../resources/session-definition.js";
import type { AccountLifecycleHooks, ReconcileReleaseReason } from "./account-lifecycle.js";

export interface ManagedSessionArchiveReleaseDeps {
  /** Whether a path exists — real `access()` in production; a fake in tests. Never a directory listing: a single-path existence check is all this needs. */
  exists: (path: string) => Promise<boolean>;
  /** Same env `startManagedSessionsLoop` resolves its own root from — `BUTCHR_SESSION_ARCHIVE_DIR`/`BUTCHR_SESSION_DEFINITIONS_DIR` must agree with whatever produced the id being released. Defaults to `process.env`. */
  env?: SessionDefinitionsEnv;
  /** The built-in rule's own id — defaults to `MANAGED_SESSIONS_RULE_ID`; overridable only so a test can use a distinct id without colliding with a real one. */
  ruleId?: string;
}

/**
 * Wraps `hooks` so a `"stop"` release against a managed-sessions id is
 * upgraded to `"archive"` when (and only when) this module can positively
 * confirm the definition now lives in the archive directory under its
 * original basename — see this module's own top comment for the full
 * reasoning. Every other call (`ensure`, `retryPendingReleases`,
 * `publishBatch`, and `release` for any non-managed-session id, or a
 * `"respawn"` release) passes straight through to `hooks`, unchanged.
 */
export function wireManagedSessionArchiveRelease(hooks: AccountLifecycleHooks, deps: ManagedSessionArchiveReleaseDeps): AccountLifecycleHooks {
  const ruleId = deps.ruleId ?? MANAGED_SESSIONS_RULE_ID;
  return {
    ...hooks,
    async release(id: string, reason: ReconcileReleaseReason) {
      if (reason === "stop" && ownsManagedSessionAgent(id, ruleId)) {
        const decoded = decodeAnyAgentKey(id);
        if (decoded?.kind === "resource") {
          const activePath = decoded.resourceId;
          const archivedPath = join(sessionArchiveDir(deps.env ?? process.env, dirname(activePath)), basename(activePath));
          if (await deps.exists(archivedPath)) {
            await hooks.release(id, "archive");
            return;
          }
        }
      }
      await hooks.release(id, reason);
    },
  };
}

/** The real, disk-touching `exists` — everything `ManagedSessionArchiveReleaseDeps.exists` needs outside tests. */
export const realPathExists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};
