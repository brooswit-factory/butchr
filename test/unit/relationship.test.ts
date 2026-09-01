import { describe, expect, test } from "bun:test";
import {
  newWorker, startWorker, shelveWorker, adoptWorker, finishWorker, prioritizeWorker, tellWorker, correctWorker,
  reportToBoss, askBoss, submitToBoss, finishWithoutABoss, fileWhereItBelongs, classifyDestination, ORPHAN_LABEL, ASK_MARKER, CORRECTION_MARKER,
} from "../../src/tools/relationship.js";
import { EXEMPT_LABEL } from "../../src/agents/parked.js";
import type { AtlassianOps } from "../../src/tools/atlassian.js";

const ROLES = { story: "acct-story", task: "acct-task" };

/**
 * A small stateful Jira+Confluence world implementing the full AtlassianOps
 * surface, in the same spirit as docs.test.ts's makeWorld (relationship.ts's
 * logic — ownership checks, type inference, the new_worker write order — is
 * genuinely stateful across calls in a way a simple call-recording rig
 * isn't built for).
 */
function makeWorld() {
  let nextIssueId = 100;
  let nextPageId = 900;
  const issues = new Map<
    string,
    {
      issuetype: string; project: string; status: string; assignee?: string; priority?: string; labels: string[]; bossKey?: string; comments: string[];
      remoteLink?: { title: string; url: string };
      // `description` is `unknown`, not `string`: real Jira hands back ADF (an
      // object), and correctWorker's tests need a fake world that can hold
      // that shape too, not just the plain text createIssue/fileWhereItBelongs
      // already exercise here.
      description?: unknown;
      summary?: string;
    }
  >();
  const pages = new Map<string, { parentId: string; title: string; body: string; labels: string[] }>();
  const projectProperties = new Map<string, unknown>();

  function addIssue(key: string, p: { issuetype: string; project: string; status?: string; labels?: string[]; bossKey?: string; assignee?: string; description?: unknown; summary?: string }) {
    issues.set(key, {
      issuetype: p.issuetype, project: p.project, status: p.status ?? "To Do", labels: p.labels ?? [], comments: [],
      ...(p.bossKey ? { bossKey: p.bossKey } : {}), ...(p.assignee ? { assignee: p.assignee } : {}),
      ...(p.description !== undefined ? { description: p.description } : {}), ...(p.summary ? { summary: p.summary } : {}),
    });
  }
  function setProjectProperty(projectKey: string, value: unknown) {
    projectProperties.set(projectKey, value);
  }
  function pageUrl(id: string) {
    return `https://fake.atlassian.net/wiki/pages/${id}`;
  }
  function requireIssue(key: string) {
    const i = issues.get(key);
    if (!i) throw new Error(`fake world: no such issue ${key}`);
    return i;
  }

  const ops: AtlassianOps = {
    getIssue: async (key: string) => {
      const i = requireIssue(key);
      return {
        self: `https://fake.atlassian.net/rest/api/3/issue/${key}`,
        fields: {
          summary: i.summary ?? `${key} summary`,
          issuetype: { name: i.issuetype },
          project: { key: i.project },
          status: { name: i.status },
          labels: i.labels,
          assignee: i.assignee ? { accountId: i.assignee } : null,
          issuelinks: i.bossKey ? [{ type: { name: "Implements" }, inwardIssue: { key: i.bossKey } }] : [],
          description: i.description,
        },
      };
    },
    search: async () => ({}),
    addComment: async (key: string, text: string) => {
      requireIssue(key).comments.push(text);
      return { ok: true };
    },
    linkIssues: async (from: string, to: string, type: string) => {
      if (type === "Implements") requireIssue(from).bossKey = to;
      return { ok: true };
    },
    transition: async (key: string, status: string) => {
      requireIssue(key).status = status;
      return { ok: true };
    },
    createIssue: async (p) => {
      const key = `${p.projectKey}-${nextIssueId++}`;
      issues.set(key, {
        issuetype: p.issuetype, project: p.projectKey, status: "To Do",
        labels: p.labels ? [...p.labels] : [], comments: [],
        ...(p.assignee ? { assignee: p.assignee } : {}), ...(p.priority ? { priority: p.priority } : {}),
        ...(p.description ? { description: p.description } : {}),
      });
      return { key };
    },
    setPriority: async (key: string, priority: string) => {
      requireIssue(key).priority = priority;
      return { ok: true };
    },
    assign: async (key: string, accountId: string) => {
      requireIssue(key).assignee = accountId;
      return { ok: true };
    },
    correctText: async (key: string, p: { description?: string; summary?: string }) => {
      const i = requireIssue(key);
      if (p.description !== undefined) i.description = p.description;
      if (p.summary !== undefined) i.summary = p.summary;
      return { ok: true };
    },
    createPage: async () => ({}),
    getPage: async (id: string) => {
      const p = pages.get(id);
      if (!p) throw new Error(`fake world: no such page ${id}`);
      return { title: p.title, body: { storage: { value: p.body } }, _links: { base: "https://fake.atlassian.net/wiki", webui: `/pages/${id}` } };
    },
    updatePage: async (p) => {
      const page = pages.get(p.id);
      if (!page) throw new Error(`fake world: no such page ${p.id}`);
      page.body = p.body;
      if (p.title) page.title = p.title;
      return { ok: true };
    },
    searchPages: async () => ({ results: [] }),
    listSpaces: async () => ({}),
    getProjectProperty: async (projectKey: string) => {
      const v = projectProperties.get(projectKey);
      if (!v) throw new Error(`fake world: no "butchr" property for project ${projectKey}`);
      return v;
    },
    getRemoteLink: async (key: string) => {
      const i = issues.get(key);
      return i?.remoteLink ? { object: { ...i.remoteLink } } : null;
    },
    upsertRemoteLink: async (key: string, _g: string, _r: string, object: { title: string; url: string }) => {
      requireIssue(key).remoteLink = { ...object };
      return { id: 1 };
    },
    getChildPages: async (parentId: string, cursor?: string) => {
      const all = [...pages.entries()].filter(([, p]) => p.parentId === parentId).map(([id]) => id);
      const start = cursor ? Number(cursor) : 0;
      return { results: all.slice(start).map((id) => ({ id, title: pages.get(id)!.title })) };
    },
    getPageLabels: async (pageId: string) => pages.get(pageId)?.labels ?? [],
    createPageWithLabel: async (p) => {
      const titleTaken = [...pages.values()].some((pg) => pg.title === p.title);
      if (titleTaken) throw new Error("title collision");
      const id = String(nextPageId++);
      pages.set(id, { parentId: p.parentId, title: p.title, body: p.body, labels: [p.label] });
      return { id, title: p.title, url: pageUrl(id) };
    },
    addLabels: async (key: string, labels: readonly string[]) => {
      const i = requireIssue(key);
      i.labels = [...new Set([...i.labels, ...labels])];
      return { ok: true };
    },
    deleteIssue: async (key: string) => {
      if (!issues.delete(key)) throw new Error(`fake world: no such issue ${key}`);
      return { ok: true };
    },
  };

  return { ops, issues, pages, addIssue, setProjectProperty };
}

const ROOT_DOC_ID = "1";
const BUTCHR_PROPERTY = { space: { key: "BUTCHR" }, rootDoc: { id: ROOT_DOC_ID } };

// ---------------------------------------------------------------------------
// new_worker
// ---------------------------------------------------------------------------

describe("newWorker: inference", () => {
  test("Epic caller -> Story child, staffed by roles.story", async () => {
    const { ops, addIssue, issues, setProjectProperty } = makeWorld();
    setProjectProperty("BUTCHR", BUTCHR_PROPERTY);
    addIssue("BUTCHR-1", { issuetype: "Epic", project: "BUTCHR" });
    const result = await newWorker(ops, ROLES, "BUTCHR-1", { summary: "s", disposition: { kind: "start" } });
    const child = issues.get(result.key)!;
    expect(child.issuetype).toBe("Story");
    expect(child.assignee).toBe(ROLES.story);
  });

  test("Story caller -> Task child, staffed by roles.task", async () => {
    const { ops, addIssue, issues, setProjectProperty } = makeWorld();
    setProjectProperty("BUTCHR", BUTCHR_PROPERTY);
    addIssue("BUTCHR-1", { issuetype: "Story", project: "BUTCHR" });
    const result = await newWorker(ops, ROLES, "BUTCHR-1", { summary: "s", disposition: { kind: "start" } });
    const child = issues.get(result.key)!;
    expect(child.issuetype).toBe("Task");
    expect(child.assignee).toBe(ROLES.task);
  });

  test("Task caller REFUSES with a message that explains itself in words, not a type/enum error", async () => {
    const { ops, addIssue } = makeWorld();
    addIssue("BUTCHR-1", { issuetype: "Task", project: "BUTCHR" });
    await expect(newWorker(ops, ROLES, "BUTCHR-1", { summary: "s", disposition: { kind: "start" } }))
      .rejects.toThrow(/is a Task.*has no worker beneath it/);
  });

  test("an unrecognized caller issue type (neither Epic nor Story nor Task) refuses with a generic explanation, not a Task-specific one", async () => {
    const { ops, addIssue } = makeWorld();
    addIssue("BUTCHR-1", { issuetype: "Bug", project: "BUTCHR" });
    await expect(newWorker(ops, ROLES, "BUTCHR-1", { summary: "s", disposition: { kind: "start" } }))
      .rejects.toThrow(/"Bug".*has no defined child type/);
  });

  test("a caller issue with no readable issuetype at all refuses, naming it \"unknown\" rather than crashing", async () => {
    const { ops, addIssue, issues } = makeWorld();
    addIssue("BUTCHR-1", { issuetype: "Epic", project: "BUTCHR" });
    issues.get("BUTCHR-1")!.issuetype = undefined as unknown as string;
    await expect(newWorker(ops, ROLES, "BUTCHR-1", { summary: "s", disposition: { kind: "start" } }))
      .rejects.toThrow(/"unknown".*has no defined child type/);
  });

  test("missing role accountId refuses, naming the env var (matching jira_create_issue's shape)", async () => {
    const { ops, addIssue } = makeWorld();
    addIssue("BUTCHR-1", { issuetype: "Epic", project: "BUTCHR" });
    await expect(newWorker(ops, {}, "BUTCHR-1", { summary: "s", disposition: { kind: "start" } }))
      .rejects.toThrow(/BUTCHR_ASSIGNEE_STORY/);
  });

  test("the link's `from` is the NEW CHILD and `to` is the CALLER — never the reverse (the exact near-miss to check for)", async () => {
    const { ops, addIssue, issues, setProjectProperty } = makeWorld();
    setProjectProperty("BUTCHR", BUTCHR_PROPERTY);
    addIssue("BUTCHR-1", { issuetype: "Epic", project: "BUTCHR" });
    const result = await newWorker(ops, ROLES, "BUTCHR-1", { summary: "s", disposition: { kind: "start" } });
    // bossKey is set on the CHILD (from), never on the caller (to) — findBossKey reads `bossKey`.
    expect(issues.get(result.key)!.bossKey).toBe("BUTCHR-1");
    expect(issues.get("BUTCHR-1")!.bossKey).toBeUndefined();
  });

  test("project is inferred from the CALLER's own project", async () => {
    const { ops, addIssue, issues, setProjectProperty } = makeWorld();
    setProjectProperty("KAN", { space: { key: "KAN" }, rootDoc: { id: "1" } });
    addIssue("KAN-1", { issuetype: "Epic", project: "KAN" });
    const result = await newWorker(ops, ROLES, "KAN-1", { summary: "s", disposition: { kind: "start" } });
    expect(result.key.startsWith("KAN-")).toBe(true);
    expect(issues.get(result.key)!.project).toBe("KAN");
  });
});

describe("newWorker: disposition", () => {
  test("refuses when no disposition reason is given for shelve", async () => {
    const { ops, addIssue } = makeWorld();
    addIssue("BUTCHR-1", { issuetype: "Epic", project: "BUTCHR" });
    await expect(newWorker(ops, ROLES, "BUTCHR-1", { summary: "s", disposition: { kind: "shelve", reason: "" } }))
      .rejects.toThrow(/reason/);
  });

  test("start: transitions the new child to In Progress; NO shelve label", async () => {
    const { ops, addIssue, issues, setProjectProperty } = makeWorld();
    setProjectProperty("BUTCHR", BUTCHR_PROPERTY);
    addIssue("BUTCHR-1", { issuetype: "Epic", project: "BUTCHR" });
    const result = await newWorker(ops, ROLES, "BUTCHR-1", { summary: "s", disposition: { kind: "start" } });
    const child = issues.get(result.key)!;
    expect(child.status).toBe("In Progress");
    expect(child.labels).not.toContain(EXEMPT_LABEL);
  });

  test("shelve: the label lands IN THE CREATE CALL (present even before disposition is applied), plus a reason comment; NO transition call", async () => {
    const { ops, addIssue, issues, setProjectProperty } = makeWorld();
    setProjectProperty("BUTCHR", BUTCHR_PROPERTY);
    addIssue("BUTCHR-1", { issuetype: "Epic", project: "BUTCHR" });
    const result = await newWorker(ops, ROLES, "BUTCHR-1", { summary: "s", disposition: { kind: "shelve", reason: "waiting on X" } });
    const child = issues.get(result.key)!;
    expect(child.labels).toContain(EXEMPT_LABEL);
    expect(child.status).toBe("To Do"); // never transitioned — born there
    expect(child.comments.some((c) => c.includes("waiting on X"))).toBe(true);
    expect(child.comments.some((c) => c.startsWith(`[BUTCHR-1]`))).toBe(true); // identity-tagged
  });
});

describe("newWorker: the doc, LAST — a doc-step failure does not roll back the ticket", () => {
  test("doc creation failing leaves the ticket, link and disposition all in place; throws naming why, not claiming self-healing", async () => {
    const { ops, addIssue, issues } = makeWorld();
    // no project property registered -> ensureDoc's step 0 throws.
    addIssue("BUTCHR-1", { issuetype: "Epic", project: "BUTCHR" });
    await expect(newWorker(ops, ROLES, "BUTCHR-1", { summary: "s", disposition: { kind: "start" } }))
      .rejects.toThrow(/fully declared worker.*no rollback/s);
    // exactly one child ticket was created and SURVIVES, linked and running.
    const children = [...issues.entries()].filter(([k]) => k !== "BUTCHR-1");
    expect(children.length).toBe(1);
    const [key, child] = children[0]!;
    expect(child.bossKey).toBe("BUTCHR-1");
    expect(child.status).toBe("In Progress");
    void key;
  });
});

describe("newWorker: THE LOAD-BEARING ATOMICITY TEST — each step fails in turn, asserting what does and doesn't survive", () => {
  test("step 1 (create) fails: ops.createIssue rejects -> nothing was ever created, nothing to check", async () => {
    const { ops, addIssue } = makeWorld();
    addIssue("BUTCHR-1", { issuetype: "Epic", project: "BUTCHR" });
    const broken: AtlassianOps = { ...ops, createIssue: async () => { throw new Error("jira down"); } };
    await expect(newWorker(broken, ROLES, "BUTCHR-1", { summary: "s", disposition: { kind: "start" } })).rejects.toThrow(/jira down/);
  });

  test("step 2 (Implements link) fails: the ticket IS rolled back (deleted) — no ticket, no link survives", async () => {
    const { ops, addIssue, issues } = makeWorld();
    addIssue("BUTCHR-1", { issuetype: "Epic", project: "BUTCHR" });
    const broken: AtlassianOps = { ...ops, linkIssues: async () => { throw new Error("link refused"); } };
    const before = issues.size;
    await expect(newWorker(broken, ROLES, "BUTCHR-1", { summary: "s", disposition: { kind: "start" } }))
      .rejects.toThrow(/rolled back \(deleted\); nothing survives/);
    expect(issues.size).toBe(before); // the created child is gone; only the caller remains
  });

  test("step 3 (disposition, start) fails: the ticket IS rolled back — no ticket, no link, no page survives", async () => {
    const { ops, addIssue, issues, pages, setProjectProperty } = makeWorld();
    setProjectProperty("BUTCHR", BUTCHR_PROPERTY);
    addIssue("BUTCHR-1", { issuetype: "Epic", project: "BUTCHR" });
    const broken: AtlassianOps = { ...ops, transition: async () => { throw new Error("no such transition"); } };
    const before = issues.size;
    await expect(newWorker(broken, ROLES, "BUTCHR-1", { summary: "s", disposition: { kind: "start" } }))
      .rejects.toThrow(/rolled back \(deleted\); nothing survives/);
    expect(issues.size).toBe(before);
    expect(pages.size).toBe(0); // doc step never even reached
  });

  test("step 3 (disposition, shelve) fails: the ticket IS rolled back even though the label had already been set at creation", async () => {
    const { ops, addIssue, issues } = makeWorld();
    addIssue("BUTCHR-1", { issuetype: "Epic", project: "BUTCHR" });
    const broken: AtlassianOps = { ...ops, addComment: async () => { throw new Error("comment refused"); } };
    const before = issues.size;
    await expect(newWorker(broken, ROLES, "BUTCHR-1", { summary: "s", disposition: { kind: "shelve", reason: "later" } }))
      .rejects.toThrow(/rolled back \(deleted\); nothing survives/);
    expect(issues.size).toBe(before);
  });

  test("step 4 (doc) fails: NOTHING is rolled back — the ticket, link and disposition all survive (this is the designed, non-atomic step)", async () => {
    const { ops, addIssue, issues } = makeWorld();
    addIssue("BUTCHR-1", { issuetype: "Epic", project: "BUTCHR" }); // no project property -> ensureDoc throws
    const before = issues.size;
    await expect(newWorker(ops, ROLES, "BUTCHR-1", { summary: "s", disposition: { kind: "start" } })).rejects.toThrow();
    expect(issues.size).toBe(before + 1); // the child SURVIVES
  });

  test("rollback itself failing (deleteIssue refused) reports a NAMED PARTIAL STATE — the surviving ticket key — rather than pretending nothing survives", async () => {
    const { ops, addIssue, issues } = makeWorld();
    addIssue("BUTCHR-1", { issuetype: "Epic", project: "BUTCHR" });
    const broken: AtlassianOps = {
      ...ops,
      linkIssues: async () => { throw new Error("link refused"); },
      deleteIssue: async () => { throw new Error("403 no DELETE_ISSUES permission"); },
    };
    let thrown: Error | undefined;
    try {
      await newWorker(broken, ROLES, "BUTCHR-1", { summary: "s", disposition: { kind: "start" } });
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown?.message).toMatch(/COULD NOT be rolled back/);
    expect(thrown?.message).toMatch(/SURVIVES/);
    // and the ticket really is still there, matching the error's claim:
    const survivors = [...issues.keys()].filter((k) => k !== "BUTCHR-1");
    expect(survivors.length).toBe(1);
    expect(thrown?.message).toContain(survivors[0]!);
  });
});

// ---------------------------------------------------------------------------
// start_worker / finish_worker / prioritize_worker / tell_worker — the four
// "refuse a stranger's key" verbs (shelve_worker is exercised in its own
// group below because of the label-additivity requirement).
// ---------------------------------------------------------------------------

describe("start_worker / finish_worker / prioritize_worker / tell_worker: ownership refusal", () => {
  test("start_worker refuses a key that is not one of the caller's own workers", async () => {
    const { ops, addIssue } = makeWorld();
    addIssue("BUTCHR-1", { issuetype: "Epic", project: "BUTCHR" });
    addIssue("BUTCHR-9", { issuetype: "Task", project: "BUTCHR", bossKey: "SOMEONE-ELSE" });
    await expect(startWorker(ops, "BUTCHR-1", "BUTCHR-9")).rejects.toThrow(/not one of BUTCHR-1's own workers/);
  });

  test("start_worker transitions an owned worker to In Progress", async () => {
    const { ops, addIssue, issues } = makeWorld();
    addIssue("BUTCHR-1", { issuetype: "Epic", project: "BUTCHR" });
    addIssue("BUTCHR-2", { issuetype: "Story", project: "BUTCHR", bossKey: "BUTCHR-1" });
    await startWorker(ops, "BUTCHR-1", "BUTCHR-2");
    expect(issues.get("BUTCHR-2")!.status).toBe("In Progress");
  });

  test("finish_worker refuses a stranger's key and transitions an owned one to Done", async () => {
    const { ops, addIssue, issues } = makeWorld();
    addIssue("BUTCHR-1", { issuetype: "Epic", project: "BUTCHR" });
    addIssue("BUTCHR-2", { issuetype: "Story", project: "BUTCHR", bossKey: "BUTCHR-1" });
    addIssue("BUTCHR-9", { issuetype: "Task", project: "BUTCHR", bossKey: "SOMEONE-ELSE" });
    await expect(finishWorker(ops, "BUTCHR-1", "BUTCHR-9")).rejects.toThrow();
    await finishWorker(ops, "BUTCHR-1", "BUTCHR-2");
    expect(issues.get("BUTCHR-2")!.status).toBe("Done");
  });

  test("prioritize_worker refuses a stranger's key AND the caller's OWN key, distinctly", async () => {
    const { ops, addIssue, issues } = makeWorld();
    addIssue("BUTCHR-1", { issuetype: "Epic", project: "BUTCHR" });
    addIssue("BUTCHR-2", { issuetype: "Story", project: "BUTCHR", bossKey: "BUTCHR-1" });
    addIssue("BUTCHR-9", { issuetype: "Task", project: "BUTCHR", bossKey: "SOMEONE-ELSE" });
    await expect(prioritizeWorker(ops, "BUTCHR-1", "BUTCHR-9", "High")).rejects.toThrow(/not one of BUTCHR-1's own workers/);
    await expect(prioritizeWorker(ops, "BUTCHR-1", "BUTCHR-1", "High")).rejects.toThrow(/your own/);
    await prioritizeWorker(ops, "BUTCHR-1", "BUTCHR-2", "High");
    expect(issues.get("BUTCHR-2")!.priority).toBe("High");
  });

  test("tell_worker refuses a stranger's key and comments on the OWNED worker's ticket (not the caller's own)", async () => {
    const { ops, addIssue, issues } = makeWorld();
    addIssue("BUTCHR-1", { issuetype: "Epic", project: "BUTCHR" });
    addIssue("BUTCHR-2", { issuetype: "Story", project: "BUTCHR", bossKey: "BUTCHR-1" });
    await tellWorker(ops, "BUTCHR-1", "BUTCHR-2", "scope note");
    expect(issues.get("BUTCHR-2")!.comments).toEqual(["[BUTCHR-1] scope note"]);
    expect(issues.get("BUTCHR-1")!.comments).toEqual([]); // the CALLER's own ticket gets nothing
  });
});

// ---------------------------------------------------------------------------
// correct_worker (BUTCHR-60)
// ---------------------------------------------------------------------------

describe("correctWorker", () => {
  test("refuses the CALLER'S OWN key, BEFORE any Jira read (matches prioritizeWorker's own shape)", async () => {
    const { ops } = makeWorld();
    let getIssueCalls = 0;
    const throwingOps: AtlassianOps = { ...ops, getIssue: async (key: string) => { getIssueCalls++; throw new Error(`should not be read: ${key}`); } };
    await expect(correctWorker(throwingOps, "BUTCHR-1", "BUTCHR-1", { description: "new", why: "reason" })).rejects.toThrow(/refusing to correct BUTCHR-1's own/);
    expect(getIssueCalls).toBe(0); // the refusal cost no Jira round trip
  });

  test("refuses a stranger's key (not one of the caller's own workers)", async () => {
    const { ops, addIssue } = makeWorld();
    addIssue("BUTCHR-1", { issuetype: "Story", project: "BUTCHR" });
    addIssue("BUTCHR-9", { issuetype: "Task", project: "BUTCHR", bossKey: "SOMEONE-ELSE" });
    await expect(correctWorker(ops, "BUTCHR-1", "BUTCHR-9", { description: "new", why: "reason" })).rejects.toThrow(/not one of BUTCHR-1's own workers/);
  });

  test("refuses when neither `description` nor `summary` is given", async () => {
    const { ops, addIssue } = makeWorld();
    addIssue("BUTCHR-1", { issuetype: "Story", project: "BUTCHR" });
    addIssue("BUTCHR-2", { issuetype: "Task", project: "BUTCHR", bossKey: "BUTCHR-1" });
    await expect(correctWorker(ops, "BUTCHR-1", "BUTCHR-2", { why: "reason" })).rejects.toThrow(/neither/);
  });

  test("refuses an empty/whitespace-only `why`", async () => {
    const { ops, addIssue } = makeWorld();
    addIssue("BUTCHR-1", { issuetype: "Story", project: "BUTCHR" });
    addIssue("BUTCHR-2", { issuetype: "Task", project: "BUTCHR", bossKey: "BUTCHR-1" });
    await expect(correctWorker(ops, "BUTCHR-1", "BUTCHR-2", { description: "new", why: "   " })).rejects.toThrow(/why.*(required|non-empty)/i);
  });

  test("happy path: archives the CURRENT description as a `[correction]`-marked comment BEFORE overwriting it, superseded text present", async () => {
    const { ops, addIssue, issues } = makeWorld();
    addIssue("BUTCHR-1", { issuetype: "Story", project: "BUTCHR" });
    addIssue("BUTCHR-2", {
      issuetype: "Task", project: "BUTCHR", bossKey: "BUTCHR-1",
      description: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "old description text" }] }] },
    });
    const result = await correctWorker(ops, "BUTCHR-1", "BUTCHR-2", { description: "new description text", why: "was stale" });
    expect(issues.get("BUTCHR-2")!.description).toBe("new description text"); // the edit landed
    expect(issues.get("BUTCHR-2")!.comments).toHaveLength(1);
    const comment = issues.get("BUTCHR-2")!.comments[0]!;
    // reads the exported constant, not a hardcoded literal — a marker drift would fail THIS assertion, not silently pass it.
    expect(comment.startsWith(`[BUTCHR-1] ${CORRECTION_MARKER}`)).toBe(true);
    expect(comment).toContain("old description text"); // adfToText flattened the pre-existing ADF description correctly
    expect(comment).toContain("was stale"); // `why` landed in the archive
    expect(comment).toMatch(/PREVIOUS VERSION/);
    expect(result.key).toBe("BUTCHR-2");
    expect(result.correctedDescription).toBe(true);
    expect(result.correctedSummary).toBe(false);
  });

  test("ORDER PROOF: when the archive comment fails, the edit op is NEVER called and the worker is unchanged", async () => {
    const { ops, addIssue, issues } = makeWorld();
    addIssue("BUTCHR-1", { issuetype: "Story", project: "BUTCHR" });
    addIssue("BUTCHR-2", { issuetype: "Task", project: "BUTCHR", bossKey: "BUTCHR-1", description: "old" });
    let correctTextCalled = false;
    const failingOps: AtlassianOps = {
      ...ops,
      addComment: async () => { throw new Error("comment API down"); },
      correctText: async (key, p) => { correctTextCalled = true; return ops.correctText(key, p); },
    };
    await expect(correctWorker(failingOps, "BUTCHR-1", "BUTCHR-2", { description: "new", why: "reason" })).rejects.toThrow(/archive comment failed/);
    expect(correctTextCalled).toBe(false); // the guarantee, not a comment about it
    expect(issues.get("BUTCHR-2")!.description).toBe("old"); // UNCHANGED
  });

  test("edit failing AFTER a successful archive: one harmless extra comment, description UNCHANGED, error says safe to retry", async () => {
    const { ops, addIssue, issues } = makeWorld();
    addIssue("BUTCHR-1", { issuetype: "Story", project: "BUTCHR" });
    addIssue("BUTCHR-2", { issuetype: "Task", project: "BUTCHR", bossKey: "BUTCHR-1", description: "old" });
    const failingOps: AtlassianOps = { ...ops, correctText: async () => { throw new Error("edit API down"); } };
    await expect(correctWorker(failingOps, "BUTCHR-1", "BUTCHR-2", { description: "new", why: "reason" })).rejects.toThrow(/UNCHANGED/);
    await expect(correctWorker(failingOps, "BUTCHR-1", "BUTCHR-2", { description: "new", why: "reason" })).rejects.toThrow(/retry/i);
    expect(issues.get("BUTCHR-2")!.comments).toHaveLength(2); // the archive lands each time (safe to retry)
    expect(issues.get("BUTCHR-2")!.description).toBe("old"); // the edit never took
  });

  test("a description-only call writes ONLY description — summary is untouched", async () => {
    const { ops, addIssue, issues } = makeWorld();
    addIssue("BUTCHR-1", { issuetype: "Story", project: "BUTCHR" });
    addIssue("BUTCHR-2", { issuetype: "Task", project: "BUTCHR", bossKey: "BUTCHR-1", description: "old", summary: "kept summary" });
    await correctWorker(ops, "BUTCHR-1", "BUTCHR-2", { description: "new", why: "reason" });
    expect(issues.get("BUTCHR-2")!.description).toBe("new");
    expect(issues.get("BUTCHR-2")!.summary).toBe("kept summary");
  });

  test("a summary-only call writes ONLY summary — description is untouched", async () => {
    const { ops, addIssue, issues } = makeWorld();
    addIssue("BUTCHR-1", { issuetype: "Story", project: "BUTCHR" });
    addIssue("BUTCHR-2", { issuetype: "Task", project: "BUTCHR", bossKey: "BUTCHR-1", description: "kept description", summary: "old summary" });
    await correctWorker(ops, "BUTCHR-1", "BUTCHR-2", { summary: "new summary", why: "reason" });
    expect(issues.get("BUTCHR-2")!.summary).toBe("new summary");
    expect(issues.get("BUTCHR-2")!.description).toBe("kept description");
  });

  test("result.message names the summary-snapshot limitation ONLY when a summary was actually corrected", async () => {
    const { ops, addIssue } = makeWorld();
    addIssue("BUTCHR-1", { issuetype: "Story", project: "BUTCHR" });
    addIssue("BUTCHR-2", { issuetype: "Task", project: "BUTCHR", bossKey: "BUTCHR-1", description: "old", summary: "old summary" });
    const descOnly = await correctWorker(ops, "BUTCHR-1", "BUTCHR-2", { description: "new", why: "reason" });
    expect(descOnly.message).not.toMatch(/SNAPSHOTTED/);
    const summaryToo = await correctWorker(ops, "BUTCHR-1", "BUTCHR-2", { summary: "newer summary", why: "reason 2" });
    expect(summaryToo.message).toMatch(/SNAPSHOTTED/);
    expect(summaryToo.message).toMatch(/tell_worker/);
  });
});

// ---------------------------------------------------------------------------
// shelve_worker — the label
// ---------------------------------------------------------------------------

describe("shelveWorker", () => {
  test("refuses a stranger's key", async () => {
    const { ops, addIssue } = makeWorld();
    addIssue("BUTCHR-1", { issuetype: "Epic", project: "BUTCHR" });
    addIssue("BUTCHR-9", { issuetype: "Task", project: "BUTCHR", bossKey: "SOMEONE-ELSE" });
    await expect(shelveWorker(ops, "BUTCHR-1", "BUTCHR-9", "reason")).rejects.toThrow(/not one of BUTCHR-1's own workers/);
  });

  test("refuses an empty reason", async () => {
    const { ops, addIssue } = makeWorld();
    addIssue("BUTCHR-1", { issuetype: "Epic", project: "BUTCHR" });
    addIssue("BUTCHR-2", { issuetype: "Story", project: "BUTCHR", bossKey: "BUTCHR-1" });
    await expect(shelveWorker(ops, "BUTCHR-1", "BUTCHR-2", "   ")).rejects.toThrow(/reason/);
  });

  test("moves to To Do, sets EXACTLY the detector's label (not a near-miss), and posts the reason — all as one call", async () => {
    const { ops, addIssue, issues } = makeWorld();
    addIssue("BUTCHR-1", { issuetype: "Epic", project: "BUTCHR" });
    addIssue("BUTCHR-2", { issuetype: "Story", project: "BUTCHR", bossKey: "BUTCHR-1", status: "In Progress" });
    await shelveWorker(ops, "BUTCHR-1", "BUTCHR-2", "waiting on the API design");
    const w = issues.get("BUTCHR-2")!;
    expect(w.status).toBe("To Do");
    expect(w.labels).toContain(EXEMPT_LABEL);
    expect(w.labels).toContain("butchr:shelved"); // the literal itself, pinned — not a near-miss like "butchr:shelve" or "butchr-shelved"
    expect(w.comments.some((c) => c.includes("waiting on the API design"))).toBe(true);
  });

  test("THE LABEL WRITE IS ADDITIVE — starting from a ticket that already carries other labels, none of them are dropped", async () => {
    const { ops, addIssue, issues } = makeWorld();
    addIssue("BUTCHR-1", { issuetype: "Epic", project: "BUTCHR" });
    addIssue("BUTCHR-2", { issuetype: "Story", project: "BUTCHR", bossKey: "BUTCHR-1", labels: ["team:infra", "agent:working"] });
    await shelveWorker(ops, "BUTCHR-1", "BUTCHR-2", "reason");
    const labels = issues.get("BUTCHR-2")!.labels;
    expect(labels).toContain("team:infra");
    expect(labels).toContain("agent:working");
    expect(labels).toContain(EXEMPT_LABEL);
    expect(labels.length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// adopt_worker
// ---------------------------------------------------------------------------

describe("adoptWorker", () => {
  test("refuses a ticket already linked to a DIFFERENT boss", async () => {
    const { ops, addIssue } = makeWorld();
    addIssue("BUTCHR-1", { issuetype: "Epic", project: "BUTCHR" });
    addIssue("BUTCHR-9", { issuetype: "Task", project: "BUTCHR", bossKey: "SOMEONE-ELSE" });
    await expect(adoptWorker(ops, ROLES, "BUTCHR-1", "BUTCHR-9", { kind: "start" }))
      .rejects.toThrow(/already linked to a different boss \(SOMEONE-ELSE\)/);
  });

  test("refuses a \"shelve\" disposition with an empty reason", async () => {
    const { ops, addIssue } = makeWorld();
    addIssue("BUTCHR-1", { issuetype: "Epic", project: "BUTCHR" });
    addIssue("BUTCHR-9", { issuetype: "Task", project: "BUTCHR" });
    await expect(adoptWorker(ops, ROLES, "BUTCHR-1", "BUTCHR-9", { kind: "shelve", reason: "  " })).rejects.toThrow(/reason/);
  });

  test("adopts an orphan: assigns by the ADOPTED ticket's OWN type, links it (from=adopted, to=caller), applies disposition", async () => {
    const { ops, addIssue, issues, setProjectProperty } = makeWorld();
    setProjectProperty("BUTCHR", BUTCHR_PROPERTY);
    addIssue("BUTCHR-1", { issuetype: "Epic", project: "BUTCHR" });
    addIssue("BUTCHR-9", { issuetype: "Task", project: "BUTCHR" }); // orphan, no boss
    const result = await adoptWorker(ops, ROLES, "BUTCHR-1", "BUTCHR-9", { kind: "start" });
    expect(result.alreadyAdopted).toBe(false);
    const w = issues.get("BUTCHR-9")!;
    expect(w.assignee).toBe(ROLES.task); // Task's own type, not the caller's (Epic)
    expect(w.bossKey).toBe("BUTCHR-1");
    expect(w.status).toBe("In Progress");
  });

  test("refuses adopting an Epic (no successor issue type)", async () => {
    const { ops, addIssue } = makeWorld();
    addIssue("BUTCHR-1", { issuetype: "Epic", project: "BUTCHR" });
    addIssue("BUTCHR-9", { issuetype: "Epic", project: "BUTCHR" });
    await expect(adoptWorker(ops, ROLES, "BUTCHR-1", "BUTCHR-9", { kind: "start" })).rejects.toThrow(/cannot be adopted/);
  });

  test("IDEMPOTENT: a ticket already linked, assigned by role, AND already in the state its disposition names changes nothing and is not an error", async () => {
    const { ops, addIssue, issues, setProjectProperty } = makeWorld();
    setProjectProperty("BUTCHR", BUTCHR_PROPERTY);
    addIssue("BUTCHR-1", { issuetype: "Epic", project: "BUTCHR" });
    addIssue("BUTCHR-9", { issuetype: "Task", project: "BUTCHR", bossKey: "BUTCHR-1", assignee: ROLES.task, status: "In Progress" });
    let assignCalls = 0, linkCalls = 0, transitionCalls = 0;
    const spied: AtlassianOps = {
      ...ops,
      assign: async (...a) => { assignCalls++; return ops.assign(...a); },
      linkIssues: async (...a) => { linkCalls++; return ops.linkIssues(...a); },
      transition: async (...a) => { transitionCalls++; return ops.transition(...a); },
    };
    const result = await adoptWorker(spied, ROLES, "BUTCHR-1", "BUTCHR-9", { kind: "start" });
    expect(result.alreadyAdopted).toBe(true);
    expect(assignCalls).toBe(0);
    expect(linkCalls).toBe(0);
    expect(transitionCalls).toBe(0);
    const w = issues.get("BUTCHR-9")!;
    expect(w.assignee).toBe(ROLES.task);
    expect(w.status).toBe("In Progress");
  });

  test("THE RECOVERY-PATH BUG: a ticket that is already linked and assigned but NOT YET DECLARED (new_worker's own worst-case partial state on a deployment where deleteIssue is refused) is NOT reported as already adopted — the disposition is genuinely applied, not silently skipped", async () => {
    const { ops, addIssue, issues, setProjectProperty } = makeWorld();
    setProjectProperty("BUTCHR", BUTCHR_PROPERTY);
    addIssue("BUTCHR-1", { issuetype: "Epic", project: "BUTCHR" });
    // Linked AND assigned already (as new_worker's steps 1-2 would leave it),
    // but still To Do with NO exemption label — undeclared, exactly what the
    // parked-ticket detector escalates on.
    addIssue("BUTCHR-9", { issuetype: "Task", project: "BUTCHR", bossKey: "BUTCHR-1", assignee: ROLES.task, status: "To Do" });
    let assignCalls = 0, linkCalls = 0;
    const spied: AtlassianOps = {
      ...ops,
      assign: async (...a) => { assignCalls++; return ops.assign(...a); },
      linkIssues: async (...a) => { linkCalls++; return ops.linkIssues(...a); },
    };
    const result = await adoptWorker(spied, ROLES, "BUTCHR-1", "BUTCHR-9", { kind: "start" });
    expect(result.alreadyAdopted).toBe(false); // NOT a no-op
    expect(assignCalls).toBe(0); // already correct — not redundantly re-written
    expect(linkCalls).toBe(0); // already correct — not redundantly re-written
    expect(issues.get("BUTCHR-9")!.status).toBe("In Progress"); // the disposition WAS actually applied
  });

  test("shelve disposition on a fresh adoption sets the label additively and posts the reason", async () => {
    const { ops, addIssue, issues, setProjectProperty } = makeWorld();
    setProjectProperty("BUTCHR", BUTCHR_PROPERTY);
    addIssue("BUTCHR-1", { issuetype: "Epic", project: "BUTCHR" });
    addIssue("BUTCHR-9", { issuetype: "Story", project: "BUTCHR", labels: ["team:infra"] });
    await adoptWorker(ops, ROLES, "BUTCHR-1", "BUTCHR-9", { kind: "shelve", reason: "not ready yet" });
    const w = issues.get("BUTCHR-9")!;
    expect(w.status).toBe("To Do");
    expect(w.labels).toContain("team:infra");
    expect(w.labels).toContain(EXEMPT_LABEL);
  });

  test("shelve disposition on an already-Story-in-To-Do doesn't attempt a self-transition (label + comment only)", async () => {
    const { ops, addIssue, issues, setProjectProperty } = makeWorld();
    setProjectProperty("BUTCHR", BUTCHR_PROPERTY);
    addIssue("BUTCHR-1", { issuetype: "Epic", project: "BUTCHR" });
    addIssue("BUTCHR-9", { issuetype: "Story", project: "BUTCHR", status: "To Do" });
    let transitionCalls = 0;
    const spied: AtlassianOps = { ...ops, transition: async (...a) => { transitionCalls++; return ops.transition(...a); } };
    await adoptWorker(spied, ROLES, "BUTCHR-1", "BUTCHR-9", { kind: "shelve", reason: "later" });
    expect(transitionCalls).toBe(0);
    expect(issues.get("BUTCHR-9")!.labels).toContain(EXEMPT_LABEL);
  });

  test("ORDERING: a fresh-adoption shelve labels BEFORE transitioning — if addLabels fails, the ticket is NOT left To Do without the label", async () => {
    const { ops, addIssue, issues, setProjectProperty } = makeWorld();
    setProjectProperty("BUTCHR", BUTCHR_PROPERTY);
    addIssue("BUTCHR-1", { issuetype: "Epic", project: "BUTCHR" });
    addIssue("BUTCHR-9", { issuetype: "Task", project: "BUTCHR", status: "In Progress" });
    const broken: AtlassianOps = { ...ops, addLabels: async () => { throw new Error("label write refused"); } };
    await expect(adoptWorker(broken, ROLES, "BUTCHR-1", "BUTCHR-9", { kind: "shelve", reason: "later" })).rejects.toThrow(/label write refused/);
    expect(issues.get("BUTCHR-9")!.status).toBe("In Progress"); // NOT transitioned to To Do — never parked-looking
  });

  test("THE DISCARDED-REASON BUG: adopting an orphan that ALREADY carries the exemption label (set by a human, or a boss that has since died) still posts the caller's reason — a shelved worker must never end up with no activation condition on record", async () => {
    const { ops, addIssue, issues, setProjectProperty } = makeWorld();
    setProjectProperty("BUTCHR", BUTCHR_PROPERTY);
    addIssue("BUTCHR-1", { issuetype: "Epic", project: "BUTCHR" });
    // Exact repro from review: To Do, already labelled, but unlinked and unassigned.
    addIssue("BUTCHR-9", { issuetype: "Story", project: "BUTCHR", status: "To Do", labels: [EXEMPT_LABEL] });
    let transitionCalls = 0, labelCalls = 0;
    const spied: AtlassianOps = {
      ...ops,
      transition: async (...a) => { transitionCalls++; return ops.transition(...a); },
      addLabels: async (...a) => { labelCalls++; return ops.addLabels(...a); },
    };
    const result = await adoptWorker(spied, ROLES, "BUTCHR-1", "BUTCHR-9", { kind: "shelve", reason: "MY-FRESH-REASON" });
    expect(result.alreadyAdopted).toBe(false); // real adoption work happened (link + assign)
    const w = issues.get("BUTCHR-9")!;
    expect(w.bossKey).toBe("BUTCHR-1");
    expect(w.assignee).toBe(ROLES.story);
    expect(w.comments.some((c) => c.includes("MY-FRESH-REASON"))).toBe(true); // THE bug: this must never be empty
    expect(transitionCalls).toBe(0); // state already correct — no redundant write
    expect(labelCalls).toBe(0); // state already correct — no redundant write
  });
});

describe("shelveWorker: ORDERING — label before transition", () => {
  test("if addLabels fails, the ticket is NOT left To Do without the exemption label (the parked-looking state)", async () => {
    const { ops, addIssue, issues } = makeWorld();
    addIssue("BUTCHR-1", { issuetype: "Epic", project: "BUTCHR" });
    addIssue("BUTCHR-2", { issuetype: "Story", project: "BUTCHR", bossKey: "BUTCHR-1", status: "In Progress" });
    const broken: AtlassianOps = { ...ops, addLabels: async () => { throw new Error("label write refused"); } };
    await expect(shelveWorker(broken, "BUTCHR-1", "BUTCHR-2", "later")).rejects.toThrow(/label write refused/);
    expect(issues.get("BUTCHR-2")!.status).toBe("In Progress"); // never transitioned — the addLabels call comes first
  });
});

// ---------------------------------------------------------------------------
// Worker -> boss
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// classifyDestination — the refusal shapes, pure
// ---------------------------------------------------------------------------

describe("classifyDestination", () => {
  test("empty/whitespace-only refuses, teaching both accepted shapes and WHY", async () => {
    for (const bad of ["", "   "]) {
      expect(() => classifyDestination(bad)).toThrow(/EXISTING EPIC KEY.*brand-new epic.*half the job/s);
    }
  });

  test("known placeholders refuse, normalized (case, whitespace, trailing punctuation)", () => {
    for (const bad of ["n/a", "N/A", "N/A.", " tbd ", "Unknown", "none", "?", "-", "idk"]) {
      expect(() => classifyDestination(bad)).toThrow(/placeholder/);
    }
  });

  test("prose too thin to be a real reason refuses, but a genuinely terse real reason survives", () => {
    expect(() => classifyDestination("misc")).toThrow(/too thin/);
    expect(() => classifyDestination("later maybe")).not.toThrow(); // 10 non-space chars, and not a listed placeholder
    expect(classifyDestination("no epic covers billing yet")).toEqual({ kind: "reason", text: "no epic covers billing yet" });
  });

  test("a Jira-key-shaped destination classifies as an epic candidate, UNVALIDATED (existence/type is the caller's job)", () => {
    expect(classifyDestination("BUTCHR-25")).toEqual({ kind: "epic", key: "BUTCHR-25" });
    expect(classifyDestination("  BUTCHR-25  ")).toEqual({ kind: "epic", key: "BUTCHR-25" });
  });
});

// ---------------------------------------------------------------------------
// fileWhereItBelongs — the 2026-08-30 regression scenario: an agent files
// work outside its own epic, and the result must have BOTH halves: the
// destination stated on the ticket itself, AND a notice a person receives.
// ---------------------------------------------------------------------------

describe("fileWhereItBelongs: refusals", () => {
  test("refuses without a valid destination (delegates to classifyDestination's teaching message)", async () => {
    const { ops, addIssue, setProjectProperty } = makeWorld();
    setProjectProperty("BUTCHR", BUTCHR_PROPERTY);
    addIssue("BUTCHR-7", { issuetype: "Task", project: "BUTCHR" });
    await expect(fileWhereItBelongs(ops, ROLES, "BUTCHR-7", { summary: "s", issuetype: "Task", destination: "n/a" }))
      .rejects.toThrow(/placeholder/);
  });

  test("refuses a Jira-key destination that does not exist", async () => {
    const { ops, addIssue, setProjectProperty } = makeWorld();
    setProjectProperty("BUTCHR", BUTCHR_PROPERTY);
    addIssue("BUTCHR-7", { issuetype: "Task", project: "BUTCHR" });
    await expect(fileWhereItBelongs(ops, ROLES, "BUTCHR-7", { summary: "s", issuetype: "Task", destination: "BUTCHR-999" }))
      .rejects.toThrow(/"BUTCHR-999".*could not be read/s);
  });

  test("refuses a Jira-key destination that exists but is NOT an Epic, naming what it actually is", async () => {
    const { ops, addIssue, setProjectProperty } = makeWorld();
    setProjectProperty("BUTCHR", BUTCHR_PROPERTY);
    addIssue("BUTCHR-7", { issuetype: "Task", project: "BUTCHR" });
    addIssue("BUTCHR-2", { issuetype: "Story", project: "BUTCHR" });
    await expect(fileWhereItBelongs(ops, ROLES, "BUTCHR-7", { summary: "s", issuetype: "Task", destination: "BUTCHR-2" }))
      .rejects.toThrow(/"BUTCHR-2" exists but is a Story, not an Epic/);
  });

  test("refuses when the requested issuetype's role has no configured accountId", async () => {
    const { ops, addIssue, setProjectProperty } = makeWorld();
    setProjectProperty("BUTCHR", BUTCHR_PROPERTY);
    addIssue("BUTCHR-7", { issuetype: "Task", project: "BUTCHR" });
    addIssue("BUTCHR-1", { issuetype: "Epic", project: "BUTCHR" });
    await expect(fileWhereItBelongs(ops, {}, "BUTCHR-7", { summary: "s", issuetype: "Task", destination: "BUTCHR-1" }))
      .rejects.toThrow(/BUTCHR_ASSIGNEE_TASK/);
  });
});

describe("fileWhereItBelongs: case A — destination is an existing epic key", () => {
  test("THE REGRESSION SCENARIO, case A: the created ticket states its destination AND a notice reaches the named epic — both halves, on the real end state", async () => {
    const { ops, addIssue, issues, setProjectProperty } = makeWorld();
    setProjectProperty("BUTCHR", BUTCHR_PROPERTY);
    addIssue("BUTCHR-1", { issuetype: "Epic", project: "BUTCHR" }); // the destination epic
    addIssue("BUTCHR-7", { issuetype: "Story", project: "BUTCHR", bossKey: "BUTCHR-1" }); // the filer, in-scope under its own epic

    const result = await fileWhereItBelongs(ops, ROLES, "BUTCHR-7", {
      summary: "found this while doing BUTCHR-7, not mine",
      issuetype: "Task",
      destination: "BUTCHR-1",
    });

    // HALF ONE: the destination is stated on the ticket's own description + a filterable label.
    const created = issues.get(result.key)!;
    expect(created.description).toMatch(/Epic BUTCHR-1/);
    expect(created.description).toMatch(/Filed by: BUTCHR-7/);
    expect(created.labels).toContain(ORPHAN_LABEL);
    expect(created.labels).not.toContain(EXEMPT_LABEL); // never cargo-culted — parkedCandidates can't see this ticket anyway
    expect(created.bossKey).toBeUndefined(); // TRUE ORPHAN — no Implements link, ever
    expect(created.status).toBe("To Do"); // staffed by role, never transitioned
    expect(created.assignee).toBe(ROLES.task);

    // HALF TWO: a notice actually reaches a ticket a human watches — the named epic.
    expect(result.noticeTarget).toBe("BUTCHR-1");
    const notice = issues.get("BUTCHR-1")!.comments[0]!;
    expect(notice).toContain(result.key);
    expect(notice).toContain("BUTCHR-7"); // who filed it
    expect(notice).toMatch(/not linked to you/i); // notice is NOT the home
    expect(issues.get("BUTCHR-1")!.bossKey).toBeUndefined(); // the epic never became this ticket's boss either
  });

  test("the doc is ensured and bottoms out under the project root (no boss)", async () => {
    const { ops, addIssue, pages, setProjectProperty } = makeWorld();
    setProjectProperty("BUTCHR", BUTCHR_PROPERTY);
    addIssue("BUTCHR-1", { issuetype: "Epic", project: "BUTCHR" });
    addIssue("BUTCHR-7", { issuetype: "Story", project: "BUTCHR", bossKey: "BUTCHR-1" });
    const result = await fileWhereItBelongs(ops, ROLES, "BUTCHR-7", { summary: "s", issuetype: "Task", destination: "BUTCHR-1" });
    expect(result.doc).toBeDefined();
    expect(pages.get(result.doc.id)!.parentId).toBe(ROOT_DOC_ID);
  });
});

describe("fileWhereItBelongs: case B — destination is a reason a NEW epic is needed", () => {
  test("THE REGRESSION SCENARIO, case B: no epic to comment on, so the notice walks the CALLER's own Implements chain to the topmost ticket — and still creates NO link", async () => {
    const { ops, addIssue, issues, setProjectProperty } = makeWorld();
    setProjectProperty("BUTCHR", BUTCHR_PROPERTY);
    addIssue("BUTCHR-1", { issuetype: "Epic", project: "BUTCHR" }); // topmost — the caller's grandboss
    addIssue("BUTCHR-2", { issuetype: "Story", project: "BUTCHR", bossKey: "BUTCHR-1" }); // caller's boss
    addIssue("BUTCHR-7", { issuetype: "Task", project: "BUTCHR", bossKey: "BUTCHR-2" }); // the filer

    const result = await fileWhereItBelongs(ops, ROLES, "BUTCHR-7", {
      summary: "unrelated infra work",
      issuetype: "Task",
      destination: "no epic covers observability tooling yet",
    });

    // HALF ONE: destination stated on the ticket, even though it names no key.
    const created = issues.get(result.key)!;
    expect(created.description).toMatch(/a NEW epic/);
    expect(created.description).toMatch(/observability tooling/);
    expect(created.labels).toContain(ORPHAN_LABEL);
    expect(created.bossKey).toBeUndefined(); // CRITICAL: case B creates NO link — not to BUTCHR-1, not to anything

    // HALF TWO: the notice lands on the TOPMOST ticket in BUTCHR-7's OWN chain (BUTCHR-1), never on BUTCHR-7 itself or BUTCHR-2.
    expect(result.noticeTarget).toBe("BUTCHR-1");
    expect(issues.get("BUTCHR-2")!.comments).toEqual([]);
    const notice = issues.get("BUTCHR-1")!.comments[0]!;
    expect(notice).toContain(result.key);
    expect(notice).toContain("BUTCHR-7");
    expect(notice).toMatch(/observability tooling/);
    expect(issues.get("BUTCHR-1")!.bossKey).toBeUndefined(); // still not linked to anything
  });

  test("when the caller itself has no boss (an Epic filing on its own behalf), the topmost ticket IS the caller", async () => {
    const { ops, addIssue, issues, setProjectProperty } = makeWorld();
    setProjectProperty("BUTCHR", BUTCHR_PROPERTY);
    addIssue("BUTCHR-1", { issuetype: "Epic", project: "BUTCHR" }); // no boss — topmost by construction
    const result = await fileWhereItBelongs(ops, ROLES, "BUTCHR-1", { summary: "s", issuetype: "Task", destination: "needs a brand new epic entirely" });
    expect(result.noticeTarget).toBe("BUTCHR-1");
    expect(issues.get("BUTCHR-1")!.comments.length).toBe(1);
  });
});

describe("fileWhereItBelongs: partial-failure honesty — the ticket, once created, is NEVER rolled back", () => {
  test("notice failing: the ticket survives, fully documented, and the throw names the notice failure without claiming anything needs cleanup on the ticket itself", async () => {
    const { ops, addIssue, issues, setProjectProperty } = makeWorld();
    setProjectProperty("BUTCHR", BUTCHR_PROPERTY);
    addIssue("BUTCHR-1", { issuetype: "Epic", project: "BUTCHR" });
    addIssue("BUTCHR-7", { issuetype: "Story", project: "BUTCHR", bossKey: "BUTCHR-1" });
    const broken: AtlassianOps = { ...ops, addComment: async (key: string) => { if (key === "BUTCHR-1") throw new Error("comment refused"); return { ok: true }; } };
    let thrown: Error | undefined;
    let key: string | undefined;
    const before = issues.size;
    try {
      await fileWhereItBelongs(broken, ROLES, "BUTCHR-7", { summary: "s", issuetype: "Task", destination: "BUTCHR-1" });
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown?.message).toMatch(/nothing there needs cleanup/);
    expect(thrown?.message).toMatch(/notice comment on BUTCHR-1 failed/);
    // exactly one new ticket was created and SURVIVES, destination + label intact.
    const created = [...issues.entries()].filter(([k]) => !["BUTCHR-1", "BUTCHR-7"].includes(k));
    expect(created.length).toBe(1);
    key = created[0]![0];
    expect(issues.get(key)!.labels).toContain(ORPHAN_LABEL);
    expect(issues.size).toBe(before + 1);
  });

  test("doc failing: the ticket, destination and notice all survive; the throw names the doc failure and how it self-heals", async () => {
    const { ops, addIssue, issues } = makeWorld();
    // no project property registered -> ensureDoc's step 0 throws.
    addIssue("BUTCHR-1", { issuetype: "Epic", project: "BUTCHR" });
    addIssue("BUTCHR-7", { issuetype: "Story", project: "BUTCHR", bossKey: "BUTCHR-1" });
    let thrown: Error | undefined;
    try {
      await fileWhereItBelongs(ops, ROLES, "BUTCHR-7", { summary: "s", issuetype: "Task", destination: "BUTCHR-1" });
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown?.message).toMatch(/Confluence doc failed to create/);
    expect(thrown?.message).toMatch(/own first set_doc call/);
    // the notice still fired despite the doc failure — independent steps.
    expect(issues.get("BUTCHR-1")!.comments.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// jira_create_issue's `implements: "none"` orphan escape is NOT this module's
// concern (it lives in defs.ts, tested in defs.test.ts) — but the parked
// detector's reach IS relevant here: fileWhereItBelongs's ticket must never
// carry EXEMPT_LABEL, on top of the direct assertion above.
// ---------------------------------------------------------------------------

describe("reportToBoss / askBoss / submitToBoss", () => {
  test("reportToBoss comments on the CALLER'S OWN ticket, tagged", async () => {
    const { ops, addIssue, issues } = makeWorld();
    addIssue("BUTCHR-7", { issuetype: "Task", project: "BUTCHR" });
    await reportToBoss(ops, "BUTCHR-7", "status update");
    expect(issues.get("BUTCHR-7")!.comments).toEqual(["[BUTCHR-7] status update"]);
  });

  test("askBoss writes the SAME channel, but marked with the ASK_MARKER right after the identity tag — distinguishing it from reportToBoss", async () => {
    const { ops, addIssue, issues } = makeWorld();
    addIssue("BUTCHR-7", { issuetype: "Task", project: "BUTCHR" });
    await askBoss(ops, "BUTCHR-7", "which approach do you want?");
    expect(issues.get("BUTCHR-7")!.comments).toEqual([`[BUTCHR-7] ${ASK_MARKER} which approach do you want?`]);
    expect(ASK_MARKER).toBe("[ask]");
  });

  test("submitToBoss transitions the CALLER'S OWN ticket to In Review, no arguments", async () => {
    const { ops, addIssue, issues } = makeWorld();
    addIssue("BUTCHR-7", { issuetype: "Task", project: "BUTCHR", status: "In Progress" });
    await submitToBoss(ops, "BUTCHR-7");
    expect(issues.get("BUTCHR-7")!.status).toBe("In Review");
  });
});

// ---------------------------------------------------------------------------
// finish_without_a_boss — the load-bearing test is the refusal: it is the
// review hop this verb exists to protect for the one caller shape (bossless)
// that has no boss to submit to and no boss who will ever call finish_worker.
// ---------------------------------------------------------------------------

describe("finishWithoutABoss", () => {
  test("THE LOAD-BEARING TEST: refuses a caller that HAS a boss, naming the boss and teaching the way out", async () => {
    const { ops, addIssue, issues } = makeWorld();
    addIssue("BUTCHR-1", { issuetype: "Epic", project: "BUTCHR" });
    addIssue("BUTCHR-2", { issuetype: "Story", project: "BUTCHR", bossKey: "BUTCHR-1" });
    await expect(finishWithoutABoss(ops, "BUTCHR-2")).rejects.toThrow(/has a boss \(BUTCHR-1\)/);
    await expect(finishWithoutABoss(ops, "BUTCHR-2")).rejects.toThrow(/submit_to_boss/);
    await expect(finishWithoutABoss(ops, "BUTCHR-2")).rejects.toThrow(/finish_worker/);
    // and, correctly, it was never transitioned by the refused call.
    expect(issues.get("BUTCHR-2")!.status).toBe("To Do");
  });

  test("the happy path: a bossless caller actually reaches Done", async () => {
    const { ops, addIssue, issues } = makeWorld();
    addIssue("BUTCHR-1", { issuetype: "Epic", project: "BUTCHR" }); // no bossKey at all
    await finishWithoutABoss(ops, "BUTCHR-1");
    expect(issues.get("BUTCHR-1")!.status).toBe("Done");
  });
});
