import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { encodeAgentKey } from "../../src/rules/agent-key.js";
import { parseRules, type Rule } from "../../src/rules/rules.js";
import { createGithubIssueEventRules, type GithubIssueMatch } from "../../src/rules/github-issue-type.js";
import { parseGithubIssueRef } from "../../src/resources/github-issue-ref.js";
import type { GithubIssue } from "../../src/resources/github-issue.js";

/**
 * FACTORY-865/FACTORY-866 (ticket scope item H): "every provider" from
 * FACTORY-864's own text is vacuous for three of four — butchr's agent:*/pr:*
 * label sync writes through a Jira-only writer (SyncDeps.jira,
 * src/labels/sync.ts), so those labels exist ONLY on Jira issues; GitHub
 * label changes are a human/external act and MUST keep firing; Zendesk and
 * filesystem resources have no label dimension at all. This file PINS that
 * conclusion rather than leaving it inherited on trust, per FACTORY-865's
 * own instruction: "add an assertion or a documented test that fails if an
 * agent:* label ever becomes writable on a non-Jira provider, or if the
 * GitHub label-change path stops firing."
 *
 * What would make each half of this file FAIL, stated up front:
 * - The SyncDeps test fails the moment a second label-writing dependency
 *   (github/zendesk/filesystem) is added to SyncDeps in src/labels/sync.ts,
 *   which is exactly the change that would make an agent:*/pr:* label
 *   writable on a non-Jira provider.
 * - The GitHub test fails if `createGithubIssueEventRules`' own label-change
 *   detection stops firing — e.g. if a future change folded GitHub's own
 *   `labels` field into some daemon-label-only suppression analogous to
 *   Jira's, which this ticket's fix must never do (GitHub has no such
 *   concept and butchr never writes a GitHub label).
 */

describe("FACTORY-865 scope pin: SyncDeps is a Jira-only label writer", () => {
  test("src/labels/sync.ts declares exactly one label-writing dependency (`jira: LabelWriter`) on SyncDeps", () => {
    const src = readFileSync(join(import.meta.dir, "../../src/labels/sync.ts"), "utf8");
    const ifaceMatch = /export interface SyncDeps \{([\s\S]*?)\n\}/.exec(src);
    expect(ifaceMatch).not.toBeNull();
    const body = ifaceMatch![1]!;
    // Every LabelWriter-typed field on this interface — today, and if this
    // count ever becomes 2, the scope claim above is false and this must fail.
    const writerFields = [...body.matchAll(/^\s*(\w+)(?:\?)?:\s*LabelWriter\s*;/gm)].map((m) => m[1]);
    expect(writerFields).toEqual(["jira"]);
  });
});

describe("FACTORY-865 scope pin: the GitHub issue label-change path still fires (unaffected by this ticket's Jira-only fix)", () => {
  const rule: Rule = parseRules({ rules: [{ id: "bugs", resourceProvider: "github-issue", query: "type:Bug", brief: "fix it" }] })[0]!;
  const gi = (ref: string, over: Partial<GithubIssue> = {}): GithubIssue => {
    const r = parseGithubIssueRef(ref)!;
    return { ref, owner: r.owner, repo: r.repo, number: r.number, title: `title ${ref}`, body: "body", state: "open", stateReason: null, issueType: "Bug", labels: [], comments: 0, updated: "2026-09-16T00:00:00Z", url: `https://github.com/${r.owner}/${r.repo}/issues/${r.number}`, ...over };
  };
  const match = (ref: string, over: Partial<GithubIssue> = {}): GithubIssueMatch =>
    ({ agentKey: encodeAgentKey({ resourceProvider: "github-issue", ruleId: "bugs", resourceId: ref }), rule, issue: gi(ref, over) });

  test("a GitHub label change alone still delivers (deliver: true, no reason) — this ticket never touches github-issue-type.ts", async () => {
    const rules = createGithubIssueEventRules({});
    const snap = (...m: GithubIssueMatch[]) => ({ primary: m.map((mm) => ({ kind: "resource" as const, match: mm })), related: [] });
    const before = match("acme/w#1");
    const after = match("acme/w#1", { labels: ["p1"], updated: "later" });
    const poll = await rules.poll(snap(before), snap(after));
    expect(poll.changedPrimary).toEqual([before.agentKey]);
    const verdict = await poll.decide(poll.changedPrimary[0]!, poll.changedPrimary[0]!, "primary");
    expect(verdict.deliver).toBe(true);
  });
});
