import { describe, expect, test } from "bun:test";
import { deliverNotice, renderNotifyDelivery, type ChannelPushResult, type NotifyDelivery } from "../../src/notify/deliver.js";
import type { NudgeResult } from "../../src/agents/herd.js";

/**
 * FACTORY-893/FACTORY-894 — `deliverNotice` is the ONE gate every delivery
 * seam (src/daemon/index.ts) now routes through, replacing the old
 * `void notifyAgent(...).catch(...)` + unconditional `herd.nudge(...)`
 * pairing repeated at all 7 seams. These tests exercise the gate in
 * isolation via fake `pushChannel`/`nudgePrompt` closures — no real
 * `McpHandle`/`Herd` needed, since every seam's closures are this thin.
 *
 * FAILS-ON-BASE NOTE (acceptance criterion A): on the base commit,
 * `deliverNotice` does not exist at all — the old code unconditionally
 * awaited `herd.nudge` after merely firing-and-forgetting the channel push.
 * A test asserting "prompt not called when channel delivers" could not
 * even be expressed against that shape without first building this gate;
 * by inspection of the base pairing (`void notifyAgent(...).catch(...)`
 * discards the result, then `await herd.nudge(...)` always runs next with
 * nothing consulted), `nudgePrompt`/`herd.nudge` was unconditionally called
 * on every notice — i.e. "the happy-path test below would fail on base" is
 * true by construction, not by running it there. Policy (this ticket, this
 * repo) forbids running tests locally; CI runs this suite against the PR
 * branch, where the gate exists and the assertion holds.
 */

function ok(sent: string[], refused: ChannelPushResult["refused"] = []): ChannelPushResult {
  return { sent, refused };
}

describe("deliverNotice: acceptance A — channel available means the prompt path is never called", () => {
  test("non-empty sent, nothing refused: delivers on channel only", async () => {
    let nudgeCalls = 0;
    const result = await deliverNotice({
      pushChannel: async () => ok(["conn-1"]),
      nudgePrompt: async () => { nudgeCalls++; return { delivered: true }; },
    });
    expect(result).toEqual({ via: "channel" });
    expect(nudgeCalls).toBe(0); // the actual regression this ticket closes: asserting push was called is not enough
  });

  test("non-empty sent with a DIFFERENT id also refused: still channel-only (at least one real delivery)", async () => {
    let nudgeCalls = 0;
    const result = await deliverNotice({
      pushChannel: async () => ok(["conn-1"], [{ id: "conn-2", reason: "not-connected" }]),
      nudgePrompt: async () => { nudgeCalls++; return { delivered: true }; },
    });
    expect(result).toEqual({ via: "channel" });
    expect(nudgeCalls).toBe(0);
  });
});

describe("deliverNotice: acceptance B — no channel available falls back, and the fallback is distinguishable", () => {
  test("empty sent: falls back to the prompt, which delivers", async () => {
    const result = await deliverNotice({
      pushChannel: async () => ok([]),
      nudgePrompt: async () => ({ delivered: true }),
    });
    expect(result).toEqual({ via: "prompt", fallbackReason: "no channel attached", delivered: true });
  });
});

describe("deliverNotice: acceptance C — every ambiguous/failure case falls back, never assumes delivery", () => {
  test("push rejects: falls back", async () => {
    let nudgeCalls = 0;
    const result = await deliverNotice({
      pushChannel: async () => { throw new Error("boom"); },
      nudgePrompt: async () => { nudgeCalls++; return { delivered: true }; },
    });
    expect(result.via).toBe("prompt");
    expect((result as { fallbackReason: string }).fallbackReason).toBe("channel push threw: boom");
    expect(nudgeCalls).toBe(1);
  });

  test("push throws synchronously (not just rejects): falls back", async () => {
    const result = await deliverNotice({
      // eslint-disable-next-line @typescript-eslint/require-await -- deliberately synchronous throw inside an async-typed closure
      pushChannel: (() => { throw new Error("sync boom"); }) as unknown as () => Promise<ChannelPushResult>,
      nudgePrompt: async () => ({ delivered: true }),
    });
    expect(result).toEqual({ via: "prompt", fallbackReason: "channel push threw: sync boom", delivered: true });
  });

  test("sent is empty: falls back", async () => {
    const result = await deliverNotice({ pushChannel: async () => ok([]), nudgePrompt: async () => ({ delivered: false }) });
    expect(result).toEqual({ via: "prompt", fallbackReason: "no channel attached", delivered: false });
  });

  test("sent is non-empty but every entry also appears in refused: falls back (defensive — the real sendAll never does this)", async () => {
    const result = await deliverNotice({
      pushChannel: async () => ok(["conn-1"], [{ id: "conn-1", reason: "closed-mid-send" }]),
      nudgePrompt: async () => ({ delivered: true }),
    });
    expect(result).toEqual({ via: "prompt", fallbackReason: "channel reported sent but every connection was also refused", delivered: true });
  });

  test("nudgePrompt itself rejects: treated as not delivered, never throws out of the gate", async () => {
    const result = await deliverNotice({
      pushChannel: async () => ok([]),
      nudgePrompt: async () => { throw new Error("pane gone"); },
    });
    expect(result).toEqual({ via: "prompt", fallbackReason: "no channel attached", delivered: false });
  });

  test("availability read unavailable (push resolves undefined-shaped/garbage is not representable; the honest version is a reject) — pinned via reject above, plus: push resolves but with no sent field at all behaves like empty", async () => {
    const result = await deliverNotice({
      pushChannel: async () => ({ sent: [], refused: [] }),
      nudgePrompt: async () => ({ delivered: true }),
    });
    expect(result).toEqual({ via: "prompt", fallbackReason: "no channel attached", delivered: true });
  });
});

describe("deliverNotice: session-limit refusal surfaces through the gate", () => {
  test("prompt fallback hits a session-limit refusal: carried on the result", async () => {
    const refusal: NudgeResult["refusal"] = { resetsAt: 1_700_000_000_000 };
    const result = await deliverNotice({
      pushChannel: async () => ok([]),
      nudgePrompt: async () => ({ delivered: true, refusal }),
    });
    expect(result).toEqual({ via: "prompt", fallbackReason: "no channel attached", delivered: true, refusal });
  });
});

describe("acceptance E — Codex: notifyAgent's own x-butchr-provider exclusion already makes `sent` empty for a Codex connection, so this gate falls back exactly like before, byte-identically", () => {
  test("a push that reflects Codex's exclusion (always empty sent) still reaches the prompt", async () => {
    let pushCalls = 0, nudgeCalls = 0;
    const result = await deliverNotice({
      pushChannel: async () => { pushCalls++; return ok([]); }, // what notifyAgent resolves to for a codex-only connection set
      nudgePrompt: async () => { nudgeCalls++; return { delivered: true }; },
    });
    expect(pushCalls).toBe(1); // channel push is still attempted (unchanged: it always was)
    expect(nudgeCalls).toBe(1); // and the prompt is still the only real delivery, same as before this ticket
    expect(result).toEqual({ via: "prompt", fallbackReason: "no channel attached", delivered: true });
  });
});

describe("renderNotifyDelivery: acceptance F — the three distinguishable [notify] outcomes", () => {
  test("channel-delivered", () => {
    expect(renderNotifyDelivery({ via: "channel" })).toBe("Claude channel delivered");
  });

  test("fell-back (prompt delivered)", () => {
    const d: NotifyDelivery = { via: "prompt", fallbackReason: "no channel attached", delivered: true };
    expect(renderNotifyDelivery(d)).toBe("Claude channel unavailable (no channel attached), fell back to prompt: prompt delivered");
  });

  test("neither (fell back, and the prompt ALSO didn't land)", () => {
    const d: NotifyDelivery = { via: "prompt", fallbackReason: "no channel attached", delivered: false };
    expect(renderNotifyDelivery(d)).toBe("Claude channel unavailable (no channel attached), fell back to prompt: prompt refused/absent");
  });

  test("fell back into a session-limit refusal: refusal text wins over the bare delivered flag", () => {
    const d: NotifyDelivery = { via: "prompt", fallbackReason: "no channel attached", delivered: true, refusal: { resetsAt: 1_700_000_000_000 } };
    expect(renderNotifyDelivery(d)).toBe(
      `Claude channel unavailable (no channel attached), fell back to prompt: refused (session limit, resets ${new Date(1_700_000_000_000).toISOString()})`,
    );
  });

  test("fell back into a session-limit refusal with unknown reset time", () => {
    const d: NotifyDelivery = { via: "prompt", fallbackReason: "channel push threw: boom", delivered: false, refusal: { resetsAt: null } };
    expect(renderNotifyDelivery(d)).toBe(
      "Claude channel unavailable (channel push threw: boom), fell back to prompt: refused (session limit, resets unknown)",
    );
  });
});
