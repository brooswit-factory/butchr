import { describe, expect, test } from "bun:test";
import { readFileSync, existsSync, rmSync, writeFileSync, statSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { briefFor, interpolate, modelFor, effortFor, assertNoInheritedMcpConfig, buildWorkspace, agentIdOfWorkspacePath, FILESYSTEM_TOOLS_NOTE, MANAGED_SESSION_TOOLS_NOTE, mcpIdentityHeaders, resolveAccountHeader, resolveMcpServerHeaders, resourceKeyOf, ruleAgentIdOfWorkspacePath, singleResourceOf, workspaceDirFor, workspaceMcpServers, workspacePermissionMode, workspaceStrictMcpConfig, workspaceModel, workspaceEffort, workspaceRoot, type SpawnSpec } from "../../src/agents/workspace.js";
import { agentLaunchConfig } from "../../src/agents/argv.js";
import { encodeAgentKey, encodeQueryAgentKey } from "../../src/rules/agent-key.js";

describe("workspace identity", () => {
  test("AGY writes cwd bridge identity and AGENTS.md while retaining existing work", () => {
    const previous = process.env.BUTCHR_WORKSPACES;
    const root = mkdtempSync(join(tmpdir(), "butchr-agy-workspace-"));
    process.env.BUTCHR_WORKSPACES = root;
    try {
      const spec = { key: "AGY-1", issuetype: "Task", summary: "bridge fixture", parent: null };
      const dir = buildWorkspace(spec, "http://localhost:7717/mcp", "agy");
      expect(dir).toBe(join(root, spec.key));
      expect(JSON.parse(readFileSync(join(dir, ".butchr-agy.json"), "utf8"))).toEqual({ issue: spec.key, mcpUrl: "http://localhost:7717/mcp" });
      expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).toContain("Read `brief.md`");
      expect(readFileSync(join(dir, "brief.md"), "utf8")).toContain(spec.key);
      expect(existsSync(join(dir, "CLAUDE.md"))).toBe(false);
      expect(existsSync(join(dir, "mcp.json"))).toBe(false);
      expect(existsSync(join(dir, "ENVIRONMENT.md"))).toBe(true);
      writeFileSync(join(dir, "progress.txt"), "keep this work");
      buildWorkspace(spec, "http://localhost:9000/mcp", "agy");
      expect(JSON.parse(readFileSync(join(dir, ".butchr-agy.json"), "utf8")).mcpUrl).toBe("http://localhost:9000/mcp");
      expect(readFileSync(join(dir, "progress.txt"), "utf8")).toBe("keep this work");
    } finally {
      if (previous === undefined) delete process.env.BUTCHR_WORKSPACES;
      else process.env.BUTCHR_WORKSPACES = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });
  test("derives identity only from a direct child of the configured workspace root", () => {
    const root = workspaceRoot();
    expect(agentIdOfWorkspacePath(join(root, "kan-42"))).toBe("KAN-42");
    expect(agentIdOfWorkspacePath(join(root, "nested", "KAN-42"))).toBeNull();
    expect(agentIdOfWorkspacePath("/tmp/KAN-42")).toBeNull();
    expect(agentIdOfWorkspacePath(null)).toBeNull();
  });
  test("rule agent ids cover every provider and never a legacy workspace", () => {
    const root = "/w";
    expect(ruleAgentIdOfWorkspacePath("/w/jira-work/build/KAN-1", root)).toBe("jira-work:build:KAN-1");
    expect(ruleAgentIdOfWorkspacePath("/w/github-issue/triage/acme%2Fweb%2342", root)).toBe("github-issue:triage:acme%2Fweb%2342");
    expect(ruleAgentIdOfWorkspacePath("/w/jira-idea/ideas/IDEA-7", root)).toBe("jira-idea:ideas:IDEA-7");
    expect(ruleAgentIdOfWorkspacePath("/w/zendesk-ticket/support/acme%2312", root)).toBe("zendesk-ticket:support:acme%2312");
    expect(ruleAgentIdOfWorkspacePath("/w/kan-42", root)).toBeNull();
    expect(ruleAgentIdOfWorkspacePath("/w/github-issue/triage/not-a-ref", root)).toBeNull();
    expect(ruleAgentIdOfWorkspacePath(null, root)).toBeNull();
  });
  test("BUTCHR-397: a query-level agent's workspace round-trips through workspaceDirFor/agentIdOfWorkspacePath and sits as a SIBLING of that rule's per-resource ones, never their parent", () => {
    const root = "/w";
    const queryKey = encodeQueryAgentKey({ resourceProvider: "jira-work", ruleId: "triage" });
    const resourceKey = encodeAgentKey({ resourceProvider: "jira-work", ruleId: "triage", resourceId: "BUTCHR-12" });
    const queryDir = workspaceDirFor(queryKey, root);
    const resourceDir = workspaceDirFor(resourceKey, root);
    expect(queryDir).toBe(join(root, "jira-work", "triage", "%40query"));
    // Same parent directory (the rule's own folder) — a sibling, not an ancestor: buildWorkspace()
    // would otherwise write the query agent's own files into the directory that holds every
    // per-resource agent's subdirectory for this rule.
    expect(join(queryDir, "..")).toBe(join(resourceDir, ".."));
    expect(queryDir).not.toBe(resourceDir);
    // Round-trips back to the exact same key, and is recognised as a rule-engine (not legacy) workspace.
    expect(agentIdOfWorkspacePath(queryDir, root)).toBe(queryKey);
    expect(ruleAgentIdOfWorkspacePath(queryDir, root)).toBe(queryKey);
    // Findable again after a "daemon restart" with nothing but the directory: agentIdOfWorkspacePath
    // takes only the path and root, no in-memory state, and this is the exact inverse of workspaceDirFor.
    expect(workspaceDirFor(agentIdOfWorkspacePath(queryDir, root)!, root)).toBe(queryDir);
  });

  test("BUTCHR-398 (review finding 1): singleResourceOf is null for a query-level id — a caller that needs a real single resource to write to (e.g. an escalation comment) must never fall back to the bogus whole key resourceKeyOf itself falls back to", () => {
    for (const resourceProvider of ["jira-work", "github-issue", "github-pr", "jira-idea", "zendesk-ticket"] as const) {
      const key = encodeQueryAgentKey({ resourceProvider, ruleId: "triage" });
      expect(singleResourceOf(key)).toBeNull();
      // Never equal to resourceKeyOf's own fallback (the bogus whole key) — this is the actual bug being closed.
      expect(resourceKeyOf(key)).toBe(key);
    }
  });
  test("BUTCHR-398: singleResourceOf is unchanged for a per-resource id, of any provider — same as resourceKeyOf", () => {
    const key = encodeAgentKey({ resourceProvider: "jira-work", ruleId: "triage", resourceId: "BUTCHR-1" });
    expect(singleResourceOf(key)).toBe("BUTCHR-1");
    expect(singleResourceOf(key)).toBe(resourceKeyOf(key));
  });
  test("BUTCHR-398: mcpIdentityHeaders for a query-level spec sends x-butchr-agent alone, never x-issue, for every provider including jira-work", () => {
    for (const resourceProvider of ["jira-work", "github-issue", "github-pr", "jira-idea", "zendesk-ticket"] as const) {
      const key = encodeQueryAgentKey({ resourceProvider, ruleId: "triage" });
      const spec: SpawnSpec = { key, issuetype: "task", summary: "s", parent: null, brief: "b" };
      expect(mcpIdentityHeaders(spec)).toEqual({ "x-butchr-agent": key });
    }
  });

  test("BUTCHR-398: buildWorkspace for a query-level agy spec writes {agent, mcpUrl} only — no issue/resource field a real Jira/GitHub/Zendesk lookup could be keyed off", () => {
    const previous = process.env.BUTCHR_WORKSPACES;
    const root = mkdtempSync(join(tmpdir(), "butchr-agy-query-workspace-"));
    process.env.BUTCHR_WORKSPACES = root;
    try {
      const key = encodeQueryAgentKey({ resourceProvider: "jira-work", ruleId: "triage" });
      const spec: SpawnSpec = { key, issuetype: "task", summary: "triage (query agent)", parent: null, brief: "Handle the whole queue." };
      const dir = buildWorkspace(spec, "http://localhost:7717/mcp", "agy");
      expect(dir).toBe(workspaceDirFor(key, root));
      expect(JSON.parse(readFileSync(join(dir, ".butchr-agy.json"), "utf8"))).toEqual({ agent: key, mcpUrl: "http://localhost:7717/mcp" });
      // mcp.json (the Claude path) carries the same header shape.
      buildWorkspace(spec, "http://localhost:7717/mcp", "claude");
      expect(JSON.parse(readFileSync(join(dir, "mcp.json"), "utf8")).mcpServers.butchr.headers).toEqual({ "x-butchr-agent": key });
    } finally {
      if (previous === undefined) delete process.env.BUTCHR_WORKSPACES;
      else process.env.BUTCHR_WORKSPACES = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("briefFor / modelFor", () => {
  test("each type gets its brief; unknown gets default", () => {
    expect(briefFor("Epic")).toContain("You own one outcome");
    expect(briefFor("Story")).toContain("one increment of value");
    expect(briefFor("Task")).toContain("one unit of work");
    expect(briefFor("Bug")).toContain("Read your ticket");
  });
  // FACTORY-40: briefs/bug.md was rewritten from a ~21-line worker-tier stub
  // ("You own one defect. Reproduce it... work in the repository... submit
  // the bug for review") into a boss-tier brief, the same tier as an Epic —
  // it files Stories for the fix and formally reviews them, never touching
  // code itself. This guards the shape of that rewrite directly, the same
  // way the merge-check-guard/assertion-check-guard accounting guards its
  // review-instruction content: a future edit that quietly regresses bug.md
  // back toward "fix it yourself" fails this loudly instead of only
  // surfacing in a much later end-to-end symptom.
  test("FACTORY-40: bug brief is boss-tier — reviews Stories via new_worker, sends a [review] line, states the Done-gate, and carries no worker-stub phrasing instructing it to fix code itself", () => {
    const brief = briefFor("Bug");
    // boss-side staffing verb, same as epic.md/story.md teach for their own workers
    expect(brief).toContain("new_worker");
    expect(brief).toContain("adopt_worker");
    // the reviewer-side [review] line shape this brief sends DOWN to a Story
    expect(brief).toMatch(/\[review\]\s+APPROVED\s+<pr-url>\s+@\s*<full 40-char sha>/);
    expect(brief).toMatch(/\[review\]\s+CHANGES_REQUESTED\s+<pr-url>\s+@\s*<full 40-char sha>/);
    // the Done-gate, stated in words (point 6 of FACTORY-40's own ticket)
    expect(brief).toContain("never closes itself");
    expect(brief).toContain("Stories is not Done");
    // negative: none of the old worker-stub's own phrasing survives
    expect(brief).not.toContain("identify the smallest correct fix");
    expect(brief).not.toContain("work in the repository and branch named by the ticket");
    expect(brief).not.toContain("submit the bug for review");
    // negative: a Bug never authors its own PR — no author-side merge check
    // (that's Story's/Task's instruction, not a boss's — see
    // merge-check-guard.test.ts's MERGE_INSTRUCTING_BRIEFS)
    expect(brief).not.toContain("reviews[].commit.oid");
  });
  test("BUTCHR-71: a project resource is selected the SAME WAY an issue's issuetype is — 'project' resolves to briefs/project.md, case-insensitively", () => {
    expect(briefFor("project")).toContain("You own a **product**, not a ticket");
    expect(briefFor("Project")).toBe(briefFor("project")); // same case-insensitivity every other entry gets
  });
  // BUTCHR-318: project.md must name its inbound surfaces precisely (root
  // doc comments, plus In-Review epics' ticket comments), say an In
  // Progress epic cannot reach it, say it hears a running epic only on its
  // own initiative, and correct the misconception (BUTCHR-277's own doc
  // asserted this wrongly) that an epic's report_to_boss lands on the root doc.
  test("project brief names its inbound surfaces precisely and corrects the report_to_boss-lands-on-root-doc misconception", () => {
    const brief = briefFor("project");
    expect(brief).toContain("Name your inbound surfaces precisely");
    expect(brief).toContain("the ticket comments of any epic");
    expect(brief).toContain("In Progress is not in that result set");
    expect(brief).toContain("it cannot reach you this way");
    expect(brief).toContain("You hear a running epic only by reading its ticket yourself");
    expect(brief).toContain("the epic's own ticket, never on your root doc");
  });
  // BUTCHR-331 defect 1: an ISSUE caller's report_to_boss/ask_boss can NEVER
  // write a root-doc comment (src/tools/speak.ts's project-id branch is the
  // only path to one) — the brief must name the real writers (the project's
  // own report_to_boss/ask_boss, a peer's tell_peer, a person or agent
  // commenting directly) instead of the false "any caller's".
  test("project brief names the real writers of root-doc comments, not 'any caller's report_to_boss/ask_boss'", () => {
    const brief = briefFor("project");
    expect(brief).not.toContain("any caller's `report_to_boss`");
    expect(brief).toContain("written by YOUR OWN `report_to_boss`/`ask_boss`");
    expect(brief).toContain("a peer project's `tell_peer`");
    expect(brief).toContain("a person or agent commenting on the page directly");
    expect(brief).toContain("never by an issue caller's `report_to_boss`/`ask_boss`");
  });
  // BUTCHR-331 defect 2: the project's activation verdict ORs THREE axes
  // (src/resources/project.ts: versionBehind || commentBehind || epicsBehind)
  // — a root-doc BODY edit (the version axis) also wakes the project. The
  // brief previously said "exactly two ... full stop", omitting it.
  test("project brief names all three wake axes, including the root-doc version/body-edit axis, and drops the false 'exactly two ... full stop' precision", () => {
    const brief = briefFor("project");
    expect(brief).not.toContain("exactly two");
    expect(brief).not.toContain("full stop");
    expect(brief).toContain("three wake axes");
    expect(brief).toContain("the VERSION axis");
  });
  // BUTCHR-337 defect 1: the VERSION axis parenthetical claimed "epics have
  // been told to put load-bearing directives in the page body" — false, and
  // self-contradicting within the same paragraph, which later says an epic
  // overwriting the root doc body is destructive and not a channel, never a
  // way for an epic to talk to the project. The VERSION axis itself stays
  // real; only the false justification is dropped.
  test("project brief drops the false 'epics have been told' claim from the VERSION axis parenthetical, while the axis itself remains", () => {
    const brief = briefFor("project");
    expect(brief).not.toContain("epics have been told");
    expect(brief).toContain("three wake axes");
    expect(brief).toContain("the VERSION axis");
  });
  // BUTCHR-335 defect 1: "an epic has no verb that edits or comments on your
  // root doc" was FALSE — confluence_update_page is an unguarded full-body
  // replace with no check on whose page it is, so an epic CAN overwrite a
  // project's root doc body with it (src/tools/defs.ts). Only the "comments"
  // half was ever true. The brief must say so without presenting
  // confluence_update_page as a usable backchannel to the project.
  test("project brief no longer claims an epic has no verb that EDITS the root doc, and does not offer confluence_update_page as a backchannel", () => {
    const brief = briefFor("project");
    expect(brief).not.toContain("an epic has no verb that edits or comments on your root doc");
    expect(brief).not.toContain("no verb that edits");
    expect(brief).toMatch(/no verb that\s+comments on your root doc/);
    expect(brief).toContain("confluence_update_page");
    expect(brief).toContain("not a message reaching you");
    expect(brief).toContain("not a way for an epic to talk to you");
  });
  test("models: epic=opus story=opus task=sonnet project=opus, default sonnet", () => {
    expect(modelFor("Epic")).toBe("opus");
    expect(modelFor("Story")).toBe("opus");
    expect(modelFor("Task")).toBe("sonnet");
    expect(modelFor("Whatever")).toBe("sonnet");
    // BUTCHR-71: a project resource gets the SAME tier an epic gets, not the
    // task-level default — it makes epic-level product judgment.
    expect(modelFor("project")).toBe("opus");
  });
  test("effort: epic/story/task/project all high, unknown type also defaults to high without throwing", () => {
    expect(effortFor("Epic")).toBe("high");
    expect(effortFor("Story")).toBe("high");
    expect(effortFor("Task")).toBe("high");
    expect(effortFor("project")).toBe("high");
    expect(() => effortFor("Whatever")).not.toThrow();
    expect(effortFor("Whatever")).toBe("high");
    expect(effortFor("EPIC")).toBe("high");
    expect(effortFor("Story")).toBe("high");
  });
  test("reviewer briefs carry the [review] verdict-line instruction", () => {
    expect(briefFor("Epic")).toContain("[review] APPROVED");
    expect(briefFor("Story")).toContain("[review] APPROVED");
  });
  // This guard was written to pin an INSTRUCTION: an epic/story must
  // transition its child to In Progress, because an assigned-but-To-Do
  // child is never staffed. BUTCHR-13's review of PR #120 (BUTCHR-43) found
  // that in epic.md "never staffed" now sits inside a HISTORICAL sentence
  // explaining a hole new_worker's required disposition already closed, not
  // an activation instruction — the substring still matches, but what makes
  // it match moved out from under the guard. That's variant #7 of this
  // epic's guard-failure family (a check whose SUBJECT moved while the
  // assertion kept matching) — distinct from too-narrow, too-wide,
  // wrong-moment, adjacent-field, delta-not-requirement and write-not-effect,
  // the other six this epic has produced. Kept below, not deleted: in
  // story.md this text is still an operative warning, not history, and the
  // guard is weaker, not worthless. The guard that actually pins the
  // structural property that replaced the instruction is the one right
  // after it.
  test("epic and story briefs carry the staffing-activation instruction", () => {
    expect(briefFor("Epic")).toContain("In Progress");
    expect(briefFor("Epic")).toContain("never staffed");
    expect(briefFor("Story")).toContain("In Progress");
    expect(briefFor("Story")).toContain("never staffed");
  });
  // BUTCHR-43: the property that actually replaced the instruction above is
  // structural, not procedural — new_worker takes a REQUIRED disposition
  // ("start" or "shelve"+reason) with no default and no third option, so a
  // filed worker can't be left undeclared. Per-tier on purpose (Epic files
  // Stories, Story files Tasks — each teaches new_worker at its own call
  // site, so a rewrite that drops the requirement from only one brief must
  // fail exactly that tier's expect, not get covered by the other's).
  //
  // Scope of what this guards: this can only assert that the BRIEF SAYS the
  // disposition is required with no default — it says nothing about whether
  // relationship.ts actually enforces that. If the requirement were removed
  // from the code tomorrow, this guard would still pass, brief text intact.
  // The behaviour itself is guarded separately, code-side, by
  // test/unit/relationship.test.ts and test/unit/tools.test.ts, which assert
  // the refusals directly (a missing disposition, a reasonless shelve) —
  // verify those still exist rather than trusting this comment. Two guards,
  // two different properties (prose vs. behaviour); this one only covers the
  // first, and the pairing is what covers both.
  test("epic and story briefs teach new_worker's disposition as required, with no default and no third option", () => {
    const epic = briefFor("Epic");
    expect(epic).toContain("required disposition");
    expect(epic).toContain("no third option and no default");

    const story = briefFor("Story");
    expect(story).toContain("required disposition");
    expect(story).toContain("no third option");
    expect(story).toContain("never left undeclared");
  });
  // BUTCHR-46: the old `reviewDecision,headRefOid` two-signal check could
  // not detect a stale approval — `headRefOid` is the PR's CURRENT head, not
  // the reviewed head, so it keeps matching a local HEAD after every push
  // while `reviewDecision` stays APPROVED (this repo doesn't dismiss stale
  // reviews). Both required signals survived exactly the event they existed
  // to catch, proven live against PR #120's own review history. The guard is
  // now pinned to `reviews[].commit.oid`, the field this check anchors on
  // instead of `headRefOid` (NOT immutable itself — see BUTCHR-74, which
  // caveats this in every merge-instructing channel), plus a negative
  // assertion that the old command string is gone — the same cheap defense
  // against a partial revert as the other negative guards here.
  //
  // Scope of what this guards: this can only assert that the BRIEF SAYS to
  // use the last-decisive-review check — it says nothing about whether `gh`
  // actually returns those fields as described. If the command were wrong
  // and never caught anything, this guard would still pass, brief text
  // intact.
  //
  // BUTCHR-47: the ordering half of this check was unguarded. The assertion
  // used to be `toContain("last")` — the bare English word, which ordinary
  // prose elsewhere in both briefs also contains, so the assertion was
  // satisfied no matter what the command said. A `] | last` -> `] | first`
  // mutation (picking the OLDEST decisive review instead of the newest —
  // reintroducing the stale-approval bug this whole guard exists to prevent)
  // left every test green. The assertion now pins `] | last`, the actual jq
  // operator the ordering depends on, because that is the token a
  // "simplification" would change and the bare word was not enough to catch
  // it.
  test("author briefs carry the last-decisive-review merge check, not the stale reviewDecision+headRefOid one", () => {
    for (const t of ["Story", "Task"]) {
      const brief = briefFor(t);
      expect(brief).toContain("reviews[].commit.oid");
      expect(brief).toContain('select(.state=="APPROVED" or .state=="CHANGES_REQUESTED")');
      expect(brief).toContain("] | last");
      expect(brief).not.toContain("reviewDecision,headRefOid");
    }
  });
  // BUTCHR-38: the relationship-verb rewrite. Guards below protect the
  // load-bearing new instructions so the next rewrite can't silently drop
  // them, the same way the guards above protect the ones before them.
  test("every brief teaches set_doc's replace-not-append semantic", () => {
    for (const t of ["Epic", "Story", "Task", "Bug"]) {
      expect(briefFor(t)).toContain("FULL-BODY REPLACE");
      expect(briefFor(t)).toContain("not an append");
    }
  });
  test("reviewing tiers' checklists reject on doc staleness", () => {
    expect(briefFor("Epic")).toContain("doc actually reflects");
    expect(briefFor("Story")).toContain("doc actually reflects");
  });
  test("the captain's-log convention is fully gone — no title format, no convention link, in any brief", () => {
    for (const t of ["Epic", "Story", "Task", "Bug"]) {
      const brief = briefFor(t);
      expect(brief).not.toContain("Log — ");
      expect(brief.toLowerCase()).not.toContain("captain's log");
      expect(brief).not.toContain("10715137");
    }
  });
  test("epic and story briefs teach the boss-side relationship verbs", () => {
    for (const t of ["Epic", "Story"]) {
      const brief = briefFor(t);
      // start_worker added by BUTCHR-42: it was absent from every brief, so
      // reactivating a shelved worker or pulling one back from In Review had
      // no documented route. Its presence in this per-tier loop is itself
      // the guard that would have caught that gap.
      for (const verb of ["new_worker", "start_worker", "shelve_worker", "adopt_worker", "finish_worker", "prioritize_worker", "tell_worker"]) {
        expect(brief).toContain(verb);
      }
    }
  });
  test("story and task briefs teach the worker-side relationship verbs", () => {
    for (const t of ["Story", "Task"]) {
      const brief = briefFor(t);
      for (const verb of ["report_to_boss", "ask_boss", "submit_to_boss"]) {
        expect(brief).toContain(verb);
      }
    }
  });
  // BUTCHR-42: GAP 1 — start_worker is also the verb that reverses
  // shelve_worker, so it belongs right where shelve_worker is taught, in
  // both epic.md and story.md individually (a per-tier check, not just the
  // aggregate verb-list guard above, since a brief could name the verb
  // without covering both reactivation cases).
  test("epic and story briefs teach start_worker covering both the shelved-reactivation and In-Review-back-to-work cases", () => {
    for (const t of ["Epic", "Story"]) {
      const brief = briefFor(t);
      expect(brief).toContain("start_worker");
      expect(brief).toContain("back from In Review");
    }
  });
  // BUTCHR-42: GAP 3 — ask_boss was taught in story.md/task.md/default.md
  // but missing from epic.md specifically, right where "too vague to
  // decompose" already told an epic agent to comment and stop. An aggregate
  // check across all briefs would have missed this (ask_boss was already
  // present elsewhere); this guard is Epic-specific on purpose.
  test("epic brief names ask_boss for a too-vague-to-decompose epic description", () => {
    const brief = briefFor("Epic");
    expect(brief).toContain("ask_boss");
    expect(brief).toContain("too vague to decompose");
  });
  // BUTCHR-318: an epic's boss is a project, which reads the epic's ticket
  // comments only while the epic is In Review — the too-vague-to-decompose
  // ask_boss call above happens while the epic is still In Progress, so
  // epic.md must say plainly that nothing automated is reading it yet.
  test("epic brief's too-vague-to-decompose passage states ask_boss is unread while the epic is still In Progress", () => {
    const brief = briefFor("Epic");
    expect(brief).toContain("if you do have a project boss, it");
    expect(brief).toContain("reads your ticket's comments only while you are In Review");
    expect(brief).toContain("nothing automated is reading it at");
  });
  // BUTCHR-318: the blocked-dialog escalation passage must state the
  // Epic→Project conditionality (an In Progress epic's report_to_boss wakes
  // nobody) and must say submit_to_boss is not a doorbell, plus what an
  // In Progress epic should do instead (call report_to_boss anyway).
  test("epic brief's blocked-dialog section states the Epic→Project conditionality and that submit_to_boss is not a doorbell", () => {
    const brief = briefFor("Epic");
    expect(brief).toContain("your boss is a");
    expect(brief).toContain("project, and a project reads an epic's ticket comments only while that epic");
    expect(brief).toContain("is In Review");
    expect(brief).toContain('it does NOT "escalate to');
    expect(brief).toContain("whoever watches you\" the way the same call genuinely does for a Story or a");
    expect(brief).toContain("`submit_to_boss` is not a doorbell.");
    expect(brief).toContain("call `report_to_boss` anyway");
  });

  // BUTCHR-331 defect 3(a): "escalate to a human immediately" named no
  // mechanism — no verb reaches a human. The brief must instead say the
  // concrete substance: call report_to_boss anyway, only a person reading
  // the ticket directly will see it, and no agent will answer.
  test("epic brief's submit_to_boss-is-not-a-doorbell passage names the concrete mechanism instead of the undefined 'escalate to a human immediately' phrase", () => {
    const brief = briefFor("Epic");
    expect(brief).toContain("only a PERSON READING YOUR TICKET DIRECTLY will ever see it");
    expect(brief).toContain("no agent will answer it");
    expect(brief).not.toContain("escalate to a human immediately");
  });
  // BUTCHR-42: GAP 2 — jira_get_issue, jira_search, jira_add_comment,
  // confluence_search_pages and confluence_list_spaces are retained
  // PERMANENTLY (never deprecated, on no removal clock) but that was never
  // stated anywhere. Each guard below is per-tier and only covers the
  // briefs where the ticket confirmed the name is actually used, so a
  // future rewrite can't satisfy it by adding the word "permanent" to one
  // brief while leaving the other silent.
  test("every brief marks jira_get_issue as a permanent lookup", () => {
    for (const t of ["Epic", "Story", "Task", "Bug"]) {
      expect(briefFor(t)).toContain("permanent lookup");
    }
  });
  test("epic, story, and task briefs mark jira_search as permanent alongside jira_get_issue", () => {
    for (const t of ["Epic", "Story", "Task"]) {
      const brief = briefFor(t);
      expect(brief).toContain("jira_search");
      expect(brief.toUpperCase()).toContain("PERMANENTLY");
    }
  });
  test("epic and story briefs teach jira_add_comment as the permanent sideways peer channel", () => {
    for (const t of ["Epic", "Story"]) {
      const brief = briefFor(t);
      expect(brief).toContain("jira_add_comment");
      expect(brief.toLowerCase()).toContain("sideways");
      expect(brief.toUpperCase()).toContain("PERMANENT");
    }
  });
  test("epic and story briefs teach confluence_search_pages/confluence_list_spaces as permanent discovery tools", () => {
    for (const t of ["Epic", "Story"]) {
      const brief = briefFor(t);
      expect(brief).toContain("confluence_search_pages");
      expect(brief).toContain("confluence_list_spaces");
    }
  });
  test("every brief points at the ASSIST space", () => {
    for (const t of ["Epic", "Story", "Task", "Bug"]) {
      expect(briefFor(t)).toContain("wiki/spaces/ASSIST");
    }
  });
  test("the blocked-dialog ANSWER reply names tell_worker, not a bare comment", () => {
    expect(briefFor("Epic")).toContain("tell_worker(story, text)");
    expect(briefFor("Story")).toContain("tell_worker(task, text)");
  });
  // BUTCHR-46: `finish_without_a_boss` merged in PR #121 as the successor to
  // jira_transition(my_own_key, "Done") for the top-level, bossless case
  // that epic.md's step 5 previously flagged as an honest gap ("no
  // relationship verb closes a top-level ticket to Done"). The negative
  // assertion is the cheap guard against a partial revert: `jira_transition`
  // had exactly one occurrence in epic.md (the parenthetical this replaces)
  // before this change, so asserting its total absence from the brief is the
  // simplest honest form, not an approximation of a narrower claim.
  //
  // Scope of what this guards: this can only assert that the BRIEF SAYS
  // finish_without_a_boss and no longer sends an epic to jira_transition for
  // Done — it says nothing about whether the tool itself behaves that way.
  // If finish_without_a_boss were deleted from the code tomorrow, this guard
  // would still pass, brief text intact.
  test("epic brief teaches finish_without_a_boss and no longer names jira_transition for the Done case", () => {
    const epic = briefFor("Epic");
    expect(epic).toContain("finish_without_a_boss");
    expect(epic).not.toContain("jira_transition");
  });
});
describe("interpolate", () => {
  test("fills key, summary, type, parent; parent-less says so", () => {
    const out = interpolate("k={{KEY}} s={{SUMMARY}} t={{TYPE}} p={{PARENT}}", { key: "K-1", issuetype: "Task", summary: "do it", parent: "K-0" });
    expect(out).toBe("k=K-1 s=do it t=Task p=K-0");
    expect(interpolate("{{PARENT}}", { key: "K", issuetype: "Epic", summary: "s", parent: null })).toContain("top-level");
  });
});
describe("buildWorkspace", () => {
  test("writes CLAUDE.md, interpolated brief.md, and mcp.json with x-issue", () => {
    const previous = process.env.BUTCHR_WORKSPACES;
    const root = mkdtempSync(join(tmpdir(), "bw-"));
    process.env.BUTCHR_WORKSPACES = root;
    try {
      const dir = buildWorkspace({ key: "KAN-9", issuetype: "Story", summary: "ship it", parent: "KAN-1" }, "http://x/mcp");
      expect(dir).toBe(join(root, "KAN-9"));
      expect(readFileSync(join(dir, "CLAUDE.md"), "utf8")).toContain("brief.md");
      const brief = readFileSync(join(dir, "brief.md"), "utf8");
      // BUTCHR-169: `parent` is now a TRUSTWORTHY value by the time it
      // reaches here — ISSUE_SPAWN_CONFIG.specFor (src/resources/issue.ts)
      // derives it from the ticket's Implements link, never Jira's native
      // `parent` field. buildWorkspace itself just renders whatever
      // SpawnSpec it's given, which is what this fixture pins.
      expect(brief).toContain("KAN-9"); expect(brief).toContain("ship it"); expect(brief).toContain("KAN-1");
      const mcp = JSON.parse(readFileSync(join(dir, "mcp.json"), "utf8"));
      expect(mcp.mcpServers.butchr.headers["x-issue"]).toBe("KAN-9");
      expect(mcp.mcpServers.butchr.url).toBe("http://x/mcp");
    } finally {
      if (previous === undefined) delete process.env.BUTCHR_WORKSPACES;
      else process.env.BUTCHR_WORKSPACES = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("writes ENVIRONMENT.md, and CLAUDE.md is interpolated with the same ground truth", () => {
    const previous = process.env.BUTCHR_WORKSPACES;
    const root = mkdtempSync(join(tmpdir(), "bw-"));
    process.env.BUTCHR_WORKSPACES = root;
    try {
      const dir = buildWorkspace({ key: "KAN-10", issuetype: "Task", summary: "ship it", parent: "KAN-1" }, "http://localhost:7719/mcp");
      expect(existsSync(join(dir, "ENVIRONMENT.md"))).toBe(true);
      const environment = readFileSync(join(dir, "ENVIRONMENT.md"), "utf8");
      expect(environment).toContain(hostname());
      expect(environment).toContain("journalctl");
      expect(environment).toContain("7719");
      const claudeMd = readFileSync(join(dir, "CLAUDE.md"), "utf8");
      expect(claudeMd).toContain(hostname());
      expect(claudeMd).toContain("journalctl");
      expect(claudeMd).not.toContain("{{GROUND_TRUTH}}");
    } finally {
      if (previous === undefined) delete process.env.BUTCHR_WORKSPACES;
      else process.env.BUTCHR_WORKSPACES = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("PR #394 review fix 2: spec.cwd does NOT redirect buildWorkspace — bookkeeping files always land in workspaceDirFor(spec.key), never in an operator's own working directory", () => {
    const previous = process.env.BUTCHR_WORKSPACES;
    const root = mkdtempSync(join(tmpdir(), "bw-root-"));
    const real = mkdtempSync(join(tmpdir(), "bw-real-cwd-"));
    process.env.BUTCHR_WORKSPACES = root;
    try {
      const key = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "managed-sessions", resourceId: "/etc/defs/a.json" });
      const spec: SpawnSpec = { key, issuetype: "managed-session", summary: "s", parent: null, brief: "b", cwd: real };
      const dir = buildWorkspace(spec, "http://x/mcp");
      expect(dir).toBe(workspaceDirFor(key, root));
      expect(dir).not.toBe(real);
      expect(existsSync(join(dir, "CLAUDE.md"))).toBe(true);
      expect(existsSync(join(dir, "brief.md"))).toBe(true);
      expect(existsSync(join(dir, "mcp.json"))).toBe(true);
      // The operator's own working directory is untouched — nothing was ever written there.
      expect(existsSync(join(real, "CLAUDE.md"))).toBe(false);
      expect(existsSync(join(real, "brief.md"))).toBe(false);
      expect(existsSync(join(real, "mcp.json"))).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.BUTCHR_WORKSPACES;
      else process.env.BUTCHR_WORKSPACES = previous;
      rmSync(root, { recursive: true, force: true });
      rmSync(real, { recursive: true, force: true });
    }
  });

  test("BUTCHR-456: a managed-session agent's brief gets MANAGED_SESSION_TOOLS_NOTE, never the generic FILESYSTEM_TOOLS_NOTE — a plain filesystem/BUTCHR-407 agent gets the reverse", () => {
    const previous = process.env.BUTCHR_WORKSPACES;
    const root = mkdtempSync(join(tmpdir(), "bw-tools-note-"));
    process.env.BUTCHR_WORKSPACES = root;
    try {
      const managedKey = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "managed-sessions", resourceId: "/etc/defs/a.json" });
      const managedSpec: SpawnSpec = { key: managedKey, issuetype: "managed-session", summary: "s", parent: null, brief: "Tend it." };
      const managedDir = buildWorkspace(managedSpec, "http://x/mcp");
      const managedBrief = readFileSync(join(managedDir, "brief.md"), "utf8");
      expect(managedBrief).toContain(MANAGED_SESSION_TOOLS_NOTE);
      expect(managedBrief).not.toContain(FILESYSTEM_TOOLS_NOTE);
      expect(managedBrief).toContain("freeze_session");

      const plainKey = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "docs", resourceId: "/repo/a.md" });
      const plainSpec: SpawnSpec = { key: plainKey, issuetype: "filesystem", summary: "s", parent: null, brief: "Keep it current." };
      const plainDir = buildWorkspace(plainSpec, "http://x/mcp");
      const plainBrief = readFileSync(join(plainDir, "brief.md"), "utf8");
      expect(plainBrief).toContain(FILESYSTEM_TOOLS_NOTE);
      expect(plainBrief).not.toContain(MANAGED_SESSION_TOOLS_NOTE);
    } finally {
      if (previous === undefined) delete process.env.BUTCHR_WORKSPACES;
      else process.env.BUTCHR_WORKSPACES = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("PR #394 review fix (round 3): agentLaunchConfig keeps the launched PROCESS at the bookkeeping dir even when spec.cwd is set — see SpawnSpec.cwd's own doc comment (Drovr's launch.cwd===workspace.cwd invariant) — while mcp config stays anchored there too, for both vendors", () => {
    const key = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "managed-sessions", resourceId: "/etc/defs/a.json" });
    const spec: SpawnSpec = { key, issuetype: "managed-session", summary: "s", parent: null, brief: "b", cwd: "/repo/some-project" };
    const bookkeepingDir = "/butchr-workspaces/filesystem/managed-sessions/%2Fetc%2Fdefs%2Fa.json";
    const claudeLaunch = agentLaunchConfig(spec, bookkeepingDir, "pane-1", "name", { provider: "claude" });
    expect(claudeLaunch.cwd).toBe(bookkeepingDir);
    expect(claudeLaunch.cwd).not.toBe("/repo/some-project");
    expect((claudeLaunch as { mcpConfigPath: string }).mcpConfigPath).toBe(`${bookkeepingDir}/mcp.json`);
    const codexLaunch = agentLaunchConfig(spec, bookkeepingDir, "pane-1", "name", { provider: "codex" });
    expect(codexLaunch.cwd).toBe(bookkeepingDir);
    // No spec.cwd: byte-for-byte unchanged behaviour for every other spec.
    const noOverride: SpawnSpec = { key: "AGY-1", issuetype: "Task", summary: "s", parent: null };
    expect(agentLaunchConfig(noOverride, "/some/dir", "pane-1", "name", { provider: "claude" }).cwd).toBe("/some/dir");
  });

  test("PR #394 review fix 2, end-to-end: a spawn through buildWorkspace + agentLaunchConfig never touches pre-existing CLAUDE.md/AGENTS.md/mcp.json in the operator's own working directory, for both vendors (round 3: the guarantee holds trivially now — butchr's process never even launches there)", () => {
    const previous = process.env.BUTCHR_WORKSPACES;
    const root = mkdtempSync(join(tmpdir(), "bw-root2-"));
    process.env.BUTCHR_WORKSPACES = root;
    const real = mkdtempSync(join(tmpdir(), "bw-real-project-"));
    const ownClaudeMd = "# This project's own instructions — do not touch.\n";
    const ownAgentsMd = "# This project's own AGENTS.md — do not touch.\n";
    const ownMcpJson = JSON.stringify({ mcpServers: { "some-other-server": { type: "http", url: "https://example.test" } } });
    writeFileSync(join(real, "CLAUDE.md"), ownClaudeMd);
    writeFileSync(join(real, "AGENTS.md"), ownAgentsMd);
    writeFileSync(join(real, "mcp.json"), ownMcpJson);
    try {
      for (const provider of ["claude", "codex"] as const) {
        const key = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "managed-sessions", resourceId: `/etc/defs/${provider}.json` });
        const spec: SpawnSpec = { key, issuetype: "managed-session", summary: "s", parent: null, brief: "Do the work.", cwd: real };
        const dir = buildWorkspace(spec, "http://x/mcp", provider);
        const launch = agentLaunchConfig(spec, dir, "pane-1", "name", { provider });
        expect(launch.cwd).toBe(dir); // the process launches at the bookkeeping dir, not `real`
        expect(launch.cwd).not.toBe(real);
        expect(launch.prompt).toBe(""); // agentLaunchConfig itself never sets the kickoff — kickoffFor does, dispatched separately (herd.ts)
        // Byte-identical: the operator's own files were never opened for writing.
        expect(readFileSync(join(real, "CLAUDE.md"), "utf8")).toBe(ownClaudeMd);
        expect(readFileSync(join(real, "AGENTS.md"), "utf8")).toBe(ownAgentsMd);
        expect(readFileSync(join(real, "mcp.json"), "utf8")).toBe(ownMcpJson);
      }
    } finally {
      if (previous === undefined) delete process.env.BUTCHR_WORKSPACES;
      else process.env.BUTCHR_WORKSPACES = previous;
      rmSync(root, { recursive: true, force: true });
      rmSync(real, { recursive: true, force: true });
    }
  });

  test("BUTCHR-408 (McpServerBinding ported from S4): a bound server lands in mcp.json alongside butchr's own; headersEnvVar is resolved from THIS daemon's env, never persisted anywhere else", () => {
    const previous = process.env.BUTCHR_WORKSPACES;
    const root = mkdtempSync(join(tmpdir(), "bw-mcp-"));
    process.env.BUTCHR_WORKSPACES = root;
    const envBefore = process.env.MUD_BRIDGE_HEADERS;
    process.env.MUD_BRIDGE_HEADERS = JSON.stringify({ Authorization: "Bearer secret-token" });
    try {
      const mcpServers = [{ name: "mud-bridge", type: "http" as const, url: "https://mud.internal/mcp", headersEnvVar: "MUD_BRIDGE_HEADERS", channel: true }];
      const spec: SpawnSpec = { key: "KAN-9", issuetype: "Story", summary: "s", parent: "KAN-1", mcpServers };
      const dir = buildWorkspace(spec, "http://x/mcp");
      const mcpJsonPath = join(dir, "mcp.json");
      const mcp = JSON.parse(readFileSync(mcpJsonPath, "utf8"));
      expect(mcp.mcpServers.butchr.url).toBe("http://x/mcp");
      expect(mcp.mcpServers["mud-bridge"]).toEqual({ type: "http", url: "https://mud.internal/mcp", headers: { Authorization: "Bearer secret-token" } });
      // A resolved secret header value makes mcp.json 0600.
      const mode = require("node:fs").statSync(mcpJsonPath).mode & 0o777;
      expect(mode).toBe(0o600);
      // The persisted, staleness-check-only sidecar carries the binding's metadata (name/url/channel/headersEnvVar NAME) — never a resolved header value.
      const persisted = readFileSync(join(dir, ".butchr-mcp-servers.json"), "utf8");
      expect(persisted).not.toContain("secret-token");
      expect(JSON.parse(persisted)).toEqual(mcpServers);
      expect(workspaceMcpServers(dir)).toEqual(mcpServers);
    } finally {
      if (envBefore === undefined) delete process.env.MUD_BRIDGE_HEADERS; else process.env.MUD_BRIDGE_HEADERS = envBefore;
      if (previous === undefined) delete process.env.BUTCHR_WORKSPACES;
      else process.env.BUTCHR_WORKSPACES = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("mcp.json keeps its default permissions when no binding resolves a secret header", () => {
    const previous = process.env.BUTCHR_WORKSPACES;
    const root = mkdtempSync(join(tmpdir(), "bw-mcp-nosecret-"));
    process.env.BUTCHR_WORKSPACES = root;
    try {
      const mcpServers = [{ name: "mud-bridge", type: "http" as const, url: "https://mud.internal/mcp", channel: true }];
      const dir = buildWorkspace({ key: "KAN-9", issuetype: "Story", summary: "s", parent: null, mcpServers }, "http://x/mcp");
      const mode = require("node:fs").statSync(join(dir, "mcp.json")).mode & 0o777;
      expect(mode).not.toBe(0o600);
    } finally {
      if (previous === undefined) delete process.env.BUTCHR_WORKSPACES;
      else process.env.BUTCHR_WORKSPACES = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("workspaceMcpServers is undefined for a workspace with no bound servers, never throws", () => {
    const previous = process.env.BUTCHR_WORKSPACES;
    const root = mkdtempSync(join(tmpdir(), "bw-mcp-none-"));
    process.env.BUTCHR_WORKSPACES = root;
    try {
      const dir = buildWorkspace({ key: "KAN-9", issuetype: "Story", summary: "s", parent: null }, "http://x/mcp");
      expect(workspaceMcpServers(dir)).toBeUndefined();
      expect(workspaceMcpServers("/does/not/exist")).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.BUTCHR_WORKSPACES;
      else process.env.BUTCHR_WORKSPACES = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

  // FACTORY-43: `permissionMode`/`strictMcpConfig` are persisted at build
  // time and read back the same way `mcpServers` is above — staleIssues()
  // (src/agents/herd.ts) previously had no way to recover either field,
  // which respawn-looped every managed session launched with a non-default
  // permission mode (or strictMcpConfig) forever.
  test("workspacePermissionMode/workspaceStrictMcpConfig round-trip what buildWorkspace persisted", () => {
    const previous = process.env.BUTCHR_WORKSPACES;
    const root = mkdtempSync(join(tmpdir(), "bw-permission-"));
    process.env.BUTCHR_WORKSPACES = root;
    try {
      const dir = buildWorkspace({ key: "KAN-9", issuetype: "managed-session", summary: "s", parent: null, permissionMode: "auto", strictMcpConfig: true }, "http://x/mcp");
      expect(readFileSync(join(dir, ".butchr-permission-mode.json"), "utf8")).toBe(JSON.stringify("auto"));
      expect(readFileSync(join(dir, ".butchr-strict-mcp-config.json"), "utf8")).toBe(JSON.stringify(true));
      expect(workspacePermissionMode(dir)).toBe("auto");
      expect(workspaceStrictMcpConfig(dir)).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.BUTCHR_WORKSPACES;
      else process.env.BUTCHR_WORKSPACES = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("workspacePermissionMode/workspaceStrictMcpConfig are undefined for a workspace where neither was ever set, never throws", () => {
    const previous = process.env.BUTCHR_WORKSPACES;
    const root = mkdtempSync(join(tmpdir(), "bw-permission-none-"));
    process.env.BUTCHR_WORKSPACES = root;
    try {
      const dir = buildWorkspace({ key: "KAN-9", issuetype: "Story", summary: "s", parent: null }, "http://x/mcp");
      expect(workspacePermissionMode(dir)).toBeUndefined();
      expect(workspaceStrictMcpConfig(dir)).toBeUndefined();
      expect(workspacePermissionMode("/does/not/exist")).toBeUndefined();
      expect(workspaceStrictMcpConfig("/does/not/exist")).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.BUTCHR_WORKSPACES;
      else process.env.BUTCHR_WORKSPACES = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

  // FACTORY-75: `spec.agents[].model`/`.effort` (the two-axis mechanism's
  // resolved value for whichever provider this workspace launches under)
  // are persisted the SAME shape as `permissionMode`/`strictMcpConfig`
  // above — `HerdrHerd.staleIssues()`'s own `resolvedAgentOf` seam
  // (src/agents/herd.ts) reads them back to compare against what the
  // definition/rule CURRENTLY resolves to.
  test("workspaceModel/workspaceEffort round-trip what buildWorkspace persisted, keyed by the launch's own provider", () => {
    const previous = process.env.BUTCHR_WORKSPACES;
    const root = mkdtempSync(join(tmpdir(), "bw-model-effort-"));
    process.env.BUTCHR_WORKSPACES = root;
    try {
      const dir = buildWorkspace({ key: "KAN-9", issuetype: "managed-session", summary: "s", parent: null, agents: [{ harness: "claude", model: "fable", effort: "xhigh" }] }, "http://x/mcp", "claude");
      expect(readFileSync(join(dir, ".butchr-model.json"), "utf8")).toBe(JSON.stringify("fable"));
      expect(readFileSync(join(dir, ".butchr-effort.json"), "utf8")).toBe(JSON.stringify("xhigh"));
      expect(workspaceModel(dir)).toBe("fable");
      expect(workspaceEffort(dir)).toBe("xhigh");
    } finally {
      if (previous === undefined) delete process.env.BUTCHR_WORKSPACES;
      else process.env.BUTCHR_WORKSPACES = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("workspaceModel/workspaceEffort persist the entry matching the ACTUAL launch provider, not just spec.agents[0] — a fallback chain's other entries are ignored", () => {
    const previous = process.env.BUTCHR_WORKSPACES;
    const root = mkdtempSync(join(tmpdir(), "bw-model-effort-provider-"));
    process.env.BUTCHR_WORKSPACES = root;
    try {
      const spec: SpawnSpec = { key: "KAN-9", issuetype: "managed-session", summary: "s", parent: null, agents: [{ harness: "claude", model: "fable", effort: "xhigh" }, { harness: "codex", model: "gpt-6-astra" }] };
      const dirCodex = buildWorkspace(spec, "http://x/mcp", "codex");
      expect(workspaceModel(dirCodex)).toBe("gpt-6-astra");
      expect(workspaceEffort(dirCodex)).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.BUTCHR_WORKSPACES;
      else process.env.BUTCHR_WORKSPACES = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("workspaceModel/workspaceEffort are undefined for a workspace where neither was ever set (no spec.agents entry for this provider), never throws", () => {
    const previous = process.env.BUTCHR_WORKSPACES;
    const root = mkdtempSync(join(tmpdir(), "bw-model-effort-none-"));
    process.env.BUTCHR_WORKSPACES = root;
    try {
      const dir = buildWorkspace({ key: "KAN-9", issuetype: "Story", summary: "s", parent: null }, "http://x/mcp");
      expect(workspaceModel(dir)).toBeUndefined();
      expect(workspaceEffort(dir)).toBeUndefined();
      expect(workspaceModel("/does/not/exist")).toBeUndefined();
      expect(workspaceEffort("/does/not/exist")).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.BUTCHR_WORKSPACES;
      else process.env.BUTCHR_WORKSPACES = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

  // FACTORY-75: Codex has no `--effort`/`--reasoning` CLI flag at all
  // (`CodexAgentLaunch`, @brooswit/drovr, has no effort field) — its own
  // `model_reasoning_effort` config key is emitted into the SAME
  // per-workspace `.codex/config.toml` the freeform (jira-project) path
  // already writes `approval_policy`/`sandbox_mode` into (see
  // `codexReasoningEffortFlag`'s own doc comment, src/resources/power-scale.ts,
  // for how the config key itself was confirmed and its caveats).
  test("a codex managed-session launch with a resolved effort gets .codex/config.toml's model_reasoning_effort — a tier-based (back-compat) launch, which never resolves an effort, gets no such file at all", () => {
    const previous = process.env.BUTCHR_WORKSPACES;
    const root = mkdtempSync(join(tmpdir(), "bw-codex-effort-"));
    process.env.BUTCHR_WORKSPACES = root;
    try {
      const withEffort = buildWorkspace({ key: "KAN-10", issuetype: "managed-session", summary: "s", parent: null, agents: [{ harness: "codex", model: "gpt-6-astra", effort: "xhigh" }] }, "http://x/mcp", "codex");
      const configToml = readFileSync(join(withEffort, ".codex/config.toml"), "utf8");
      expect(configToml).toBe('model_reasoning_effort = "xhigh"\n'); // live-verified passthrough — see codexReasoningEffortFlag's own doc comment.
      const tierBased = buildWorkspace({ key: "KAN-11", issuetype: "managed-session", summary: "s", parent: null, agents: [{ harness: "codex", model: "gpt-5.6-luna" }] }, "http://x/mcp", "codex");
      expect(existsSync(join(tierBased, ".codex", "config.toml"))).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.BUTCHR_WORKSPACES;
      else process.env.BUTCHR_WORKSPACES = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("resolveMcpServerHeaders: missing/malformed headersEnvVar resolves to undefined and logs the binding+var name, never a value", () => {
    const logs: string[] = [];
    const binding = { name: "mud-bridge", type: "http" as const, url: "https://mud.internal/mcp", headersEnvVar: "MUD_BRIDGE_HEADERS", channel: true };
    const noEnvVar = { name: "mud-bridge", type: "http" as const, url: "https://mud.internal/mcp", channel: true };
    expect(resolveMcpServerHeaders(binding, {}, (l) => logs.push(l))).toBeUndefined();
    expect(resolveMcpServerHeaders(noEnvVar, { MUD_BRIDGE_HEADERS: "{}" })).toBeUndefined();
    expect(resolveMcpServerHeaders(binding, { MUD_BRIDGE_HEADERS: "not json" }, (l) => logs.push(l))).toBeUndefined();
    expect(resolveMcpServerHeaders(binding, { MUD_BRIDGE_HEADERS: JSON.stringify({ a: 1 }) }, (l) => logs.push(l))).toBeUndefined();
    expect(resolveMcpServerHeaders(binding, { MUD_BRIDGE_HEADERS: JSON.stringify({ Authorization: "Bearer x" }) })).toEqual({ Authorization: "Bearer x" });
    expect(logs.length).toBeGreaterThan(0);
    for (const l of logs) { expect(l).toContain("mud-bridge"); expect(l).toContain("MUD_BRIDGE_HEADERS"); }
  });

  test("BUTCHR-408 / Nexus MCP isolation constraint, direction 1: a managed-session agent's launched cwd never becomes the operator's own workingDirectory, and butchr never reads/writes/touches a .mcp.json there — a pre-existing one stays byte-identical (does NOT by itself prove Claude Code can't discover it; see 'PR #394 review round 2' below for the direction that guarantees the property regardless of Claude Code's own undocumented discovery behaviour)", () => {
    const previous = process.env.BUTCHR_WORKSPACES;
    const root = mkdtempSync(join(tmpdir(), "bw-nexus-"));
    const real = mkdtempSync(join(tmpdir(), "bw-nexus-real-"));
    process.env.BUTCHR_WORKSPACES = root;
    // Simulate a Bakr agent's real project directory carrying its OWN project-level
    // .mcp.json (the Claude Code auto-discovery convention — a DIFFERENT file/mechanism
    // than butchr's own explicit --mcp-config "mcp.json", no leading dot).
    const evilDotMcpJson = JSON.stringify({ mcpServers: { "evil-server": { type: "http", url: "https://not-butchr.test" } } });
    writeFileSync(join(real, ".mcp.json"), evilDotMcpJson);
    try {
      const key = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "managed-sessions", resourceId: "/etc/defs/a.json" });
      const spec: SpawnSpec = { key, issuetype: "managed-session", summary: "s", parent: null, brief: "Do the work.", cwd: real };
      const dir = buildWorkspace(spec, "http://x/mcp", "claude");
      const launch = agentLaunchConfig(spec, dir, "pane-1", "name", { provider: "claude" });
      // The launched process's OWN cwd is the bookkeeping dir, never `real` —
      // whatever Claude Code's own discovery does, it does it starting from
      // THIS directory, not from workingDirectory.
      expect(launch.cwd).toBe(dir);
      expect(launch.cwd).not.toBe(real);
      expect((launch as { mcpConfigPath: string }).mcpConfigPath).toBe(join(dir, "mcp.json"));
      // butchr never reads, writes, or otherwise touches a .mcp.json anywhere —
      // the operator's own file is byte-identical, and butchr's own config is a
      // differently-named file (no leading dot) in a different directory entirely.
      expect(readFileSync(join(real, ".mcp.json"), "utf8")).toBe(evilDotMcpJson);
      expect(existsSync(join(dir, ".mcp.json"))).toBe(false);
      const ownMcpJson = JSON.parse(readFileSync(join(dir, "mcp.json"), "utf8"));
      expect(Object.keys(ownMcpJson.mcpServers)).toEqual(["butchr"]);
    } finally {
      if (previous === undefined) delete process.env.BUTCHR_WORKSPACES;
      else process.env.BUTCHR_WORKSPACES = previous;
      rmSync(root, { recursive: true, force: true });
      rmSync(real, { recursive: true, force: true });
    }
  });

  test("PR #394 review round 2, direction 2 — the guarantee: a .mcp.json in ANY ancestor of the launched cwd (workspaceDirFor(spec.key)), not just workingDirectory, refuses the spawn outright rather than asserting Claude Code won't discover it — a managed-session agent's launched cwd is always workspaceDirFor(spec.key), which Claude's --mcp-config is additive to, not exclusive of (no --strict-mcp-config anywhere in this codebase or @brooswit/drovr)", () => {
    const previous = process.env.BUTCHR_WORKSPACES;
    const root = mkdtempSync(join(tmpdir(), "bw-nexus-ancestor-"));
    process.env.BUTCHR_WORKSPACES = root;
    // A .mcp.json two levels above workspaceRoot() itself — well outside anything
    // butchr writes to, simulating an operator's own dotfile sitting somewhere
    // up the tree (e.g. $HOME, or a parent of BUTCHR_WORKSPACES).
    const ancestorMcpJson = join(root, ".mcp.json");
    writeFileSync(ancestorMcpJson, JSON.stringify({ mcpServers: { "evil-server": { type: "http", url: "https://not-butchr.test" } } }));
    try {
      const key = encodeAgentKey({ resourceProvider: "filesystem", ruleId: "managed-sessions", resourceId: "/etc/defs/a.json" });
      const spec: SpawnSpec = { key, issuetype: "managed-session", summary: "s", parent: null, brief: "Do the work.", cwd: "/repo/some-project" };
      expect(() => buildWorkspace(spec, "http://x/mcp", "claude")).toThrow(/would inherit/);
      expect(() => buildWorkspace(spec, "http://x/mcp", "claude")).toThrow(ancestorMcpJson);
      // Nothing was written before the guard fired — refuse-before-write, not partial-then-fail.
      expect(existsSync(workspaceDirFor(key))).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.BUTCHR_WORKSPACES;
      else process.env.BUTCHR_WORKSPACES = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("assertNoInheritedMcpConfig: no ancestor .mcp.json anywhere -> no throw, even walking all the way to the filesystem root", () => {
    const previous = process.env.BUTCHR_WORKSPACES;
    const root = mkdtempSync(join(tmpdir(), "bw-nexus-clean-"));
    process.env.BUTCHR_WORKSPACES = root;
    try {
      expect(() => assertNoInheritedMcpConfig(join(root, "filesystem", "managed-sessions", "a"))).not.toThrow();
    } finally {
      if (previous === undefined) delete process.env.BUTCHR_WORKSPACES;
      else process.env.BUTCHR_WORKSPACES = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a spec WITHOUT cwd (every non-managed-session provider) is never guarded — byte-for-byte unchanged behaviour, even with a .mcp.json sitting in an ancestor", () => {
    const previous = process.env.BUTCHR_WORKSPACES;
    const root = mkdtempSync(join(tmpdir(), "bw-nexus-unguarded-"));
    process.env.BUTCHR_WORKSPACES = root;
    writeFileSync(join(root, ".mcp.json"), "{}");
    try {
      const spec: SpawnSpec = { key: "KAN-9", issuetype: "Story", summary: "s", parent: null };
      expect(() => buildWorkspace(spec, "http://x/mcp")).not.toThrow();
    } finally {
      if (previous === undefined) delete process.env.BUTCHR_WORKSPACES;
      else process.env.BUTCHR_WORKSPACES = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// BUTCHR-411: a rule can bind additional MCP servers, each landing in
// mcp.json alongside butchr's own — the channel flag itself is argv.ts's
// concern (see argv.test.ts); this is what a Claude agent's mcp.json actually
// contains.
describe("buildWorkspace — MCP server bindings (BUTCHR-411)", () => {
  const withRoot = (fn: (root: string) => void) => {
    const previous = process.env.BUTCHR_WORKSPACES;
    const root = mkdtempSync(join(tmpdir(), "bw-mcp-"));
    process.env.BUTCHR_WORKSPACES = root;
    try { fn(root); }
    finally {
      if (previous === undefined) delete process.env.BUTCHR_WORKSPACES;
      else process.env.BUTCHR_WORKSPACES = previous;
      rmSync(root, { recursive: true, force: true });
    }
  };
  const mud = { name: "mud", type: "http" as const, url: "https://mud.example/mcp", channel: true };

  test("no mcpServers -> mcp.json byte-identical to before (just butchr)", () => {
    withRoot(() => {
      const withField = buildWorkspace({ key: "KAN-20", issuetype: "Task", summary: "s", parent: null, mcpServers: [] }, "http://x/mcp");
      const withoutField = buildWorkspace({ key: "KAN-21", issuetype: "Task", summary: "s", parent: null }, "http://x/mcp");
      const a = readFileSync(join(withField, "mcp.json"), "utf8").replace(/KAN-20/g, "KAN");
      const b = readFileSync(join(withoutField, "mcp.json"), "utf8").replace(/KAN-21/g, "KAN");
      expect(a).toBe(b);
      expect(Object.keys(JSON.parse(a).mcpServers)).toEqual(["butchr"]);
    });
  });

  test("a bound server lands in mcp.json alongside butchr's own, channel:true or not", () => {
    withRoot(() => {
      const dir = buildWorkspace({ key: "KAN-22", issuetype: "Task", summary: "s", parent: null, mcpServers: [mud, { ...mud, name: "silent", channel: false }] }, "http://x/mcp");
      const mcp = JSON.parse(readFileSync(join(dir, "mcp.json"), "utf8"));
      expect(Object.keys(mcp.mcpServers).sort()).toEqual(["butchr", "mud", "silent"]);
      expect(mcp.mcpServers.mud).toEqual({ type: "http", url: "https://mud.example/mcp" });
      expect(mcp.mcpServers.silent).toEqual({ type: "http", url: "https://mud.example/mcp" });
      expect(mcp.mcpServers.butchr.url).toBe("http://x/mcp"); // butchr's own entry is unchanged by bindings
    });
  });

  test("a bound server's headersEnvVar resolves from THIS process's own env into mcp.json headers", () => {
    withRoot(() => {
      process.env.BUTCHR_TEST_WS_MUD_HEADERS = JSON.stringify({ Authorization: "Bearer t" });
      try {
        const dir = buildWorkspace({ key: "KAN-23", issuetype: "Task", summary: "s", parent: null, mcpServers: [{ ...mud, headersEnvVar: "BUTCHR_TEST_WS_MUD_HEADERS" }] }, "http://x/mcp");
        const mcp = JSON.parse(readFileSync(join(dir, "mcp.json"), "utf8"));
        expect(mcp.mcpServers.mud).toEqual({ type: "http", url: "https://mud.example/mcp", headers: { Authorization: "Bearer t" } });
      } finally { delete process.env.BUTCHR_TEST_WS_MUD_HEADERS; }
    });
  });

  test("a non-claude provider never writes mcp.json at all -- bindings must not break agy/codex launch", () => {
    withRoot(() => {
      const dir = buildWorkspace({ key: "KAN-24", issuetype: "Task", summary: "s", parent: null, mcpServers: [mud] }, "http://x/mcp", "agy");
      expect(existsSync(join(dir, "mcp.json"))).toBe(false);
    });
  });

  // Review finding, PR #387 (BLOCKING): a bound server's resolved header
  // VALUE landed in a group/other-readable mcp.json at the default umask.
  const mode = (path: string) => statSync(path).mode & 0o777;

  test("mcp.json carrying a bound server's resolved header is chmod 0600 (owner-only)", () => {
    withRoot(() => {
      process.env.BUTCHR_TEST_WS_PERM_HEADERS = JSON.stringify({ Authorization: "Bearer secret" });
      try {
        const dir = buildWorkspace({ key: "KAN-25", issuetype: "Task", summary: "s", parent: null, mcpServers: [{ ...mud, headersEnvVar: "BUTCHR_TEST_WS_PERM_HEADERS" }] }, "http://x/mcp");
        expect(mode(join(dir, "mcp.json"))).toBe(0o600);
      } finally { delete process.env.BUTCHR_TEST_WS_PERM_HEADERS; }
    });
  });

  test("a binding-less mcp.json keeps its default (unchanged) permissions — not tightened when there is no secret to protect", () => {
    withRoot(() => {
      const dir = buildWorkspace({ key: "KAN-26", issuetype: "Task", summary: "s", parent: null }, "http://x/mcp");
      const withoutBindings = mode(join(dir, "mcp.json"));
      const dir2 = buildWorkspace({ key: "KAN-27", issuetype: "Task", summary: "s", parent: null, mcpServers: [mud] }, "http://x/mcp"); // bound, but headersEnvVar unset -> no resolved header
      const withHeaderlessBinding = mode(join(dir2, "mcp.json"));
      expect(withHeaderlessBinding).toBe(withoutBindings);
      expect(withHeaderlessBinding).not.toBe(0o600); // proves this isn't just "always 0600 now"
    });
  });

  // BUTCHR-413 (CHANGES_REQUESTED review finding 1): spec.rocketchatAccount +
  // a binding's accountHeader reach Claude's mcp.json too, not just Codex's
  // argv — the SAME non-secret value on both surfaces (boundCodexServers,
  // src/agents/argv.ts, and argv.test.ts's own coverage for that half).
  test("spec.rocketchatAccount + a binding's accountHeader land in Claude's mcp.json", () => {
    withRoot(() => {
      const dir = buildWorkspace({ key: "KAN-29", issuetype: "Task", summary: "s", parent: null, mcpServers: [{ ...mud, accountHeader: "x-rocketr-account" }], rocketchatAccount: "butchr_acct_1" }, "http://x/mcp");
      const mcp = JSON.parse(readFileSync(join(dir, "mcp.json"), "utf8"));
      expect(mcp.mcpServers.mud).toEqual({ type: "http", url: "https://mud.example/mcp", headers: { "x-rocketr-account": "butchr_acct_1" } });
    });
  });

  test("an account header ALONE (no headersEnvVar) never triggers the 0600 tightening — only an actual secret does", () => {
    withRoot(() => {
      const dir = buildWorkspace({ key: "KAN-30", issuetype: "Task", summary: "s", parent: null, mcpServers: [{ ...mud, accountHeader: "x-rocketr-account" }], rocketchatAccount: "butchr_acct_1" }, "http://x/mcp");
      expect(mode(join(dir, "mcp.json"))).not.toBe(0o600);
    });
  });

  test("rebuilding an EXISTING workspace still tightens permissions on the rewrite (chmod, not just the create-time mode)", () => {
    withRoot(() => {
      const spec = { key: "KAN-28", issuetype: "Task", summary: "s", parent: null };
      const dir = buildWorkspace(spec, "http://x/mcp"); // first build: no bindings, default perms
      expect(mode(join(dir, "mcp.json"))).not.toBe(0o600);
      process.env.BUTCHR_TEST_WS_PERM_HEADERS2 = JSON.stringify({ Authorization: "Bearer secret" });
      try {
        buildWorkspace({ ...spec, mcpServers: [{ ...mud, headersEnvVar: "BUTCHR_TEST_WS_PERM_HEADERS2" }] }, "http://x/mcp"); // rebuild: now bound, with a resolved header
        expect(mode(join(dir, "mcp.json"))).toBe(0o600);
      } finally { delete process.env.BUTCHR_TEST_WS_PERM_HEADERS2; }
    });
  });

  // BUTCHR-412 (BUTCHR-391 comment 24007): the corrected Rocket.Chat
  // credential design — an agent never holds a credential; its MCP binding
  // carries only its own (non-secret) account name, via `accountHeader`.
  describe("accountHeader / spec.rocketchatAccount (BUTCHR-412)", () => {
    const rocketr = { name: "rocketr", type: "http" as const, url: "https://rocketr.internal/mcp", accountHeader: "x-rocketr-account", channel: true };

    test("spec.rocketchatAccount is injected under the binding's accountHeader name — never anywhere else", () => {
      withRoot(() => {
        const dir = buildWorkspace({ key: "KAN-30", issuetype: "Task", summary: "s", parent: null, mcpServers: [rocketr], rocketchatAccount: "butchr_jira-work-triage-kan-30_deadbeef00" }, "http://x/mcp");
        const mcp = JSON.parse(readFileSync(join(dir, "mcp.json"), "utf8"));
        expect(mcp.mcpServers.rocketr).toEqual({ type: "http", url: "https://rocketr.internal/mcp", headers: { "x-rocketr-account": "butchr_jira-work-triage-kan-30_deadbeef00" } });
        for (const f of ["CLAUDE.md", "brief.md", "ENVIRONMENT.md"]) {
          expect(readFileSync(join(dir, f), "utf8")).not.toContain("butchr_jira-work-triage-kan-30_deadbeef00");
        }
        // No token, no credential file of any kind — the account name is the ONLY thing that ever moves.
        expect(existsSync(join(dir, ".butchr-rocketchat.json"))).toBe(false);
      });
    });

    test("an account name (never secret) does NOT by itself tighten mcp.json's permissions", () => {
      withRoot(() => {
        const dir = buildWorkspace({ key: "KAN-31", issuetype: "Task", summary: "s", parent: null, mcpServers: [rocketr], rocketchatAccount: "butchr_x" }, "http://x/mcp");
        expect(mode(join(dir, "mcp.json"))).not.toBe(0o600);
      });
    });

    test("no rocketchatAccount on the spec (account policy \"none\", or ensureAccount hasn't run): the header is simply omitted", () => {
      withRoot(() => {
        const dir = buildWorkspace({ key: "KAN-32", issuetype: "Task", summary: "s", parent: null, mcpServers: [rocketr] }, "http://x/mcp");
        const mcp = JSON.parse(readFileSync(join(dir, "mcp.json"), "utf8"));
        expect(mcp.mcpServers.rocketr).toEqual({ type: "http", url: "https://rocketr.internal/mcp" });
      });
    });

    test("a binding with no accountHeader ignores spec.rocketchatAccount entirely", () => {
      withRoot(() => {
        const dir = buildWorkspace({ key: "KAN-33", issuetype: "Task", summary: "s", parent: null, mcpServers: [mud], rocketchatAccount: "butchr_x" }, "http://x/mcp");
        const mcp = JSON.parse(readFileSync(join(dir, "mcp.json"), "utf8"));
        expect(mcp.mcpServers.mud).toEqual({ type: "http", url: "https://mud.example/mcp" });
      });
    });

    test("accountHeader and headersEnvVar combine on the SAME binding — the secret one still tightens permissions, the account name doesn't need to", () => {
      withRoot(() => {
        process.env.BUTCHR_TEST_WS_ROCKETR_HEADERS = JSON.stringify({ "X-Extra": "v" });
        try {
          const dir = buildWorkspace({ key: "KAN-34", issuetype: "Task", summary: "s", parent: null, mcpServers: [{ ...rocketr, headersEnvVar: "BUTCHR_TEST_WS_ROCKETR_HEADERS" }], rocketchatAccount: "butchr_x" }, "http://x/mcp");
          const mcp = JSON.parse(readFileSync(join(dir, "mcp.json"), "utf8"));
          expect(mcp.mcpServers.rocketr).toEqual({ type: "http", url: "https://rocketr.internal/mcp", headers: { "X-Extra": "v", "x-rocketr-account": "butchr_x" } });
          expect(mode(join(dir, "mcp.json"))).toBe(0o600); // the headersEnvVar half is still treated as potentially secret
        } finally { delete process.env.BUTCHR_TEST_WS_ROCKETR_HEADERS; }
      });
    });
  });
});

describe("resolveAccountHeader (BUTCHR-412)", () => {
  const rocketr = { name: "rocketr", type: "http" as const, url: "https://rocketr.internal/mcp", accountHeader: "x-rocketr-account", channel: true };
  const mud = { name: "mud", type: "http" as const, url: "https://mud.example/mcp", channel: true };

  test("binding names accountHeader and an account is present -> resolves that one header", () => {
    expect(resolveAccountHeader(rocketr, "butchr_x")).toEqual({ "x-rocketr-account": "butchr_x" });
  });
  test("binding names accountHeader but no account (undefined) -> undefined, never an empty-string header", () => {
    expect(resolveAccountHeader(rocketr, undefined)).toBeUndefined();
  });
  test("no accountHeader on the binding -> undefined regardless of account", () => {
    expect(resolveAccountHeader(mud, "butchr_x")).toBeUndefined();
  });
});

describe("resolveMcpServerHeaders (BUTCHR-411)", () => {
  const mud = { name: "mud", type: "http" as const, url: "https://mud.example/mcp", channel: true };

  const silent = () => {}; // most cases below intentionally exercise the "resolves to nothing" log path; keep test output clean

  test("no headersEnvVar -> undefined, and the log is never called (nothing to warn about)", () => {
    const lines: string[] = [];
    expect(resolveMcpServerHeaders(mud, {}, (l) => lines.push(l))).toBeUndefined();
    expect(lines).toEqual([]);
  });
  test("headersEnvVar names an unset var -> undefined, not a throw", () => {
    expect(resolveMcpServerHeaders({ ...mud, headersEnvVar: "NOPE" }, {}, silent)).toBeUndefined();
  });
  test("a set var holding a flat string-valued JSON object resolves, and the log is never called", () => {
    const lines: string[] = [];
    expect(resolveMcpServerHeaders({ ...mud, headersEnvVar: "H" }, { H: JSON.stringify({ Authorization: "Bearer t", "X-Extra": "y" }) }, (l) => lines.push(l))).toEqual({ Authorization: "Bearer t", "X-Extra": "y" });
    expect(lines).toEqual([]);
  });
  test("malformed JSON, a non-object, or a non-string-valued object all resolve to undefined rather than throwing", () => {
    for (const raw of ["not json", "[]", "null", "42", JSON.stringify({ a: 1 }), JSON.stringify({ a: { b: "c" } })]) {
      expect(resolveMcpServerHeaders({ ...mud, headersEnvVar: "H" }, { H: raw }, silent)).toBeUndefined();
    }
  });
  // Review finding, PR #387 (non-blocking, requested): an authenticated
  // bridge whose headersEnvVar resolves to nothing must leave a trail
  // naming the binding and the env var — never the (here, secret) value.
  test("headersEnvVar set but unresolvable logs exactly one line naming the binding and env var — never the raw env value", () => {
    const lines: string[] = [];
    resolveMcpServerHeaders({ ...mud, headersEnvVar: "MUD_MCP_HEADERS" }, { MUD_MCP_HEADERS: "not-json-but-looks-like-a-SEKRET-token" }, (l) => lines.push(l));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("mud");
    expect(lines[0]).toContain("MUD_MCP_HEADERS");
    expect(lines[0]).not.toContain("SEKRET");
    expect(lines[0]).not.toContain("not-json-but-looks-like-a-SEKRET-token");
  });
  test("defaults to console.error when no log fn is given (only asserting it doesn't throw — output is incidental)", () => {
    expect(() => resolveMcpServerHeaders({ ...mud, headersEnvVar: "STILL_UNSET_VAR_XYZ" }, {})).not.toThrow();
  });
  test("defaults to process.env when no env map is given", () => {
    process.env.BUTCHR_TEST_RESOLVE_HEADERS = JSON.stringify({ A: "b" });
    try { expect(resolveMcpServerHeaders({ ...mud, headersEnvVar: "BUTCHR_TEST_RESOLVE_HEADERS" })).toEqual({ A: "b" }); }
    finally { delete process.env.BUTCHR_TEST_RESOLVE_HEADERS; }
  });
});
