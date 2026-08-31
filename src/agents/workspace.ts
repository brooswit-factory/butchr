import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
// Bun embeds these at build time, so the built binary carries its briefs.
import CLAUDE_MD from "../../briefs/CLAUDE.md" with { type: "text" };
import EPIC from "../../briefs/epic.md" with { type: "text" };
import STORY from "../../briefs/story.md" with { type: "text" };
import TASK from "../../briefs/task.md" with { type: "text" };
import DEFAULT from "../../briefs/default.md" with { type: "text" };
import { deriveGroundTruth, groundTruthText } from "./ground-truth.js";

export interface SpawnSpec { key: string; issuetype: string; summary: string; parent: string | null }

export const briefFor = (issuetype: string): string =>
  ({ epic: EPIC, story: STORY, task: TASK } as Record<string, string>)[issuetype.toLowerCase()] ?? DEFAULT;

/** `groundTruth` fills `{{GROUND_TRUTH}}` (only CLAUDE.md carries that placeholder); omit it for templates that don't need it. */
export const interpolate = (template: string, spec: SpawnSpec, groundTruth?: string): string =>
  template
    .replaceAll("{{KEY}}", spec.key)
    .replaceAll("{{SUMMARY}}", spec.summary)
    .replaceAll("{{TYPE}}", spec.issuetype)
    .replaceAll("{{PARENT}}", spec.parent ?? "(none — you are top-level)")
    .replaceAll("{{GROUND_TRUTH}}", groundTruth ?? "");

/** Model per issue type: epics think hardest, tasks run fast. */
export const modelFor = (issuetype: string): string =>
  ({ epic: "opus", story: "opus", task: "sonnet" } as Record<string, string>)[issuetype.toLowerCase()] ?? "sonnet";

/** Effort per issue type: all types run high for now. */
export const effortFor = (issuetype: string): string =>
  ({ epic: "high", story: "high", task: "high" } as Record<string, string>)[issuetype.toLowerCase()] ?? "high";

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
