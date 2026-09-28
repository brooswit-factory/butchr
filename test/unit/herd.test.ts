import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HerdrError, processProviderAvailability } from "@brooswit/drovr";
import { HerdrHerd, agentNameFor, resumableArgvReason, PANE_READY_WAIT_MS, PANE_READINESS_TIMEOUT_MS, SPAWN_TAG } from "../../src/agents/herd.js";
import type { Herd } from "../../src/agents/herd.js";
import { reconcileNow, RespawnGuard } from "../../src/daemon/loop.js";
import { buildWorkspace, ensureWorkspaceDir, workspaceDirFor, workspaceRoot, workspaceSessionId, workspaceModel, workspaceEffort, persistDiscoveredSessionId } from "../../src/agents/workspace.js";
import { spawnArgs, DEFAULT_PERMISSION_MODE } from "../../src/agents/argv.js";
import { encodeAgentKey, encodeQueryAgentKey } from "../../src/rules/agent-key.js";
import { specForSessionDefinition, builtinManagedSessionsRule } from "../../src/rules/session-definition-type.js";
import { effectiveAgent } from "../../src/resources/session-definition.js";
import { createAdmissionController, ADMISSION2_TAG } from "../../src/agents/admission.js";
import { rcUsernameFor } from "../../src/accounts/identity.js";

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
    const key = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "managed-sessions", resourceId: "/defs/a.json" });
    await herd.spawn({
      key, issuetype: "managed-session", summary: "s", parent: null,
      brief: "Keep this repo's docs and dependency versions current.",
      cwd: "/repo/some-project",
      agents: [{ harness: "claude", model: "sonnet" }],
    });
    expect(f.started.length).toBe(1); // did NOT throw — this is the regression this test exists to catch
    expect(f.started[0].args[0]).toContain("/repo/some-project");
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
      const key = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "managed-sessions", resourceId: "/etc/defs/a.json" });
      const cwd = ensureWorkspaceDir(key);
      const mcpServers = [{ name: "mud-bridge", type: "http" as const, url: "https://mud.internal/mcp", channel: true }];
      writeFileSync(join(cwd, ".butchr-mcp-servers.json"), JSON.stringify(mcpServers));
      // Built via the SAME spawnArgs a real spawn (and staleIssues' own
      // "expected" reconstruction) uses, so the channel-flag joining format
      // is guaranteed consistent rather than hand-guessed here.
      const goodArgv = ["claude", ...spawnArgs({ key, issuetype: "managed-session", summary: "s", parent: null, resource: "/etc/defs/a.json", mcpServers }, cwd)];
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
      const key = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "managed-sessions", resourceId: "/etc/defs/a.json" });
      const cwd = ensureWorkspaceDir(key);
      const mcpServers = [{ name: "mud-bridge", type: "http" as const, url: "https://mud.internal/mcp", channel: true }];
      writeFileSync(join(cwd, ".butchr-mcp-servers.json"), JSON.stringify(mcpServers));
      // Missing the server:mud-bridge channel flag the definition now calls for.
      const staleArgv = ["claude", ...spawnArgs({ key, issuetype: "managed-session", summary: "s", parent: null, resource: "/etc/defs/a.json" }, cwd)];
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
      const key = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "managed-sessions", resourceId: "/etc/defs/a.json" });
      const cwd = ensureWorkspaceDir(key);
      writeFileSync(join(cwd, ".butchr-permission-mode.json"), JSON.stringify("auto"));
      // Built via the SAME spawnArgs a real spawn (and staleIssues' own
      // "expected" reconstruction) uses, so the flag value is guaranteed
      // consistent rather than hand-guessed here.
      const goodArgv = ["claude", ...spawnArgs({ key, issuetype: "managed-session", summary: "s", parent: null, resource: "/etc/defs/a.json", permissionMode: "auto" }, cwd)];
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
      const key = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "managed-sessions", resourceId: "/etc/defs/a.json" });
      const cwd = ensureWorkspaceDir(key);
      writeFileSync(join(cwd, ".butchr-permission-mode.json"), JSON.stringify("auto"));
      // Missing the --permission-mode auto flag the persisted definition now calls for.
      const staleArgv = ["claude", ...spawnArgs({ key, issuetype: "managed-session", summary: "s", parent: null, resource: "/etc/defs/a.json" }, cwd)];
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
      const key = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "managed-sessions", resourceId: "/etc/defs/a.json" });
      const cwd = ensureWorkspaceDir(key);
      writeFileSync(join(cwd, ".butchr-strict-mcp-config.json"), JSON.stringify(true));
      const goodArgv = ["claude", ...spawnArgs({ key, issuetype: "managed-session", summary: "s", parent: null, resource: "/etc/defs/a.json", strictMcpConfig: true }, cwd)];
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
      const key = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "managed-sessions", resourceId: "/etc/defs/a.json" });
      const cwd = ensureWorkspaceDir(key);
      writeFileSync(join(cwd, ".butchr-strict-mcp-config.json"), JSON.stringify(true));
      const staleArgv = ["claude", ...spawnArgs({ key, issuetype: "managed-session", summary: "s", parent: null, resource: "/etc/defs/a.json" }, cwd)];
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
      const key = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "managed-sessions", resourceId: "/etc/defs/a.json" });
      const spec = { key, issuetype: "managed-session", summary: "s", parent: null, resource: "/etc/defs/a.json" };
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
      const key = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "managed-sessions", resourceId: "/etc/defs/a.json" });
      const spec = { key, issuetype: "managed-session", summary: "s", parent: null, resource: "/etc/defs/a.json" };
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
      const key = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "managed-sessions", resourceId: "/etc/defs/a.json" });
      const cwd = ensureWorkspaceDir(key);
      writeFileSync(join(cwd, ".butchr-model.json"), JSON.stringify("fable"));
      writeFileSync(join(cwd, ".butchr-effort.json"), JSON.stringify("xhigh"));
      const goodArgv = ["claude", ...spawnArgs({ key, issuetype: "managed-session", summary: "s", parent: null, resource: "/etc/defs/a.json" }, cwd)];
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
      const key = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "managed-sessions", resourceId: "/etc/defs/a.json" });
      const cwd = ensureWorkspaceDir(key);
      // Spawned a while ago at Sonnet/medium...
      writeFileSync(join(cwd, ".butchr-model.json"), JSON.stringify("sonnet"));
      writeFileSync(join(cwd, ".butchr-effort.json"), JSON.stringify("medium"));
      const staleArgv = ["claude", ...spawnArgs({ key, issuetype: "managed-session", summary: "s", parent: null, resource: "/etc/defs/a.json" }, cwd)];
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
      const key = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "managed-sessions", resourceId: "/etc/defs/a.json" });
      const cwd = ensureWorkspaceDir(key);
      // The respawn already happened: buildWorkspace persisted the NEW resolved model/effort...
      writeFileSync(join(cwd, ".butchr-model.json"), JSON.stringify("fable"));
      writeFileSync(join(cwd, ".butchr-effort.json"), JSON.stringify("xhigh"));
      // ...and the running process now reflects it too (argv itself never carries --model/--effort comparison, but the workspace persistence does).
      const freshArgv = ["claude", ...spawnArgs({ key, issuetype: "managed-session", summary: "s", parent: null, resource: "/etc/defs/a.json" }, cwd)];
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
      const rule = builtinManagedSessionsRule("/etc/defs");
      const resourcePath = "/etc/defs/admin-agentcost.json";
      const agentKey = encodeAgentKey({ resourceProvider: "filesystem", ruleId: rule.id, resourceId: resourcePath });
      // The REAL resolver (effectiveAgent) and REAL spec builder (specForSessionDefinition) —
      // exactly what searchSessionDefinitions/specForSessionDefinitionUnit run in production.
      const definitionAt100_70 = { workingDirectory: "/repo/admin-agentcost", brief: "Track spend.", vendor: "claude" as const, modelPower: 100, effort: 70, permissionMode: "default" as const, execution: "swarm" as const, account: "none" as const, role: "worker" as const, frozen: false };
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
        const key = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "managed-sessions", resourceId: "/etc/defs/a.json" });
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
        const key = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "managed-sessions", resourceId: "/etc/defs/a.json" });
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
      const key = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "managed-sessions", resourceId: "/etc/defs/a.json" });
      const cwd = ensureWorkspaceDir(key);
      writeFileSync(join(cwd, ".butchr-model.json"), JSON.stringify("sonnet"));
      const argv = ["claude", ...spawnArgs({ key, issuetype: "managed-session", summary: "s", parent: null, resource: "/etc/defs/a.json" }, cwd)];
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
      const running = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "repos", resourceId: "/home/one/brooswit-factory/rinth" });
      const incoming = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "repos", resourceId: "/srv/two/brooswit-factory/rinth" });
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
      const running = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "repos", resourceId: "/srv/two/brooswit-factory/rinth" });
      const incoming = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "repos", resourceId: "/home/one/brooswit-factory/rinth" });
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
    const f = fakeHerdr([{ pane_id: "p1", cwd: "/home/someone/unrelated-project", workspace_id: "wX" }]);
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
      const a = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "repos", resourceId: "/home/one/brooswit-factory/rinth" });
      const b = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "repos", resourceId: "/srv/two/brooswit-factory/rinth" });
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
  function statefulHerdr(pane: string, cwd: string, initialStatus: "idle" | "working" | "done" = "idle", options: { crashesOnStart?: boolean; nameTaken?: boolean } = {}) {
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
    const client = {
      agent: {
        list: async () => ({ agents: [{ agent: foreground === "claude" ? "claude" : undefined, agent_status: status, cwd, pane_id: pane, workspace_id: "w1" }] }),
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
        processInfo: async () => ({ process_info: { pane_id: pane, foreground_processes: [foreground === "claude" ? { ...CLAUDE_PROC, argv: lastArgv } : SHELL_PROC] } }),
        sendText: async (p: any) => { sent.push({ text: p.text }); },
        sendKeys: async (p: any) => { sent.push({ keys: p.keys }); foreground = "shell"; },
      },
    };
    return { client: client as any, sent, started };
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
        expect(f.started).toHaveLength(1); // the attempt WAS made
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
  // `agent_name_taken`. This must resolve to the SAME safe, non-destructive
  // "stuck" outcome a pane that never left claude's foreground gets, not a
  // raw thrown failure.
  test("stuck (via agent_name_taken): the relaunch is rejected because the old process still holds the pane's agent name — resolves to 'stuck', never throws, never persists", async () => {
    await withTempWorkspaces(async () => {
      const key = encodeAgentKey({ resourceProvider: "jira-work", ruleId: "jira-work", resourceId: "FACTORY-908" });
      const cwd = workspaceDirFor(key);
      const spec = { key, issuetype: "Task", summary: "s", parent: null };
      await withResumableSession(cwd, "original-session", async (home) => {
        const f = statefulHerdr("w1:p1", cwd, "idle", { nameTaken: true });
        const herd = new HerdrHerd(f.client, "http://x/mcp", instant, undefined, undefined, undefined, homeOf(home));
        const outcome = await herd.resumeInPlace(spec);
        expect(outcome).toBe("stuck");
        expect(workspaceSessionId(cwd)).toBe("original-session");
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
  test("unresumable: a persisted session id whose transcript is missing — never attempts /exit", async () => {
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
        expect(outcome).toBe("unresumable");
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
      const key = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "managed-sessions", resourceId: "/etc/defs/factory-913.json" });
      const cwd = ensureWorkspaceDir(key);
      const binding = { name: "chan1", type: "http" as const, url: "http://example/mcp", channel: true };
      const spec = { key, issuetype: "Task" as const, summary: "s", parent: null, resource: "/etc/defs/factory-913.json", mcpServers: [binding] };
      await withResumableSession(cwd, "original-session", async (home) => {
        const f = statefulHerdr("w1:p1", cwd);
        const oldArgv = spawnArgs({ key, issuetype: "managed-session", summary: "", parent: null, resource: "/etc/defs/factory-913.json" }, cwd);
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
});
