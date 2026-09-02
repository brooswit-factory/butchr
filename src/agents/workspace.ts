import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
// Bun embeds these at build time, so the built binary carries its briefs.
import CLAUDE_MD from "../../briefs/CLAUDE.md" with { type: "text" };
import EPIC from "../../briefs/epic.md" with { type: "text" };
import STORY from "../../briefs/story.md" with { type: "text" };
import TASK from "../../briefs/task.md" with { type: "text" };
import PROJECT from "../../briefs/project.md" with { type: "text" };
import DEFAULT from "../../briefs/default.md" with { type: "text" };
import { deriveGroundTruth, groundTruthText } from "./ground-truth.js";

export interface SpawnSpec { key: string; issuetype: string; summary: string; parent: string | null }

const BRIEF_BY_TYPE: Readonly<Record<string, string>> = { epic: EPIC, story: STORY, task: TASK, project: PROJECT };

/**
 * Selected by `issuetype` — the SAME lookup an issue resource and a PROJECT
 * resource both go through (BUTCHR-71): an issue names its Jira issue type
 * here ("Epic"/"Story"/"Task"), and a project resource's spawn config names
 * `"project"` where an issue would name its type, so this one table serves
 * both without a second selection mechanism. Verify against BUTCHR-64's
 * spawn-config work before assuming the caller shape reaching this function
 * hasn't moved — this file only adds the `project` entry additively.
 */
export const briefFor = (issuetype: string): string => BRIEF_BY_TYPE[issuetype.toLowerCase()] ?? DEFAULT;

/**
 * The issue-type keys `briefFor` maps explicitly (lowercase). Every other
 * `issuetype` falls back to `DEFAULT`, which this deliberately excludes —
 * `DEFAULT` isn't a tracked brief, it's what "nothing more specific applies"
 * looks like. Exposed so a caller (BUTCHR-149: test/unit/merge-check-guard.test.ts)
 * can derive "every brief this fleet actually ships" from this table instead
 * of hand-copying a parallel list here that goes stale the moment a type is
 * added above — which is exactly how `briefs/project.md` went uncovered.
 */
export const knownBriefTypes = (): string[] => Object.keys(BRIEF_BY_TYPE);

/** `groundTruth` fills `{{GROUND_TRUTH}}` (only CLAUDE.md carries that placeholder); omit it for templates that don't need it. */
export const interpolate = (template: string, spec: SpawnSpec, groundTruth?: string): string =>
  template
    .replaceAll("{{KEY}}", spec.key)
    .replaceAll("{{SUMMARY}}", spec.summary)
    .replaceAll("{{TYPE}}", spec.issuetype)
    .replaceAll("{{PARENT}}", spec.parent ?? "(none — you are top-level)")
    .replaceAll("{{GROUND_TRUTH}}", groundTruth ?? "");

/** Model per issue type: epics think hardest, tasks run fast. A project resource (BUTCHR-71) gets the SAME tier an epic gets, not the task default — it makes epic-level product judgment, not fast mechanical work. */
export const modelFor = (issuetype: string): string =>
  ({ epic: "opus", story: "opus", task: "sonnet", project: "opus" } as Record<string, string>)[issuetype.toLowerCase()] ?? "sonnet";

/** Effort per issue type: all types run high for now, project (BUTCHR-71) included. */
export const effortFor = (issuetype: string): string =>
  ({ epic: "high", story: "high", task: "high", project: "high" } as Record<string, string>)[issuetype.toLowerCase()] ?? "high";

export const workspaceRoot = (): string => process.env.BUTCHR_WORKSPACES ?? join(homedir(), "butchr-workspaces");

/**
 * Create the agent's workspace: CLAUDE.md (generic pointer, interpolated so
 * it can carry ground truth), brief.md (type-specific, interpolated),
 * mcp.json (connects back to butchr, identifying the issue), and
 * ENVIRONMENT.md (the same ground truth, standalone). Returns the
 * directory — the agent's cwd.
 */
export function buildWorkspace(spec: SpawnSpec, mcpUrl: string): string {
  const dir = join(workspaceRoot(), spec.key);
  mkdirSync(dir, { recursive: true });
  const groundTruth = groundTruthText(deriveGroundTruth(mcpUrl));
  writeFileSync(join(dir, "CLAUDE.md"), interpolate(CLAUDE_MD, spec, groundTruth));
  writeFileSync(join(dir, "brief.md"), interpolate(briefFor(spec.issuetype), spec));
  writeFileSync(join(dir, "mcp.json"), JSON.stringify({ mcpServers: { butchr: { type: "http", url: mcpUrl, headers: { "x-issue": spec.key } } } }, null, 2));
  writeFileSync(join(dir, "ENVIRONMENT.md"), groundTruth);
  return dir;
}
