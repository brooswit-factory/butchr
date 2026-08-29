import { describe, expect, test } from "bun:test";
import {
  computePlan,
  fetchAllIssues,
  applyPlan,
  formatTable,
  summarize,
  type MigrateIssue,
  type MigrateLink,
  type Plan,
} from "../../scripts/migrate-links.js";
import type { Config } from "../../src/config/config.js";

const link = (type: string, direction: "inward" | "outward", key: string, id = "1"): MigrateLink => ({ id, type, direction, key });

const issue = (over: Partial<MigrateIssue> & { key: string; issuetype: string }): MigrateIssue => ({
  statusCategory: "In Progress",
  parent: null,
  summary: "",
  issuelinks: [],
  ...over,
});

describe("computePlan", () => {
  test("story missing its epic Implements link is added", () => {
    const epic = issue({ key: "KAN-1", issuetype: "Epic" });
    const story = issue({ key: "KAN-2", issuetype: "Story", parent: "KAN-1" });
    const plan = computePlan([epic, story]);
    expect(plan.actions).toEqual([{ ticket: "KAN-2", action: "add-implements", otherEnd: "KAN-1", reason: "story implements its parent epic KAN-1" }]);
  });

  test("story that already implements its epic gets no action (idempotence)", () => {
    const epic = issue({ key: "KAN-1", issuetype: "Epic" });
    const story = issue({ key: "KAN-2", issuetype: "Story", parent: "KAN-1", issuelinks: [link("Implements", "inward", "KAN-1")] });
    expect(computePlan([epic, story]).actions).toEqual([]);
  });

  test("a story's Implements link recorded in the WRONG direction does not satisfy the requirement", () => {
    const epic = issue({ key: "KAN-1", issuetype: "Epic" });
    // direction "outward" here would mean KAN-1 is the implementer of KAN-2 — backwards.
    const story = issue({ key: "KAN-2", issuetype: "Story", parent: "KAN-1", issuelinks: [link("Implements", "outward", "KAN-1")] });
    const plan = computePlan([epic, story]);
    expect(plan.actions).toEqual([{ ticket: "KAN-2", action: "add-implements", otherEnd: "KAN-1", reason: "story implements its parent epic KAN-1" }]);
  });

  test("task resolved via an existing Relates link to its story: add-implements + delete-relates", () => {
    const story = issue({ key: "KAN-10", issuetype: "Story" });
    const task = issue({ key: "KAN-11", issuetype: "Task", issuelinks: [link("Relates", "outward", "KAN-10", "rel-1")] });
    const plan = computePlan([story, task]);
    expect(plan.actions).toEqual([
      { ticket: "KAN-11", action: "add-implements", otherEnd: "KAN-10", reason: "task implements its owning story KAN-10" },
      { ticket: "KAN-11", action: "delete-relates", otherEnd: "KAN-10", linkId: "rel-1", reason: "Implements link to KAN-10 added above; redundant Relates link removed" },
    ]);
  });

  test("task resolved via an existing Implements link: delete-relates only", () => {
    const story = issue({ key: "KAN-10", issuetype: "Story" });
    const task = issue({
      key: "KAN-11",
      issuetype: "Task",
      issuelinks: [link("Implements", "inward", "KAN-10", "impl-1"), link("Relates", "outward", "KAN-10", "rel-1")],
    });
    const plan = computePlan([story, task]);
    expect(plan.actions).toEqual([
      { ticket: "KAN-11", action: "delete-relates", otherEnd: "KAN-10", linkId: "rel-1", reason: "Implements link to KAN-10 already exists; redundant Relates link removed" },
    ]);
  });

  test("task resolved via the [KAN-nnn] summary prefix fallback, flagged in the reason", () => {
    const story = issue({ key: "KAN-20", issuetype: "Story" });
    const task = issue({ key: "KAN-21", issuetype: "Task", summary: "[KAN-20] do the thing" });
    const plan = computePlan([story, task]);
    expect(plan.actions).toEqual([
      { ticket: "KAN-21", action: "add-implements", otherEnd: "KAN-20", reason: 'owning story resolved from the "[KAN-20]" summary prefix' },
    ]);
  });

  test("an unresolved task gets no actions, only a reported reason", () => {
    const task = issue({ key: "KAN-30", issuetype: "Task", summary: "no story named here" });
    const plan = computePlan([task]);
    expect(plan.actions).toEqual([]);
    expect(plan.unresolved).toEqual([
      { ticket: "KAN-30", reason: 'no Implements link, no Relates link, and no "[KAN-nnn]" summary prefix names an open Story' },
    ]);
  });

  test("the [KAN-nnn] fallback is rejected when KAN-nnn is not an open Story", () => {
    const doneStory = issue({ key: "KAN-40", issuetype: "Story", statusCategory: "Done" });
    const task = issue({ key: "KAN-41", issuetype: "Task", summary: "[KAN-40] stale reference" });
    const plan = computePlan([doneStory, task]);
    expect(plan.unresolved).toEqual([{ ticket: "KAN-41", reason: 'no Implements link, no Relates link, and no "[KAN-nnn]" summary prefix names an open Story' }]);
  });

  test("a Done ticket is ignored entirely — neither processed nor usable as a resolution target", () => {
    const doneEpic = issue({ key: "KAN-1", issuetype: "Epic", statusCategory: "Done" });
    const doneStory = issue({ key: "KAN-2", issuetype: "Story", parent: "KAN-1", statusCategory: "Done" });
    const openTaskViaDoneStory = issue({ key: "KAN-3", issuetype: "Task", issuelinks: [link("Relates", "outward", "KAN-2")] });
    const plan = computePlan([doneEpic, doneStory, openTaskViaDoneStory]);
    expect(plan.actions).toEqual([]);
    expect(plan.unresolved).toEqual([
      { ticket: "KAN-3", reason: 'no Implements link, no Relates link, and no "[KAN-nnn]" summary prefix names an open Story' },
    ]);
  });

  test("a non-Relates link between a task and its story is never deleted", () => {
    const story = issue({ key: "KAN-10", issuetype: "Story" });
    const task = issue({
      key: "KAN-11",
      issuetype: "Task",
      issuelinks: [link("Implements", "inward", "KAN-10"), link("Blocks", "outward", "KAN-10", "blocks-1")],
    });
    expect(computePlan([story, task]).actions).toEqual([]);
  });

  test("idempotence proof: computing the plan from post-migration state yields an empty plan", () => {
    const epic = issue({ key: "KAN-1", issuetype: "Epic" });
    const story = issue({ key: "KAN-2", issuetype: "Story", parent: "KAN-1", issuelinks: [link("Implements", "inward", "KAN-1", "si-1")] });
    const task = issue({ key: "KAN-3", issuetype: "Task", issuelinks: [link("Implements", "inward", "KAN-2", "ti-1")] });
    const plan = computePlan([epic, story, task]);
    expect(plan).toEqual({ actions: [], unresolved: [] });
  });
});

describe("computePlan — delete-backwards-implements", () => {
  test("10617-style: an Epic recorded as implementing a Story, with a correct Story->Epic counterpart, is planned for deletion", () => {
    const epic = issue({ key: "KAN-100", issuetype: "Epic", issuelinks: [link("Implements", "inward", "KAN-101", "back-1")] });
    const story = issue({ key: "KAN-101", issuetype: "Story", issuelinks: [link("Implements", "inward", "KAN-100", "correct-1")] });
    const plan = computePlan([epic, story]);
    expect(plan.actions).toEqual([
      {
        ticket: "KAN-100",
        action: "delete-backwards-implements",
        otherEnd: "KAN-101",
        linkId: "back-1",
        reason: "KAN-100 (Epic) is recorded as implementing KAN-101 (Story) — backwards; a correct-direction Implements link exists between the same two tickets",
      },
    ]);
    expect(plan.unresolved).toEqual([]);
  });

  test("10620-style: a Story recorded as implementing its Task, with a correct Task->Story counterpart, is planned for deletion", () => {
    const story = issue({ key: "KAN-110", issuetype: "Story", issuelinks: [link("Implements", "inward", "KAN-111", "back-2")] });
    const task = issue({ key: "KAN-111", issuetype: "Task", issuelinks: [link("Implements", "inward", "KAN-110", "correct-2")] });
    const plan = computePlan([story, task]);
    expect(plan.actions).toEqual([
      {
        ticket: "KAN-110",
        action: "delete-backwards-implements",
        otherEnd: "KAN-111",
        linkId: "back-2",
        reason: "KAN-110 (Story) is recorded as implementing KAN-111 (Task) — backwards; a correct-direction Implements link exists between the same two tickets",
      },
    ]);
    expect(plan.unresolved).toEqual([]);
  });

  test("10618-style: a Story recorded as implementing a DONE Task, with a correct counterpart, is still found and planned (Done-fetch regression guard)", () => {
    const story = issue({ key: "KAN-120", issuetype: "Story", issuelinks: [link("Implements", "inward", "KAN-121", "back-3")] });
    const doneTask = issue({ key: "KAN-121", issuetype: "Task", statusCategory: "Done", issuelinks: [link("Implements", "inward", "KAN-120", "correct-3")] });
    const plan = computePlan([story, doneTask]);
    expect(plan.actions).toEqual([
      {
        ticket: "KAN-120",
        action: "delete-backwards-implements",
        otherEnd: "KAN-121",
        linkId: "back-3",
        reason: "KAN-120 (Story) is recorded as implementing KAN-121 (Task) — backwards; a correct-direction Implements link exists between the same two tickets",
      },
    ]);
    expect(plan.unresolved).toEqual([]);
  });

  test("BOTH ends Done: a backwards link is still planned even when neither endpoint is open (time-independence regression guard)", () => {
    // e.g. 10622 on the live board: KAN-757 and KAN-759 both went Done after the backwards link was created,
    // yet the link is still a stranded non-wake-path that must be cleanable regardless of when --apply runs.
    const doneStory = issue({ key: "KAN-150", issuetype: "Story", statusCategory: "Done", issuelinks: [link("Implements", "inward", "KAN-151", "back-5")] });
    const doneTask = issue({ key: "KAN-151", issuetype: "Task", statusCategory: "Done", issuelinks: [link("Implements", "inward", "KAN-150", "correct-5")] });
    const plan = computePlan([doneStory, doneTask]);
    expect(plan.actions).toEqual([
      {
        ticket: "KAN-150",
        action: "delete-backwards-implements",
        otherEnd: "KAN-151",
        linkId: "back-5",
        reason: "KAN-150 (Story) is recorded as implementing KAN-151 (Task) — backwards; a correct-direction Implements link exists between the same two tickets",
      },
    ]);
    expect(plan.unresolved).toEqual([]);
  });

  test("a backwards Implements link with no correct-direction counterpart is unresolved, not deleted", () => {
    // KAN-131's real owning story is KAN-129 (correctly implemented) so the pre-existing task-resolution
    // loop stays silent; KAN-130's backwards Implements link to KAN-131 has no counterpart of its own.
    const storyOwner = issue({ key: "KAN-129", issuetype: "Story" });
    const story = issue({ key: "KAN-130", issuetype: "Story", issuelinks: [link("Implements", "inward", "KAN-131", "back-4")] });
    const task = issue({ key: "KAN-131", issuetype: "Task", issuelinks: [link("Implements", "inward", "KAN-129", "own-1")] });
    const plan = computePlan([storyOwner, story, task]);
    expect(plan.actions).toEqual([]);
    expect(plan.unresolved).toEqual([{ ticket: "KAN-130", reason: "backwards Implements link without a correct counterpart" }]);
  });

  test("correct-direction Implements links (Task->Story, Story->Epic) are never flagged as backwards", () => {
    const epic = issue({ key: "KAN-140", issuetype: "Epic" });
    const story = issue({ key: "KAN-141", issuetype: "Story", issuelinks: [link("Implements", "inward", "KAN-140", "si-140")] });
    const task = issue({ key: "KAN-142", issuetype: "Task", issuelinks: [link("Implements", "inward", "KAN-141", "ti-141")] });
    const plan = computePlan([epic, story, task]);
    expect(plan.actions).toEqual([]);
    expect(plan.unresolved).toEqual([]);
  });

  test("a backwards link appearing on BOTH ends' issuelinks (same link id) is planned exactly once", () => {
    const epic = issue({ key: "KAN-150", issuetype: "Epic", issuelinks: [link("Implements", "inward", "KAN-151", "dup-1")] });
    const story = issue({
      key: "KAN-151",
      issuetype: "Story",
      issuelinks: [link("Implements", "outward", "KAN-150", "dup-1"), link("Implements", "inward", "KAN-150", "correct-dup")],
    });
    const plan = computePlan([epic, story]);
    const backDeletes = plan.actions.filter((a) => a.action === "delete-backwards-implements");
    expect(backDeletes).toEqual([{ ticket: "KAN-150", action: "delete-backwards-implements", otherEnd: "KAN-151", linkId: "dup-1", reason: expect.any(String) }]);
  });

  test("idempotence: computing the plan after the backwards link has been deleted plans nothing new", () => {
    const epic = issue({ key: "KAN-160", issuetype: "Epic" });
    const story = issue({ key: "KAN-161", issuetype: "Story", issuelinks: [link("Implements", "inward", "KAN-160", "correct-160")] });
    const plan = computePlan([epic, story]);
    expect(plan).toEqual({ actions: [], unresolved: [] });
  });
});

describe("summarize / formatTable", () => {
  test("summarize reports an empty plan explicitly, and a non-empty one with counts", () => {
    expect(summarize({ actions: [], unresolved: [] })).toBe("plan is empty — nothing to migrate");
    const plan: Plan = {
      actions: [
        { ticket: "KAN-2", action: "add-implements", otherEnd: "KAN-1", reason: "r" },
        { ticket: "KAN-3", action: "delete-relates", otherEnd: "KAN-2", linkId: "5", reason: "r" },
      ],
      unresolved: [{ ticket: "KAN-4", reason: "r" }],
    };
    expect(summarize(plan)).toBe("plan: 1 add-implements, 1 delete-relates, 1 unresolved");
  });

  test("formatTable renders header, actions and unresolved rows", () => {
    const plan: Plan = {
      actions: [{ ticket: "KAN-2", action: "add-implements", otherEnd: "KAN-1", reason: "r" }],
      unresolved: [{ ticket: "KAN-4", reason: "no owner" }],
    };
    const table = formatTable(plan);
    expect(table).toContain("ticket");
    expect(table).toContain("add-implements");
    expect(table).toContain("KAN-4");
    expect(table).toContain("unresolved");
    expect(table).toContain("no owner");
  });

  test("summarize includes the delete-backwards-implements count when present", () => {
    const plan: Plan = {
      actions: [{ ticket: "KAN-1", action: "delete-backwards-implements", otherEnd: "KAN-2", linkId: "9", reason: "r" }],
      unresolved: [],
    };
    expect(summarize(plan)).toBe("plan: 0 add-implements, 0 delete-relates, 1 delete-backwards-implements, 0 unresolved");
  });

  test("formatTable shows the link id for a delete-backwards-implements row", () => {
    const plan: Plan = {
      actions: [{ ticket: "KAN-1", action: "delete-backwards-implements", otherEnd: "KAN-2", linkId: "9", reason: "backwards" }],
      unresolved: [],
    };
    const table = formatTable(plan);
    expect(table).toContain("delete-backwards-implements");
    expect(table).toContain("9");
    expect(table).toContain("backwards");
  });
});

function fakeConfig(): Config {
  return { atlassian: { site: "https://x.atlassian.net", email: "a@b.c", token: "tok" }, port: 7717, stalledMinutes: 10 };
}

describe("fetchAllIssues", () => {
  test("paginates via nextPageToken until exhausted, mapping fields incl. link ids", async () => {
    const pages = [
      { issues: [{ key: "KAN-1", fields: { issuetype: { name: "Story" }, status: { statusCategory: { name: "In Progress" } }, parent: { key: "KAN-0" }, summary: "s1", issuelinks: [{ id: "9", type: { name: "Implements" }, inwardIssue: { key: "KAN-0" } }] } }], nextPageToken: "page2" },
      { issues: [{ key: "KAN-2", fields: { issuetype: { name: "Task" }, status: { statusCategory: { name: "In Progress" } }, summary: "s2" } }] },
    ];
    const seen: string[] = [];
    const fetchImpl = async (url: string) => {
      seen.push(url);
      const body = url.includes("nextPageToken=page2") ? pages[1] : pages[0];
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    };
    const issues = await fetchAllIssues(fakeConfig(), fetchImpl);
    expect(seen.length).toBe(2);
    expect(issues).toEqual([
      { key: "KAN-1", issuetype: "Story", statusCategory: "In Progress", parent: "KAN-0", summary: "s1", issuelinks: [{ id: "9", type: "Implements", direction: "inward", key: "KAN-0" }] },
      { key: "KAN-2", issuetype: "Task", statusCategory: "In Progress", parent: null, summary: "s2", issuelinks: [] },
    ]);
  });

  test("a non-2xx response throws with the status", async () => {
    const fetchImpl = async () => new Response("nope", { status: 401 });
    await expect(fetchAllIssues(fakeConfig(), fetchImpl)).rejects.toThrow(/401/);
  });
});

describe("applyPlan", () => {
  test("performs every add before any delete, and skips the delete whose add failed", async () => {
    const plan: Plan = {
      actions: [
        { ticket: "KAN-2", action: "add-implements", otherEnd: "KAN-1", reason: "r" },
        { ticket: "KAN-3", action: "add-implements", otherEnd: "KAN-4", reason: "r" },
        { ticket: "KAN-2", action: "delete-relates", otherEnd: "KAN-1", linkId: "10", reason: "r" },
        { ticket: "KAN-3", action: "delete-relates", otherEnd: "KAN-4", linkId: "11", reason: "r" },
      ],
      unresolved: [],
    };
    const calls: { method: string; url: string }[] = [];
    const fetchImpl = async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ method, url });
      if (method === "POST" && url.includes("issueLink") && (init?.body as string).includes("KAN-4")) {
        return new Response("boom", { status: 500 });
      }
      return new Response("{}", { status: 200 });
    };
    const outcomes = await applyPlan(plan, fakeConfig(), fetchImpl);
    // both adds attempted before either delete
    expect(calls.slice(0, 2).every((c) => c.method === "POST")).toBe(true);
    expect(calls.slice(2).every((c) => c.method === "DELETE")).toBe(true);
    expect(outcomes).toEqual([
      { ticket: "KAN-2", action: "add-implements", otherEnd: "KAN-1", ok: true },
      { ticket: "KAN-3", action: "add-implements", otherEnd: "KAN-4", ok: false, error: expect.stringContaining("500") },
      { ticket: "KAN-2", action: "delete-relates", otherEnd: "KAN-1", ok: true },
      { ticket: "KAN-3", action: "delete-relates", otherEnd: "KAN-4", ok: false, error: "skipped — Implements add to KAN-4 failed" },
    ]);
    // only ONE delete call was actually made (KAN-4's delete was skipped, not attempted)
    expect(calls.filter((c) => c.method === "DELETE").length).toBe(1);
  });

  test("a failing delete is reported without throwing", async () => {
    const plan: Plan = { actions: [{ ticket: "KAN-2", action: "delete-relates", otherEnd: "KAN-1", linkId: "10", reason: "r" }], unresolved: [] };
    const fetchImpl = async () => new Response("nope", { status: 404 });
    const outcomes = await applyPlan(plan, fakeConfig(), fetchImpl);
    expect(outcomes).toEqual([{ ticket: "KAN-2", action: "delete-relates", otherEnd: "KAN-1", ok: false, error: expect.stringContaining("404") }]);
  });
});
