import { describe, expect, test } from "bun:test";
import { encodeAgentKey } from "../../src/rules/agent-key.js";
import { MANAGED_SESSIONS_RULE_ID } from "../../src/rules/session-definition-type.js";
import type { AccountLifecycleHooks, ReconcileReleaseReason } from "../../src/agents/account-lifecycle.js";
import { createAccountLifecycle } from "../../src/agents/account-lifecycle.js";
import { createAccountManager } from "../../src/accounts/manager.js";
import { reconcileNow } from "../../src/daemon/loop.js";
import { rcUsernameFor } from "../../src/accounts/identity.js";
import { fakeManifestPublisher, fakeRcClient, fakeStore, baseAccountManagerDeps } from "../fixtures/rocketchat-fakes.js";
import type { Herd, SpawnSpec } from "../../src/agents/herd.js";
import { wireManagedSessionArchiveRelease } from "../../src/agents/managed-session-account-release.js";

const managedSessionId = (path: string, ruleId: string = MANAGED_SESSIONS_RULE_ID) =>
  encodeAgentKey({ resourceProvider: "filesystem", ruleId, resourceId: path });

function fakeHooks() {
  const releaseCalls: Array<{ id: string; reason: ReconcileReleaseReason }> = [];
  const ensureCalls: unknown[] = [];
  let retryCalls = 0;
  let publishCalls = 0;
  const hooks: AccountLifecycleHooks = {
    async ensure(spec) { ensureCalls.push(spec); return spec; },
    async release(id, reason) { releaseCalls.push({ id, reason }); },
    async retryPendingReleases() { retryCalls++; },
    async publishBatch() { publishCalls++; },
  };
  return { hooks, releaseCalls, ensureCalls, getRetryCalls: () => retryCalls, getPublishCalls: () => publishCalls };
}

function fakeExists(paths: Set<string>) {
  return async (path: string): Promise<boolean> => paths.has(path);
}

describe("wireManagedSessionArchiveRelease", () => {
  test("a \"stop\" release for a managed-session id upgrades to \"archive\" when the archive directory now holds the same basename", async () => {
    const { hooks, releaseCalls } = fakeHooks();
    const id = managedSessionId("/home/butchr/.config/butchr/session-definitions/foo.json");
    const exists = fakeExists(new Set(["/home/butchr/.config/butchr/session-definitions-archive/foo.json"]));
    const wrapped = wireManagedSessionArchiveRelease(hooks, { exists });
    await wrapped.release(id, "stop");
    expect(releaseCalls).toEqual([{ id, reason: "archive" }]);
  });

  test("a \"stop\" release for a managed-session id stays \"stop\" when nothing matching exists in the archive directory (deleted, invalidated, or frozen — not archived)", async () => {
    const { hooks, releaseCalls } = fakeHooks();
    const id = managedSessionId("/home/butchr/.config/butchr/session-definitions/foo.json");
    const wrapped = wireManagedSessionArchiveRelease(hooks, { exists: fakeExists(new Set()) });
    await wrapped.release(id, "stop");
    expect(releaseCalls).toEqual([{ id, reason: "stop" }]);
  });

  test("a \"respawn\" release is never upgraded, even if a same-basename file exists in the archive directory", async () => {
    const { hooks, releaseCalls } = fakeHooks();
    const id = managedSessionId("/defs/foo.json");
    const wrapped = wireManagedSessionArchiveRelease(hooks, { exists: fakeExists(new Set(["/defs-archive/foo.json"])) });
    await wrapped.release(id, "respawn");
    expect(releaseCalls).toEqual([{ id, reason: "respawn" }]);
  });

  test("a non-managed-session id's \"stop\" release is never upgraded, even if a coincidentally-matching path exists", async () => {
    const { hooks, releaseCalls } = fakeHooks();
    const id = encodeAgentKey({ resourceProvider: "jira-work", ruleId: "triage", resourceId: "BUTCHR-1" });
    const wrapped = wireManagedSessionArchiveRelease(hooks, { exists: fakeExists(new Set(["/anything"])) });
    await wrapped.release(id, "stop");
    expect(releaseCalls).toEqual([{ id, reason: "stop" }]);
  });

  test("respects the archive-dir env override (BUTCHR_SESSION_ARCHIVE_DIR), not just the sibling-suffix default", async () => {
    const { hooks, releaseCalls } = fakeHooks();
    const id = managedSessionId("/defs/foo.json");
    const wrapped = wireManagedSessionArchiveRelease(hooks, {
      exists: fakeExists(new Set(["/custom-archive/foo.json"])),
      env: { BUTCHR_SESSION_ARCHIVE_DIR: "/custom-archive" },
    });
    await wrapped.release(id, "stop");
    expect(releaseCalls).toEqual([{ id, reason: "archive" }]);
  });

  test("a custom ruleId is honoured — an id under a DIFFERENT rule id is never treated as a managed-session agent even if it decodes as \"filesystem\"", async () => {
    const { hooks, releaseCalls } = fakeHooks();
    const id = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "some-other-filesystem-rule", resourceId: "/defs/foo.json" });
    const wrapped = wireManagedSessionArchiveRelease(hooks, { exists: fakeExists(new Set(["/defs-archive/foo.json"])) });
    await wrapped.release(id, "stop");
    expect(releaseCalls).toEqual([{ id, reason: "stop" }]);
  });

  test("ensure/retryPendingReleases/publishBatch pass straight through to the wrapped hooks, unchanged", async () => {
    const { hooks, ensureCalls, getRetryCalls, getPublishCalls } = fakeHooks();
    const wrapped = wireManagedSessionArchiveRelease(hooks, { exists: fakeExists(new Set()) });
    const spec = { key: "x", issuetype: "task", summary: "s", parent: null } as Parameters<AccountLifecycleHooks["ensure"]>[0];
    await wrapped.ensure(spec);
    await wrapped.retryPendingReleases();
    await wrapped.publishBatch();
    expect(ensureCalls).toEqual([spec]);
    expect(getRetryCalls()).toBe(1);
    expect(getPublishCalls()).toBe(1);
  });
});

/**
 * End to end, through the REAL `reconcileNow` (`src/daemon/loop.ts`) with a
 * fake RC — same discipline as `test/unit/account-reconcile-matrix.test.ts`
 * — proving BUTCHR-460's own DoD directly: archiving a `temporary`-account
 * managed-session definition releases its account exactly once, `permanent`
 * is retained, `none` does nothing, archive -> unarchive -> archive never
 * double-releases or leaks, and the Nexus manifest no longer lists a
 * released account after the release path has run.
 */
describe("BUTCHR-460 end to end: managed-session archive release through the real reconciler", () => {
  const DEF_PATH = "/home/butchr/.config/butchr/session-definitions/foo.json";
  const ARCHIVED_PATH = "/home/butchr/.config/butchr/session-definitions-archive/foo.json";
  const KEY = encodeAgentKey({ resourceProvider: "filesystem", ruleId: MANAGED_SESSIONS_RULE_ID, resourceId: DEF_PATH });

  function fakeHerd(): Herd & { running: Set<string>; spawnedSpecs: Map<string, SpawnSpec> } {
    const running = new Set<string>();
    const spawnedSpecs = new Map<string, SpawnSpec>();
    return {
      running, spawnedSpecs,
      async runningIssues() { return [...running]; },
      async staleIssues() { return []; },
      async spawn(spec) { spawnedSpecs.set(spec.key, spec); running.add(spec.key); },
      async stop(id) { running.delete(id); },
      async paneFor(id) { return running.has(id) ? `pane-${id}` : null; },
      async nudge() { return { delivered: true }; },
    };
  }

  function build(policy: "none" | "temporary" | "permanent") {
    const store = fakeStore();
    const { client, calls } = fakeRcClient();
    const manager = createAccountManager(baseAccountManagerDeps({ client, store, now: () => "2026-09-24T00:00:00.000Z", randomPassword: () => "fixed" }));
    const manifestPublisher = fakeManifestPublisher();
    const rawHooks = createAccountLifecycle({ manager, policyOf: () => policy, manifestPublisher });
    let archived = false; // toggled to simulate `butchr session archive`/`unarchive` moving the file
    const account = wireManagedSessionArchiveRelease(rawHooks, { exists: async (p) => archived && p === ARCHIVED_PATH });
    const herd = fakeHerd();
    const spec: SpawnSpec = { key: KEY, issuetype: "managed-session", summary: "s", parent: null };
    return { store, calls, manifestPublisher, account, herd, spec, setArchived: (v: boolean) => { archived = v; } };
  }

  test("temporary: archiving releases the account exactly once, reason \"archive\", and the Nexus manifest no longer lists it", async () => {
    const { store, calls, manifestPublisher, account, herd, spec, setArchived } = build("temporary");

    // Poll 1: desired — spawns and provisions.
    await reconcileNow(herd, new Map([[KEY, spec]]), { account });
    expect(herd.spawnedSpecs.get(KEY)?.rocketchatAccount).toBe(rcUsernameFor(KEY));
    expect(await store.get(KEY)).toMatchObject({ policy: "temporary" });
    expect(manifestPublisher.publishes.at(-1)).toEqual([{ account: rcUsernameFor(KEY), tokenFile: expect.any(String) }]);

    // The definition is archived (file moved) — no longer desired.
    setArchived(true);
    await reconcileNow(herd, new Map(), { account });

    expect(await store.get(KEY)).toBeNull(); // unprovisioned
    expect(calls.filter((c) => c.method === "deleteUser")).toHaveLength(1); // exactly once
    expect(manifestPublisher.publishes.at(-1)).toEqual([]); // no longer lists the released account
  });

  test("permanent: archiving retains the account — never released", async () => {
    const { store, calls, account, herd, spec, setArchived } = build("permanent");
    await reconcileNow(herd, new Map([[KEY, spec]]), { account });
    expect(await store.get(KEY)).toMatchObject({ policy: "permanent" });

    setArchived(true);
    await reconcileNow(herd, new Map(), { account });

    expect(await store.get(KEY)).not.toBeNull(); // retained
    expect(calls.filter((c) => c.method === "deleteUser")).toHaveLength(0);
  });

  test("none: archiving does nothing — the account manager is never touched", async () => {
    const { calls, account, herd, spec, setArchived } = build("none");
    await reconcileNow(herd, new Map([[KEY, spec]]), { account });
    setArchived(true);
    await reconcileNow(herd, new Map(), { account });
    expect(calls).toEqual([]);
  });

  test("archive -> unarchive -> archive never double-releases or leaks", async () => {
    const { store, calls, account, herd, spec, setArchived } = build("temporary");

    // spawn + provision
    await reconcileNow(herd, new Map([[KEY, spec]]), { account });
    expect(await store.get(KEY)).not.toBeNull();

    // archive: releases
    setArchived(true);
    await reconcileNow(herd, new Map(), { account });
    expect(await store.get(KEY)).toBeNull();
    expect(calls.filter((c) => c.method === "deleteUser")).toHaveLength(1);

    // unarchive: desired again — re-provisions (a fresh account, the old one is really gone)
    setArchived(false);
    await reconcileNow(herd, new Map([[KEY, spec]]), { account });
    expect(await store.get(KEY)).not.toBeNull();
    expect(calls.filter((c) => c.method === "createUser")).toHaveLength(2); // original + re-provision

    // archive again: releases again — exactly once more, never a double-release of the same record
    setArchived(true);
    await reconcileNow(herd, new Map(), { account });
    expect(await store.get(KEY)).toBeNull();
    expect(calls.filter((c) => c.method === "deleteUser")).toHaveLength(2);
  });

  test("a release failure is queued and retried, never lost — reason \"archive\" is preserved through the retry (cf. how BUTCHR-412 queues failed releases)", async () => {
    const store = fakeStore();
    const { client: baseClient, calls } = fakeRcClient();
    let failDeleteOnce = true;
    const client = {
      ...baseClient,
      async deleteUser(userId: string) {
        if (failDeleteOnce) { failDeleteOnce = false; throw new Error("transient RC outage"); }
        return baseClient.deleteUser(userId);
      },
    };
    const manager = createAccountManager(baseAccountManagerDeps({ client, store, now: () => "2026-09-24T00:00:00.000Z", randomPassword: () => "fixed" }));
    const manifestPublisher = fakeManifestPublisher();
    const logs: string[] = [];
    const rawHooks = createAccountLifecycle({ manager, policyOf: () => "temporary", manifestPublisher, log: (l) => logs.push(l) });
    let archived = false;
    const account = wireManagedSessionArchiveRelease(rawHooks, { exists: async (p) => archived && p === ARCHIVED_PATH });
    const herd = fakeHerd();
    const spec: SpawnSpec = { key: KEY, issuetype: "managed-session", summary: "s", parent: null };

    await reconcileNow(herd, new Map([[KEY, spec]]), { account });
    expect(await store.get(KEY)).not.toBeNull();

    // Archived: the release itself throws (the RC delete call fails transiently, before ever
    // reaching the fake client's own call log) — queued, never lost, and `release` itself never
    // rethrows (reconcileNow completes this poll normally).
    archived = true;
    await reconcileNow(herd, new Map(), { account });
    expect(await store.get(KEY)).not.toBeNull(); // still there — the failed attempt never partially released it
    expect(calls.filter((c) => c.method === "deleteUser")).toHaveLength(0); // the attempt threw before the fake client logged it
    expect(logs.some((l) => l.includes("WARNING") && l.includes("release (archive) failed") && l.includes("queued for retry"))).toBe(true);

    // Next poll: `retryPendingReleases` (called once per poll by `reconcileNow`, independent of
    // `plan.stop`) drains the queue — the underlying call now succeeds, and the reason logged is
    // still "archive", not a generic "stop": it was decided once, at the original release call,
    // and the queue preserves it verbatim through the retry.
    await reconcileNow(herd, new Map(), { account });
    expect(await store.get(KEY)).toBeNull();
    expect(calls.filter((c) => c.method === "deleteUser")).toHaveLength(1); // the retry's own successful call
    expect(logs.some((l) => l.includes("[account]") && l.includes("released (archive)"))).toBe(true);
  });
});
