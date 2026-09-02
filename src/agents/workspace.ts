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
import { buildIdentity } from "./build-identity.js";
import { computeBuildCurrency } from "./build-currency.js";
import { deriveGroundTruth, groundTruthText } from "./ground-truth.js";

export interface SpawnSpec { key: string; issuetype: string; summary: string; parent: string | null }

/**
 * BUTCHR-169: every placeholder `interpolate()` is capable of substituting
 * into a workspace file — the type-level door `src/workspace/registry.ts`
 * mirrors (see that file's header for the rule this joins, and why the
 * registry lives there, not here). This array is the hand-written source of
 * truth (a closed union has to start somewhere written down), and what
 * keeps it from silently drifting from what `interpolate()` actually
 * substitutes is the OTHER direction of the tie: `interpolate()`'s own
 * substitution table (`values`, below) is typed `Record<WorkspacePlaceholder,
 * string>`, so adding a `.replaceAll`-worthy name to `values` without adding
 * it here is an excess-property error, and adding a name here without a
 * matching `values` entry fails to compile for the opposite reason (`Record`
 * requires every key). `src/workspace/registry.ts` imports this type FROM
 * here — never the reverse — so this write path never depends on the
 * registry, same "no runtime behaviour lives in the registry"
 * discipline `src/headers/registry.ts` documents for its own medium.
 */
export const WORKSPACE_PLACEHOLDERS = ["KEY", "SUMMARY", "TYPE", "PARENT", "GROUND_TRUTH"] as const;
export type WorkspacePlaceholder = (typeof WORKSPACE_PLACEHOLDERS)[number];

/**
 * Selected by `issuetype` — the SAME lookup an issue resource and a PROJECT
 * resource both go through (BUTCHR-71): an issue names its Jira issue type
 * here ("Epic"/"Story"/"Task"), and a project resource's spawn config names
 * `"project"` where an issue would name its type, so this one table serves
 * both without a second selection mechanism. Verify against BUTCHR-64's
 * spawn-config work before assuming the caller shape reaching this function
 * hasn't moved — this file only adds the `project` entry additively.
 */
export const briefFor = (issuetype: string): string =>
  ({ epic: EPIC, story: STORY, task: TASK, project: PROJECT } as Record<string, string>)[issuetype.toLowerCase()] ?? DEFAULT;

/** `groundTruth` fills `{{GROUND_TRUTH}}` (only CLAUDE.md carries that placeholder); omit it for templates that don't need it. */
export const interpolate = (template: string, spec: SpawnSpec, groundTruth?: string): string => {
  const values: Record<WorkspacePlaceholder, string> = {
    KEY: spec.key,
    SUMMARY: spec.summary,
    TYPE: spec.issuetype,
    PARENT: spec.parent ?? "(none — you are top-level)",
    GROUND_TRUTH: groundTruth ?? "",
  };
  return WORKSPACE_PLACEHOLDERS.reduce((acc, name) => acc.replaceAll(`{{${name}}}`, values[name]), template);
};

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
  const groundTruth = groundTruthText(deriveGroundTruth(mcpUrl), buildIdentity, computeBuildCurrency(buildIdentity));
  writeFileSync(join(dir, "CLAUDE.md"), interpolate(CLAUDE_MD, spec, groundTruth));
  writeFileSync(join(dir, "brief.md"), interpolate(briefFor(spec.issuetype), spec));
  writeFileSync(join(dir, "mcp.json"), JSON.stringify({ mcpServers: { butchr: { type: "http", url: mcpUrl, headers: { "x-issue": spec.key } } } }, null, 2));
  writeFileSync(join(dir, "ENVIRONMENT.md"), groundTruth);
  return dir;
}
