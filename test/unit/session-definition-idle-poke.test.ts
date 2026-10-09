import { describe, expect, test } from "bun:test";
import {
  parseSessionDefinition, sessionDefinitionProblems,
} from "../../src/resources/session-definition.js";
import { startManagedSessionsLoop } from "../../src/daemon/session-definitions-loop.js";
import { encodeAgentKey } from "../../src/rules/agent-key.js";
import type { Herd } from "../../src/agents/herd.js";
import type { SpawnSpec } from "../../src/agents/workspace.js";
import type { FilesystemResource } from "../../src/resources/filesystem.js";
import { absPath } from "../helpers/abs-path";

const HOME = absPath("home", "tester");
const good = () => ({
  workingDirectory: absPath("repo", "project"), brief: "Tend this repo.", vendor: "claude", tier: "tier1", permissionMode: "auto",
});

/**
 * FACTORY-926 (epic FACTORY-836) — the SessionDefinition schema's idle-poke
 * fields reuse `Rule.idlePokeMinutes`/`idlePokeMessage`/`idlePokeEnabled`
 * (src/rules/rules.ts) verbatim: same names, same validation idiom, same
 * "idlePokeEnabled always resolves, the other two never do" split. These
 * tests mirror test/unit/rules.test.ts's own "per-role idle-poke defaults"
 * describe block so a reviewer can compare the two shapes directly.
 */
describe("SessionDefinition idle-poke fields: same shape as Rule's (FACTORY-844/846)", () => {
  test("idlePokeMinutes/idlePokeMessage stay absent when omitted; idlePokeEnabled always resolves, to true", () => {
    expect(sessionDefinitionProblems(good(), "def")).toEqual([]);
    const parsed = parseSessionDefinition(good(), "def", HOME);
    expect(parsed.idlePokeMinutes).toBeUndefined();
    expect(parsed.idlePokeMessage).toBeUndefined();
    expect(parsed.idlePokeEnabled).toBe(true);
  });

  test("a definition may set idlePokeMinutes/idlePokeMessage/idlePokeEnabled explicitly", () => {
    const doc = { ...good(), idlePokeMinutes: 1440, idlePokeMessage: " check your director queue ", idlePokeEnabled: true };
    expect(sessionDefinitionProblems(doc, "def")).toEqual([]);
    const parsed = parseSessionDefinition(doc, "def", HOME);
    expect(parsed.idlePokeMinutes).toBe(1440);
    expect(parsed.idlePokeMessage).toBe("check your director queue");
    expect(parsed.idlePokeEnabled).toBe(true);
  });

  test("idlePokeEnabled: false is accepted and kept — the shape a shipped utility-session definition (dialog-monitor/genius/buddy) uses", () => {
    const doc = { ...good(), idlePokeEnabled: false };
    expect(sessionDefinitionProblems(doc, "def")).toEqual([]);
    const parsed = parseSessionDefinition(doc, "def", HOME);
    expect(parsed.idlePokeEnabled).toBe(false);
  });

  test("rejects a non-positive or non-finite idlePokeMinutes", () => {
    for (const bad of [0, -5, NaN, Infinity]) {
      expect(sessionDefinitionProblems({ ...good(), idlePokeMinutes: bad }, "def")).toEqual(["def.idlePokeMinutes must be a positive number"]);
    }
  });

  test("a fractional idlePokeMinutes is accepted", () => {
    const parsed = parseSessionDefinition({ ...good(), idlePokeMinutes: 2.5 }, "def", HOME);
    expect(parsed.idlePokeMinutes).toBe(2.5);
  });

  test('rejects a blank or non-string idlePokeMessage — empty means rejected, not "no text" (use idlePokeEnabled: false for that)', () => {
    for (const bad of ["", "   ", 7]) {
      expect(sessionDefinitionProblems({ ...good(), idlePokeMessage: bad }, "def")).toEqual(["def.idlePokeMessage must be a non-empty string"]);
    }
  });

  test("rejects a non-boolean idlePokeEnabled", () => {
    expect(sessionDefinitionProblems({ ...good(), idlePokeEnabled: "false" }, "def")).toEqual(["def.idlePokeEnabled must be a boolean"]);
  });
});

/**
 * FACTORY-926 acceptance 4 — "a test that would FAIL if a utility session
 * (dialog-monitor/genius/buddy equivalent) received a poke." Two
 * independent guards, matching the two independent walls the ticket's own
 * safety-question comment found (FACTORY-942, posted before any schema
 * change):
 *
 * 1. A STRUCTURAL guard on `src/daemon/index.ts` (which cannot be
 *    unit-tested by importing it — see test/unit/notify-deliver-seams.test.ts's
 *    own top comment for why — so this pins its SOURCE TEXT, the same
 *    technique that file already uses) and on
 *    `src/daemon/session-definitions-loop.ts`'s own `ManagedSessionsLoopDeps`:
 *    neither ever names `idlePoke`/`syncLabels`/`idlePokeRuleConfig`. If a
 *    future change wired the idle-poke engine into the managed-sessions
 *    loop, this guard fails immediately, naming exactly what changed.
 * 2. A BEHAVIOURAL guard: `startManagedSessionsLoop` run for real (production
 *    code, unmodified) against a definition that sets `idlePokeEnabled: true`
 *    and a short `idlePokeMinutes` — i.e. flipping the shipped utility-session
 *    flag to the "on" value this ticket's shipped config never uses — across
 *    many poll intervals, asserting `deliver` (the only channel a
 *    managed-session agent can ever be nudged through, per
 *    `ManagedSessionsLoopDeps.deliver`'s own doc comment: there is no Jira
 *    ticket to comment on) is never called. This is the regression acceptance
 *    4 names directly: a path that bypasses the flag would show up here as a
 *    `deliver` call this test never expects.
 */
const indexSrc = await Bun.file(new URL("../../src/daemon/index.ts", import.meta.url)).text();
const loopSrc = await Bun.file(new URL("../../src/daemon/session-definitions-loop.ts", import.meta.url)).text();

function sliceAfter(src: string, marker: string, length: number): string {
  const i = src.indexOf(marker);
  expect(i, `expected to find ${JSON.stringify(marker)}`).toBeGreaterThan(-1);
  return src.slice(i, i + length);
}

describe("FACTORY-926 acceptance 4: a utility session cannot receive a poke, through any path", () => {
  test("structural: ManagedSessionsLoopDeps (session-definitions-loop.ts) names no idle-poke field", () => {
    const start = loopSrc.indexOf("export interface ManagedSessionsLoopDeps {");
    const end = loopSrc.indexOf("\nexport function startManagedSessionsLoop(");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = loopSrc.slice(start, end);
    expect(block).not.toMatch(/idlePoke/i);
    expect(block).not.toContain("syncLabels");
  });

  test("structural: session-definitions-loop.ts never calls the idle-poke engine or syncLabels", () => {
    expect(loopSrc).not.toMatch(/idlePoke/i);
    expect(loopSrc).not.toContain("syncLabels");
  });

  test("structural: the startManagedSessionsLoop({...}) call site in index.ts passes no idle-poke dep", () => {
    const block = sliceAfter(indexSrc, "startManagedSessionsLoop({", indexSrc.indexOf("\n});", indexSrc.indexOf("startManagedSessionsLoop({")) - indexSrc.indexOf("startManagedSessionsLoop({") + 4);
    expect(block).not.toMatch(/idlePoke/i);
    expect(block).not.toContain("syncLabels:");
  });

  const res = (path: string): FilesystemResource => ({ path, kind: "file", name: path.split("/").pop()!, size: 10, mtimeMs: 1000 });
  const utilitySessionDef = () => ({
    workingDirectory: "/repo/project", brief: "You are dialog-monitor.", vendor: "claude", tier: "tier1", permissionMode: "default",
    // Deliberately the OPPOSITE of the shipped default (idlePokeEnabled:
    // false) and a very short interval — if ANY path read and acted on
    // this, a poke would show up almost immediately across the polls this
    // test waits through.
    idlePokeEnabled: true, idlePokeMinutes: 1,
  });

  test("behavioural: startManagedSessionsLoop never calls deliver for an idle managed session, even with idlePokeEnabled:true/idlePokeMinutes:1 on its definition", async () => {
    const agentKey = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "managed-sessions", resourceId: "/defs/dialog-monitor.json" });
    const running = new Set([agentKey]);
    const delivered: Array<{ agent: string; resource: string; message: string }> = [];
    const herd: Herd = {
      async runningIssues() { return [...running]; },
      async staleIssues() { return []; },
      async spawn(sp: SpawnSpec) { running.add(sp.key); },
      async stop(i) { running.delete(i); },
      async paneFor(i) { return running.has(i) ? `pane-${i}` : null; },
      async nudge() { return { delivered: true }; },
      async resumeInPlace() { return "resumed" as const; },
    };

    let polls = 0;
    const stop = startManagedSessionsLoop({
      root: "/defs",
      herd,
      deliver: async (agent, resource, message) => { delivered.push({ agent, resource, message }); },
      list: async () => { polls += 1; return [res("/defs/dialog-monitor.json")]; },
      read: async () => JSON.stringify(utilitySessionDef()),
      log: () => {},
      intervalMs: 5,
      onPollSuccess: () => {},
    });

    const start = Date.now();
    while (polls < 20 && Date.now() - start < 2000) await new Promise((r) => setTimeout(r, 10));
    stop();

    expect(polls).toBeGreaterThanOrEqual(20); // the loop actually ran, this isn't a false pass from zero polls
    expect(delivered).toEqual([]);
  });
});
