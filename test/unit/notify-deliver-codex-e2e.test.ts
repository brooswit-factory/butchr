import { afterAll, describe, expect, test } from "bun:test";
import { buildApp, notifyAgent } from "../../src/daemon/app.js";
import { deliverNotice, renderNotifyDelivery } from "../../src/notify/deliver.js";
import { FakeConnection } from "@brooswit/thatch/testing";

/**
 * FACTORY-893/FACTORY-894 acceptance E — Codex behaviour must stay
 * byte-identical after the gate lands: a Codex agent still receives its
 * prompt, and the channel push still excludes it. This test exercises the
 * REAL `notifyAgent`/`sendAll` code path (src/daemon/app.ts, untouched by
 * this ticket) through the real HTTP/MCP connection machinery, composed
 * with the new `deliverNotice` gate — not a fake standing in for
 * `notifyAgent`'s own exclusion logic. If this ticket's change to
 * `notifyAgent`'s own `where` filter ever regressed (it should not have —
 * this ticket does not touch src/daemon/app.ts at all), THIS is the test
 * that would catch it, not just the plain-object unit tests in
 * notify-deliver.test.ts.
 */
const view = {
  state: async () => [],
  open: async () => ({ ok: true as const }),
  openPane: async () => ({ ok: true as const }),
  health: () => ({ ok: true, components: [] }),
  dashboard: async () => ({ checked: true, confirmedAt: new Date(0).toISOString(), rows: [], admission: { cap: 0, residency: null, sentinels: null, sources: [] } }),
  header: () => ({ build: { sha: null, shaDirty: null, shaUnknownReason: "test fixture", version: "0.0.0", versionProvenance: "tag" as const, versionUnknownReason: null } }),
  resourceLink: async (key: string) => ({ ok: true as const, url: `https://example.invalid/${key}` }),
  configInventory: async () => ({ rules: [], sessionDefinitions: [], errors: [] }),
};
const { app, mcp } = buildApp(view);
app.listen(0);
const base = `http://localhost:${app.server!.port}`;
afterAll(async () => { await mcp.closeAll(); app.stop(); });

describe("deliverNotice + real notifyAgent: a Codex-provider connection", () => {
  test("is excluded from the channel push (sent stays empty) and the gate falls back to the prompt, which still delivers", async () => {
    const codex = await FakeConnection.connect(base, { headers: { "x-issue": "KAN-50", "x-butchr-agent": "jira-work:task:KAN-50", "x-butchr-provider": "codex" } });
    // wait for the channel stream to attach so an empty `sent` reflects the
    // provider exclusion, never a connect race.
    for (let i = 0; i < 100 && !mcp.connections.get(codex.sessionId!); i++) await Bun.sleep(5);

    let nudgeCalls = 0;
    const result = await deliverNotice({
      pushChannel: () => notifyAgent(mcp, "jira-work:task:KAN-50", "KAN-50", "a notice"),
      nudgePrompt: async () => { nudgeCalls++; return { delivered: true }; },
    });

    expect(result).toEqual({ via: "prompt", fallbackReason: "no channel attached", delivered: true });
    expect(nudgeCalls).toBe(1); // the prompt is Codex's ONLY real delivery — unchanged by this ticket
    expect(renderNotifyDelivery(result)).toBe("Claude channel unavailable (no channel attached), fell back to prompt: prompt delivered");

    await codex.disconnect();
  });

  test("control: a Claude (non-codex) connection on the same shape DOES receive the channel push, and the prompt is never called", async () => {
    const claude = await FakeConnection.connect(base, { headers: { "x-issue": "KAN-51", "x-butchr-agent": "jira-work:task:KAN-51" } });
    let push; for (let i = 0; i < 100; i++) { push = await notifyAgent(mcp, "jira-work:task:KAN-51", "KAN-51", "probe"); if (push.sent.length) break; await Bun.sleep(10); }
    expect(push!.sent).toEqual([claude.sessionId!]);
    await claude.nextFrame(); // drain the probe push consumed above

    let nudgeCalls = 0;
    const result = await deliverNotice({
      pushChannel: () => notifyAgent(mcp, "jira-work:task:KAN-51", "KAN-51", "a real notice"),
      nudgePrompt: async () => { nudgeCalls++; return { delivered: true }; },
    });
    expect(result).toEqual({ via: "channel" });
    expect(nudgeCalls).toBe(0);
    await claude.disconnect();
  });
});
