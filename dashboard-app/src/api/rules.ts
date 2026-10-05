/**
 * FACTORY-661 (epic FACTORY-659, slice U1) — the ONE client module the Rules
 * page talks to. Every field/value shape below is typed against what the
 * FACTORY R1 slice (`GET /api/rules`, `GET /api/rules/:id/preview`) and
 * FACTORY-662 (`POST /api/rules/plan`) are EXPECTED to serve; none of this
 * is a guess about wire format invented here — the tri-state
 * `staffed`/`reason` pair is reused verbatim from the Configurations view's
 * own `RuleInventoryEntry` contract (`../../../src/agents/
 * query-agent-inventory.ts`, type-only import — safe at runtime, see that
 * file's own discipline and `view-model/config-inventory-availability.ts`
 * for the precedent), and `RulePlanResponse` matches FACTORY-662's own
 * `{planHash, spawned, stopped, restarted, etag}` shape named on the
 * ticket.
 *
 * TWO IMPLEMENTATIONS, same `RulesApi` interface:
 *   - `fixturesRulesApi` (built by `createFixturesRulesApi`): in-memory,
 *     simulates latency and lets a caller force failures — `capabilities.write
 *     === true`, so the Rules page's toggle/preview/plan flows are all
 *     actually exercisable against it (dev server, component tests).
 *   - `realRulesApi`: `listRules`/`previewRule` fetch the two real R1-slice
 *     GET endpoints; `planToggle` posts to FACTORY-662's own named
 *     endpoint. `capabilities.write` is hardcoded `false` — there is no
 *     real write endpoint for `applyToggle` yet ("a write endpoint from
 *     the write-path slice", not named by any ticket), so the Rules page
 *     renders the toggle disabled with a "needs the write API" tooltip
 *     whenever this is `false`, and `applyToggle` itself refuses rather
 *     than guessing a path (see its own doc comment).
 *
 * `rulesApi` picks between them on Vite's own dev/build distinction
 * (`import.meta.env.DEV`) — true under `vite dev`, false in a production
 * `vite build`, and simply absent (so `=== true` is false) under `bun test`,
 * which is why every test in this repo imports `fixturesRulesApi`/
 * `realRulesApi`/`createFixturesRulesApi` BY NAME instead of this
 * flag-selected default: a test must never depend on which bundler ran it.
 */
import type { AccountPolicy, AgentEffort, AgentHarness, AgentRole, ExecutionMode, ResourceProvider } from "../../../src/rules/rules.js";

export interface RuleAgentPreferenceDto {
  harness: AgentHarness;
  model?: string;
  effort?: AgentEffort;
}

export interface RuleDto {
  id: string;
  resourceProvider: ResourceProvider;
  query: string;
  enabled: boolean;
  /** Display-only in this slice — the count control is `execution`, not a `maxAgents` field (spec change, agentsafety review 2026-10-05: there is no `title`/`maxAgents` field). See `../../../src/rules/rules.js`'s own `ExecutionMode` doc comment for what each value means. */
  execution: ExecutionMode;
  account: AccountPolicy;
  role: AgentRole;
  /** `[]` when the rule sets no preference (uses butchr's global agent config) — same as `RuleInventoryEntry.agentPreferences`. */
  agentPreferences: RuleAgentPreferenceDto[];
  /**
   * Tri-state, reused verbatim from `RuleInventoryEntry.staffed`
   * (`../../../src/agents/query-agent-inventory.ts`): `true` staffed,
   * `false` genuinely not staffed (`reason` says why), `null` COULD NOT
   * CHECK (the agent census itself is unavailable this poll). Every reader
   * in this module compares with `=== true` / `=== false` / `=== null` —
   * never a truthiness test, which would silently collapse `null` into
   * "not staffed" (see `rules-view.ts`'s `renderStaffed`).
   */
  staffed: boolean | null;
  /** Why not staffed, or why that could not be determined; `null` iff `staffed === true`. */
  reason: string | null;
}

export interface RulesFileError {
  path: string;
  message: string;
}

export interface RulesListResponse {
  rules: RuleDto[];
  /** Every rules-file load/parse error — same shape as `QueryAgentInventory.errors`. Non-empty means the validation-problems banner renders, independent of whether `rules` is also empty. */
  errors: RulesFileError[];
}

export interface RulePreviewTicket {
  /** The ticket/resource key only (b) — agentsafety review 2026-10-05: no summary field. */
  key: string;
}

export interface RulePreviewResponse {
  ruleId: string;
  total: number;
  tickets: RulePreviewTicket[];
}

/**
 * FACTORY-662's own plan contract, named on this ticket: `POST
 * /api/rules/plan` returns `{planHash, spawned, stopped, restarted, etag}`.
 * Report-only — computing one never changes anything. The Rules page
 * requires an explicit confirm before `applyToggle` whenever `stopped > 0
 * || restarted > 0` (agentsafety review 2026-10-05, item c).
 */
export interface RulePlanResponse {
  planHash: string;
  spawned: number;
  stopped: number;
  restarted: number;
  etag: string;
}

export interface RulesApiCapabilities {
  /**
   * `true` only for `fixturesRulesApi`. `realRulesApi` has no write
   * endpoint to call yet — the Rules page reads this to render the
   * enable/disable toggle DISABLED with a "needs the write API" tooltip,
   * never by guessing at whether FACTORY R1/the write-path slice has
   * merged.
   */
  readonly write: boolean;
}

export interface RulesApi {
  readonly capabilities: RulesApiCapabilities;
  listRules(signal?: AbortSignal): Promise<RulesListResponse>;
  previewRule(ruleId: string, signal?: AbortSignal): Promise<RulePreviewResponse>;
  /** Report-only: never applies anything. */
  planToggle(ruleId: string, nextEnabled: boolean, signal?: AbortSignal): Promise<RulePlanResponse>;
  /**
   * The actual write. `plan` must be the SAME `RulePlanResponse` just
   * returned by `planToggle` for this `ruleId` — its `etag` travels as
   * `If-Match` (see `request()`'s own doc comment for why only this
   * module ever attaches that header, per agentsafety review 2026-10-05
   * item (e)).
   */
  applyToggle(ruleId: string, nextEnabled: boolean, plan: RulePlanResponse, signal?: AbortSignal): Promise<RuleDto>;
}

interface RequestOpts {
  method?: string;
  body?: unknown;
  /** Sent as `If-Match` — never guessed, always the etag a `RulePlanResponse` just carried. */
  etag?: string;
  /** Attach a CSRF token (via `fetchCsrfToken` below) — only ever `true` for a write call. */
  csrf?: boolean;
  signal?: AbortSignal | undefined;
}

/**
 * TODO SEAM (write-path slice, agentsafety review 2026-10-05 item (e)):
 * `GET /api/session` does not exist yet. Real CSRF resolution MUST go
 * through this function alone once it does — never a guessed header name,
 * never a second hand-rolled fetch beside `request()` below. Typed against
 * the shape the write-path slice is expected to serve. Not reachable from
 * today's UI: `realRulesApi.applyToggle` refuses before any write is
 * attempted (see its own doc comment), and `planToggle` is a GET-shaped
 * report-only POST the write-path slice itself does not gate behind CSRF
 * per FACTORY-662 — so this seam exists typed and tested
 * (`dashboard-app-rules-api.test.ts`) without being exercised by a real
 * network call anywhere in this slice.
 */
async function fetchCsrfToken(signal?: AbortSignal): Promise<string> {
  const res = await fetch("/api/session", signal ? { signal } : {});
  if (!res.ok) throw new Error(`/api/session: HTTP ${res.status}`);
  const body = (await res.json()) as { csrfToken: string };
  return body.csrfToken;
}

/**
 * The ONLY place `realRulesApi` attaches headers (agentsafety review
 * 2026-10-05 item (e)): `If-Match` for a caller-supplied etag, and a CSRF
 * token (via `fetchCsrfToken` above) for a `csrf: true` call. Every real
 * method below goes through this instead of calling `fetch` directly.
 */
async function request<T>(path: string, opts: RequestOpts = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.etag !== undefined) headers["if-match"] = opts.etag;
  if (opts.csrf) headers["x-csrf-token"] = await fetchCsrfToken(opts.signal);
  const res = await fetch(path, {
    method: opts.method ?? "GET",
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

/**
 * `GET /api/rules` / `GET /api/rules/:id/preview` (FACTORY R1 slice) and
 * `POST /api/rules/plan` (FACTORY-662) — real endpoints, named on tickets,
 * never invented. `applyToggle` is the one method with no named endpoint
 * to call: "a write endpoint from the write-path slice" is deliberately
 * unnamed by FACTORY-661's own ticket text ("do not invent endpoints"), so
 * it refuses rather than guessing a path. `capabilities.write` stays
 * `false` until that slice lands and this object is updated alongside it.
 */
export const realRulesApi: RulesApi = {
  capabilities: { write: false },
  listRules: (signal) => request<RulesListResponse>("/api/rules", { signal }),
  previewRule: (ruleId, signal) => request<RulePreviewResponse>(`/api/rules/${encodeURIComponent(ruleId)}/preview`, { signal }),
  planToggle: (ruleId, nextEnabled, signal) =>
    request<RulePlanResponse>("/api/rules/plan", { method: "POST", body: { ruleId, enabled: nextEnabled }, signal }),
  async applyToggle() {
    throw new Error('rules write endpoint is not available yet — needs the write-path slice (epic FACTORY-659); the Rules page keeps the toggle disabled ("needs the write API") so this should be unreachable from the UI');
  },
};

export interface FixturesRulesApiOptions {
  initial?: RulesListResponse;
  /** Simulated network latency per call, ms. Defaults to 150. Component tests pass 0. */
  latencyMs?: number;
  /** Keyed by rule id; falls back to a trivial empty preview when absent. */
  previews?: Record<string, RulePreviewResponse>;
  /** Keyed by rule id; falls back to a plan with `spawned/stopped/restarted` derived from `nextEnabled` (disabling "stops" one, enabling "spawns" one) when absent. */
  plans?: Record<string, RulePlanResponse>;
  /** When set, every call rejects with this message — simulates a fixtures-mode backend error. */
  failWith?: string;
}

function defaultPlanFor(ruleId: string, nextEnabled: boolean): RulePlanResponse {
  return {
    planHash: `${ruleId}:${nextEnabled}:1`,
    spawned: nextEnabled ? 1 : 0,
    stopped: nextEnabled ? 0 : 1,
    restarted: 0,
    etag: `fixture-etag-${ruleId}-1`,
  };
}

/**
 * Demo dataset for `bun run dev:web` — every tri-state `staffed` value, a
 * disabled rule, and more than one `resourceProvider`, so the Rules page has
 * something real to render without a live daemon.
 */
export function defaultRulesFixture(): RulesListResponse {
  return {
    rules: [
      {
        id: "factory-triage",
        resourceProvider: "jira-work",
        query: 'project = FACTORY AND status = "To Do"',
        enabled: true,
        execution: "swarm",
        account: "none",
        role: "worker",
        agentPreferences: [{ harness: "claude", model: "claude-opus-5" }],
        staffed: true,
        reason: null,
      },
      {
        id: "stale-github-prs",
        resourceProvider: "github-pr",
        query: "is:open label:needs-triage",
        enabled: false,
        execution: "swarm",
        account: "none",
        role: "worker",
        agentPreferences: [],
        staffed: false,
        reason: "disabled",
      },
      {
        id: "vip-zendesk",
        resourceProvider: "zendesk-ticket",
        query: "tags:vip status<solved",
        enabled: true,
        execution: "singleton",
        account: "none",
        role: "worker",
        agentPreferences: [{ harness: "claude", effort: "high" }],
        staffed: null,
        reason: "census unavailable: most recent agent-list poll failed",
      },
    ],
    errors: [],
  };
}

/**
 * Builds a fresh, independent in-memory `RulesApi` — a factory, not a
 * singleton, so each test/dev-server instance owns its own mutable state
 * (`applyToggle` below mutates `state.rules`, never the input `initial`
 * array in place).
 */
export function createFixturesRulesApi(opts: FixturesRulesApiOptions = {}): RulesApi {
  const latencyMs = opts.latencyMs ?? 150;
  let state: RulesListResponse = opts.initial ?? defaultRulesFixture();
  const delay = () => (latencyMs > 0 ? new Promise<void>((resolve) => setTimeout(resolve, latencyMs)) : Promise.resolve());
  const maybeFail = () => {
    if (opts.failWith) throw new Error(opts.failWith);
  };

  return {
    capabilities: { write: true },
    async listRules() {
      await delay();
      maybeFail();
      return state;
    },
    async previewRule(ruleId) {
      await delay();
      maybeFail();
      return opts.previews?.[ruleId] ?? { ruleId, total: 0, tickets: [] };
    },
    async planToggle(ruleId, nextEnabled) {
      await delay();
      maybeFail();
      return opts.plans?.[ruleId] ?? defaultPlanFor(ruleId, nextEnabled);
    },
    async applyToggle(ruleId, nextEnabled) {
      await delay();
      maybeFail();
      const rule = state.rules.find((r) => r.id === ruleId);
      if (!rule) throw new Error(`unknown rule "${ruleId}"`);
      const updated: RuleDto = { ...rule, enabled: nextEnabled };
      state = { ...state, rules: state.rules.map((r) => (r.id === ruleId ? updated : r)) };
      return updated;
    },
  };
}

export const fixturesRulesApi: RulesApi = createFixturesRulesApi();

/**
 * Build/dev flag selecting the implementation (DoD requirement 3): `vite
 * dev` sets `import.meta.env.DEV === true`, a production `vite build`
 * statically replaces it with `false`, and `bun test` sees neither (the
 * object is empty under bun, so `=== true` is false) — which is exactly
 * why every test imports `fixturesRulesApi`/`realRulesApi`/
 * `createFixturesRulesApi` directly instead of this export.
 */
const viteEnv = (import.meta as unknown as { env?: Record<string, unknown> }).env;
export const rulesApi: RulesApi = viteEnv?.["DEV"] === true ? fixturesRulesApi : realRulesApi;
