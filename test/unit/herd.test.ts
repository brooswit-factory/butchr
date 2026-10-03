import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HerdrError, processProviderAvailability } from "@brooswit/drovr";
import { HerdrHerd, agentNameFor, resumableArgvReason, staleArgvOutcome, isHerdrRestoredPane, restoredResumeEnabledFor, PANE_READY_WAIT_MS, PANE_READINESS_TIMEOUT_MS, SPAWN_TAG, RESUME_TAG } from "../../src/agents/herd.js";
import type { Herd } from "../../src/agents/herd.js";
import { reconcileNow, RespawnGuard } from "../../src/daemon/loop.js";
import { buildWorkspace, ensureWorkspaceDir, workspaceDirFor, workspaceRoot, workspaceSessionId, workspaceModel, workspaceEffort, persistDiscoveredSessionId } from "../../src/agents/workspace.js";
import { spawnArgs, DEFAULT_PERMISSION_MODE } from "../../src/agents/argv.js";
import { encodeAgentKey, encodeQueryAgentKey } from "../../src/rules/agent-key.js";
import { specForSessionDefinition, builtinManagedSessionsRule } from "../../src/rules/session-definition-type.js";
import { effectiveAgent } from "../../src/resources/session-definition.js";
import { createAdmissionController, ADMISSION2_TAG } from "../../src/agents/admission.js";
import { rcUsernameFor } from "../../src/accounts/identity.js";
import { absPath } from "../helpers/abs-path";

const clearQuota = () => {
  processProviderAvailability.clear({ provider: "claude", accountId: "default" });
  processProviderAvailability.clear({ provider: "codex", accountId: "default" });
};
beforeEach(clearQuota);
afterEach(clearQuota);

/** One foreground process, as herdr's `pane.process_info` reports it. */
interface FakeProcess { pid: number; argv?: string[] | null; name?: string }

function fakeHerdr(agents: Array<{ name?: string; pane_id: string; cwd?: string | undefined; workspace_id?: string }>) {
  const started: any[] = []; const closed: string[] = []; const renamed: any[] = []; const metadata: any[] = []; const creates: any[] = [];
  let createdCwd: string | undefined; let createdWorkspaceId = "w9";
  const client = {
    agent: { list: async () => ({ agents: agents.map((a) => {
      // Names are key hashes, so started agents carry their workspace's cwd; fixtures seeded by name still map `butchr-kan-1` to KAN-1.
      const cwd = a.cwd ?? (a.name?.startsWith("butchr-") ? join(workspaceRoot(), a.name.slice("butchr-".length).toUpperCase()) : undefined);
      const workspace_id = a.workspace_id ?? "w9";
      return cwd ? { ...a, agent: "claude", cwd, workspace_id } : { ...a, workspace_id };
    }) }), start: async (p: any) => { started.push(p); agents.push({ name: p.name, pane_id: p.pane_id, cwd: createdCwd, workspace_id: createdWorkspaceId }); } },
    pane: { close: async (id: string) => { closed.push(id); }, read: async () => ({ read: { text: "" } }) },
    workspace: {
      // `label` is passed to `workspace.create` by drovr's own `ManagedHerdrLifecycle.start()`
      // (never to `agent.start`) — see this fake's own `creates` tracking array below.
      create: async (p: any) => { createdCwd = p.cwd; creates.push(p); return { root_pane: { pane_id: `${createdWorkspaceId}:p1` } }; },
      rename: async (p: any) => { renamed.push(p); return {}; },
      reportMetadata: async (p: any) => { metadata.push(p); return {}; },
    },
  };
  return { client: client as any, started, closed, renamed, metadata, creates };
}

describe("agent name convention", () => {
  const HERDR_NAME = /^butchr-[0-9a-f]{24}$/;
  const valid = (key: string) => {
    const name = agentNameFor(key);
    expect(name).toMatch(HERDR_NAME);
    expect(name.length).toBe(31);
    expect(name.length).toBeLessThanOrEqual(32);
    return name;
  };

  test("one key always gets the same fixed-length name", () => {
    const key = encodeAgentKey({ resourceProvider: "jira-work", ruleId: "live-jira-work", resourceId: "BUTCHR-364" });
    expect(valid(key)).toBe(agentNameFor(key));
    expect(agentNameFor(key)).toBe(`butchr-${createHash("sha256").update(key).digest("hex").slice(0, 24)}`);
  });

  test("different resources, rules and providers get different names", () => {
    const names = [
      encodeAgentKey({ resourceProvider: "jira-work", ruleId: "triage", resourceId: "BUTCHR-364" }),
      encodeAgentKey({ resourceProvider: "jira-work", ruleId: "triage", resourceId: "BUTCHR-365" }),
      encodeAgentKey({ resourceProvider: "jira-work", ruleId: "triage-2", resourceId: "BUTCHR-364" }),
      encodeAgentKey({ resourceProvider: "jira-idea", ruleId: "triage", resourceId: "BUTCHR-364" }),
      encodeAgentKey({ resourceProvider: "jira-work", ruleId: "x-my", resourceId: "PROJ-1" }),
      encodeAgentKey({ resourceProvider: "jira-work", ruleId: "x", resourceId: "MY_PROJ-1" }),
      encodeAgentKey({ resourceProvider: "github-issue", ruleId: "r", resourceId: "a-b/c#1" }),
      encodeAgentKey({ resourceProvider: "github-issue", ruleId: "r", resourceId: "a/b-c#1" }),
      encodeAgentKey({ resourceProvider: "zendesk-ticket", ruleId: "r", resourceId: "acme#123" }),
    ].map(valid);
    expect(new Set(names).size).toBe(names.length);
  });

  test("uppercase keys become lowercase names that still distinguish case", () => {
    expect(valid("jira-work:TRIAGE:BUTCHR-364")).not.toBe(valid("jira-work:triage:butchr-364"));
    expect(valid("KAN-1")).not.toBe(valid("kan-1"));
  });

  test("very long and unusual keys stay within Herdr's limit and distinct", () => {
    const long = (n: number) => `github-issue:${"a".repeat(200)}:owner%2F${"R".repeat(500)}%23${n}`;
    expect(valid(long(1))).not.toBe(valid(long(2)));
    for (const key of ["", ":", "Ünïcødé:ключ:🦀", "x".repeat(10_000), " \t\n:/#%"]) valid(key);
  });
});

const instant = () => Promise.resolve();

describe("HerdrHerd", () => {
  test("AGY creates its pane with the prepared isolated HOME", async () => {
    const f = fakeHerdr([]);
    const creates: any[] = [];
    f.client.workspace.create = async (p: any) => { creates.push(p); return { root_pane: "w9:p1" }; };
    const herd = new HerdrHerd(f.client, "http://localhost:7717/mcp", instant, undefined,
      { provider: "agy" }, undefined, async () => ({ HOME: "/tmp/isolated-agy-home" }));
    await herd.spawn({ key: "KAN-7", issuetype: "Task", summary: "s", parent: null });
    expect(creates[0].env).toEqual({ HOME: "/tmp/isolated-agy-home" });
    expect(f.started[0].kind).toBe("agy");
  });
  test("a rule agent key with an uppercase Jira key starts under a Herdr-valid name", async () => {
    const f = fakeHerdr([]);
    const key = encodeAgentKey({ resourceProvider: "jira-work", ruleId: "triage", resourceId: "BUTCHR-364" });
    const herd = new HerdrHerd(f.client, "http://localhost:7717/mcp", instant);
    await herd.spawn({ key, issuetype: "Task", summary: "s", parent: null });
    expect(f.started[0].name).toBe(agentNameFor(key));
    expect(f.started[0].name).toMatch(/^butchr-[0-9a-f]{24}$/);
    expect(workspaceDirFor(key)).toBe(join(workspaceRoot(), "jira-work", "triage", "BUTCHR-364")); // workspace identity keeps the exact key
  });
  // BUTCHR-413 (CHANGES_REQUESTED review finding 1): `spawn()` itself injects
  // this issue's own `accountNameOf()` value as `spec.rocketchatAccount` — the
  // caller never sets it directly (mirrors how `mcpBindingsOf` is looked up
  // fresh rather than cached) — and a binding's `accountHeader` turns that
  // into a real header in Codex's own launch argv, unlike `headersEnvVar`
  // (see argv.test.ts's "a bound server's headersEnvVar is NEVER resolved
  // for Codex" for that half, unweakened by this).
  test("spawn injects accountNameOf()'s value into rocketchatAccount, and a bound accountHeader reaches Codex argv", async () => {
    const f = fakeHerdr([]);
    const binding = { name: "rocketr", type: "http" as const, url: "https://rocketr.example/mcp", channel: false, accountHeader: "x-rocketr-account" };
    const herd = new HerdrHerd(f.client, "http://localhost:7717/mcp", instant, undefined, { provider: "codex" }, undefined, undefined, undefined, () => [binding], () => "butchr_acct_1");
    await herd.spawn({ key: "KAN-7", issuetype: "Task", summary: "s", parent: null, mcpServers: [binding] });
    const rocketrArg = f.started[0].args.find((a: string) => a.includes("mcp_servers.rocketr="));
    expect(rocketrArg).toBeDefined();
    expect(rocketrArg).toContain("x-rocketr-account");
    expect(rocketrArg).toContain("butchr_acct_1");
  });

  test("spawn with no accountNameOf configured: byte-identical to before this field existed, even with an accountHeader binding", async () => {
    const f = fakeHerdr([]);
    const binding = { name: "rocketr", type: "http" as const, url: "https://rocketr.example/mcp", channel: false, accountHeader: "x-rocketr-account" };
    const herd = new HerdrHerd(f.client, "http://localhost:7717/mcp", instant, undefined, { provider: "codex" });
    await herd.spawn({ key: "KAN-7", issuetype: "Task", summary: "s", parent: null, mcpServers: [binding] });
    const rocketrArg = f.started[0].args.find((a: string) => a.includes("mcp_servers.rocketr="));
    expect(rocketrArg).toBeDefined();
    expect(rocketrArg).not.toContain("http_headers");
  });

  // BUTCHR-412's own account-lifecycle.ts `ensure()` sets `rocketchatAccount`
  // on the spec BEFORE `herd.spawn` is ever called, from the REAL
  // ensureAccount outcome for this launch — a value `spawn()` must never
  // clobber with its own independent `accountNameOf()` recomputation (both
  // derive the identical value in the ordinary case, but only `ensure()`'s
  // is the one that actually reflects THIS launch's real provisioning
  // outcome). `accountNameOf` is a fallback for a launch that never went
  // through `ensure` at all, not a second source of truth.
  test("spawn NEVER overwrites an already-set spec.rocketchatAccount (BUTCHR-412's account-lifecycle.ts sets it first) with its own accountNameOf() value", async () => {
    const f = fakeHerdr([]);
    const binding = { name: "rocketr", type: "http" as const, url: "https://rocketr.example/mcp", channel: false, accountHeader: "x-rocketr-account" };
    const herd = new HerdrHerd(f.client, "http://localhost:7717/mcp", instant, undefined, { provider: "codex" }, undefined, undefined, undefined, () => [binding], () => "computed-by-accountNameOf");
    await herd.spawn({ key: "KAN-7", issuetype: "Task", summary: "s", parent: null, mcpServers: [binding], rocketchatAccount: "set-by-ensure-already" });
    const rocketrArg = f.started[0].args.find((a: string) => a.includes("mcp_servers.rocketr="));
    expect(rocketrArg).toContain("set-by-ensure-already");
    expect(rocketrArg).not.toContain("computed-by-accountNameOf");
  });

  test("runningIssues lists only butchr-managed agents, mapped to their issue", async () => {
    const { client } = fakeHerdr([{ name: "butchr-kan-1", pane_id: "w1:p1" }, { name: "someone-else", pane_id: "w1:p2" }, { pane_id: "w1:p3" }]);
    const herd = new HerdrHerd(client, "http://localhost:7717/mcp");
    expect(await herd.runningIssues()).toEqual(["KAN-1"]);
  });
  test("runningIssues derives ownership from cwd when Herdr has cleared the name", async () => {
    const client = { agent: { list: async () => ({ agents: [{ name: null, pane_id: "w1:p1", cwd: join(workspaceRoot(), "KAN-2") }] }) } };
    const herd = new HerdrHerd(client as any, "http://localhost:7717/mcp");
    expect(await herd.runningIssues()).toEqual(["KAN-2"]);
  });
  test("managedAgents exposes path-derived dashboard identity when Herdr has cleared the name", async () => {
    const client = { agent: { list: async () => ({ agents: [{ name: null, agent_status: "working", pane_id: "w1:p2", cwd: join(workspaceRoot(), "KAN-2") }] }) } };
    const herd = new HerdrHerd(client as any, "http://localhost:7717/mcp");
    expect(await herd.managedAgents()).toEqual([{
      issue: "KAN-2",
      pane: "w1:p2",
      cwd: join(workspaceRoot(), "KAN-2"),
      status: "working",
    }]);
  });
  test("spawn starts a claude agent with the channel flag + per-issue mcp config + kickoff prompt; is idempotent", async () => {
    const f = fakeHerdr([]);
    const herd = new HerdrHerd(f.client, "http://localhost:7717/mcp", instant);
    await herd.spawn({ key: "KAN-7", issuetype: "Task", summary: "s", parent: "KAN-1" });
    expect(f.started.length).toBe(1);
    expect(f.started[0].name).toBe(agentNameFor("KAN-7"));
    expect(f.started[0].pane_id).toBe("w9:p1");   // started in the new workspace's root pane
    expect(f.started[0].kind).toBe("claude");
    expect(f.started[0].args).toContain("--permission-mode");
    expect(f.started[0].args).toContain("acceptEdits"); // FACTORY-138: no explicit permissionMode on the spec -> butchr's own default.
    expect(f.started[0].args).toContain("--dangerously-load-development-channels=server:butchr");
    // the kickoff prompt is the FIRST argument: the variadic mcp flag would
    // swallow a trailing positional as one of its own entries
    expect(f.started[0].args[0]).toBe("follow your CLAUDE.md");
    expect(f.started[0].args[f.started[0].args.length - 1]).toBe("--dangerously-load-development-channels=server:butchr");
    const cfgPath = f.started[0].args[f.started[0].args.indexOf("--mcp-config") + 1];
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
    expect(cfg.mcpServers.butchr.url).toBe("http://localhost:7717/mcp");
    expect(cfg.mcpServers.butchr.headers["x-issue"]).toBe("KAN-7");
    // idempotent: already-running issue is not started again
    const f2 = fakeHerdr([{ name: "butchr-kan-7", pane_id: "w1:p1" }]);
    await new HerdrHerd(f2.client, "u", instant).spawn({ key: "KAN-7", issuetype: "Task", summary: "s", parent: null });
    expect(f2.started.length).toBe(0);
  });

  test("PR #394 review fix (round 3): a managed-session spec (cwd set) spawns cleanly end-to-end through the REAL spawn path (HerdrHerd + Drovr's ManagedHerdrLifecycle, not a stub) — kickoff names both the working directory AND the brief, and the launched process itself stays at the ordinary bookkeeping workspace", async () => {
    // Round 2 shipped a version where agentLaunchConfig's own `cwd` was `spec.cwd` directly. That
    // broke Drovr's ManagedHerdrLifecycle invariant (its `cwd` is FIXED to workspaceDirFor(issue) —
    // see herd.ts's own `lifecycle()` — and it throws "Launch does not match selected provider and
    // workspace" the moment the prepared launch's cwd differs) — caught here, through the real spawn
    // path, not by the narrower buildWorkspace/agentLaunchConfig-only tests the PR review itself ran.
    const f = fakeHerdr([]);
    const herd = new HerdrHerd(f.client, "http://localhost:7717/mcp", instant);
    const key = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "managed-sessions", resourceId: absPath("defs", "a.json") });
    await herd.spawn({
      key, issuetype: "managed-session", summary: "s", parent: null,
      brief: "Keep this repo's docs and dependency versions current.",
      cwd: absPath("repo", "some-project"),
      agents: [{ harness: "claude", model: "sonnet" }],
    });
    expect(f.started.length).toBe(1); // did NOT throw — this is the regression this test exists to catch
    expect(f.started[0].args[0]).toContain(absPath("repo", "some-project"));
    expect(f.started[0].args[0]).toContain("Keep this repo's docs and dependency versions current.");
    expect(f.started[0].args[0]).not.toContain("CLAUDE.md");
  });
  test("paneFor resolves the current pane, or null when not running", async () => {
    const f = fakeHerdr([{ name: "butchr-kan-5", pane_id: "w1:p5" }]);
    const herd = new HerdrHerd(f.client, "u");
    expect(await herd.paneFor("KAN-5")).toBe("w1:p5");
    expect(await herd.paneFor("KAN-404")).toBeNull();
  });
  test("stop closes the issue's pane; a no-op when nothing is running for it", async () => {
    const f = fakeHerdr([{ name: "butchr-kan-9", pane_id: "w1:p9" }]);
    const herd = new HerdrHerd(f.client, "u");
    await herd.stop("KAN-9");
    expect(f.closed).toEqual(["w1:p9"]);
    await herd.stop("KAN-404");   // not running
    expect(f.closed).toEqual(["w1:p9"]);
  });
});

describe("spawn: kickoff verification (KAN-804/807)", () => {
  // After agent.start, the fake herdr's agent.list() must report the new
  // agent so statusOf()/byIssue() can see it — real herdr does this
  // immediately once the pane exists, unlike the plain fakeHerdr() above
  // (whose `agents` array is fixed at construction, before start() runs).
  function fakeHerdrWithLiveAgent(opts: { statusAfterStart: string; paneText?: string; fail?: boolean }) {
    const started: any[] = []; const closed: string[] = []; const prompts: any[] = []; const keys: any[] = [];
    let agents: Array<{ name?: string; pane_id: string; agent_status?: string; agent?: string; cwd?: string }> = [];
    const client = {
      agent: {
        list: async () => ({ agents }),
        start: async (p: any) => { started.push(p); agents = [{ name: p.name, pane_id: p.pane_id, agent_status: opts.statusAfterStart, agent: p.kind, cwd: join(workspaceRoot(), "KAN-7") }]; },
        prompt: async (p: any) => { if (opts.fail) throw new Error("blocked"); prompts.push(p); return { agent: agents[0] }; },
      },
      pane: {
        close: async (id: string) => { closed.push(id); },
        read: async () => ({ read: { text: opts.paneText ?? "" } }),
        sendKeys: async (k: any) => { keys.push(k); },
      },
      workspace: { create: async () => ({ root_pane: { pane_id: "w9:p1" } }) },
    };
    return { client: client as any, started, closed, prompts, keys };
  }

  test("a turn started (agent went working) → no recovery action", async () => {
    const f = fakeHerdrWithLiveAgent({ statusAfterStart: "working" });
    const herd = new HerdrHerd(f.client, "u", instant);
    await herd.spawn({ key: "KAN-7", issuetype: "Task", summary: "s", parent: null });
    expect(f.prompts.length).toBe(0);
    expect(f.closed.length).toBe(0);
  });

  test("idle alone does not prove kickoff was swallowed and never repeats work", async () => {
    const f = fakeHerdrWithLiveAgent({ statusAfterStart: "idle", paneText: "some ordinary idle pane, no refusal here" });
    const herd = new HerdrHerd(f.client, "u", instant);
    await herd.spawn({ key: "KAN-7", issuetype: "Task", summary: "s", parent: null });
    expect(f.prompts).toEqual([]);
    expect(f.keys).toEqual([]);
  });

  test("kickoff swallowed by a session-limit refusal → NOT re-sent (a limited session can't be nudged back to life)", async () => {
    const f = fakeHerdrWithLiveAgent({ statusAfterStart: "idle", paneText: "You've hit your session limit · resets 9:50pm" });
    const herd = new HerdrHerd(f.client, "u", instant);
    await herd.spawn({ key: "KAN-7", issuetype: "Task", summary: "s", parent: null });
    expect(f.prompts.length).toBe(0);
    expect(f.closed.length).toBe(0); // spawn() itself never closes — that's session-limit-watch.ts's job
  });

  test("done (sitting at its prompt) is treated the same as idle for verification", async () => {
    const f = fakeHerdrWithLiveAgent({ statusAfterStart: "done", paneText: "no refusal" });
    const herd = new HerdrHerd(f.client, "u", instant);
    await herd.spawn({ key: "KAN-7", issuetype: "Task", summary: "s", parent: null });
    expect(f.prompts.length).toBe(0);
  });
});

describe("spawn failure", () => {
  test("closes the just-created workspace pane when agent.start fails", async () => {
    const closed: string[] = [];
    const f = {
      started: [] as any[],
      agent: { list: async () => ({ agents: [] }), start: async () => { throw new Error("boom"); } },
      workspace: { create: async () => ({ root_pane: "wX:p1" }) },
      pane: { close: async (p: string) => { closed.push(p); } },
    };
    const herd = new HerdrHerd(f as any, "http://x/mcp");
    await expect(herd.spawn({ key: "KAN-9", issuetype: "Task", summary: "s", parent: null })).rejects.toThrow("boom");
    expect(closed).toEqual(["wX:p1"]);
  });
});

// BUTCHR-320 (A): one SPAWN_TAG outcome line per spawn attempt — success,
// failure, or the no-op early return — all from this one place. Falsifier 1
// (mutation test): deleting any one of the three `this.log?.(...)` calls in
// `HerdrHerd.spawn()` must fail exactly the corresponding test below BY NAME
// — verified by hand while writing this ticket's PR (see its own body for
// which test failed for which deleted line), not merely asserted here.
describe("spawn: outcome logging under SPAWN_TAG (BUTCHR-320)", () => {
  test("success line names the issue and the pane it started on, written only after verifyKickoff — not right after agent.start", async () => {
    const lines: string[] = [];
    const f = fakeHerdr([]);
    const herd = new HerdrHerd(f.client, "http://localhost:7717/mcp", instant, (l) => lines.push(l));
    await herd.spawn({ key: "KAN-7", issuetype: "Task", summary: "s", parent: null });
    // FACTORY-314 (PR #513 review fix): this fake never creates a real
    // Claude transcript, so the post-spawn session-id discovery this ticket
    // added correctly finds nothing and logs its own WARNING — a real,
    // separate line from the SPAWN_TAG success line this test's own name is
    // about, which still lands unchanged right after it.
    expect(lines).toEqual([
      "WARNING: [spawn] KAN-7 could not discover a native Claude session id after a successful launch — a later model/effort change will fall back to a fresh restart instead of resuming",
      `${SPAWN_TAG} KAN-7 succeeded — pane w9:p1 origin=spawn`,
    ]);
  });

  test("failure line names the issue and the rejection's own message, from the SAME tag as success", async () => {
    const lines: string[] = [];
    const f = {
      agent: { list: async () => ({ agents: [] }), start: async () => { throw new Error("boom"); } },
      workspace: { create: async () => ({ root_pane: "wX:p1" }) },
      pane: { close: async () => {} },
    };
    const herd = new HerdrHerd(f as any, "http://x/mcp", instant, (l) => lines.push(l));
    await expect(herd.spawn({ key: "KAN-9", issuetype: "Task", summary: "s", parent: null })).rejects.toThrow("boom");
    expect(lines).toEqual([`${SPAWN_TAG} KAN-9 failed origin=spawn — boom`]);
  });

  // A failure is logged whatever the complaint/latch state (hard constraint
  // on the ticket) — this method never consults reconcile-failure.ts's
  // ReconcileFailureTracker.isSpoken latch at all, so there is nothing here
  // that COULD gate this line on it; this test pins that by simply repeating
  // the same failure twice and expecting two identical lines, exactly what a
  // latched complaint tracker would NOT produce for its own comment.
  test("a failure is logged every time it recurs — never latched, unlike the reconcile-failure complaint", async () => {
    const lines: string[] = [];
    const f = {
      agent: { list: async () => ({ agents: [] }), start: async () => { throw new Error("boom"); } },
      workspace: { create: async () => ({ root_pane: "wX:p1" }) },
      pane: { close: async () => {} },
    };
    const herd = new HerdrHerd(f as any, "http://x/mcp", instant, (l) => lines.push(l));
    await expect(herd.spawn({ key: "KAN-9", issuetype: "Task", summary: "s", parent: null })).rejects.toThrow("boom");
    await expect(herd.spawn({ key: "KAN-9", issuetype: "Task", summary: "s", parent: null })).rejects.toThrow("boom");
    expect(lines.filter((l) => l === `${SPAWN_TAG} KAN-9 failed origin=spawn — boom`).length).toBe(2);
  });

  // THE TRAP: an issue that already has a live agent attempts nothing — not
  // a success, not a failure. It gets its own third outcome under the same
  // tag rather than silence, so (A)'s total can still be reconciled against
  // (B)'s admitted count (see admission.test.ts's cross-instrument check).
  test("the no-op early return (already running) logs a THIRD outcome, never 'succeeded'", async () => {
    const lines: string[] = [];
    const f2 = fakeHerdr([{ name: "butchr-kan-7", pane_id: "w1:p1" }]);
    const herd = new HerdrHerd(f2.client, "u", instant, (l) => lines.push(l));
    await herd.spawn({ key: "KAN-7", issuetype: "Task", summary: "s", parent: null });
    expect(lines).toEqual([`${SPAWN_TAG} KAN-7 noop — already has a live agent origin=spawn`]);
  });

  test("omitting the log dependency entirely is a no-op — every existing caller/test before this ticket is unaffected", async () => {
    const f = fakeHerdr([]);
    const herd = new HerdrHerd(f.client, "http://localhost:7717/mcp", instant); // no 4th arg
    await expect(herd.spawn({ key: "KAN-7", issuetype: "Task", summary: "s", parent: null })).resolves.toBeUndefined();
  });

  // BUTCHR-320 review fix (round 1): the no-op check's OWN `byIssue()` read
  // (`agent.list()`) used to sit OUTSIDE the try — a rejecting `agent.list()`
  // rejected `spawn()` having logged nothing at all, a silent failure
  // surviving inside the fix for silent failures. Pinned here: a rejecting
  // `agent.list()` must still produce exactly one `failed` line.
  test("a rejecting agent.list() (the no-op check's own read) still logs a failed line — never silent", async () => {
    const lines: string[] = [];
    const client = {
      agent: { list: async () => { throw new Error("herdr socket closed"); }, start: async () => {} },
      pane: { close: async () => {} },
      workspace: { create: async () => ({ root_pane: "w1:p1" }) },
    };
    const herd = new HerdrHerd(client as any, "http://x/mcp", instant, (l) => lines.push(l));
    await expect(herd.spawn({ key: "KAN-42", issuetype: "Task", summary: "s", parent: null })).rejects.toThrow("herdr socket closed");
    expect(lines).toEqual([`${SPAWN_TAG} KAN-42 failed origin=spawn — herdr socket closed`]);
  });

  // BUTCHR-334 review fix (round 1): `origin=` must sit BEFORE the free-text
  // error message, never after — the message is server-supplied
  // (HerdrError's own message comes off the wire) and nothing excludes a
  // newline in it. Placed after, a multi-line message would push `origin=`
  // onto a SECOND journal line, undercounting `respawn attempts = count of
  // [spawn] lines with origin=respawn`. Pinned directly against the
  // reviewer's own repro shape: a multi-line rejection message must still
  // leave the tag AND `origin=` on the line's own first line.
  test("a multi-line rejection message never separates origin= from the tag onto a later line (review fix, round 1)", async () => {
    const lines: string[] = [];
    const client = {
      agent: { list: async () => ({ agents: [] }), start: async () => { throw new Error("connect ECONNREFUSED\n    at Socket.<anonymous>"); } },
      workspace: { create: async () => ({ root_pane: "wX:p1" }) },
      pane: { close: async () => {} },
    };
    const herd = new HerdrHerd(client as any, "http://x/mcp", instant, (l) => lines.push(l));
    await expect(herd.spawn({ key: "KAN-9", issuetype: "Task", summary: "s", parent: null }, "respawn")).rejects.toThrow();
    const firstLine = lines[0]!.split("\n")[0]!;
    expect(firstLine).toBe(`${SPAWN_TAG} KAN-9 failed origin=respawn — connect ECONNREFUSED`);
    expect(firstLine.startsWith(SPAWN_TAG)).toBe(true);
    expect(firstLine.includes("origin=respawn")).toBe(true);
  });
});

// BUTCHR-320 falsifier 2 — CROSS-INSTRUMENT CONSISTENCY: for the same poll,
// the number of attempts derivable from (A)'s SPAWN_TAG must equal the
// admitted count from (B)'s ADMISSION2_TAG line — independent emissions of
// the same fact, run here through the REAL reconcileNow + a REAL
// createAdmissionController + a REAL HerdrHerd (never the plain `Herd` test
// fakes elsewhere in this codebase, which never emit either line at all).
describe("BUTCHR-320 falsifier 2: (A) attempts == (B) admitted, for the same poll", () => {
  const spec = (k: string) => ({ key: k, issuetype: "Task", summary: "s", parent: null });

  test("ordinary case (no race): one success + one failure — attempts(2) == admitted(2)", async () => {
    const spawnLines: string[] = [];
    const admissionLines: string[] = [];
    const client = {
      agent: {
        list: async () => ({ agents: [] }), // never running — no residency race in this test
        start: async (p: any) => { if (p.name === agentNameFor("KAN-3")) throw new Error("boom"); },
      },
      pane: { close: async () => {}, read: async () => ({ read: { text: "" } }) },
      workspace: { create: async (p: any) => ({ root_pane: { pane_id: `pane-${p.label}` } }) },
    };
    const herd = new HerdrHerd(client as any, "http://x/mcp", instant, (l) => spawnLines.push(l));
    const admission = createAdmissionController({ cap: 10, residency: () => herd.runningIssues(), log: (l) => admissionLines.push(l) });
    const desired = new Map([["KAN-2", spec("KAN-2")], ["KAN-3", spec("KAN-3")]]);
    await reconcileNow(herd, desired, { admission: admission.admit, onAdmitted: admission.recordSpawned });

    expect(spawnLines.filter((l) => l.startsWith(SPAWN_TAG)).length).toBe(2); // 1 success + 1 failure, 0 noop
    const admissionLine = admissionLines.find((l) => l.startsWith(ADMISSION2_TAG))!;
    expect(admissionLine).toContain("admitted=2");
  });

  // THE TRAP, exercised end to end: `reconcileNow`'s own `running` snapshot
  // and `admission`'s own `residency()` read both see KAN-1 as NOT running
  // (agent.list() calls 1-2), but by the time `herd.spawn()` makes its own
  // fresh `byIssue()` read (agent.list() call 3), a concurrent respawn
  // elsewhere has registered it — the exact TOCTOU gap `spawn()`'s own doc
  // comment names. (A)'s total must include the noop as an ATTEMPT for the
  // arithmetic to close: attempts(1 noop) == admitted(1).
  test("the no-op race: attempts(1 noop) == admitted(1) — the reconciliation rule for THE TRAP", async () => {
    const spawnLines: string[] = [];
    const admissionLines: string[] = [];
    let calls = 0;
    const client = {
      agent: {
        list: async () => {
          calls++;
          return calls <= 2 ? { agents: [] } : { agents: [{ name: "butchr-kan-1", pane_id: "raced-in-pane", cwd: join(workspaceRoot(), "KAN-1") }] };
        },
        start: async () => {},
      },
      pane: { close: async () => {}, read: async () => ({ read: { text: "" } }) },
      workspace: { create: async () => ({ root_pane: { pane_id: "w9:p1" } }) },
    };
    const herd = new HerdrHerd(client as any, "http://x/mcp", instant, (l) => spawnLines.push(l));
    const admission = createAdmissionController({ cap: 10, residency: () => herd.runningIssues(), log: (l) => admissionLines.push(l) });
    const desired = new Map([["KAN-1", spec("KAN-1")]]);
    await reconcileNow(herd, desired, { admission: admission.admit, onAdmitted: admission.recordSpawned });

    const attempts = spawnLines.filter((l) => l.startsWith(SPAWN_TAG));
    expect(attempts).toEqual([`${SPAWN_TAG} KAN-1 noop — already has a live agent origin=spawn`]);
    const admissionLine = admissionLines.find((l) => l.startsWith(ADMISSION2_TAG))!;
    expect(admissionLine).toContain("admitted=1");
    expect(attempts.length).toBe(1); // reconciliation rule: attempts (success+failure+noop) == admitted, here 1 == 1
  });
});

// BUTCHR-334 falsifier 3 — THE RESPAWN TERM: the bare "attempts == admitted"
// rule above is false on any poll containing a respawn, because respawns
// bypass admission entirely (ReconcileOptions.admission's own doc comment:
// "plan.stop`/`plan.respawn` are never touched"). This is the falsifier that
// was missing — it drives a poll with an admitted plan-spawn AND a respawn
// (one succeeding, one FAILING) through a REAL reconcileNow + REAL
// createAdmissionController + REAL HerdrHerd (spawn/stop delegate to it, so
// the actual `origin=` tagging in HerdrHerd.spawn() is what's under test,
// not a re-implementation of it), and shows the TRUE rule — attempts ==
// admitted + respawn attempts — closing arithmetically.
describe("BUTCHR-334 falsifier 3: (A) attempts == (B) admitted + respawn attempts, for a poll containing both", () => {
  const spec = (k: string) => ({ key: k, issuetype: "Task", summary: "s", parent: null });

  test("mixed poll: one admitted plan-spawn, one successful respawn, one FAILED respawn — the true rule closes, and the failed respawn is distinguishable from a failed plan spawn by origin alone", async () => {
    const spawnLines: string[] = [];
    const admissionLines: string[] = [];
    const live: any[] = [];
    const client = {
      agent: {
        // Always empty: every one of the three issues below misses HerdrHerd's
        // own noop check (byIssue().has(issue)), so all three genuinely
        // attempt agent.start — same shape falsifier 2's own tests rely on.
        list: async () => ({ agents: live }),
        start: async (p: any) => {
          if (p.name === agentNameFor("KAN-RESPAWN-FAIL")) throw new Error("boom");
          const issue = [...desired.keys()].find((k) => agentNameFor(k) === p.name)!;
          live.push({ pane_id: p.pane_id, agent: p.kind, cwd: join(workspaceRoot(), issue), agent_status: "working" });
        },
      },
      pane: { close: async () => {}, read: async () => ({ read: { text: "" } }) },
      workspace: { create: async (p: any) => ({ root_pane: { pane_id: `pane-${p.label}` } }) },
    };
    // The real spawn/outcome-logging logic under test — both the ordinary
    // spawn loop and the respawn loop below call THIS SAME instance, exactly
    // as production's one shared HerdrHerd does.
    const inner = new HerdrHerd(client as any, "http://x/mcp", instant, (l) => spawnLines.push(l));

    // A hand-built Herd whose runningIssues/staleIssues are fixed (so this
    // test controls exactly which issue falls into plan.spawn vs.
    // plan.respawn, without reimplementing HerdrHerd's own argv-staleness
    // detection), but whose spawn/stop delegate to the real `inner` above.
    const staleAgents = [
      { issue: "KAN-RESPAWN-OK", reason: "x", observedArgv: [] },
      { issue: "KAN-RESPAWN-FAIL", reason: "x", observedArgv: [] },
    ];
    const herd: Herd = {
      runningIssues: async () => ["KAN-RESPAWN-OK", "KAN-RESPAWN-FAIL"],
      staleIssues: async () => staleAgents,
      spawn: (sp, origin) => inner.spawn(sp, origin),
      stop: async () => {},
      paneFor: async () => null,
      nudge: async () => ({ delivered: false }),
      resumeInPlace: async () => "unresumable",
    };
    const admission = createAdmissionController({ cap: 10, residency: () => herd.runningIssues(), log: (l) => admissionLines.push(l) });
    const desired = new Map([
      ["KAN-NEW", spec("KAN-NEW")],
      ["KAN-RESPAWN-OK", spec("KAN-RESPAWN-OK")],
      ["KAN-RESPAWN-FAIL", spec("KAN-RESPAWN-FAIL")],
    ]);
    await reconcileNow(herd, desired, { admission: admission.admit, onAdmitted: admission.recordSpawned });

    const attempts = spawnLines.filter((l) => l.startsWith(SPAWN_TAG));
    expect(attempts.length).toBe(3); // KAN-NEW succeeded, KAN-RESPAWN-OK succeeded, KAN-RESPAWN-FAIL failed

    const admissionLine = admissionLines.find((l) => l.startsWith(ADMISSION2_TAG))!;
    expect(admissionLine).toContain("admitted=1"); // ONLY the ordinary plan-spawn candidate ever reached admission

    const planSpawnAttempts = attempts.filter((l) => l.includes("origin=spawn"));
    const respawnAttempts = attempts.filter((l) => l.includes("origin=respawn"));
    expect(planSpawnAttempts).toEqual([`${SPAWN_TAG} KAN-NEW succeeded — pane pane-KAN-NEW origin=spawn`]);
    expect(respawnAttempts.length).toBe(2); // BOTH the successful AND the failed respawn carry origin=respawn

    // THE TRUE RULE (SPAWN_TAG's own doc comment): attempts == admitted (1)
    // + respawn attempts this same poll (2). The BARE rule from BUTCHR-320
    // ("attempts == admitted") would wrongly demand 1 == 3 here and fail.
    expect(attempts.length).toBe(1 /* admitted */ + respawnAttempts.length);

    // The second gap named on the ticket: a failed respawn must be
    // distinguishable, BY TAG ALONE, from a failed plan spawn — it is, via
    // `origin=`, with no change to the `[reconcile] ... respawned:` line at
    // all (that line is written only on a SUCCESSFUL respawn and is not
    // involved here).
    const failedRespawn = respawnAttempts.find((l) => l.includes("KAN-RESPAWN-FAIL"));
    expect(failedRespawn).toBe(`${SPAWN_TAG} KAN-RESPAWN-FAIL failed origin=respawn — boom`);
    expect(respawnAttempts.some((l) => l.includes("KAN-RESPAWN-OK") && l.includes("succeeded"))).toBe(true);
  });
});

describe("spawn: pane readiness retry (BUTCHR-268)", () => {
  const busyError = () =>
    new HerdrError("agent_pane_busy", "agent target pane wX:p1 is not an available shell", "agent.start", {
      code: "agent_pane_busy",
      message: "agent target pane wX:p1 is not an available shell",
    });

  /** `agent.start` rejects with `agent_pane_busy` on the first `rejectCount` calls, then succeeds (or never, if `rejectCount` is unbounded). */
  function fakeHerdrBusyThenOk(rejectCount: number) {
    const started: any[] = [];
    const closed: string[] = [];
    let calls = 0;
    const client = {
      agent: {
        list: async () => ({ agents: [] }),
        start: async (p: any) => {
          calls++;
          if (calls <= rejectCount) throw busyError();
          started.push(p);
        },
      },
      pane: { close: async (id: string) => { closed.push(id); }, read: async () => ({ read: { text: "" } }) },
      workspace: { create: async () => ({ root_pane: { pane_id: "w9:p1" } }) },
    };
    return { client: client as any, started, closed, callCount: () => calls };
  }

  test("retries only busy rejections and launches once after slow shell initialization", async () => {
    const f = fakeHerdrBusyThenOk(7);
    const waits: number[] = [];
    let now = 0;
    const herd = new HerdrHerd(f.client, "u", async (ms) => { waits.push(ms); now += ms; }, undefined, undefined, undefined, undefined, () => now);
    await herd.spawn({ key: "KAN-7", issuetype: "Task", summary: "s", parent: null });
    expect(f.started.length).toBe(1);
    expect(f.closed.length).toBe(0); // it eventually started — the pane it created must not be closed
    expect(f.callCount()).toBe(8);
    expect(waits).toEqual([...Array(7).fill(PANE_READY_WAIT_MS), 12_000]);
  });

  test("deadline exhaustion closes the pane and never falls back to another provider", async () => {
    const f = fakeHerdrBusyThenOk(Number.POSITIVE_INFINITY);
    let now = 0;
    const herd = new HerdrHerd(f.client, "u", async (ms) => { now += ms; }, undefined, { provider: "claude", providers: ["claude", "codex", "agy"] }, undefined, undefined, () => now);
    await expect(herd.spawn({ key: "KAN-7", issuetype: "Task", summary: "s", parent: null })).rejects.toMatchObject({
      code: "agent_shell_readiness_timeout", diagnostics: { elapsedMs: PANE_READINESS_TIMEOUT_MS, processInfo: "unavailable" },
    });
    expect(f.closed).toEqual(["w9:p1"]);
    expect(f.started.length).toBe(0);
    expect(f.callCount()).toBe(PANE_READINESS_TIMEOUT_MS / PANE_READY_WAIT_MS);
    expect(now).toBe(PANE_READINESS_TIMEOUT_MS);
  });

  test("a non-busy agent.start rejection is never retried — it reaches spawn()'s own catch on the first attempt", async () => {
    const closed: string[] = [];
    let calls = 0;
    const client = {
      agent: { list: async () => ({ agents: [] }), start: async () => { calls++; throw new Error("boom"); } },
      workspace: { create: async () => ({ root_pane: "wX:p1" }) },
      pane: { close: async (p: string) => { closed.push(p); } },
    };
    const herd = new HerdrHerd(client as any, "http://x/mcp", () => Promise.resolve());
    await expect(herd.spawn({ key: "KAN-9", issuetype: "Task", summary: "s", parent: null })).rejects.toThrow("boom");
    expect(calls).toBe(1);
    expect(closed).toEqual(["wX:p1"]);
  });
});

describe("nudge", () => {
  const base = (prompts: any[], opts: { fail?: boolean; statusAfter?: string; keys?: any[] } = {}) => ({
    agent: {
      list: async () => ({ agents: [{ name: "butchr-kan-7", pane_id: "w1:p1", agent: "claude", cwd: join(workspaceRoot(), "KAN-7"), agent_status: prompts.length ? opts.statusAfter ?? "idle" : "idle" }] }),
      start: async () => {},
      prompt: async (p: any) => {
        if (opts.fail) throw new Error("pane is blocked");
        prompts.push(p);
        return { agent: { name: "butchr-kan-7", pane_id: "w1:p1", agent: "claude", cwd: join(workspaceRoot(), "KAN-7"), agent_status: "idle" } };
      },
    },
    workspace: { create: async () => ({ root_pane: "w1:p1" }) },
    pane: {
      close: async () => {},
      sendKeys: async (k: any) => { (opts.keys ?? []).push(k); },
      read: async () => ({ read: { text: "no refusal here" } }),
    },
  });
  test("Codex channel followups do not wait for Claude quota observation", async () => {
    const prompts: any[] = []; const fixture = base(prompts);
    const list = fixture.agent.list; const prompt = fixture.agent.prompt;
    fixture.agent.list = async () => ({agents:(await list()).agents.map(a=>({...a,agent:"codex",agent_status:"working"}))});
    fixture.agent.prompt = async p => ({agent:{...(await prompt(p)).agent,agent:"codex",agent_status:"working"}});
    const waits:number[]=[];
    const herd = new HerdrHerd(fixture as any,"http://x/mcp",async ms=>{waits.push(ms);});
    expect(await herd.nudge("KAN-7","stop current work")).toEqual({delivered:true});
    expect(prompts).toHaveLength(1);expect(waits).toEqual([]);
  });
  test("delivers a prompt; still idle after the wait → submits the stranded composer", async () => {
    const prompts: any[] = []; const keys: any[] = [];
    const herd = new HerdrHerd(base(prompts, { keys }) as any, "http://x/mcp", instant);
    expect(await herd.nudge("KAN-7", "[butchr] hi")).toEqual({ delivered: true });
    expect(prompts[0]).toEqual({ target: "w1:p1", text: "[butchr] hi" });
    expect(keys[0]).toEqual({ pane_id: "w1:p1", keys: ["enter"] });   // delivered ≠ turn started
  });
  test("agent went working → no enter is sent", async () => {
    const keys: any[] = [];
    const herd = new HerdrHerd(base([], { statusAfter: "working", keys }) as any, "http://x/mcp", instant);
    expect(await herd.nudge("KAN-7", "x")).toEqual({ delivered: true });
    expect(keys.length).toBe(0);
  });
  test("agent blocked after prompt → never send enter (it would pick a dialog option)", async () => {
    const keys: any[] = [];
    const herd = new HerdrHerd(base([], { statusAfter: "blocked", keys }) as any, "http://x/mcp", instant);
    expect(await herd.nudge("KAN-7", "x")).toEqual({ delivered: true });
    expect(keys.length).toBe(0);
  });
  test("false when no agent runs for the issue", async () => {
    const herd = new HerdrHerd(base([]) as any, "http://x/mcp", instant);
    expect(await herd.nudge("KAN-999", "x")).toEqual({ delivered: false });
  });
  test("delivers by pane when Herdr has cleared the friendly name", async () => {
    const prompts: any[] = [];
    const fixture = base(prompts);
    const client = {
      ...fixture,
      agent: {
        ...fixture.agent,
        list: async () => ({ agents: [{ name: null, pane_id: "w1:p1", agent: "claude", cwd: join(workspaceRoot(), "KAN-7"), agent_status: "working" }] }),
      },
    };
    const herd = new HerdrHerd(client as any, "http://x/mcp", instant);
    expect(await herd.nudge("KAN-7", "continue")).toEqual({ delivered: true });
    expect(prompts[0]).toEqual({ target: "w1:p1", text: "continue" });
  });
  test("a corrected blocked prompt result refuses delivery without recovery Enter", async () => {
    const keys: any[] = [];
    const fixture = base([], { keys });
    const client = { ...fixture, agent: { ...fixture.agent, prompt: async () => ({ agent: { agent_status: "blocked" } }) } };
    const herd = new HerdrHerd(client as any, "http://x/mcp", instant);
    expect(await herd.nudge("KAN-7", "x")).toEqual({ delivered: false });
    expect(keys).toEqual([]);
  });
  test("false when the pane refuses (blocked at prompt time)", async () => {
    const herd = new HerdrHerd(base([], { fail: true }) as any, "http://x/mcp", instant);
    expect(await herd.nudge("KAN-7", "x")).toEqual({ delivered: false });
  });
  // KAN-829: the nudge landed (agent.prompt did not throw), the agent is
  // still idle after the verify wait — but it is idle because the session
  // refused the prompt, not because of a stranded composer. Enter must NOT
  // be sent (nothing to submit), and the caller must be able to tell this
  // apart from an ordinary "delivered".
  test("prompt lands on a session-limit refusal → delivered but reports the refusal, never sends enter", async () => {
    const prompts: any[] = []; const keys: any[] = [];
    const client = base(prompts, { keys });
    client.pane.read = async () => ({ read: { text: "You've hit your session limit · resets 9:50pm" } });
    const herd = new HerdrHerd(client as any, "http://x/mcp", instant);
    const outcome = await herd.nudge("KAN-7", "x");
    expect(outcome.delivered).toBe(true);
    expect(outcome.refusal?.raw).toContain("You've hit your session limit"); // resetsAt resolution is session-limit.test.ts's concern
    expect(keys.length).toBe(0);
  });
  // KAN-831 review (PR #82): before the refusal check existed, nudge() could
  // no longer throw once agent.prompt succeeded (the only remaining call,
  // sendKeys, was already .catch(() => {})). A transient pane.read failure
  // here must not propagate: it would make daemon/index.ts's caller log
  // "refused/absent" for a prompt that WAS delivered — inverting the honesty
  // fix — and skip the stranded-composer enter, reopening KAN-691's 2.5h
  // stall via an unrelated herdr hiccup.
  test("a transient pane.read failure while checking for a refusal does not fail the nudge — falls through to submitting the stranded composer", async () => {
    const prompts: any[] = []; const keys: any[] = [];
    const client = base(prompts, { keys });
    client.pane.read = async () => { throw new Error("herdr hiccup"); };
    const herd = new HerdrHerd(client as any, "http://x/mcp", instant);
    const outcome = await herd.nudge("KAN-7", "x");
    expect(outcome).toEqual({ delivered: true });
    expect(keys[0]).toEqual({ pane_id: "w1:p1", keys: ["enter"] });
  });
});

describe("staleIssues", () => {
  /** `processInfo` responds per-pane; default to "no such pane" for any pane not given a canned response. */
  function fakeHerdrWithCwd(
    agents: Array<{ name?: string; pane_id: string; cwd?: string | null }>,
    responses: Record<string, () => Promise<{ process_info?: { pane_id: string; foreground_processes?: FakeProcess[] } }>>,
  ) {
    const calls: string[] = [];
    const client = {
      agent: { list: async () => ({ agents }) },
      pane: {
        processInfo: async (p: { pane_id: string }) => {
          calls.push(p.pane_id);
          const r = responses[p.pane_id];
          if (!r) throw new Error(`no fake response for pane ${p.pane_id}`);
          return r();
        },
      },
    };
    return { client: client as any, calls };
  }
  const instant = () => Promise.resolve();
  const ok = (foreground_processes: FakeProcess[]) => async () => ({ process_info: { pane_id: "x", foreground_processes } });
  const DEF_RESOURCE = absPath("etc", "defs", "a.json"); // reused across most tests in this block

  test("AGY residents are checked using the Drovr launch contract", async () => {
    const cwd = join(workspaceRoot(), "KAN-783");
    const argv = ["agy", ...spawnArgs({ key: "KAN-783", issuetype: "Task", summary: "", parent: null }, cwd, { provider: "agy" })];
    const { client, calls } = fakeHerdrWithCwd([{ pane_id: "agy-pane", cwd }], {
      "agy-pane": ok([{ pid: 1, argv, name: "agy" }]),
    });
    expect(await new HerdrHerd(client, "http://x/mcp", instant).staleIssues()).toEqual([]);
    expect(calls).toEqual(["agy-pane"]);
  });

  test("blocked AGY default skips stale reconciliation before inspecting residents", async () => {
    const client = { agent: { list: async () => { throw new Error("must not inspect"); } } };
    const herd = new HerdrHerd(client as any, "http://x/mcp", instant, undefined, {
      provider: "agy", agySpawnBlocked: "global bridge unavailable",
    });
    expect(await herd.staleIssues()).toEqual([]);
  });

  test("a claude process at the reported pane with a bare `claude --resume` argv -> stale, naming the missing flags", async () => {
    const cwd = join(workspaceRoot(), "KAN-783");
    const argv = ["claude", "--resume", "8e5164dc"];
    const { client } = fakeHerdrWithCwd([{ name: "butchr-kan-783", pane_id: "w1:p1", cwd }], { "w1:p1": ok([{ pid: 1, argv, name: "claude" }]) });
    const herd = new HerdrHerd(client, "http://x/mcp", instant);
    const stale = await herd.staleIssues();
    expect(stale.length).toBe(1);
    expect(stale[0]!.issue).toBe("KAN-783");
    expect(stale[0]!.reason).toContain("--permission-mode acceptEdits"); // FACTORY-138: no explicit permissionMode -> butchr's own default.
    expect(stale[0]!.reason).toContain(`--mcp-config ${cwd}/mcp.json`);
    expect(stale[0]!.reason).toContain("--dangerously-load-development-channels server:butchr");
    expect(stale[0]!.observedArgv).toEqual(argv);
  });

  test("a claude process carrying the full flag set -> not stale", async () => {
    const cwd = join(workspaceRoot(), "KAN-783");
    const goodArgv = ["claude", "follow your CLAUDE.md", "--model", "sonnet", "--permission-mode", "acceptEdits", "--mcp-config", `${cwd}/mcp.json`, "--dangerously-load-development-channels", "server:butchr"];
    const { client } = fakeHerdrWithCwd([{ name: "butchr-kan-783", pane_id: "w1:p1", cwd }], { "w1:p1": ok([{ pid: 1, argv: goodArgv, name: "claude" }]) });
    const herd = new HerdrHerd(client, "http://x/mcp", instant);
    expect(await herd.staleIssues()).toEqual([]);
  });

  test("BUTCHR-408: a managed-session agent's real bound channel server (persisted at build time, workspaceMcpServers) is honoured, not flagged stale for lacking a flag it never should have had in the first place", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require("node:fs") as typeof import("node:fs");
    const { tmpdir } = require("node:os") as typeof import("node:os");
    const previous = process.env.BUTCHR_WORKSPACES;
    const root = mkdtempSync(join(tmpdir(), "herd-mcp-"));
    process.env.BUTCHR_WORKSPACES = root;
    try {
      const key = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "managed-sessions", resourceId: DEF_RESOURCE });
      const cwd = ensureWorkspaceDir(key);
      const mcpServers = [{ name: "mud-bridge", type: "http" as const, url: "https://mud.internal/mcp", channel: true }];
      writeFileSync(join(cwd, ".butchr-mcp-servers.json"), JSON.stringify(mcpServers));
      // Built via the SAME spawnArgs a real spawn (and staleIssues' own
      // "expected" reconstruction) uses, so the channel-flag joining format
      // is guaranteed consistent rather than hand-guessed here.
      const goodArgv = ["claude", ...spawnArgs({ key, issuetype: "managed-session", summary: "s", parent: null, resource: DEF_RESOURCE, mcpServers }, cwd)];
      const { client } = fakeHerdrWithCwd([{ pane_id: "w1:p1", cwd }], { "w1:p1": ok([{ pid: 1, argv: goodArgv, name: "claude" }]) });
      const herd = new HerdrHerd(client, "http://x/mcp", instant);
      expect(await herd.staleIssues()).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.BUTCHR_WORKSPACES; else process.env.BUTCHR_WORKSPACES = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("BUTCHR-408: a running agent missing its definition's bound channel flag IS flagged stale — proves workspaceMcpServers is actually consulted, not just harmlessly absent", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require("node:fs") as typeof import("node:fs");
    const { tmpdir } = require("node:os") as typeof import("node:os");
    const previous = process.env.BUTCHR_WORKSPACES;
    const root = mkdtempSync(join(tmpdir(), "herd-mcp-drift-"));
    process.env.BUTCHR_WORKSPACES = root;
    try {
      const key = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "managed-sessions", resourceId: DEF_RESOURCE });
      const cwd = ensureWorkspaceDir(key);
      const mcpServers = [{ name: "mud-bridge", type: "http" as const, url: "https://mud.internal/mcp", channel: true }];
      writeFileSync(join(cwd, ".butchr-mcp-servers.json"), JSON.stringify(mcpServers));
      // Missing the server:mud-bridge channel flag the definition now calls for.
      const staleArgv = ["claude", ...spawnArgs({ key, issuetype: "managed-session", summary: "s", parent: null, resource: DEF_RESOURCE }, cwd)];
      const { client } = fakeHerdrWithCwd([{ pane_id: "w1:p1", cwd }], { "w1:p1": ok([{ pid: 1, argv: staleArgv, name: "claude" }]) });
      const herd = new HerdrHerd(client, "http://x/mcp", instant);
      const stale = await herd.staleIssues();
      expect(stale).toHaveLength(1);
      expect(stale[0]!.reason).toContain("server:mud-bridge");
    } finally {
      if (previous === undefined) delete process.env.BUTCHR_WORKSPACES; else process.env.BUTCHR_WORKSPACES = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

  // FACTORY-43: a managed session with `permissionMode: "auto"` respawn-looped
  // forever — staleIssues()' reconstructed expected spec never carried
  // `permissionMode` at all (only `mcpServers`/`externalMcpServers` were
  // persisted and read back), so every poll compared the real `--permission-mode
  // auto` argv against an expectation defaulting to `bypassPermissions` and
  // killed+respawned the agent every time. Same read-the-workspace-back shape
  // as the `.butchr-mcp-servers.json` pair above, extended to
  // `.butchr-permission-mode.json`.
  test("FACTORY-43: a managed-session agent launched with permissionMode \"auto\" (persisted at build time, workspacePermissionMode) is honoured, not flagged stale for a permission mode it was never launched without", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require("node:fs") as typeof import("node:fs");
    const { tmpdir } = require("node:os") as typeof import("node:os");
    const previous = process.env.BUTCHR_WORKSPACES;
    const root = mkdtempSync(join(tmpdir(), "herd-permission-mode-"));
    process.env.BUTCHR_WORKSPACES = root;
    try {
      const key = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "managed-sessions", resourceId: DEF_RESOURCE });
      const cwd = ensureWorkspaceDir(key);
      writeFileSync(join(cwd, ".butchr-permission-mode.json"), JSON.stringify("auto"));
      // Built via the SAME spawnArgs a real spawn (and staleIssues' own
      // "expected" reconstruction) uses, so the flag value is guaranteed
      // consistent rather than hand-guessed here.
      const goodArgv = ["claude", ...spawnArgs({ key, issuetype: "managed-session", summary: "s", parent: null, resource: DEF_RESOURCE, permissionMode: "auto" }, cwd)];
      const { client } = fakeHerdrWithCwd([{ pane_id: "w1:p1", cwd }], { "w1:p1": ok([{ pid: 1, argv: goodArgv, name: "claude" }]) });
      const herd = new HerdrHerd(client, "http://x/mcp", instant);
      expect(await herd.staleIssues()).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.BUTCHR_WORKSPACES; else process.env.BUTCHR_WORKSPACES = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("FACTORY-43: a running agent actually launched with the DEFAULT permission mode while its persisted definition calls for \"auto\" IS flagged stale — proves workspacePermissionMode is actually consulted, not just harmlessly absent", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require("node:fs") as typeof import("node:fs");
    const { tmpdir } = require("node:os") as typeof import("node:os");
    const previous = process.env.BUTCHR_WORKSPACES;
    const root = mkdtempSync(join(tmpdir(), "herd-permission-mode-drift-"));
    process.env.BUTCHR_WORKSPACES = root;
    try {
      const key = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "managed-sessions", resourceId: DEF_RESOURCE });
      const cwd = ensureWorkspaceDir(key);
      writeFileSync(join(cwd, ".butchr-permission-mode.json"), JSON.stringify("auto"));
      // Missing the --permission-mode auto flag the persisted definition now calls for.
      const staleArgv = ["claude", ...spawnArgs({ key, issuetype: "managed-session", summary: "s", parent: null, resource: DEF_RESOURCE }, cwd)];
      const { client } = fakeHerdrWithCwd([{ pane_id: "w1:p1", cwd }], { "w1:p1": ok([{ pid: 1, argv: staleArgv, name: "claude" }]) });
      const herd = new HerdrHerd(client, "http://x/mcp", instant);
      const stale = await herd.staleIssues();
      expect(stale).toHaveLength(1);
      expect(stale[0]!.reason).toContain("--permission-mode auto");
    } finally {
      if (previous === undefined) delete process.env.BUTCHR_WORKSPACES; else process.env.BUTCHR_WORKSPACES = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

  // FACTORY-43: same bug, `strictMcpConfig: true` — the directors' case
  // named on this ticket's own "Done when". Same fix, same shape.
  test("FACTORY-43: a managed-session agent launched with strictMcpConfig: true (persisted at build time, workspaceStrictMcpConfig) is honoured, not flagged stale for a flag it was actually launched with", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require("node:fs") as typeof import("node:fs");
    const { tmpdir } = require("node:os") as typeof import("node:os");
    const previous = process.env.BUTCHR_WORKSPACES;
    const root = mkdtempSync(join(tmpdir(), "herd-strict-mcp-config-"));
    process.env.BUTCHR_WORKSPACES = root;
    try {
      const key = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "managed-sessions", resourceId: DEF_RESOURCE });
      const cwd = ensureWorkspaceDir(key);
      writeFileSync(join(cwd, ".butchr-strict-mcp-config.json"), JSON.stringify(true));
      const goodArgv = ["claude", ...spawnArgs({ key, issuetype: "managed-session", summary: "s", parent: null, resource: DEF_RESOURCE, strictMcpConfig: true }, cwd)];
      const { client } = fakeHerdrWithCwd([{ pane_id: "w1:p1", cwd }], { "w1:p1": ok([{ pid: 1, argv: goodArgv, name: "claude" }]) });
      const herd = new HerdrHerd(client, "http://x/mcp", instant);
      expect(await herd.staleIssues()).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.BUTCHR_WORKSPACES; else process.env.BUTCHR_WORKSPACES = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("FACTORY-43: a running agent missing --strict-mcp-config while its persisted definition calls for strictMcpConfig: true IS flagged stale — proves workspaceStrictMcpConfig is actually consulted, not just harmlessly absent", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require("node:fs") as typeof import("node:fs");
    const { tmpdir } = require("node:os") as typeof import("node:os");
    const previous = process.env.BUTCHR_WORKSPACES;
    const root = mkdtempSync(join(tmpdir(), "herd-strict-mcp-config-drift-"));
    process.env.BUTCHR_WORKSPACES = root;
    try {
      const key = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "managed-sessions", resourceId: DEF_RESOURCE });
      const cwd = ensureWorkspaceDir(key);
      writeFileSync(join(cwd, ".butchr-strict-mcp-config.json"), JSON.stringify(true));
      const staleArgv = ["claude", ...spawnArgs({ key, issuetype: "managed-session", summary: "s", parent: null, resource: DEF_RESOURCE }, cwd)];
      const { client } = fakeHerdrWithCwd([{ pane_id: "w1:p1", cwd }], { "w1:p1": ok([{ pid: 1, argv: staleArgv, name: "claude" }]) });
      const herd = new HerdrHerd(client, "http://x/mcp", instant);
      const stale = await herd.staleIssues();
      expect(stale).toHaveLength(1);
      expect(stale[0]!.reason).toContain("--strict-mcp-config");
    } finally {
      if (previous === undefined) delete process.env.BUTCHR_WORKSPACES; else process.env.BUTCHR_WORKSPACES = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

  // FACTORY-108: same FACTORY-43 respawn-loop shape, for Codex's own
  // lizard-mode launch signal (`SpawnSpec.lizardMode` -> drops
  // `--dangerously-bypass-approvals-and-sandbox`). Without persisting the
  // EXPLICIT spawn-time value and reading it back into `staleIssues()`'s own
  // "expected" reconstruction, a lizard Codex agent's real (bypass-flag-less)
  // argv would forever mismatch an expectation still assuming the bypass
  // flag, and it would respawn on every poll forever.
  test("FACTORY-108: a managed-session CODEX agent launched with lizardMode: true (persisted at build time, workspaceLizardMode) is honoured, not flagged stale for lacking the bypass flag it was deliberately launched without", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require("node:fs") as typeof import("node:fs");
    const { tmpdir } = require("node:os") as typeof import("node:os");
    const previous = process.env.BUTCHR_WORKSPACES;
    const root = mkdtempSync(join(tmpdir(), "herd-lizard-mode-"));
    process.env.BUTCHR_WORKSPACES = root;
    try {
      const key = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "managed-sessions", resourceId: DEF_RESOURCE });
      const cwd = ensureWorkspaceDir(key);
      writeFileSync(join(cwd, ".butchr-lizard-mode.json"), JSON.stringify(true));
      const goodArgv = ["codex", ...spawnArgs({ key, issuetype: "managed-session", summary: "s", parent: null, resource: DEF_RESOURCE, lizardMode: true }, cwd, { provider: "codex", disabledMcpServers: [] }, "http://x/mcp")];
      const { client } = fakeHerdrWithCwd([{ pane_id: "w1:p1", cwd }], { "w1:p1": ok([{ pid: 1, argv: goodArgv, name: "codex" }]) });
      const herd = new HerdrHerd(client, "http://x/mcp", instant, undefined, { provider: "codex", disabledMcpServers: [] });
      expect(await herd.staleIssues()).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.BUTCHR_WORKSPACES; else process.env.BUTCHR_WORKSPACES = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

  // FACTORY-108: toggling lizardMode on an ALREADY-RUNNING Codex agent is
  // NOT symmetric — `checkManagedAgentArgv` only ever flags a WANTED-BUT-MISSING
  // flag, never an unwanted-but-present one. Both directions measured
  // directly here rather than assumed, per this ticket's own requirement to
  // document (and prove) what toggling actually does, not leave it silent.
  test("FACTORY-108: turning lizardMode ON while a CODEX agent is already running IN bypass mode is SILENT — not flagged stale, since the new expected argv no longer wants the bypass flag at all and checkArgv never flags an unwanted-but-present flag", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require("node:fs") as typeof import("node:fs");
    const { tmpdir } = require("node:os") as typeof import("node:os");
    const previous = process.env.BUTCHR_WORKSPACES;
    const root = mkdtempSync(join(tmpdir(), "herd-lizard-mode-toggle-on-"));
    process.env.BUTCHR_WORKSPACES = root;
    try {
      const key = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "managed-sessions", resourceId: DEF_RESOURCE });
      const cwd = ensureWorkspaceDir(key);
      // The definition has just been edited to lizardMode: true, and the daemon persisted that at the last managed-sessions poll...
      writeFileSync(join(cwd, ".butchr-lizard-mode.json"), JSON.stringify(true));
      // ...but the agent itself is still the one running from BEFORE the edit — still carrying the bypass flag.
      const stillBypassedArgv = ["codex", ...spawnArgs({ key, issuetype: "managed-session", summary: "s", parent: null, resource: DEF_RESOURCE }, cwd, { provider: "codex", disabledMcpServers: [] }, "http://x/mcp")];
      const { client } = fakeHerdrWithCwd([{ pane_id: "w1:p1", cwd }], { "w1:p1": ok([{ pid: 1, argv: stillBypassedArgv, name: "codex" }]) });
      const herd = new HerdrHerd(client, "http://x/mcp", instant, undefined, { provider: "codex", disabledMcpServers: [] });
      expect(await herd.staleIssues()).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.BUTCHR_WORKSPACES; else process.env.BUTCHR_WORKSPACES = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("FACTORY-108: turning lizardMode OFF while a CODEX agent is already running WITHOUT the bypass flag IS flagged stale and respawns it back to bypass mode — the opposite direction from the test above", async () => {
    const { mkdtempSync, mkdirSync, rmSync } = require("node:fs") as typeof import("node:fs");
    const { tmpdir } = require("node:os") as typeof import("node:os");
    const previous = process.env.BUTCHR_WORKSPACES;
    const root = mkdtempSync(join(tmpdir(), "herd-lizard-mode-toggle-off-"));
    process.env.BUTCHR_WORKSPACES = root;
    try {
      const key = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "managed-sessions", resourceId: DEF_RESOURCE });
      const cwd = ensureWorkspaceDir(key);
      // No .butchr-lizard-mode.json — the definition has just been edited BACK to lizardMode: false/unset.
      // The agent itself is still the one running from BEFORE that edit — launched without the bypass flag.
      const stillLizardArgv = ["codex", ...spawnArgs({ key, issuetype: "managed-session", summary: "s", parent: null, resource: DEF_RESOURCE, lizardMode: true }, cwd, { provider: "codex", disabledMcpServers: [] }, "http://x/mcp")];
      const { client } = fakeHerdrWithCwd([{ pane_id: "w1:p1", cwd }], { "w1:p1": ok([{ pid: 1, argv: stillLizardArgv, name: "codex" }]) });
      const herd = new HerdrHerd(client, "http://x/mcp", instant, undefined, { provider: "codex", disabledMcpServers: [] });
      const stale = await herd.staleIssues();
      expect(stale).toHaveLength(1);
      expect(stale[0]!.reason).toContain("--dangerously-bypass-approvals-and-sandbox");
    } finally {
      if (previous === undefined) delete process.env.BUTCHR_WORKSPACES; else process.env.BUTCHR_WORKSPACES = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

  // FACTORY-577/Correction 3: `checkManagedAgentArgv`'s bypass-flag
  // comparison is one-directional (the whole block is gated behind
  // `if (expected.includes(bypassFlag))`), so only manual -> YOLO is
  // detectable in butchr today. This test proves that ONE direction for
  // spec.permissionMode (as opposed to lizardMode, covered above); the
  // opposite direction (YOLO -> manual) is NOT achievable here and is
  // deliberately not asserted as if it respawned — see FACTORY-578's PR
  // body/comment for the drovr ticket filed against the missing half.
  test("FACTORY-577: a managed-session CODEX agent's definition changing permissionMode from manual to bypassPermissions (persisted at build time) IS flagged stale and respawns to pick up the bypass flag", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require("node:fs") as typeof import("node:fs");
    const { tmpdir } = require("node:os") as typeof import("node:os");
    const previous = process.env.BUTCHR_WORKSPACES;
    const root = mkdtempSync(join(tmpdir(), "herd-permission-mode-toggle-to-bypass-"));
    process.env.BUTCHR_WORKSPACES = root;
    try {
      const key = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "managed-sessions", resourceId: DEF_RESOURCE });
      const cwd = ensureWorkspaceDir(key);
      // The definition has just been edited to permissionMode: "bypassPermissions", and the daemon persisted that at the last managed-sessions poll...
      writeFileSync(join(cwd, ".butchr-permission-mode.json"), JSON.stringify("bypassPermissions"));
      // ...but the agent itself is still the one running from BEFORE the edit — launched manual, no bypass flag.
      const stillManualArgv = ["codex", ...spawnArgs({ key, issuetype: "managed-session", summary: "s", parent: null, resource: DEF_RESOURCE, permissionMode: "default" }, cwd, { provider: "codex", disabledMcpServers: [] }, "http://x/mcp")];
      const { client } = fakeHerdrWithCwd([{ pane_id: "w1:p1", cwd }], { "w1:p1": ok([{ pid: 1, argv: stillManualArgv, name: "codex" }]) });
      const herd = new HerdrHerd(client, "http://x/mcp", instant, undefined, { provider: "codex", disabledMcpServers: [] });
      const stale = await herd.staleIssues();
      expect(stale).toHaveLength(1);
      expect(stale[0]!.reason).toContain("--dangerously-bypass-approvals-and-sandbox");
    } finally {
      if (previous === undefined) delete process.env.BUTCHR_WORKSPACES; else process.env.BUTCHR_WORKSPACES = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("FACTORY-108: a RULE-launched (non-managed-session) CODEX agent with lizardMode: true persisted is likewise honoured, not flagged stale for lacking the bypass flag — the persist/read-back path is not managed-session-only", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require("node:fs") as typeof import("node:fs");
    const { tmpdir } = require("node:os") as typeof import("node:os");
    const previous = process.env.BUTCHR_WORKSPACES;
    const root = mkdtempSync(join(tmpdir(), "herd-lizard-mode-rule-"));
    process.env.BUTCHR_WORKSPACES = root;
    try {
      const key = encodeAgentKey({ resourceProvider: "jira-work", ruleId: "live-jira-work", resourceId: "BUTCHR-364" });
      const cwd = ensureWorkspaceDir(key);
      writeFileSync(join(cwd, ".butchr-lizard-mode.json"), JSON.stringify(true));
      const goodArgv = ["codex", ...spawnArgs({ key, issuetype: "task", summary: "", parent: null, resource: "BUTCHR-364", lizardMode: true }, cwd, { provider: "codex", disabledMcpServers: [] }, "http://x/mcp")];
      const { client } = fakeHerdrWithCwd([{ pane_id: "w1:p1", cwd }], { "w1:p1": ok([{ pid: 1, argv: goodArgv, name: "codex" }]) });
      const herd = new HerdrHerd(client, "http://x/mcp", instant, undefined, { provider: "codex", disabledMcpServers: [] });
      expect(await herd.staleIssues()).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.BUTCHR_WORKSPACES; else process.env.BUTCHR_WORKSPACES = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("FACTORY-108: a non-lizard CODEX agent's staleness behaviour is unchanged — no .butchr-lizard-mode.json, bypass flag present, still not stale", async () => {
    const { mkdtempSync, mkdirSync, rmSync } = require("node:fs") as typeof import("node:fs");
    const { tmpdir } = require("node:os") as typeof import("node:os");
    const previous = process.env.BUTCHR_WORKSPACES;
    const root = mkdtempSync(join(tmpdir(), "herd-lizard-mode-absent-"));
    process.env.BUTCHR_WORKSPACES = root;
    try {
      const key = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "managed-sessions", resourceId: DEF_RESOURCE });
      const cwd = ensureWorkspaceDir(key);
      const goodArgv = ["codex", ...spawnArgs({ key, issuetype: "managed-session", summary: "s", parent: null, resource: DEF_RESOURCE }, cwd, { provider: "codex", disabledMcpServers: [] }, "http://x/mcp")];
      const { client } = fakeHerdrWithCwd([{ pane_id: "w1:p1", cwd }], { "w1:p1": ok([{ pid: 1, argv: goodArgv, name: "codex" }]) });
      const herd = new HerdrHerd(client, "http://x/mcp", instant, undefined, { provider: "codex", disabledMcpServers: [] });
      expect(await herd.staleIssues()).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.BUTCHR_WORKSPACES; else process.env.BUTCHR_WORKSPACES = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

  // FACTORY-138 (AC4, the respawn-loop guard): the shared builder
  // (`agentLaunchConfig`) now defaults an unset `permissionMode` to
  // `acceptEdits` — and `staleIssues()` reconstructs its own "expected" argv
  // through that SAME builder (via `spawnArgs`), never a second,
  // independently-maintained expectation — so a fresh launch and its own
  // stale check derive the same value by construction, exactly the FACTORY-43
  // property this guards. Modelled on the FACTORY-43 test pair above, through
  // the REAL `buildWorkspace`, not a hand-written fixture.
  test("FACTORY-138: a fresh managed-session launch with NO explicit permissionMode is not flagged stale — not on the first poll, nor a second one", async () => {
    const { rmSync, mkdtempSync } = require("node:fs") as typeof import("node:fs");
    const { tmpdir } = require("node:os") as typeof import("node:os");
    const previous = process.env.BUTCHR_WORKSPACES;
    const root = mkdtempSync(join(tmpdir(), "herd-permission-mode-default-"));
    process.env.BUTCHR_WORKSPACES = root;
    try {
      const key = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "managed-sessions", resourceId: DEF_RESOURCE });
      const spec = { key, issuetype: "managed-session", summary: "s", parent: null, resource: DEF_RESOURCE };
      // The REAL buildWorkspace — no permissionMode on the spec, so
      // `.butchr-permission-mode.json` is never written (buildWorkspace only
      // persists an EXPLICIT value), matching a real spec-construction site
      // that leaves the field unset for `agentLaunchConfig` to default.
      const cwd = buildWorkspace(spec, "http://x/mcp", "claude");
      // The SAME spawnArgs a real spawn() call uses — resolves to `acceptEdits` via the shared builder.
      const freshArgv = ["claude", ...spawnArgs(spec, cwd)];
      expect(freshArgv).toContain("acceptEdits");
      const { client } = fakeHerdrWithCwd([{ pane_id: "w1:p1", cwd }], { "w1:p1": ok([{ pid: 1, argv: freshArgv, name: "claude" }]) });
      const herd = new HerdrHerd(client, "http://x/mcp", instant);
      expect(await herd.staleIssues()).toEqual([]);
      expect(await herd.staleIssues()).toEqual([]); // second poll: still not stale.
    } finally {
      if (previous === undefined) delete process.env.BUTCHR_WORKSPACES; else process.env.BUTCHR_WORKSPACES = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("FACTORY-138: an agent actually running with the PRE-CHANGE argv (--permission-mode bypassPermissions, no persisted mode — what the old builder produced) IS flagged stale exactly once at deploy; the replacement launched with the new argv is not flagged again", async () => {
    const { rmSync, mkdtempSync } = require("node:fs") as typeof import("node:fs");
    const { tmpdir } = require("node:os") as typeof import("node:os");
    const previous = process.env.BUTCHR_WORKSPACES;
    const root = mkdtempSync(join(tmpdir(), "herd-permission-mode-deploy-"));
    process.env.BUTCHR_WORKSPACES = root;
    try {
      const key = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "managed-sessions", resourceId: DEF_RESOURCE });
      const spec = { key, issuetype: "managed-session", summary: "s", parent: null, resource: DEF_RESOURCE };
      const cwd = buildWorkspace(spec, "http://x/mcp", "claude"); // no permissionMode persisted, same as before this ticket.
      // What every currently-running agent's argv actually looks like today: no --permission-mode flag was ever
      // sent by butchr, so Drovr's own `launch.permissionMode ?? "bypassPermissions"` fallback produced this value.
      const preChangeArgv = ["claude", "follow your CLAUDE.md", "--model", "sonnet", "--effort", "high", "--permission-mode", "bypassPermissions", "--mcp-config", `${cwd}/mcp.json`, "--dangerously-load-development-channels", "server:butchr"];
      const { client } = fakeHerdrWithCwd([{ pane_id: "w1:p1", cwd }], { "w1:p1": ok([{ pid: 1, argv: preChangeArgv, name: "claude" }]) });
      const herd = new HerdrHerd(client, "http://x/mcp", instant);
      const stale = await herd.staleIssues();
      expect(stale).toHaveLength(1); // the one-time respawn at deploy.
      expect(stale[0]!.reason).toContain("--permission-mode acceptEdits");
      // The replacement, launched with the new builder's argv, stays clean across subsequent polls — not a loop.
      const freshArgv = ["claude", ...spawnArgs(spec, cwd)];
      const { client: freshClient } = fakeHerdrWithCwd([{ pane_id: "w1:p1", cwd }], { "w1:p1": ok([{ pid: 1, argv: freshArgv, name: "claude" }]) });
      const herdAfterRespawn = new HerdrHerd(freshClient, "http://x/mcp", instant);
      for (let poll = 0; poll < 5; poll++) expect(await herdAfterRespawn.staleIssues()).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.BUTCHR_WORKSPACES; else process.env.BUTCHR_WORKSPACES = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

  // FACTORY-75: `--model`/`--effort` are deliberately excluded from
  // `checkArgv`/`checkManagedAgentArgv`'s own comparison (this method's own
  // top comment, and every FACTORY-43 test pair above never asserts on
  // either flag), so the two-axis (modelPower/effort) mechanism's
  // auto-reconcile-on-change needs its OWN comparison: `resolvedAgentOf`
  // (the LIVE current resolution) against `workspaceModel`/`workspaceEffort`
  // (what this workspace was ACTUALLY spawned with). A NAIVE implementation
  // that skips the persist-and-read-back step — comparing `resolvedAgentOf`
  // against itself, or against nothing at all — would find every one of
  // these two tests indistinguishable (both "live" reads return the same
  // thing on their own), so it would either flag EVERY agent stale forever
  // (a respawn loop, FACTORY-43's own failure shape) or never flag a real
  // drift at all (the negative test below) — the exact two `resolvedAgentOf`
  // is built to avoid.
  test("FACTORY-75: a managed-session agent whose persisted model/effort (workspaceModel/workspaceEffort) matches what the definition CURRENTLY resolves to (resolvedAgentOf) is NOT flagged stale", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require("node:fs") as typeof import("node:fs");
    const { tmpdir } = require("node:os") as typeof import("node:os");
    const previous = process.env.BUTCHR_WORKSPACES;
    const root = mkdtempSync(join(tmpdir(), "herd-model-effort-"));
    process.env.BUTCHR_WORKSPACES = root;
    try {
      const key = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "managed-sessions", resourceId: DEF_RESOURCE });
      const cwd = ensureWorkspaceDir(key);
      writeFileSync(join(cwd, ".butchr-model.json"), JSON.stringify("fable"));
      writeFileSync(join(cwd, ".butchr-effort.json"), JSON.stringify("xhigh"));
      const goodArgv = ["claude", ...spawnArgs({ key, issuetype: "managed-session", summary: "s", parent: null, resource: DEF_RESOURCE }, cwd)];
      const { client } = fakeHerdrWithCwd([{ pane_id: "w1:p1", cwd }], { "w1:p1": ok([{ pid: 1, argv: goodArgv, name: "claude" }]) });
      const herd = new HerdrHerd(client, "http://x/mcp", instant, undefined, undefined, undefined, undefined, undefined, undefined, undefined, () => ({ model: "fable", effort: "xhigh" }));
      expect(await herd.staleIssues()).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.BUTCHR_WORKSPACES; else process.env.BUTCHR_WORKSPACES = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("FACTORY-75: a managed-session agent whose persisted model/effort no longer matches what the definition CURRENTLY resolves to (an edit, or a table edit shipped in a new build) IS flagged stale — proves resolvedAgentOf is actually consulted against the PERSISTED value, not compared against itself", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require("node:fs") as typeof import("node:fs");
    const { tmpdir } = require("node:os") as typeof import("node:os");
    const previous = process.env.BUTCHR_WORKSPACES;
    const root = mkdtempSync(join(tmpdir(), "herd-model-effort-drift-"));
    process.env.BUTCHR_WORKSPACES = root;
    try {
      const key = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "managed-sessions", resourceId: DEF_RESOURCE });
      const cwd = ensureWorkspaceDir(key);
      // Spawned a while ago at Sonnet/medium...
      writeFileSync(join(cwd, ".butchr-model.json"), JSON.stringify("sonnet"));
      writeFileSync(join(cwd, ".butchr-effort.json"), JSON.stringify("medium"));
      const staleArgv = ["claude", ...spawnArgs({ key, issuetype: "managed-session", summary: "s", parent: null, resource: DEF_RESOURCE }, cwd)];
      const { client } = fakeHerdrWithCwd([{ pane_id: "w1:p1", cwd }], { "w1:p1": ok([{ pid: 1, argv: staleArgv, name: "claude" }]) });
      // ...but the definition now resolves to Fable/xhigh (an edit, or a table edit).
      const herd = new HerdrHerd(client, "http://x/mcp", instant, undefined, undefined, undefined, undefined, undefined, undefined, undefined, () => ({ model: "fable", effort: "xhigh" }));
      const stale = await herd.staleIssues();
      expect(stale).toHaveLength(1);
      expect(stale[0]!.reason).toContain("sonnet");
      expect(stale[0]!.reason).toContain("fable");
    } finally {
      if (previous === undefined) delete process.env.BUTCHR_WORKSPACES; else process.env.BUTCHR_WORKSPACES = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

  // DoD: "clean across 5+ reconcile polls after the single restart" — once
  // the normal reconcile loop stops the stale agent and respawns it
  // (buildWorkspace persisting the NEW resolved model/effort, exactly as
  // the drifted test above's OWN definition now resolves), staleIssues()
  // must stay clean forever after, not just on the next poll — proving
  // this is a single edge-triggered restart, never a respawn loop.
  test("FACTORY-75: after a respawn re-persists the new resolved model/effort, staleIssues() stays clean across 5+ subsequent polls", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require("node:fs") as typeof import("node:fs");
    const { tmpdir } = require("node:os") as typeof import("node:os");
    const previous = process.env.BUTCHR_WORKSPACES;
    const root = mkdtempSync(join(tmpdir(), "herd-model-effort-respawn-clean-"));
    process.env.BUTCHR_WORKSPACES = root;
    try {
      const key = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "managed-sessions", resourceId: DEF_RESOURCE });
      const cwd = ensureWorkspaceDir(key);
      // The respawn already happened: buildWorkspace persisted the NEW resolved model/effort...
      writeFileSync(join(cwd, ".butchr-model.json"), JSON.stringify("fable"));
      writeFileSync(join(cwd, ".butchr-effort.json"), JSON.stringify("xhigh"));
      // ...and the running process now reflects it too (argv itself never carries --model/--effort comparison, but the workspace persistence does).
      const freshArgv = ["claude", ...spawnArgs({ key, issuetype: "managed-session", summary: "s", parent: null, resource: DEF_RESOURCE }, cwd)];
      const { client } = fakeHerdrWithCwd([{ pane_id: "w1:p1", cwd }], { "w1:p1": ok([{ pid: 1, argv: freshArgv, name: "claude" }]) });
      const herd = new HerdrHerd(client, "http://x/mcp", instant, undefined, undefined, undefined, undefined, undefined, undefined, undefined, () => ({ model: "fable", effort: "xhigh" }));
      for (let poll = 0; poll < 5; poll++) expect(await herd.staleIssues()).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.BUTCHR_WORKSPACES; else process.env.BUTCHR_WORKSPACES = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

  // DoD item 1+2, end-to-end through the REAL chain — discovery's own
  // resolver (effectiveAgent), the REAL spec builder (specForSessionDefinition),
  // and the REAL buildWorkspace persistence, not hand-written fixture files
  // standing in for them. Only the herdr client itself is faked (as every
  // other test in this describe block already does) — the closest faithful
  // harness available without a real running daemon/Codex-CLI process,
  // which this ticket's own constraints forbid touching anyway ("do not
  // touch live runtimes, services, or definitions").
  test("FACTORY-75 end-to-end: a definition at modelPower=100/effort=70 launches Fable/xhigh through the REAL resolver+spec+persistence chain; editing it to the canonical Sonnet/medium pair flags exactly one restart", async () => {
    const { mkdtempSync, rmSync } = require("node:fs") as typeof import("node:fs");
    const { tmpdir } = require("node:os") as typeof import("node:os");
    const previous = process.env.BUTCHR_WORKSPACES;
    const root = mkdtempSync(join(tmpdir(), "herd-e2e-power-scale-"));
    process.env.BUTCHR_WORKSPACES = root;
    try {
      const rule = builtinManagedSessionsRule(absPath("etc", "defs"));
      const resourcePath = absPath("etc", "defs", "admin-agentcost.json");
      const agentKey = encodeAgentKey({ resourceProvider: "filesystem", ruleId: rule.id, resourceId: resourcePath });
      // The REAL resolver (effectiveAgent) and REAL spec builder (specForSessionDefinition) —
      // exactly what searchSessionDefinitions/specForSessionDefinitionUnit run in production.
      const definitionAt100_70 = { workingDirectory: absPath("repo", "admin-agentcost"), brief: "Track spend.", vendor: "claude" as const, modelPower: 100, effort: 70, permissionMode: "default" as const, execution: "swarm" as const, account: "none" as const, role: "worker" as const, frozen: false };
      const spec = specForSessionDefinition({ agentKey, rule, resource: { path: resourcePath, kind: "file", name: "admin-agentcost.json", size: 10, mtimeMs: 1 }, definition: definitionAt100_70 });
      expect(spec.agents).toEqual([{ harness: "claude", model: "fable", effort: "xhigh" }]); // DoD item 1: modelPower=100/effort=70 -> Fable at xhigh.
      // The REAL buildWorkspace — persists .butchr-model.json/.butchr-effort.json exactly as a real spawn would.
      const cwd = buildWorkspace(spec, "http://x/mcp", "claude");
      const freshArgv = ["claude", ...spawnArgs(spec, cwd)];
      const { client } = fakeHerdrWithCwd([{ pane_id: "w1:p1", cwd }], { "w1:p1": ok([{ pid: 1, argv: freshArgv, name: "claude" }]) });
      // "Live" resolution matches what was just persisted — not stale.
      const herdAtRest = new HerdrHerd(client, "http://x/mcp", instant, undefined, undefined, undefined, undefined, undefined, undefined, undefined, () => effectiveAgent(definitionAt100_70));
      expect(await herdAtRest.staleIssues()).toEqual([]);
      // DoD item 2: the operator edits modelPower/effort to the canonical Sonnet/medium pair —
      // the SAME real effectiveAgent() call now resolves differently; the persisted files still say Fable/xhigh.
      const definitionAtSonnetMedium = { ...definitionAt100_70, modelPower: 25, effort: 20 };
      expect(effectiveAgent(definitionAtSonnetMedium)).toEqual({ model: "sonnet", effort: "medium" });
      const herdAfterEdit = new HerdrHerd(client, "http://x/mcp", instant, undefined, undefined, undefined, undefined, undefined, undefined, undefined, () => effectiveAgent(definitionAtSonnetMedium));
      const stale = await herdAfterEdit.staleIssues();
      expect(stale).toHaveLength(1); // exactly one restart signalled, not a loop of many.
      expect(stale[0]!.reason).toContain("fable"); expect(stale[0]!.reason).toContain("sonnet");
    } finally {
      if (previous === undefined) delete process.env.BUTCHR_WORKSPACES; else process.env.BUTCHR_WORKSPACES = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

  // PR #473 review fix — the mass-restart-on-deploy bug: a workspace
  // spawned by a build BEFORE this ticket never wrote
  // `.butchr-model.json`/`.butchr-effort.json` at all, so every
  // already-running tier-based managed session (whose `effectiveAgent()`
  // always resolves a defined `model`) would have been flagged stale on
  // the very first poll after deploy, with no edit having happened. Fixed
  // by falling back to `proc.argv` (Claude always emits `--model`/`--effort`
  // unconditionally) when the persisted file is absent — see
  // `staleIssues()`'s own doc comment on this seam for the full account.
  describe("FACTORY-75 review fix: legacy workspaces (spawned before this ticket, no .butchr-model.json/.butchr-effort.json) must not mass-restart on deploy", () => {
    test("a legacy tier-based managed session whose argv already matches its definition's resolved model is NOT flagged stale, even with no persisted model/effort file at all", async () => {
      const { mkdtempSync, mkdirSync, rmSync } = require("node:fs") as typeof import("node:fs");
      const { tmpdir } = require("node:os") as typeof import("node:os");
      const previous = process.env.BUTCHR_WORKSPACES;
      const root = mkdtempSync(join(tmpdir(), "herd-legacy-tier-match-"));
      process.env.BUTCHR_WORKSPACES = root;
      try {
        const key = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "managed-sessions", resourceId: DEF_RESOURCE });
        const cwd = ensureWorkspaceDir(key); // no .butchr-model.json/.butchr-effort.json — the pre-this-ticket build never wrote them.
        // A pre-existing build's real launch: agentLaunchConfig always emits both --model and --effort for Claude, unconditionally (its own default fallback resolved to sonnet/high here).
        const argv = ["claude", "follow your CLAUDE.md", "--model", "sonnet", "--effort", "high", "--permission-mode", "acceptEdits", "--mcp-config", `${cwd}/mcp.json`, "--dangerously-load-development-channels", "server:butchr"]; // FACTORY-138: no persisted permission mode -> butchr's own default, not Drovr's bypassPermissions fallback.
        const { client } = fakeHerdrWithCwd([{ pane_id: "w1:p1", cwd }], { "w1:p1": ok([{ pid: 1, argv, name: "claude" }]) });
        // The tier1 definition still resolves to sonnet, no effort — matches what's actually running.
        const herd = new HerdrHerd(client, "http://x/mcp", instant, undefined, undefined, undefined, undefined, undefined, undefined, undefined, () => ({ model: "sonnet" }));
        expect(await herd.staleIssues()).toEqual([]);
      } finally {
        if (previous === undefined) delete process.env.BUTCHR_WORKSPACES; else process.env.BUTCHR_WORKSPACES = previous;
        rmSync(root, { recursive: true, force: true });
      }
    });

    test("a legacy tier-based managed session whose definition has since changed IS flagged stale exactly once (no persisted file, argv fallback used); after the respawn persists the new values, staleIssues() stays clean across 5+ subsequent polls", async () => {
      const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require("node:fs") as typeof import("node:fs");
      const { tmpdir } = require("node:os") as typeof import("node:os");
      const previous = process.env.BUTCHR_WORKSPACES;
      const root = mkdtempSync(join(tmpdir(), "herd-legacy-tier-drift-"));
      process.env.BUTCHR_WORKSPACES = root;
      try {
        const key = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "managed-sessions", resourceId: DEF_RESOURCE });
        const cwd = ensureWorkspaceDir(key); // legacy: no persisted model/effort file.
        const legacyArgv = ["claude", "follow your CLAUDE.md", "--model", "sonnet", "--effort", "high", "--permission-mode", "acceptEdits", "--mcp-config", `${cwd}/mcp.json`, "--dangerously-load-development-channels", "server:butchr"];
        const { client } = fakeHerdrWithCwd([{ pane_id: "w1:p1", cwd }], { "w1:p1": ok([{ pid: 1, argv: legacyArgv, name: "claude" }]) });
        // The operator has since moved this definition to modelPower=100/effort=70 (Fable/xhigh).
        const herd = new HerdrHerd(client, "http://x/mcp", instant, undefined, undefined, undefined, undefined, undefined, undefined, undefined, () => ({ model: "fable", effort: "xhigh" }));
        const stale = await herd.staleIssues();
        expect(stale).toHaveLength(1);
        expect(stale[0]!.reason).toContain("sonnet"); expect(stale[0]!.reason).toContain("fable");
        // Respawn happens: buildWorkspace persists the NEW resolved values.
        writeFileSync(join(cwd, ".butchr-model.json"), JSON.stringify("fable"));
        writeFileSync(join(cwd, ".butchr-effort.json"), JSON.stringify("xhigh"));
        const freshArgv = ["claude", "follow your CLAUDE.md", "--model", "fable", "--effort", "xhigh", "--permission-mode", "acceptEdits", "--mcp-config", `${cwd}/mcp.json`, "--dangerously-load-development-channels", "server:butchr"]; // FACTORY-138: matches the new default.
        const { client: freshClient } = fakeHerdrWithCwd([{ pane_id: "w1:p1", cwd }], { "w1:p1": ok([{ pid: 1, argv: freshArgv, name: "claude" }]) });
        const herdAfterRespawn = new HerdrHerd(freshClient, "http://x/mcp", instant, undefined, undefined, undefined, undefined, undefined, undefined, undefined, () => ({ model: "fable", effort: "xhigh" }));
        for (let poll = 0; poll < 5; poll++) expect(await herdAfterRespawn.staleIssues()).toEqual([]);
      } finally {
        if (previous === undefined) delete process.env.BUTCHR_WORKSPACES; else process.env.BUTCHR_WORKSPACES = previous;
        rmSync(root, { recursive: true, force: true });
      }
    });

    test("a legacy RULE agent with an explicit agentPreferences.model/effort (unrelated to modelPower/effortPower) is NOT flagged stale when its argv already matches, even with no persisted file", async () => {
      const { mkdtempSync, mkdirSync, rmSync } = require("node:fs") as typeof import("node:fs");
      const { tmpdir } = require("node:os") as typeof import("node:os");
      const previous = process.env.BUTCHR_WORKSPACES;
      const root = mkdtempSync(join(tmpdir(), "herd-legacy-rule-match-"));
      process.env.BUTCHR_WORKSPACES = root;
      try {
        const issue = "jira-work:triage:KAN-500";
        const cwd = workspaceDirFor(issue);
        mkdirSync(cwd, { recursive: true }); // legacy: no persisted model/effort file.
        const argv = ["claude", "follow your CLAUDE.md", "--model", "opus", "--effort", "high", "--permission-mode", "acceptEdits", "--mcp-config", `${cwd}/mcp.json`, "--dangerously-load-development-channels", "server:butchr"]; // FACTORY-138: no persisted permission mode -> butchr's own default.
        const { client } = fakeHerdrWithCwd([{ pane_id: "w1:p1", cwd }], { "w1:p1": ok([{ pid: 1, argv, name: "claude" }]) });
        const herd = new HerdrHerd(client, "http://x/mcp", instant, undefined, undefined, undefined, undefined, undefined, undefined, undefined, () => ({ model: "opus", effort: "high" }));
        expect(await herd.staleIssues()).toEqual([]);
      } finally {
        if (previous === undefined) delete process.env.BUTCHR_WORKSPACES; else process.env.BUTCHR_WORKSPACES = previous;
        rmSync(root, { recursive: true, force: true });
      }
    });

    test("a legacy RULE agent whose explicit agentPreferences.model has since changed IS flagged stale exactly once, then clean across 5+ polls after the respawn persists the new value", async () => {
      const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require("node:fs") as typeof import("node:fs");
      const { tmpdir } = require("node:os") as typeof import("node:os");
      const previous = process.env.BUTCHR_WORKSPACES;
      const root = mkdtempSync(join(tmpdir(), "herd-legacy-rule-drift-"));
      process.env.BUTCHR_WORKSPACES = root;
      try {
        const issue = "jira-work:triage:KAN-501";
        const cwd = workspaceDirFor(issue);
        mkdirSync(cwd, { recursive: true });
        const legacyArgv = ["claude", "follow your CLAUDE.md", "--model", "opus", "--effort", "high", "--permission-mode", "acceptEdits", "--mcp-config", `${cwd}/mcp.json`, "--dangerously-load-development-channels", "server:butchr"];
        const { client } = fakeHerdrWithCwd([{ pane_id: "w1:p1", cwd }], { "w1:p1": ok([{ pid: 1, argv: legacyArgv, name: "claude" }]) });
        // An operator edit to rules.json moved this rule to a different explicit model.
        const herd = new HerdrHerd(client, "http://x/mcp", instant, undefined, undefined, undefined, undefined, undefined, undefined, undefined, () => ({ model: "haiku", effort: "low" }));
        const stale = await herd.staleIssues();
        expect(stale).toHaveLength(1);
        expect(stale[0]!.reason).toContain("opus"); expect(stale[0]!.reason).toContain("haiku");
        writeFileSync(join(cwd, ".butchr-model.json"), JSON.stringify("haiku"));
        writeFileSync(join(cwd, ".butchr-effort.json"), JSON.stringify("low"));
        const freshArgv = ["claude", "follow your CLAUDE.md", "--model", "haiku", "--effort", "low", "--permission-mode", "acceptEdits", "--mcp-config", `${cwd}/mcp.json`, "--dangerously-load-development-channels", "server:butchr"]; // FACTORY-138: matches the new default.
        const { client: freshClient } = fakeHerdrWithCwd([{ pane_id: "w1:p1", cwd }], { "w1:p1": ok([{ pid: 1, argv: freshArgv, name: "claude" }]) });
        const herdAfterRespawn = new HerdrHerd(freshClient, "http://x/mcp", instant, undefined, undefined, undefined, undefined, undefined, undefined, undefined, () => ({ model: "haiku", effort: "low" }));
        for (let poll = 0; poll < 5; poll++) expect(await herdAfterRespawn.staleIssues()).toEqual([]);
      } finally {
        if (previous === undefined) delete process.env.BUTCHR_WORKSPACES; else process.env.BUTCHR_WORKSPACES = previous;
        rmSync(root, { recursive: true, force: true });
      }
    });

    // Codex has no --effort flag at all (its reasoning effort lives only in
    // .codex/config.toml) — with no persisted effort file and no argv
    // signal, there is nothing to compare against, so a legacy Codex rule
    // agent's explicit effort preference must never be flagged (the
    // "unknown, not stale" fail-safe), even though its effort has genuinely
    // never been observed.
    test("a legacy CODEX rule agent with an explicit effort preference is NOT flagged stale for effort — Codex has no argv signal for it at all, so 'unknown' must not read as 'changed'", async () => {
      const { mkdtempSync, mkdirSync, rmSync } = require("node:fs") as typeof import("node:fs");
      const { tmpdir } = require("node:os") as typeof import("node:os");
      const previous = process.env.BUTCHR_WORKSPACES;
      const root = mkdtempSync(join(tmpdir(), "herd-legacy-codex-effort-"));
      process.env.BUTCHR_WORKSPACES = root;
      try {
        const issue = "jira-work:triage:KAN-502";
        const cwd = workspaceDirFor(issue);
        mkdirSync(cwd, { recursive: true }); // legacy: no persisted model/effort file, no .codex/config.toml either.
        // A realistic codex launch, via the SAME spawnArgs() builder the real launch and staleIssues() reconstruction both use.
        const spec = { key: issue, issuetype: "task", summary: "s", parent: null, resource: "KAN-502" };
        // spawnArgs()/agentLaunchConfig() reads the launch model from the AgentConfig param directly (spec.agents is
        // resolved into it by startProviders()'s own prepare() callback before a real launch reaches this point).
        const argv = ["codex", ...spawnArgs(spec, cwd, { provider: "codex", model: "gpt-6-astra", disabledMcpServers: [] }, "http://x/mcp")];
        const { client } = fakeHerdrWithCwd([{ pane_id: "w1:p1", cwd }], { "w1:p1": ok([{ pid: 1, argv, name: "codex" }]) });
        // model matches (recovered from argv); effort ("high") has no argv signal at all for codex.
        const herd = new HerdrHerd(client, "http://x/mcp", instant, undefined, { provider: "codex", disabledMcpServers: [] }, undefined, undefined, undefined, undefined, undefined, () => ({ model: "gpt-6-astra", effort: "high" }));
        expect(await herd.staleIssues()).toEqual([]);
      } finally {
        if (previous === undefined) delete process.env.BUTCHR_WORKSPACES; else process.env.BUTCHR_WORKSPACES = previous;
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  test("FACTORY-75: resolvedAgentOf returning undefined (nothing this daemon can resolve for this issue) means nothing to compare — never flagged, same fail-safe shape mcpBindingsOf's own absence already has", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require("node:fs") as typeof import("node:fs");
    const { tmpdir } = require("node:os") as typeof import("node:os");
    const previous = process.env.BUTCHR_WORKSPACES;
    const root = mkdtempSync(join(tmpdir(), "herd-model-effort-unresolved-"));
    process.env.BUTCHR_WORKSPACES = root;
    try {
      const key = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "managed-sessions", resourceId: DEF_RESOURCE });
      const cwd = ensureWorkspaceDir(key);
      writeFileSync(join(cwd, ".butchr-model.json"), JSON.stringify("sonnet"));
      const argv = ["claude", ...spawnArgs({ key, issuetype: "managed-session", summary: "s", parent: null, resource: DEF_RESOURCE }, cwd)];
      const { client } = fakeHerdrWithCwd([{ pane_id: "w1:p1", cwd }], { "w1:p1": ok([{ pid: 1, argv, name: "claude" }]) });
      const herd = new HerdrHerd(client, "http://x/mcp", instant, undefined, undefined, undefined, undefined, undefined, undefined, undefined, () => undefined);
      expect(await herd.staleIssues()).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.BUTCHR_WORKSPACES; else process.env.BUTCHR_WORKSPACES = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("no cwd reported for the agent -> unknown, not stale (never even calls pane.process_info)", async () => {
    const { client, calls } = fakeHerdrWithCwd([{ name: "butchr-kan-783", pane_id: "w1:p1", cwd: null }], { "w1:p1": ok([{ pid: 1, argv: ["claude", "--resume", "x"], name: "claude" }]) });
    const herd = new HerdrHerd(client, "http://x/mcp", instant);
    expect(await herd.staleIssues()).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("pane.process_info rejects -> unknown, not stale, and does not abort the sweep for other issues", async () => {
    const cwd = join(workspaceRoot(), "KAN-783");
    const otherCwd = join(workspaceRoot(), "KAN-9");
    const goodArgv = ["claude", "follow your CLAUDE.md", "--model", "sonnet", "--permission-mode", "acceptEdits", "--mcp-config", `${otherCwd}/mcp.json`, "--dangerously-load-development-channels", "server:butchr"];
    const { client } = fakeHerdrWithCwd(
      [{ name: "butchr-kan-783", pane_id: "w1:p1", cwd }, { name: "butchr-kan-9", pane_id: "w1:p2", cwd: otherCwd }],
      { "w1:p1": async () => { throw new Error("herdr socket hiccup"); }, "w1:p2": ok([{ pid: 2, argv: goodArgv, name: "claude" }]) },
    );
    const herd = new HerdrHerd(client, "http://x/mcp", instant);
    expect(await herd.staleIssues()).toEqual([]); // KAN-783's failure didn't stop KAN-9 from being (correctly) cleared
  });

  test("no process_info in the result -> unknown, not stale", async () => {
    const cwd = join(workspaceRoot(), "KAN-783");
    const { client } = fakeHerdrWithCwd([{ name: "butchr-kan-783", pane_id: "w1:p1", cwd }], { "w1:p1": async () => ({}) });
    const herd = new HerdrHerd(client, "http://x/mcp", instant);
    expect(await herd.staleIssues()).toEqual([]);
  });

  test("foreground_processes absent from process_info -> unknown, not stale", async () => {
    const cwd = join(workspaceRoot(), "KAN-783");
    const { client } = fakeHerdrWithCwd([{ name: "butchr-kan-783", pane_id: "w1:p1", cwd }], { "w1:p1": async () => ({ process_info: { pane_id: "w1:p1" } }) });
    const herd = new HerdrHerd(client, "http://x/mcp", instant);
    expect(await herd.staleIssues()).toEqual([]);
  });

  test("foreground_processes is empty -> unknown, not stale", async () => {
    const cwd = join(workspaceRoot(), "KAN-783");
    const { client } = fakeHerdrWithCwd([{ name: "butchr-kan-783", pane_id: "w1:p1", cwd }], { "w1:p1": ok([]) });
    const herd = new HerdrHerd(client, "http://x/mcp", instant);
    expect(await herd.staleIssues()).toEqual([]);
  });

  test("no foreground process is a claude -> unknown, not stale", async () => {
    const cwd = join(workspaceRoot(), "KAN-783");
    const { client } = fakeHerdrWithCwd([{ name: "butchr-kan-783", pane_id: "w1:p1", cwd }], { "w1:p1": ok([{ pid: 1, argv: ["zsh"], name: "zsh" }]) });
    const herd = new HerdrHerd(client, "http://x/mcp", instant);
    expect(await herd.staleIssues()).toEqual([]);
  });

  test("the matched claude process reports no argv -> unknown, not stale", async () => {
    const cwd = join(workspaceRoot(), "KAN-783");
    const { client } = fakeHerdrWithCwd([{ name: "butchr-kan-783", pane_id: "w1:p1", cwd }], { "w1:p1": ok([{ pid: 1, argv: null, name: "claude" }]) });
    const herd = new HerdrHerd(client, "http://x/mcp", instant);
    expect(await herd.staleIssues()).toEqual([]);
  });

  test("KAN-816 measured storm: a stray bare `claude --resume` at the SAME cwd, outside this pane's own foreground list, never taints the verdict", async () => {
    // The exact shape measured live 2026-08-29 00:14 PDT on KAN-811: a stray
    // unnamed pane's bare `claude --resume` process shared a cwd with the
    // healthy named pane. The old /proc-by-cwd scan would find both and, with
    // both processes' parents non-claude, pick the lower pid — the stray —
    // and call the healthy pane stale. Nothing here ever looks at cwd-shared
    // processes outside the pane's OWN foreground list, so the stray is
    // structurally invisible to the verdict.
    const cwd = join(workspaceRoot(), "KAN-811");
    const goodArgv = ["claude", "follow your CLAUDE.md", "--model", "sonnet", "--permission-mode", "acceptEdits", "--mcp-config", `${cwd}/mcp.json`, "--dangerously-load-development-channels", "server:butchr"];
    const { client } = fakeHerdrWithCwd(
      [{ name: "butchr-kan-811", pane_id: "w1:p1", cwd }],
      // Only w1:p1 (the named, healthy pane) is ever queried — a stray pane
      // (e.g. w2K:p1) at the same cwd is not even a butchr-managed agent, so
      // byIssue() never surfaces it and staleIssues() never asks about it.
      { "w1:p1": ok([{ pid: 999999, argv: goodArgv, name: "claude" }]) },
    );
    const herd = new HerdrHerd(client, "http://x/mcp", instant);
    expect(await herd.staleIssues()).toEqual([]);
  });

  // FACTORY-118 Addendum A5: a rename must never happen under a live agent,
  // and a deploy that introduces short-leaf directories must not look like a
  // mass restart. This is the fleet-level version of the FACTORY-47/FACTORY-75
  // bar: a MIXED fleet — one agent still at its pre-ticket old-layout
  // (percent-encoded) directory, one already migrated to its new short-leaf
  // one — must be recognised STABLY across repeated polls by every one of
  // HerdrHerd's own live-agent queries. A regression here reads as "this
  // agent vanished" or "this agent is foreign" on some but not all polls —
  // exactly the FACTORY-47 class of bug (an infinite stop/respawn loop from a
  // decode mismatch), just triggered by a deploy that ships this ticket
  // instead of by a config edit.
  test("Addendum A5: one old-layout (unmigrated) agent and one new-layout (short-leaf, stamped) agent are BOTH recognised, by BOTH runningIssues() and staleIssues(), unchanged across 5+ consecutive polls", async () => {
    const { mkdtempSync, mkdirSync, rmSync } = require("node:fs") as typeof import("node:fs");
    const { tmpdir } = require("node:os") as typeof import("node:os");
    const previous = process.env.BUTCHR_WORKSPACES;
    const root = mkdtempSync(join(tmpdir(), "herd-mixed-fleet-"));
    process.env.BUTCHR_WORKSPACES = root;
    try {
      // Old-layout: a github-issue key at its pre-FACTORY-118 fully
      // percent-encoded three-deep leaf, built BY HAND (never through
      // ensureWorkspaceDir, which always computes the NEW short leaf) —
      // exactly what a real not-yet-migrated workspace looks like on disk.
      const oldKey = encodeAgentKey({ resourceProvider: "github-issue", ruleId: "bugs", resourceId: "acme/legacy#7" });
      const oldCwd = join(root, ...oldKey.split(":"));
      mkdirSync(oldCwd, { recursive: true });
      const oldArgv = ["claude", "follow your CLAUDE.md", "--model", "sonnet", "--permission-mode", "acceptEdits", "--mcp-config", `${oldCwd}/mcp.json`, "--dangerously-load-development-channels", "server:butchr"];

      // New-layout: a different github-issue key, already migrated (a real,
      // stamped ensureWorkspaceDir claim at its short leaf).
      const newKey = encodeAgentKey({ resourceProvider: "github-issue", ruleId: "bugs", resourceId: "acme/shiny#9" });
      const newCwd = ensureWorkspaceDir(newKey);
      expect(newCwd.endsWith("/github-issue/bugs/shiny#9")).toBe(true);
      const newArgv = ["claude", "follow your CLAUDE.md", "--model", "sonnet", "--permission-mode", "acceptEdits", "--mcp-config", `${newCwd}/mcp.json`, "--dangerously-load-development-channels", "server:butchr"];

      const { client } = fakeHerdrWithCwd(
        [{ pane_id: "w-old:p1", cwd: oldCwd }, { pane_id: "w-new:p1", cwd: newCwd }],
        { "w-old:p1": ok([{ pid: 1, argv: oldArgv, name: "claude" }]), "w-new:p1": ok([{ pid: 2, argv: newArgv, name: "claude" }]) },
      );
      const herd = new HerdrHerd(client, "http://x/mcp", instant);
      for (let poll = 0; poll < 5; poll++) {
        expect(await herd.runningIssues()).toEqual([oldKey, newKey]);
        expect(await herd.staleIssues()).toEqual([]); // both argvs already match — no false "changed config" either
      }
    } finally {
      if (previous === undefined) delete process.env.BUTCHR_WORKSPACES; else process.env.BUTCHR_WORKSPACES = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// BUTCHR-411: staleIssues() rebuilds its expected argv from key/provider/
// disabledMcpServers/resource alone (see herd.ts's own doc comment on
// spawnArgs' callers) — a rule's mcpServers bindings are invisible to that
// reconstruction unless the caller supplies `mcpBindingsOf`, the 9th
// constructor param. These tests are the ticket's own DoD line: a running
// agent whose argv matches the bound argv is not flagged, and one launched
// WITHOUT the binding is.
describe("staleIssues — mcpBindingsOf / MCP server bindings (BUTCHR-411)", () => {
  const instant = () => Promise.resolve();
  const mud = { name: "mud", type: "http" as const, url: "https://mud.example/mcp", channel: true };
  const issue = "jira-work:mud-rule:BUTCHR-1";
  const cwd = workspaceDirFor(issue);

  function fakeHerdrWithCwd(agents: Array<{ name?: string; pane_id: string; cwd?: string | null }>, argv: string[]) {
    const client = {
      agent: { list: async () => ({ agents }) },
      pane: { processInfo: async () => ({ process_info: { pane_id: "x", foreground_processes: [{ pid: 1, argv, name: "claude" }] } }) },
    };
    return client as any;
  }

  test("mcpBindingsOf omitted (default): a rule's binding is invisible, so an agent launched WITH it never reads as stale either — no fleet-wide respawn for callers that don't wire this seam", async () => {
    const argv = ["claude", ...spawnArgs({ key: issue, issuetype: "task", summary: "", parent: null, resource: "BUTCHR-1", mcpServers: [mud] }, cwd)];
    const client = fakeHerdrWithCwd([{ name: "n", pane_id: "p1", cwd }], argv);
    const herd = new HerdrHerd(client, "http://x/mcp", instant);
    expect(await herd.staleIssues()).toEqual([]);
  });

  test("mcpBindingsOf resolves the rule's bindings: an agent launched WITH the bound channel is not stale", async () => {
    const argv = ["claude", ...spawnArgs({ key: issue, issuetype: "task", summary: "", parent: null, resource: "BUTCHR-1", mcpServers: [mud] }, cwd)];
    const client = fakeHerdrWithCwd([{ name: "n", pane_id: "p1", cwd }], argv);
    const herd = new HerdrHerd(client, "http://x/mcp", instant, undefined, undefined, undefined, undefined, undefined, () => [mud]);
    expect(await herd.staleIssues()).toEqual([]);
  });

  test("mcpBindingsOf resolves the rule's bindings: an agent launched WITHOUT the binding IS stale, naming the missing channel", async () => {
    const argv = ["claude", ...spawnArgs({ key: issue, issuetype: "task", summary: "", parent: null, resource: "BUTCHR-1" }, cwd)]; // no binding at launch
    const client = fakeHerdrWithCwd([{ name: "n", pane_id: "p1", cwd }], argv);
    const herd = new HerdrHerd(client, "http://x/mcp", instant, undefined, undefined, undefined, undefined, undefined, () => [mud]);
    const stale = await herd.staleIssues();
    expect(stale.length).toBe(1);
    expect(stale[0]!.issue).toBe(issue);
    expect(stale[0]!.reason).toContain("--dangerously-load-development-channels server:mud");
  });

  test("a rule that never sets mcpServers (mcpBindingsOf returns undefined for it) is unaffected — byte-identical expected argv to pre-BUTCHR-411", async () => {
    const argv = ["claude", ...spawnArgs({ key: issue, issuetype: "task", summary: "", parent: null, resource: "BUTCHR-1" }, cwd)];
    const client = fakeHerdrWithCwd([{ name: "n", pane_id: "p1", cwd }], argv);
    const herd = new HerdrHerd(client, "http://x/mcp", instant, undefined, undefined, undefined, undefined, undefined, () => undefined);
    expect(await herd.staleIssues()).toEqual([]);
  });

  // Review finding, PR #387: a bound server's secret header value must
  // never surface in a StaleAgent's `reason` or `observedArgv` — both are
  // logged verbatim ([reconcile] .../onRespawn in src/daemon/index.ts) and
  // shown on the Jira ticket. Proven end to end through staleIssues() for a
  // Codex agent, since that's the only provider whose argv could ever have
  // carried a header value at all (Claude's argv never does).
  test("a Codex agent's stale reason/observedArgv never contain a bound server's secret header value, even when the daemon's own env holds one", async () => {
    process.env.BUTCHR_TEST_HERD_MUD_HEADERS = JSON.stringify({ Authorization: "Bearer SEKRET-TOKEN-VALUE" });
    try {
      const secretMud = { ...mud, headersEnvVar: "BUTCHR_TEST_HERD_MUD_HEADERS" };
      const codexArgvWithoutBinding = ["codex", ...spawnArgs({ key: issue, issuetype: "task", summary: "", parent: null, resource: "BUTCHR-1" }, cwd, { provider: "codex", disabledMcpServers: [] })];
      const client = fakeHerdrWithCwd([{ name: "n", pane_id: "p1", cwd }], codexArgvWithoutBinding);
      // Fake process reports as codex via its argv/name shape used elsewhere in this file's fakes.
      client.pane.processInfo = async () => ({ process_info: { pane_id: "x", foreground_processes: [{ pid: 1, argv: codexArgvWithoutBinding, name: "codex" }] } });
      // disabledMcpServers: [] (not undefined) so staleIssues() doesn't take
      // the separate "Codex MCP isolation inventory missing" early-out and
      // actually reaches the expected-vs-observed comparison this test needs.
      const herd = new HerdrHerd(client, "http://x/mcp", instant, undefined, { provider: "codex", disabledMcpServers: [] }, undefined, undefined, undefined, () => [secretMud]);
      const stale = await herd.staleIssues();
      expect(stale.length).toBe(1);
      expect(stale[0]!.reason).not.toContain("SEKRET-TOKEN-VALUE");
      expect(stale[0]!.observedArgv.join(" ")).not.toContain("SEKRET-TOKEN-VALUE");
      expect(stale[0]!.reason).not.toContain("Authorization");
    } finally { delete process.env.BUTCHR_TEST_HERD_MUD_HEADERS; }
  });

  // BUTCHR-413: `accountNameOf` (the 10th constructor param) must be
  // consulted by staleIssues()'s OWN reconstruction, not just by spawn() —
  // otherwise a Codex agent granted an account would be launched WITH its
  // accountHeader (spawn() injects it) but forever compared against an
  // expected argv built WITHOUT one (staleIssues() never asked), reading as
  // permanently stale and respawning every poll. Recomputing the SAME
  // deterministic value fresh at both call sites (never caching the
  // original spawn's spec) is what keeps them from ever disagreeing.
  test("accountNameOf: an agent launched WITH its account header is NOT flagged stale — the fleet-wide-respawn hazard this ticket must not reintroduce", async () => {
    const acctBinding = { name: "rocketr", type: "http" as const, url: "https://rocketr.example/mcp", channel: false, accountHeader: "x-rocketr-account" };
    const argv = ["codex", ...spawnArgs({ key: issue, issuetype: "task", summary: "", parent: null, resource: "BUTCHR-1", mcpServers: [acctBinding], rocketchatAccount: "butchr_acct_1" }, cwd, { provider: "codex", disabledMcpServers: [] }, "http://x/mcp")];
    const client = fakeHerdrWithCwd([{ name: "n", pane_id: "p1", cwd }], argv);
    client.pane.processInfo = async () => ({ process_info: { pane_id: "x", foreground_processes: [{ pid: 1, argv, name: "codex" }] } });
    const herd = new HerdrHerd(client, "http://x/mcp", instant, undefined, { provider: "codex", disabledMcpServers: [] }, undefined, undefined, undefined, () => [acctBinding], () => "butchr_acct_1");
    expect(await herd.staleIssues()).toEqual([]);
  });

  test("accountNameOf: an agent launched WITHOUT its account header (accountNameOf returned undefined at spawn time) IS stale once the agent gains an account", async () => {
    const acctBinding = { name: "rocketr", type: "http" as const, url: "https://rocketr.example/mcp", channel: false, accountHeader: "x-rocketr-account" };
    const argv = ["codex", ...spawnArgs({ key: issue, issuetype: "task", summary: "", parent: null, resource: "BUTCHR-1", mcpServers: [acctBinding] }, cwd, { provider: "codex", disabledMcpServers: [] }, "http://x/mcp")]; // no account at launch
    const client = fakeHerdrWithCwd([{ name: "n", pane_id: "p1", cwd }], argv);
    client.pane.processInfo = async () => ({ process_info: { pane_id: "x", foreground_processes: [{ pid: 1, argv, name: "codex" }] } });
    const herd = new HerdrHerd(client, "http://x/mcp", instant, undefined, { provider: "codex", disabledMcpServers: [] }, undefined, undefined, undefined, () => [acctBinding], () => "butchr_acct_1");
    const stale = await herd.staleIssues();
    expect(stale.length).toBe(1);
    expect(stale[0]!.reason).toContain("x-rocketr-account");
  });

  // Review round 3, blocking finding 2: an EARLIER version of `accountNameOf`
  // (src/daemon/index.ts) called `rcUsernameFor(id)` with no prefix,
  // silently assuming the DEFAULT managed prefix — wrong once BUTCHR-412's
  // configurable `Config.rocketchat.managedPrefix` names a NON-default one,
  // since `ensureAccount` (src/accounts/manager.ts) derives the REAL
  // provisioned username with THAT prefix. This proves the actual contract
  // `HerdrHerd` depends on: whatever prefix the injected `accountNameOf`
  // uses, `spawn()`'s Codex argv header and `staleIssues()`'s own
  // reconstruction always agree (same callback, same prefix) and the agent
  // is never respawned — the same property must hold for src/daemon/index.ts's
  // own `accountNameOf`, which threads `config.rocketchat?.managedPrefix`
  // into this exact `rcUsernameFor` call for exactly this reason.
  test("a NON-DEFAULT managedPrefix: the Codex argv header and staleIssues() both carry the SAME prefixed account name, and the agent is not respawned", async () => {
    const acctBinding = { name: "rocketr", type: "http" as const, url: "https://rocketr.example/mcp", channel: false, accountHeader: "x-rocketr-account" };
    const customPrefix = "acme_rc_";
    const provisionedName = rcUsernameFor(issue, customPrefix); // what ensureAccount would ACTUALLY have provisioned with this prefix configured
    expect(provisionedName.startsWith(customPrefix)).toBe(true);
    const accountNameOf = (id: string) => rcUsernameFor(id, customPrefix);
    const argv = ["codex", ...spawnArgs({ key: issue, issuetype: "task", summary: "", parent: null, resource: "BUTCHR-1", mcpServers: [acctBinding], rocketchatAccount: provisionedName }, cwd, { provider: "codex", disabledMcpServers: [] }, "http://x/mcp")];
    // Prove the argv actually carries the prefixed name, under this prefix — not the default one.
    expect(argv.join(" ")).toContain(provisionedName);
    expect(argv.join(" ")).not.toContain(rcUsernameFor(issue)); // the DEFAULT-prefix name never appears
    const client = fakeHerdrWithCwd([{ name: "n", pane_id: "p1", cwd }], argv);
    client.pane.processInfo = async () => ({ process_info: { pane_id: "x", foreground_processes: [{ pid: 1, argv, name: "codex" }] } });
    const herd = new HerdrHerd(client, "http://x/mcp", instant, undefined, { provider: "codex", disabledMcpServers: [] }, undefined, undefined, undefined, () => [acctBinding], accountNameOf);
    expect(await herd.staleIssues()).toEqual([]); // no respawn: staleIssues() derives the SAME prefixed name
  });
});

describe("HerdrHerd + reconcileNow: the argv-staleness headline case", () => {
  // The real workspace directory buildWorkspace() would use for KAN-783 —
  // the same one a herdr-reported agent cwd must match for the expected argv.
  const dir = join(workspaceRoot(), "KAN-783");
  const desired = new Map([["KAN-783", { key: "KAN-783", issuetype: "Task", summary: "s", parent: null }]]);

  function fakeHerdrStale(processInfo: (paneId: string) => Promise<{ process_info?: { pane_id: string; foreground_processes?: FakeProcess[] } }>) {
    let agents = [{ name: "butchr-kan-783", pane_id: "w1:p1", cwd: dir, agent: "claude" }];
    const started: any[] = []; const closed: string[] = [];
    const client = {
      agent: {
        list: async () => ({ agents }),
        start: async (p: any) => { started.push(p); agents = [...agents, { name: "butchr-kan-783", pane_id: "w9:p1", cwd: dir, agent: p.kind }]; },
      },
      // Closing a pane retires its agent — herdr's list no longer carries it,
      // exactly what makes spawn() (which no-ops when the name already
      // exists) actually start a fresh one on the stop-then-spawn respawn path.
      pane: {
        close: async (id: string) => { closed.push(id); agents = agents.filter((a) => a.pane_id !== id); },
        processInfo: (p: { pane_id: string }) => processInfo(p.pane_id),
      },
      workspace: { create: async () => ({ root_pane: { pane_id: "w9:p1" } }) },
    };
    return { client: client as any, started, closed };
  }
  const ok = (foreground_processes: FakeProcess[]) => async () => ({ process_info: { pane_id: "x", foreground_processes } });

  test("a) a stale pane (bare `claude --resume`) is closed and a fresh agent started with the full spawn argv; the [butchr:respawn] notice fires exactly once", async () => {
    const argv = ["claude", "--resume", "8e5164dc-c5d6-41b7-aa41-4a6143b818a5"];
    const f = fakeHerdrStale(ok([{ pid: 1, argv, name: "claude" }]));
    const herd = new HerdrHerd(f.client, "http://x/mcp", () => Promise.resolve());
    const notices: Array<{ issue: string; reason: string; observedArgv: string[] }> = [];
    await reconcileNow(herd, desired, { onRespawn: (issue, reason, observedArgv) => { notices.push({ issue, reason, observedArgv }); } });

    // a) pane closed AND a new agent started whose args equal the full spawn argv
    expect(f.closed).toEqual(["w1:p1"]);
    expect(f.started.length).toBe(1);
    expect(f.started[0].args[0]).toBe("follow your CLAUDE.md");
    expect(f.started[0].args).toContain("--permission-mode");
    expect(f.started[0].args).toContain("acceptEdits"); // FACTORY-138: no explicit permissionMode on the spec -> butchr's own default.
    expect(f.started[0].args[f.started[0].args.indexOf("--mcp-config") + 1]).toBe(dir + "/mcp.json");

    // b) the notice was posted exactly once and starts with [butchr:respawn]'s reason shape
    expect(notices.length).toBe(1);
    expect(notices[0]!.issue).toBe("KAN-783");
    expect(notices[0]!.reason.startsWith("argv lacks")).toBe(true);
    expect(notices[0]!.observedArgv).toEqual(argv);
  });

  test("b) a second pass, now with process-info showing the full argv, closes/starts nothing", async () => {
    const goodArgv = ["claude", "follow your CLAUDE.md", "--model", "sonnet", "--permission-mode", "acceptEdits", "--mcp-config", `${dir}/mcp.json`, "--dangerously-load-development-channels", "server:butchr"];
    const f = fakeHerdrStale(ok([{ pid: 1, argv: goodArgv, name: "claude" }]));
    const herd = new HerdrHerd(f.client, "http://x/mcp", () => Promise.resolve());
    const notices: unknown[] = [];
    await reconcileNow(herd, desired, { onRespawn: (...a) => { notices.push(a); } });
    expect(f.closed).toEqual([]);
    expect(f.started).toEqual([]);
    expect(notices).toEqual([]);
  });

  test("c) no claude in the pane's foreground closes/starts nothing (unknown, not stale)", async () => {
    const f = fakeHerdrStale(ok([]));
    const herd = new HerdrHerd(f.client, "http://x/mcp", () => Promise.resolve());
    const notices: unknown[] = [];
    await reconcileNow(herd, desired, { onRespawn: (...a) => { notices.push(a); } });
    expect(f.closed).toEqual([]);
    expect(f.started).toEqual([]);
    expect(notices).toEqual([]);
  });

  test("KAN-816 measured storm, end to end: a stray bare `claude --resume` sharing this issue's cwd but OUTSIDE its pane's own foreground list never causes a respawn — zero pane.close, zero agent.start, zero onRespawn", async () => {
    // The measured incident (2026-08-29 00:14 PDT, KAN-811): a stray unnamed
    // pane's bare `claude --resume` shared a cwd with the healthy named pane.
    // The retired /proc-by-cwd scan found both processes there and, with
    // neither's parent itself claude, picked the lower pid — the stray — and
    // called the healthy pane STALE, closing and respawning it every poll.
    // pane.process_info is scoped to ONE pane, so the stray (which lives on
    // some other, non-butchr-managed pane) is never even asked about here —
    // there is no cwd-based lookup left for it to pollute.
    const goodArgv = ["claude", "follow your CLAUDE.md", "--model", "sonnet", "--permission-mode", "acceptEdits", "--mcp-config", `${dir}/mcp.json`, "--dangerously-load-development-channels", "server:butchr"];
    const f = fakeHerdrStale(ok([{ pid: 999999, argv: goodArgv, name: "claude" }]));
    const herd = new HerdrHerd(f.client, "http://x/mcp", () => Promise.resolve());
    const notices: unknown[] = [];
    await reconcileNow(herd, desired, { onRespawn: (...a) => { notices.push(a); } });
    expect(f.closed).toEqual([]);
    expect(f.started).toEqual([]);
    expect(notices).toEqual([]);
  });

  describe("providerOf (BUTCHR-413)", () => {
    test("resolves the pane's own foreground provider for a running issue", async () => {
      const f = fakeHerdrStale(ok([{ pid: 1, argv: ["codex", "whatever"], name: "codex" }]));
      const herd = new HerdrHerd(f.client, "http://x/mcp", () => Promise.resolve());
      expect(await herd.providerOf("KAN-783")).toBe("codex");
    });

    test("null for an issue with no running agent", async () => {
      const f = fakeHerdrStale(ok([]));
      const herd = new HerdrHerd(f.client, "http://x/mcp", () => Promise.resolve());
      expect(await herd.providerOf("NOT-RUNNING")).toBeNull();
    });

    test("null when the pane's foreground has no recognisable provider process (unknown, not a guess)", async () => {
      const f = fakeHerdrStale(ok([]));
      const herd = new HerdrHerd(f.client, "http://x/mcp", () => Promise.resolve());
      expect(await herd.providerOf("KAN-783")).toBeNull();
    });
  });
});

// FACTORY-95 (implementing FACTORY-90, epic FACTORY-83): a spawned agent's
// herdr workspace label is its short display id (`resolveDisplayLabels`,
// src/rules/display-label.ts), collision-safe against every OTHER
// currently-running agent — never the bare `spec.key` (this ticket's own
// change), and the full agent key is preserved in herdr metadata.
describe("spawn wiring: short display id as the herdr label (FACTORY-95)", () => {
  test("an ordinary rule-engine spawn labels its workspace \"<shortId> · <ruleId>\", not the bare key", async () => {
    const f = fakeHerdr([]);
    const herd = new HerdrHerd(f.client, "http://x/mcp", instant);
    const key = encodeAgentKey({ resourceProvider: "jira-work", ruleId: "jira-work", resourceId: "FACTORY-51" });
    await herd.spawn({ key, issuetype: "Task", summary: "s", parent: null });
    expect(f.creates[0].label).toBe("FACTORY-51 · jira-work");
  });

  test("a legacy/bare key (no rule-engine encoding) still labels as itself — unchanged, pre-FACTORY-95 behaviour", async () => {
    const f = fakeHerdr([]);
    const herd = new HerdrHerd(f.client, "http://x/mcp", instant);
    await herd.spawn({ key: "KAN-7", issuetype: "Task", summary: "s", parent: null });
    expect(f.creates[0].label).toBe("KAN-7");
  });

  // FACTORY-95 review fix (round 1): no two LIVE workspaces may ever share a
  // label, in EITHER sort order — not just the case where the incoming key
  // happens to sort after the running one. `resolveDisplayLabels`'s
  // tie-break (the lexicographically smallest key of a colliding group)
  // does not care which key is "new"; when the incoming key sorts BEFORE an
  // already-running colliding key, the running workspace's OWN label must
  // be fixed up too, right now — not left to share the incoming spawn's
  // bare label until the next `relabelOwnedWorkspaces()` restart pass.
  test("spawning a colliding key that sorts AFTER an already-running one: the new workspace is suffixed, the running one keeps its bare label (reasserted, not left stale)", async () => {
    const previous = process.env.BUTCHR_WORKSPACES;
    const root = mkdtempSync(join(tmpdir(), "herd-collide-after-"));
    process.env.BUTCHR_WORKSPACES = root;
    try {
      // Same "<parent>:<name>" (brooswit-factory:rinth) under two different roots — the exact FACTORY-90 collision example.
      const running = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "repos", resourceId: absPath("home", "one", "brooswit-factory", "rinth") });
      const incoming = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "repos", resourceId: absPath("srv", "two", "brooswit-factory", "rinth") });
      expect(incoming > running).toBe(true); // pins the ordering this test relies on
      // `ensureWorkspaceDir`, not a bare `workspaceDirFor` string: a real
      // already-running agent's workspace is always claimed+stamped on disk
      // (FACTORY-118) — that stamp is what lets `agentIdOfWorkspacePath`
      // resolve this fake pane's cwd back to `running` at all, and what lets
      // `incoming`'s own `newLayoutDirFor` recognise the bare short name as
      // occupied by a DIFFERENT key and correctly suffix itself.
      const runningCwd = ensureWorkspaceDir(running);
      const f = fakeHerdr([{ pane_id: "p-running", cwd: runningCwd, workspace_id: "w-running" }]);
      const herd = new HerdrHerd(f.client, "http://x/mcp", instant);
      await herd.spawn({ key: incoming, issuetype: "Task", summary: "s", parent: null });
      expect(f.creates[0].label).toMatch(/^brooswit-factory:rinth · repos-[0-9a-f]{6}$/);
      // `labelFor` unconditionally reasserts every OTHER member of the group's own
      // correct label whenever the group has more than one member — cheap, idempotent,
      // and never relies on knowing whether herdr's own stored value already agrees.
      expect(f.renamed).toEqual([{ workspace_id: "w-running", label: "brooswit-factory:rinth · repos" }]);
      expect(f.creates[0].label).not.toBe(f.renamed[0]?.label); // the one invariant that matters: never shared
    } finally {
      if (previous === undefined) delete process.env.BUTCHR_WORKSPACES; else process.env.BUTCHR_WORKSPACES = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("spawning a colliding key that sorts BEFORE an already-running one: the new workspace gets the bare label AND the running workspace is relabeled to the suffix, so the two never share a label", async () => {
    const previous = process.env.BUTCHR_WORKSPACES;
    const root = mkdtempSync(join(tmpdir(), "herd-collide-before-"));
    process.env.BUTCHR_WORKSPACES = root;
    try {
      const running = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "repos", resourceId: absPath("srv", "two", "brooswit-factory", "rinth") });
      const incoming = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "repos", resourceId: absPath("home", "one", "brooswit-factory", "rinth") });
      expect(incoming < running).toBe(true); // pins the ordering this test relies on — the reverse of the case above
      const runningCwd = ensureWorkspaceDir(running); // see the sibling test above for why this must be a real, stamped claim
      const f = fakeHerdr([{ pane_id: "p-running", cwd: runningCwd, workspace_id: "w-running" }]);
      const herd = new HerdrHerd(f.client, "http://x/mcp", instant);
      await herd.spawn({ key: incoming, issuetype: "Task", summary: "s", parent: null });
      expect(f.creates[0].label).toBe("brooswit-factory:rinth · repos");
      // The already-running sibling must be relabeled to the suffix RIGHT NOW — not left bare until a later restart.
      expect(f.renamed).toHaveLength(1);
      expect(f.renamed[0]).toMatchObject({ workspace_id: "w-running" });
      expect(f.renamed[0]?.label).toMatch(/^brooswit-factory:rinth · repos-[0-9a-f]{6}$/);
      expect(f.metadata.find((m) => m.workspace_id === "w-running")).toEqual({ workspace_id: "w-running", source: "butchr", tokens: { agentKey: running } });
      // The one invariant that matters: no two live workspaces ever share a label.
      expect(f.creates[0].label).not.toBe(f.renamed[0]?.label);
    } finally {
      if (previous === undefined) delete process.env.BUTCHR_WORKSPACES; else process.env.BUTCHR_WORKSPACES = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a successful spawn preserves the full agent key in herdr metadata, keyed by the started workspace id", async () => {
    const f = fakeHerdr([]);
    const herd = new HerdrHerd(f.client, "http://x/mcp", instant);
    const key = encodeAgentKey({ resourceProvider: "jira-work", ruleId: "jira-work", resourceId: "FACTORY-51" });
    await herd.spawn({ key, issuetype: "Task", summary: "s", parent: null });
    expect(f.metadata).toEqual([{ workspace_id: "w9", source: "butchr", tokens: { agentKey: key } }]);
  });

  test("a failed spawn reports no metadata at all", async () => {
    const f = {
      agent: { list: async () => ({ agents: [] }), start: async () => { throw new Error("boom"); } },
      workspace: { create: async () => ({ root_pane: "wX:p1" }), reportMetadata: async (p: any) => { metadata.push(p); } },
      pane: { close: async () => {} },
    };
    const metadata: any[] = [];
    const herd = new HerdrHerd(f as any, "http://x/mcp", instant);
    await expect(herd.spawn({ key: "KAN-9", issuetype: "Task", summary: "s", parent: null })).rejects.toThrow("boom");
    expect(metadata).toEqual([]);
  });
});

// FACTORY-95: relabelling already-running workspaces in place, without an
// agent restart — `HerdrHerd.relabelOwnedWorkspaces`, today's only caller
// being daemon startup (src/daemon/index.ts).
describe("relabelOwnedWorkspaces (FACTORY-95: relabel running workspaces in place)", () => {
  test("renames every owned running workspace to its short display label and reports its full key as metadata", async () => {
    const keyA = encodeAgentKey({ resourceProvider: "jira-work", ruleId: "jira-work", resourceId: "FACTORY-51" });
    const keyB = encodeQueryAgentKey({ resourceProvider: "github-issue", ruleId: "triage" });
    const f = fakeHerdr([
      { pane_id: "p1", cwd: workspaceDirFor(keyA), workspace_id: "wA" },
      { pane_id: "p2", cwd: workspaceDirFor(keyB), workspace_id: "wB" },
    ]);
    const herd = new HerdrHerd(f.client, "http://x/mcp", instant);
    await herd.relabelOwnedWorkspaces();
    const renameFor = (workspaceId: string) => f.renamed.find((r) => r.workspace_id === workspaceId)?.label;
    expect(renameFor("wA")).toBe("FACTORY-51 · jira-work");
    expect(renameFor("wB")).toBe("triage");
    const metadataFor = (workspaceId: string) => f.metadata.find((m) => m.workspace_id === workspaceId);
    expect(metadataFor("wA")).toEqual({ workspace_id: "wA", source: "butchr", tokens: { agentKey: keyA } });
    expect(metadataFor("wB")).toEqual({ workspace_id: "wB", source: "butchr", tokens: { agentKey: keyB } });
  });

  test("never touches a workspace whose pane cwd is NOT butchr's own (ownership proven via cwd, never via herdr's current label)", async () => {
    const f = fakeHerdr([{ pane_id: "p1", cwd: absPath("home", "someone", "unrelated-project"), workspace_id: "wX" }]);
    const herd = new HerdrHerd(f.client, "http://x/mcp", instant);
    await herd.relabelOwnedWorkspaces();
    expect(f.renamed).toEqual([]);
    expect(f.metadata).toEqual([]);
  });

  test("disambiguates a collision across two owned workspaces the same way spawn-time collision resolution would (same agent -> same label both ways)", async () => {
    const previous = process.env.BUTCHR_WORKSPACES;
    const root = mkdtempSync(join(tmpdir(), "herd-relabel-collide-"));
    process.env.BUTCHR_WORKSPACES = root;
    try {
      const a = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "repos", resourceId: absPath("home", "one", "brooswit-factory", "rinth") });
      const b = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "repos", resourceId: absPath("srv", "two", "brooswit-factory", "rinth") });
      // Real, stamped claims (FACTORY-118) — see the spawn-time collision
      // tests above for why a bare `workspaceDirFor` string here would leave
      // `agentIdOfWorkspacePath` unable to resolve either fake pane's cwd
      // back to its key at all.
      const f = fakeHerdr([
        { pane_id: "p1", cwd: ensureWorkspaceDir(a), workspace_id: "wA" },
        { pane_id: "p2", cwd: ensureWorkspaceDir(b), workspace_id: "wB" },
      ]);
      const herd = new HerdrHerd(f.client, "http://x/mcp", instant);
      await herd.relabelOwnedWorkspaces();
      const renameFor = (workspaceId: string) => f.renamed.find((r) => r.workspace_id === workspaceId)?.label;
      const labels = [renameFor("wA"), renameFor("wB")];
      expect(new Set(labels).size).toBe(2); // never shared
      expect(labels).toContain("brooswit-factory:rinth · repos"); // one keeps the bare label
      expect(labels.find((l) => l !== "brooswit-factory:rinth · repos")).toMatch(/^brooswit-factory:rinth · repos-[0-9a-f]{6}$/);
    } finally {
      if (previous === undefined) delete process.env.BUTCHR_WORKSPACES; else process.env.BUTCHR_WORKSPACES = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("idempotent: calling it twice renames to the same labels both times", async () => {
    const key = encodeAgentKey({ resourceProvider: "jira-work", ruleId: "jira-work", resourceId: "FACTORY-51" });
    const f = fakeHerdr([{ pane_id: "p1", cwd: workspaceDirFor(key), workspace_id: "wA" }]);
    const herd = new HerdrHerd(f.client, "http://x/mcp", instant);
    await herd.relabelOwnedWorkspaces();
    await herd.relabelOwnedWorkspaces();
    expect(f.renamed.map((r) => r.label)).toEqual(["FACTORY-51 · jira-work", "FACTORY-51 · jira-work"]);
  });

  test("never throws when herdr itself is unreachable — logged and swallowed, like reap.ts's own detector", async () => {
    const f = { agent: { list: async () => { throw new Error("herdr socket closed"); } }, workspace: {}, pane: {} };
    const lines: string[] = [];
    const herd = new HerdrHerd(f as any, "http://x/mcp", instant, (l) => lines.push(l));
    await expect(herd.relabelOwnedWorkspaces()).resolves.toBeUndefined();
    expect(lines.some((l) => l.includes("WARNING: [relabel]"))).toBe(true);
  });

  test("one workspace's own rename failure never blocks the others", async () => {
    const good = encodeAgentKey({ resourceProvider: "jira-work", ruleId: "jira-work", resourceId: "FACTORY-1" });
    const bad = encodeAgentKey({ resourceProvider: "jira-work", ruleId: "jira-work", resourceId: "FACTORY-2" });
    const renamed: any[] = [];
    const f = {
      agent: { list: async () => ({ agents: [
        { pane_id: "p1", cwd: workspaceDirFor(good), workspace_id: "w-good" },
        { pane_id: "p2", cwd: workspaceDirFor(bad), workspace_id: "w-bad" },
      ] }) },
      workspace: {
        rename: async (p: any) => { if (p.workspace_id === "w-bad") throw new Error("rename rejected"); renamed.push(p); },
        reportMetadata: async () => {},
      },
      pane: {},
    };
    const lines: string[] = [];
    const herd = new HerdrHerd(f as any, "http://x/mcp", instant, (l) => lines.push(l));
    await herd.relabelOwnedWorkspaces();
    expect(renamed).toEqual([{ workspace_id: "w-good", label: "FACTORY-1 · jira-work" }]);
    expect(lines.some((l) => l.includes(`WARNING: [relabel] ${bad}`))).toBe(true);
  });
});

// FACTORY-411/FACTORY-424 (classification doc, Finding 2, point 3): a
// deliberate ALLOWLIST, never a blanket "any checkArgv failure is
// resumable". Exercises the pure classifier directly — the integration path
// (a real staleIssues()/resumeInPlace() round trip) is covered separately in
// the "resumeInPlace" describe block below.
describe("resumableArgvReason", () => {
  const claudeCases: Array<[string, boolean]> = [
    ["argv lacks --permission-mode bypassPermissions", true],
    ["argv lacks --strict-mcp-config", true],
    ["argv lacks --dangerously-load-development-channels server:x server:y", true],
    // Combined — still every piece within the allowed set.
    ["argv lacks --permission-mode bypassPermissions, --strict-mcp-config", true],
    // A REQUIRED_CLAUDE_FLAGS member this ticket did NOT verify --resume
    // against (the --mcp-config VALUE itself, e.g. a changed mcpUrl) —
    // never allowed, alone or mixed with an allowed flag.
    ["argv lacks --mcp-config http://new/mcp", false],
    ["argv lacks --permission-mode bypassPermissions, --mcp-config http://new/mcp", false],
    // The freeform-jira-project shape — a different AgentConfig entirely, never verified.
    ["argv lacks --dangerously-bypass-approvals-and-sandbox", false],
    ["argv lacks --cd /some/path", false],
    // Not even a checkArgv-shaped reason (e.g. the Codex MCP isolation push site's own text).
    ["Codex MCP isolation inventory missing", false],
  ];
  for (const [reason, expected] of claudeCases) {
    test(`claude, "${reason}" -> ${expected}`, () => {
      expect(resumableArgvReason(reason, "claude")).toBe(expected);
    });
  }
  test("never true for a non-Claude provider, even for an otherwise-allowed reason", () => {
    expect(resumableArgvReason("argv lacks --permission-mode bypassPermissions", "codex")).toBe(false);
    expect(resumableArgvReason("argv lacks --strict-mcp-config", "agy")).toBe(false);
  });
});

// FACTORY-411/FACTORY-424 (PR #541 review, item 4): `staleArgvOutcome` is
// the exact function `staleIssues()`'s own checkArgv-failure push site
// calls — see its own doc comment for why this is tested directly rather
// than through a full `staleIssues()` fixture (today's non-Claude argv
// shapes never actually produce one of these three flags in `expected`, so
// a `staleIssues()`-level fixture for this specific rewrite would be
// unreachable/synthetic; this is the real code path, exercised directly).
describe("staleArgvOutcome", () => {
  test("a Claude-resumable reason passes through unchanged, resumable: true", () => {
    expect(staleArgvOutcome("argv lacks --permission-mode bypassPermissions", "claude")).toEqual({
      reason: "argv lacks --permission-mode bypassPermissions",
      resumable: true,
    });
  });
  test("a non-candidate reason (even on Claude) passes through unchanged, resumable: false", () => {
    expect(staleArgvOutcome("argv lacks --mcp-config http://new/mcp", "claude")).toEqual({
      reason: "argv lacks --mcp-config http://new/mcp",
      resumable: false,
    });
  });
  test("a non-candidate reason on a non-Claude provider passes through unchanged, resumable: false — no Claude-only rewrite for a reason that was never a candidate", () => {
    expect(staleArgvOutcome("Codex MCP isolation inventory missing", "codex")).toEqual({
      reason: "Codex MCP isolation inventory missing",
      resumable: false,
    });
  });
  // The case PR #541's review specifically asked for: a non-Claude provider
  // whose drift IS confined to one of the three candidate fields gets the
  // explicit "stated limitation" rewrite, never the bare argv diff.
  test("a Claude-candidate reason on a non-Claude provider is rewritten to state the Claude-only limitation explicitly, resumable: false", () => {
    const { reason, resumable } = staleArgvOutcome("argv lacks --strict-mcp-config", "codex");
    expect(resumable).toBe(false);
    expect(reason).not.toContain("argv lacks"); // never the bare argv diff for this case
    expect(reason).toContain("session lost");
    expect(reason).toContain("--strict-mcp-config");
    expect(reason).toContain("Claude-only");
    expect(reason).toContain("codex"); // names the actual provider, not a generic "not Claude"
  });
  test("same rewrite for a combined candidate reason (permission-mode + development-channels) on a non-Claude provider", () => {
    const { reason, resumable } = staleArgvOutcome("argv lacks --permission-mode bypassPermissions, --dangerously-load-development-channels server:x", "agy");
    expect(resumable).toBe(false);
    expect(reason).not.toContain("argv lacks");
    expect(reason).toContain("session lost");
    expect(reason).toContain("--permission-mode bypassPermissions");
    expect(reason).toContain("--dangerously-load-development-channels server:x");
  });
});

// FACTORY-470/472: the identity check that classifies a herdr-restored
// pane (herdr's OWN restore after a host hard reset — a bare
// `claude --resume <pre-boot-session-id>`, none of butchr's flags)
// as resumable via the SAME full-flag `resumeInPlace()` path, WITHOUT
// widening FACTORY-411/#556's flag-diff allowlist and without a new
// field-by-field staleness classifier — see `isHerdrRestoredPane`'s own
// doc comment (src/agents/herd.ts) for the full reasoning.
describe("isHerdrRestoredPane", () => {
  test("true: the pane's own --resume value matches the persisted session id", () => {
    expect(isHerdrRestoredPane(["claude", "--resume", "abc-123"], "abc-123")).toBe(true);
  });
  test("false: no persisted session id at all (never discovered, or invalidated by FACTORY-418)", () => {
    expect(isHerdrRestoredPane(["claude", "--resume", "abc-123"], undefined)).toBe(false);
  });
  test("false: the pane's --resume value names a DIFFERENT session than the one persisted", () => {
    expect(isHerdrRestoredPane(["claude", "--resume", "some-other-id"], "abc-123")).toBe(false);
  });
  test("false: no --resume flag in argv at all (an ordinary fresh-spawned agent, not herdr-restored)", () => {
    expect(isHerdrRestoredPane(["claude", "--permission-mode", "acceptEdits"], "abc-123")).toBe(false);
  });
  // PR #560 review: the --resume match alone is not enough — a pane butchr
  // ITSELF relaunched via resumeInPlace() also carries --resume <persisted
  // id> forever afterward. Without the --mcp-config discriminator, any
  // LATER unrelated drift on that already-`--resume`d pane would be
  // misclassified "herdr restored" instead of going through the ordinary
  // allowlist path — silently widening resume-in-place to other
  // definition-change cases, which this ticket's scope excludes.
  test("false: --resume matches, but --mcp-config IS present — a pane butchr itself already relaunched, not a herdr restore", () => {
    expect(isHerdrRestoredPane(["claude", "--resume", "abc-123", "--mcp-config", "/some/mcp.json", "--permission-mode", "acceptEdits"], "abc-123")).toBe(false);
  });
  // FACTORY-491 (director item 4): the discriminator must require ALL
  // THREE of butchr's own launch flags absent — narrower than PR #560's
  // original single-flag (--mcp-config) check, which a pane missing only
  // --mcp-config but still carrying --permission-mode or the channels flag
  // would have incorrectly passed.
  test("false: --resume matches and --mcp-config is absent, but --permission-mode IS present — not every butchr flag is missing", () => {
    expect(isHerdrRestoredPane(["claude", "--resume", "abc-123", "--permission-mode", "acceptEdits"], "abc-123")).toBe(false);
  });
  test("false: --resume matches and --mcp-config is absent, but --dangerously-load-development-channels IS present — not every butchr flag is missing", () => {
    expect(isHerdrRestoredPane(["claude", "--resume", "abc-123", "--dangerously-load-development-channels", "server:x"], "abc-123")).toBe(false);
  });
  test("true: --resume matches and ALL THREE butchr flags are absent", () => {
    expect(isHerdrRestoredPane(["claude", "--resume", "abc-123", "--model", "haiku"], "abc-123")).toBe(true);
  });
  // FACTORY-491 (director item 1): defensive hardening for forms herdr's
  // OWN measured restore shape (FACTORY-467 comment 27815:
  // `["claude", "--resume", "<id>", "--model", "haiku"]`, the separate-
  // argument form the pre-existing indexOf+1 match already handled) does
  // not presently produce — never a fix for a live break, sequenced by
  // convenience rather than urgency (epic comment 27818).
  test("true: the --resume=<id> form", () => {
    expect(isHerdrRestoredPane(["claude", "--resume=abc-123", "--model", "haiku"], "abc-123")).toBe(true);
  });
  test("true: the short -r <id> form", () => {
    expect(isHerdrRestoredPane(["claude", "-r", "abc-123", "--model", "haiku"], "abc-123")).toBe(true);
  });
  test("true: the short -r=<id> form", () => {
    expect(isHerdrRestoredPane(["claude", "-r=abc-123", "--model", "haiku"], "abc-123")).toBe(true);
  });
  test("false: the --resume=<id> form names a DIFFERENT session than the one persisted", () => {
    expect(isHerdrRestoredPane(["claude", "--resume=some-other-id"], "abc-123")).toBe(false);
  });
});

describe("restoredResumeEnabledFor", () => {
  test("off never enables it, regardless of agent name", () => {
    expect(restoredResumeEnabledFor("off", "buddy")).toBe(false);
    expect(restoredResumeEnabledFor("off", undefined)).toBe(false);
  });
  test("all enables it for every agent, including one with no name at all", () => {
    expect(restoredResumeEnabledFor("all", "buddy")).toBe(true);
    expect(restoredResumeEnabledFor("all", "anything-else")).toBe(true);
    expect(restoredResumeEnabledFor("all", undefined)).toBe(true);
  });
  test("a named list enables it only for a listed name", () => {
    const policy = new Set(["buddy", "genius"]);
    expect(restoredResumeEnabledFor(policy, "buddy")).toBe(true);
    expect(restoredResumeEnabledFor(policy, "genius")).toBe(true);
    expect(restoredResumeEnabledFor(policy, "someone-else")).toBe(false);
  });
  test("a named list never enables it for an agent with no name (an ordinary rule-engine agent, not a managed session)", () => {
    expect(restoredResumeEnabledFor(new Set(["buddy", "genius"]), undefined)).toBe(false);
  });
});

describe("resumeInPlace", () => {
  const instant = () => Promise.resolve();
  const CLAUDE_PROC = { pid: 1, argv: ["claude"], name: "claude" };
  const SHELL_PROC = { pid: 2, argv: ["/usr/bin/fish"], name: "fish" };

  /**
   * A STATEFUL fake herdr for `resumeInPlace`'s own multi-step protocol —
   * unlike `fakeHerdrWithCwd` above (fixed canned responses), this one's
   * `agent.list`/`pane.processInfo` reflect a foreground that actually
   * changes when `pane.sendKeys` (the `/exit`) and `agent.start` (the
   * relaunch) are called, the same way a real pane would.
   */
  function statefulHerdr(pane: string, cwd: string, initialStatus: "idle" | "working" | "done" = "idle", options: { crashesOnStart?: boolean; nameTaken?: boolean; launchPending?: boolean; processGone?: boolean } = {}) {
    let status: string = initialStatus;
    let foreground: "claude" | "shell" = "claude";
    // FACTORY-314 (epic review on PR #513, point 3): the REAL argv from the
    // most recent `agent.start`, not the fixed `CLAUDE_PROC` stub — needed
    // by the multi-poll `staleIssues()` regression test below, which must
    // see the ACTUAL resumed argv (carrying `--resume`, never `--session-id`)
    // to prove the FACTORY-43 two-shape symmetry holds for real, not just
    // in the isolated `agentStartParams` builder tests.
    let lastArgv: string[] = CLAUDE_PROC.argv;
    const sent: Array<{ text?: string; keys?: string[] }> = [];
    const started: any[] = [];
    const closed: string[] = [];
    const client = {
      agent: {
        // FACTORY-491 (director evidence, FACTORY-467 comment 27770/27774,
        // measured by admin-assembly on real codey): a bare-shell pane's
        // entry is ABSENT from herdr's agent.list — not present with
        // `agent: undefined`. This fixture previously listed it with
        // `agent: undefined` while keeping the entry, which is what
        // produced the review's own withdrawn "state 3" prediction; fixed
        // to match reality.
        list: async () => ({ agents: foreground === "claude" ? [{ agent: "claude", agent_status: status, cwd, pane_id: pane, workspace_id: "w1", launch_pending: options.launchPending === true }] : [] }),
        start: async (p: any) => {
          started.push(p);
          // FACTORY-314 (PR #513 review fix, live-tested): the OLD process
          // can still hold the agent name in herdr's own bookkeeping for a
          // moment even after this fake's OWN foreground already reports
          // "shell" — simulates that exact measured race.
          if (options.nameTaken) throw HerdrError.from("agent.start", { code: "agent_name_taken", message: "agent name already used" });
          // An unavailable model (or any other immediate failure) accepts
          // the launch but exits straight back to a shell — never reaching "idle".
          if (options.crashesOnStart) { foreground = "shell"; return; }
          lastArgv = ["claude", ...(p.args ?? [])];
          foreground = "claude"; status = "idle";
        },
      },
      pane: {
        // FACTORY-489: `processGone` decouples processInfo from `foreground`
        // — herdr's agent.list() bookkeeping can still list a pane as
        // launch-pending claude for a moment after its actual OS process has
        // already died; this simulates exactly that lag, independent of
        // whatever `list()` above still reports.
        processInfo: async () => ({ process_info: { pane_id: pane, foreground_processes: options.processGone ? [] : [foreground === "claude" ? { ...CLAUDE_PROC, argv: lastArgv } : SHELL_PROC] } }),
        sendText: async (p: any) => { sent.push({ text: p.text }); },
        sendKeys: async (p: any) => { sent.push({ keys: p.keys }); foreground = "shell"; },
        // FACTORY-491 (director item 3): records every defensive close so
        // tests can assert `resumeInPlaceExclusive`'s own "failed" paths
        // close the pane by id directly, independent of `herd.stop()`'s
        // separate identity-matched close.
        close: async (id: string) => { closed.push(id); },
      },
    };
    return { client: client as any, sent, started, closed };
  }

  async function withTempWorkspaces<T>(fn: () => Promise<T>): Promise<T> {
    const { mkdtempSync, rmSync } = require("node:fs") as typeof import("node:fs");
    const { tmpdir } = require("node:os") as typeof import("node:os");
    const previous = process.env.BUTCHR_WORKSPACES;
    const root = mkdtempSync(join(tmpdir(), "herd-resume-"));
    process.env.BUTCHR_WORKSPACES = root;
    try { return await fn(); }
    finally {
      if (previous === undefined) delete process.env.BUTCHR_WORKSPACES; else process.env.BUTCHR_WORKSPACES = previous;
      rmSync(root, { recursive: true, force: true });
    }
  }

  /**
   * FACTORY-314 (PR #513 review fix): `resumeInPlace()` now verifies a real
   * Claude transcript exists for the persisted session id BEFORE doing
   * anything else — so every test past "no persisted id at all" needs a
   * fake `~/.claude/projects/<encoded-cwd>/<id>.jsonl` under a CONTROLLED
   * home directory, never the real one. `persistDiscoveredSessionId` writes
   * the SAME `.butchr-session-id.json` `HerdrHerd.startProviders` itself
   * would have written after discovering it post-launch.
   *
   * FACTORY-631/FACTORY-623/FACTORY-568 hardening: at least one caller
   * (the "FACTORY-314 (epic review, round 3)" test below) immediately
   * follows this with a REAL `herd.spawn()`, whose own `launchStartedAt =
   * Date.now()` (`HerdrHerd.startProviders`) is what `discoverClaudeSessionId`
   * filters this very transcript against. Relying on plain wall-clock
   * ordering between the write just below and that later `Date.now()` call
   * risks landing in the SAME millisecond — exactly the "created >= after
   * compares true on a sub-ms birthtime vs a whole-ms `after`" hazard
   * `discoverClaudeSessionId`'s own doc comment now documents (its fixed
   * `AFTER_MARGIN_MS` bound needs the write to be in a STRICTLY EARLIER
   * millisecond, not merely "earlier" by some fraction). A real, awaited
   * delay here is the only thing that actually moves the value the filter
   * reads (`birthtimeMs`, immutable once written — `utimesSync` cannot
   * touch it, see the FACTORY-418 test's own hardening a few lines below
   * for where that was tried and measured ineffective) — comfortably larger
   * than any CI scheduler jitter this suite has measured (~2ms in the full
   * suite), without being large enough to slow the suite down meaningfully.
   */
  async function withResumableSession<T>(cwd: string, id: string, fn: (home: string) => Promise<T>): Promise<T> {
    const { mkdtempSync, rmSync, mkdirSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
    const { tmpdir } = require("node:os") as typeof import("node:os");
    const { resolve } = require("node:path") as typeof import("node:path");
    const home = mkdtempSync(join(tmpdir(), "claude-home-"));
    try {
      const projectDir = join(home, ".claude", "projects", resolve(cwd).replace(/[^a-zA-Z0-9]/g, "-"));
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(join(projectDir, `${id}.jsonl`), "{}");
      persistDiscoveredSessionId(cwd, id);
      await new Promise((r) => setTimeout(r, 50)); // see doc comment above — a real gap, not a retry or a fix for the production bound
      return await fn(home);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }

  /** `prepareWorkspace` override (7th HerdrHerd constructor arg) so `resumeInPlace()`'s transcript check looks under the CONTROLLED test home. */
  const homeOf = (home: string) => async () => ({ HOME: home });

  test("resumed: an idle agent exits, relaunches on the SAME pane with --resume, the new model/effort, and the full flag set; the persisted session id is unchanged", async () => {
    await withTempWorkspaces(async () => {
      const key = encodeAgentKey({ resourceProvider: "jira-work", ruleId: "jira-work", resourceId: "FACTORY-900" });
      const cwd = workspaceDirFor(key);
      const spec = { key, issuetype: "Task", summary: "s", parent: null, agents: [{ harness: "claude" as const, model: "claude-opus-5", effort: "medium" as const }] };
      await withResumableSession(cwd, "original-session", async (home) => {
        const f = statefulHerdr("w1:p1", cwd);
        const herd = new HerdrHerd(f.client, "http://x/mcp", instant, undefined, undefined, undefined, homeOf(home));
        const outcome = await herd.resumeInPlace(spec);
        expect(outcome).toBe("resumed");
        expect(f.sent).toEqual([{ text: "/exit" }, { keys: ["enter"] }]);
        expect(f.started).toHaveLength(1);
        const args: string[] = f.started[0]!.args;
        expect(args[args.indexOf("--resume") + 1]).toBe("original-session");
        expect(args).toEqual(expect.arrayContaining(["--model", "claude-opus-5", "--effort", "medium", "--permission-mode", DEFAULT_PERMISSION_MODE]));
        expect(f.started[0]!.pane_id).toBe("w1:p1"); // SAME pane — never a new one
        expect(workspaceSessionId(cwd)).toBe("original-session"); // a --resume relaunch keeps the SAME id, never rediscovered
        expect(workspaceModel(cwd)).toBe("claude-opus-5"); // re-persisted, confirmed only AFTER the relaunch succeeded
        expect(workspaceEffort(cwd)).toBe("medium");
      });
    });
  });

  // FACTORY-489 (FACTORY-312, source read of herdr at the running version's
  // tag, not a live measurement): agent_status is computed from screen state
  // independently of the managed-agent launch phase, so a pane whose claude
  // launch is still pending can report agent_status "idle"/"done" — a state
  // `isIdle()` alone would treat as ready to `/exit`. `launchPending` is the
  // one signal that distinguishes it. This pair must be able to fail for
  // the reason it tests and no other: (a) proves the guard actually blocks
  // /exit when launch_pending is true even though agent_status says idle;
  // (b) proves the SAME fixture/spec, with only launch_pending flipped to
  // false, is NOT blocked — so (a) passing isn't just an artifact of some
  // OTHER gate (missing session id, wrong provider, etc.) misfiring.
  test("deferred: a launch-pending pane reporting agent_status idle is NOT resumed — no /exit is sent", async () => {
    await withTempWorkspaces(async () => {
      const key = encodeAgentKey({ resourceProvider: "jira-work", ruleId: "jira-work", resourceId: "FACTORY-901" });
      const cwd = workspaceDirFor(key);
      const spec = { key, issuetype: "Task", summary: "s", parent: null };
      await withResumableSession(cwd, "original-session", async (home) => {
        const f = statefulHerdr("w1:p1", cwd, "idle", { launchPending: true });
        const herd = new HerdrHerd(f.client, "http://x/mcp", instant, undefined, undefined, undefined, homeOf(home));
        const outcome = await herd.resumeInPlace(spec);
        expect(outcome).toBe("deferred");
        expect(f.sent).toEqual([]); // no /exit text, no enter keys — the pane was never touched
        expect(f.started).toHaveLength(0); // no relaunch attempted either
      });
    });
  });

  test("negative control: the SAME idle pane, with launch_pending false, IS resumed — proves the fixture (and every other gate) is otherwise satisfied, so the guard above is what blocked it", async () => {
    await withTempWorkspaces(async () => {
      const key = encodeAgentKey({ resourceProvider: "jira-work", ruleId: "jira-work", resourceId: "FACTORY-902" });
      const cwd = workspaceDirFor(key);
      const spec = { key, issuetype: "Task", summary: "s", parent: null };
      await withResumableSession(cwd, "original-session", async (home) => {
        const f = statefulHerdr("w1:p1", cwd, "idle", { launchPending: false });
        const herd = new HerdrHerd(f.client, "http://x/mcp", instant, undefined, undefined, undefined, homeOf(home));
        const outcome = await herd.resumeInPlace(spec);
        expect(outcome).toBe("resumed");
        expect(f.sent).toEqual([{ text: "/exit" }, { keys: ["enter"] }]);
        expect(f.started).toHaveLength(1);
      });
    });
  });

  // FACTORY-489 (FACTORY-312 review correction): pins the launchPending
  // guard's PLACEMENT, not just its existence. A guard placed BEFORE
  // `providerOfPane` would return "deferred" for one detection pass on a
  // pane whose agent.list() entry still lags with launch_pending:true after
  // the underlying claude process has already died — herdr clears the
  // managed agent once it observes the exit, so that guard-first ordering
  // would only delay, by one poll, the existing "unresumable" ->
  // stop()/spawn() recovery that a "no process found" providerOfPane result
  // already provides for that case; this test proves the guard runs AFTER
  // providerOfPane instead, so that recovery is immediate rather than
  // delayed. The entry itself (and launch_pending:true) is present, but the
  // pane's OS process is gone. NOTE: the fixture (statefulHerdr with
  // processGone:true) holds launch_pending true INDEFINITELY, since it does
  // not model herdr's own release path — its shape pins the guard's
  // placement, not a claim about how long the real launch_pending state
  // persists after a process dies.
  test("unresumable, NOT deferred: launch_pending true but the pane's OS process is already gone — the existing providerOfPane gate wins, not the launchPending guard", async () => {
    await withTempWorkspaces(async () => {
      const key = encodeAgentKey({ resourceProvider: "jira-work", ruleId: "jira-work", resourceId: "FACTORY-903" });
      const cwd = workspaceDirFor(key);
      const spec = { key, issuetype: "Task", summary: "s", parent: null };
      await withResumableSession(cwd, "original-session", async (home) => {
        const f = statefulHerdr("w1:p1", cwd, "idle", { launchPending: true, processGone: true });
        const herd = new HerdrHerd(f.client, "http://x/mcp", instant, undefined, undefined, undefined, homeOf(home));
        const outcome = await herd.resumeInPlace(spec);
        expect(outcome).toBe("unresumable");
        expect(f.sent).toEqual([]);
        expect(f.started).toHaveLength(0);
      });
    });
  });

  // FACTORY-73 epic review (26188/26208, point 3) — "FACTORY-43 symmetry
  // stands: a fresh launch now carries no session flag, a resumed launch
  // carries --resume <id>; one module builds AND judges both; test across
  // SEVERAL consecutive polls." This drives `staleIssues()` itself (not
  // just the isolated `agentStartParams` builder) against the pane's REAL
  // post-resume argv (`--resume`, the NEW model/effort, no `--session-id`)
  // and proves it is never flagged, on the first poll or any of several
  // after it — a checker that only knew the FRESH shape would respawn a
  // resumed agent forever.
  test("no loop: a resumed agent's REAL argv (--resume, not --session-id) is never flagged stale by staleIssues() across SEVERAL consecutive polls, once resolvedAgentOf matches the new model/effort", async () => {
    await withTempWorkspaces(async () => {
      const key = encodeAgentKey({ resourceProvider: "jira-work", ruleId: "jira-work", resourceId: "FACTORY-909" });
      const cwd = workspaceDirFor(key);
      const spec = { key, issuetype: "Task", summary: "s", parent: null, agents: [{ harness: "claude" as const, model: "claude-opus-5", effort: "medium" as const }] };
      await withResumableSession(cwd, "original-session", async (home) => {
        const f = statefulHerdr("w1:p1", cwd);
        const herd = new HerdrHerd(
          f.client, "http://x/mcp", instant, undefined, undefined, undefined, homeOf(home), undefined, undefined, undefined,
          () => ({ model: "claude-opus-5", effort: "medium" }), // the definition/rule NOW resolves to exactly what we're about to resume to
        );
        expect(await herd.resumeInPlace(spec)).toBe("resumed");
        for (let poll = 0; poll < 5; poll++) {
          expect(await herd.staleIssues()).toEqual([]);
        }
      });
    });
  });

  // FACTORY-312 review (26137, point 2 + 1): herdr accepting the launch only
  // means the process STARTED — an unavailable model exits almost
  // immediately (Step 0.2: measured exit 1). Two things must both hold:
  // this is reported as "failed", not "resumed", and the model/effort files
  // are NOT overwritten (so the next poll's comparison still sees the OLD
  // values and keeps trying, rather than "matching" a launch that never
  // actually took).
  test("failed: the relaunch is accepted by herdr but the pane never shows claude alive afterward — reported as 'failed', model/effort NOT persisted", async () => {
    await withTempWorkspaces(async () => {
      const key = encodeAgentKey({ resourceProvider: "jira-work", ruleId: "jira-work", resourceId: "FACTORY-905" });
      const cwd = workspaceDirFor(key);
      const spec = { key, issuetype: "Task", summary: "s", parent: null, agents: [{ harness: "claude" as const, model: "claude-nonexistent-model", effort: "medium" as const }] };
      buildWorkspace({ ...spec, agents: [{ harness: "claude" as const, model: "claude-opus-5", effort: "high" as const }] }, "http://x/mcp", "claude");
      await withResumableSession(cwd, "original-session", async (home) => {
        const f = statefulHerdr("w1:p1", cwd, "idle", { crashesOnStart: true });
        const herd = new HerdrHerd(f.client, "http://x/mcp", instant, undefined, undefined, undefined, homeOf(home));
        const outcome = await herd.resumeInPlace(spec);
        expect(outcome).toBe("failed");
        // FACTORY-525: herdr accepted the launch and nothing threw — no exit
        // code is available from herdr for a pane's process, so this is the
        // honest ceiling, not a gap.
        expect(herd.lastResumeFailureDetail(key)).toBe("no exit status captured");
        expect(f.started).toHaveLength(1); // the attempt WAS made
        // FACTORY-491 (director item 3): the pane is closed by id directly,
        // defence in depth ahead of reconcileNow's own herd.stop()+spawn().
        expect(f.closed).toEqual(["w1:p1"]);
        // Old values stand — never overwritten by a relaunch that didn't take.
        expect(workspaceModel(cwd)).toBe("claude-opus-5");
        expect(workspaceEffort(cwd)).toBe("high");
        expect(workspaceSessionId(cwd)).toBe("original-session");
      });
    });
  });

  // FACTORY-314 (PR #513 review fix) — MEASURED LIVE against a real herdr
  // (throwaway workspace, real HerdrHerd.spawn/resumeInPlace): the old
  // process can still hold this pane's agent name in herdr's own
  // bookkeeping for a moment even after every check above (idle, `/exit`,
  // "back to a shell") has passed — `agent.start` itself then rejects with
  // `agent_name_taken`.
  //
  // FACTORY-426 (epic review, comment 27460): originally asserted this
  // resolved to "stuck" — proven WRONG by a live reproduction
  // (FACTORY-73/FACTORY-394, FACTORY-312 comment 27407): "stuck" is a bare
  // retry, and by the time this catch fires the pane is ALREADY confirmed
  // empty (this fake's own `sendKeys` sets `foreground = "shell"`
  // immediately, simulating the confirmed exit), so a bare retry never
  // clears `ManagedHerdrLifecycle`'s stale "current worker" identity —
  // every later ordinary spawn attempt then hits `HandoffBlocked: Current
  // worker disappeared; refusing implicit replacement`, forever. The
  // correct outcome is "failed", which routes through `reconcileNow`'s
  // existing stop-then-spawn fallback (see loop.test.ts's own
  // scopedHerd-routing tests) — the SAME machinery a liveness-check failure
  // already used safely before this ticket.
  test("failed (via agent_name_taken on an already-confirmed-empty pane): routes to the stop-then-spawn fallback instead of a bare 'stuck' retry — never persists", async () => {
    await withTempWorkspaces(async () => {
      const key = encodeAgentKey({ resourceProvider: "jira-work", ruleId: "jira-work", resourceId: "FACTORY-908" });
      const cwd = workspaceDirFor(key);
      const spec = { key, issuetype: "Task", summary: "s", parent: null };
      await withResumableSession(cwd, "original-session", async (home) => {
        const f = statefulHerdr("w1:p1", cwd, "idle", { nameTaken: true });
        const herd = new HerdrHerd(f.client, "http://x/mcp", instant, undefined, undefined, undefined, homeOf(home));
        const outcome = await herd.resumeInPlace(spec);
        expect(outcome).toBe("failed");
        // FACTORY-525: the herdr rejection itself is the reason — carried
        // through from the `agent.start` throw, not lost on the way to
        // "failed".
        expect(herd.lastResumeFailureDetail(key)).toBe("herdr error: agent.start: agent name already used [agent_name_taken]");
        // FACTORY-491 (director item 3): closed by id directly, independent
        // of herd.stop()'s own identity-matched close in the fallthrough.
        expect(f.closed).toEqual(["w1:p1"]);
        expect(workspaceSessionId(cwd)).toBe("original-session");
      });
    });
  });

  // FACTORY-426: the twin of the test above — required addition 1 from the
  // epic's review. Any OTHER error from the relaunch attempt (not just
  // `agent_name_taken`) reaches this same catch with the pane just as
  // confirmed-empty, and used to propagate as a raw throw — `reconcileNow`
  // then does `failures.push(...); continue;`, ALSO a bare retry that never
  // clears `ManagedHerdrLifecycle.active`. Must resolve the same way.
  test("failed (via a non-agent_name_taken relaunch error on an already-confirmed-empty pane): routes to the stop-then-spawn fallback instead of propagating the throw", async () => {
    await withTempWorkspaces(async () => {
      const key = encodeAgentKey({ resourceProvider: "jira-work", ruleId: "jira-work", resourceId: "FACTORY-909" });
      const cwd = workspaceDirFor(key);
      const spec = { key, issuetype: "Task", summary: "s", parent: null };
      await withResumableSession(cwd, "original-session", async (home) => {
        const f = statefulHerdr("w1:p1", cwd, "idle");
        f.client.agent.start = async () => { throw new Error("transport hiccup"); };
        const herd = new HerdrHerd(f.client, "http://x/mcp", instant, undefined, undefined, undefined, homeOf(home));
        const outcome = await herd.resumeInPlace(spec);
        expect(outcome).toBe("failed");
        // FACTORY-525: ANY relaunch error, not just `agent_name_taken`,
        // survives as this outcome's reason.
        expect(herd.lastResumeFailureDetail(key)).toBe("herdr error: transport hiccup");
        // FACTORY-491 (director item 3): closed by id directly, independent
        // of herd.stop()'s own identity-matched close in the fallthrough.
        expect(f.closed).toEqual(["w1:p1"]);
        expect(workspaceSessionId(cwd)).toBe("original-session");
      });
    });
  });

  // FACTORY-426: the narrow safety valve required addition 1 preserves —
  // if something genuinely DOES occupy the pane again between the exit
  // check and the relaunch attempt's own failure (not the expected case,
  // but not provably impossible either), the original error must still
  // surface rather than being silently downgraded to "failed".
  test("a relaunch error with the pane unexpectedly re-occupied still throws (not silently downgraded to 'failed')", async () => {
    await withTempWorkspaces(async () => {
      const key = encodeAgentKey({ resourceProvider: "jira-work", ruleId: "jira-work", resourceId: "FACTORY-910" });
      const cwd = workspaceDirFor(key);
      const spec = { key, issuetype: "Task", summary: "s", parent: null };
      await withResumableSession(cwd, "original-session", async (home) => {
        const f = statefulHerdr("w1:p1", cwd, "idle");
        f.client.agent.start = async () => {
          // Something reoccupies the pane's foreground right as the relaunch itself fails.
          f.client.pane.processInfo = async () => ({ process_info: { pane_id: "w1:p1", foreground_processes: [CLAUDE_PROC] } });
          throw new Error("transport hiccup");
        };
        const herd = new HerdrHerd(f.client, "http://x/mcp", instant, undefined, undefined, undefined, homeOf(home));
        await expect(herd.resumeInPlace(spec)).rejects.toThrow("transport hiccup");
        expect(workspaceSessionId(cwd)).toBe("original-session");
        // FACTORY-491 (director item 3): the defensive close is scoped to a
        // genuine "failed" outcome only — a re-occupied pane throws instead,
        // and must not be closed out from under whatever now occupies it.
        expect(f.closed).toEqual([]);
      });
    });
  });

  test("deferred: an agent mid-turn is never sent /exit and nothing is relaunched", async () => {
    await withTempWorkspaces(async () => {
      const key = encodeAgentKey({ resourceProvider: "jira-work", ruleId: "jira-work", resourceId: "FACTORY-901" });
      const cwd = workspaceDirFor(key);
      const spec = { key, issuetype: "Task", summary: "s", parent: null };
      await withResumableSession(cwd, "original-session", async (home) => {
        const f = statefulHerdr("w1:p1", cwd, "working");
        const herd = new HerdrHerd(f.client, "http://x/mcp", instant, undefined, undefined, undefined, homeOf(home));
        const outcome = await herd.resumeInPlace(spec);
        expect(outcome).toBe("deferred");
        expect(f.sent).toEqual([]);
        expect(f.started).toEqual([]);
      });
    });
  });

  test("stuck: /exit is sent but the pane never shows a shell in its foreground — never relaunched, never killed", async () => {
    await withTempWorkspaces(async () => {
      const key = encodeAgentKey({ resourceProvider: "jira-work", ruleId: "jira-work", resourceId: "FACTORY-902" });
      const cwd = workspaceDirFor(key);
      const spec = { key, issuetype: "Task", summary: "s", parent: null };
      await withResumableSession(cwd, "original-session", async (home) => {
        const f = statefulHerdr("w1:p1", cwd);
        // Override sendKeys so the pane STAYS on claude (a stuck dialog), unlike the happy-path fake above.
        f.client.pane.sendKeys = async (p: any) => { f.sent.push({ keys: p.keys }); };
        let now = 0;
        const herd = new HerdrHerd(f.client, "http://x/mcp", instant, undefined, undefined, undefined, homeOf(home), () => (now += 5_000));
        const outcome = await herd.resumeInPlace(spec);
        expect(outcome).toBe("stuck");
        expect(f.started).toEqual([]);
      });
    });
  });

  test("unresumable: no persisted session id (a pre-FACTORY-314 workspace) — never attempts /exit", async () => {
    await withTempWorkspaces(async () => {
      const { mkdirSync } = require("node:fs") as typeof import("node:fs");
      const key = encodeAgentKey({ resourceProvider: "jira-work", ruleId: "jira-work", resourceId: "FACTORY-903" });
      const cwd = workspaceDirFor(key);
      mkdirSync(cwd, { recursive: true }); // workspace exists, but session id was never discovered/persisted
      const spec = { key, issuetype: "Task", summary: "s", parent: null };
      const f = statefulHerdr("w1:p1", cwd);
      const herd = new HerdrHerd(f.client, "http://x/mcp", instant);
      const outcome = await herd.resumeInPlace(spec);
      expect(outcome).toBe("unresumable");
      expect(f.sent).toEqual([]);
    });
  });

  // FACTORY-312 review (26137, point 1, via the formal PR review): a
  // persisted id whose transcript no longer exists (corrupted state, or a
  // discovery bug) must fail safe — never attempt `--resume` against a
  // conversation that isn't there.
  test("unresumable-transcript-gone: a persisted session id whose transcript is missing — never attempts /exit", async () => {
    await withTempWorkspaces(async () => {
      const { mkdtempSync, rmSync } = require("node:fs") as typeof import("node:fs");
      const { tmpdir } = require("node:os") as typeof import("node:os");
      const key = encodeAgentKey({ resourceProvider: "jira-work", ruleId: "jira-work", resourceId: "FACTORY-906" });
      const cwd = workspaceDirFor(key);
      persistDiscoveredSessionId(cwd, "ghost-session"); // persisted, but no transcript file exists anywhere
      const home = mkdtempSync(join(tmpdir(), "claude-home-empty-"));
      try {
        const f = statefulHerdr("w1:p1", cwd);
        const herd = new HerdrHerd(f.client, "http://x/mcp", instant, undefined, undefined, undefined, homeOf(home));
        const outcome = await herd.resumeInPlace({ key, issuetype: "Task", summary: "s", parent: null });
        // PR #560 review: a DISTINCT outcome from the bare "unresumable"
        // the OTHER two tests around this one assert — the id here WAS
        // determined ("ghost-session"); only its transcript is gone, which
        // deserves its own honest respawn-comment wording, not "session id
        // could not be determined" (see src/daemon/loop.ts's reason mapping).
        expect(outcome).toBe("unresumable-transcript-gone");
        expect(f.sent).toEqual([]);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
  });

  // FACTORY-73 epic review on PR #513 (round 3) — the failure shape a
  // discovery-failure branch that only LOGGED, never invalidated, left wide
  // open: (1) an earlier launch of this SAME workspace discovers and
  // persists S1. (2) the workspace later gets a genuinely fresh relaunch
  // (any reason), Claude picks a NEW id, but THIS launch's discovery finds
  // nothing (simulated here by `fakeHerdr`'s `agent.start`, which never
  // writes a transcript at all — the same "discovery loses the race"
  // condition `SESSION_DISCOVERY_ATTEMPTS` bounds but does not eliminate).
  // (3) S1's OLD id and OLD transcript are both still sitting on disk
  // (`claudeTranscriptExists` is a bare `existsSync`, and the project
  // folder is per-cwd, stable across respawns) — so a NAIVE "only log on
  // failure" implementation would leave S1 persisted, `resumeInPlace()`
  // would find it, find its transcript, and `--resume` it: silently
  // reviving a DIFFERENT, already-finished conversation and calling it
  // "PRESERVED". Asserts the OUTCOME (`resumeInPlace()` returns
  // `"unresumable"`, never attempts `/exit`), not merely that some file
  // changed.
  test("FACTORY-314 (epic review, round 3): a failed discovery INVALIDATES an older persisted session id from a PRIOR launch of this same workspace — resumeInPlace() never resumes the stale one", async () => {
    await withTempWorkspaces(async () => {
      const key = encodeAgentKey({ resourceProvider: "jira-work", ruleId: "jira-work", resourceId: "FACTORY-908" });
      const cwd = workspaceDirFor(key);
      const spec = { key, issuetype: "Task", summary: "s", parent: null };
      await withResumableSession(cwd, "stale-session-from-a-prior-launch", async (home) => {
        const f = fakeHerdr([]); // agent.start here never writes a transcript — this launch's own discovery will find nothing
        const herd = new HerdrHerd(f.client, "http://x/mcp", instant, undefined, undefined, undefined, homeOf(home));
        await herd.spawn(spec);
        expect(f.started).toHaveLength(1);
        // The stale id must be GONE, not merely left unreplaced — a later
        // resumeInPlace() must never find it.
        expect(workspaceSessionId(cwd)).toBeUndefined();
        const outcome = await herd.resumeInPlace(spec);
        expect(outcome).toBe("unresumable");
        expect(f.started).toHaveLength(1); // no /exit, no second agent.start — never touched the live agent at all
      });
    });
  });

  // FACTORY-73 (25989/25978): FACTORY-300 root-causes ManagedHerdrLifecycle.start()
  // throwing HandoffBlocked("Current worker disappeared; refusing implicit
  // replacement") when its remembered `this.active` can't be re-resolved — a
  // real risk during resumeInPlace's own exit-to-relaunch window, when the
  // pane briefly shows a bare shell. Proven safe WITHOUT touching that guard:
  // resumeInPlace and spawn() share the SAME per-issue exclusive queue
  // (`this.exclusive`), so a concurrent ordinary `herd.spawn()` for this
  // exact issue simply queues behind resumeInPlace and, once it runs, finds
  // the resumed agent already present — it never reaches
  // `ManagedHerdrLifecycle.start()` (and so never `workspace.create`) at all.
  test("FACTORY-300: a concurrent ordinary herd.spawn() for the SAME issue, fired while resumeInPlace's exit-to-relaunch window is open, never throws and ends as a no-op", async () => {
    await withTempWorkspaces(async () => {
      const key = encodeAgentKey({ resourceProvider: "jira-work", ruleId: "jira-work", resourceId: "FACTORY-904" });
      const cwd = workspaceDirFor(key);
      const spec = { key, issuetype: "Task", summary: "s", parent: null };
      await withResumableSession(cwd, "original-session", async (home) => {
        const f = statefulHerdr("w1:p1", cwd);
        // workspace.create is ONLY ever reached if the ordinary spawn path
        // falls through to ManagedHerdrLifecycle.start() — make it throw if
        // called at all, so a wrong (non-serialized) implementation fails loud.
        (f.client as any).workspace = { create: async () => { throw new Error("spawn() must never create a new workspace during a resumeInPlace window"); } };
        const herd = new HerdrHerd(f.client, "http://x/mcp", instant, undefined, undefined, undefined, homeOf(home));
        const [resumeOutcome] = await Promise.all([herd.resumeInPlace(spec), herd.spawn(spec)]);
        expect(resumeOutcome).toBe("resumed");
        expect(f.started).toHaveLength(1); // only resumeInPlace's own relaunch — spawn() found it already running and no-opped
      });
    });
  });

  // FACTORY-312 review (formal PR review on #513): the isolated builder tests
  // above prove `agentStartParams()` appends `--resume` correctly, but a REAL
  // fresh spawn never goes through that function at all — `HerdrHerd.spawnExclusive`'s
  // `prepare()` hands `agentLaunchConfig(...)` straight to Drovr's REAL
  // `ManagedHerdrLifecycle.start()`, which builds its OWN `agent.start` args
  // via Drovr's OWN `buildAgentStartParams` (verified against the pinned
  // 0.15.1 source: no `--session-id`/`--resume` concept for Claude at all).
  // This test drives THAT production path — `HerdrHerd.spawn()`, the real
  // `ManagedHerdrLifecycle`, a fake herdr client only at the RPC boundary —
  // and would have FAILED against this PR's original head, where the
  // launch's real argv never carried the persisted id at all (it could not:
  // nothing wired it there), so `resumeInPlace()` would have resumed a
  // uuid Claude never used.
  test("FACTORY-314 (PR #513 review): a REAL fresh spawn (HerdrHerd.spawn -> the real ManagedHerdrLifecycle.start -> Drovr's own buildAgentStartParams) discovers and persists the session id Claude ACTUALLY used, never a butchr-guessed one", async () => {
    await withTempWorkspaces(async () => {
      const { mkdtempSync, rmSync, mkdirSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
      const { tmpdir } = require("node:os") as typeof import("node:os");
      const { resolve } = require("node:path") as typeof import("node:path");
      const key = encodeAgentKey({ resourceProvider: "jira-work", ruleId: "jira-work", resourceId: "FACTORY-907" });
      const cwd = workspaceDirFor(key);
      const home = mkdtempSync(join(tmpdir(), "claude-home-real-spawn-"));
      try {
        const f = fakeHerdr([]);
        const realStart = f.client.agent.start;
        const claudeChosenId = "claude-picked-this-id-itself";
        // Simulates the ONE thing real Claude Code does that this whole fix
        // depends on: it names its OWN transcript file, independent of
        // anything in the launch argv (`p.args`) — never influenced by butchr.
        f.client.agent.start = async (p: any) => {
          await realStart(p);
          // FACTORY-631/FACTORY-623/FACTORY-568: see the matching comment
          // on the FACTORY-426 fixture below — a real, awaited delay so
          // this fake write lands safely past `discoverClaudeSessionId`'s
          // `AFTER_MARGIN_MS`, the same way a real Claude launch's own
          // (much slower) transcript write always does.
          await new Promise((r) => setTimeout(r, 20));
          const projectDir = join(home, ".claude", "projects", resolve(cwd).replace(/[^a-zA-Z0-9]/g, "-"));
          mkdirSync(projectDir, { recursive: true });
          writeFileSync(join(projectDir, `${claudeChosenId}.jsonl`), "{}");
        };
        const herd = new HerdrHerd(f.client, "http://x/mcp", instant, undefined, undefined, undefined, homeOf(home));
        await herd.spawn({ key, issuetype: "Task", summary: "s", parent: null });
        expect(f.started).toHaveLength(1);
        expect(f.started[0]!.args).not.toContain("--session-id"); // confirms the real launch path carries no butchr-chosen id at all
        expect(f.started[0]!.args).not.toContain("--resume");
        expect(workspaceSessionId(cwd)).toBe(claudeChosenId); // discovered from Claude's OWN transcript, not guessed
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
  });

  /**
   * FACTORY-426 (epic review, comment 27460 — "the first test proposal on
   * this ticket that would actually have caught its own bug"): a fake at
   * the `Herd` interface level (what every prior resumeInPlace/scopedHerd
   * test on this ticket used) cannot exercise this bug at all — it lives
   * inside `ManagedHerdrLifecycle`'s own private `this.active` bookkeeping,
   * a REAL class from `@brooswit/drovr` that `HerdrHerd` constructs
   * internally and never exposes. This fixture stubs ONLY the herdr RPC
   * boundary (`client.agent`/`client.pane`/`client.workspace`) — the same
   * seam `fakeHerdr` above already uses for a real fresh spawn — and adds
   * exactly what `resumeInPlace`'s own post-`/exit` region additionally
   * needs: `pane.processInfo` (foreground detection), `pane.sendText`/
   * `sendKeys` (the `/exit` sequence), and `agent_status` on spawned
   * entries (`ManagedHerdrLifecycle.resolveCurrent()`'s own idle check).
   */
  function fakeHerdrFullCycle(cwd: string) {
    // FACTORY-622: `panes` is a SEPARATE registry from `agents`, and that
    // separation is the whole point — real herdr can list a pane that has no
    // agent on it (the bare shell a `/exit` leaves behind), and it can also
    // stop listing a pane entirely (its workspace was closed). Before this,
    // the fixture modelled only `agents`, so neither state was reachable and
    // `pane.list` did not exist at all. Every pre-existing test keeps the
    // behaviour it had: `workspace.create` registers the pane it returns and
    // `pane.close` removes it, which is exactly what those tests already
    // assumed implicitly.
    const state: { agents: Array<{ pane_id: string; cwd: string; agent?: string; agent_status: string }>; panes: string[]; foreground: "claude" | "shell" } = { agents: [], panes: [], foreground: "shell" };
    let paneCounter = 0;
    // FACTORY-470/472: the REAL argv the last successful `agent.start` was
    // called with — needed by `staleIssues()`'s own `isHerdrRestoredPane`
    // check (this ticket), which PR #551's own tests never exercised
    // through this fixture. Additive only: every existing #551 test still
    // gets the exact same fixed shell/claude foreground shape it always did.
    let lastArgv: string[] = ["claude"];
    const started: any[] = []; const closed: string[] = []; const sent: any[] = []; const creates: any[] = [];
    let nameTakenNext = false;
    let otherErrorNext = false;
    let keepForegroundAfterExit = false;
    const client = {
      agent: {
        list: async () => ({ agents: state.agents.map((a) => ({ ...a })) }),
        start: async (p: any) => {
          started.push(p);
          if (nameTakenNext) { nameTakenNext = false; throw HerdrError.from("agent.start", { code: "agent_name_taken", message: "agent name already used" }); }
          if (otherErrorNext) { otherErrorNext = false; throw new Error("herdr RPC transport hiccup"); }
          lastArgv = ["claude", ...(p.args ?? [])];
          state.agents = [...state.agents.filter((a) => a.pane_id !== p.pane_id), { pane_id: p.pane_id, cwd, agent: "claude", agent_status: "idle" }];
          state.foreground = "claude";
        },
      },
      pane: {
        list: async () => ({ panes: state.panes.map((pane_id) => ({ pane_id, cwd })) }),
        processInfo: async (q: { pane_id: string }) => ({ process_info: { pane_id: q.pane_id, foreground_processes: state.foreground === "claude" ? [{ pid: 1, argv: lastArgv, name: "claude" }] : [] } }),
        sendText: async (p: any) => { sent.push({ text: p.text }); },
        sendKeys: async (p: any) => { sent.push({ keys: p.keys }); if (!keepForegroundAfterExit) state.foreground = "shell"; },
        close: async (id: string) => { closed.push(id); state.agents = state.agents.filter((a) => a.pane_id !== id); state.panes = state.panes.filter((p) => p !== id); },
        read: async () => ({ read: { text: "" } }),
      },
      workspace: { create: async (p: any) => { paneCounter++; creates.push(p); const pane_id = `fresh-${paneCounter}`; state.panes = [...state.panes, pane_id]; return { root_pane: { pane_id } }; } },
    };
    return {
      client: client as any, started, closed, sent, creates, state,
      setNameTakenOnNextStart: () => { nameTakenNext = true; },
      // FACTORY-622: keep `pane.processInfo` reporting claude in the
      // foreground even after the `/exit` keystroke — the ONLY way to reach
      // `resumeInPlaceExclusive`'s `"stuck"` outcome through this fixture,
      // since that outcome is defined by the pane still being occupied when
      // the exit deadline passes. The real pane then empties a moment later
      // (`emptyPane` below), which is precisely the sequence measured on
      // v0.19.0 for admin-brooswit-nexus.
      keepForegroundAfterExit: () => { keepForegroundAfterExit = true; },
      /**
       * FACTORY-622: the pane's provider exits, WITHOUT butchr closing the
       * pane. herdr keeps listing the pane (it is a live bare shell) and
       * drops its agent entry, which is the state the director's own evidence
       * describes as "the pane emptied".
       */
      emptyPane: () => { state.foreground = "shell"; state.agents = []; },
      /**
       * FACTORY-622: something OUTSIDE butchr closes the workspace — a direct
       * herdr `workspace.close`, never butchr's own `stop()`. Both the pane
       * and its agent vanish from herdr, and nothing tells
       * `ManagedHerdrLifecycle` about it. Deliberately does NOT go through
       * `pane.close` above: that is the path butchr itself uses, and routing
       * this through it would not reproduce the defect (it would also be
       * recorded in `closed`, hiding whether the production code closed
       * anything of its own).
       */
      closeWorkspaceExternally: () => { state.panes = []; state.agents = []; state.foreground = "shell"; },
      // FACTORY-470/472: force the NEXT `agent.start` to throw a non-
      // agent_name_taken error — the second door PR #551's floor fix
      // covers (`postExitOutcome()` applies identically to both).
      setOtherErrorOnNextStart: () => { otherErrorNext = true; },
      // Simulates herdr's OWN bookkeeping eventually forgetting a dead
      // pane's agent-name registration (the "old process can still hold
      // this pane's agent name... for a moment" gap `staleIssues()`'s own
      // comment describes) — its real timing is external and unmodeled
      // here; what this test actually validates is what happens ONCE that
      // catch-up occurs, which is the part `ManagedHerdrLifecycle.active`'s
      // own staleness controls.
      forgetAllAgents: () => { state.agents = []; },
    };
  }

  // THE regression test for FACTORY-426's floor fix. Verified (locally,
  // before committing) to FAIL against the pre-fix `resumeInPlaceExclusive`
  // (which returned "stuck" for `agent_name_taken` unconditionally): with
  // "stuck", `herd.stop()` below is never reached, so `ManagedHerdrLifecycle`
  // still holds the ORIGINAL pane as `this.active` when the final
  // `herd.spawn()` runs, which then hits `resolveCurrent()` finding nothing
  // (this test's own `forgetAllAgents()`) while `this.active` is still set —
  // `ManagedHerdrLifecycle.start()`'s own precondition throws
  // `HandoffBlocked: Current worker disappeared; refusing implicit
  // replacement`, `spawnExclusive` catches it, logs `"waiting - handoff
  // blocked"`, and returns — no throw, `f.started` stays at 2, no third
  // pane is ever created. That is the exact silent permanent stall
  // confirmed live (FACTORY-73/FACTORY-394, FACTORY-312 comment 27407).
  test("FACTORY-426: a 'failed' outcome from a vacated-pane relaunch collision lets the NEXT ordinary spawn actually recover — real HerdrHerd + real ManagedHerdrLifecycle, stubbed only at the herdr RPC boundary", async () => {
    await withTempWorkspaces(async () => {
      const { mkdtempSync, rmSync, mkdirSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
      const { tmpdir } = require("node:os") as typeof import("node:os");
      const { resolve } = require("node:path") as typeof import("node:path");
      const key = encodeAgentKey({ resourceProvider: "jira-work", ruleId: "jira-work", resourceId: "FACTORY-911" });
      const cwd = workspaceDirFor(key);
      const spec = { key, issuetype: "Task", summary: "s", parent: null };
      const home = mkdtempSync(join(tmpdir(), "claude-home-strand-"));
      try {
        const f = fakeHerdrFullCycle(cwd);
        let sessionCounter = 0;
        const rawStart = f.client.agent.start;
        // Simulates Claude naming its OWN transcript file on a genuinely
        // successful launch only — `rawStart` throws before this runs when
        // `setNameTakenOnNextStart()` is armed, exactly like the real
        // failure this fixture reproduces never gets a session id either.
        f.client.agent.start = async (p: any) => {
          await rawStart(p);
          sessionCounter++;
          // FACTORY-631/FACTORY-623/FACTORY-568: a real, awaited delay, not
          // a sleep standing in for the production fix — `discoverClaudeSessionId`'s
          // `AFTER_MARGIN_MS` (see its own doc comment) requires a
          // transcript to land in a STRICTLY LATER millisecond than
          // `launchStartedAt` to be accepted as this launch's own. A real
          // Claude launch takes tens of milliseconds to seconds to do that
          // on its own; this fake `agent.start` writes synchronously, with
          // no real elapsed time at all, so it needs an explicit, realistic
          // gap to stay a true positive instead of flaking on that margin.
          await new Promise((r) => setTimeout(r, 20));
          const projectDir = join(home, ".claude", "projects", resolve(cwd).replace(/[^a-zA-Z0-9]/g, "-"));
          mkdirSync(projectDir, { recursive: true });
          writeFileSync(join(projectDir, `session-${sessionCounter}.jsonl`), "{}");
        };
        const herd = new HerdrHerd(f.client, "http://x/mcp", instant, undefined, undefined, undefined, homeOf(home));

        // 1) A REAL fresh spawn — establishes ManagedHerdrLifecycle's own
        // "current worker" identity for real, not a fake's approximation of it.
        await herd.spawn(spec);
        expect(f.started).toHaveLength(1);
        const originalPane = f.state.agents[0]!.pane_id;

        // 2) resumeInPlace attempts a same-pane relaunch that collides with
        // agent_name_taken — the exact live-reproduced failure.
        f.setNameTakenOnNextStart();
        const outcome = await herd.resumeInPlace(spec);
        expect(outcome).toBe("failed"); // not "stuck" — the floor fix in effect
        expect(f.sent.some((s) => s.text === "/exit")).toBe(true); // confirms /exit really was sent before the collision

        // 3) herdr eventually forgets the dead pane's registration (see
        // `forgetAllAgents`'s own doc comment above for why this is the
        // honest way to reach the state this test actually cares about).
        f.forgetAllAgents();

        // 4) reconcileNow's ACTUAL contract for a "failed" outcome —
        // `herd.stop(issue)` THEN `herd.spawn(issue)` — mirrored directly so
        // this test isolates exactly what the floor fix changed, without
        // routing through reconcileNow's own unrelated admission/guard logic.
        await herd.stop(spec.key);
        await herd.spawn(spec);

        expect(f.started).toHaveLength(3); // the third attempt actually reached agent.start — not silently blocked
        expect(f.state.agents).toHaveLength(1);
        expect(f.state.agents[0]!.pane_id).not.toBe(originalPane); // a genuinely NEW pane — an honest fresh restart, not a phantom reuse
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
  });

  // The negative control for the test above: without the `herd.stop()` call
  // (i.e., the OLD "stuck" behavior's actual consequence), the next spawn
  // attempt is silently blocked — proving this fixture reproduces the real
  // defect, not just a fixture quirk. Deliberately calls `spawnExclusive`'s
  // production entry point (`herd.spawn`), never a lower-level drovr call.
  test("FACTORY-426 (negative control): skipping herd.stop() before the next spawn reproduces the silent HandoffBlocked stall this ticket fixed", async () => {
    await withTempWorkspaces(async () => {
      const { mkdtempSync, rmSync, mkdirSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
      const { tmpdir } = require("node:os") as typeof import("node:os");
      const { resolve } = require("node:path") as typeof import("node:path");
      const key = encodeAgentKey({ resourceProvider: "jira-work", ruleId: "jira-work", resourceId: "FACTORY-912" });
      const cwd = workspaceDirFor(key);
      const spec = { key, issuetype: "Task", summary: "s", parent: null };
      const home = mkdtempSync(join(tmpdir(), "claude-home-strand-control-"));
      try {
        const f = fakeHerdrFullCycle(cwd);
        let sessionCounter = 0;
        const rawStart = f.client.agent.start;
        f.client.agent.start = async (p: any) => {
          await rawStart(p);
          sessionCounter++;
          // FACTORY-631/FACTORY-623/FACTORY-568: a real, awaited delay, not
          // a sleep standing in for the production fix — `discoverClaudeSessionId`'s
          // `AFTER_MARGIN_MS` (see its own doc comment) requires a
          // transcript to land in a STRICTLY LATER millisecond than
          // `launchStartedAt` to be accepted as this launch's own. A real
          // Claude launch takes tens of milliseconds to seconds to do that
          // on its own; this fake `agent.start` writes synchronously, with
          // no real elapsed time at all, so it needs an explicit, realistic
          // gap to stay a true positive instead of flaking on that margin.
          await new Promise((r) => setTimeout(r, 20));
          const projectDir = join(home, ".claude", "projects", resolve(cwd).replace(/[^a-zA-Z0-9]/g, "-"));
          mkdirSync(projectDir, { recursive: true });
          writeFileSync(join(projectDir, `session-${sessionCounter}.jsonl`), "{}");
        };
        const herd = new HerdrHerd(f.client, "http://x/mcp", instant, undefined, undefined, undefined, homeOf(home));
        await herd.spawn(spec);
        f.setNameTakenOnNextStart();
        await herd.resumeInPlace(spec);
        f.forgetAllAgents();
        // Deliberately no herd.stop() here — mirrors what "stuck" used to do.
        await herd.spawn(spec);
        // `ManagedHerdrLifecycle.start()` returns `{status:"blocked"}` rather
        // than throwing; `spawnExclusive` logs and returns silently. The
        // observable symptom: no third launch attempt ever reaches
        // `agent.start`, and no new pane appears — the silent permanent
        // stall, reproduced deliberately to prove this fixture is sensitive
        // to the actual defect rather than trivially passing either way.
        expect(f.started).toHaveLength(2);
        expect(f.state.agents).toHaveLength(0);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
  });

  /**
   * FACTORY-622 — shared setup for this ticket's own tests, factored out of
   * the two FACTORY-426 tests above (which keep their inline copies rather
   * than being rewritten around this: their assertions are about a shipped
   * fix and are not this ticket's to disturb).
   *
   * The `agent.start` wrapper is the same one those tests use, and it is
   * needed for the same reason: `startProviders` runs
   * `discoverClaudeSessionId` after a SUCCESSFUL launch, which only accepts a
   * transcript written in a strictly later millisecond than the launch began
   * (see `withResumableSession`'s own doc comment). Without it a successful
   * spawn still succeeds but logs a WARNING, which would sit in the middle of
   * the log assertions below.
   */
  async function withFullCycleHerd<T>(
    resourceId: string,
    fn: (ctx: { f: ReturnType<typeof fakeHerdrFullCycle>; herd: HerdrHerd; spec: { key: string; issuetype: string; summary: string; parent: null }; lines: string[]; cwd: string }) => Promise<T>,
  ): Promise<T> {
    return await withTempWorkspaces(async () => {
      const { mkdtempSync, rmSync, mkdirSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
      const { tmpdir } = require("node:os") as typeof import("node:os");
      const { resolve } = require("node:path") as typeof import("node:path");
      const key = encodeAgentKey({ resourceProvider: "jira-work", ruleId: "jira-work", resourceId });
      const cwd = workspaceDirFor(key);
      const spec = { key, issuetype: "Task", summary: "s", parent: null };
      const home = mkdtempSync(join(tmpdir(), "claude-home-622-"));
      try {
        const f = fakeHerdrFullCycle(cwd);
        let sessionCounter = 0;
        const rawStart = f.client.agent.start;
        f.client.agent.start = async (p: any) => {
          await rawStart(p);
          sessionCounter++;
          await new Promise((r) => setTimeout(r, 20));
          const projectDir = join(home, ".claude", "projects", resolve(cwd).replace(/[^a-zA-Z0-9]/g, "-"));
          mkdirSync(projectDir, { recursive: true });
          writeFileSync(join(projectDir, `session-${sessionCounter}.jsonl`), "{}");
        };
        const lines: string[] = [];
        // A clock that advances a second per READ, not a fixed value: the
        // post-`/exit` wait in `resumeInPlaceExclusive` is a
        // `monotonicNow()`-bounded loop whose injected `wait` is `instant`
        // here, so a frozen clock would spin it forever and a real clock
        // would make the `"stuck"` test below sit through the full
        // `RESUME_EXIT_TIMEOUT_MS` of real time.
        let clock = 0;
        const herd = new HerdrHerd(f.client, "http://x/mcp", instant, (l) => lines.push(l), undefined, undefined, homeOf(home), () => (clock += 1_000));
        return await fn({ f, herd, spec, lines, cwd });
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
  }

  /**
   * THE regression test for this ticket's originally reported cause. Verified
   * to FAIL without `clearVanishedWorker` (src/agents/herd.ts): every spawn
   * after the external close logs `waiting - handoff blocked` and
   * `f.started` never leaves 1, which is the live-confirmed stall — the
   * director and genius panes on 2026-10-02, recoverable only by restarting
   * `butchr.service`.
   *
   * Deliberately calls NOTHING but `herd.spawn()` between the close and the
   * recovery: no `herd.stop()` (that is FACTORY-426's route, and needing it
   * here is the defect), no freeze/unfreeze (that is what admin-assembly had
   * to do by hand on 2026-10-03), and no restart. The second `spawn()` is
   * what the next ordinary reconcile poll would do.
   */
  test("FACTORY-622: a workspace closed directly in herdr (not via butchr stop) gets its stale worker state cleared, and the next spawn succeeds with no restart", async () => {
    await withFullCycleHerd("FACTORY-920", async ({ f, herd, spec, lines }) => {
      await herd.spawn(spec);
      expect(f.started).toHaveLength(1);
      const originalPane = f.state.agents[0]!.pane_id;

      // Something external closes the workspace. butchr is told nothing, and
      // still holds `originalPane` as its current worker.
      f.closeWorkspaceExternally();

      // The reconcile poll that follows: desired, not running, so it spawns.
      // This one is still refused — the repair is state-only, by design.
      await herd.spawn(spec);
      expect(f.started).toHaveLength(1);
      expect(lines.some((l) => l.includes("waiting - handoff blocked"))).toBe(true);
      expect(lines.some((l) => l.includes("cleared stale worker state") && l.includes(originalPane) && l.includes("closed outside butchr"))).toBe(true);
      // The reason is retained non-destructively for the ops alert, and it is
      // the SDK's own wording, not a string this test or the fix invented.
      expect(herd.lastSpawnRefusal(spec.key)).toBe("Current worker disappeared; refusing implicit replacement");

      // The next poll's spawn — the one that used to be refused forever.
      await herd.spawn(spec);
      expect(f.started).toHaveLength(2);
      expect(f.state.agents).toHaveLength(1);
      expect(f.state.agents[0]!.pane_id).not.toBe(originalPane); // an honest fresh pane, not a phantom reuse
      expect(herd.lastSpawnRefusal(spec.key)).toBeUndefined(); // cleared by the successful spawn
      // Nothing was closed by butchr: the workspace was already gone, so
      // there was nothing to close — only identity to forget.
      expect(f.closed).toEqual([]);
    });
  });

  /**
   * The director's scope addition (2026-10-03): the same wedge via
   * `resumeInPlace`, which FACTORY-426's fix does not reach because no
   * `herd.stop()` ever runs for a `"stuck"` outcome. Measured on v0.19.0:
   * admin-brooswit-nexus logged `"stuck"` at 05:41:44 after a 05:41:34
   * `/exit`, the pane emptied, the cached identity was never cleared, and 26
   * consecutive spawns were refused until admin-assembly cleared it by hand
   * with `session freeze` + `unfreeze`.
   *
   * The acceptance criterion names the recovery exactly: respawn succeeds
   * with NO freeze/unfreeze. Note the pane is still LISTED here — only its
   * provider exited — so this is the branch that the pane-gone test above
   * does not cover, and the one that proves the fix is keyed on evidence
   * about the pane rather than on how the pane came to be empty.
   */
  test("FACTORY-622: a resume-in-place 'stuck' whose pane empties afterwards is cleared too, and the respawn succeeds with no freeze/unfreeze", async () => {
    await withFullCycleHerd("FACTORY-921", async ({ f, herd, spec, lines }) => {
      await herd.spawn(spec);
      expect(f.started).toHaveLength(1);
      const originalPane = f.state.agents[0]!.pane_id;

      // The pane does not vacate before the exit deadline, so the resume
      // returns "stuck" — a bare retry, with no stop/spawn behind it.
      f.keepForegroundAfterExit();
      expect(await herd.resumeInPlace(spec)).toBe("stuck");
      expect(f.sent.some((s) => s.text === "/exit")).toBe(true);

      // ...and then the pane empties anyway, a moment later. herdr still
      // lists the pane; it just has no provider on it any more.
      f.emptyPane();
      expect(f.state.panes).toEqual([originalPane]);

      await herd.spawn(spec);
      expect(f.started).toHaveLength(1); // still refused on this poll
      expect(lines.some((l) => l.includes("cleared stale worker state") && l.includes("still listed but empty"))).toBe(true);
      // The orphaned bare shell IS closed in this branch, unlike the
      // closed-workspace one: the next spawn must not have to launch beside it.
      expect(f.closed).toContain(originalPane);

      await herd.spawn(spec);
      expect(f.started).toHaveLength(2);
      expect(f.state.agents).toHaveLength(1);
      expect(f.state.agents[0]!.pane_id).not.toBe(originalPane);
    });
  });

  /**
   * The ticket's second requirement, as its own test: "Only clear when herdr
   * positively reports the workspace/pane missing. A herdr error or timeout
   * is NOT proof it is gone; do not clear on that."
   *
   * This is the test that would catch the dangerous version of this fix. If
   * `clearVanishedWorker` treated a failed `pane.list()` as evidence, it
   * would clear the identity of a worker that is in fact alive and herdr is
   * merely unreachable about — and the next poll would launch a SECOND agent
   * beside it, in the same workspace.
   */
  test("FACTORY-622: a pane.list() failure is not proof the pane is gone — the worker state is left exactly as it was", async () => {
    await withFullCycleHerd("FACTORY-922", async ({ f, herd, spec, lines }) => {
      await herd.spawn(spec);
      expect(f.started).toHaveLength(1);
      f.closeWorkspaceExternally();
      f.client.pane.list = async () => { throw new Error("herdr RPC transport hiccup"); };

      await herd.spawn(spec);
      expect(lines.some((l) => l.includes("pane.list() failed so herdr confirmed nothing") && l.includes("left untouched"))).toBe(true);
      expect(lines.some((l) => l.includes("cleared stale worker state"))).toBe(false);

      // Still wedged, deliberately: with no proof, the safe answer is to keep
      // refusing. Once herdr answers again, the very next poll recovers.
      await herd.spawn(spec);
      expect(f.started).toHaveLength(1);
      f.client.pane.list = async () => ({ panes: [] });
      await herd.spawn(spec);
      await herd.spawn(spec);
      expect(f.started).toHaveLength(2);
    });
  });

  /**
   * The third case the ticket asks for: an intact worker is untouched. The
   * pane is listed AND still running its provider; only herdr's `agent.list`
   * bookkeeping has dropped the entry (the measured lag `staleIssues()`'s own
   * comment describes). Clearing here would discard the identity of a live
   * agent, so the fix must refuse to — a pane that exists but whose agent has
   * died is FACTORY-426's stop-then-spawn case, not this one.
   */
  test("FACTORY-622: a blocked spawn whose held pane is still running a provider clears nothing", async () => {
    await withFullCycleHerd("FACTORY-923", async ({ f, herd, spec, lines }) => {
      await herd.spawn(spec);
      expect(f.started).toHaveLength(1);
      const originalPane = f.state.agents[0]!.pane_id;
      // The agent entry is gone from herdr's bookkeeping; the pane and its
      // claude process are both still there.
      f.forgetAllAgents();
      expect(f.state.panes).toEqual([originalPane]);

      await herd.spawn(spec);
      expect(lines.some((l) => l.includes("still running a provider") && l.includes("left untouched"))).toBe(true);
      expect(lines.some((l) => l.includes("cleared stale worker state"))).toBe(false);
      expect(f.closed).toEqual([]); // the live pane is never closed
      expect(f.started).toHaveLength(1);
    });
  });

  /**
   * The same guard one step further in: a `processInfo` that SUCCEEDS but
   * reports no foreground data at all is `"unknown"`, not `"empty"`. A shell
   * that is still starting reports exactly this, and so does a pane blocked
   * on a dialog — absence of data is not absence of a process. Without this
   * distinction `paneOccupancy` would be the same two-valued check
   * `providerOfPane` already is, and this fix would clear on a herdr hiccup
   * by a different door than the one the test above closes.
   */
  test("FACTORY-622: a processInfo that reports no foreground data is unknown, not empty — nothing is cleared", async () => {
    await withFullCycleHerd("FACTORY-924", async ({ f, herd, spec, lines }) => {
      await herd.spawn(spec);
      f.forgetAllAgents();
      f.client.pane.processInfo = async (q: { pane_id: string }) => ({ process_info: { pane_id: q.pane_id } });

      await herd.spawn(spec);
      expect(lines.some((l) => l.includes("of unknown occupancy") && l.includes("left untouched"))).toBe(true);
      expect(lines.some((l) => l.includes("cleared stale worker state"))).toBe(false);
      expect(f.started).toHaveLength(1);
    });
  });

  // FACTORY-426 (epic-authorized observability gap): before this, no outcome
  // of `resumeInPlace` was ever logged — a `"stuck"`/`"unresumable"`/`"failed"`
  // result with no `onResumePreserved`/`onResumeWaiting` subscriber wired
  // left zero trace that a resume was even attempted. Covers every outcome
  // through the ONE wrapper (`resumeInPlace`'s own try/catch around
  // `resumeInPlaceExclusive`), not by asserting every branch individually.
  test("RESUME_TAG: every outcome (and a thrown error) logs exactly one line, never zero", async () => {
    await withTempWorkspaces(async () => {
      const key = encodeAgentKey({ resourceProvider: "jira-work", ruleId: "jira-work", resourceId: "FACTORY-913" });
      const cwd = workspaceDirFor(key);
      const spec = { key, issuetype: "Task", summary: "s", parent: null };

      // "unresumable": no entry running at all — the cheapest outcome to reach.
      const lines: string[] = [];
      const f = statefulHerdr("w1:p1", cwd);
      const herd = new HerdrHerd(f.client, "http://x/mcp", instant, (l) => lines.push(l));
      const outcome = await herd.resumeInPlace(spec);
      expect(outcome).toBe("unresumable");
      expect(lines).toEqual([`${RESUME_TAG} ${key} unresumable`]);

      // A thrown error also logs exactly one line, distinguishable from a
      // clean outcome by its own wording, and still propagates the throw.
      const lines2: string[] = [];
      const f2 = statefulHerdr("w1:p1", cwd, "idle");
      f2.client.agent.list = async () => { throw new Error("herdr hiccup"); };
      const herd2 = new HerdrHerd(f2.client, "http://x/mcp", instant, (l) => lines2.push(l));
      await expect(herd2.resumeInPlace(spec)).rejects.toThrow("herdr hiccup");
      expect(lines2).toEqual([`${RESUME_TAG} ${key} threw — herdr hiccup`]);
    });
  });

  // FACTORY-525: the fix this ticket exists for — before it, `[resume] KEY
  // failed` carried no reason at all (the exact shape agentsafety's batch 1
  // report observed live). Covers both the log line AND the separate
  // `lastResumeFailureDetail` accessor `reconcileNow` (loop.ts) reads to
  // build its own respawn comment — one attempt, two consumers, same value.
  test("FACTORY-525: a 'failed' outcome's log line and lastResumeFailureDetail both carry the reason — a herdr error when the relaunch itself was rejected", async () => {
    await withTempWorkspaces(async () => {
      const key = encodeAgentKey({ resourceProvider: "jira-work", ruleId: "jira-work", resourceId: "FACTORY-914" });
      const cwd = workspaceDirFor(key);
      const spec = { key, issuetype: "Task", summary: "s", parent: null };
      await withResumableSession(cwd, "original-session", async (home) => {
        const lines: string[] = [];
        const f = statefulHerdr("w1:p1", cwd, "idle", { nameTaken: true });
        const herd = new HerdrHerd(f.client, "http://x/mcp", instant, (l) => lines.push(l), undefined, undefined, homeOf(home));
        const outcome = await herd.resumeInPlace(spec);
        expect(outcome).toBe("failed");
        expect(lines).toEqual([`${RESUME_TAG} ${key} failed — herdr error: agent.start: agent name already used [agent_name_taken]`]);
        // Read-once: the SAME detail the log line already rendered is still
        // there for a second, independent consumer (`reconcileNow`) — and is
        // gone after that read, so a later unrelated poll never sees a stale
        // detail from this attempt.
        expect(herd.lastResumeFailureDetail(key)).toBe("herdr error: agent.start: agent name already used [agent_name_taken]");
        expect(herd.lastResumeFailureDetail(key)).toBeUndefined();
      });
    });
  });

  // FACTORY-525: the OTHER half of "the herdr error and the exit status,
  // where they are available" — when herdr accepted the launch and nothing
  // threw, there is no herdr error and no exit code (herdr exposes none for
  // a pane's process), so the log line must say so explicitly rather than
  // printing nothing.
  test("FACTORY-525: a 'failed' outcome with nothing thrown (Claude simply didn't stay up) logs 'no exit status captured'", async () => {
    await withTempWorkspaces(async () => {
      const key = encodeAgentKey({ resourceProvider: "jira-work", ruleId: "jira-work", resourceId: "FACTORY-915" });
      const cwd = workspaceDirFor(key);
      const spec = { key, issuetype: "Task", summary: "s", parent: null };
      await withResumableSession(cwd, "original-session", async (home) => {
        const lines: string[] = [];
        const f = statefulHerdr("w1:p1", cwd, "idle", { crashesOnStart: true });
        const herd = new HerdrHerd(f.client, "http://x/mcp", instant, (l) => lines.push(l), undefined, undefined, homeOf(home));
        const outcome = await herd.resumeInPlace(spec);
        expect(outcome).toBe("failed");
        expect(lines).toEqual([`${RESUME_TAG} ${key} failed — no exit status captured`]);
      });
    });
  });

  // FACTORY-411/FACTORY-424 acceptance criterion 1: each candidate field
  // preserves the session on a Claude-vendor agent when it changes ALONE,
  // proven through the PRODUCTION spawn path — `HerdrHerd.staleIssues()`
  // detecting the drift as `resumable`, then the REAL `resumeInPlaceExclusive`
  // (`statefulHerdr`'s multi-step /exit-then-relaunch protocol, not an
  // isolated `agentStartParams` builder call) actually carrying it out. Not
  // an isolated-builder test — the exact gap this ticket's own acceptance
  // criteria name as having shipped a defect behind a green gate once
  // already.
  test("FACTORY-411/FACTORY-424: a permissionMode-only drift is detected as resumable by staleIssues(), and resumeInPlace() resumes the SAME session id with the NEW --permission-mode in its relaunch argv", async () => {
    await withTempWorkspaces(async () => {
      const key = encodeAgentKey({ resourceProvider: "jira-work", ruleId: "jira-work", resourceId: "FACTORY-911" });
      const cwd = workspaceDirFor(key);
      const spec = { key, issuetype: "Task" as const, summary: "s", parent: null, permissionMode: "bypassPermissions" as const };
      await withResumableSession(cwd, "original-session", async (home) => {
        const f = statefulHerdr("w1:p1", cwd);
        // Seeds the pane's OWN reported argv as though it was launched with
        // the OLD permission mode (the definition's own persisted intent,
        // written below, already calls for the new one) — the exact drift
        // shape the FACTORY-43 tests above exercise, here carried through to
        // an actual resumeInPlace() call rather than stopping at staleIssues().
        const oldArgv = spawnArgs({ key, issuetype: "task", summary: "", parent: null }, cwd);
        await f.client.agent.start({ args: oldArgv });
        f.started.length = 0; // that seeding call isn't part of what this test asserts on
        const { writeFileSync } = require("node:fs") as typeof import("node:fs");
        writeFileSync(join(cwd, ".butchr-permission-mode.json"), JSON.stringify("bypassPermissions"));

        const herd = new HerdrHerd(f.client, "http://x/mcp", instant, undefined, undefined, undefined, homeOf(home));
        const stale = await herd.staleIssues();
        expect(stale).toHaveLength(1);
        expect(stale[0]!.reason).toContain("--permission-mode bypassPermissions");
        expect(stale[0]!.resumable).toBe(true);

        const outcome = await herd.resumeInPlace(spec);
        expect(outcome).toBe("resumed");
        expect(f.sent).toEqual([{ text: "/exit" }, { keys: ["enter"] }]); // idle-checked, exited, never interrupted mid-turn
        expect(f.started).toHaveLength(1);
        expect(f.started[0]!.args).toContain("--resume");
        expect(f.started[0]!.args).toContain("original-session");
        expect(f.started[0]!.args).toContain("--permission-mode");
        expect(f.started[0]!.args).toContain("bypassPermissions");
        expect(workspaceSessionId(cwd)).toBe("original-session"); // SAME session, never rediscovered

        // The very next poll must not flag it stale again (FACTORY-43 no-loop
        // symmetry) — staleIssues() now sees the RELAUNCHED argv, which
        // already carries --permission-mode bypassPermissions.
        expect(await herd.staleIssues()).toEqual([]);
      });
    });
  });

  // Same production-path proof, for strictMcpConfig.
  test("FACTORY-411/FACTORY-424: a strictMcpConfig-only drift is detected as resumable by staleIssues(), and resumeInPlace() resumes the SAME session id with --strict-mcp-config in its relaunch argv", async () => {
    await withTempWorkspaces(async () => {
      const key = encodeAgentKey({ resourceProvider: "jira-work", ruleId: "jira-work", resourceId: "FACTORY-912" });
      const cwd = workspaceDirFor(key);
      const spec = { key, issuetype: "Task" as const, summary: "s", parent: null, strictMcpConfig: true };
      await withResumableSession(cwd, "original-session", async (home) => {
        const f = statefulHerdr("w1:p1", cwd);
        const oldArgv = spawnArgs({ key, issuetype: "task", summary: "", parent: null }, cwd);
        await f.client.agent.start({ args: oldArgv });
        f.started.length = 0;
        const { writeFileSync } = require("node:fs") as typeof import("node:fs");
        writeFileSync(join(cwd, ".butchr-strict-mcp-config.json"), JSON.stringify(true));

        const herd = new HerdrHerd(f.client, "http://x/mcp", instant, undefined, undefined, undefined, homeOf(home));
        const stale = await herd.staleIssues();
        expect(stale).toHaveLength(1);
        expect(stale[0]!.reason).toContain("--strict-mcp-config");
        expect(stale[0]!.resumable).toBe(true);

        const outcome = await herd.resumeInPlace(spec);
        expect(outcome).toBe("resumed");
        expect(f.started[0]!.args).toContain("--strict-mcp-config");
        expect(workspaceSessionId(cwd)).toBe("original-session");
        expect(await herd.staleIssues()).toEqual([]);
      });
    });
  });

  // FACTORY-411/FACTORY-424 (classification doc, Finding 2, point 2): the
  // mcpServers channel-flag case specifically — proves mcp.json's CONTENT is
  // already fresh once resumeInPlace() reports "resumed", not merely that
  // its own argv is correct. Against the pre-fix ordering (buildWorkspace()
  // only called after a confirmed-alive relaunch, and never regenerating
  // mcp.json at all on this path) the bound server would be MISSING from
  // mcp.json here.
  test("FACTORY-411/FACTORY-424: an mcpServers channel-flag add is detected as resumable, and resumeInPlace() writes the new binding into mcp.json BEFORE reporting resumed", async () => {
    await withTempWorkspaces(async () => {
      // Managed-session shape (filesystem/managed-sessions) — staleIssues()
      // only reads `mcpServers` back from the workspace's own persisted
      // `.butchr-mcp-servers.json` (`workspaceMcpServers`) for THIS shape;
      // a bare rule-engine spec instead needs a `mcpBindingsOf` callback
      // this test doesn't wire up.
      const key = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "managed-sessions", resourceId: absPath("etc", "defs", "factory-913.json") });
      const cwd = ensureWorkspaceDir(key);
      const binding = { name: "chan1", type: "http" as const, url: "http://example/mcp", channel: true };
      const spec = { key, issuetype: "Task" as const, summary: "s", parent: null, resource: absPath("etc", "defs", "factory-913.json"), mcpServers: [binding] };
      await withResumableSession(cwd, "original-session", async (home) => {
        const f = statefulHerdr("w1:p1", cwd);
        const oldArgv = spawnArgs({ key, issuetype: "managed-session", summary: "", parent: null, resource: absPath("etc", "defs", "factory-913.json") }, cwd);
        await f.client.agent.start({ args: oldArgv });
        f.started.length = 0;
        const { writeFileSync } = require("node:fs") as typeof import("node:fs");
        writeFileSync(join(cwd, ".butchr-mcp-servers.json"), JSON.stringify([binding]));

        const herd = new HerdrHerd(f.client, "http://x/mcp", instant, undefined, undefined, undefined, homeOf(home));
        const stale = await herd.staleIssues();
        expect(stale).toHaveLength(1);
        expect(stale[0]!.reason).toContain("--dangerously-load-development-channels");
        expect(stale[0]!.resumable).toBe(true);

        const outcome = await herd.resumeInPlace(spec);
        expect(outcome).toBe("resumed");
        const mcpJson = JSON.parse(readFileSync(join(cwd, "mcp.json"), "utf8"));
        expect(mcpJson.mcpServers.chan1).toEqual({ type: "http", url: "http://example/mcp" });
        expect(workspaceSessionId(cwd)).toBe("original-session");
      });
    });
  });

  // PR #560 review — the scope-creep case `isHerdrRestoredPane`'s own
  // --mcp-config discriminator exists to close: a pane butchr ITSELF
  // already relaunched via resumeInPlace() (so its live argv carries
  // `--resume <id>` PLUS the full flag set, `--mcp-config` included) that
  // LATER drifts for an unrelated, ordinary reason must still be classified
  // through FACTORY-411/#556's allowlist as before — never mistaken for a
  // herdr restore just because `--resume` is present. Without the
  // discriminator, this would be silently misclassified "herdr restored"
  // and relaunched via the identity path with the WRONG stated reason,
  // quietly widening resume-in-place's reach to any drift on any
  // already-`--resume`d pane — exactly what FACTORY-470 puts out of scope.
  test("staleIssues(): a pane already relaunched via resumeInPlace (carries --resume AND the full flag set) that later drifts is classified via the ordinary allowlist, never as 'herdr restored'", async () => {
    await withTempWorkspaces(async () => {
      const key = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "managed-sessions", resourceId: absPath("etc", "defs", "factory-918.json") });
      const cwd = ensureWorkspaceDir(key);
      const binding = { name: "chan1", type: "http" as const, url: "http://example/mcp", channel: true };
      persistDiscoveredSessionId(cwd, "already-resumed-session");
      const f = statefulHerdr("w1:p1", cwd);
      // The argv THIS workspace's own prior resumeInPlace() relaunch would
      // have produced — full flags (--mcp-config included), PLUS --resume.
      // Never a herdr-restore shape: butchr itself built this argv.
      const priorArgv = spawnArgs(
        { key, issuetype: "managed-session", summary: "", parent: null, resource: absPath("etc", "defs", "factory-918.json") },
        cwd, { provider: "claude", resumeSessionId: "already-resumed-session" },
      );
      await f.client.agent.start({ args: priorArgv.slice(1) }); // drop the leading "claude" positional; statefulHerdr re-adds it
      f.started.length = 0;
      // A later, unrelated drift: the definition now binds a NEW channel
      // server (FACTORY-411/#556's own allowed shape) that the persisted
      // `.butchr-mcp-servers.json` doesn't know about yet.
      const { writeFileSync } = require("node:fs") as typeof import("node:fs");
      writeFileSync(join(cwd, ".butchr-mcp-servers.json"), JSON.stringify([binding]));

      const herd = new HerdrHerd(f.client, "http://x/mcp", instant);
      const stale = await herd.staleIssues();
      expect(stale).toHaveLength(1);
      // The ordinary allowlist path fired (FACTORY-411/#556) — NOT this
      // ticket's herdr-restored identity path.
      expect(stale[0]!.reason).toContain("--dangerously-load-development-channels");
      expect(stale[0]!.reason).not.toContain("herdr restored");
      expect(stale[0]!.resumable).toBe(true); // still resumable — just via the allowlist, not the identity check
    });
  });

  // FACTORY-470/472 — the ticket's own headline case: herdr's OWN
  // restore-after-host-hard-reset (independent of butchr, outside this
  // repo's source) produces exactly this shape — a live claude process
  // whose observed argv is a bare `--resume <pre-boot-session-id>`, none of
  // butchr's own flags (permission-mode, mcp-config, channels) at all. This
  // is the "0 of 15 real panes" gap: under FACTORY-411/#556's allowlist
  // alone, its checkArgv reason always also lists `--mcp-config` (never on
  // that allowlist), so it would be `resumable: false` forever. Asserts the
  // identity path (`isHerdrRestoredPane`) is what actually classifies it —
  // not a coincidental allowlist pass — then relaunches with the FULL flag
  // set (same builder a fresh spawn uses, per this ticket's scope decision)
  // and proves no respawn loop across SEVERAL consecutive polls afterward
  // (FACTORY-470 review comment: the persisted-id equality this mechanism
  // relies on must not drift after the relaunch it itself triggers).
  test("FACTORY-470/472: a herdr-restored pane (bare `claude --resume <id>`, no butchr flags) is classified resumable via identity, relaunches with the full flag set, and is never flagged again across several consecutive polls", async () => {
    await withTempWorkspaces(async () => {
      const key = encodeAgentKey({ resourceProvider: "jira-work", ruleId: "jira-work", resourceId: "FACTORY-914" });
      const cwd = workspaceDirFor(key);
      const spec = { key, issuetype: "Task" as const, summary: "s", parent: null, agents: [{ harness: "claude" as const, model: "claude-opus-5", effort: "medium" as const }] };
      await withResumableSession(cwd, "original-session", async (home) => {
        const f = statefulHerdr("w1:p1", cwd);
        // Simulate herdr's own restore: a bare `claude --resume <id>` —
        // never something butchr itself built (contrast with every other
        // test in this file, which seeds `lastArgv` via a real
        // `spawnArgs(...)`/`agentStartParams(...)` call).
        await f.client.agent.start({ args: ["--resume", "original-session"] });
        f.started.length = 0;

        // FACTORY-491: this test proves the identity mechanism itself, not
        // the canary gate — enable BUTCHR_RESTORED_RESUME's policy for every
        // agent so the herdr-restored classification below is reachable
        // regardless of the {buddy, genius}-only production default.
        const herd = new HerdrHerd(f.client, "http://x/mcp", instant, undefined, { provider: "claude", restoredResume: "all" }, undefined, homeOf(home));
        const stale = await herd.staleIssues();
        expect(stale).toHaveLength(1);
        expect(stale[0]!.resumable).toBe(true);
        expect(stale[0]!.reason).toContain("herdr restored");
        // Confirm the IDENTITY path fired, not a coincidental allowlist
        // pass: this reason's missing-flag list includes --mcp-config,
        // which resumableArgvReason must still refuse on its own.
        const missing = stale[0]!.reason.match(/\(([^)]+)\)/)?.[1] ?? "";
        expect(missing).toContain("--mcp-config");
        expect(resumableArgvReason(`argv lacks ${missing}`, "claude")).toBe(false);

        const outcome = await herd.resumeInPlace(spec);
        expect(outcome).toBe("resumed");
        const args: string[] = f.started[0]!.args;
        expect(args[args.indexOf("--resume") + 1]).toBe("original-session");
        expect(args).toEqual(expect.arrayContaining([
          "--model", "claude-opus-5", "--effort", "medium",
          "--permission-mode", DEFAULT_PERMISSION_MODE,
          "--mcp-config", join(cwd, "mcp.json"),
        ]));
        expect(f.started[0]!.pane_id).toBe("w1:p1"); // same pane, never a new one
        expect(workspaceSessionId(cwd)).toBe("original-session");

        for (let poll = 0; poll < 3; poll++) {
          expect(await herd.staleIssues()).toEqual([]);
        }
      });
    });
  });

  // FACTORY-491 (director item 5) — the canary/kill switch, exercised
  // through `staleIssues()` end to end rather than only the pure
  // `restoredResumeEnabledFor` unit above: a managed session named
  // "buddy" is enabled by the {buddy, genius} default (the epic's own
  // reading of the ambiguous director steer), an ordinary jira-work
  // (non-managed-session) agent is NOT — the default policy names agents,
  // and only a managed session has one to check against.
  test("FACTORY-491: BUTCHR_RESTORED_RESUME defaulting to {buddy, genius} enables identity classification for a managed session named 'buddy'", async () => {
    await withTempWorkspaces(async () => {
      const key = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "managed-sessions", resourceId: absPath("etc", "defs", "buddy.json") });
      const cwd = ensureWorkspaceDir(key);
      await withResumableSession(cwd, "original-session", async () => {
        const f = statefulHerdr("w1:p1", cwd);
        await f.client.agent.start({ args: ["--resume", "original-session"] });
        f.started.length = 0;
        const herd = new HerdrHerd(f.client, "http://x/mcp", instant, undefined, { provider: "claude", restoredResume: new Set(["buddy", "genius"]) });
        const stale = await herd.staleIssues();
        expect(stale).toHaveLength(1);
        expect(stale[0]!.resumable).toBe(true);
        expect(stale[0]!.reason).toContain("herdr restored");
      });
    });
  });
  test("FACTORY-491: BUTCHR_RESTORED_RESUME defaulting to {buddy, genius} does NOT enable identity classification for an ordinary (non-managed-session) agent — it has no name to match", async () => {
    await withTempWorkspaces(async () => {
      const key = encodeAgentKey({ resourceProvider: "jira-work", ruleId: "jira-work", resourceId: "FACTORY-919" });
      const cwd = workspaceDirFor(key);
      await withResumableSession(cwd, "original-session", async () => {
        const f = statefulHerdr("w1:p1", cwd);
        await f.client.agent.start({ args: ["--resume", "original-session"] });
        f.started.length = 0;
        const herd = new HerdrHerd(f.client, "http://x/mcp", instant, undefined, { provider: "claude", restoredResume: new Set(["buddy", "genius"]) });
        const stale = await herd.staleIssues();
        expect(stale).toHaveLength(1);
        expect(stale[0]!.reason).not.toContain("herdr restored");
        expect(stale[0]!.resumable).toBe(false); // falls through to the ordinary allowlist, which refuses --mcp-config
      });
    });
  });
  test("FACTORY-491: BUTCHR_RESTORED_RESUME=off disables identity classification even for a canary-listed managed session", async () => {
    await withTempWorkspaces(async () => {
      const key = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "managed-sessions", resourceId: absPath("etc", "defs", "buddy.json") });
      const cwd = ensureWorkspaceDir(key);
      await withResumableSession(cwd, "original-session", async () => {
        const f = statefulHerdr("w1:p1", cwd);
        await f.client.agent.start({ args: ["--resume", "original-session"] });
        f.started.length = 0;
        const herd = new HerdrHerd(f.client, "http://x/mcp", instant, undefined, { provider: "claude", restoredResume: "off" });
        const stale = await herd.staleIssues();
        expect(stale).toHaveLength(1);
        expect(stale[0]!.reason).not.toContain("herdr restored");
        expect(stale[0]!.resumable).toBe(false);
      });
    });
  });
  // FACTORY-491 (director item 4, FACTORY-467 comment 27818 + FACTORY-73's
  // outstanding hazard question relayed on FACTORY-467, 2026-09-28
  // 23:05Z: whether a `launch_pending: true` entry can report
  // `agent_status: "idle"`, which would let `resumeInPlace` send `/exit`
  // to a claude that has not finished starting) — checked BEFORE the
  // identity match regardless of `agent_status`, so this guard holds even
  // in that unresolved case.
  test("FACTORY-491: a pane whose claude launch is still pending (launch_pending: true) is never classified herdr-restored, even when its argv already carries a matching --resume", async () => {
    await withTempWorkspaces(async () => {
      const key = encodeAgentKey({ resourceProvider: "jira-work", ruleId: "jira-work", resourceId: "FACTORY-920" });
      const cwd = workspaceDirFor(key);
      await withResumableSession(cwd, "original-session", async () => {
        const client = {
          agent: {
            list: async () => ({ agents: [{ agent: "claude", agent_status: "idle", cwd, pane_id: "w1:p1", workspace_id: "w1", launch_pending: true }] }),
          },
          pane: {
            processInfo: async () => ({ process_info: { pane_id: "w1:p1", foreground_processes: [{ pid: 1, name: "claude", argv: ["claude", "--resume", "original-session"] }] } }),
          },
        };
        const herd = new HerdrHerd(client as any, "http://x/mcp", instant, undefined, { provider: "claude", restoredResume: "all" });
        const stale = await herd.staleIssues();
        expect(stale).toHaveLength(1);
        expect(stale[0]!.reason).not.toContain("herdr restored");
        expect(stale[0]!.resumable).toBe(false); // falls through to the ordinary allowlist, which refuses --mcp-config
      });
    });
  });

  // FACTORY-470/472 (boss review on FACTORY-472, relaying FACTORY-312/PR
  // #551 — now MERGED, rebased onto here): resumeInPlaceExclusive is SHARED
  // between the pre-existing model/effort resume path and this ticket's
  // herdr-restored-pane path — a relaunch failing AFTER `/exit` has already
  // landed (the measured-live `agent_name_taken` race) is reachable through
  // EITHER. Before #551, this left `ManagedHerdrLifecycle`'s `this.active`
  // pointing at a gone pane forever (a permanent wedge — this file's own
  // git history has the version of this test that proved it). #551's floor
  // fix re-checks pane occupancy post-collision and reports `"failed"`
  // (never `"stuck"`) when the pane is confirmed empty, which routes
  // through `reconcileNow`'s existing stop-then-spawn fallback. Proven here
  // through the REAL `resumeInPlaceExclusive` + `spawnExclusive` code paths
  // (via `fakeHerdrFullCycle`, the same fixture PR #551's own recovery test
  // uses, extended only to track argv — see that fixture's own doc comment)
  // — this ticket's herdr-restored classification reaches the exact same
  // recovery #551 already proved for the model/effort path, not a new one.
  test("FACTORY-470/472 + FACTORY-312/#551: a herdr-restored pane's relaunch colliding with agent_name_taken AFTER /exit reports 'failed' and a later herd.stop()+herd.spawn() actually recovers it", async () => {
    await withTempWorkspaces(async () => {
      const { mkdtempSync, rmSync, mkdirSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
      const { tmpdir } = require("node:os") as typeof import("node:os");
      const { resolve } = require("node:path") as typeof import("node:path");
      const key = encodeAgentKey({ resourceProvider: "jira-work", ruleId: "jira-work", resourceId: "FACTORY-916" });
      const cwd = workspaceDirFor(key);
      const spec = { key, issuetype: "Task" as const, summary: "s", parent: null };
      const home = mkdtempSync(join(tmpdir(), "claude-home-herdr-restored-wedge-"));
      try {
        const projectDir = join(home, ".claude", "projects", resolve(cwd).replace(/[^a-zA-Z0-9]/g, "-"));
        mkdirSync(projectDir, { recursive: true });
        writeFileSync(join(projectDir, "original-session.jsonl"), "{}");
        persistDiscoveredSessionId(cwd, "original-session");

        const f = fakeHerdrFullCycle(cwd);
        // Seed the herdr-restore shape directly (this daemon never itself
        // launched this pane — no prior herd.spawn(), unlike PR #551's own
        // recovery test): a bare `claude --resume <id>`, none of butchr's
        // flags. Calling the real `agent.start` (not HerdrHerd's) sets
        // `state.agents`/`lastArgv`/`foreground` exactly as a real launch would.
        await f.client.agent.start({ pane_id: "w1:p1", args: ["--resume", "original-session"] });
        f.started.length = 0;

        // FACTORY-491: enable the canary for every agent — this test proves
        // the wedge/recovery mechanism, not the canary gate.
        const herd = new HerdrHerd(f.client, "http://x/mcp", instant, undefined, { provider: "claude", restoredResume: "all" }, undefined, homeOf(home));
        const stale = await herd.staleIssues();
        expect(stale).toHaveLength(1);
        expect(stale[0]!.resumable).toBe(true); // classified via this ticket's identity check

        f.setNameTakenOnNextStart();
        const outcome = await herd.resumeInPlace(spec);
        expect(outcome).toBe("failed"); // not "stuck" — #551's floor fix in effect
        expect(f.sent.some((s) => s.text === "/exit")).toBe(true); // confirms /exit really was sent before the collision
        // FACTORY-491 (director item 3): closed by id directly, inside
        // resumeInPlace itself — before reconcileNow's own fallthrough
        // (mirrored below) ever runs its separate identity-matched close.
        expect(f.closed).toEqual(["w1:p1"]);

        // herdr eventually forgets the dead pane's registration (see
        // fakeHerdrFullCycle's own doc comment for why this is the honest
        // way to reach the state this test cares about), then
        // reconcileNow's ACTUAL contract for a "failed" outcome —
        // herd.stop() THEN herd.spawn() — mirrored directly.
        f.forgetAllAgents();
        await herd.stop(spec.key);
        await herd.spawn(spec);

        expect(f.started).toHaveLength(2); // the collision attempt, then the recovering spawn — f.started was reset after seeding, so this counts only the two attempts this test drives
        expect(f.state.agents).toHaveLength(1);
        expect(f.state.agents[0]!.pane_id).not.toBe("w1:p1"); // a genuinely NEW pane — an honest fresh restart, since the herdr-restored session's own history is what was actually lost here (not this ticket's scope to prevent — only a CLEAN relaunch collision is)
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
  });

  // FACTORY-470/472 (epic review, FACTORY-470 comment 27586): the SAME
  // question for the OTHER door of `resumeInPlaceExclusive`'s
  // `startManagedAgent` catch — any error that is NOT `agent_name_taken`.
  // #551's floor fix applies the identical `postExitOutcome()` re-check to
  // this branch too: with the pane confirmed empty, ANY relaunch error now
  // reports `"failed"` (never a raw propagated throw), so it recovers the
  // same way as the agent_name_taken door above.
  test("FACTORY-470/472 + FACTORY-312/#551: a herdr-restored pane's relaunch throwing a non-agent_name_taken error AFTER /exit ALSO reports 'failed' and recovers the same way", async () => {
    await withTempWorkspaces(async () => {
      const { mkdtempSync, rmSync, mkdirSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
      const { tmpdir } = require("node:os") as typeof import("node:os");
      const { resolve } = require("node:path") as typeof import("node:path");
      const key = encodeAgentKey({ resourceProvider: "jira-work", ruleId: "jira-work", resourceId: "FACTORY-917" });
      const cwd = workspaceDirFor(key);
      const spec = { key, issuetype: "Task" as const, summary: "s", parent: null };
      const home = mkdtempSync(join(tmpdir(), "claude-home-herdr-restored-wedge-2-"));
      try {
        const projectDir = join(home, ".claude", "projects", resolve(cwd).replace(/[^a-zA-Z0-9]/g, "-"));
        mkdirSync(projectDir, { recursive: true });
        writeFileSync(join(projectDir, "original-session.jsonl"), "{}");
        persistDiscoveredSessionId(cwd, "original-session");

        const f = fakeHerdrFullCycle(cwd);
        await f.client.agent.start({ pane_id: "w1:p1", args: ["--resume", "original-session"] });
        f.started.length = 0;

        // FACTORY-491: enable the canary for every agent — this test proves
        // the wedge/recovery mechanism, not the canary gate.
        const herd = new HerdrHerd(f.client, "http://x/mcp", instant, undefined, { provider: "claude", restoredResume: "all" }, undefined, homeOf(home));
        const stale = await herd.staleIssues();
        expect(stale[0]!.resumable).toBe(true); // classified via this ticket's identity check

        f.setOtherErrorOnNextStart();
        const outcome = await herd.resumeInPlace(spec);
        expect(outcome).toBe("failed"); // never a raw propagated throw — #551's floor fix applies to this door too
        // FACTORY-491 (director item 3): closed by id directly, inside resumeInPlace itself.
        expect(f.closed).toEqual(["w1:p1"]);

        f.forgetAllAgents();
        await herd.stop(spec.key);
        await herd.spawn(spec);

        expect(f.started).toHaveLength(2); // the collision attempt, then the recovering spawn
        expect(f.state.agents).toHaveLength(1);
        expect(f.state.agents[0]!.pane_id).not.toBe("w1:p1");
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
  });

  // FACTORY-470/472 acceptance criterion 3/4: a pane that LOOKS
  // herdr-restored (a bare `--resume <id>` argv) but whose transcript is
  // genuinely gone must still fail safe — FACTORY-418's invalidation is
  // unconditional, whatever detection path found the pane resumable-looking.
  test("FACTORY-470/472: a herdr-restored-looking pane with a genuinely missing transcript falls back to unresumable, never relaunched", async () => {
    await withTempWorkspaces(async () => {
      const { mkdtempSync, rmSync } = require("node:fs") as typeof import("node:fs");
      const { tmpdir } = require("node:os") as typeof import("node:os");
      const key = encodeAgentKey({ resourceProvider: "jira-work", ruleId: "jira-work", resourceId: "FACTORY-915" });
      const cwd = workspaceDirFor(key);
      persistDiscoveredSessionId(cwd, "vanished-session"); // persisted, but no transcript file exists anywhere
      const home = mkdtempSync(join(tmpdir(), "claude-home-empty-"));
      try {
        const f = statefulHerdr("w1:p1", cwd);
        await f.client.agent.start({ args: ["--resume", "vanished-session"] });
        f.started.length = 0;
        // FACTORY-491: enable the canary for every agent — this test proves
        // the transcript-gone fail-safe, not the canary gate.
        const herd = new HerdrHerd(f.client, "http://x/mcp", instant, undefined, { provider: "claude", restoredResume: "all" }, undefined, homeOf(home));
        const stale = await herd.staleIssues();
        expect(stale).toHaveLength(1);
        expect(stale[0]!.resumable).toBe(true); // the identity match alone can't know the transcript is gone
        const outcome = await herd.resumeInPlace({ key, issuetype: "Task", summary: "s", parent: null });
        expect(outcome).toBe("unresumable-transcript-gone"); // resumeInPlaceExclusive's own transcript check catches it — id was known, only the transcript is gone
        expect(f.started).toEqual([]); // never attempted a relaunch
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
  });
});
