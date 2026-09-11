import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { panesFor, groupOwnedPanes, aggregateVerdict } from "../../src/agents/residency-census.js";
import { HerdrHerd } from "../../src/agents/herd.js";
import { workspaceRoot } from "../../src/agents/workspace.js";

const root = workspaceRoot();

/** One foreground process, as herdr's `pane.process_info` reports it — mirrors reap.test.ts's own fixture shape. */
interface FakeProcess { pid: number; argv?: string[] | null; name?: string }

/** A fake herdr client exposing only `pane.list`/`pane.processInfo` — everything `HerdrHerd.residency()`/`residentIssues()` touch. */
function fakeHerdrForResidency(panes: Array<{ pane_id: string; workspace_id: string; cwd: string | null }>, processInfo: (paneId: string) => Promise<{ process_info?: { pane_id: string; foreground_processes?: FakeProcess[] } }>) {
  const client = {
    pane: { list: async () => ({ panes }), processInfo: (p: { pane_id: string }) => processInfo(p.pane_id) },
  };
  return client as any;
}
const ok = (foreground_processes: FakeProcess[]) => async () => ({ process_info: { pane_id: "x", foreground_processes } });

describe("panesFor (BUTCHR-287) — pure ownership join, no agent.list() involvement", () => {
  test("a pane whose cwd is exactly this issue's own workspace directory is owned", () => {
    const panes = [{ pane_id: "w1:p1", workspace_id: "w1", cwd: join(root, "BUTCHR-9") }] as any[];
    expect(panesFor("BUTCHR-9", panes, root).map((p) => p.pane_id)).toEqual(["w1:p1"]);
  });

  test("a pane at a different cwd entirely is never owned", () => {
    const panes = [{ pane_id: "w1:p1", workspace_id: "w1", cwd: "/home/someone/some-other-project" }] as any[];
    expect(panesFor("BUTCHR-9", panes, root)).toEqual([]);
  });

  test("a pane whose cwd has the right <root>/<key> SHAPE but for a DIFFERENT issue is never owned", () => {
    const panes = [{ pane_id: "w1:p1", workspace_id: "w1", cwd: join(root, "BUTCHR-9") }] as any[];
    expect(panesFor("BUTCHR-10", panes, root)).toEqual([]);
  });

  test("no panes reported at all — empty, not an error", () => {
    expect(panesFor("BUTCHR-9", [], root)).toEqual([]);
  });

  test("multiple panes for the same issue are all returned", () => {
    const panes = [
      { pane_id: "w1:p1", workspace_id: "w1", cwd: join(root, "BUTCHR-9") },
      { pane_id: "w1:p2", workspace_id: "w1", cwd: join(root, "BUTCHR-9") },
      { pane_id: "w2:p1", workspace_id: "w2", cwd: join(root, "OTHER-1") },
    ] as any[];
    expect(panesFor("BUTCHR-9", panes, root).map((p) => p.pane_id)).toEqual(["w1:p1", "w1:p2"]);
  });
});

describe("groupOwnedPanes (BUTCHR-287) — the inverse join, no candidate list needed", () => {
  test("a pane directly under root is grouped under its cwd's basename", () => {
    const panes = [{ pane_id: "w1:p1", workspace_id: "w1", cwd: join(root, "BUTCHR-9") }] as any[];
    const out = groupOwnedPanes(panes, root);
    expect([...out.keys()]).toEqual(["BUTCHR-9"]);
    expect(out.get("BUTCHR-9")!.map((p) => p.pane_id)).toEqual(["w1:p1"]);
  });

  test("a pane with no cwd reported is never grouped", () => {
    const panes = [{ pane_id: "w1:p1", workspace_id: "w1", cwd: null }] as any[];
    expect(groupOwnedPanes(panes, root).size).toBe(0);
  });

  test("a pane elsewhere entirely is never grouped", () => {
    const panes = [{ pane_id: "w1:p1", workspace_id: "w1", cwd: "/home/someone/some-other-project" }] as any[];
    expect(groupOwnedPanes(panes, root).size).toBe(0);
  });

  test("a pane nested deeper than one level under root (not buildWorkspace()'s own shape) is never grouped", () => {
    const panes = [{ pane_id: "w1:p1", workspace_id: "w1", cwd: join(root, "BUTCHR-9", "nested") }] as any[];
    expect(groupOwnedPanes(panes, root).size).toBe(0);
  });

  test("multiple panes for the same issue are grouped together; different issues stay separate", () => {
    const panes = [
      { pane_id: "w1:p1", workspace_id: "w1", cwd: join(root, "BUTCHR-9") },
      { pane_id: "w1:p2", workspace_id: "w1", cwd: join(root, "BUTCHR-9") },
      { pane_id: "w2:p1", workspace_id: "w2", cwd: join(root, "OTHER-1") },
    ] as any[];
    const out = groupOwnedPanes(panes, root);
    expect(out.get("BUTCHR-9")!.map((p) => p.pane_id)).toEqual(["w1:p1", "w1:p2"]);
    expect(out.get("OTHER-1")!.map((p) => p.pane_id)).toEqual(["w2:p1"]);
  });
});

describe("aggregateVerdict (BUTCHR-287) — pure combination of per-pane verdicts", () => {
  test("no panes at all is vacant, not unknown — nothing there to be unsure about", () => {
    expect(aggregateVerdict([])).toBe("vacant");
  });

  test("a single live pane is resident", () => {
    expect(aggregateVerdict(["live"])).toBe("resident");
  });

  test("every pane dead is vacant", () => {
    expect(aggregateVerdict(["dead", "dead"])).toBe("vacant");
  });

  test("one live among several others is resident — a single live claude proves occupancy regardless of the rest", () => {
    expect(aggregateVerdict(["dead", "live", "unknown"])).toBe("resident");
  });

  test("one unknown among otherwise-dead panes is unknown, never vacant — an ambiguous pane can never be outvoted into a false vacancy", () => {
    expect(aggregateVerdict(["dead", "unknown"])).toBe("unknown");
  });

  test("all unknown is unknown", () => {
    expect(aggregateVerdict(["unknown", "unknown"])).toBe("unknown");
  });
});

describe("HerdrHerd.residency (BUTCHR-287) — the candidate-scoped census, independent of agent.list()", () => {
  test("a candidate with a live claude in its own pane is resident", async () => {
    const client = fakeHerdrForResidency(
      [{ pane_id: "w1:p1", workspace_id: "w1", cwd: join(root, "BUTCHR-9") }],
      ok([{ pid: 1, name: "claude", argv: ["claude"] }]),
    );
    const herd = new HerdrHerd(client, "u");
    expect(await herd.residency(["BUTCHR-9"])).toEqual(new Map([["BUTCHR-9", "resident"]]));
  });

  test("a candidate with no owned pane at all is vacant — agent.list() reporting it not-running is CORRECT here, not a false positive to guard against", async () => {
    const client = fakeHerdrForResidency([], ok([]));
    const herd = new HerdrHerd(client, "u");
    expect(await herd.residency(["BUTCHR-9"])).toEqual(new Map([["BUTCHR-9", "vacant"]]));
  });

  test("a candidate whose pane shows a non-claude foreground process (the agent genuinely exited) is vacant — spawnable, not stuck withheld forever", async () => {
    const client = fakeHerdrForResidency(
      [{ pane_id: "w1:p1", workspace_id: "w1", cwd: join(root, "BUTCHR-9") }],
      ok([{ pid: 1, name: "fish", argv: ["/usr/bin/fish"] }]),
    );
    const herd = new HerdrHerd(client, "u");
    expect(await herd.residency(["BUTCHR-9"])).toEqual(new Map([["BUTCHR-9", "vacant"]]));
  });

  test("processInfo throwing for a candidate's pane is unknown, never vacant or resident", async () => {
    const client = fakeHerdrForResidency(
      [{ pane_id: "w1:p1", workspace_id: "w1", cwd: join(root, "BUTCHR-9") }],
      async () => { throw new Error("herdr hiccup"); },
    );
    const herd = new HerdrHerd(client, "u");
    expect(await herd.residency(["BUTCHR-9"])).toEqual(new Map([["BUTCHR-9", "unknown"]]));
  });

  test("multiple candidates are each resolved independently in one call", async () => {
    const responses: Record<string, () => Promise<any>> = {
      "w1:p1": ok([{ pid: 1, name: "claude", argv: ["claude"] }]),
      "w2:p1": ok([{ pid: 2, name: "fish", argv: ["/usr/bin/fish"] }]),
    };
    const client = fakeHerdrForResidency(
      [
        { pane_id: "w1:p1", workspace_id: "w1", cwd: join(root, "BUTCHR-9") },
        { pane_id: "w2:p1", workspace_id: "w2", cwd: join(root, "BUTCHR-10") },
      ],
      (paneId) => responses[paneId]!(),
    );
    const herd = new HerdrHerd(client, "u");
    expect(await herd.residency(["BUTCHR-9", "BUTCHR-10"])).toEqual(new Map([["BUTCHR-9", "resident"], ["BUTCHR-10", "vacant"]]));
  });

  test("an empty candidate list resolves to an empty map without calling pane.list() at all", async () => {
    let listCalled = false;
    const client = { pane: { list: async () => { listCalled = true; return { panes: [] }; }, processInfo: async () => ({}) } } as any;
    const herd = new HerdrHerd(client, "u");
    expect(await herd.residency([])).toEqual(new Map());
    expect(listCalled).toBe(false);
  });

  test("pane.list() itself throwing reports every candidate unknown, never a silent vacant", async () => {
    const client = { pane: { list: async () => { throw new Error("herdr down"); }, processInfo: async () => ({}) } } as any;
    const herd = new HerdrHerd(client, "u");
    expect(await herd.residency(["BUTCHR-9", "BUTCHR-10"])).toEqual(new Map([["BUTCHR-9", "unknown"], ["BUTCHR-10", "unknown"]]));
  });
});

describe("HerdrHerd.residentIssues (BUTCHR-287) — the minimal reusable shape, no candidate list needed", () => {
  test("returns every issue key whose own pane shows a live claude, and nothing else", async () => {
    const responses: Record<string, () => Promise<any>> = {
      "w1:p1": ok([{ pid: 1, name: "claude", argv: ["claude"] }]),
      "w2:p1": ok([{ pid: 2, name: "fish", argv: ["/usr/bin/fish"] }]),
      "w3:p1": async () => { throw new Error("hiccup"); },
    };
    const client = fakeHerdrForResidency(
      [
        { pane_id: "w1:p1", workspace_id: "w1", cwd: join(root, "BUTCHR-9") },   // resident
        { pane_id: "w2:p1", workspace_id: "w2", cwd: join(root, "BUTCHR-10") },  // vacant
        { pane_id: "w3:p1", workspace_id: "w3", cwd: join(root, "BUTCHR-11") },  // unknown
      ],
      (paneId) => responses[paneId]!(),
    );
    const herd = new HerdrHerd(client, "u");
    expect(await herd.residentIssues()).toEqual(["BUTCHR-9"]);
  });

  test("a pane.list() failure PROPAGATES (throws) rather than reporting a silent empty list — the exact confident-zero hazard this method exists to avoid feeding to a future consumer", async () => {
    const client = { pane: { list: async () => { throw new Error("herdr down"); }, processInfo: async () => ({}) } } as any;
    const herd = new HerdrHerd(client, "u");
    await expect(herd.residentIssues()).rejects.toThrow("herdr down");
  });

  test("no owned panes at all resolves to an empty array, not an error", async () => {
    const client = fakeHerdrForResidency([], ok([]));
    const herd = new HerdrHerd(client, "u");
    expect(await herd.residentIssues()).toEqual([]);
  });
});
