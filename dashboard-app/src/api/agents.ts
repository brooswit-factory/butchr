/**
 * FACTORY-666 — the dashboard's agent-control panel client: start, stop,
 * shelve, adopt and prioritize a fleet worker ticket against the
 * `/api/agents/:issue/*` routes (`src/web/view.ts`). Same CSRF/error-
 * mapping idiom every other API client module in this directory already
 * owns independently (`./settings.ts`, `./rules.ts`) — no shared `request()`
 * helper exists in this codebase to reuse, so this module duplicates the
 * same small pattern rather than inventing a different one.
 */

export interface AgentSnapshot {
  key: string;
  status: string | null;
  summary: string | null;
  labels: string[];
  /** The worker's current boss key (Implements link, or an eligible Jira parent), or `null` if it has none yet — an action needing one derives it server-side from this SAME resolution; `null` here means `start`/`shelve`/`prioritize` will all refuse until `adopt` gives it a boss. */
  boss: string | null;
  /** Whether this daemon's own herd currently has a live agent process for this issue. */
  running: boolean;
  pane: string | null;
}

/** The structured, 200-status dry-run preview for a destructive action (`stop`/`shelve`) — never parsed out of an error body. */
export interface AgentActionPlan {
  requiresConfirm: true;
  confirmReason: "agent-stop" | "agent-shelve";
  preview: Record<string, unknown>;
}

export type AgentActionResult = AgentActionPlan | { requiresConfirm?: undefined; [key: string]: unknown };

export interface AdoptAgentInput {
  bossKey: string;
  disposition: "start" | "shelve";
  reason?: string;
}

export interface AgentsApi {
  getSnapshot(issue: string, signal?: AbortSignal): Promise<AgentSnapshot>;
  start(issue: string, signal?: AbortSignal): Promise<AgentActionResult>;
  /** `confirm: false` (the ordinary first call) returns the dry-run `AgentActionPlan`; `confirm: true` performs the real stop. Same single-route two-call dance `createRule` (`./rules.ts`) already uses for its own combined plan-then-confirm route. */
  stop(issue: string, confirm: boolean, signal?: AbortSignal): Promise<AgentActionResult>;
  shelve(issue: string, reason: string, confirm: boolean, signal?: AbortSignal): Promise<AgentActionResult>;
  adopt(issue: string, input: AdoptAgentInput, signal?: AbortSignal): Promise<AgentActionResult>;
  prioritize(issue: string, priority: string, signal?: AbortSignal): Promise<AgentActionResult>;
}

const CSRF_HEADER = "x-butchr-csrf";

async function fetchCsrfToken(signal?: AbortSignal): Promise<string> {
  const res = await fetch("/api/session", signal ? { signal } : {});
  if (!res.ok) throw new Error(`/api/session: HTTP ${res.status}`);
  const body = (await res.json()) as { csrfToken: string };
  return body.csrfToken;
}

/** `res.json().error`, or a generic `<label>: HTTP <status>` when the body isn't the expected `{error: string}` shape — the exact text an operator sees, per this ticket's AC4 ("refusals reach the UI verbatim"). */
async function errorMessageOf(res: Response, label: string): Promise<string> {
  try {
    const body: unknown = await res.json();
    if (body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string") return (body as { error: string }).error;
  } catch { /* non-JSON error body: fall through to the generic message */ }
  return `${label}: HTTP ${res.status}`;
}

async function postJson(path: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
  const csrfToken = await fetchCsrfToken(signal);
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", [CSRF_HEADER]: csrfToken },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) throw new Error(await errorMessageOf(res, path));
  return res.json();
}

export const realAgentsApi: AgentsApi = {
  async getSnapshot(issue, signal) {
    const res = await fetch(`/api/agents/${encodeURIComponent(issue)}`, signal ? { signal } : {});
    if (!res.ok) throw new Error(await errorMessageOf(res, `/api/agents/${issue}`));
    return (await res.json()) as AgentSnapshot;
  },
  start: (issue, signal) => postJson(`/api/agents/${encodeURIComponent(issue)}/start`, {}, signal) as Promise<AgentActionResult>,
  stop: (issue, confirm, signal) => postJson(`/api/agents/${encodeURIComponent(issue)}/stop`, { confirm }, signal) as Promise<AgentActionResult>,
  shelve: (issue, reason, confirm, signal) => postJson(`/api/agents/${encodeURIComponent(issue)}/shelve`, { reason, confirm }, signal) as Promise<AgentActionResult>,
  adopt: (issue, input, signal) => postJson(`/api/agents/${encodeURIComponent(issue)}/adopt`, input, signal) as Promise<AgentActionResult>,
  prioritize: (issue, priority, signal) => postJson(`/api/agents/${encodeURIComponent(issue)}/prioritize`, { priority }, signal) as Promise<AgentActionResult>,
};
