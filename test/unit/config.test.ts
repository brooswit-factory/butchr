import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadConfig, describeConfig } from "../../src/config/config.js";
import { workspaceRoot } from "../../src/agents/workspace.js";

const noRead = () => { throw new Error("should not read"); };
const base = { ATLASSIAN_SITE: "https://x.atlassian.net/", ATLASSIAN_EMAIL: "a@b.c", ATLASSIAN_TOKEN: "tok" };

describe("loadConfig", () => {
  test("parses a full env; trims trailing slash; default port 7717", () => {
    const c = loadConfig(base, noRead);
    expect(c.atlassian).toEqual({ site: "https://x.atlassian.net", email: "a@b.c", token: "tok" });
    expect(c.port).toBe(7717);
    expect(c.herdrSocket).toBeUndefined();
  });
  test("reads the token from a file when ATLASSIAN_TOKEN_FILE is set", () => {
    const c = loadConfig({ ...base, ATLASSIAN_TOKEN: undefined, ATLASSIAN_TOKEN_FILE: "/t" }, (p) => { expect(p).toBe("/t"); return "filetok\n"; });
    expect(c.atlassian.token).toBe("filetok");
  });
  test("honours BUTCHR_PORT and HERDR_SOCKET", () => {
    const c = loadConfig({ ...base, BUTCHR_PORT: "9000", HERDR_SOCKET: "/s.sock" }, noRead);
    expect(c.port).toBe(9000); expect(c.herdrSocket).toBe("/s.sock");
  });
  test("throws on missing site/email/token and on a bad port", () => {
    expect(() => loadConfig({ ...base, ATLASSIAN_SITE: undefined }, noRead)).toThrow(/ATLASSIAN_SITE/);
    expect(() => loadConfig({ ...base, ATLASSIAN_EMAIL: "" }, noRead)).toThrow(/ATLASSIAN_EMAIL/);
    expect(() => loadConfig({ ...base, ATLASSIAN_TOKEN: undefined }, noRead)).toThrow(/ATLASSIAN_TOKEN/);
    expect(() => loadConfig({ ...base, ATLASSIAN_TOKEN_FILE: "/t" }, () => "  \n")).toThrow(/empty/);
    expect(() => loadConfig({ ...base, BUTCHR_PORT: "notaport" }, noRead)).toThrow(/BUTCHR_PORT/);
  });
  test("describeConfig never leaks the token value", () => {
    const d = describeConfig(loadConfig({ ...base, ATLASSIAN_TOKEN: "s3cr3t-VALUE" }, noRead));
    expect(d).not.toContain("s3cr3t-VALUE"); expect(d).toContain("***"); expect(d).toContain("12 chars");
  });

  test("github is absent when GITHUB_TOKEN_FILE or BUTCHR_GITHUB_ORGS is missing", () => {
    expect(loadConfig(base, noRead).github).toBeUndefined();
    expect(loadConfig({ ...base, BUTCHR_GITHUB_ORGS: "acme" }, noRead).github).toBeUndefined();
    expect(loadConfig({ ...base, GITHUB_TOKEN_FILE: "/gh" }, (p) => { expect(p).toBe("/gh"); return "ghtok\n"; }).github).toBeUndefined();
  });
  test("github is populated when both are set; orgs are comma-split and trimmed", () => {
    const c = loadConfig({ ...base, GITHUB_TOKEN_FILE: "/gh", BUTCHR_GITHUB_ORGS: "acme, other-org" }, () => "ghtok\n");
    expect(c.github).toEqual({ token: "ghtok", orgs: ["acme", "other-org"] });
  });
  test("describeConfig reports github as disabled or its orgs, never the token value", () => {
    expect(describeConfig(loadConfig(base, noRead))).toContain("github=disabled");
    const d = describeConfig(loadConfig({ ...base, GITHUB_TOKEN_FILE: "/gh", BUTCHR_GITHUB_ORGS: "acme" }, () => "s3cr3t-gh-tok"));
    expect(d).not.toContain("s3cr3t-gh-tok");
    expect(d).toContain("orgs=acme");
  });

  test("stalledMinutes defaults to 10, honours BUTCHR_STALLED_MINUTES, and rejects a non-positive value", () => {
    expect(loadConfig(base, noRead).stalledMinutes).toBe(10);
    expect(loadConfig({ ...base, BUTCHR_STALLED_MINUTES: "20" }, noRead).stalledMinutes).toBe(20);
    expect(() => loadConfig({ ...base, BUTCHR_STALLED_MINUTES: "0" }, noRead)).toThrow(/BUTCHR_STALLED_MINUTES/);
    expect(() => loadConfig({ ...base, BUTCHR_STALLED_MINUTES: "nope" }, noRead)).toThrow(/BUTCHR_STALLED_MINUTES/);
  });

  test("crashLoopCount defaults to 5, honours BUTCHR_CRASHLOOP_COUNT, and rejects a non-positive value", () => {
    expect(loadConfig(base, noRead).crashLoopCount).toBe(5);
    expect(loadConfig({ ...base, BUTCHR_CRASHLOOP_COUNT: "3" }, noRead).crashLoopCount).toBe(3);
    expect(() => loadConfig({ ...base, BUTCHR_CRASHLOOP_COUNT: "0" }, noRead)).toThrow(/BUTCHR_CRASHLOOP_COUNT/);
    expect(() => loadConfig({ ...base, BUTCHR_CRASHLOOP_COUNT: "nope" }, noRead)).toThrow(/BUTCHR_CRASHLOOP_COUNT/);
  });

  test("crashLoopWindowMinutes defaults to 60, honours BUTCHR_CRASHLOOP_WINDOW_MINUTES, and rejects a non-positive value", () => {
    expect(loadConfig(base, noRead).crashLoopWindowMinutes).toBe(60);
    expect(loadConfig({ ...base, BUTCHR_CRASHLOOP_WINDOW_MINUTES: "30" }, noRead).crashLoopWindowMinutes).toBe(30);
    expect(() => loadConfig({ ...base, BUTCHR_CRASHLOOP_WINDOW_MINUTES: "0" }, noRead)).toThrow(/BUTCHR_CRASHLOOP_WINDOW_MINUTES/);
    expect(() => loadConfig({ ...base, BUTCHR_CRASHLOOP_WINDOW_MINUTES: "nope" }, noRead)).toThrow(/BUTCHR_CRASHLOOP_WINDOW_MINUTES/);
  });

  test("describeConfig includes crashLoopCount/crashLoopWindowMinutes", () => {
    expect(describeConfig(loadConfig(base, noRead))).toContain("crashLoopCount=5 crashLoopWindowMinutes=60");
  });

  test("unresponsiveMinutes defaults to 5, honours BUTCHR_UNRESPONSIVE_MINUTES, and rejects a non-positive value", () => {
    expect(loadConfig(base, noRead).unresponsiveMinutes).toBe(5);
    expect(loadConfig({ ...base, BUTCHR_UNRESPONSIVE_MINUTES: "15" }, noRead).unresponsiveMinutes).toBe(15);
    expect(() => loadConfig({ ...base, BUTCHR_UNRESPONSIVE_MINUTES: "0" }, noRead)).toThrow(/BUTCHR_UNRESPONSIVE_MINUTES/);
    expect(() => loadConfig({ ...base, BUTCHR_UNRESPONSIVE_MINUTES: "nope" }, noRead)).toThrow(/BUTCHR_UNRESPONSIVE_MINUTES/);
  });

  test("pollStaleMs defaults to 60000, honours BUTCHR_POLL_STALE_MS, and rejects a non-positive value", () => {
    expect(loadConfig(base, noRead).pollStaleMs).toBe(60_000);
    expect(loadConfig({ ...base, BUTCHR_POLL_STALE_MS: "30000" }, noRead).pollStaleMs).toBe(30_000);
    expect(() => loadConfig({ ...base, BUTCHR_POLL_STALE_MS: "0" }, noRead)).toThrow(/BUTCHR_POLL_STALE_MS/);
    expect(() => loadConfig({ ...base, BUTCHR_POLL_STALE_MS: "nope" }, noRead)).toThrow(/BUTCHR_POLL_STALE_MS/);
  });
  test("describeConfig includes pollStaleMs", () => {
    expect(describeConfig(loadConfig(base, noRead))).toContain("pollStaleMs=60000");
  });

  test("assignees are parsed when both BUTCHR_ASSIGNEE_STORY/TASK are set", () => {
    const c = loadConfig({ ...base, BUTCHR_ASSIGNEE_STORY: "712020:story", BUTCHR_ASSIGNEE_TASK: "712020:task" }, noRead);
    expect(c.assignees).toEqual({ story: "712020:story", task: "712020:task" });
  });
  test("loadConfig does not throw when BUTCHR_ASSIGNEE_STORY/TASK are absent; roles are undefined", () => {
    const c = loadConfig(base, noRead);
    expect(c.assignees.story).toBeUndefined();
    expect(c.assignees.task).toBeUndefined();
  });
  test("describeConfig includes the resolved accountIds and names the consequence when a role is unset, never a token", () => {
    const both = describeConfig(loadConfig({ ...base, BUTCHR_ASSIGNEE_STORY: "712020:e160cf60-6480-44de-8554-af5b81c584e2", BUTCHR_ASSIGNEE_TASK: "712020:619ec5ec-2e92-492f-8979-91ccda318230" }, noRead));
    expect(both).toContain("assignees=story:712020:e160");
    expect(both).toContain("task:712020:619e");
    const none = describeConfig(loadConfig(base, noRead));
    expect(none).toContain("story:unset — Story creation will be refused");
    expect(none).toContain("task:unset — Task creation will be refused");
  });

  // BUTCHR-71 Contract 5: the epic role, same shape as story/task, never a
  // silent fallback to either.
  test("BUTCHR_ASSIGNEE_EPIC is parsed independently of story/task", () => {
    const c = loadConfig({ ...base, BUTCHR_ASSIGNEE_EPIC: "712020:epic" }, noRead);
    expect(c.assignees).toEqual({ epic: "712020:epic" });
  });
  test("loadConfig does not throw when BUTCHR_ASSIGNEE_EPIC is absent; the role is undefined, NOT defaulted from story/task", () => {
    const c = loadConfig({ ...base, BUTCHR_ASSIGNEE_STORY: "712020:story", BUTCHR_ASSIGNEE_TASK: "712020:task" }, noRead);
    expect(c.assignees.epic).toBeUndefined();
  });
  test("describeConfig includes the resolved epic accountId, and names the consequence when unset, never a token", () => {
    const set = describeConfig(loadConfig({ ...base, BUTCHR_ASSIGNEE_EPIC: "712020:e160cf60-6480-44de-8554-af5b81c584e2" }, noRead));
    expect(set).toContain("epic:712020:e160");
    const unset = describeConfig(loadConfig(base, noRead));
    expect(unset).toContain("epic:unset — Epic creation will be refused");
  });

  // BUTCHR-110/S2: role-map collision reporting at boot. Pairwise across the
  // SET roles only; unset stays a DIFFERENT condition (never conflated —
  // see the "unset" tests above, unaffected by any of this); and a HONESTY
  // CLAUSE is always present, collision or none, because a clean report is
  // the one case most likely to be misread as "every hop checked".
  describe("describeConfig: role-map collisions (BUTCHR-110/S2)", () => {
    test("story/task collision: names both env vars, both tiers, the hop, GitHub, and the shared accountId", () => {
      const d = describeConfig(loadConfig({ ...base, BUTCHR_ASSIGNEE_STORY: "712020:same-account", BUTCHR_ASSIGNEE_TASK: "712020:same-account" }, noRead));
      expect(d).toContain("BUTCHR_ASSIGNEE_STORY");
      expect(d).toContain("BUTCHR_ASSIGNEE_TASK");
      expect(d).toContain("story");
      expect(d).toContain("task");
      expect(d).toContain("SAME accountId");
      expect(d).toContain("712020:same…");
      expect(d).toContain("the story that owns a task");
      expect(d).toContain("GitHub refuses");
    });

    test("epic/task collision — the exact incident this ticket exists to surface — is caught the same way, uniformly", () => {
      const d = describeConfig(loadConfig({ ...base, BUTCHR_ASSIGNEE_TASK: "712020:collide", BUTCHR_ASSIGNEE_EPIC: "712020:collide" }, noRead));
      expect(d).toContain("BUTCHR_ASSIGNEE_TASK");
      expect(d).toContain("BUTCHR_ASSIGNEE_EPIC");
      expect(d).toContain("the epic that owns a task");
    });

    test("all three roles set to the SAME account reports every pair, not just one", () => {
      const d = describeConfig(loadConfig({ ...base, BUTCHR_ASSIGNEE_STORY: "712020:x", BUTCHR_ASSIGNEE_TASK: "712020:x", BUTCHR_ASSIGNEE_EPIC: "712020:x" }, noRead));
      expect(d).toContain("the epic that owns a story");
      expect(d).toContain("the epic that owns a task");
      expect(d).toContain("the story that owns a task");
    });

    test("no collision when all set roles genuinely differ", () => {
      const d = describeConfig(loadConfig({ ...base, BUTCHR_ASSIGNEE_STORY: "712020:aaa", BUTCHR_ASSIGNEE_TASK: "712020:bbb", BUTCHR_ASSIGNEE_EPIC: "712020:ccc" }, noRead));
      expect(d).not.toContain("SAME accountId");
      expect(d).toContain("none among this daemon's currently-SET roles");
    });

    test("an UNSET role is never reported as a collision, and the existing unset wording is unchanged — unset and collided are different conditions", () => {
      const d = describeConfig(loadConfig({ ...base, BUTCHR_ASSIGNEE_STORY: "712020:aaa" }, noRead)); // task/epic unset
      expect(d).not.toContain("SAME accountId");
      expect(d).toContain("task:unset — Task creation will be refused");
      expect(d).toContain("epic:unset — Epic creation will be refused");
    });

    // THE HONESTY CLAUSE (measured by BUTCHR-100, 2026-09-02): a local
    // pairwise comparison cannot see a tier staffed by a DIFFERENT daemon —
    // on that measured daemon, story/task differed locally while a live
    // Epic staffed elsewhere carried the SAME accountId as the local task
    // role, and a naive check reported a clean boot. The clause must
    // therefore appear REGARDLESS of whether a collision was found —
    // it qualifies the CLEAN report, which is the dangerous one.
    test("the honesty clause is present on a CLEAN report (no collision found) — this is the graded case", () => {
      const d = describeConfig(loadConfig({ ...base, BUTCHR_ASSIGNEE_STORY: "712020:aaa", BUTCHR_ASSIGNEE_TASK: "712020:bbb" }, noRead));
      expect(d).not.toContain("SAME accountId");
      expect(d).toContain("LOCALLY CONFIGURED");
      expect(d).toContain("DIFFERENT daemon");
      expect(d).toContain("NOT evidence");
    });

    test("the honesty clause is present on a COLLIDING report too — not only alongside a clean one", () => {
      const d = describeConfig(loadConfig({ ...base, BUTCHR_ASSIGNEE_STORY: "712020:same", BUTCHR_ASSIGNEE_TASK: "712020:same" }, noRead));
      expect(d).toContain("SAME accountId");
      expect(d).toContain("LOCALLY CONFIGURED");
      expect(d).toContain("project↔epic hop");
    });

    test("the honesty clause names the project↔epic gap, and points at S1 (new_worker/adopt_worker) as the check that actually catches it", () => {
      const d = describeConfig(loadConfig(base, noRead));
      expect(d).toContain("project↔epic hop");
      expect(d).toContain("new_worker/adopt_worker");
    });

    test("the whole collision report is scoped to THIS daemon, not the fleet", () => {
      const d = describeConfig(loadConfig(base, noRead));
      expect(d).toContain("roleCollisions(this daemon only)=");
    });
  });

  test("captureDir defaults to .captures under the workspace root; BUTCHR_CAPTURE_DIR overrides it", () => {
    const c = loadConfig(base, noRead);
    expect(c.captureDir).toBe(join(workspaceRoot(), ".captures"));
    expect(loadConfig({ ...base, BUTCHR_CAPTURE_DIR: "/tmp/captures" }, noRead).captureDir).toBe("/tmp/captures");
  });
  test("describeConfig includes captureDir", () => {
    expect(describeConfig(loadConfig({ ...base, BUTCHR_CAPTURE_DIR: "/tmp/captures" }, noRead))).toContain("captureDir=/tmp/captures");
  });

  // BUTCHR-91/BUTCHR-68: the project tier's opt-in staffing scope, default
  // OFF. Paired control, same shape as the github-orgs tests above: an
  // implementation that always returns [] (reject-everything) would pass
  // the first assertion alone but fail the second; one that ignores the env
  // entirely and returns something non-empty by default would fail the
  // first. Only a real comma-split-and-trim parser passes both.
  test("projectAllowlist defaults to empty when BUTCHR_PROJECT_ALLOWLIST is unset", () => {
    expect(loadConfig(base, noRead).projectAllowlist).toEqual([]);
  });
  test("projectAllowlist is comma-split and trimmed when BUTCHR_PROJECT_ALLOWLIST is set", () => {
    const c = loadConfig({ ...base, BUTCHR_PROJECT_ALLOWLIST: "ACME, BETA ,GAMMA" }, noRead);
    expect(c.projectAllowlist).toEqual(["ACME", "BETA", "GAMMA"]);
  });
  test("describeConfig states the allowlist plainly — empty as an explicit 'staffs nothing', non-empty as the actual keys", () => {
    expect(describeConfig(loadConfig(base, noRead))).toContain("projectAllowlist=EMPTY — project tier staffs nothing");
    expect(describeConfig(loadConfig({ ...base, BUTCHR_PROJECT_ALLOWLIST: "ACME" }, noRead))).toContain("projectAllowlist=ACME");
  });
});
