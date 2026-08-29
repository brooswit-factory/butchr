import { readFileSync } from "node:fs";
import { loadConfig, type Config, type ConfigEnv } from "../src/config/config.js";
import type { FetchLike } from "../src/atlassian/client.js";

/** A single issue link as seen from the OWNING issue's own fields.issuelinks row. */
export interface MigrateLink {
  id: string;
  type: string; // e.g. "Implements", "Relates", "Blocks"
  direction: "inward" | "outward";
  key: string; // the OTHER issue's key
}

export interface MigrateIssue {
  key: string;
  issuetype: string; // "Epic" | "Story" | "Task" | ...
  statusCategory: string; // Jira's status.statusCategory.name, e.g. "Done"
  parent: string | null; // Jira parent field (an epic, for stories and tasks alike)
  summary: string;
  issuelinks: MigrateLink[];
}

export interface AddAction { ticket: string; action: "add-implements"; otherEnd: string; reason: string }
export interface DeleteAction { ticket: string; action: "delete-relates"; otherEnd: string; linkId: string; reason: string }
export interface DeleteBackwardsImplementsAction { ticket: string; action: "delete-backwards-implements"; otherEnd: string; linkId: string; reason: string }
export type Action = AddAction | DeleteAction | DeleteBackwardsImplementsAction;
export interface Unresolved { ticket: string; reason: string }
export interface Plan { actions: Action[]; unresolved: Unresolved[] }

/** Epic > Story > Task. An Implements link is valid only when the implementer's level is strictly lower than the boss's. */
const LEVEL: Record<string, number> = { Epic: 2, Story: 1, Task: 0 };

const SUMMARY_PREFIX = /^\[(KAN-\d+)\]/;

/**
 * An Implements link is direction-correct on the IMPLEMENTER's own issuelinks
 * when it shows as "inward" (the boss appears via inwardIssue — see the
 * direction contract: creation sets outwardIssue=implementer,
 * inwardIssue=boss, and an issue's own issuelinks row surfaces the OTHER end
 * labeled by that end's role). The reverse ("outward" with the boss's key)
 * means the link was created backwards and must not count.
 */
const implementsBoss = (issue: MigrateIssue, bossKey: string): boolean =>
  issue.issuelinks.some((l) => l.type === "Implements" && l.direction === "inward" && l.key === bossKey);

const relatesTo = (issue: MigrateIssue, otherKey: string): MigrateLink | undefined =>
  issue.issuelinks.find((l) => l.type === "Relates" && l.key === otherKey);

/**
 * Translates one Implements link entry, as seen from `owner`'s own
 * issuelinks row, into the (implementer, boss) pair it records — regardless
 * of which end we're reading from. direction "outward" means the OTHER end
 * is the implementer; "inward" means the OTHER end is the boss (same
 * convention as implementsBoss above).
 */
const recordedRoles = (owner: MigrateIssue, link: MigrateLink): { implementerKey: string; bossKey: string } =>
  link.direction === "outward" ? { implementerKey: link.key, bossKey: owner.key } : { implementerKey: owner.key, bossKey: link.key };

/**
 * Finds Implements links whose recorded implementer sits at the same or a
 * higher hierarchy level than its recorded boss (Task->Story is valid;
 * Epic->Story is not — see LEVEL). A backwards link is planned for deletion
 * only when a correct-direction Implements link between the SAME two
 * tickets already exists; otherwise it is reported unresolved, since
 * deleting it would strand the only wake path between the two tickets.
 * Iterates ALL issues, Done included: a backwards link is never a valid
 * wake path regardless of either endpoint's status, so cleaning it up must
 * not depend on when the operator happens to run --apply relative to when
 * its endpoints close. `byKeyAll` is used both to resolve levels and to
 * look up the counterpart.
 */
function planBackwardsImplements(allIssues: MigrateIssue[], byKeyAll: Map<string, MigrateIssue>): { actions: DeleteBackwardsImplementsAction[]; unresolved: Unresolved[] } {
  const actions: DeleteBackwardsImplementsAction[] = [];
  const unresolved: Unresolved[] = [];
  const seen = new Set<string>(); // link id — a link between two issues appears on both ends' issuelinks

  for (const owner of allIssues) {
    for (const l of owner.issuelinks) {
      if (l.type !== "Implements" || seen.has(l.id)) continue;
      const { implementerKey, bossKey } = recordedRoles(owner, l);
      const implementer = byKeyAll.get(implementerKey);
      const boss = byKeyAll.get(bossKey);
      const implementerLevel = implementer ? LEVEL[implementer.issuetype] : undefined;
      const bossLevel = boss ? LEVEL[boss.issuetype] : undefined;

      if (implementerLevel === undefined || bossLevel === undefined) {
        seen.add(l.id);
        unresolved.push({ ticket: owner.key, reason: `cannot resolve hierarchy level of ${implementerLevel === undefined ? implementerKey : bossKey}: not present in fetched issue set` });
        continue;
      }
      if (implementerLevel < bossLevel) continue; // correctly directed — leave untouched

      seen.add(l.id);
      // the REAL implementer is whichever ticket is actually strictly lower — bossKey here; look for it implementing implementerKey
      const hasCorrectCounterpart = implementsBoss(byKeyAll.get(bossKey)!, implementerKey);
      if (!hasCorrectCounterpart) {
        unresolved.push({ ticket: owner.key, reason: "backwards Implements link without a correct counterpart" });
        continue;
      }
      actions.push({
        ticket: implementerKey,
        action: "delete-backwards-implements",
        otherEnd: bossKey,
        linkId: l.id,
        reason: `${implementerKey} (${implementer!.issuetype}) is recorded as implementing ${bossKey} (${boss!.issuetype}) — backwards; a correct-direction Implements link exists between the same two tickets`,
      });
    }
  }

  return { actions, unresolved };
}

/** Resolve a task's owning story: existing Implements > Relates > "[KAN-nnn]" summary fallback. */
function resolveOwningStory(task: MigrateIssue, byKey: Map<string, MigrateIssue>): { storyKey: string; viaSummary: boolean } | null {
  for (const l of task.issuelinks) {
    if (l.type === "Implements" && l.direction === "inward" && byKey.get(l.key)?.issuetype === "Story") {
      return { storyKey: l.key, viaSummary: false };
    }
  }
  for (const l of task.issuelinks) {
    if (l.type === "Relates" && byKey.get(l.key)?.issuetype === "Story") {
      return { storyKey: l.key, viaSummary: false };
    }
  }
  const m = SUMMARY_PREFIX.exec(task.summary);
  if (m && byKey.get(m[1]!)?.issuetype === "Story") return { storyKey: m[1]!, viaSummary: true };
  return null;
}

/**
 * Pure plan computation. Takes the full set of fetched issues (any
 * statusCategory) and returns the actions to add missing story/task
 * Implements links plus the redundant task<->story Relates links to delete
 * once their Implements replacement exists, and any tasks whose owning story
 * could not be resolved. No fetch, no env, no process.exit.
 */
export function computePlan(allIssues: MigrateIssue[]): Plan {
  const issues = allIssues.filter((i) => i.statusCategory !== "Done");
  const byKey = new Map(issues.map((i) => [i.key, i]));
  const byKeyAll = new Map(allIssues.map((i) => [i.key, i]));
  const actions: Action[] = [];
  const unresolved: Unresolved[] = [];

  for (const story of issues.filter((i) => i.issuetype === "Story")) {
    if (!story.parent) continue;
    if (!implementsBoss(story, story.parent)) {
      actions.push({ ticket: story.key, action: "add-implements", otherEnd: story.parent, reason: `story implements its parent epic ${story.parent}` });
    }
  }

  for (const task of issues.filter((i) => i.issuetype === "Task")) {
    const resolution = resolveOwningStory(task, byKey);
    if (!resolution) {
      unresolved.push({ ticket: task.key, reason: "no Implements link, no Relates link, and no \"[KAN-nnn]\" summary prefix names an open Story" });
      continue;
    }
    const { storyKey, viaSummary } = resolution;
    const already = implementsBoss(task, storyKey);
    if (!already) {
      actions.push({
        ticket: task.key,
        action: "add-implements",
        otherEnd: storyKey,
        reason: viaSummary ? `owning story resolved from the "[${storyKey}]" summary prefix` : `task implements its owning story ${storyKey}`,
      });
    }
    const relates = relatesTo(task, storyKey);
    if (relates) {
      actions.push({
        ticket: task.key,
        action: "delete-relates",
        otherEnd: storyKey,
        linkId: relates.id,
        reason: already ? `Implements link to ${storyKey} already exists; redundant Relates link removed` : `Implements link to ${storyKey} added above; redundant Relates link removed`,
      });
    }
  }

  const backwards = planBackwardsImplements(allIssues, byKeyAll);
  actions.push(...backwards.actions);
  unresolved.push(...backwards.unresolved);

  return { actions, unresolved };
}

/** "plan is empty" line is always printed so a crash is distinguishable from success. */
export function summarize(plan: Plan): string {
  const adds = plan.actions.filter((a) => a.action === "add-implements").length;
  const dels = plan.actions.filter((a) => a.action === "delete-relates").length;
  const backDels = plan.actions.filter((a) => a.action === "delete-backwards-implements").length;
  if (adds === 0 && dels === 0 && backDels === 0 && plan.unresolved.length === 0) return "plan is empty — nothing to migrate";
  const parts = [`${adds} add-implements`, `${dels} delete-relates`];
  if (backDels > 0) parts.push(`${backDels} delete-backwards-implements`);
  parts.push(`${plan.unresolved.length} unresolved`);
  return `plan: ${parts.join(", ")}`;
}

export function formatTable(plan: Plan): string {
  const rows: string[][] = [["ticket", "action", "other end", "link id", "reason"]];
  for (const a of plan.actions) rows.push([a.ticket, a.action, a.otherEnd, a.action === "delete-relates" || a.action === "delete-backwards-implements" ? a.linkId : "-", a.reason]);
  for (const u of plan.unresolved) rows.push([u.ticket, "unresolved", "-", "-", u.reason]);
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
  return rows.map((r) => r.map((c, i) => c.padEnd(widths[i]!)).join("  ")).join("\n");
}

const basicAuth = (cfg: Config) => "Basic " + Buffer.from(`${cfg.atlassian.email}:${cfg.atlassian.token}`).toString("base64");

function mapIssue(raw: any): MigrateIssue {
  const f = raw.fields ?? {};
  const issuelinks: MigrateLink[] = [];
  for (const l of f.issuelinks ?? []) {
    const type = l.type?.name ?? "";
    if (l.outwardIssue) issuelinks.push({ id: String(l.id), type, direction: "outward", key: l.outwardIssue.key });
    else if (l.inwardIssue) issuelinks.push({ id: String(l.id), type, direction: "inward", key: l.inwardIssue.key });
  }
  return {
    key: raw.key,
    issuetype: f.issuetype?.name ?? "",
    statusCategory: f.status?.statusCategory?.name ?? "",
    parent: f.parent?.key ?? null,
    summary: f.summary ?? "",
    issuelinks,
  };
}

/**
 * Fetches every KAN issue (Done included — a backwards Implements link's
 * other end may be Done, and its level must still be resolvable) with the
 * fields the plan needs, paginating via nextPageToken until exhausted.
 * computePlan() is responsible for filtering Done issues out of the set it
 * iterates while still resolving levels from the full set. client.ts's
 * search() hardcodes a different fields list and its links() drops link IDs
 * (needed to delete), so this is its own small typed helper rather than a
 * bent reuse of the client.
 */
export async function fetchAllIssues(cfg: Config, fetchImpl: FetchLike): Promise<MigrateIssue[]> {
  const auth = basicAuth(cfg);
  const issues: MigrateIssue[] = [];
  let nextPageToken: string | undefined;
  do {
    const params = new URLSearchParams({
      jql: "project = KAN",
      fields: "issuetype,parent,status,summary,issuelinks",
      maxResults: "100",
    });
    if (nextPageToken) params.set("nextPageToken", nextPageToken);
    const res = await fetchImpl(`${cfg.atlassian.site}/rest/api/3/search/jql?${params}`, {
      headers: { authorization: auth, accept: "application/json" },
    });
    if (!res.ok) throw new Error(`Atlassian ${res.status} on search: ${(await res.text()).slice(0, 200)}`);
    const body: any = await res.json();
    for (const raw of body.issues ?? []) issues.push(mapIssue(raw));
    nextPageToken = body.nextPageToken || undefined;
  } while (nextPageToken);
  return issues;
}

export interface ApplyOutcome { ticket: string; action: Action["action"]; otherEnd: string; ok: boolean; error?: string }

async function createImplements(site: string, auth: string, fetchImpl: FetchLike, implementer: string, boss: string): Promise<void> {
  const res = await fetchImpl(`${site}/rest/api/3/issueLink`, {
    method: "POST",
    headers: { authorization: auth, "content-type": "application/json" },
    body: JSON.stringify({ type: { name: "Implements" }, outwardIssue: { key: implementer }, inwardIssue: { key: boss } }),
  });
  if (!res.ok) throw new Error(`Atlassian ${res.status} creating Implements ${implementer}->${boss}: ${(await res.text()).slice(0, 200)}`);
}

async function deleteLink(site: string, auth: string, fetchImpl: FetchLike, linkId: string): Promise<void> {
  const res = await fetchImpl(`${site}/rest/api/3/issueLink/${linkId}`, { method: "DELETE", headers: { authorization: auth } });
  if (!res.ok) throw new Error(`Atlassian ${res.status} deleting link ${linkId}: ${(await res.text()).slice(0, 200)}`);
}

/**
 * Executes a plan: every add-implements before any delete (delete-relates or
 * delete-backwards-implements). If an add fails, the delete-relates that
 * depended on it (matched by ticket+otherEnd) is skipped and reported rather
 * than stranding the ticket with neither link. A delete-backwards-implements
 * never depends on an add, so failedAdds never suppresses it.
 */
export async function applyPlan(plan: Plan, cfg: Config, fetchImpl: FetchLike): Promise<ApplyOutcome[]> {
  const auth = basicAuth(cfg);
  const outcomes: ApplyOutcome[] = [];
  const failedAdds = new Set<string>();

  for (const a of plan.actions) {
    if (a.action !== "add-implements") continue;
    try {
      await createImplements(cfg.atlassian.site, auth, fetchImpl, a.ticket, a.otherEnd);
      outcomes.push({ ticket: a.ticket, action: a.action, otherEnd: a.otherEnd, ok: true });
    } catch (err) {
      failedAdds.add(`${a.ticket}->${a.otherEnd}`);
      outcomes.push({ ticket: a.ticket, action: a.action, otherEnd: a.otherEnd, ok: false, error: (err as Error).message });
    }
  }

  for (const d of plan.actions) {
    if (d.action !== "delete-relates" && d.action !== "delete-backwards-implements") continue;
    if (d.action === "delete-relates" && failedAdds.has(`${d.ticket}->${d.otherEnd}`)) {
      outcomes.push({ ticket: d.ticket, action: d.action, otherEnd: d.otherEnd, ok: false, error: `skipped — Implements add to ${d.otherEnd} failed` });
      continue;
    }
    try {
      await deleteLink(cfg.atlassian.site, auth, fetchImpl, d.linkId);
      outcomes.push({ ticket: d.ticket, action: d.action, otherEnd: d.otherEnd, ok: true });
    } catch (err) {
      outcomes.push({ ticket: d.ticket, action: d.action, otherEnd: d.otherEnd, ok: false, error: (err as Error).message });
    }
  }

  return outcomes;
}

async function main(): Promise<void> {
  const apply = process.argv.slice(2).includes("--apply");
  console.log(apply ? "=== APPLY MODE — this WILL modify Jira ===" : "=== DRY RUN (default) — no changes will be made; pass --apply to execute ===");

  const cfg = loadConfig(process.env as ConfigEnv, (p) => readFileSync(p, "utf8"));
  const issues = await fetchAllIssues(cfg, globalThis.fetch as FetchLike);
  const plan = computePlan(issues);

  console.log(formatTable(plan));
  console.log(summarize(plan));

  if (!apply) return;
  const outcomes = await applyPlan(plan, cfg, globalThis.fetch as FetchLike);
  for (const o of outcomes) console.log(`  ${o.ok ? "✓" : "✗"} ${o.action} ${o.ticket} -> ${o.otherEnd}${o.error ? `: ${o.error}` : ""}`);
  if (outcomes.some((o) => !o.ok)) process.exitCode = 1;
}

if (import.meta.main) await main();
