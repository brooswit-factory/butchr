import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  lizardModeLabelFor, ruleLizardModeOf, runPermissionAnswerTick, startPermissionAnswerLoop,
  type PermissionAnswerClient, type PermissionAnswerPane, type RuleLizardModeDeps,
} from "../../src/agents/permission-answer-loop.js";
import { encodeAgentKey } from "../../src/rules/agent-key.js";
import type { Rule } from "../../src/rules/rules.js";

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

/** Marks every pane eligible, labelled by its own pane id — the "lizard mode is on for everything" test shape, standing in for a real per-agent gate. */
const allEligible = (agents: readonly PermissionAnswerPane[]): ReadonlyMap<string, string> =>
  new Map(agents.map((a) => [a.pane_id, a.pane_id]));

/** Marks nothing eligible — the default/"lizard mode never opted in" shape every real pane starts in. */
const noneEligible = (): ReadonlyMap<string, string> => new Map();

describe("runPermissionAnswerTick", () => {
  test("presses the unambiguous always-allow option on an eligible pane and writes an audit record", async () => {
    const dir = mkdtempSync(join(tmpdir(), "perm-audit-"));
    const auditPath = join(dir, "audit.jsonl");
    const { client, sendKeysCalls } = fakeClient({ p1: ALWAYS_ALLOW_SCREEN });
    const lines: string[] = [];

    const results = await runPermissionAnswerTick({ client, eligiblePanes: allEligible, auditPath, operator: "test-op", log: (l) => lines.push(l) });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ paneId: "p1", outcome: "answered", tool: "Bash command" });
    expect(sendKeysCalls).toEqual([{ target: "p1", keys: ["enter"] }]); // FACTORY-93: option 1 "Yes", once
    const audit = readFileSync(auditPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(audit).toHaveLength(2); // "approving" then "approved" — approvePermission's own two-record contract
    expect(audit.every((r) => r.operator === "test-op")).toBe(true);
    expect(lines.some((l) => l.includes("1 answered"))).toBe(true);
    // FACTORY-67: the journal line must name which agent (the eligiblePanes label) and which tool — not just an opaque pane id.
    expect(lines.some((l) => l.includes("p1") && l.includes("answered") && l.includes("Bash command"))).toBe(true);

    rmSync(dir, { recursive: true, force: true });
  });

  test("DROVR-42/FACTORY-67 opt-in gate: a pane NOT returned by eligiblePanes is never scanned or answered, even with an always-allow dialog on screen — the default for every real pane", async () => {
    const dir = mkdtempSync(join(tmpdir(), "perm-audit-"));
    const auditPath = join(dir, "audit.jsonl");
    const { client, sendKeysCalls } = fakeClient({ p1: ALWAYS_ALLOW_SCREEN });

    const results = await runPermissionAnswerTick({ client, eligiblePanes: noneEligible, auditPath });

    expect(results).toEqual([]);
    expect(sendKeysCalls).toEqual([]); // never pressed — the pane was never even scanned
    rmSync(dir, { recursive: true, force: true });
  });

  test("opt-in gate is per-pane: only the pane eligiblePanes names is scanned, a sibling pane with the identical dialog is left untouched", async () => {
    const dir = mkdtempSync(join(tmpdir(), "perm-audit-"));
    const auditPath = join(dir, "audit.jsonl");
    const { client, sendKeysCalls } = fakeClient({ p1: ALWAYS_ALLOW_SCREEN, p2: ALWAYS_ALLOW_SCREEN });
    const onlyP1 = (agents: readonly PermissionAnswerPane[]): ReadonlyMap<string, string> =>
      new Map(agents.filter((a) => a.pane_id === "p1").map((a) => [a.pane_id, "lizard-def.json"]));

    const results = await runPermissionAnswerTick({ client, eligiblePanes: onlyP1, auditPath });

    expect(results).toHaveLength(1);
    expect(results[0]?.paneId).toBe("p1");
    expect(sendKeysCalls).toEqual([{ target: "p1", keys: ["enter"] }]); // FACTORY-93: option 1 "Yes", once // p2 never touched
    rmSync(dir, { recursive: true, force: true });
  });

  test("FACTORY-93: a prompt with no always-allow option (Yes / No) is still answered — option 1 'Yes', once, never 'No'", async () => {
    const dir = mkdtempSync(join(tmpdir(), "perm-audit-"));
    const auditPath = join(dir, "audit.jsonl");
    const { client, sendKeysCalls } = fakeClient({ p1: NO_ALWAYS_SCREEN });

    const results = await runPermissionAnswerTick({ client, eligiblePanes: allEligible, auditPath });

    expect(results).toHaveLength(1);
    expect(results[0]?.outcome).toBe("answered");
    expect(sendKeysCalls).toEqual([{ target: "p1", keys: ["enter"] }]);
    const audit = readFileSync(auditPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(audit.at(-1)).toMatchObject({ outcome: "approved", scope: "once", option: "Yes" });

    rmSync(dir, { recursive: true, force: true });
  });

  test("no pane is eligible at all — empty result, nothing pressed, nothing logged, and agent.list is the ONLY herdr call made", async () => {
    const dir = mkdtempSync(join(tmpdir(), "perm-audit-"));
    const auditPath = join(dir, "audit.jsonl");
    const { client, sendKeysCalls } = fakeClient({ p1: "some ordinary working pane, nothing pending here" });
    const lines: string[] = [];

    const results = await runPermissionAnswerTick({ client, eligiblePanes: noneEligible, auditPath, log: (l) => lines.push(l) });

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

    const results = await runPermissionAnswerTick({ client, eligiblePanes: allEligible, auditPath: "/dev/null", log: (l) => lines.push(l) });

    expect(results).toEqual([]);
    expect(lines.some((l) => l.includes("tick failed") && l.includes("herdr socket down"))).toBe(true);
  });

  test("FACTORY-100/FACTORY-103: onApproved fires once per answered pane, and a throwing onApproved never fails the tick", async () => {
    const dir = mkdtempSync(join(tmpdir(), "perm-audit-"));
    const auditPath = join(dir, "audit.jsonl");
    const { client } = fakeClient({ p1: ALWAYS_ALLOW_SCREEN, p2: ALWAYS_ALLOW_SCREEN });
    let onApprovedCalls = 0;

    const results = await runPermissionAnswerTick({
      client,
      eligiblePanes: allEligible,
      auditPath,
      onApproved: () => { onApprovedCalls++; throw new Error("boom — must never propagate"); },
    });

    expect(results).toHaveLength(2);
    expect(results.every((r) => r.outcome === "answered")).toBe(true);
    expect(onApprovedCalls).toBe(2); // once per answered pane, despite each call throwing

    rmSync(dir, { recursive: true, force: true });
  });

  test("onApproved is never called for a skipped or failed pane, and is optional (omitting it changes nothing)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "perm-audit-"));
    const auditPath = join(dir, "audit.jsonl");
    const { client } = fakeClient({ p1: "some ordinary working pane, nothing pending here" });

    const results = await runPermissionAnswerTick({ client, eligiblePanes: allEligible, auditPath });

    expect(results).toEqual([]); // nothing answered, nothing to hook
    rmSync(dir, { recursive: true, force: true });
  });

  test("readTimeoutMs and operator, when given, are forwarded through to autoAnswerPermissions (operator lands in the audit record)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "perm-audit-"));
    const auditPath = join(dir, "audit.jsonl");
    const { client } = fakeClient({ p1: ALWAYS_ALLOW_SCREEN });

    await runPermissionAnswerTick({ client, eligiblePanes: allEligible, auditPath, operator: "butchr-daemon", readTimeoutMs: 8_000 });

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

    const timer = startPermissionAnswerLoop({ client, eligiblePanes: noneEligible, auditPath }, 5);
    await new Promise((r) => setTimeout(r, 100));
    clearInterval(timer);

    expect(maxConcurrent).toBe(1); // never more than one tick in flight at once
    expect(listCalls).toBeGreaterThan(1); // the guard let later ticks through once the first settled

    rmSync(dir, { recursive: true, force: true });
  });
});

// FACTORY-87 (FACTORY-76, rule-side companion to DROVR-42): the pane-
// eligibility decision itself, extracted out of src/daemon/index.ts
// (lizardModeLabel/ruleLizardModeOf there are now thin bindings of these two
// functions to the daemon's own live state) per PR #478 review — that module
// has no exports and cannot be imported by a test without running the whole
// daemon's startup side effects, so this is the only place the decision can
// be exercised directly.
describe("ruleLizardModeOf / lizardModeLabelFor (FACTORY-87)", () => {
  const rule = (over: Partial<Rule> & Pick<Rule, "id" | "resourceProvider">): Rule =>
    ({ enabled: true, query: "q", brief: "b", execution: "swarm", account: "none", role: "worker", ...over });

  const noManagedSession = () => false;
  const emptyMap = new Map<string, boolean>();

  const cases: { label: string; resourceProvider: Rule["resourceProvider"]; resourceId: string }[] = [
    { label: "jira-work", resourceProvider: "jira-work", resourceId: "BUTCHR-7" },
    { label: "jira-project", resourceProvider: "jira-project", resourceId: "BUTCHR" },
    { label: "github-issue", resourceProvider: "github-issue", resourceId: "acme/w#1" },
    { label: "github-pr", resourceProvider: "github-pr", resourceId: "acme/w#1" },
    { label: "filesystem", resourceProvider: "filesystem", resourceId: "/repo/a.md" },
  ];

  for (const { label, resourceProvider, resourceId } of cases) {
    test(`positive (${label}): lizardMode: true on the owning rule makes the agent eligible, labelled by its resource id's basename`, () => {
      const id = encodeAgentKey({ resourceProvider, ruleId: "lz", resourceId });
      const deps: RuleLizardModeDeps = {
        rules: [rule({ id: "lz", resourceProvider, lizardMode: true })],
        isManagedSessionAgent: noManagedSession,
        managedSessionLizardModes: emptyMap,
      };
      expect(ruleLizardModeOf(id, deps)).toBe(true);
      expect(lizardModeLabelFor(id, deps)).toBe(resourceId.split("/").pop());
    });

    test(`positive (${label}): FACTORY-138 — lizardMode absent on the owning rule (found, field unset) is now ELIGIBLE by default, labelled by its resource id's basename`, () => {
      const id = encodeAgentKey({ resourceProvider, ruleId: "lz", resourceId });
      const deps: RuleLizardModeDeps = {
        rules: [rule({ id: "lz", resourceProvider })],
        isManagedSessionAgent: noManagedSession,
        managedSessionLizardModes: emptyMap,
      };
      expect(ruleLizardModeOf(id, deps)).toBe(true);
      expect(lizardModeLabelFor(id, deps)).toBe(resourceId.split("/").pop());
    });
  }

  test("negative: FACTORY-138 — an EXPLICIT lizardMode: false on the owning rule opts out, no longer the same as absent (absent is now eligible)", () => {
    const id = encodeAgentKey({ resourceProvider: "jira-work", ruleId: "lz", resourceId: "BUTCHR-7" });
    const deps: RuleLizardModeDeps = {
      rules: [rule({ id: "lz", resourceProvider: "jira-work", lizardMode: false })],
      isManagedSessionAgent: noManagedSession,
      managedSessionLizardModes: emptyMap,
    };
    expect(ruleLizardModeOf(id, deps)).toBe(false);
  });

  test("negative: an unknown rule id (no rule in the list matches) is never eligible, even with other lizard-mode rules present", () => {
    const id = encodeAgentKey({ resourceProvider: "jira-work", ruleId: "gone", resourceId: "BUTCHR-7" });
    const deps: RuleLizardModeDeps = {
      rules: [rule({ id: "lz", resourceProvider: "jira-work", lizardMode: true }), rule({ id: "lz2", resourceProvider: "jira-work", lizardMode: true })],
      isManagedSessionAgent: noManagedSession,
      managedSessionLizardModes: emptyMap,
    };
    expect(ruleLizardModeOf(id, deps)).toBe(false);
  });

  test("negative: a resourceProvider mismatch (same rule id, different provider) is never eligible", () => {
    // A github-issue agent under rule id "lz" — the only "lz" rule on file is a jira-work rule with lizardMode: true.
    const id = encodeAgentKey({ resourceProvider: "github-issue", ruleId: "lz", resourceId: "acme/w#1" });
    const deps: RuleLizardModeDeps = {
      rules: [rule({ id: "lz", resourceProvider: "jira-work", lizardMode: true })],
      isManagedSessionAgent: noManagedSession,
      managedSessionLizardModes: emptyMap,
    };
    expect(ruleLizardModeOf(id, deps)).toBe(false);
  });

  test("negative: a legacy bare-issue id (no rule-engine key shape at all) is never eligible", () => {
    const deps: RuleLizardModeDeps = {
      rules: [rule({ id: "lz", resourceProvider: "jira-work", lizardMode: true })],
      isManagedSessionAgent: noManagedSession,
      managedSessionLizardModes: emptyMap,
    };
    expect(ruleLizardModeOf("BUTCHR-7", deps)).toBe(false);
    expect(lizardModeLabelFor("BUTCHR-7", deps)).toBeUndefined();
  });

  test("negative: undecodable/garbage input is never eligible, and a null id resolves undefined without throwing", () => {
    const deps: RuleLizardModeDeps = { rules: [], isManagedSessionAgent: noManagedSession, managedSessionLizardModes: emptyMap };
    expect(ruleLizardModeOf("not:even:close:to:valid", deps)).toBe(false);
    expect(ruleLizardModeOf("", deps)).toBe(false);
    expect(lizardModeLabelFor(null, deps)).toBeUndefined();
  });

  describe("the managed-session branch", () => {
    const id = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "managed-sessions", resourceId: "/sessions/def.json" });

    test("resolves from the live map, true only when the map says true — never from `rules`", () => {
      const deps: RuleLizardModeDeps = {
        // Even though a matching Rule with lizardMode: true is on file, the managed-session branch must never consult it.
        rules: [rule({ id: "managed-sessions", resourceProvider: "filesystem", lizardMode: true })],
        isManagedSessionAgent: () => true,
        managedSessionLizardModes: new Map([[id, true]]),
      };
      expect(ruleLizardModeOf(id, deps)).toBe(true);
      expect(lizardModeLabelFor(id, deps)).toBe("def.json");
    });

    test("the map saying false wins over a matching Rule saying true", () => {
      const deps: RuleLizardModeDeps = {
        rules: [rule({ id: "managed-sessions", resourceProvider: "filesystem", lizardMode: true })],
        isManagedSessionAgent: () => true,
        managedSessionLizardModes: new Map([[id, false]]),
      };
      expect(ruleLizardModeOf(id, deps)).toBe(false);
    });

    test("an id absent from the map (not yet observed this daemon's lifetime) is never eligible", () => {
      const deps: RuleLizardModeDeps = {
        rules: [rule({ id: "managed-sessions", resourceProvider: "filesystem", lizardMode: true })],
        isManagedSessionAgent: () => true,
        managedSessionLizardModes: new Map(),
      };
      expect(ruleLizardModeOf(id, deps)).toBe(false);
    });
  });
});
