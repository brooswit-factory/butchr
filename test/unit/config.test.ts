import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadConfig, describeConfig, ignoredExtensionOriginsWarning, isAtlassianConfigured, validateAtlassianSiteShape } from "../../src/config/config.js";
import { workspaceRoot } from "../../src/agents/workspace.js";
import { checkExtensionOrigin } from "../../src/web/origin-guard.js";

const noRead = () => { throw new Error("should not read"); };
const base = { ATLASSIAN_SITE: "https://x.atlassian.net/", ATLASSIAN_EMAIL: "a@b.c", ATLASSIAN_TOKEN: "tok" };

describe("loadConfig", () => {
  test("accepts AGY as default and in every role's ordered provider list", () => {
    const c = loadConfig({ ...base, BUTCHR_AGENT_PROVIDER: " agy ", BUTCHR_AGENT_PROVIDERS: "claude, agy, codex",
      BUTCHR_AGENT_PROVIDERS_PROJECT: "agy,claude", BUTCHR_AGENT_PROVIDERS_EPIC: "agy,codex",
      BUTCHR_AGENT_PROVIDERS_STORY: "codex,agy", BUTCHR_AGENT_PROVIDERS_TASK: "agy",
    }, noRead);
    expect(c.agent).toEqual({ provider: "agy", providers: ["claude", "agy", "codex"], roleProviders: {
      project: ["agy", "claude"], epic: ["agy", "codex"], story: ["codex", "agy"], task: ["agy"],
    }, restoredResume: new Set(["buddy", "genius"]) });
    expect(describeConfig(c)).toContain("provider=agy");
    for (const order of ["agy,agy", "agy,unknown", "agy,", ""]) {
      expect(() => loadConfig({ ...base, BUTCHR_AGENT_PROVIDERS: order }, noRead)).toThrow("ordered list");
      expect(() => loadConfig({ ...base, BUTCHR_AGENT_PROVIDERS_TASK: order }, noRead)).toThrow("ordered list");
    }
    expect(() => loadConfig({ ...base, BUTCHR_AGENT_PROVIDER: "unknown" }, noRead)).toThrow("BUTCHR_AGENT_PROVIDER");
  });
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
  test("FACTORY-665: rejects an ATLASSIAN_SITE that isn't exactly https://<name>.atlassian.net", () => {
    for (const bad of ["https://evil.example.com", "http://x.atlassian.net", "https://x.atlassian.net/extra", "https://x.atlassian.net:8443", "https://x.atlassian.net.evil.com", "https://.atlassian.net", "not-a-url"]) {
      expect(() => loadConfig({ ...base, ATLASSIAN_SITE: bad }, noRead)).toThrow(/ATLASSIAN_SITE must look like/);
    }
    expect(() => loadConfig({ ...base, ATLASSIAN_SITE: "HTTPS://X.ATLASSIAN.NET" }, noRead)).not.toThrow();
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

  test("abandonedMinutes defaults to 30, honours BUTCHR_ABANDONED_MINUTES, and rejects a non-positive value", () => {
    expect(loadConfig(base, noRead).abandonedMinutes).toBe(30);
    expect(loadConfig({ ...base, BUTCHR_ABANDONED_MINUTES: "45" }, noRead).abandonedMinutes).toBe(45);
    expect(() => loadConfig({ ...base, BUTCHR_ABANDONED_MINUTES: "0" }, noRead)).toThrow(/BUTCHR_ABANDONED_MINUTES/);
    expect(() => loadConfig({ ...base, BUTCHR_ABANDONED_MINUTES: "nope" }, noRead)).toThrow(/BUTCHR_ABANDONED_MINUTES/);
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

  // FACTORY-772: BOUNDED on both ends, unlike BUTCHR_HERDR_TIMEOUT_MS above
  // (no upper bound — a defect this var deliberately does not repeat).
  test("loopWatchdogThresholdMs defaults to 120000, honours BUTCHR_LOOP_WATCHDOG_THRESHOLD_MS, and rejects NaN/below-min/above-max", () => {
    expect(loadConfig(base, noRead).loopWatchdogThresholdMs).toBe(120_000);
    expect(loadConfig({ ...base, BUTCHR_LOOP_WATCHDOG_THRESHOLD_MS: "60000" }, noRead).loopWatchdogThresholdMs).toBe(60_000);
    expect(() => loadConfig({ ...base, BUTCHR_LOOP_WATCHDOG_THRESHOLD_MS: "nope" }, noRead)).toThrow(/BUTCHR_LOOP_WATCHDOG_THRESHOLD_MS/);
    expect(() => loadConfig({ ...base, BUTCHR_LOOP_WATCHDOG_THRESHOLD_MS: "29999" }, noRead)).toThrow(/BUTCHR_LOOP_WATCHDOG_THRESHOLD_MS/);
    expect(() => loadConfig({ ...base, BUTCHR_LOOP_WATCHDOG_THRESHOLD_MS: "1800001" }, noRead)).toThrow(/BUTCHR_LOOP_WATCHDOG_THRESHOLD_MS/);
    expect(loadConfig({ ...base, BUTCHR_LOOP_WATCHDOG_THRESHOLD_MS: "30000" }, noRead).loopWatchdogThresholdMs).toBe(30_000);
    expect(loadConfig({ ...base, BUTCHR_LOOP_WATCHDOG_THRESHOLD_MS: "1800000" }, noRead).loopWatchdogThresholdMs).toBe(1_800_000);
  });
  test("describeConfig includes loopWatchdogThresholdMs", () => {
    expect(describeConfig(loadConfig(base, noRead))).toContain("loopWatchdogThresholdMs=120000");
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
    const both = describeConfig(loadConfig({ ...base, BUTCHR_ASSIGNEE_STORY: "000000:00000000-0000-0000-0000-000000000000", BUTCHR_ASSIGNEE_TASK: "000000:11111111-1111-1111-1111-111111111111" }, noRead));
    expect(both).toContain("assignees=story:000000:0000");
    expect(both).toContain("task:000000:1111");
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
    const set = describeConfig(loadConfig({ ...base, BUTCHR_ASSIGNEE_EPIC: "000000:00000000-0000-0000-0000-000000000000" }, noRead));
    expect(set).toContain("epic:000000:0000");
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

  // FACTORY-100/FACTORY-103: OFF by default, same all-or-nothing optional-object shape as `github` — absent BUTCHR_LIZARD_APPROVAL_SOUND means the field is undefined, not merely empty. The enable flag and the override path are TWO SEPARATE env vars: the common case (drovr's bundled default) needs only the flag.
  test("lizardApprovalSound is absent unless BUTCHR_LIZARD_APPROVAL_SOUND is set to a non-empty value", () => {
    expect(loadConfig(base, noRead).lizardApprovalSound).toBeUndefined();
    expect(loadConfig({ ...base, BUTCHR_LIZARD_APPROVAL_SOUND: "   " }, noRead).lizardApprovalSound).toBeUndefined();
    // A path alone, with the flag unset, must NOT enable the feature.
    expect(loadConfig({ ...base, BUTCHR_LIZARD_APPROVAL_SOUND_PATH: "/x/lizard.mp3" }, noRead).lizardApprovalSound).toBeUndefined();
  });
  test("BUTCHR_LIZARD_APPROVAL_SOUND alone enables it with no override (drovr's bundled default)", () => {
    expect(loadConfig({ ...base, BUTCHR_LIZARD_APPROVAL_SOUND: "1" }, noRead).lizardApprovalSound).toEqual({});
  });
  test("BUTCHR_LIZARD_APPROVAL_SOUND_PATH (trimmed), alongside the flag, sets overridePath", () => {
    expect(loadConfig({ ...base, BUTCHR_LIZARD_APPROVAL_SOUND: "1", BUTCHR_LIZARD_APPROVAL_SOUND_PATH: "  ~/.local/share/butchr/sounds/lizard-button.mp3  " }, noRead).lizardApprovalSound).toEqual({ overridePath: "~/.local/share/butchr/sounds/lizard-button.mp3" });
  });
  test("describeConfig reports lizardApprovalSound as disabled, enabled with the default, or enabled with its override path", () => {
    expect(describeConfig(loadConfig(base, noRead))).toContain("lizardApprovalSound=disabled");
    expect(describeConfig(loadConfig({ ...base, BUTCHR_LIZARD_APPROVAL_SOUND: "1" }, noRead))).toContain("lizardApprovalSound=enabled overridePath=(default: drovr's bundled asset)");
    expect(describeConfig(loadConfig({ ...base, BUTCHR_LIZARD_APPROVAL_SOUND: "1", BUTCHR_LIZARD_APPROVAL_SOUND_PATH: "/x/lizard.mp3" }, noRead))).toContain("lizardApprovalSound=enabled overridePath=/x/lizard.mp3");
  });

  // FACTORY-581 SAFETY GUARD 4: OFF (undefined) by default — unset or
  // blank/whitespace-only means permission-answering stays fleet-wide, the
  // exact behaviour before this field existed; no new flag, only a narrowing
  // value for the EXISTING eligiblePanes gate (src/daemon/index.ts).
  test("permissionAnswerCanaryPaneLabel is absent unless BUTCHR_PERMISSION_ANSWER_CANARY_PANE is set to a non-empty value", () => {
    expect(loadConfig(base, noRead).permissionAnswerCanaryPaneLabel).toBeUndefined();
    expect(loadConfig({ ...base, BUTCHR_PERMISSION_ANSWER_CANARY_PANE: "   " }, noRead).permissionAnswerCanaryPaneLabel).toBeUndefined();
  });
  test("BUTCHR_PERMISSION_ANSWER_CANARY_PANE (trimmed) sets the canary label", () => {
    expect(loadConfig({ ...base, BUTCHR_PERMISSION_ANSWER_CANARY_PANE: "  admin-brooswit-nexus  " }, noRead).permissionAnswerCanaryPaneLabel).toBe("admin-brooswit-nexus");
  });
  test("describeConfig reports the canary label, or that it's unset (fleet-wide)", () => {
    expect(describeConfig(loadConfig(base, noRead))).toContain("permissionAnswerCanaryPaneLabel=(unset — permission-answering is fleet-wide)");
    expect(describeConfig(loadConfig({ ...base, BUTCHR_PERMISSION_ANSWER_CANARY_PANE: "admin-brooswit-nexus" }, noRead))).toContain("permissionAnswerCanaryPaneLabel=admin-brooswit-nexus");
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

  test("maxAgents (BUTCHR-284) defaults to 8, honours BUTCHR_MAX_AGENTS, and rejects a non-positive or non-integer value", () => {
    expect(loadConfig(base, noRead).maxAgents).toBe(8);
    expect(loadConfig({ ...base, BUTCHR_MAX_AGENTS: "20" }, noRead).maxAgents).toBe(20);
    expect(() => loadConfig({ ...base, BUTCHR_MAX_AGENTS: "0" }, noRead)).toThrow(/BUTCHR_MAX_AGENTS/);
    expect(() => loadConfig({ ...base, BUTCHR_MAX_AGENTS: "-1" }, noRead)).toThrow(/BUTCHR_MAX_AGENTS/);
    expect(() => loadConfig({ ...base, BUTCHR_MAX_AGENTS: "nope" }, noRead)).toThrow(/BUTCHR_MAX_AGENTS/);
    // a count, unlike the *_MINUTES knobs above — a fractional value is rejected, not merely a non-positive one.
    expect(() => loadConfig({ ...base, BUTCHR_MAX_AGENTS: "3.5" }, noRead)).toThrow(/BUTCHR_MAX_AGENTS/);
  });
  test("describeConfig includes maxAgents", () => {
    expect(describeConfig(loadConfig(base, noRead))).toContain("maxAgents=8");
  });

  // BUTCHR-395/S4: rocketchat is optional, same all-or-nothing shape as github.
  test("rocketchat is absent when any of the three required settings is missing", () => {
    expect(loadConfig(base, noRead).rocketchat).toBeUndefined();
    expect(loadConfig({ ...base, ROCKETCHAT_URL: "https://chat.x" }, noRead).rocketchat).toBeUndefined();
    expect(loadConfig({ ...base, ROCKETCHAT_URL: "https://chat.x", ROCKETCHAT_ADMIN_USER_ID: "a1" }, noRead).rocketchat).toBeUndefined();
    expect(loadConfig({ ...base, ROCKETCHAT_ADMIN_USER_ID: "a1", ROCKETCHAT_ADMIN_TOKEN_FILE: "/t" }, noRead).rocketchat).toBeUndefined();
  });
  test("rocketchat is populated when all three are set; adminTokenFile is the PATH, never file contents (loadConfig's readFile is never called for it)", () => {
    const c = loadConfig({ ...base, ROCKETCHAT_URL: "https://chat.x/", ROCKETCHAT_ADMIN_USER_ID: "a1", ROCKETCHAT_ADMIN_TOKEN_FILE: "/etc/rc-token" }, noRead);
    expect(c.rocketchat).toMatchObject({ url: "https://chat.x/", adminUserId: "a1", adminTokenFile: "/etc/rc-token", userCapThreshold: 45, temporaryAccountCapThreshold: 8 });
    expect(c.rocketchat?.managedPrefix).toBeUndefined();
    expect(c.rocketchat?.tokenDir).toEndWith(".butchr-rc-tokens");
    expect(c.rocketchat?.nexusManifestFile).toEndWith(".butchr-rc-nexus-manifest.json");
  });
  test("userCapThreshold defaults to 45, honours ROCKETCHAT_USER_CAP_THRESHOLD, and rejects anything not a positive integer below 50", () => {
    const rc = { ROCKETCHAT_URL: "https://chat.x", ROCKETCHAT_ADMIN_USER_ID: "a1", ROCKETCHAT_ADMIN_TOKEN_FILE: "/t" };
    expect(loadConfig({ ...base, ...rc }, noRead).rocketchat?.userCapThreshold).toBe(45);
    expect(loadConfig({ ...base, ...rc, ROCKETCHAT_USER_CAP_THRESHOLD: "30" }, noRead).rocketchat?.userCapThreshold).toBe(30);
    for (const bad of ["0", "-1", "50", "51", "nope", "3.5"]) {
      expect(() => loadConfig({ ...base, ...rc, ROCKETCHAT_USER_CAP_THRESHOLD: bad }, noRead)).toThrow(/ROCKETCHAT_USER_CAP_THRESHOLD/);
    }
  });
  // BUTCHR-412 item 5 (BUTCHR-391 comment 23999): a separate, tighter cap on concurrently-existing TEMPORARY accounts alone.
  test("temporaryAccountCapThreshold defaults to 8, honours ROCKETCHAT_TEMPORARY_CAP_THRESHOLD, and rejects a non-positive/non-integer value", () => {
    const rc = { ROCKETCHAT_URL: "https://chat.x", ROCKETCHAT_ADMIN_USER_ID: "a1", ROCKETCHAT_ADMIN_TOKEN_FILE: "/t" };
    expect(loadConfig({ ...base, ...rc }, noRead).rocketchat?.temporaryAccountCapThreshold).toBe(8);
    expect(loadConfig({ ...base, ...rc, ROCKETCHAT_TEMPORARY_CAP_THRESHOLD: "3" }, noRead).rocketchat?.temporaryAccountCapThreshold).toBe(3);
    for (const bad of ["0", "-1", "nope", "3.5"]) {
      expect(() => loadConfig({ ...base, ...rc, ROCKETCHAT_TEMPORARY_CAP_THRESHOLD: bad }, noRead)).toThrow(/ROCKETCHAT_TEMPORARY_CAP_THRESHOLD/);
    }
  });
  test("tokenDir/nexusManifestFile/managedPrefix are configurable and never crash when absent", () => {
    const rc = { ROCKETCHAT_URL: "https://chat.x", ROCKETCHAT_ADMIN_USER_ID: "a1", ROCKETCHAT_ADMIN_TOKEN_FILE: "/t" };
    const c = loadConfig({ ...base, ...rc, ROCKETCHAT_TOKEN_DIR: "/var/lib/butchr/rc-tokens", ROCKETCHAT_NEXUS_MANIFEST_FILE: "/var/lib/butchr/nexus.json", ROCKETCHAT_MANAGED_PREFIX: "acme_" }, noRead);
    expect(c.rocketchat?.tokenDir).toBe("/var/lib/butchr/rc-tokens");
    expect(c.rocketchat?.nexusManifestFile).toBe("/var/lib/butchr/nexus.json");
    expect(c.rocketchat?.managedPrefix).toBe("acme_");
  });
  test("a stray ROCKETCHAT_USER_CAP_THRESHOLD never crashes a daemon that otherwise has no Rocket.Chat config", () => {
    expect(() => loadConfig({ ...base, ROCKETCHAT_USER_CAP_THRESHOLD: "not-a-number-at-all" }, noRead)).not.toThrow();
    expect(loadConfig({ ...base, ROCKETCHAT_USER_CAP_THRESHOLD: "not-a-number-at-all" }, noRead).rocketchat).toBeUndefined();
  });
  test("describeConfig reports rocketchat as disabled or its URL/admin id/thresholds, and never reads (or could leak) the token file", () => {
    expect(describeConfig(loadConfig(base, noRead))).toContain("rocketchat=disabled");
    const d = describeConfig(loadConfig({ ...base, ROCKETCHAT_URL: "https://chat.x", ROCKETCHAT_ADMIN_USER_ID: "a1", ROCKETCHAT_ADMIN_TOKEN_FILE: "/etc/rc-token" }, noRead));
    expect(d).toContain("url=https://chat.x");
    expect(d).toContain("userCapThreshold=45");
    expect(d).toContain("temporaryAccountCapThreshold=8");
    expect(d).toContain("adminTokenFile=/etc/rc-token");
  });

  // FACTORY-369: a SEPARATE identity from `rocketchat` above — same
  // all-or-nothing shape, but its own env vars.
  describe("managedEscalationRocketChat (FACTORY-369)", () => {
    test("absent when any of the three required settings is missing", () => {
      expect(loadConfig(base, noRead).managedEscalationRocketChat).toBeUndefined();
      expect(loadConfig({ ...base, BUTCHR_TEAM_ADMIN_ROCKETCHAT_URL: "https://chat.x" }, noRead).managedEscalationRocketChat).toBeUndefined();
      expect(loadConfig({ ...base, BUTCHR_TEAM_ADMIN_ROCKETCHAT_URL: "https://chat.x", BUTCHR_TEAM_ADMIN_ROCKETCHAT_USER_ID: "a1" }, noRead).managedEscalationRocketChat).toBeUndefined();
    });
    test("populated when all three are set; room defaults to team-admin", () => {
      const c = loadConfig({ ...base, BUTCHR_TEAM_ADMIN_ROCKETCHAT_URL: "https://chat.x", BUTCHR_TEAM_ADMIN_ROCKETCHAT_USER_ID: "a1", BUTCHR_TEAM_ADMIN_ROCKETCHAT_TOKEN_FILE: "/etc/ta-token" }, noRead);
      expect(c.managedEscalationRocketChat).toEqual({ url: "https://chat.x", adminUserId: "a1", adminTokenFile: "/etc/ta-token", room: "team-admin" });
    });
    test("BUTCHR_TEAM_ADMIN_ROOM overrides the default room", () => {
      const c = loadConfig({ ...base, BUTCHR_TEAM_ADMIN_ROCKETCHAT_URL: "https://chat.x", BUTCHR_TEAM_ADMIN_ROCKETCHAT_USER_ID: "a1", BUTCHR_TEAM_ADMIN_ROCKETCHAT_TOKEN_FILE: "/etc/ta-token", BUTCHR_TEAM_ADMIN_ROOM: "ops-alerts" }, noRead);
      expect(c.managedEscalationRocketChat?.room).toBe("ops-alerts");
    });
    test("a stray BUTCHR_TEAM_ADMIN_ROOM never crashes a daemon that otherwise has no team-admin config", () => {
      expect(() => loadConfig({ ...base, BUTCHR_TEAM_ADMIN_ROOM: "ops-alerts" }, noRead)).not.toThrow();
      expect(loadConfig({ ...base, BUTCHR_TEAM_ADMIN_ROOM: "ops-alerts" }, noRead).managedEscalationRocketChat).toBeUndefined();
    });
    test("describeConfig reports it disabled or its url/admin id/room, and never reads (or could leak) the token file", () => {
      expect(describeConfig(loadConfig(base, noRead))).toContain("managedEscalationRocketChat=disabled");
      const d = describeConfig(loadConfig({ ...base, BUTCHR_TEAM_ADMIN_ROCKETCHAT_URL: "https://chat.x", BUTCHR_TEAM_ADMIN_ROCKETCHAT_USER_ID: "a1", BUTCHR_TEAM_ADMIN_ROCKETCHAT_TOKEN_FILE: "/etc/ta-token" }, noRead));
      expect(d).toContain("url=https://chat.x");
      expect(d).toContain("room=team-admin");
      expect(d).toContain("adminTokenFile=/etc/ta-token");
    });
  });

  // FACTORY-609 (Part B): always present, independent of the credential
  // gate above — defaults to the director's own routing (FACTORY-607
  // comment 28688), overridable per-value via env vars.
  describe("managedEscalationRouting (FACTORY-609)", () => {
    test("defaults match the director's routing (FACTORY-607 comment 28688) when nothing is set", () => {
      const c = loadConfig(base, noRead);
      expect(c.managedEscalationRouting).toEqual({
        normalMention: "@admin-assembly", normalRoom: "team-admin",
        assemblyMention: "@manager-factory", assemblyRoom: "team-engineering",
        directorMention: "@director", directorRoom: "team-engineering",
        tier2Minutes: 10, tier3Minutes: 20,
      });
    });

    test("every value is independently overridable via its own env var", () => {
      const c = loadConfig({
        ...base,
        BUTCHR_MANAGED_ESCALATION_ANSWERER_MENTION: "@custom-answerer",
        BUTCHR_TEAM_ADMIN_ROOM: "custom-admin-room",
        BUTCHR_MANAGED_ESCALATION_ASSEMBLY_MENTION: "@custom-manager",
        BUTCHR_MANAGED_ESCALATION_ASSEMBLY_ROOM: "custom-eng-room",
        BUTCHR_MANAGED_ESCALATION_DIRECTOR_MENTION: "@custom-director",
        BUTCHR_MANAGED_ESCALATION_DIRECTOR_ROOM: "custom-director-room",
        BUTCHR_MANAGED_ESCALATION_TIER2_MINUTES: "7",
        BUTCHR_MANAGED_ESCALATION_TIER3_MINUTES: "15",
      }, noRead);
      expect(c.managedEscalationRouting).toEqual({
        normalMention: "@custom-answerer", normalRoom: "custom-admin-room",
        assemblyMention: "@custom-manager", assemblyRoom: "custom-eng-room",
        directorMention: "@custom-director", directorRoom: "custom-director-room",
        tier2Minutes: 7, tier3Minutes: 15,
      });
    });

    test("rejects a non-positive or non-numeric tier delay", () => {
      expect(() => loadConfig({ ...base, BUTCHR_MANAGED_ESCALATION_TIER2_MINUTES: "0" }, noRead)).toThrow();
      expect(() => loadConfig({ ...base, BUTCHR_MANAGED_ESCALATION_TIER3_MINUTES: "not-a-number" }, noRead)).toThrow();
    });

    test("rejects tier3 <= tier2 — the director's own ordering is a correctness constraint, not a style preference", () => {
      expect(() => loadConfig({ ...base, BUTCHR_MANAGED_ESCALATION_TIER2_MINUTES: "20", BUTCHR_MANAGED_ESCALATION_TIER3_MINUTES: "20" }, noRead)).toThrow();
      expect(() => loadConfig({ ...base, BUTCHR_MANAGED_ESCALATION_TIER2_MINUTES: "20", BUTCHR_MANAGED_ESCALATION_TIER3_MINUTES: "10" }, noRead)).toThrow();
    });

    test("describeConfig reports the full routing table", () => {
      const d = describeConfig(loadConfig(base, noRead));
      expect(d).toContain("managedEscalationRouting=");
      expect(d).toContain("@admin-assembly");
      expect(d).toContain("@manager-factory");
      expect(d).toContain("@director");
      expect(d).toContain("tier2Minutes=10");
      expect(d).toContain("tier3Minutes=20");
    });
  });

  describe("opsAlert (FACTORY-630)", () => {
    test("defaults to the director's own room, mention and dedup window, with no env set at all", () => {
      const c = loadConfig(base, noRead);
      expect(c.opsAlert).toEqual({ room: "team-admin", mention: "@director", dedupMinutes: 60 });
    });

    test("is ALWAYS present, even with no Rocket.Chat posting credential — the [butchr:ops-alert] journal line needs these values regardless of whether posting is configured", () => {
      const c = loadConfig(base, noRead);
      expect(c.managedEscalationRocketChat).toBeUndefined();
      expect(c.opsAlert.room).toBe("team-admin");
    });

    test("each value is overridable", () => {
      const c = loadConfig({ ...base, BUTCHR_OPS_ALERT_ROOM: "team-engineering", BUTCHR_OPS_ALERT_MENTION: "@manager-factory", BUTCHR_OPS_ALERT_DEDUP_MINUTES: "15" }, noRead);
      expect(c.opsAlert).toEqual({ room: "team-engineering", mention: "@manager-factory", dedupMinutes: 15 });
    });

    test("a literal `none` mention means post with NO mention — an empty env var cannot express that, since it is indistinguishable from unset", () => {
      expect(loadConfig({ ...base, BUTCHR_OPS_ALERT_MENTION: "none" }, noRead).opsAlert.mention).toBe("");
      // Empty/whitespace is UNSET, and so takes the default rather than
      // silently producing an unmentioned room nobody asked for.
      expect(loadConfig({ ...base, BUTCHR_OPS_ALERT_MENTION: "   " }, noRead).opsAlert.mention).toBe("@director");
    });

    test("rejects a non-positive or non-numeric dedup window rather than silently disabling dedup", () => {
      expect(() => loadConfig({ ...base, BUTCHR_OPS_ALERT_DEDUP_MINUTES: "0" }, noRead)).toThrow();
      expect(() => loadConfig({ ...base, BUTCHR_OPS_ALERT_DEDUP_MINUTES: "-5" }, noRead)).toThrow();
      expect(() => loadConfig({ ...base, BUTCHR_OPS_ALERT_DEDUP_MINUTES: "soon" }, noRead)).toThrow();
    });

    test("describeConfig names the room, the mention, the window, and says when no posting credential exists", () => {
      const d = describeConfig(loadConfig(base, noRead));
      expect(d).toContain("opsAlert=#team-admin");
      expect(d).toContain("dedupMinutes=60");
      expect(d).toContain("NO posting credential");
    });
  });
});

describe("extensionAuth (FACTORY-339; FACTORY-464/FACTORY-465 dropped the bearer token; FACTORY-497/FACTORY-475 hardcodes Cleavr's fixed id as the ONLY allowed origin)", () => {
  const CLEAVR_ORIGIN = "chrome-extension://geffpgminecanhmpafbliajpeleoocan";

  // FACTORY-497: removed the tests for the three-way unset/explicit-empty/
  // additive env semantics (`BUTCHR_EXTENSION_ORIGINS` had a real effect on
  // the allowlist) — there is no longer any env-driven allowlist behavior
  // to assert: `loadConfig` never reads that variable into `extensionAuth`
  // at all any more, so those cases no longer exist to test. No security
  // assertion is weakened: the replacement tests below still assert the
  // fixed id is allowed, every other id is rejected, and absent Origin is
  // refused — plus a new assertion (below) that the variable's value now
  // has NO effect on the allowlist, which is a strictly stronger claim than
  // "additive" ever was.

  test("extensionAuth is always exactly Cleavr's fixed id, regardless of environment", () => {
    const c = loadConfig(base, noRead);
    expect(c.extensionAuth).toEqual({ allowedOrigins: [CLEAVR_ORIGIN] });
  });
  test("setting BUTCHR_EXTENSION_ORIGINS has no effect on the allowlist, however it's set", () => {
    for (const value of ["chrome-extension://abcdefghijklmnopabcdefghijklmnop", "", "not-a-uri-at-all", ","]) {
      const c = loadConfig({ ...base, BUTCHR_EXTENSION_ORIGINS: value }, noRead);
      expect(c.extensionAuth).toEqual({ allowedOrigins: [CLEAVR_ORIGIN] });
    }
  });
  test("setting BUTCHR_EXTENSION_ORIGINS triggers the ignored-variable warning; unset does not", () => {
    expect(ignoredExtensionOriginsWarning({ ...base, BUTCHR_EXTENSION_ORIGINS: "chrome-extension://abcdefghijklmnopabcdefghijklmnop" })).toContain("BUTCHR_EXTENSION_ORIGINS");
    expect(ignoredExtensionOriginsWarning({ ...base, BUTCHR_EXTENSION_ORIGINS: "" })).toContain("BUTCHR_EXTENSION_ORIGINS");
    expect(ignoredExtensionOriginsWarning(base)).toBeUndefined();
  });
  test("describeConfig reports the single fixed-id allowlist", () => {
    expect(describeConfig(loadConfig(base, noRead))).toContain(`extensionAuth=origins=${CLEAVR_ORIGIN}`);
  });
});

describe("guard behavior with the real config (FACTORY-497/FACTORY-475)", () => {
  const CLEAVR_ORIGIN = "chrome-extension://geffpgminecanhmpafbliajpeleoocan";

  test("default config allows the fixed Cleavr id and rejects any other origin", () => {
    const c = loadConfig(base, noRead);
    expect(checkExtensionOrigin({ origin: CLEAVR_ORIGIN }, c.extensionAuth).ok).toBe(true);
    expect(checkExtensionOrigin({ origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop" }, c.extensionAuth).ok).toBe(false);
  });
  test("absent Origin is still refused (403) even with the default allowlist populated", () => {
    const c = loadConfig(base, noRead);
    const r = checkExtensionOrigin({ origin: null }, c.extensionAuth);
    expect(r).toEqual({ ok: false, status: 403, body: { error: "origin required" }, corsHeaders: {}, reason: "origin required" });
  });
});

describe("FACTORY-665 (PR-2): isAtlassianConfigured / validateAtlassianSiteShape", () => {
  test("isAtlassianConfigured is true only when site+email+(token or token file) are all present and non-blank", () => {
    expect(isAtlassianConfigured(base)).toBe(true);
    expect(isAtlassianConfigured({ ...base, ATLASSIAN_SITE: undefined })).toBe(false);
    expect(isAtlassianConfigured({ ...base, ATLASSIAN_SITE: "  " })).toBe(false);
    expect(isAtlassianConfigured({ ...base, ATLASSIAN_EMAIL: undefined })).toBe(false);
    expect(isAtlassianConfigured({ ...base, ATLASSIAN_TOKEN: undefined })).toBe(false);
    expect(isAtlassianConfigured({ ...base, ATLASSIAN_TOKEN: undefined, ATLASSIAN_TOKEN_FILE: "/t" })).toBe(true);
  });
  test("isAtlassianConfigured never validates the site's shape — only presence (loadConfig/validateAtlassianSiteShape own that)", () => {
    expect(isAtlassianConfigured({ ...base, ATLASSIAN_SITE: "not a url at all" })).toBe(true);
  });
  test("validateAtlassianSiteShape accepts exactly https://<name>.atlassian.net, case-insensitively, and rejects everything else", () => {
    expect(() => validateAtlassianSiteShape("https://x.atlassian.net")).not.toThrow();
    expect(() => validateAtlassianSiteShape("https://my-team.atlassian.net")).not.toThrow();
    expect(() => validateAtlassianSiteShape("HTTPS://X.ATLASSIAN.NET")).not.toThrow();
    for (const bad of ["https://evil.example.com", "http://x.atlassian.net", "https://x.atlassian.net/", "https://x.atlassian.net/path", "https://x.atlassian.net:443", "https://x.atlassian.net.evil.com", "https://.atlassian.net", "https://-x.atlassian.net", "ftp://x.atlassian.net", ""]) {
      expect(() => validateAtlassianSiteShape(bad)).toThrow(/ATLASSIAN_SITE must look like/);
    }
  });
});
