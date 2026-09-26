import { describe, expect, test } from "bun:test";
import { createManagedSessionEscalationWatcher } from "../../src/agents/managed-session-escalation-watcher.js";
import type { Escalator } from "../../src/agents/escalation-loop.js";

// The real trust-dialog text this repo already fixtures elsewhere
// (test/unit/escalation-loop.test.ts's own TRUST) — verified against the
// REAL @brooswit/drovr 0.15.0 classifyBlockingScreen to classify as
// `{ kind: "startup", name: "trust", keys: ["down", "enter"] }`: a dialog
// drovr WOULD press without this module's no-op override.
const TRUST_SCREEN = `──────────────────────────────
 Accessing workspace:
 /home/brooswit/butchr-workspaces/KAN-706
 Quick safety check: Is this a project you created or one you trust? (Like your own code, a
 well-known open source project, or work from your team). If not, take a moment to review
 what's in this folder first.
 Claude Code'll be able to read, edit, and execute files here.
 Security guide
 ❯ No, exit
   Yes, I trust this folder
 Enter to confirm · Esc to cancel`;

// Verified against the real package to classify as `{ kind: "unknown",
// dialog: { question, options } }` — a dialog drovr never presses, only
// reports/escalates.
const UNKNOWN_SCREEN = `Teach auto mode about your environment?
❯ 1. Sure, let's go
  2. Not now
  3. Never ask again
Enter to confirm · Esc to cancel`;

// `agent: "claude"` is load-bearing: drovr's own `scanBlockingPrompts` filters to `agent.agent === "claude"` before reading anything — verified against the real installed package (a pane without it is silently skipped, never read).
const AGENT_BASE = { agent: "claude" as const, focused: true, revision: 1, tab_id: "t1", terminal_id: "term1", workspace_id: "w1" };

function fakeClient(screensByPane: Record<string, string>) {
  const sendKeysCalls: unknown[] = [];
  const readCalls: string[] = [];
  return {
    sendKeysCalls,
    readCalls,
    client: {
      agent: {
        list: async () => ({
          type: "agent_list" as const,
          agents: Object.keys(screensByPane).map((pane_id) => ({ ...AGENT_BASE, pane_id, agent_status: "blocked" as const })),
        }),
        read: async (p: { target: string }) => {
          readCalls.push(p.target);
          return { type: "pane_read" as const, read: { format: "text" as const, pane_id: p.target, revision: 1, source: "detection" as const, tab_id: "t1", text: screensByPane[p.target] ?? "", truncated: false, workspace_id: "w1" } };
        },
        sendKeys: async (p: unknown) => { sendKeysCalls.push(p); return { type: "ok" as const }; },
      },
    },
  };
}

function fakeEscalator() {
  const unknownDialogCalls: Array<{ paneId: string; question: string; options: readonly string[]; fingerprint: string }> = [];
  const resolvedCalls: Array<{ paneId: string; fingerprint: string }> = [];
  const escalator: Pick<Escalator, "onDrovrUnknownDialog" | "onDrovrDialogResolved"> = {
    onDrovrUnknownDialog: async (escalation) => { unknownDialogCalls.push(escalation); },
    onDrovrDialogResolved: (resolved) => { resolvedCalls.push(resolved); },
  };
  return { escalator, unknownDialogCalls, resolvedCalls };
}

describe("createManagedSessionEscalationWatcher (FACTORY-45 Part B review fix)", () => {
  test("a recognized startup (trust) dialog is detected but NEVER pressed — the caller's own sendKeys is never called", async () => {
    const { client, sendKeysCalls } = fakeClient({ p1: TRUST_SCREEN });
    const { escalator, unknownDialogCalls } = fakeEscalator();
    const watcher = createManagedSessionEscalationWatcher(escalator);

    await watcher.poll(client);

    expect(sendKeysCalls).toEqual([]); // the whole point of the fix: drovr detects, never presses
    expect(unknownDialogCalls).toEqual([]); // a recognized startup prompt is not "unknown" — no escalation either
  });

  test("a genuinely unknown dialog still reaches escalator.onDrovrUnknownDialog, with no key ever pressed", async () => {
    const { client, sendKeysCalls } = fakeClient({ p1: UNKNOWN_SCREEN });
    const { escalator, unknownDialogCalls } = fakeEscalator();
    const watcher = createManagedSessionEscalationWatcher(escalator);

    await watcher.poll(client);

    expect(sendKeysCalls).toEqual([]);
    expect(unknownDialogCalls.length).toBe(1);
    expect(unknownDialogCalls[0]).toMatchObject({
      paneId: "p1",
      question: "Teach auto mode about your environment?",
      options: ["Sure, let's go", "Not now", "Never ask again"],
    });
    expect(typeof unknownDialogCalls[0]!.fingerprint).toBe("string");
  });

  test("a resolved episode reaches escalator.onDrovrDialogResolved once the dialog clears", async () => {
    const screens: Record<string, string> = { p1: UNKNOWN_SCREEN };
    const { client } = fakeClient(screens);
    const { escalator, unknownDialogCalls, resolvedCalls } = fakeEscalator();
    const watcher = createManagedSessionEscalationWatcher(escalator);

    await watcher.poll(client);
    expect(unknownDialogCalls.length).toBe(1);

    screens.p1 = "Nothing blocking here now.";
    // Re-list as not-blocked/no-dialog by removing the pane from the fake's own screens map has no effect on list(); simulate
    // clearing by returning empty text for the SAME pane, which drovr reads as no-longer-waiting.
    delete screens.p1;
    await watcher.poll(client);

    expect(resolvedCalls).toEqual([{ paneId: "p1", fingerprint: unknownDialogCalls[0]!.fingerprint }]);
  });
});
