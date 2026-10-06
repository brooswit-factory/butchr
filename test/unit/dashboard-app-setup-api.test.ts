import { describe, expect, test } from "bun:test";
import { createFixturesSetupApi, defaultSetupSuccess, RateLimitError } from "../../dashboard-app/src/api/setup.js";

describe("createFixturesSetupApi", () => {
  test("getStatus returns configured:false by default", async () => {
    const api = createFixturesSetupApi();
    expect(await api.getStatus()).toEqual({ configured: false });
  });

  test("getStatus returns a supplied status verbatim", async () => {
    const api = createFixturesSetupApi({ status: { configured: true } });
    expect(await api.getStatus()).toEqual({ configured: true });
  });

  test("submitSetup defaults to a success result", async () => {
    const api = createFixturesSetupApi();
    const result = await api.submitSetup({ site: "s", email: "e", token: "t", setupCode: "c" });
    expect(result).toEqual(defaultSetupSuccess());
  });

  test("rotateToken shares the same one-shot nextResult as submitSetup", async () => {
    const api = createFixturesSetupApi({ nextResult: defaultSetupSuccess({ rotated: true, accountId: "rot-1" }) });
    const first = await api.rotateToken({ token: "t", setupCode: "c" });
    expect(first.rotated).toBe(true);
    expect(first.accountId).toBe("rot-1");
    const second = await api.submitSetup({ site: "s", email: "e", token: "t", setupCode: "c" });
    expect(second).toEqual(defaultSetupSuccess()); // reverted to default after one-shot consumed
  });

  test("a one-shot nextResult.throw is thrown then cleared", async () => {
    const api = createFixturesSetupApi({ nextResult: { throw: new Error("setup code: mismatch") } });
    await expect(api.submitSetup({ site: "s", email: "e", token: "t", setupCode: "c" })).rejects.toThrow("setup code: mismatch");
    const second = await api.submitSetup({ site: "s", email: "e", token: "t", setupCode: "c" });
    expect(second.ok).toBe(true);
  });

  test("a one-shot nextRateLimit throws RateLimitError, then clears", async () => {
    const api = createFixturesSetupApi({ nextRateLimit: { retryAfterSeconds: 42 } });
    const err = await api.submitSetup({ site: "s", email: "e", token: "t", setupCode: "c" }).catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect((err as RateLimitError).retryAfterSeconds).toBe(42);
    const second = await api.rotateToken({ token: "t", setupCode: "c" });
    expect(second.ok).toBe(true);
  });
});
