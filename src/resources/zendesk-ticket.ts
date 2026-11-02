/**
 * The `zendesk-ticket` resource provider's Zendesk side: OAuth token loading,
 * rule-query validation, and a REST client for tickets and their comments.
 *
 * Auth is an OAuth access token ONLY, sent as `Authorization: Bearer`. The
 * token is read from `ZENDESK_OAUTH_TOKEN_FILE`, which must be a regular file
 * owned by the daemon's user (or root) with no group or other permissions.
 * Zendesk's email/API-token basic auth is not supported: if `ZENDESK_EMAIL`
 * or `ZENDESK_API_TOKEN` is set, Zendesk staffing refuses to start rather
 * than leave an operator guessing which credential is in use. Every request
 * refuses redirects, so the token is only ever sent to
 * `https://<ZENDESK_SUBDOMAIN>.zendesk.com`.
 *
 * The ONE write is `addInternalNote`: a ticket comment with `public: false`,
 * hard-coded here and not a parameter anywhere, landing only on a ticket it
 * has just re-read inside the configured subdomain. Zendesk's own audit of
 * the update is checked, and a comment it recorded as public is reported
 * loudly as an error. Nothing here replies to a requester, changes status,
 * assigns, tags, or creates anything.
 *
 * Every search adds `type:ticket`; queries naming `type:` themselves, or using
 * boolean operators or parentheses, are rejected at rule-load time, and any
 * result that is not a ticket is dropped regardless.
 */
import { readFileSync, statSync } from "node:fs";
import type { FetchLike } from "../labels/pr.js";
import { formatZendeskTicketRef, isZendeskSubdomain, type ZendeskTicketRef } from "./zendesk-ticket-ref.js";

export interface ZendeskTicket {
  /** Canonical `<subdomain>#<id>` — the resource id. */
  ref: string;
  id: number;
  subject: string;
  /** The ticket's first comment, as Zendesk keeps it on the ticket. */
  description: string;
  status: string;
  priority: string | null;
  /** `question`, `incident`, `problem`, `task`, or null when unset. */
  ticketType: string | null;
  tags: string[];
  updated: string;
  /** The agent-interface URL, for people — never an API URL. */
  url: string;
}

export interface ZendeskComment { id: string; authorId: number | null; public: boolean; body: string; created: string }

export class ZendeskHttpError extends Error {
  constructor(readonly status: number, what: string) {
    super(`Zendesk ${what} failed: HTTP ${status}`);
    this.name = "ZendeskHttpError";
  }
}

export interface ZendeskAuthEnv {
  [name: string]: string | undefined;
  ZENDESK_SUBDOMAIN?: string | undefined;
  ZENDESK_OAUTH_TOKEN_FILE?: string | undefined;
}

/** The filesystem and process facts token loading depends on, injectable for tests. */
export interface ZendeskTokenFileIo {
  stat: (path: string) => { isFile(): boolean; mode: number; uid: number };
  readFile: (path: string) => string;
  /** The daemon's uid, or undefined where the platform has none. */
  uid: number | undefined;
}

const realIo: ZendeskTokenFileIo = { stat: (p) => statSync(p), readFile: (p) => readFileSync(p, "utf8"), uid: process.getuid?.() };

export type ZendeskAuth = { ok: true; subdomain: string; token: string } | { ok: false; reason: string };

/**
 * Reads Zendesk OAuth configuration, failing closed with a reason that never
 * contains token material. Only called when an enabled `zendesk-ticket` rule
 * exists, so a daemon without Zendesk rules never touches the token file.
 */
export function loadZendeskAuth(env: ZendeskAuthEnv, io: ZendeskTokenFileIo = realIo): ZendeskAuth {
  const deprecated = ["ZENDESK_EMAIL", "ZENDESK_API_TOKEN"].filter((k) => env[k]?.trim());
  if (deprecated.length) return { ok: false, reason: `${deprecated.join(" and ")} set: Zendesk email/API-token auth is not supported; unset it and use ZENDESK_OAUTH_TOKEN_FILE` };
  const subdomain = env.ZENDESK_SUBDOMAIN?.trim();
  const path = env.ZENDESK_OAUTH_TOKEN_FILE?.trim();
  if (!subdomain || !path) return { ok: false, reason: "set ZENDESK_SUBDOMAIN and ZENDESK_OAUTH_TOKEN_FILE" };
  if (!isZendeskSubdomain(subdomain)) return { ok: false, reason: `ZENDESK_SUBDOMAIN must be the subdomain alone (e.g. acme for acme.zendesk.com), got ${JSON.stringify(subdomain)}` };
  let st: ReturnType<ZendeskTokenFileIo["stat"]>;
  try { st = io.stat(path); } catch (e) { return { ok: false, reason: `ZENDESK_OAUTH_TOKEN_FILE ${path} cannot be read: ${(e as NodeJS.ErrnoException).code ?? "error"}` }; }
  if (!st.isFile()) return { ok: false, reason: `ZENDESK_OAUTH_TOKEN_FILE ${path} is not a regular file` };
  if (st.mode & 0o077) return { ok: false, reason: `ZENDESK_OAUTH_TOKEN_FILE ${path} is accessible to group or others (mode ${(st.mode & 0o777).toString(8)}); chmod 600 it` };
  if (io.uid !== undefined && st.uid !== io.uid && st.uid !== 0) return { ok: false, reason: `ZENDESK_OAUTH_TOKEN_FILE ${path} must be owned by the daemon's user or root` };
  let token: string;
  try { token = io.readFile(path).trim(); } catch (e) { return { ok: false, reason: `ZENDESK_OAUTH_TOKEN_FILE ${path} cannot be read: ${(e as NodeJS.ErrnoException).code ?? "error"}` }; }
  if (!token) return { ok: false, reason: `ZENDESK_OAUTH_TOKEN_FILE ${path} is empty` };
  if (/[^\x21-\x7e]/.test(token)) return { ok: false, reason: `ZENDESK_OAUTH_TOKEN_FILE ${path} must hold one token and nothing else` };
  return { ok: true, subdomain, token };
}

/** Split on whitespace outside double quotes. Quotes are kept on their token. */
function tokens(query: string): string[] {
  return query.match(/(?:[^\s"]+|"[^"]*"?)+/g) ?? [];
}

/**
 * Why a `zendesk-ticket` rule query is unusable, or `[]`. Checked when rules
 * load, so a bad rule stops the daemon before any search runs.
 *
 * `type:` is refused because every search adds `type:ticket` itself. Boolean
 * operators and parentheses are refused so that added `type:ticket` always
 * ANDs with the whole query.
 */
export function zendeskTicketQueryProblems(query: string): string[] {
  const problems: string[] = [];
  for (const token of tokens(query)) {
    const bare = token.replace(/"[^"]*"?/g, "");
    if (/[()]/.test(bare)) problems.push(`parentheses are not supported ("${token}")`);
    if (/^(AND|OR|NOT)$/.test(token)) problems.push(`boolean operator ${token} is not supported`);
    if (/^-?type:/i.test(token)) problems.push(`"${token}": zendesk-ticket rules match tickets only; type:ticket is added to every search`);
  }
  return problems;
}

/** The query actually sent: the rule's query and `type:ticket`. */
export function scopedTicketQuery(query: string): string {
  const problems = zendeskTicketQueryProblems(query);
  if (problems.length) throw new Error(`zendesk-ticket query rejected: ${problems.join("; ")}`);
  return `${query.trim()} type:ticket`;
}

interface TicketItem {
  result_type?: unknown;
  id?: unknown;
  subject?: unknown;
  description?: unknown;
  status?: unknown;
  priority?: unknown;
  type?: unknown;
  tags?: unknown;
  updated_at?: unknown;
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** One ticket object as a `ZendeskTicket` under `subdomain`, or null for anything malformed. */
export function mapZendeskTicket(subdomain: string, item: TicketItem): ZendeskTicket | null {
  if (typeof item.id !== "number" || !Number.isSafeInteger(item.id) || item.id < 1) return null;
  let ref: string;
  try { ref = formatZendeskTicketRef({ subdomain, id: item.id }); } catch { return null; }
  return {
    ref, id: item.id,
    subject: str(item.subject) ?? "",
    description: str(item.description) ?? "",
    status: str(item.status) ?? "unknown",
    priority: str(item.priority),
    ticketType: str(item.type),
    tags: Array.isArray(item.tags) ? item.tags.filter((t): t is string => typeof t === "string").sort() : [],
    updated: str(item.updated_at) ?? "",
    url: `https://${subdomain}.zendesk.com/agent/tickets/${item.id}`,
  };
}

export interface ZendeskTicketClientDeps {
  fetchImpl: FetchLike;
  subdomain: string;
  token: string;
  log?: (line: string) => void;
}

/** Zendesk's Search API returns at most 1000 results for any query. */
export const ZENDESK_SEARCH_LIMIT = 1000;
const PAGE = 100;
const COMMENT_PAGE_LIMIT = 30;

export interface ZendeskTicketClient {
  /** Every ticket a rule query matches, or a rejection — never a partial list. */
  searchAll(query: string): Promise<ZendeskTicket[]>;
  /** Every comment on one ticket, public and internal, oldest first. */
  comments(ref: ZendeskTicketRef): Promise<ZendeskComment[]>;
  /** One ticket, re-read by id. Rejects a ticket outside the configured subdomain or an answer naming another ticket. */
  get(ref: ZendeskTicketRef): Promise<ZendeskTicket>;
  /**
   * Add a PRIVATE internal note after `get` confirms the target. There is no
   * public variant. Rejects if Zendesk's audit records the comment as public.
   * Resolves the note's id and whether the audit confirmed it private (both
   * unknown if the audit did not say), and the ticket's `updated` as the
   * update returned it.
   */
  addInternalNote(ref: ZendeskTicketRef, body: string): Promise<{ id: string | null; confirmedPrivate: boolean; updated: string | null }>;
}

export function createZendeskTicketClient(deps: ZendeskTicketClientDeps): ZendeskTicketClient {
  if (!isZendeskSubdomain(deps.subdomain)) throw new Error("Zendesk client needs a valid ZENDESK_SUBDOMAIN");
  const base = `https://${deps.subdomain}.zendesk.com/api/v2`;
  const headers = { authorization: `Bearer ${deps.token}`, accept: "application/json" };
  const request = async (path: string, what: string, init: RequestInit = {}): Promise<unknown> => {
    // redirect "error": a redirect must never carry the bearer token to another URL.
    const res = await deps.fetchImpl(`${base}${path}`, { ...init, headers: { ...headers, ...(init.headers as Record<string, string> | undefined) }, redirect: "error" });
    if (!res.ok) throw new ZendeskHttpError(res.status, what);
    return res.json();
  };
  const getTicket = async (ref: ZendeskTicketRef): Promise<ZendeskTicket> => {
    const want = formatZendeskTicketRef(ref);
    if (ref.subdomain !== deps.subdomain) throw new Error(`${want} is outside ZENDESK_SUBDOMAIN`);
    const body = await request(`/tickets/${ref.id}.json`, "ticket read") as { ticket?: TicketItem } | null;
    const ticket = body && typeof body === "object" && body.ticket && typeof body.ticket === "object" ? mapZendeskTicket(deps.subdomain, body.ticket) : null;
    if (!ticket) throw new Error(`Zendesk ticket read for ${want} returned an unexpected body`);
    if (ticket.ref !== want) throw new Error(`Zendesk answered ${ticket.ref} for ${want}; refusing`);
    return ticket;
  };
  return {
    get: getTicket,
    async addInternalNote(ref, text) {
      const ticket = await getTicket(ref);
      if (ticket.status === "closed") throw new Error(`${ticket.ref} is closed; Zendesk accepts no notes on a closed ticket`);
      const body = await request(`/tickets/${ref.id}.json`, "internal note", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        // public: false is the only comment shape this client can send.
        body: JSON.stringify({ ticket: { comment: { body: text, public: false } } }),
      }) as { ticket?: { updated_at?: unknown }; audit?: { events?: unknown } } | null;
      const events = Array.isArray(body?.audit?.events) ? body!.audit!.events as Array<Record<string, unknown>> : [];
      const comment = events.find((e) => e?.type === "Comment");
      if (events.some((e) => e?.type === "Comment" && e.public === true)) {
        deps.log?.(`ERROR: [zendesk-ticket] Zendesk recorded the note on ${ticket.ref} as PUBLIC`);
        throw new Error(`Zendesk recorded the note on ${ticket.ref} as public; check the ticket and the agent account's role now`);
      }
      return {
        id: comment && comment.id !== undefined ? String(comment.id) : null,
        confirmedPrivate: comment?.public === false,
        updated: str(body?.ticket?.updated_at),
      };
    },
    async searchAll(query) {
      // Created order, oldest first: new tickets land on the last page, so paging
      // cannot skip a ticket the way updated order can when one moves mid-read.
      const q = scopedTicketQuery(query);
      const byRef = new Map<string, ZendeskTicket>();
      for (let page = 1; ; page++) {
        const params = new URLSearchParams({ query: q, sort_by: "created_at", sort_order: "asc", per_page: String(PAGE), page: String(page) });
        const body = await request(`/search.json?${params}`, "ticket search") as { count?: unknown; results?: unknown } | null;
        if (!body || typeof body.count !== "number" || !Array.isArray(body.results)) throw new Error("Zendesk ticket search returned an unexpected body");
        if (body.count > ZENDESK_SEARCH_LIMIT) throw new Error(`Zendesk ticket search matched ${body.count} tickets, over the ${ZENDESK_SEARCH_LIMIT} it can list`);
        for (const item of body.results as TicketItem[]) {
          if (item?.result_type !== "ticket") continue;
          const ticket = mapZendeskTicket(deps.subdomain, item);
          if (ticket) byRef.set(ticket.ref, ticket);
        }
        if (body.results.length < PAGE || page * PAGE >= body.count) break;
      }
      return [...byRef.values()];
    },
    async comments(ref) {
      if (ref.subdomain !== deps.subdomain) throw new Error(`${formatZendeskTicketRef(ref)} is outside ZENDESK_SUBDOMAIN`);
      const out: ZendeskComment[] = [];
      let after: string | null = null;
      for (let page = 1; ; page++) {
        if (page > COMMENT_PAGE_LIMIT) throw new Error(`Zendesk comments for ${formatZendeskTicketRef(ref)} exceed ${COMMENT_PAGE_LIMIT * PAGE}`);
        const params = new URLSearchParams({ "page[size]": String(PAGE), sort_order: "asc", ...(after ? { "page[after]": after } : {}) });
        const body = await request(`/tickets/${ref.id}/comments.json?${params}`, "ticket comments") as { comments?: unknown; meta?: { has_more?: unknown; after_cursor?: unknown } } | null;
        if (!body || !Array.isArray(body.comments)) throw new Error("Zendesk ticket comments returned an unexpected body");
        for (const c of body.comments as Array<Record<string, unknown>>) out.push(mapComment(c));
        if (body.meta?.has_more !== true) return out;
        if (typeof body.meta.after_cursor !== "string" || !body.meta.after_cursor) throw new Error("Zendesk ticket comments claimed more pages without a cursor");
        after = body.meta.after_cursor;
      }
    },
  };
}

function mapComment(c: Record<string, unknown>): ZendeskComment {
  return {
    id: String(c.id),
    authorId: typeof c.author_id === "number" ? c.author_id : null,
    // Anything but an explicit false is treated as public: never under-report who can see a comment.
    public: c.public !== false,
    body: str(c.body) ?? "",
    created: str(c.created_at) ?? "",
  };
}
