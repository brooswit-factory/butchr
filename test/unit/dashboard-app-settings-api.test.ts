import { describe, expect, test } from "bun:test";
import { createFixturesSettingsApi, defaultSettingsFixture, DaemonRestartUnavailableError, RateLimitError, SettingsWriteRefusedError } from "../../dashboard-app/src/api/settings.js";

describe("createFixturesSettingsApi", () => {
  test("listSettings returns the default fixture when none is supplied", async () => {
    const api = createFixturesSettingsApi();
    const result = await api.listSettings();
    expect(result).toEqual(defaultSettingsFixture());
  });

  test("listSettings returns a supplied response verbatim", async () => {
    const custom = { ...defaultSettingsFixture(), settings: [] };
    const api = createFixturesSettingsApi({ response: custom });
    expect(await api.listSettings()).toEqual(custom);
  });

  test("testJiraConnection defaults to an ok 2xx result", async () => {
    const api = createFixturesSettingsApi();
    const result = await api.testJiraConnection();
    expect(result.ok).toBe(true);
    expect(result.httpStatusClass).toBe("2xx");
  });

  test("testJiraConnection one-shot nextJiraTest is consumed then reverts to default", async () => {
    const api = createFixturesSettingsApi({ nextJiraTest: { ok: false, site: "x", httpStatusClass: "401/403", error: "nope" } });
    const first = await api.testJiraConnection();
    expect(first.httpStatusClass).toBe("401/403");
    const second = await api.testJiraConnection();
    expect(second.ok).toBe(true);
  });

  test("testJiraConnection one-shot nextRateLimit throws RateLimitError, then clears", async () => {
    const api = createFixturesSettingsApi({ nextRateLimit: { retryAfterSeconds: 3 } });
    await expect(api.testJiraConnection()).rejects.toBeInstanceOf(RateLimitError);
    const second = await api.testJiraConnection();
    expect(second.ok).toBe(true);
  });

  // FACTORY-665
  test("writeSetting updates the in-memory fixture's own value/source, returned by a later listSettings", async () => {
    const api = createFixturesSettingsApi();
    const written = await api.writeSetting("BUTCHR_MAX_AGENTS", "20", false);
    const row = written.settings.find((e) => e.key === "BUTCHR_MAX_AGENTS")!;
    expect(row.secret).toBe(false);
    if (!row.secret) { expect(row.value).toBe("20"); expect(row.source).toBe("file"); }
    expect(await api.listSettings()).toEqual(written);
  });

  test("writeSetting one-shot nextWriteError is thrown then cleared", async () => {
    const err = new SettingsWriteRefusedError("above the confirm ceiling", true);
    const api = createFixturesSettingsApi({ nextWriteError: err });
    await expect(api.writeSetting("BUTCHR_MAX_AGENTS", "999", false)).rejects.toBe(err);
    // cleared: a second call succeeds
    await expect(api.writeSetting("BUTCHR_MAX_AGENTS", "20", false)).resolves.toBeDefined();
  });

  test("restartDaemon resolves by default", async () => {
    const api = createFixturesSettingsApi();
    await expect(api.restartDaemon()).resolves.toBeUndefined();
  });

  test("restartDaemon one-shot nextRestartError is thrown then cleared", async () => {
    const err = new DaemonRestartUnavailableError("restart butchr manually");
    const api = createFixturesSettingsApi({ nextRestartError: err });
    await expect(api.restartDaemon()).rejects.toBe(err);
    await expect(api.restartDaemon()).resolves.toBeUndefined();
  });
});
