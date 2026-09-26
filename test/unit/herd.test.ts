import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HerdrError, processProviderAvailability } from "@brooswit/drovr";
import { HerdrHerd, agentNameFor, PANE_READY_WAIT_MS, PANE_READINESS_TIMEOUT_MS, SPAWN_TAG } from "../../src/agents/herd.js";
import type { Herd } from "../../src/agents/herd.js";
import { reconcileNow, RespawnGuard } from "../../src/daemon/loop.js";
import { workspaceDirFor, workspaceRoot } from "../../src/agents/workspace.js";
import { spawnArgs } from "../../src/agents/argv.js";
import { encodeAgentKey } from "../../src/rules/agent-key.js";
import { createAdmissionController, ADMISSION2_TAG } from "../../src/agents/admission.js";

const clearQuota = () => {
  processProviderAvailability.clear({ provider: "claude", accountId: "default" });
  processProviderAvailability.clear({ provider: "codex", accountId: "default" });
};
beforeEach(clearQuota);
afterEach(clearQuota);

/** One foreground process, as herdr's `pane.process_info` reports it. */
interface FakeProcess { pid: number; argv?: string[] | null; name?: string }

function fakeHerdr(agents: Array<{ name?: string; pane_id: string; cwd?: string | undefined }>) {
  const started: any[] = []; const closed: string[] = []; let createdCwd: string | undefined;
  const client = {
    agent: { list: async () => ({ agents: agents.map((a) => {
      // Names are key hashes, so started agents carry their workspace's cwd; fixtures seeded by name still map `butchr-kan-1` to KAN-1.
      const cwd = a.cwd ?? (a.name?.startsWith("butchr-") ? join(workspaceRoot(), a.name.slice("butchr-".length).toUpperCase()) : undefined);
      return cwd ? { ...a, agent: "claude", cwd } : a;
    }) }), start: async (p: any) => { started.push(p); agents.push({ name: p.name, pane_id: p.pane_id, cwd: createdCwd }); } },
    pane: { close: async (id: string) => { closed.push(id); }, read: async () => ({ read: { text: "" } }) },
    workspace: { create: async (p: any) => { createdCwd = p.cwd; return { root_pane: { pane_id: "w9:p1" } }; } },
  };
  return { client: client as any, started, closed };
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
    expect(f.started[0].args).toContain("bypassPermissions");
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
    expect(lines).toEqual([`${SPAWN_TAG} KAN-7 succeeded — pane w9:p1 origin=spawn`]);
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
    expect(stale[0]!.reason).toContain("--permission-mode bypassPermissions");
    expect(stale[0]!.reason).toContain(`--mcp-config ${cwd}/mcp.json`);
    expect(stale[0]!.reason).toContain("--dangerously-load-development-channels server:butchr");
    expect(stale[0]!.observedArgv).toEqual(argv);
  });

  test("a claude process carrying the full flag set -> not stale", async () => {
    const cwd = join(workspaceRoot(), "KAN-783");
    const goodArgv = ["claude", "follow your CLAUDE.md", "--model", "sonnet", "--permission-mode", "bypassPermissions", "--mcp-config", `${cwd}/mcp.json`, "--dangerously-load-development-channels", "server:butchr"];
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
      const cwd = workspaceDirFor(key);
      mkdirSync(cwd, { recursive: true });
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
      const cwd = workspaceDirFor(key);
      mkdirSync(cwd, { recursive: true });
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

  test("no cwd reported for the agent -> unknown, not stale (never even calls pane.process_info)", async () => {
    const { client, calls } = fakeHerdrWithCwd([{ name: "butchr-kan-783", pane_id: "w1:p1", cwd: null }], { "w1:p1": ok([{ pid: 1, argv: ["claude", "--resume", "x"], name: "claude" }]) });
    const herd = new HerdrHerd(client, "http://x/mcp", instant);
    expect(await herd.staleIssues()).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("pane.process_info rejects -> unknown, not stale, and does not abort the sweep for other issues", async () => {
    const cwd = join(workspaceRoot(), "KAN-783");
    const otherCwd = join(workspaceRoot(), "KAN-9");
    const goodArgv = ["claude", "follow your CLAUDE.md", "--model", "sonnet", "--permission-mode", "bypassPermissions", "--mcp-config", `${otherCwd}/mcp.json`, "--dangerously-load-development-channels", "server:butchr"];
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
    const goodArgv = ["claude", "follow your CLAUDE.md", "--model", "sonnet", "--permission-mode", "bypassPermissions", "--mcp-config", `${cwd}/mcp.json`, "--dangerously-load-development-channels", "server:butchr"];
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
    expect(f.started[0].args).toContain("bypassPermissions");
    expect(f.started[0].args[f.started[0].args.indexOf("--mcp-config") + 1]).toBe(dir + "/mcp.json");

    // b) the notice was posted exactly once and starts with [butchr:respawn]'s reason shape
    expect(notices.length).toBe(1);
    expect(notices[0]!.issue).toBe("KAN-783");
    expect(notices[0]!.reason.startsWith("argv lacks")).toBe(true);
    expect(notices[0]!.observedArgv).toEqual(argv);
  });

  test("b) a second pass, now with process-info showing the full argv, closes/starts nothing", async () => {
    const goodArgv = ["claude", "follow your CLAUDE.md", "--model", "sonnet", "--permission-mode", "bypassPermissions", "--mcp-config", `${dir}/mcp.json`, "--dangerously-load-development-channels", "server:butchr"];
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
    const goodArgv = ["claude", "follow your CLAUDE.md", "--model", "sonnet", "--permission-mode", "bypassPermissions", "--mcp-config", `${dir}/mcp.json`, "--dangerously-load-development-channels", "server:butchr"];
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
