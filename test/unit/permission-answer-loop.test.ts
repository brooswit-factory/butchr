import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPermissionAnswerTick, startPermissionAnswerLoop, type PermissionAnswerClient } from "../../src/agents/permission-answer-loop.js";

// Measured live against the REAL installed @brooswit/drovr 0.15.0
// `classifyPermissionPrompt` (this file's own probe, run against
// node_modules/@brooswit/drovr/dist/index.js) — this is the exact text
// documented as a real capture in the package's own
// dist/permission-approval.d.ts header comment (claude 2.1.277,
// 2026-09-18), confirmed here to classify with option 2 ("Yes, and always
// allow …") as the `scope: "always"` target `autoAnswerPermissions` presses.
const ALWAYS_ALLOW_SCREEN = `─────────────────────────────────────────
 Bash command
 Tip: auto mode handles these prompts for you — …

   touch drovr-permission-probe.txt
   Create empty probe file

 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and always allow access to /tmp/… from this project
   3. Yes, and switch to auto mode · auto mode handles these prompts for you
   4. No

 Esc to cancel · Tab to amend`;

// A permission dialog with no "always" stored-rule option at all — measured
// the same way; `autoAnswerPermissions` must skip this one without ever
// calling sendKeys, per its own documented contract (never presses when
// option 2 isn't unambiguously the "Yes, and …" choice).
const NO_ALWAYS_SCREEN = `─────────────────────────────────────────
 Bash command

   rm -rf /

 Do you want to proceed?
 ❯ 1. Yes
   2. No

 Esc to cancel · Tab to amend`;

const AGENT_BASE = { agent: "claude" as const, focused: true, revision: 1, tab_id: "t1", terminal_id: "term1", workspace_id: "w1" };

function fakeClient(screensByPaneInit: Record<string, string>): { client: PermissionAnswerClient; sendKeysCalls: unknown[] } {
  // Mutable copy: `sendKeys` below clears a pane's screen after pressing, the
  // same way a real approval clears the dialog off screen — without this,
  // `approvePermission`'s own verify loop (re-reads the pane, waits for the
  // promptId to stop matching) never sees the prompt clear and spins until
  // its 5s `verifyTimeoutMs` default, timing the test out.
  const screensByPane = { ...screensByPaneInit };
  const sendKeysCalls: unknown[] = [];
  const client: PermissionAnswerClient = {
    agent: {
      list: async () => ({
        type: "agent_list" as const,
        agents: Object.keys(screensByPane).map((pane_id) => ({ ...AGENT_BASE, pane_id, agent_status: "blocked" as const })),
      }),
      get: (async () => { throw new Error("not used by autoAnswerPermissions"); }) as PermissionAnswerClient["agent"]["get"],
      read: (async (p: { target: string }) => ({
        type: "pane_read" as const,
        read: { format: "text" as const, pane_id: p.target, revision: 1, source: "detection" as const, tab_id: "t1", text: screensByPane[p.target] ?? "", truncated: false, workspace_id: "w1" },
      })) as PermissionAnswerClient["agent"]["read"],
      sendKeys: (async (p: { target: string }) => { sendKeysCalls.push(p); screensByPane[p.target] = "cleared"; return { type: "ok" as const }; }) as PermissionAnswerClient["agent"]["sendKeys"],
    },
  };
  return { client, sendKeysCalls };
}

describe("runPermissionAnswerTick", () => {
  test("presses the unambiguous always-allow option and writes an audit record", async () => {
    const dir = mkdtempSync(join(tmpdir(), "perm-audit-"));
    const auditPath = join(dir, "audit.jsonl");
    const { client, sendKeysCalls } = fakeClient({ p1: ALWAYS_ALLOW_SCREEN });
    const lines: string[] = [];

    const results = await runPermissionAnswerTick({ client, auditPath, operator: "test-op", log: (l) => lines.push(l) });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ paneId: "p1", outcome: "answered", tool: "Bash command" });
    expect(sendKeysCalls).toEqual([{ target: "p1", keys: ["down", "enter"] }]);
    const audit = readFileSync(auditPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(audit).toHaveLength(2); // "approving" then "approved" — approvePermission's own two-record contract
    expect(audit.every((r) => r.operator === "test-op")).toBe(true);
    expect(lines.some((l) => l.includes("1 answered"))).toBe(true);

    rmSync(dir, { recursive: true, force: true });
  });

  test("a prompt with no always-allow option is skipped — sendKeys is never called, no audit record is written", async () => {
    const dir = mkdtempSync(join(tmpdir(), "perm-audit-"));
    const auditPath = join(dir, "audit.jsonl");
    const { client, sendKeysCalls } = fakeClient({ p1: NO_ALWAYS_SCREEN });

    const results = await runPermissionAnswerTick({ client, auditPath });

    expect(results).toHaveLength(1);
    expect(results[0]?.outcome).toBe("skipped");
    expect(sendKeysCalls).toEqual([]);

    rmSync(dir, { recursive: true, force: true });
  });

  test("no pane is showing a permission prompt at all — empty result, nothing pressed, nothing logged", async () => {
    const dir = mkdtempSync(join(tmpdir(), "perm-audit-"));
    const auditPath = join(dir, "audit.jsonl");
    const { client, sendKeysCalls } = fakeClient({ p1: "some ordinary working pane, nothing pending here" });
    const lines: string[] = [];

    const results = await runPermissionAnswerTick({ client, auditPath, log: (l) => lines.push(l) });

    expect(results).toEqual([]);
    expect(sendKeysCalls).toEqual([]);
    expect(lines).toEqual([]);

    rmSync(dir, { recursive: true, force: true });
  });

  test("a rejecting scan (agent.list itself throws) is caught and logged, never thrown out of the tick", async () => {
    const client: PermissionAnswerClient = {
      agent: {
        list: (async () => { throw new Error("herdr socket down"); }) as PermissionAnswerClient["agent"]["list"],
        get: (async () => { throw new Error("not used"); }) as PermissionAnswerClient["agent"]["get"],
        read: (async () => { throw new Error("not used"); }) as PermissionAnswerClient["agent"]["read"],
        sendKeys: (async () => { throw new Error("not used"); }) as PermissionAnswerClient["agent"]["sendKeys"],
      },
    };
    const lines: string[] = [];

    const results = await runPermissionAnswerTick({ client, auditPath: "/dev/null", log: (l) => lines.push(l) });

    expect(results).toEqual([]);
    expect(lines.some((l) => l.includes("tick failed") && l.includes("herdr socket down"))).toBe(true);
  });

  test("readTimeoutMs and operator, when given, are forwarded through to autoAnswerPermissions (operator lands in the audit record)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "perm-audit-"));
    const auditPath = join(dir, "audit.jsonl");
    const { client } = fakeClient({ p1: ALWAYS_ALLOW_SCREEN });

    await runPermissionAnswerTick({ client, auditPath, operator: "butchr-daemon", readTimeoutMs: 8_000 });

    const audit = readFileSync(auditPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(audit[0]?.operator).toBe("butchr-daemon");

    rmSync(dir, { recursive: true, force: true });
  });
});

describe("startPermissionAnswerLoop", () => {
  test("guards against overlapping ticks: a slow tick makes the next timer firing a no-op instead of running concurrently", async () => {
    const dir = mkdtempSync(join(tmpdir(), "perm-audit-"));
    const auditPath = join(dir, "audit.jsonl");
    let inFlightCount = 0;
    let maxConcurrent = 0;
    let listCalls = 0;
    const client: PermissionAnswerClient = {
      agent: {
        list: (async () => {
          listCalls++;
          inFlightCount++;
          maxConcurrent = Math.max(maxConcurrent, inFlightCount);
          await new Promise((r) => setTimeout(r, 30));
          inFlightCount--;
          return { type: "agent_list" as const, agents: [] };
        }) as PermissionAnswerClient["agent"]["list"],
        get: (async () => { throw new Error("not used"); }) as PermissionAnswerClient["agent"]["get"],
        read: (async () => { throw new Error("not used"); }) as PermissionAnswerClient["agent"]["read"],
        sendKeys: (async () => { throw new Error("not used"); }) as PermissionAnswerClient["agent"]["sendKeys"],
      },
    };

    const timer = startPermissionAnswerLoop({ client, auditPath }, 5);
    await new Promise((r) => setTimeout(r, 100));
    clearInterval(timer);

    expect(maxConcurrent).toBe(1); // never more than one tick in flight at once
    expect(listCalls).toBeGreaterThan(1); // the guard let later ticks through once the first settled

    rmSync(dir, { recursive: true, force: true });
  });
});
