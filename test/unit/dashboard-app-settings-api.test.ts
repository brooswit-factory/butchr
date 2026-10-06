import { describe, expect, test } from "bun:test";
import { createFixturesSettingsApi, defaultSettingsFixture, RateLimitError } from "../../dashboard-app/src/api/settings.js";

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
});
