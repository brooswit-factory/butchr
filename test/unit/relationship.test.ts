import { describe, expect, test } from "bun:test";
import {
  newWorker, startWorker, shelveWorker, adoptWorker, finishWorker, prioritizeWorker, tellWorker, correctWorker,
  reportToBoss, askBoss, submitToBoss, finishWithoutABoss, fileWhereItBelongs, classifyDestination, ORPHAN_LABEL, ASK_MARKER, CORRECTION_MARKER,
  CORRECTION_REJECTED_MARKER, JIRA_DESCRIPTION_CHAR_LIMIT, JIRA_SUMMARY_CHAR_LIMIT, JIRA_COMMENT_CHAR_LIMIT, CORRECTION_CHAIN_INCOMPLETE_MARKER,
} from "../../src/tools/relationship.js";
import { EXEMPT_LABEL } from "../../src/agents/parked.js";
import type { AtlassianOps } from "../../src/tools/atlassian.js";

const ROLES = { story: "acct-story", task: "acct-task", epic: "acct-epic" };

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
    removeLabels: async (key: string, labels: readonly string[]) => {
      const i = requireIssue(key);
      const toRemove = new Set(labels);
      i.labels = i.labels.filter((l) => !toRemove.has(l));
      return { ok: true };
    },
    deleteIssue: async (key: string) => {
      if (!issues.delete(key)) throw new Error(`fake world: no such issue ${key}`);
      return { ok: true };
    },
  commentOnPage: async () => ({ ok: true }),
  getPageComments: async () => ({ results: [] }),
  searchProjects: async () => ({ values: [] }),
  getMyself: async () => ({ accountId: "test-account" }),
  setProjectProperty: async () => ({ ok: true }),
  getPageVersions: async () => ({}),
  getIssueComments: async () => ({ results: [] }),
  getProjectPropertyOrNull: async () => null,
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

});

describe("start_worker / finish_worker / adopt_worker: BUTCHR-58 — butchr:shelved means CURRENTLY shelved, so reactivating withdraws it", () => {
  test("start_worker on a worker carrying butchr:shelved removes it BEFORE transitioning (the ordering IS the design decision)", async () => {
    const { ops, addIssue, issues } = makeWorld();
    addIssue("BUTCHR-1", { issuetype: "Epic", project: "BUTCHR" });
    addIssue("BUTCHR-2", { issuetype: "Story", project: "BUTCHR", bossKey: "BUTCHR-1", status: "To Do", labels: [EXEMPT_LABEL, "team:infra"] });
    const calls: string[] = [];
    const spied: AtlassianOps = {
      ...ops,
      removeLabels: async (...a) => { calls.push("removeLabels"); return ops.removeLabels(...a); },
      transition: async (...a) => { calls.push("transition"); return ops.transition(...a); },
    };
    await startWorker(spied, "BUTCHR-1", "BUTCHR-2");
    expect(calls).toEqual(["removeLabels", "transition"]); // order pinned, not just presence
    const w = issues.get("BUTCHR-2")!;
    expect(w.status).toBe("In Progress");
    expect(w.labels).not.toContain(EXEMPT_LABEL);
    expect(w.labels).toContain("team:infra"); // only the exemption is removed, nothing else
  });

  test("start_worker on a worker WITHOUT the label makes no removeLabels call at all — zero extra cost for the common case", async () => {
    const { ops, addIssue, issues } = makeWorld();
    addIssue("BUTCHR-1", { issuetype: "Epic", project: "BUTCHR" });
    addIssue("BUTCHR-2", { issuetype: "Story", project: "BUTCHR", bossKey: "BUTCHR-1", status: "To Do" });
    let removeCalls = 0;
    const spied: AtlassianOps = { ...ops, removeLabels: async (...a) => { removeCalls++; return ops.removeLabels(...a); } };
    await startWorker(spied, "BUTCHR-1", "BUTCHR-2");
    expect(removeCalls).toBe(0);
    expect(issues.get("BUTCHR-2")!.status).toBe("In Progress");
  });

  test("finish_worker on a worker carrying butchr:shelved removes it BEFORE transitioning to Done — same ordering as start_worker", async () => {
    const { ops, addIssue, issues } = makeWorld();
    addIssue("BUTCHR-1", { issuetype: "Epic", project: "BUTCHR" });
    addIssue("BUTCHR-2", { issuetype: "Story", project: "BUTCHR", bossKey: "BUTCHR-1", status: "In Progress", labels: [EXEMPT_LABEL] });
    const calls: string[] = [];
    const spied: AtlassianOps = {
      ...ops,
      removeLabels: async (...a) => { calls.push("removeLabels"); return ops.removeLabels(...a); },
      transition: async (...a) => { calls.push("transition"); return ops.transition(...a); },
    };
    await finishWorker(spied, "BUTCHR-1", "BUTCHR-2");
    expect(calls).toEqual(["removeLabels", "transition"]);
    const w = issues.get("BUTCHR-2")!;
    expect(w.status).toBe("Done");
    expect(w.labels).not.toContain(EXEMPT_LABEL);
  });

  test("finish_worker on a worker WITHOUT the label makes no removeLabels call at all", async () => {
    const { ops, addIssue, issues } = makeWorld();
    addIssue("BUTCHR-1", { issuetype: "Epic", project: "BUTCHR" });
    addIssue("BUTCHR-2", { issuetype: "Story", project: "BUTCHR", bossKey: "BUTCHR-1", status: "In Progress" });
    let removeCalls = 0;
    const spied: AtlassianOps = { ...ops, removeLabels: async (...a) => { removeCalls++; return ops.removeLabels(...a); } };
    await finishWorker(spied, "BUTCHR-1", "BUTCHR-2");
    expect(removeCalls).toBe(0);
    expect(issues.get("BUTCHR-2")!.status).toBe("Done");
  });

  test("adopt_worker with disposition \"start\" on a ticket carrying the label clears it (fresh adoption)", async () => {
    const { ops, addIssue, issues, setProjectProperty } = makeWorld();
    setProjectProperty("BUTCHR", BUTCHR_PROPERTY);
    addIssue("BUTCHR-1", { issuetype: "Epic", project: "BUTCHR" });
    addIssue("BUTCHR-9", { issuetype: "Story", project: "BUTCHR", status: "To Do", labels: [EXEMPT_LABEL] });
    const result = await adoptWorker(ops, ROLES, "BUTCHR-1", "BUTCHR-9", { kind: "start" });
    expect(result.alreadyAdopted).toBe(false);
    const w = issues.get("BUTCHR-9")!;
    expect(w.status).toBe("In Progress");
    expect(w.labels).not.toContain(EXEMPT_LABEL);
  });

  test("adopt_worker with disposition \"start\" clears a stale label even on an otherwise fully idempotent re-adoption (already linked, assigned, In Progress)", async () => {
    const { ops, addIssue, issues, setProjectProperty } = makeWorld();
    setProjectProperty("BUTCHR", BUTCHR_PROPERTY);
    addIssue("BUTCHR-1", { issuetype: "Epic", project: "BUTCHR" });
    // Already fully adopted by every OTHER measure — this is the residue case:
    // alreadyAdopted would be true by the old definition, and a naive
    // "skip everything when alreadyAdopted" implementation reproduces the bug.
    addIssue("BUTCHR-9", { issuetype: "Story", project: "BUTCHR", bossKey: "BUTCHR-1", assignee: ROLES.story, status: "In Progress", labels: [EXEMPT_LABEL] });
    let assignCalls = 0, linkCalls = 0, transitionCalls = 0;
    const spied: AtlassianOps = {
      ...ops,
      assign: async (...a) => { assignCalls++; return ops.assign(...a); },
      linkIssues: async (...a) => { linkCalls++; return ops.linkIssues(...a); },
      transition: async (...a) => { transitionCalls++; return ops.transition(...a); },
    };
    await adoptWorker(spied, ROLES, "BUTCHR-1", "BUTCHR-9", { kind: "start" });
    expect(assignCalls).toBe(0); // already correct — no redundant write
    expect(linkCalls).toBe(0); // already correct — no redundant write
    expect(transitionCalls).toBe(0); // already In Progress — no redundant write
    expect(issues.get("BUTCHR-9")!.labels).not.toContain(EXEMPT_LABEL); // but the stale label is still cleared
  });

  test("adopt_worker with disposition \"shelve\" still SETS the label — existing behaviour does not regress", async () => {
    const { ops, addIssue, issues, setProjectProperty } = makeWorld();
    setProjectProperty("BUTCHR", BUTCHR_PROPERTY);
    addIssue("BUTCHR-1", { issuetype: "Epic", project: "BUTCHR" });
    addIssue("BUTCHR-9", { issuetype: "Task", project: "BUTCHR" });
    await adoptWorker(ops, ROLES, "BUTCHR-1", "BUTCHR-9", { kind: "shelve", reason: "not ready" });
    const w = issues.get("BUTCHR-9")!;
    expect(w.status).toBe("To Do");
    expect(w.labels).toContain(EXEMPT_LABEL);
  });

  test("THE ROUND TRIP IS THE BUG: shelve_worker then start_worker leaves the ticket's label set with no trace of the exemption", async () => {
    const { ops, addIssue, issues } = makeWorld();
    addIssue("BUTCHR-1", { issuetype: "Epic", project: "BUTCHR" });
    addIssue("BUTCHR-2", { issuetype: "Story", project: "BUTCHR", bossKey: "BUTCHR-1", status: "In Progress" });
    await shelveWorker(ops, "BUTCHR-1", "BUTCHR-2", "waiting on a dependency");
    expect(issues.get("BUTCHR-2")!.labels).toContain(EXEMPT_LABEL);
    await startWorker(ops, "BUTCHR-1", "BUTCHR-2");
    const w = issues.get("BUTCHR-2")!;
    expect(w.status).toBe("In Progress");
    expect(w.labels).not.toContain(EXEMPT_LABEL);
  });
});

describe("adopt_worker: BUTCHR-108/BUTCHR-137 — butchr:orphan means UNDIRECTED, so adoption withdraws it for EITHER disposition", () => {
  test("disposition \"start\" on a fresh orphan clears butchr:orphan BEFORE transitioning, and ends up visible to the parked detector like any normal directed ticket (AC5)", async () => {
    const { ops, addIssue, issues, setProjectProperty } = makeWorld();
    setProjectProperty("BUTCHR", BUTCHR_PROPERTY);
    addIssue("BUTCHR-1", { issuetype: "Epic", project: "BUTCHR" });
    addIssue("BUTCHR-9", { issuetype: "Task", project: "BUTCHR", status: "To Do", labels: [ORPHAN_LABEL, "team:infra"] });
    const calls: string[] = [];
    const spied: AtlassianOps = {
      ...ops,
      removeLabels: async (...a) => { calls.push("removeLabels"); return ops.removeLabels(...a); },
      transition: async (...a) => { calls.push("transition"); return ops.transition(...a); },
    };
    await adoptWorker(spied, ROLES, "BUTCHR-1", "BUTCHR-9", { kind: "start" });
    expect(calls).toEqual(["removeLabels", "transition"]); // order pinned, not just presence
    const w = issues.get("BUTCHR-9")!;
    expect(w.status).toBe("In Progress");
    expect(w.labels).not.toContain(ORPHAN_LABEL);
    expect(w.labels).not.toContain(EXEMPT_LABEL); // AC5: a "start" adoption never cargo-cults the exemption in either
    expect(w.labels).toContain("team:infra"); // only the orphan label is removed, nothing else
  });

  test("disposition \"shelve\" on a fresh orphan clears butchr:orphan and adds butchr:shelved in the same call — the two labels never end up coexisting, and the ticket ends up correctly exempt from the parked detector (AC5)", async () => {
    const { ops, addIssue, issues, setProjectProperty } = makeWorld();
    setProjectProperty("BUTCHR", BUTCHR_PROPERTY);
    addIssue("BUTCHR-1", { issuetype: "Epic", project: "BUTCHR" });
    addIssue("BUTCHR-9", { issuetype: "Story", project: "BUTCHR", status: "To Do", labels: [ORPHAN_LABEL] });
    const calls: string[] = [];
    const spied: AtlassianOps = {
      ...ops,
      removeLabels: async (...a) => { calls.push("removeLabels"); return ops.removeLabels(...a); },
      addLabels: async (...a) => { calls.push("addLabels"); return ops.addLabels(...a); },
    };
    await adoptWorker(spied, ROLES, "BUTCHR-1", "BUTCHR-9", { kind: "shelve", reason: "not ready" });
    expect(calls).toEqual(["removeLabels", "addLabels"]); // the orphan clear happens before the exemption is added
    const w = issues.get("BUTCHR-9")!;
    expect(w.status).toBe("To Do");
    expect(w.labels).not.toContain(ORPHAN_LABEL);
    expect(w.labels).toContain(EXEMPT_LABEL);
  });

  test("a ticket that never carried butchr:orphan makes no removeLabels call for it — zero extra cost", async () => {
    const { ops, addIssue, issues, setProjectProperty } = makeWorld();
    setProjectProperty("BUTCHR", BUTCHR_PROPERTY);
    addIssue("BUTCHR-1", { issuetype: "Epic", project: "BUTCHR" });
    addIssue("BUTCHR-9", { issuetype: "Task", project: "BUTCHR" });
    let removeCalls = 0;
    const spied: AtlassianOps = { ...ops, removeLabels: async (...a) => { removeCalls++; return ops.removeLabels(...a); } };
    await adoptWorker(spied, ROLES, "BUTCHR-1", "BUTCHR-9", { kind: "start" });
    expect(removeCalls).toBe(0);
    expect(issues.get("BUTCHR-9")!.status).toBe("In Progress");
  });

  test("re-adoption of an already-adopted ticket (the alreadyAdopted no-op path, disposition \"start\") still clears a stale butchr:orphan", async () => {
    const { ops, addIssue, issues, setProjectProperty } = makeWorld();
    setProjectProperty("BUTCHR", BUTCHR_PROPERTY);
    addIssue("BUTCHR-1", { issuetype: "Epic", project: "BUTCHR" });
    // Already fully adopted by every OTHER measure (linked, assigned, In Progress) —
    // a naive "skip everything when alreadyAdopted" implementation would leave this
    // stale label behind, exactly the residue this fix exists to stop producing.
    addIssue("BUTCHR-9", { issuetype: "Task", project: "BUTCHR", bossKey: "BUTCHR-1", assignee: ROLES.task, status: "In Progress", labels: [ORPHAN_LABEL] });
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
    expect(issues.get("BUTCHR-9")!.labels).not.toContain(ORPHAN_LABEL); // but the stale orphan label is still cleared
  });

  test("re-adoption of an already-adopted ticket (the alreadyAdopted no-op path, disposition \"shelve\") still clears a stale butchr:orphan, keeping butchr:shelved", async () => {
    const { ops, addIssue, issues, setProjectProperty } = makeWorld();
    setProjectProperty("BUTCHR", BUTCHR_PROPERTY);
    addIssue("BUTCHR-1", { issuetype: "Epic", project: "BUTCHR" });
    addIssue("BUTCHR-9", { issuetype: "Story", project: "BUTCHR", bossKey: "BUTCHR-1", assignee: ROLES.story, status: "To Do", labels: [EXEMPT_LABEL, ORPHAN_LABEL] });
    const result = await adoptWorker(ops, ROLES, "BUTCHR-1", "BUTCHR-9", { kind: "shelve", reason: "still not ready" });
    expect(result.alreadyAdopted).toBe(true);
    const w = issues.get("BUTCHR-9")!;
    expect(w.labels).not.toContain(ORPHAN_LABEL);
    expect(w.labels).toContain(EXEMPT_LABEL); // "shelve" never clears its own exemption label, only the orphan one
  });
});

describe("start_worker / finish_worker / prioritize_worker / tell_worker: ownership refusal (continued)", () => {
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

  test("edit failing AFTER a successful archive: a REJECTED annotation follows it each time, description UNCHANGED, error says safe to retry", async () => {
    const { ops, addIssue, issues } = makeWorld();
    addIssue("BUTCHR-1", { issuetype: "Story", project: "BUTCHR" });
    addIssue("BUTCHR-2", { issuetype: "Task", project: "BUTCHR", bossKey: "BUTCHR-1", description: "old" });
    const failingOps: AtlassianOps = { ...ops, correctText: async () => { throw new Error("edit API down"); } };
    await expect(correctWorker(failingOps, "BUTCHR-1", "BUTCHR-2", { description: "new", why: "reason" })).rejects.toThrow(/UNCHANGED/);
    await expect(correctWorker(failingOps, "BUTCHR-1", "BUTCHR-2", { description: "new", why: "reason" })).rejects.toThrow(/retry/i);
    const comments = issues.get("BUTCHR-2")!.comments;
    expect(comments).toHaveLength(4); // archive + REJECTED annotation, twice (safe to retry)
    expect(comments[0]).toContain(CORRECTION_MARKER);
    expect(comments[1]).toContain(CORRECTION_REJECTED_MARKER);
    expect(comments[1]).toMatch(/REJECTED/);
    expect(comments[2]).toContain(CORRECTION_MARKER);
    expect(comments[3]).toContain(CORRECTION_REJECTED_MARKER);
    expect(issues.get("BUTCHR-2")!.description).toBe("old"); // the edit never took
  });

  test("edit fails and the REJECTED annotation itself also fails: the ORIGINAL edit error still surfaces, unmasked", async () => {
    const { ops, addIssue, issues } = makeWorld();
    addIssue("BUTCHR-1", { issuetype: "Story", project: "BUTCHR" });
    addIssue("BUTCHR-2", { issuetype: "Task", project: "BUTCHR", bossKey: "BUTCHR-1", description: "old" });
    let addCommentCalls = 0;
    const failingOps: AtlassianOps = {
      ...ops,
      correctText: async () => { throw new Error("edit API down"); },
      addComment: async (key: string, text: string) => {
        addCommentCalls++;
        if (addCommentCalls === 1) return ops.addComment(key, text); // the archive itself still succeeds
        throw new Error("comment API down too"); // the follow-up annotation attempt fails
      },
    };
    await expect(correctWorker(failingOps, "BUTCHR-1", "BUTCHR-2", { description: "new", why: "reason" })).rejects.toThrow(/edit API down/);
    // a catch that rethrew the annotation's own error, or swallowed the original, would fail the assertion above.
    expect(issues.get("BUTCHR-2")!.comments).toHaveLength(1); // only the archive landed; the failed annotation attempt wrote nothing
    expect(issues.get("BUTCHR-2")!.description).toBe("old");
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

  test("refuses an oversized `description` BEFORE any write — zero addComment, zero correctText calls, ticket untouched", async () => {
    const { ops, addIssue, issues } = makeWorld();
    addIssue("BUTCHR-1", { issuetype: "Story", project: "BUTCHR" });
    addIssue("BUTCHR-2", { issuetype: "Task", project: "BUTCHR", bossKey: "BUTCHR-1", description: "old" });
    let addCommentCalls = 0, correctTextCalls = 0;
    const countingOps: AtlassianOps = {
      ...ops,
      addComment: async (key: string, text: string) => { addCommentCalls++; return ops.addComment(key, text); },
      correctText: async (key: string, p) => { correctTextCalls++; return ops.correctText(key, p); },
    };
    const oversized = "x".repeat(JIRA_DESCRIPTION_CHAR_LIMIT + 1);
    await expect(correctWorker(countingOps, "BUTCHR-1", "BUTCHR-2", { description: oversized, why: "reason" })).rejects.toThrow(new RegExp(String(JIRA_DESCRIPTION_CHAR_LIMIT)));
    expect(addCommentCalls).toBe(0); // no archive was posted
    expect(correctTextCalls).toBe(0); // no edit was attempted
    expect(issues.get("BUTCHR-2")!.description).toBe("old"); // byte-for-byte untouched
  });

  test("refuses an oversized `summary` BEFORE any write — zero addComment, zero correctText calls, ticket untouched", async () => {
    const { ops, addIssue, issues } = makeWorld();
    addIssue("BUTCHR-1", { issuetype: "Story", project: "BUTCHR" });
    addIssue("BUTCHR-2", { issuetype: "Task", project: "BUTCHR", bossKey: "BUTCHR-1", summary: "old summary" });
    let addCommentCalls = 0, correctTextCalls = 0;
    const countingOps: AtlassianOps = {
      ...ops,
      addComment: async (key: string, text: string) => { addCommentCalls++; return ops.addComment(key, text); },
      correctText: async (key: string, p) => { correctTextCalls++; return ops.correctText(key, p); },
    };
    const oversized = "x".repeat(JIRA_SUMMARY_CHAR_LIMIT + 1);
    await expect(correctWorker(countingOps, "BUTCHR-1", "BUTCHR-2", { summary: oversized, why: "reason" })).rejects.toThrow(new RegExp(String(JIRA_SUMMARY_CHAR_LIMIT)));
    expect(addCommentCalls).toBe(0);
    expect(correctTextCalls).toBe(0);
    expect(issues.get("BUTCHR-2")!.summary).toBe("old summary");
  });

  test("does NOT refuse a description exactly AT the limit — the check is `>`, not `>=`", async () => {
    const { ops, addIssue } = makeWorld();
    addIssue("BUTCHR-1", { issuetype: "Story", project: "BUTCHR" });
    addIssue("BUTCHR-2", { issuetype: "Task", project: "BUTCHR", bossKey: "BUTCHR-1", description: "old" });
    const atLimit = "x".repeat(JIRA_DESCRIPTION_CHAR_LIMIT);
    await expect(correctWorker(ops, "BUTCHR-1", "BUTCHR-2", { description: atLimit, why: "reason" })).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// correct_worker — BUTCHR-145: chained archive when the archive comment
// itself (not the incoming description/summary) exceeds Jira's COMMENT cap.
// Requirements 2-5 of BUTCHR-145.
// ---------------------------------------------------------------------------

/** Strips a chained archive part's `[caller] [correction] (part i of n) ` prefix off one posted comment, asserting the prefix is exactly what Requirement 2 promises (position + total, right after the identity tag and marker). */
function stripPartPrefix(comment: string, callerKey: string, i: number, n: number): string {
  const prefix = `[${callerKey}] ${CORRECTION_MARKER} (part ${i} of ${n}) `;
  expect(comment.startsWith(prefix)).toBe(true);
  return comment.slice(prefix.length);
}

describe("correctWorker: chained archive (BUTCHR-145)", () => {
  test("Requirement 2: an over-cap archive is chained across multiple comments, and the parts reassemble to exactly the original superseded text", async () => {
    const { ops, addIssue, issues } = makeWorld();
    addIssue("BUTCHR-1", { issuetype: "Story", project: "BUTCHR" });
    const oldDescription = Array.from({ length: 50000 }, (_, i) => String.fromCharCode(97 + (i % 26))).join("");
    addIssue("BUTCHR-2", {
      issuetype: "Task", project: "BUTCHR", bossKey: "BUTCHR-1",
      description: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: oldDescription }] }] },
    });
    const result = await correctWorker(ops, "BUTCHR-1", "BUTCHR-2", { description: "new description text", why: "shrinking an oversized ticket" });
    const comments = issues.get("BUTCHR-2")!.comments;
    expect(comments.length).toBeGreaterThan(1); // it actually had to chain, not fit in one comment
    for (const c of comments) expect(c).toContain(CORRECTION_MARKER); // every part stays greppable
    for (const c of comments) expect(c.length).toBeLessThanOrEqual(JIRA_COMMENT_CHAR_LIMIT); // every part itself respects the cap
    const n = comments.length;
    const reassembled = comments.map((c, idx) => stripPartPrefix(c, "BUTCHR-1", idx + 1, n)).join("");
    expect(reassembled).toContain(oldDescription); // lossless — assert the reassembly, not just the comment count
    expect(reassembled).toContain("shrinking an oversized ticket"); // `why` survives the split too
    expect(result.correctedDescription).toBe(true);
    expect(issues.get("BUTCHR-2")!.description).toBe("new description text"); // the edit still landed after a COMPLETE chain
  });

  test("Requirement 3: a mid-chain failure leaves a legibly incomplete record — CORRECTION_CHAIN_INCOMPLETE_MARKER present, description NOT replaced", async () => {
    const { ops, addIssue, issues } = makeWorld();
    addIssue("BUTCHR-1", { issuetype: "Story", project: "BUTCHR" });
    const oldDescription = "z".repeat(100000); // comfortably needs several parts
    addIssue("BUTCHR-2", {
      issuetype: "Task", project: "BUTCHR", bossKey: "BUTCHR-1",
      description: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: oldDescription }] }] },
    });
    let addCommentCalls = 0;
    let correctTextCalled = false;
    const failingOps: AtlassianOps = {
      ...ops,
      addComment: async (key: string, text: string) => {
        addCommentCalls++;
        if (addCommentCalls === 2) throw new Error("network blip on part 2"); // part 1 succeeds, part 2 fails
        return ops.addComment(key, text);
      },
      correctText: async (key, p) => { correctTextCalled = true; return ops.correctText(key, p); },
    };
    await expect(correctWorker(failingOps, "BUTCHR-1", "BUTCHR-2", { description: "new", why: "reason" })).rejects.toThrow(/UNCHANGED/);

    expect(correctTextCalled).toBe(false); // fail closed: the replace was never attempted
    const comments = issues.get("BUTCHR-2")!.comments;
    // Only part 1 (call #1) and the best-effort incomplete-marker (call #3) actually posted — part 2 (call #2) never wrote anything.
    expect(comments.length).toBe(2);
    expect(comments[0]).toContain(CORRECTION_MARKER);
    expect(comments[0]).toContain("(part 1 of");
    expect(comments[1]).toContain(CORRECTION_CHAIN_INCOMPLETE_MARKER); // Requirement 3's positive "the chain broke" signal
    expect(comments[1]).toMatch(/INCOMPLETE/);
    expect(comments[1]).toMatch(/UNCHANGED|NOT changed/i);
    expect(comments[1]).toMatch(/retry/i);
    expect(issues.get("BUTCHR-2")!.description).not.toBe("new"); // the description was never replaced
  });

  test("Requirement 2: an ordinary under-cap correction is completely unchanged — exactly one comment, no part header", async () => {
    const { ops, addIssue, issues } = makeWorld();
    addIssue("BUTCHR-1", { issuetype: "Story", project: "BUTCHR" });
    addIssue("BUTCHR-2", { issuetype: "Task", project: "BUTCHR", bossKey: "BUTCHR-1", description: "old" });
    await correctWorker(ops, "BUTCHR-1", "BUTCHR-2", { description: "new", why: "an ordinary small correction" });
    const comments = issues.get("BUTCHR-2")!.comments;
    expect(comments).toHaveLength(1);
    expect(comments[0]!).not.toMatch(/\(part \d+ of \d+\)/); // no part header — same shape as before this ticket
    expect(comments[0]!.startsWith(`[BUTCHR-1] ${CORRECTION_MARKER}`)).toBe(true);
  });

  test("Requirement 4: the near-boundary warning fires on a successful correction close to the description limit, and not well below it, worded for a world where the next correction still succeeds", async () => {
    const { ops, addIssue } = makeWorld();
    addIssue("BUTCHR-1", { issuetype: "Story", project: "BUTCHR" });
    addIssue("BUTCHR-2", { issuetype: "Task", project: "BUTCHR", bossKey: "BUTCHR-1", description: "old" });

    const wellBelow = await correctWorker(ops, "BUTCHR-1", "BUTCHR-2", { description: "a short new description", why: "reason" });
    expect(wellBelow.message).not.toMatch(/WARNING/);

    const nearLimit = "x".repeat(JIRA_DESCRIPTION_CHAR_LIMIT - 500);
    const near = await correctWorker(ops, "BUTCHR-1", "BUTCHR-2", { description: nearLimit, why: "reason 2" });
    expect(near.message).toMatch(/WARNING/);
    expect(near.message).toMatch(/split across multiple/);
    expect(near.message).not.toMatch(/will fail/i); // Requirement 4's trap: never word it as a failure — it will still SUCCEED
    expect(near.message).toMatch(/succeed/i);
  });

  test("Requirement 2/AC2: a ticket whose description matches BUTCHR-139's real-world size (~31,300 chars) is no longer permanently uncorrectable — and stays correctable on a SECOND call", async () => {
    const { ops, addIssue, issues } = makeWorld();
    addIssue("BUTCHR-1", { issuetype: "Story", project: "BUTCHR" });
    const oldDescription = "y".repeat(31300); // BUTCHR-139's measured plain-text size
    addIssue("BUTCHR-2", {
      issuetype: "Task", project: "BUTCHR", bossKey: "BUTCHR-1",
      description: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: oldDescription }] }] },
    });
    const why = "w".repeat(2400); // BUTCHR-139's measured `why` size on the call that originally deadlocked
    const result = await correctWorker(ops, "BUTCHR-1", "BUTCHR-2", { description: "shrunk", why });
    expect(result.correctedDescription).toBe(true);
    expect(issues.get("BUTCHR-2")!.description).toBe("shrunk");
    const comments = issues.get("BUTCHR-2")!.comments;
    expect(comments.length).toBeGreaterThan(1); // this is exactly the case that used to refuse outright
    const n = comments.length;
    const reassembled = comments.map((c, idx) => stripPartPrefix(c, "BUTCHR-1", idx + 1, n)).join("");
    expect(reassembled).toContain(oldDescription);

    // The deadlock is broken, not just dodged once — correct it again immediately.
    const second = await correctWorker(ops, "BUTCHR-1", "BUTCHR-2", { description: "shrunk again", why: "second correction, proving no deadlock" });
    expect(second.correctedDescription).toBe(true);
    expect(issues.get("BUTCHR-2")!.description).toBe("shrunk again");
  });

  test("Requirement 2: a body containing astral-plane characters splits without corrupting a UTF-16 surrogate pair", async () => {
    const { ops, addIssue, issues } = makeWorld();
    addIssue("BUTCHR-1", { issuetype: "Story", project: "BUTCHR" });
    const emoji = "\u{1F600}"; // 😀 — a UTF-16 surrogate pair, 2 code units
    const blocks: string[] = [];
    for (let i = 0; i < 20000; i++) {
      blocks.push(emoji);
      if (i % 997 === 0) blocks.push("x"); // periodically shifts phase, so a fixed split budget can't dodge every pair regardless of the budget's own parity
    }
    const oldDescription = blocks.join("");
    addIssue("BUTCHR-2", {
      issuetype: "Task", project: "BUTCHR", bossKey: "BUTCHR-1",
      description: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: oldDescription }] }] },
    });
    const result = await correctWorker(ops, "BUTCHR-1", "BUTCHR-2", { description: "shrunk", why: "surrogate-pair test" });
    const comments = issues.get("BUTCHR-2")!.comments;
    expect(comments.length).toBeGreaterThan(1); // large enough to require chaining
    const n = comments.length;
    const reassembled = comments.map((c, idx) => stripPartPrefix(c, "BUTCHR-1", idx + 1, n)).join("");
    expect(reassembled).toContain(oldDescription); // no surrogate pair was split or corrupted

    // Strongest per-part guarantee: no comment ever contains a LONE surrogate — every low surrogate is immediately preceded by its own high surrogate, within that same comment.
    for (const c of comments) {
      for (let i = 0; i < c.length; i++) {
        const code = c.charCodeAt(i);
        if (code >= 0xdc00 && code <= 0xdfff) {
          expect(c.charCodeAt(i - 1)).toBeGreaterThanOrEqual(0xd800);
          expect(c.charCodeAt(i - 1)).toBeLessThanOrEqual(0xdbff);
        }
      }
    }
    expect(result.correctedDescription).toBe(true);
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

// ===========================================================================
// BUTCHR-71: a PROJECT-keyed caller. "BUTCHR" (no hyphen) is a project id by
// src/resources/id.ts's isProjectId — every function below must recognize it
// as such and take the project-caller branch, never try to ops.getIssue("BUTCHR").
// ===========================================================================

describe("newWorker: PROJECT caller creates an EPIC (BUTCHR-71 Contract 2)", () => {
  test("creates an Epic in the caller's project, staffed by roles.epic, disposition applied — same shape as the issue-caller path", async () => {
    const { ops, issues, addIssue, setProjectProperty } = makeWorld();
    setProjectProperty("BUTCHR", BUTCHR_PROPERTY);
    const result = await newWorker(ops, ROLES, "BUTCHR", { summary: "s", disposition: { kind: "start" } });
    const child = issues.get(result.key)!;
    expect(child.issuetype).toBe("Epic");
    expect(child.project).toBe("BUTCHR");
    expect(child.assignee).toBe(ROLES.epic);
    expect(child.status).toBe("In Progress");
  });

  test("NO Implements link is ever made — bossKey stays undefined — and the result reports `member`, NEVER a lying `implements`", async () => {
    const { ops, issues, addIssue, setProjectProperty } = makeWorld();
    setProjectProperty("BUTCHR", BUTCHR_PROPERTY);
    const result = await newWorker(ops, ROLES, "BUTCHR", { summary: "s", disposition: { kind: "start" } });
    expect(issues.get(result.key)!.bossKey).toBeUndefined();
    expect(result.member).toBe("BUTCHR");
    expect(result).not.toHaveProperty("implements");
  });

  test("missing roles.epic refuses, naming BUTCHR_ASSIGNEE_EPIC — never silently falls back to roles.story/roles.task", async () => {
    const { ops, setProjectProperty } = makeWorld();
    setProjectProperty("BUTCHR", BUTCHR_PROPERTY);
    await expect(newWorker(ops, { story: "s", task: "t" }, "BUTCHR", { summary: "s", disposition: { kind: "start" } }))
      .rejects.toThrow(/BUTCHR_ASSIGNEE_EPIC/);
  });

  test("shelve: the label lands in the CREATE call, plus a reason comment; NO transition", async () => {
    const { ops, issues, addIssue, setProjectProperty } = makeWorld();
    setProjectProperty("BUTCHR", BUTCHR_PROPERTY);
    const result = await newWorker(ops, ROLES, "BUTCHR", { summary: "s", disposition: { kind: "shelve", reason: "waiting on the roadmap" } });
    const child = issues.get(result.key)!;
    expect(child.labels).toContain(EXEMPT_LABEL);
    expect(child.status).toBe("To Do");
    expect(child.comments.some((c) => c.includes("waiting on the roadmap"))).toBe(true);
    expect(child.comments.some((c) => c.startsWith("[BUTCHR]"))).toBe(true); // identity-tagged with the PROJECT key
  });

  test("the epic's doc nests under the PROJECT's own root doc — verified via ensureDoc's existing bossless-bottoms-out-at-root path, no second code path", async () => {
    const { ops, pages, setProjectProperty } = makeWorld();
    setProjectProperty("BUTCHR", BUTCHR_PROPERTY);
    const result = await newWorker(ops, ROLES, "BUTCHR", { summary: "s", disposition: { kind: "start" } });
    expect(pages.get(result.doc.id)!.parentId).toBe(ROOT_DOC_ID);
  });

  test("disposition failure rolls back (deletes) the created epic — same reasoning as the issue-caller path, minus the link step", async () => {
    const { ops, issues, addIssue, setProjectProperty } = makeWorld();
    setProjectProperty("BUTCHR", BUTCHR_PROPERTY);
    const broken: AtlassianOps = { ...ops, transition: async () => { throw new Error("no such transition"); } };
    const before = issues.size;
    await expect(newWorker(broken, ROLES, "BUTCHR", { summary: "s", disposition: { kind: "start" } }))
      .rejects.toThrow(/rolled back \(deleted\); nothing survives/);
    expect(issues.size).toBe(before); // the created epic is gone
  });
});

describe("adoptWorker: PROJECT caller adopts an existing EPIC (BUTCHR-71 Contract 3)", () => {
  test("adopts an orphan epic already in the caller's own project: assigns by roles.epic, no link is ever made", async () => {
    const { ops, issues, addIssue, setProjectProperty } = makeWorld();
    setProjectProperty("BUTCHR", BUTCHR_PROPERTY);
    addIssue("BUTCHR-9", { issuetype: "Epic", project: "BUTCHR" });
    const result = await adoptWorker(ops, ROLES, "BUTCHR", "BUTCHR-9", { kind: "start" });
    expect(result.alreadyAdopted).toBe(false);
    const w = issues.get("BUTCHR-9")!;
    expect(w.assignee).toBe(ROLES.epic);
    expect(w.status).toBe("In Progress");
    expect(w.bossKey).toBeUndefined(); // membership, never a link
  });

  test("REFUSES an epic that belongs to a DIFFERENT project — sharp, just like the issue-caller path's different-boss refusal", async () => {
    const { ops, issues, addIssue, setProjectProperty } = makeWorld();
    setProjectProperty("BUTCHR", BUTCHR_PROPERTY);
    addIssue("OTHER-9", { issuetype: "Epic", project: "OTHER" });
    await expect(adoptWorker(ops, ROLES, "BUTCHR", "OTHER-9", { kind: "start" }))
      .rejects.toThrow(/OTHER-9 belongs to project OTHER, not BUTCHR/);
  });

  test("REFUSES a Story or Task in the caller's OWN project — only an Epic is adoptable by a project caller", async () => {
    const { ops, issues, addIssue, setProjectProperty } = makeWorld();
    setProjectProperty("BUTCHR", BUTCHR_PROPERTY);
    addIssue("BUTCHR-5", { issuetype: "Story", project: "BUTCHR" });
    await expect(adoptWorker(ops, ROLES, "BUTCHR", "BUTCHR-5", { kind: "start" }))
      .rejects.toThrow(/cannot be adopted by a project caller/);
  });

  test("missing roles.epic refuses, naming BUTCHR_ASSIGNEE_EPIC", async () => {
    const { ops, issues, addIssue, setProjectProperty } = makeWorld();
    setProjectProperty("BUTCHR", BUTCHR_PROPERTY);
    addIssue("BUTCHR-9", { issuetype: "Epic", project: "BUTCHR" });
    await expect(adoptWorker(ops, { story: "s", task: "t" }, "BUTCHR", "BUTCHR-9", { kind: "start" }))
      .rejects.toThrow(/BUTCHR_ASSIGNEE_EPIC/);
  });

  test("IDEMPOTENT: an epic already a member, already assigned by role, and already in the disposition's state changes nothing", async () => {
    const { ops, issues, addIssue, setProjectProperty } = makeWorld();
    setProjectProperty("BUTCHR", BUTCHR_PROPERTY);
    addIssue("BUTCHR-9", { issuetype: "Epic", project: "BUTCHR", assignee: ROLES.epic, status: "In Progress" });
    let assignCalls = 0;
    const spied: AtlassianOps = { ...ops, assign: async (...a) => { assignCalls++; return ops.assign(...a); } };
    const result = await adoptWorker(spied, ROLES, "BUTCHR", "BUTCHR-9", { kind: "start" });
    expect(result.alreadyAdopted).toBe(true);
    expect(assignCalls).toBe(0);
  });

  test("BUTCHR-108/BUTCHR-137: clears a stale butchr:orphan on an adopted epic too — symmetry / defence-in-depth, since file_where_it_belongs can never create an orphan Epic through this codebase's own write path", async () => {
    const { ops, issues, addIssue, setProjectProperty } = makeWorld();
    setProjectProperty("BUTCHR", BUTCHR_PROPERTY);
    addIssue("BUTCHR-9", { issuetype: "Epic", project: "BUTCHR", labels: [ORPHAN_LABEL] });
    const result = await adoptWorker(ops, ROLES, "BUTCHR", "BUTCHR-9", { kind: "start" });
    expect(result.alreadyAdopted).toBe(false);
    expect(issues.get("BUTCHR-9")!.labels).not.toContain(ORPHAN_LABEL);
  });

  test("BUTCHR-108/BUTCHR-137: no removeLabels call at all when the adopted epic never carried butchr:orphan — zero extra cost", async () => {
    const { ops, issues, addIssue, setProjectProperty } = makeWorld();
    setProjectProperty("BUTCHR", BUTCHR_PROPERTY);
    addIssue("BUTCHR-9", { issuetype: "Epic", project: "BUTCHR" });
    let removeCalls = 0;
    const spied: AtlassianOps = { ...ops, removeLabels: async (...a) => { removeCalls++; return ops.removeLabels(...a); } };
    await adoptWorker(spied, ROLES, "BUTCHR", "BUTCHR-9", { kind: "start" });
    expect(removeCalls).toBe(0);
  });
});

describe("start_worker / finish_worker / shelve_worker / prioritize_worker / tell_worker: PROJECT-caller ownership by MEMBERSHIP (BUTCHR-71 Contract 3)", () => {
  test("finish_worker closes an epic that is a member of the caller's project", async () => {
    const { ops, issues, addIssue, setProjectProperty } = makeWorld();
    setProjectProperty("BUTCHR", BUTCHR_PROPERTY);
    addIssue("BUTCHR-9", { issuetype: "Epic", project: "BUTCHR" });
    await finishWorker(ops, "BUTCHR", "BUTCHR-9");
    expect(issues.get("BUTCHR-9")!.status).toBe("Done");
  });

  test("tell_worker comments on an epic that is a member of the caller's project", async () => {
    const { ops, issues, addIssue, setProjectProperty } = makeWorld();
    setProjectProperty("BUTCHR", BUTCHR_PROPERTY);
    addIssue("BUTCHR-9", { issuetype: "Epic", project: "BUTCHR" });
    await tellWorker(ops, "BUTCHR", "BUTCHR-9", "[review] APPROVED https://example/pr/1 @ deadbeef");
    expect(issues.get("BUTCHR-9")!.comments).toEqual(["[BUTCHR] [review] APPROVED https://example/pr/1 @ deadbeef"]);
  });

  test("start_worker / shelve_worker / prioritize_worker all work on the caller's own epic too", async () => {
    const { ops, issues, addIssue, setProjectProperty } = makeWorld();
    setProjectProperty("BUTCHR", BUTCHR_PROPERTY);
    addIssue("BUTCHR-9", { issuetype: "Epic", project: "BUTCHR", status: "To Do" });
    await startWorker(ops, "BUTCHR", "BUTCHR-9");
    expect(issues.get("BUTCHR-9")!.status).toBe("In Progress");
    await shelveWorker(ops, "BUTCHR", "BUTCHR-9", "waiting on a dependency");
    expect(issues.get("BUTCHR-9")!.status).toBe("To Do");
    expect(issues.get("BUTCHR-9")!.labels).toContain(EXEMPT_LABEL);
    await prioritizeWorker(ops, "BUTCHR", "BUTCHR-9", "High");
    expect(issues.get("BUTCHR-9")!.priority).toBe("High");
  });

  test("prioritize_worker REFUSES the caller's OWN key for a project caller too — your priority is your boss's judgment, never your own", async () => {
    const { ops, setProjectProperty } = makeWorld();
    setProjectProperty("BUTCHR", BUTCHR_PROPERTY);
    await expect(prioritizeWorker(ops, "BUTCHR", "BUTCHR", "High")).rejects.toThrow(/your own/);
  });

  test("REFUSES (a) an epic in a DIFFERENT project — names which project it actually belongs to", async () => {
    const { ops, issues, addIssue, setProjectProperty } = makeWorld();
    setProjectProperty("BUTCHR", BUTCHR_PROPERTY);
    addIssue("OTHER-9", { issuetype: "Epic", project: "OTHER" });
    await expect(finishWorker(ops, "BUTCHR", "OTHER-9")).rejects.toThrow(/it belongs to project OTHER, not BUTCHR/);
    await expect(tellWorker(ops, "BUTCHR", "OTHER-9", "hi")).rejects.toThrow(/it belongs to project OTHER, not BUTCHR/);
  });

  test("REFUSES (b) a Story or a Task in the caller's OWN project — membership alone is not enough; only an Epic is the project's own worker", async () => {
    const { ops, issues, addIssue, setProjectProperty } = makeWorld();
    setProjectProperty("BUTCHR", BUTCHR_PROPERTY);
    addIssue("BUTCHR-5", { issuetype: "Story", project: "BUTCHR" });
    addIssue("BUTCHR-6", { issuetype: "Task", project: "BUTCHR" });
    await expect(finishWorker(ops, "BUTCHR", "BUTCHR-5")).rejects.toThrow(/not an Epic/);
    await expect(finishWorker(ops, "BUTCHR", "BUTCHR-6")).rejects.toThrow(/not an Epic/);
    await expect(tellWorker(ops, "BUTCHR", "BUTCHR-5", "hi")).rejects.toThrow();
  });
});

describe("reportToBoss / askBoss: PROJECT caller speaks on its own ROOT DOC, not a Jira comment (BUTCHR-71 spec correction)", () => {
  test("reportToBoss posts a Confluence footer comment on the project's root doc, identity-tagged, never ops.addComment", async () => {
    const { ops, issues, pages, addIssue, setProjectProperty } = makeWorld();
    setProjectProperty("BUTCHR", BUTCHR_PROPERTY);
    pages.set(ROOT_DOC_ID, { parentId: "", title: "root doc", body: "<p>hi</p>", labels: [] });
    let commentedPageId: string | undefined;
    let commentedBody: string | undefined;
    const spied: AtlassianOps = {
      ...ops,
      commentOnPage: async (pageId: string, body: string) => { commentedPageId = pageId; commentedBody = body; return { ok: true }; },
      addComment: async () => { throw new Error("must never be called for a project caller"); },
    };
    await reportToBoss(spied, "BUTCHR", "status update");
    expect(commentedPageId).toBe(ROOT_DOC_ID);
    expect(commentedBody).toContain("[BUTCHR] status update");
    void issues;
  });

  test("askBoss carries the SAME [ask] marker convention onto the project's root doc", async () => {
    const { ops, pages, setProjectProperty } = makeWorld();
    setProjectProperty("BUTCHR", BUTCHR_PROPERTY);
    pages.set(ROOT_DOC_ID, { parentId: "", title: "root doc", body: "<p>hi</p>", labels: [] });
    let commentedBody: string | undefined;
    const spied: AtlassianOps = { ...ops, commentOnPage: async (_id: string, body: string) => { commentedBody = body; return { ok: true }; } };
    await askBoss(spied, "BUTCHR", "which approach?");
    expect(commentedBody).toContain(`[BUTCHR] ${ASK_MARKER} which approach?`);
  });
});

// ===========================================================================
// BUTCHR-110/S1: tier-identity collision — RECORD, never refuse. The caller's
// own accountId (read from the CALLER's actual ticket, or — for a PROJECT
// caller — `ops.getMyself()`) is compared against the accountId about to be
// assigned to the child. A collision must be LOUD in three places: the
// returned result (`identityCollision`), the worker's own ticket (a comment),
// and (verified separately, in src/tools/defs.ts's own wiring — not
// exercised by these relationship-level tests) the daemon's audit log.
// ===========================================================================

describe("newWorker: tier-identity collision (BUTCHR-110/S1, issue caller)", () => {
  test("Epic caller whose OWN assignee equals roles.story: identityCollision in the result, naming both env vars/both tiers/the hop/the accountId, plus a comment on the new child tagged with the caller's key", async () => {
    const { ops, addIssue, issues, setProjectProperty } = makeWorld();
    setProjectProperty("BUTCHR", BUTCHR_PROPERTY);
    addIssue("BUTCHR-1", { issuetype: "Epic", project: "BUTCHR", assignee: ROLES.story });
    const result = await newWorker(ops, ROLES, "BUTCHR-1", { summary: "s", disposition: { kind: "start" } });
    expect(result.identityCollision).toBeDefined();
    expect(result.identityCollision).toContain("BUTCHR_ASSIGNEE_EPIC");
    expect(result.identityCollision).toContain("BUTCHR_ASSIGNEE_STORY");
    expect(result.identityCollision).toContain("epic");
    expect(result.identityCollision).toContain("story");
    expect(result.identityCollision).toContain(ROLES.story); // short enough not to be truncated — the shared accountId, named
    expect(result.identityCollision).toContain("GitHub refuses");
    const child = issues.get(result.key)!;
    expect(child.comments).toHaveLength(1);
    expect(child.comments[0]).toStartWith("[BUTCHR-1]");
    expect(child.comments[0]).toContain("GitHub refuses");
  });

  test("non-collision: caller's own assignee differs from the child's role — no identityCollision, no comment, nothing added to the result", async () => {
    const { ops, addIssue, issues, setProjectProperty } = makeWorld();
    setProjectProperty("BUTCHR", BUTCHR_PROPERTY);
    addIssue("BUTCHR-1", { issuetype: "Epic", project: "BUTCHR", assignee: "some-other-human" });
    const result = await newWorker(ops, ROLES, "BUTCHR-1", { summary: "s", disposition: { kind: "start" } });
    expect(result).not.toHaveProperty("identityCollision");
    expect(issues.get(result.key)!.comments).toHaveLength(0);
  });

  test("a caller ticket with NO assignee at all is not reported as a collision (undefined never equals a role's accountId)", async () => {
    const { ops, addIssue, issues, setProjectProperty } = makeWorld();
    setProjectProperty("BUTCHR", BUTCHR_PROPERTY);
    addIssue("BUTCHR-1", { issuetype: "Epic", project: "BUTCHR" }); // no assignee
    const result = await newWorker(ops, ROLES, "BUTCHR-1", { summary: "s", disposition: { kind: "start" } });
    expect(result).not.toHaveProperty("identityCollision");
    expect(issues.get(result.key)!.comments).toHaveLength(0);
  });

  test("FAIL-SAFE, NEVER FAIL-SILENT: a collision whose trace comment fails to post still succeeds — the returned warning says the trace was NOT written, and why", async () => {
    const { ops, addIssue, setProjectProperty } = makeWorld();
    setProjectProperty("BUTCHR", BUTCHR_PROPERTY);
    addIssue("BUTCHR-1", { issuetype: "Epic", project: "BUTCHR", assignee: ROLES.story });
    const broken: AtlassianOps = { ...ops, addComment: async () => { throw new Error("comment refused"); } };
    const result = await newWorker(broken, ROLES, "BUTCHR-1", { summary: "s", disposition: { kind: "start" } });
    expect(result.identityCollision).toContain("COULD NOT BE WRITTEN");
    expect(result.identityCollision).toContain("comment refused");
    expect(result.identityCollision).toContain("GitHub refuses"); // the warning text itself still survives, not just the failure note
  });
});

describe("newWorker: tier-identity collision (BUTCHR-110/S1, PROJECT caller)", () => {
  test("this daemon's own credential (getMyself) equals roles.epic: identityCollision names ATLASSIAN_EMAIL/the credential, 'project', 'epic', and BUTCHR_ASSIGNEE_EPIC; comment lands on the new epic tagged with the project key", async () => {
    const { ops, issues, setProjectProperty } = makeWorld();
    setProjectProperty("BUTCHR", BUTCHR_PROPERTY);
    const spied: AtlassianOps = { ...ops, getMyself: async () => ({ accountId: ROLES.epic }) };
    const result = await newWorker(spied, ROLES, "BUTCHR", { summary: "s", disposition: { kind: "start" } });
    expect(result.identityCollision).toBeDefined();
    expect(result.identityCollision).toContain("ATLASSIAN_EMAIL");
    expect(result.identityCollision).toContain("project");
    expect(result.identityCollision).toContain("epic");
    expect(result.identityCollision).toContain("BUTCHR_ASSIGNEE_EPIC");
    const child = issues.get(result.key)!;
    expect(child.comments).toHaveLength(1);
    expect(child.comments[0]).toStartWith("[BUTCHR]");
  });

  test("non-collision: this daemon's credential differs from roles.epic — no identityCollision, no comment", async () => {
    const { ops, issues, setProjectProperty } = makeWorld();
    setProjectProperty("BUTCHR", BUTCHR_PROPERTY);
    const result = await newWorker(ops, ROLES, "BUTCHR", { summary: "s", disposition: { kind: "start" } }); // fake world's default getMyself() = "test-account" != ROLES.epic
    expect(result).not.toHaveProperty("identityCollision");
    expect(issues.get(result.key)!.comments).toHaveLength(0);
  });

  // BUTCHR-103's review, 2026-09-02 (blocker #1): the collision check's OWN
  // read must never turn a successful staffing call into a failure. This
  // read runs after the disposition here, so the epic is already fully
  // declared either way — but it must still degrade gracefully, not throw.
  test("FAIL-SAFE: getMyself() failing does NOT fail the staffing call — the epic is still created and declared, and the result says the check could not run", async () => {
    const { ops, issues, setProjectProperty } = makeWorld();
    setProjectProperty("BUTCHR", BUTCHR_PROPERTY);
    const broken: AtlassianOps = { ...ops, getMyself: async () => { throw new Error("myself endpoint down"); } };
    const result = await newWorker(broken, ROLES, "BUTCHR", { summary: "s", disposition: { kind: "start" } });
    expect(result).not.toHaveProperty("identityCollision");
    expect(result.identityUnknown).toContain("myself endpoint down");
    expect(result.identityUnknown).toContain("NOT checked");
    expect(issues.get(result.key)!.status).toBe("In Progress"); // the staffing call itself still fully succeeded
  });
});

describe("adoptWorker: tier-identity collision (BUTCHR-110/S1, issue caller)", () => {
  test("a fresh adoption where the caller's OWN assignee equals roles.task: identityCollision in the result, comment posted on the adopted ticket", async () => {
    const { ops, addIssue, issues, setProjectProperty } = makeWorld();
    setProjectProperty("BUTCHR", BUTCHR_PROPERTY);
    addIssue("BUTCHR-1", { issuetype: "Epic", project: "BUTCHR", assignee: ROLES.task });
    addIssue("BUTCHR-9", { issuetype: "Task", project: "BUTCHR" }); // orphan
    const result = await adoptWorker(ops, ROLES, "BUTCHR-1", "BUTCHR-9", { kind: "start" });
    expect(result.alreadyAdopted).toBe(false);
    expect(result.identityCollision).toBeDefined();
    expect(result.identityCollision).toContain("BUTCHR_ASSIGNEE_EPIC");
    expect(result.identityCollision).toContain("BUTCHR_ASSIGNEE_TASK");
    expect(result.identityCollision).toContain("the epic that owns this task");
    const w = issues.get("BUTCHR-9")!;
    expect(w.comments.some((c) => c.startsWith("[BUTCHR-1]") && c.includes("GitHub refuses"))).toBe(true);
  });

  test("THE IDEMPOTENT RE-ADOPTION DECISION: identityCollision is still reported in the result (a fact about current state, cheap to state on every call) but the ticket comment is NOT reposted — this call does no other write either", async () => {
    const { ops, addIssue, issues, setProjectProperty } = makeWorld();
    setProjectProperty("BUTCHR", BUTCHR_PROPERTY);
    addIssue("BUTCHR-1", { issuetype: "Epic", project: "BUTCHR", assignee: ROLES.task });
    addIssue("BUTCHR-9", { issuetype: "Task", project: "BUTCHR", bossKey: "BUTCHR-1", assignee: ROLES.task, status: "In Progress" });
    let commentCalls = 0;
    const spied: AtlassianOps = { ...ops, addComment: async (...a) => { commentCalls++; return ops.addComment(...a); } };
    const result = await adoptWorker(spied, ROLES, "BUTCHR-1", "BUTCHR-9", { kind: "start" });
    expect(result.alreadyAdopted).toBe(true);
    expect(result.identityCollision).toBeDefined();
    expect(result.identityCollision).toContain("not reposted");
    expect(commentCalls).toBe(0);
    expect(issues.get("BUTCHR-9")!.comments).toHaveLength(0);
  });

  test("non-collision: caller's own assignee differs from the adopted ticket's role — no identityCollision, no comment", async () => {
    const { ops, addIssue, issues, setProjectProperty } = makeWorld();
    setProjectProperty("BUTCHR", BUTCHR_PROPERTY);
    addIssue("BUTCHR-1", { issuetype: "Epic", project: "BUTCHR", assignee: "some-other-human" });
    addIssue("BUTCHR-9", { issuetype: "Task", project: "BUTCHR" });
    const result = await adoptWorker(ops, ROLES, "BUTCHR-1", "BUTCHR-9", { kind: "start" });
    expect(result).not.toHaveProperty("identityCollision");
    expect(issues.get("BUTCHR-9")!.comments).toHaveLength(0);
  });

  // THE BLOCKER FROM BUTCHR-103's REVIEW, 2026-09-02: adopt_worker's extra
  // collision-check read (the caller's own ticket) runs AFTER assign/link
  // and BEFORE the disposition — an unguarded throw here used to leave the
  // ticket assigned and linked but UNDECLARED, exactly the damaging partial
  // state adoptWorker's own doc comment names as the one `adopt_worker`
  // itself exists to REPAIR, not to create. This is the regression test.
  test("FAIL-SAFE: the caller-ticket read failing does NOT fail the call, and does NOT leave the adopted ticket undeclared — assign/link already happened, and the disposition still gets applied", async () => {
    const { ops, addIssue, issues, setProjectProperty } = makeWorld();
    setProjectProperty("BUTCHR", BUTCHR_PROPERTY);
    addIssue("BUTCHR-1", { issuetype: "Epic", project: "BUTCHR" });
    addIssue("BUTCHR-9", { issuetype: "Task", project: "BUTCHR" }); // orphan
    let callerReads = 0;
    const broken: AtlassianOps = {
      ...ops,
      // Only the FIRST getIssue(BUTCHR-1) — the collision check's own read —
      // fails; ensureDoc's later boss-chain walk also reads BUTCHR-1 and
      // must succeed, or this test would be exercising a doc failure, not
      // the collision-check-read failure it's meant to isolate.
      getIssue: async (key: string) => {
        if (key === "BUTCHR-1" && callerReads === 0) { callerReads++; throw new Error("transient 503"); }
        return ops.getIssue(key);
      },
    };
    const result = await adoptWorker(broken, ROLES, "BUTCHR-1", "BUTCHR-9", { kind: "start" });
    expect(callerReads).toBe(1);
    expect(result).not.toHaveProperty("identityCollision");
    expect(result.identityUnknown).toContain("transient 503");
    expect(result.identityUnknown).toContain("NOT checked");
    const w = issues.get("BUTCHR-9")!;
    expect(w.assignee).toBe(ROLES.task); // assign — already happened, unaffected
    expect(w.bossKey).toBe("BUTCHR-1"); // link — already happened, unaffected
    expect(w.status).toBe("In Progress"); // THE FIX: disposition still applied — never left undeclared
  });
});

describe("adoptWorker: tier-identity collision (BUTCHR-110/S1, PROJECT caller)", () => {
  test("this daemon's own credential equals roles.epic: identityCollision in the result, comment posted on the adopted epic", async () => {
    const { ops, addIssue, issues, setProjectProperty } = makeWorld();
    setProjectProperty("BUTCHR", BUTCHR_PROPERTY);
    addIssue("BUTCHR-9", { issuetype: "Epic", project: "BUTCHR" }); // orphan epic
    const spied: AtlassianOps = { ...ops, getMyself: async () => ({ accountId: ROLES.epic }) };
    const result = await adoptWorker(spied, ROLES, "BUTCHR", "BUTCHR-9", { kind: "start" });
    expect(result.alreadyAdopted).toBe(false);
    expect(result.identityCollision).toBeDefined();
    expect(result.identityCollision).toContain("ATLASSIAN_EMAIL");
    expect(result.identityCollision).toContain("BUTCHR_ASSIGNEE_EPIC");
    expect(issues.get("BUTCHR-9")!.comments.some((c) => c.startsWith("[BUTCHR]"))).toBe(true);
  });

  test("idempotent re-adoption (PROJECT caller): identityCollision still reported, comment NOT reposted", async () => {
    const { ops, addIssue, issues, setProjectProperty } = makeWorld();
    setProjectProperty("BUTCHR", BUTCHR_PROPERTY);
    addIssue("BUTCHR-9", { issuetype: "Epic", project: "BUTCHR", assignee: ROLES.epic, status: "In Progress" });
    const spied: AtlassianOps = { ...ops, getMyself: async () => ({ accountId: ROLES.epic }) };
    let commentCalls = 0;
    const spied2: AtlassianOps = { ...spied, addComment: async (...a) => { commentCalls++; return spied.addComment(...a); } };
    const result = await adoptWorker(spied2, ROLES, "BUTCHR", "BUTCHR-9", { kind: "start" });
    expect(result.alreadyAdopted).toBe(true);
    expect(result.identityCollision).toContain("not reposted");
    expect(commentCalls).toBe(0);
    expect(issues.get("BUTCHR-9")!.comments).toHaveLength(0);
  });

  test("non-collision: this daemon's credential differs from roles.epic — no identityCollision, no comment", async () => {
    const { ops, addIssue, issues, setProjectProperty } = makeWorld();
    setProjectProperty("BUTCHR", BUTCHR_PROPERTY);
    addIssue("BUTCHR-9", { issuetype: "Epic", project: "BUTCHR" });
    const result = await adoptWorker(ops, ROLES, "BUTCHR", "BUTCHR-9", { kind: "start" }); // default getMyself() = "test-account"
    expect(result).not.toHaveProperty("identityCollision");
    expect(issues.get("BUTCHR-9")!.comments).toHaveLength(0);
  });

  // Same regression as the issue-caller path above, via getMyself() instead
  // of getIssue(callerKey) — see that test's comment for the full scenario.
  test("FAIL-SAFE: getMyself() failing does NOT fail the call, and does NOT leave the adopted epic undeclared — assign already happened, and the disposition still gets applied", async () => {
    const { ops, addIssue, issues, setProjectProperty } = makeWorld();
    setProjectProperty("BUTCHR", BUTCHR_PROPERTY);
    addIssue("BUTCHR-9", { issuetype: "Epic", project: "BUTCHR" }); // orphan epic
    const broken: AtlassianOps = { ...ops, getMyself: async () => { throw new Error("myself endpoint down"); } };
    const result = await adoptWorker(broken, ROLES, "BUTCHR", "BUTCHR-9", { kind: "start" });
    expect(result).not.toHaveProperty("identityCollision");
    expect(result.identityUnknown).toContain("myself endpoint down");
    expect(result.identityUnknown).toContain("NOT checked");
    const w = issues.get("BUTCHR-9")!;
    expect(w.assignee).toBe(ROLES.epic); // assign — already happened, unaffected
    expect(w.status).toBe("In Progress"); // THE FIX: disposition still applied — never left undeclared
  });
});
