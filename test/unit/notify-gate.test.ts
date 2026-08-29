import { describe, expect, test } from "bun:test";
import { createNotifyGate, type NotifyGateJira } from "../../src/labels/notify-gate.js";
import { AtlassianHttpError } from "../../src/atlassian/client.js";

function fakeJira(canSuppress: boolean): NotifyGateJira & { calls: Array<{ key: string; notify: boolean | undefined }> } {
  const calls: Array<{ key: string; notify: boolean | undefined }> = [];
  return {
    calls,
    async canSuppressNotifications() { return canSuppress; },
    async updateLabels(key, _ops, opts) { calls.push({ key, notify: opts?.notify }); },
  };
}

describe("createNotifyGate", () => {
  test("preflight true -> writes go quiet (notify: false)", async () => {
    const jira = fakeJira(true);
    const logs: string[] = [];
    const gate = createNotifyGate({ jira, account: "booswrit@gmail.com", log: (l) => logs.push(l) });
    await gate.updateLabels("KAN-1", { add: ["agent:idle"] });
    expect(jira.calls).toEqual([{ key: "KAN-1", notify: false }]);
    expect(logs).toEqual(["[labels] KAN: quiet label writes enabled (ADMINISTER_PROJECTS)"]);
  });

  test("preflight false -> writes go notifying (notify: true), with exactly one startup warning naming the account, project, permission, and remedy", async () => {
    const jira = fakeJira(false);
    const logs: string[] = [];
    const gate = createNotifyGate({ jira, account: "booswrit@gmail.com", log: (l) => logs.push(l) });
    await gate.updateLabels("KAN-1", { add: ["agent:idle"] });
    await gate.updateLabels("KAN-2", { add: ["agent:idle"] });
    expect(jira.calls).toEqual([{ key: "KAN-1", notify: true }, { key: "KAN-2", notify: true }]);
    expect(logs.length).toBe(1); // one verdict per project, not per write
    expect(logs[0]).toContain("booswrit@gmail.com");
    expect(logs[0]).toContain("KAN");
    expect(logs[0]).toContain("ADMINISTER_PROJECTS");
    expect(logs[0]).toContain("grant booswrit@gmail.com the Administrator project role on KAN");
  });

  test("a different project's first write preflights independently", async () => {
    const jira = fakeJira(true);
    const seenProjects: string[] = [];
    const wrapped: NotifyGateJira = {
      async canSuppressNotifications(p) { seenProjects.push(p); return true; },
      async updateLabels(key, _ops, opts) { jira.calls.push({ key, notify: opts?.notify }); },
    };
    const gate = createNotifyGate({ jira: wrapped, account: "a@b.c", log: () => {} });
    await gate.updateLabels("KAN-1", { add: ["agent:idle"] });
    await gate.updateLabels("ENG-1", { add: ["agent:idle"] });
    await gate.updateLabels("KAN-2", { add: ["agent:idle"] }); // KAN already cached
    expect(seenProjects).toEqual(["KAN", "ENG"]);
  });

  test("runtime 403 on the quiet path: flips the project to notifying, retries so the write lands, logs once", async () => {
    const calls: Array<{ key: string; notify: boolean | undefined }> = [];
    let quiet403 = true;
    const jira: NotifyGateJira = {
      async canSuppressNotifications() { return true; },
      async updateLabels(key, _ops, opts) {
        calls.push({ key, notify: opts?.notify });
        if (!opts?.notify && quiet403) throw new AtlassianHttpError(403, "PUT", `/rest/api/3/issue/${key}`, "forbidden");
      },
    };
    const logs: string[] = [];
    const gate = createNotifyGate({ jira, account: "booswrit@gmail.com", log: (l) => logs.push(l) });

    await gate.updateLabels("KAN-1", { add: ["agent:idle"] });
    expect(calls).toEqual([{ key: "KAN-1", notify: false }, { key: "KAN-1", notify: true }]); // retried, and landed
    // one verdict line (preflight said quiet was fine) plus one flip line (it wasn't)
    expect(logs.length).toBe(2);
    const flip = logs.find((l) => l.includes("flipping"))!;
    expect(flip).toContain("KAN-1");
    expect(flip).toContain("notifying");
    expect(flip).toContain("grant booswrit@gmail.com the Administrator project role on KAN");

    calls.length = 0;
    logs.length = 0;
    await gate.updateLabels("KAN-2", { add: ["agent:idle"] }); // same project: straight to notifying, no retry, no new log
    expect(calls).toEqual([{ key: "KAN-2", notify: true }]);
    expect(logs).toEqual([]);
  });

  test("a 403 on the notifying path too (something else is wrong) propagates instead of being swallowed", async () => {
    const jira: NotifyGateJira = {
      async canSuppressNotifications() { return false; },
      async updateLabels(_key, _ops) { throw new AtlassianHttpError(403, "PUT", "/rest/api/3/issue/KAN-1", "still forbidden"); },
    };
    const gate = createNotifyGate({ jira, account: "a@b.c", log: () => {} });
    await expect(gate.updateLabels("KAN-1", { add: ["agent:idle"] })).rejects.toThrow(/403/);
  });

  test("a non-403 error on the quiet path is not treated as a permission problem: no flip, propagates as-is", async () => {
    const jira: NotifyGateJira = {
      async canSuppressNotifications() { return true; },
      async updateLabels(_key, _ops, opts) {
        if (!opts?.notify) throw new AtlassianHttpError(500, "PUT", "/rest/api/3/issue/KAN-1", "server error");
      },
    };
    const logs: string[] = [];
    const gate = createNotifyGate({ jira, account: "a@b.c", log: (l) => logs.push(l) });
    await expect(gate.updateLabels("KAN-1", { add: ["agent:idle"] })).rejects.toThrow(/500/);
    expect(logs.some((l) => l.includes("flipping"))).toBe(false); // no flip logged — this isn't a permission problem
  });

  test("the mypermissions check itself failing (never throws, resolves false) still starts and degrades to notifying, with exactly one warning", async () => {
    // canSuppressNotifications on the real client already swallows its own errors (see atlassian.test.ts);
    // the gate only ever sees the resolved boolean, so an erroring preflight looks identical to "no permission".
    const jira = fakeJira(false);
    const logs: string[] = [];
    const gate = createNotifyGate({ jira, account: "booswrit@gmail.com", log: (l) => logs.push(l) });
    await expect(gate.updateLabels("KAN-1", { add: ["agent:idle"] })).resolves.toBeUndefined();
    expect(jira.calls).toEqual([{ key: "KAN-1", notify: true }]);
    expect(logs.length).toBe(1);
  });
});
