/**
 * local/ui — the Rules page's draft model
 * (`dashboard-app/src/view-model/rules-draft.ts`): pure reducer, diffs,
 * validation and the ordered save steps.
 */
import { describe, expect, test } from "bun:test";
import { PLACEHOLDER_QUERY, type RuleDto } from "../../dashboard-app/src/api/rules.js";
import { RULE_PERMISSION_MODES } from "../../src/rules/agent-harness.js";
import {
  baseDraftFor,
  briefText,
  builtinBriefName,
  DEFAULT_BRIEF,
  executionText,
  buildCreateDraft,
  buildFieldPatch,
  computeRuleChanges,
  deleteBlockedReason,
  diffRule,
  draftFromRule,
  idlePokeText,
  initialDraftState,
  isValidRuleId,
  newDraftKey,
  notifyDeliveryText,
  permissionDescription,
  permissionText,
  preferenceText,
  rulesDraftReducer,
  ruleStatus,
  summarizeDraft,
  validateRule,
  type RulesDraftAction,
  type RulesDraftState,
} from "../../dashboard-app/src/view-model/rules-draft.js";
import { supportsLinkedEvents } from "../../dashboard-app/src/view-model/rule-providers.js";

function rule(overrides: Partial<RuleDto> = {}): RuleDto {
  return {
    id: "factory-triage",
    resourceProvider: "jira-work",
    query: 'project = FACTORY AND status = "To Do"',
    enabled: false,
    execution: "swarm",
    role: "worker",
    agentPreferences: [{ harness: "claude", model: "claude-opus-5" }],
    permissionMode: null,
    lizardMode: null,
    resumeOnRespawn: null,
    resumeContextCutoff: null,
    idlePokeMinutes: null,
    idlePokeMessage: null,
    idlePokeEnabled: true,
    notifyDeliveryMode: null,
    staffed: false,
    reason: "disabled",
    ...overrides,
  };
}

function apply(state: RulesDraftState, ...actions: RulesDraftAction[]): RulesDraftState {
  return actions.reduce(rulesDraftReducer, state);
}

describe("draftFromRule", () => {
  test("maps every editable field, using empty strings for 'inherit'", () => {
    const d = draftFromRule(rule({ permissionMode: "plan", lizardMode: true, idlePokeMinutes: 30, idlePokeMessage: "wake up", idlePokeEnabled: false, agentPreferences: [{ harness: "codex", effort: "high" }] }));
    expect(d).toMatchObject({ key: "factory-triage", isNew: false, permissionMode: "plan", lizardMode: true, idlePokeMinutes: "30", idlePokeMessage: "wake up", idlePokeEnabled: false, deleted: false });
    expect(d.preference).toEqual({ harness: "codex", model: "", effort: "high" });
  });

  test("a rule with no preference slot has preference null", () => {
    expect(draftFromRule(rule({ agentPreferences: [] })).preference).toBeNull();
  });
});

describe("rulesDraftReducer", () => {
  test("edit then revert by hand leaves the rule clean (dirty is derived, not stored)", () => {
    const start = initialDraftState([rule()], "etag-1");
    const edited = apply(start, { type: "edit", key: "factory-triage", changes: { query: "project = OTHER" } });
    expect(summarizeDraft(edited).dirty).toBe(true);
    const reverted = apply(edited, { type: "edit", key: "factory-triage", changes: { query: rule().query } });
    expect(summarizeDraft(reverted).dirty).toBe(false);
  });

  test("add appends a new rule keyed draft-N; jira-project rules start as sentinel", () => {
    const s = apply(initialDraftState([rule()], "e"), { type: "add", resourceProvider: "jira-work" }, { type: "add", resourceProvider: "jira-project" });
    expect(s.rules.map((d) => d.key)).toEqual(["factory-triage", newDraftKey(1), newDraftKey(2)]);
    expect(s.rules[1]).toMatchObject({ isNew: true, id: "", enabled: false, role: "worker", idlePokeEnabled: false });
    expect(s.rules[2]?.role).toBe("sentinel");
    expect(s.nextDraftNo).toBe(3);
  });

  test("duplicate makes an off copy with a unique -copy id and default idle-poke settings", () => {
    const s = apply(
      initialDraftState([rule({ enabled: true, idlePokeMinutes: 10 }), rule({ id: "factory-triage-copy" })], "e"),
      { type: "duplicate", key: "factory-triage" },
    );
    const copy = s.rules[2]!;
    expect(copy).toMatchObject({ isNew: true, id: "factory-triage-copy-2", enabled: false, idlePokeMinutes: "", idlePokeEnabled: false, query: rule().query });
    expect(apply(s, { type: "duplicate", key: "nope" })).toBe(s);
  });

  test("remove drops a new rule but only marks a saved one; restore undoes both", () => {
    let s = apply(initialDraftState([rule()], "e"), { type: "add", resourceProvider: "github-pr" });
    s = apply(s, { type: "remove", key: newDraftKey(1) });
    expect(s.rules).toHaveLength(1);
    s = apply(s, { type: "edit", key: "factory-triage", changes: { query: "x" } }, { type: "remove", key: "factory-triage" });
    expect(s.rules[0]?.deleted).toBe(true);
    s = apply(s, { type: "restore", key: "factory-triage" });
    expect(s.rules[0]).toEqual(draftFromRule(rule()));
    expect(apply(s, { type: "remove", key: "missing" })).toBe(s);
    expect(apply(s, { type: "restore", key: "missing" })).toBe(s);
  });

  test("restore on a new rule removes it; discard-all goes back to the base", () => {
    const s = apply(initialDraftState([rule()], "e"), { type: "add", resourceProvider: "jira-work" }, { type: "edit", key: "factory-triage", changes: { lizardMode: true } });
    expect(apply(s, { type: "restore", key: newDraftKey(1) }).rules).toHaveLength(1);
    expect(apply(s, { type: "discard-all" }).rules).toEqual([draftFromRule(rule())]);
  });

  test("rebase keeps the person's edited fields and takes the server's value for the rest", () => {
    const s = apply(initialDraftState([rule()], "e1"), { type: "edit", key: "factory-triage", changes: { query: "mine" } });
    const theirs = rule({ lizardMode: true, query: rule().query });
    const rebased = apply(s, { type: "rebase", rules: [theirs], etag: "e2" });
    expect(rebased.baseEtag).toBe("e2");
    expect(rebased.rules[0]).toMatchObject({ query: "mine", lizardMode: true });
  });

  test("rebase turns created drafts into saved rules, drops deleted ones and appends rules that appeared", () => {
    let s = initialDraftState([rule(), rule({ id: "old" })], "e1");
    s = apply(s, { type: "add", resourceProvider: "jira-work" }, { type: "edit", key: newDraftKey(1), changes: { id: "brand-new", query: "q" } }, { type: "remove", key: "old" });
    s = apply(s, { type: "add", resourceProvider: "jira-work" });
    const fresh = [rule(), rule({ id: "brand-new", query: "q" }), rule({ id: "someone-elses" })];
    const rebased = apply(s, { type: "rebase", rules: fresh, etag: "e2", created: { [newDraftKey(1)]: "brand-new" } });
    expect(rebased.rules.map((d) => [d.key, d.isNew])).toEqual([
      ["factory-triage", false],
      ["brand-new", false],
      ["someone-elses", false],
      [newDraftKey(2), true],
    ]);
    expect(summarizeDraft(rebased).rows.filter((r) => r.dirty).map((r) => r.draft.key)).toEqual([newDraftKey(2)]);
  });
});

describe("validateRule / ruleStatus", () => {
  const all = (s: RulesDraftState) => s.rules;

  test("a new rule needs an id (incomplete), a valid slug and a unique id (invalid), and a query", () => {
    let s = apply(initialDraftState([rule()], "e"), { type: "add", resourceProvider: "jira-work" });
    const levels = (st: RulesDraftState) => validateRule(st.rules[1]!, undefined, all(st)).map((i) => `${i.field}:${i.level}`);
    expect(levels(s)).toEqual(["id:incomplete", "query:incomplete"]);
    s = apply(s, { type: "edit", key: newDraftKey(1), changes: { id: "Bad Id", query: "q" } });
    expect(levels(s)).toEqual(["id:invalid"]);
    s = apply(s, { type: "edit", key: newDraftKey(1), changes: { id: "factory-triage" } });
    expect(validateRule(s.rules[1]!, undefined, all(s))[0]?.message).toContain("already uses");
    s = apply(s, { type: "edit", key: newDraftKey(1), changes: { id: "fine-id" } });
    expect(levels(s)).toEqual([]);
    expect(ruleStatus(s.rules[1]!, undefined, [])).toBe("added");
  });

  test("turning on a rule still on the placeholder query is invalid", () => {
    const r = rule({ query: PLACEHOLDER_QUERY });
    const d = { ...draftFromRule(r), enabled: true };
    expect(validateRule(d, draftFromRule(r), [d])).toEqual([expect.objectContaining({ field: "query", level: "invalid" })]);
  });

  test("values the server can't clear back to 'inherit' are invalid once cleared", () => {
    const r = rule({ permissionMode: "plan", idlePokeMinutes: 30, idlePokeMessage: "wake" });
    const d = { ...draftFromRule(r), permissionMode: "" as const, idlePokeMinutes: "", idlePokeMessage: "" };
    expect(validateRule(d, draftFromRule(r), [d]).map((i) => i.field)).toEqual(["permissionMode", "idlePokeMinutes", "idlePokeMessage"]);
    expect(ruleStatus(d, draftFromRule(r), validateRule(d, draftFromRule(r), [d]))).toBe("invalid");
  });

  test("idle-poke minutes must be a positive whole number", () => {
    const d = { ...draftFromRule(rule()), idlePokeMinutes: "0" };
    expect(validateRule(d, draftFromRule(rule()), [d])[0]?.field).toBe("idlePokeMinutes");
    expect(validateRule({ ...d, idlePokeMinutes: "15" }, draftFromRule(rule()), [d])).toEqual([]);
  });

  test("deleted rules have no issues and show as deleted; untouched rules are clean", () => {
    const d = { ...draftFromRule(rule()), deleted: true, query: "" };
    expect(validateRule(d, draftFromRule(rule()), [d])).toEqual([]);
    expect(ruleStatus(d, draftFromRule(rule()), [])).toBe("deleted");
    expect(ruleStatus(draftFromRule(rule()), draftFromRule(rule()), [])).toBe("clean");
    expect(ruleStatus({ ...draftFromRule(rule()), query: "" }, draftFromRule(rule()), [{ field: "query", level: "incomplete", message: "" }])).toBe("incomplete");
  });
});

describe("diffRule and display text", () => {
  test("a saved rule lists only changed fields, with from/to text", () => {
    const base = draftFromRule(rule());
    const changes = diffRule(base, { ...base, enabled: true, preference: { harness: "claude", model: "", effort: "high" }, role: "sentinel" });
    expect(changes.map((c) => [c.label, c.from, c.to])).toEqual([
      ["Status", "Off", "On"],
      ["Agent", "claude · claude-opus-5", "claude · default model · high effort"],
      ["Fleet capacity", "counted", "not counted (sentinel)"],
    ]);
    expect(diffRule(base, { ...base, deleted: true })).toEqual([]);
  });

  test("a new rule lists what it sets", () => {
    const d = { ...draftFromRule(rule()), isNew: true };
    expect(diffRule(undefined, d).map((c) => c.label)).toEqual([
      "Id",
      "Provider",
      "Query",
      "Agent",
      "Permission mode",
      "Lizard mode",
      "Fleet capacity",
      "Execution",
      "Resume on respawn",
      "Resume context cutoff",
      "Notification delivery",
      "Stall threshold",
      "Brief",
    ]);
  });

  test("text helpers", () => {
    expect(preferenceText(null)).toBe("butchr's global agent config");
    expect(permissionText("")).toBe("butchr's default");
    // FACTORY-275: manual is Claude's other name for default; auto is a classifier, not a skip.
    expect([permissionDescription(""), permissionDescription("manual"), permissionDescription("auto")]).toEqual(["Same as acceptEdits.", "Another name for default.", "A model classifier answers each permission prompt, and can still say no."]);
    expect(RULE_PERMISSION_MODES.filter((m) => permissionDescription(m) === "")).toEqual([]);
    expect(idlePokeText({ idlePokeEnabled: false, idlePokeMinutes: "", idlePokeMessage: "" })).toBe("off");
    expect(idlePokeText({ idlePokeEnabled: true, idlePokeMinutes: "20", idlePokeMessage: "hi" })).toBe("every 20 min, custom message");
    expect(isValidRuleId("a".repeat(65))).toBe(false);
    const all = diffRule(draftFromRule(rule()), { ...draftFromRule(rule()), id: "", resourceProvider: "github-pr", query: "", lizardMode: true, idlePokeMinutes: "5", idlePokeMessage: "m", idlePokeEnabled: false, permissionMode: "auto" });
    expect(all.find((c) => c.field === "query")?.to).toBe("(empty)");
    expect(all.find((c) => c.field === "id")?.to).toBe("(no id)");
  });
});

describe("computeRuleChanges / patches", () => {
  test("orders steps: disable, delete, update, create, enable", () => {
    const s = apply(
      initialDraftState([rule({ id: "a", enabled: true }), rule({ id: "b" }), rule({ id: "c" }), rule({ id: "d" })], "e"),
      { type: "edit", key: "d", changes: { enabled: true, query: "new d" } },
      { type: "add", resourceProvider: "jira-work" },
      { type: "edit", key: newDraftKey(1), changes: { id: "e", query: "q" } },
      { type: "edit", key: "c", changes: { lizardMode: true } },
      { type: "remove", key: "b" },
      { type: "edit", key: "a", changes: { enabled: false } },
    );
    expect(computeRuleChanges(s).map((c) => `${c.kind}:${c.ruleId}`)).toEqual(["disable:a", "delete:b", "update:c", "update:d", "create:e", "enable:d"]);
  });

  test("the field patch only carries changed fields and keeps a multi-entry preference list the same length", () => {
    const base = rule({ agentPreferences: [{ harness: "claude", model: "claude-opus-5" }, { harness: "codex", effort: "low" }], idlePokeEnabled: true });
    const draft = { ...draftFromRule(base), preference: { harness: "claude" as const, model: "claude-sonnet-5", effort: "" as const }, idlePokeMinutes: "45", idlePokeMessage: "ping", idlePokeEnabled: false, permissionMode: "acceptEdits" as const };
    expect(buildFieldPatch(base, draft)).toEqual({
      permissionMode: "acceptEdits",
      idlePokeMinutes: 45,
      idlePokeMessage: "ping",
      idlePokeEnabled: false,
      agentPreferences: [{ harness: "claude", model: "claude-sonnet-5" }, { harness: "codex", effort: "low" }],
    });
    expect(buildFieldPatch(base, draftFromRule(base))).toEqual({});
  });

  test("the create body trims and only carries non-default fields", () => {
    const d = { ...draftFromRule(rule()), isNew: true, id: " new-one ", query: " q ", preference: null, lizardMode: true, role: "sentinel" as const, permissionMode: "plan" as const };
    expect(buildCreateDraft(d)).toEqual({ id: "new-one", resourceProvider: "jira-work", query: "q", permissionMode: "plan", lizardMode: true, role: "sentinel" });
    expect(buildCreateDraft({ ...d, preference: { harness: "codex", model: "", effort: "max" }, lizardMode: false, role: "worker", permissionMode: "" })).toEqual({
      id: "new-one",
      resourceProvider: "jira-work",
      query: "q",
      agentPreferences: [{ harness: "codex", effort: "max" }],
    });
  });

  test("summary counts and validity", () => {
    const s = apply(initialDraftState([rule({ id: "a" }), rule({ id: "b" })], "e"), { type: "add", resourceProvider: "jira-work" }, { type: "remove", key: "b" }, { type: "edit", key: "a", changes: { query: "x" } });
    const summary = summarizeDraft(s);
    expect([summary.added, summary.edited, summary.deleted, summary.validity]).toEqual([1, 1, 1, "incomplete"]);
    expect(baseDraftFor(s, s.rules[0]!)?.query).toBe(rule().query);
    expect(baseDraftFor(s, s.rules[2]!)).toBeUndefined();
  });

  test("deleteBlockedReason mirrors the server's refusals", () => {
    expect(deleteBlockedReason(rule({ enabled: true }))).toContain("off");
    expect(deleteBlockedReason(rule({ staffed: true }))).toContain("agents");
    expect(deleteBlockedReason(rule())).toBeNull();
    expect(deleteBlockedReason(undefined)).toBeNull();
  });
});

describe("execution, resume and brief", () => {
  test("draftFromRule maps them; a brief is null until loaded", () => {
    const d = draftFromRule(rule({ execution: "singleton", resumeOnRespawn: false, resumeContextCutoff: 40000 }));
    expect(d).toMatchObject({ execution: "singleton", resumeOnRespawn: false, resumeContextCutoff: "40000", brief: null });
    expect(draftFromRule(rule(), { "factory-triage": "@builtin:bug" }).brief).toBe("@builtin:bug");
  });

  test("brief-loaded fills the base and any draft still waiting for it, but never overwrites an edit", () => {
    let s = initialDraftState([rule()], "e");
    s = apply(s, { type: "brief-loaded", id: "factory-triage", brief: "@builtin:task" });
    expect([s.briefs["factory-triage"], s.rules[0]?.brief]).toEqual(["@builtin:task", "@builtin:task"]);
    s = apply(s, { type: "edit", key: "factory-triage", changes: { brief: "custom" } }, { type: "brief-loaded", id: "factory-triage", brief: "@builtin:task" });
    expect(s.rules[0]?.brief).toBe("custom");
    expect(summarizeDraft(s).rows[0]?.changes.map((c) => [c.label, c.from, c.to])).toEqual([["Brief", 'built-in "task"', "custom: custom"]]);
  });

  test("rebase takes briefs a save wrote as the new base, and drops a loaded brief the server's excerpt contradicts", () => {
    let s = apply(initialDraftState([rule(), rule({ id: "other" })], "e1"), { type: "brief-loaded", id: "factory-triage", brief: "@builtin:task" }, { type: "brief-loaded", id: "other", brief: "@builtin:task" });
    s = apply(s, { type: "edit", key: "factory-triage", changes: { brief: "saved text" } });
    s = apply(s, {
      type: "rebase",
      rules: [rule({ briefExcerpt: "saved text" }), rule({ id: "other", briefExcerpt: "someone else's" })],
      etag: "e2",
      briefs: { "factory-triage": "saved text" },
    });
    expect(s.briefs).toEqual({ "factory-triage": "saved text" });
    expect(s.rules.map((d) => d.brief)).toEqual(["saved text", null]);
    expect(summarizeDraft(s).dirty).toBe(false);
  });

  test("patches carry only changed fields; a cleared cutoff is sent as null; an unloaded brief is never sent", () => {
    const base = rule({ resumeContextCutoff: 9 });
    const loaded = { ...draftFromRule(base, { "factory-triage": "@builtin:task" }) };
    expect(buildFieldPatch(base, { ...loaded, execution: "persistent", resumeOnRespawn: false, resumeContextCutoff: "", brief: "@builtin:bug" }, "@builtin:task")).toEqual({
      execution: "persistent",
      resumeOnRespawn: false,
      resumeContextCutoff: null,
      brief: "@builtin:bug",
    });
    expect(buildFieldPatch(base, { ...draftFromRule(base), resumeContextCutoff: "12" })).toEqual({ resumeContextCutoff: 12 });
    expect(buildFieldPatch(base, draftFromRule(base))).toEqual({});
    const s = apply(initialDraftState([base], "e"), { type: "brief-loaded", id: "factory-triage", brief: "@builtin:task" }, { type: "edit", key: "factory-triage", changes: { brief: "x" } });
    expect(computeRuleChanges(s)).toEqual([{ kind: "update", key: "factory-triage", ruleId: "factory-triage", patch: { brief: "x" } }]);
  });

  test("new rules start from the defaults and send only what differs", () => {
    const s = apply(initialDraftState([], "e"), { type: "add", resourceProvider: "jira-work" });
    const d = s.rules[0]!;
    expect(d).toMatchObject({ brief: DEFAULT_BRIEF, execution: "swarm", resumeOnRespawn: true, resumeContextCutoff: "" });
    expect(buildCreateDraft({ ...d, id: "n", query: "q" })).toEqual({ id: "n", resourceProvider: "jira-work", query: "q" });
    expect(buildCreateDraft({ ...d, id: "n", query: "q", brief: "@builtin:bug", execution: "singleton", resumeOnRespawn: false, resumeContextCutoff: "3" })).toEqual({
      id: "n",
      resourceProvider: "jira-work",
      query: "q",
      brief: "@builtin:bug",
      execution: "singleton",
      resumeOnRespawn: false,
      resumeContextCutoff: 3,
    });
  });

  test("validation: cutoff must be a positive whole number, and a loaded brief can't be empty", () => {
    const d = { ...draftFromRule(rule()), resumeContextCutoff: "1.5", brief: "  " };
    expect(validateRule(d, draftFromRule(rule()), [d]).map((i) => `${i.field}:${i.level}`)).toEqual(["resumeContextCutoff:invalid", "brief:invalid"]);
  });

  test("duplicating copies the loaded brief; discard-all and restore keep loaded briefs", () => {
    let s = apply(initialDraftState([rule()], "e"), { type: "brief-loaded", id: "factory-triage", brief: "custom brief" });
    s = apply(s, { type: "duplicate", key: "factory-triage" });
    expect(s.rules[1]?.brief).toBe("custom brief");
    s = apply(s, { type: "edit", key: "factory-triage", changes: { brief: "changed" } }, { type: "restore", key: "factory-triage" });
    expect(s.rules[0]?.brief).toBe("custom brief");
    s = apply(s, { type: "discard-all" });
    expect(s.rules.map((r) => r.brief)).toEqual(["custom brief"]);
  });

  test("text helpers", () => {
    expect(builtinBriefName("@builtin:epic")).toBe("epic");
    expect(builtinBriefName("do it")).toBeNull();
    expect(briefText(null)).toBe("(not loaded)");
    expect(briefText("@builtin:epic")).toBe('built-in "epic"');
    expect(briefText(`${"x".repeat(70)}\nsecond`)).toBe(`custom: ${"x".repeat(60)}…`);
    expect(executionText("swarm")).toContain("one agent per matching ticket");
    expect(executionText("singleton")).toContain("whole query");
    expect(executionText("persistent")).toContain("always running");
  });
});

describe("notification delivery and stall threshold", () => {
  test("draftFromRule maps them; absent means butchr's default", () => {
    expect(draftFromRule(rule({ notifyDeliveryMode: "prompt", stalledMinutes: 25 }))).toMatchObject({ notifyDeliveryMode: "prompt", stalledMinutes: "25" });
    expect(draftFromRule(rule())).toMatchObject({ notifyDeliveryMode: "", stalledMinutes: "" });
  });

  test("patches set them, and going back to the default sends null (the server supports clearing both)", () => {
    const plain = rule();
    expect(buildFieldPatch(plain, { ...draftFromRule(plain), notifyDeliveryMode: "channel", stalledMinutes: "2.5" })).toEqual({ notifyDeliveryMode: "channel", stalledMinutes: 2.5 });
    const set = rule({ notifyDeliveryMode: "prompt", stalledMinutes: 25 });
    expect(buildFieldPatch(set, { ...draftFromRule(set), notifyDeliveryMode: "", stalledMinutes: "" })).toEqual({ notifyDeliveryMode: null, stalledMinutes: null });
    expect(buildFieldPatch(set, draftFromRule(set))).toEqual({});
  });

  test("the change list names them, and clearing either is valid", () => {
    const set = rule({ notifyDeliveryMode: "prompt", stalledMinutes: 25 });
    const d = { ...draftFromRule(set), notifyDeliveryMode: "" as const, stalledMinutes: "" };
    expect(diffRule(draftFromRule(set), d).map((c) => [c.label, c.from, c.to])).toEqual([
      ["Notification delivery", "direct prompt only", "channel, then prompt (default)"],
      ["Stall threshold", "25 min", "butchr's default"],
    ]);
    expect(validateRule(d, draftFromRule(set), [d])).toEqual([]);
  });

  test("a stall threshold must be a number above 0", () => {
    for (const bad of ["0", "-3", "soon"]) {
      const d = { ...draftFromRule(rule()), stalledMinutes: bad };
      expect(validateRule(d, draftFromRule(rule()), [d]).map((i) => `${i.field}:${i.level}`)).toEqual(["stalledMinutes:invalid"]);
    }
  });

  test("new rules start on the defaults and send them only when set", () => {
    const d = apply(initialDraftState([], "e"), { type: "add", resourceProvider: "jira-work" }).rules[0]!;
    expect(d).toMatchObject({ notifyDeliveryMode: "", stalledMinutes: "" });
    expect(buildCreateDraft({ ...d, id: "n", query: "q" })).toEqual({ id: "n", resourceProvider: "jira-work", query: "q" });
    expect(buildCreateDraft({ ...d, id: "n", query: "q", notifyDeliveryMode: "prompt", stalledMinutes: "15" })).toEqual({ id: "n", resourceProvider: "jira-work", query: "q", notifyDeliveryMode: "prompt", stalledMinutes: 15 });
  });

  test("rebase keeps a pending delivery edit and takes the server's fresh stall threshold", () => {
    let s = apply(initialDraftState([rule()], "e1"), { type: "edit", key: "factory-triage", changes: { notifyDeliveryMode: "prompt" } });
    s = apply(s, { type: "rebase", rules: [rule({ stalledMinutes: 40 })], etag: "e2" });
    expect(s.rules[0]).toMatchObject({ notifyDeliveryMode: "prompt", stalledMinutes: "40" });
  });

  test("notifyDeliveryText", () => {
    expect([notifyDeliveryText(""), notifyDeliveryText("channel"), notifyDeliveryText("prompt")]).toEqual(["channel, then prompt (default)", "channel only", "direct prompt only"]);
  });
});

describe("linked-change events", () => {
  test("draftFromRule maps them; absent means off and butchr's defaults", () => {
    expect(draftFromRule(rule({ linkedEventing: true, maxLinkedTurnsPerHour: 4, maxLinkedItems: 10, linkedRemoteLinks: true, linkedPollIntervalMs: 60000 }))).toMatchObject({
      linkedEventing: true,
      maxLinkedTurnsPerHour: "4",
      maxLinkedItems: "10",
      linkedRemoteLinks: true,
      linkedDescriptionLinks: false,
      linkedPollIntervalMs: "60000",
    });
    expect(draftFromRule(rule())).toMatchObject({ linkedEventing: false, maxLinkedTurnsPerHour: "", maxLinkedItems: "", linkedRemoteLinks: false, linkedDescriptionLinks: false, linkedPollIntervalMs: "" });
  });

  test("patches send changed switches as booleans and cleared counts as null", () => {
    const plain = rule();
    expect(buildFieldPatch(plain, { ...draftFromRule(plain), linkedEventing: true, maxLinkedTurnsPerHour: "4", linkedDescriptionLinks: true })).toEqual({
      linkedEventing: true,
      linkedDescriptionLinks: true,
      maxLinkedTurnsPerHour: 4,
    });
    const set = rule({ linkedEventing: true, maxLinkedItems: 10, linkedRemoteLinks: true });
    expect(buildFieldPatch(set, { ...draftFromRule(set), linkedEventing: false, linkedRemoteLinks: false, maxLinkedItems: "" })).toEqual({ linkedEventing: false, linkedRemoteLinks: false, maxLinkedItems: null });
    expect(buildFieldPatch(set, draftFromRule(set))).toEqual({});
  });

  test("counts must be whole numbers, 1 or more", () => {
    const d = { ...draftFromRule(rule()), linkedEventing: true, maxLinkedTurnsPerHour: "0", maxLinkedItems: "2.5", linkedPollIntervalMs: "soon" };
    expect(validateRule(d, draftFromRule(rule()), [d]).map((i) => `${i.field}:${i.level}`)).toEqual(["maxLinkedTurnsPerHour:invalid", "maxLinkedItems:invalid", "linkedPollIntervalMs:invalid"]);
  });

  test("a new rule lists them only when it turns them on, and sends only what it sets", () => {
    const d = apply(initialDraftState([], "e"), { type: "add", resourceProvider: "jira-work" }).rules[0]!;
    expect(diffRule(undefined, { ...d, id: "n" }).map((c) => c.label)).not.toContain("Linked-change events");
    const on = { ...d, id: "n", query: "q", linkedEventing: true, maxLinkedItems: "5" };
    expect(diffRule(undefined, on).map((c) => [c.label, c.to]).filter(([label]) => String(label).startsWith("Linked"))).toEqual([
      ["Linked-change events", "on"],
      ["Linked wakes per hour", "2 (default) per hour"],
      ["Linked items watched", "5"],
      ["Linked poll interval", "every poll (default)"],
    ]);
    expect(buildCreateDraft(on)).toEqual({ id: "n", resourceProvider: "jira-work", query: "q", linkedEventing: true, maxLinkedItems: 5 });
  });

  test("only jira-work and jira-project rules run them", () => {
    expect(["jira-work", "jira-project", "jira-idea", "github-pr", "filesystem"].map((p) => supportsLinkedEvents(p as RuleDto["resourceProvider"]))).toEqual([true, true, false, false, false]);
  });
});
