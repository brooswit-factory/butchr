/**
 * The `trello-card` resource provider's Trello side: credential-file loading,
 * rule-query validation, and a REST client for cards and their comments.
 *
 * This provider is ADDITIVE, alongside the existing Jira and Confluence
 * providers — it replaces neither and nothing routes through it unless a
 * caller explicitly builds a `TrelloCardRef`/client. No rule type, agent
 * staffing, daemon loop, or MCP tool wires this in yet (see this module's own
 * "Scope" note below) — only the resource-level identity, auth, and client
 * zendesk-ticket.ts's own header describes for its provider.
 *
 * Auth is a Trello API key PLUS an API token — Trello's REST API takes both
 * as `key`/`token` query-string parameters on every request (there is no
 * bearer-header scheme here, unlike Zendesk/GitHub). Both are read from
 * files (`TRELLO_API_KEY_FILE`, `TRELLO_TOKEN_FILE`), checked with the exact
 * same file-permission discipline `loadZendeskAuth` applies to its own token
 * file: a regular file, owned by the daemon's user (or root), with no group
 * or other permission bits. Every request refuses redirects, so neither
 * value is ever sent to anything but `https://api.trello.com`. Because both
 * go on the URL (not a header), callers of this module must never log a
 * request URL verbatim — `request()` below logs method and path only, never
 * the query string.
 *
 * This provider is scoped to exactly one Trello board (`TRELLO_BOARD_ID`):
 * `get`/`comments`/`addComment` all refuse a card outside it, the same way
 * `zendesk-ticket`'s client refuses a ticket outside `ZENDESK_SUBDOMAIN`.
 *
 * The ONE write is `addComment` — a plain Trello card comment (Trello has no
 * "internal note" concept the way Zendesk does; every Trello comment is
 * visible to everyone with board access). It re-reads the card first (`get`)
 * and refuses to post to a card outside the configured board. Nothing here
 * creates, moves, archives, or deletes a card, list, or board.
 *
 * Scope note (FACTORY-1009): this first version is read/comment only and
 * deliberately does not add a `trello-card` rule type, agent staffing, daemon
 * loop, or MCP tools — the user has not decided whether to adopt Trello at
 * all, and no live Trello account/credentials exist yet to verify any of
 * that against. Everything in this file is covered by mocked-fetch unit
 * tests only; nothing here has been run against the real Trello API.
 */
import { readFileSync, statSync } from "node:fs";
import type { FetchLike } from "../labels/pr.js";
import { expandHomePath } from "../config/home-path.js";
import { formatTrelloCardRef, isTrelloId, type TrelloCardRef } from "./trello-card-ref.js";

export interface TrelloCard {
  /** Canonical `<boardId>#<cardId>` — the resource id. */
  ref: string;
  id: string;
  boardId: string;
  name: string;
  desc: string;
  /** `true` when the card is archived ("closed", in Trello's own field name). */
  closed: boolean;
  listId: string | null;
  labels: string[];
  due: string | null;
  /** Trello's own last-activity timestamp — the closest thing a card has to `updated`. */
  updated: string;
  /** The human-facing board URL, never an API URL. */
  url: string;
}

export interface TrelloComment { id: string; authorId: string | null; body: string; created: string }

/** local/ui: one list on the configured board — what `trello-card` rules' `list:` qualifier and `trello_get_card` name a card's list by. */
export interface TrelloList { id: string; name: string; closed: boolean }

export class TrelloHttpError extends Error {
  constructor(readonly status: number, what: string) {
    super(`Trello ${what} failed: HTTP ${status}`);
    this.name = "TrelloHttpError";
  }
}

export interface TrelloAuthEnv {
  [name: string]: string | undefined;
  TRELLO_BOARD_ID?: string | undefined;
  TRELLO_API_KEY_FILE?: string | undefined;
  TRELLO_TOKEN_FILE?: string | undefined;
}

/** The filesystem facts credential loading depends on, injectable for tests. */
export interface TrelloCredentialFileIo {
  stat: (path: string) => { isFile(): boolean; mode: number; uid: number };
  readFile: (path: string) => string;
  /** The daemon's uid, or undefined where the platform has none. */
  uid: number | undefined;
}

const realIo: TrelloCredentialFileIo = { stat: (p) => statSync(p), readFile: (p) => readFileSync(p, "utf8"), uid: process.getuid?.() };

export type TrelloAuth = { ok: true; boardId: string; apiKey: string; token: string } | { ok: false; reason: string };

/** Reads and validates one credential file with the same discipline as `loadZendeskAuth`'s token file. */
function readCredentialFile(envVar: string, path: string | undefined, io: TrelloCredentialFileIo): { ok: true; value: string } | { ok: false; reason: string } {
  if (!path) return { ok: false, reason: `set ${envVar}` };
  let st: ReturnType<TrelloCredentialFileIo["stat"]>;
  try { st = io.stat(path); } catch (e) { return { ok: false, reason: `${envVar} ${path} cannot be read: ${(e as NodeJS.ErrnoException).code ?? "error"}` }; }
  if (!st.isFile()) return { ok: false, reason: `${envVar} ${path} is not a regular file` };
  if (st.mode & 0o077) return { ok: false, reason: `${envVar} ${path} is accessible to group or others (mode ${(st.mode & 0o777).toString(8)}); chmod 600 it` };
  if (io.uid !== undefined && st.uid !== io.uid && st.uid !== 0) return { ok: false, reason: `${envVar} ${path} must be owned by the daemon's user or root` };
  let raw: string;
  try { raw = io.readFile(path); } catch (e) { return { ok: false, reason: `${envVar} ${path} cannot be read: ${(e as NodeJS.ErrnoException).code ?? "error"}` }; }
  const value = raw.trim();
  if (!value) return { ok: false, reason: `${envVar} ${path} is empty` };
  if (/[^\x21-\x7e]/.test(value)) return { ok: false, reason: `${envVar} ${path} must hold one value and nothing else` };
  return { ok: true, value };
}

/**
 * Reads Trello credential configuration, failing closed with a reason that
 * never contains key/token material. Only called when an enabled
 * `trello-card` caller exists, mirroring `loadZendeskAuth`'s own lazy-read
 * discipline.
 */
export function loadTrelloAuth(env: TrelloAuthEnv, io: TrelloCredentialFileIo = realIo): TrelloAuth {
  const boardId = env.TRELLO_BOARD_ID?.trim();
  if (!boardId) return { ok: false, reason: "set TRELLO_BOARD_ID" };
  if (!isTrelloId(boardId)) return { ok: false, reason: `TRELLO_BOARD_ID must be a 24-character Trello board id, got ${JSON.stringify(boardId)}` };
  // `~/` expanded, the same paths Settings writes the key and token to (`resolveCredentialTarget`).
  const fileOf = (raw: string | undefined) => { const p = raw?.trim(); return p ? expandHomePath(p, env) : undefined; };
  const key = readCredentialFile("TRELLO_API_KEY_FILE", fileOf(env.TRELLO_API_KEY_FILE), io);
  if (!key.ok) return { ok: false, reason: key.reason };
  const token = readCredentialFile("TRELLO_TOKEN_FILE", fileOf(env.TRELLO_TOKEN_FILE), io);
  if (!token.ok) return { ok: false, reason: token.reason };
  return { ok: true, boardId, apiKey: key.value, token: token.value };
}

/** Why a `trello-card` rule query is unusable, or `[]`. Checked when rules load, so a bad rule stops the daemon before any search runs. */
export function trelloCardQueryProblems(query: string): string[] {
  const problems: string[] = [];
  if (/[()]/.test(query)) problems.push("parentheses are not supported");
  if (/\b(AND|OR|NOT)\b/.test(query)) problems.push("boolean operators are not supported");
  return problems;
}

/**
 * The query actually used: a plain, case-insensitive substring match against
 * a card's name and description, scoped to the configured board. Trello's own
 * `/1/search` endpoint spans every board the token can see and behaves
 * differently across plan tiers; rather than depend on that, this client
 * lists the configured board's own cards (`/1/boards/{id}/cards`) and filters
 * client-side — simpler, and fully deterministic under a mocked fetch. An
 * empty query matches every open card on the board.
 */
export function scopedCardQuery(query: string): string {
  const problems = trelloCardQueryProblems(query);
  if (problems.length) throw new Error(`trello-card query rejected: ${problems.join("; ")}`);
  return query.trim().toLowerCase();
}

interface CardItem {
  id?: unknown;
  idBoard?: unknown;
  name?: unknown;
  desc?: unknown;
  closed?: unknown;
  idList?: unknown;
  labels?: unknown;
  due?: unknown;
  dateLastActivity?: unknown;
  shortUrl?: unknown;
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** One card object as a `TrelloCard`, or null for anything malformed or missing a usable id/board. */
export function mapTrelloCard(item: CardItem): TrelloCard | null {
  if (typeof item.id !== "string" || typeof item.idBoard !== "string" || !isTrelloId(item.id) || !isTrelloId(item.idBoard)) return null;
  let ref: string;
  try { ref = formatTrelloCardRef({ boardId: item.idBoard, cardId: item.id }); } catch { return null; }
  const labels = Array.isArray(item.labels)
    ? item.labels.map((l) => (l && typeof l === "object" && typeof (l as { name?: unknown }).name === "string" ? (l as { name: string }).name : null)).filter((n): n is string => !!n).sort()
    : [];
  return {
    ref, id: item.id, boardId: item.idBoard,
    name: str(item.name) ?? "",
    desc: str(item.desc) ?? "",
    closed: item.closed === true,
    listId: typeof item.idList === "string" && isTrelloId(item.idList) ? item.idList : null,
    labels,
    due: str(item.due),
    updated: str(item.dateLastActivity) ?? "",
    url: str(item.shortUrl) ?? `https://trello.com/c/${item.id}`,
  };
}

export interface TrelloCardClientDeps {
  fetchImpl: FetchLike;
  boardId: string;
  apiKey: string;
  token: string;
  log?: (line: string) => void;
}

const PAGE_LIMIT = 1000;
/** Trello's `/cards/{id}/actions` endpoint hard-caps `limit` at 1000 per call; this many pages is already generous for a single card's comments. */
const COMMENT_PAGE_LIMIT = 5;

export interface TrelloCardClient {
  /** Every open card on the configured board whose name or description matches `query` (case-insensitive substring), or every open card for an empty query. */
  searchAll(query: string): Promise<TrelloCard[]>;
  /** Every comment on one card, oldest first. */
  comments(ref: TrelloCardRef): Promise<TrelloComment[]>;
  /** One card, re-read by id. Rejects a card outside the configured board or an answer naming another card. */
  get(ref: TrelloCardRef): Promise<TrelloCard>;
  /** Add a comment after `get` confirms the target is on the configured board. Every Trello comment is visible to the whole board — there is no private-note variant. */
  addComment(ref: TrelloCardRef, body: string): Promise<{ id: string; created: string | null }>;
  /** local/ui: every list on the configured board, archived ones included, so a card sitting in an archived list still has a name. */
  lists(): Promise<TrelloList[]>;
}

export function createTrelloCardClient(deps: TrelloCardClientDeps): TrelloCardClient {
  if (!isTrelloId(deps.boardId)) throw new Error("Trello client needs a valid TRELLO_BOARD_ID");
  const base = "https://api.trello.com/1";
  const auth = { key: deps.apiKey, token: deps.token };
  const request = async (path: string, what: string, params: Record<string, string> = {}, init: RequestInit = {}): Promise<unknown> => {
    const qs = new URLSearchParams({ ...auth, ...params });
    deps.log?.(`${init.method ?? "GET"} ${path}`); // never the query string: it carries the key and token
    // redirect "error": a redirect must never carry the key/token to another URL.
    const res = await deps.fetchImpl(`${base}${path}?${qs}`, { ...init, redirect: "error" });
    if (!res.ok) throw new TrelloHttpError(res.status, what);
    return res.json();
  };
  const getCard = async (ref: TrelloCardRef): Promise<TrelloCard> => {
    const want = formatTrelloCardRef(ref);
    if (ref.boardId !== deps.boardId) throw new Error(`${want} is outside TRELLO_BOARD_ID`);
    const body = await request(`/cards/${ref.cardId}`, "card read", { fields: "id,idBoard,name,desc,closed,idList,labels,due,dateLastActivity,shortUrl" }) as CardItem | null;
    const card = body && typeof body === "object" ? mapTrelloCard(body) : null;
    if (!card) throw new Error(`Trello card read for ${want} returned an unexpected body`);
    if (card.ref !== want) throw new Error(`Trello answered ${card.ref} for ${want}; refusing`);
    return card;
  };
  return {
    get: getCard,
    async addComment(ref, text) {
      const card = await getCard(ref);
      const body = await request(`/cards/${ref.cardId}/actions/comments`, "card comment", { text }, { method: "POST" }) as { id?: unknown; date?: unknown } | null;
      if (!body || typeof body.id !== "string" || !body.id) throw new Error(`Trello comment on ${card.ref} WAS posted, but its id could not be confirmed (the response carried no usable id) — do not retry, it would duplicate the comment`);
      return { id: body.id, created: str(body.date) };
    },
    async searchAll(query) {
      const q = scopedCardQuery(query);
      const body = await request(`/boards/${deps.boardId}/cards/open`, "board cards", { fields: "id,idBoard,name,desc,closed,idList,labels,due,dateLastActivity,shortUrl" }) as unknown;
      if (!Array.isArray(body)) throw new Error("Trello board cards returned an unexpected body");
      const out: TrelloCard[] = [];
      for (const item of body as CardItem[]) {
        const card = mapTrelloCard(item);
        if (!card) continue;
        if (q && !card.name.toLowerCase().includes(q) && !card.desc.toLowerCase().includes(q)) continue;
        out.push(card);
      }
      return out;
    },
    async lists() {
      const body = await request(`/boards/${deps.boardId}/lists`, "board lists", { filter: "all", fields: "id,name,closed" }) as unknown;
      if (!Array.isArray(body)) throw new Error("Trello board lists returned an unexpected body");
      const out: TrelloList[] = [];
      for (const item of body as Array<Record<string, unknown>>) {
        if (typeof item?.id !== "string" || !isTrelloId(item.id) || typeof item.name !== "string") continue;
        out.push({ id: item.id, name: item.name, closed: item.closed === true });
      }
      return out;
    },
    async comments(ref) {
      // Re-read the card first, the same way `get`/`addComment` do: `ref.boardId`
      // is caller-supplied identity, not proof of the card's CURRENT board. A
      // card that has since moved to another board must be refused here too,
      // not just trusted because the caller still names the old board.
      await getCard(ref);
      const out: TrelloComment[] = [];
      let before: string | undefined;
      for (let page = 1; ; page++) {
        if (page > COMMENT_PAGE_LIMIT) throw new Error(`Trello comments for ${formatTrelloCardRef(ref)} exceed ${COMMENT_PAGE_LIMIT * PAGE_LIMIT}`);
        const body = await request(`/cards/${ref.cardId}/actions`, "card comments", { filter: "commentCard", limit: String(PAGE_LIMIT), ...(before ? { before } : {}) }) as unknown;
        if (!Array.isArray(body)) throw new Error("Trello card comments returned an unexpected body");
        const items = body as Array<Record<string, unknown>>;
        for (const a of items) {
          const comment = mapComment(a);
          if (!comment) throw new Error(`Trello comments for ${formatTrelloCardRef(ref)} included a malformed comment action (missing or non-string id/text)`);
          out.push(comment);
        }
        if (items.length < PAGE_LIMIT) break;
        // Trello's actions endpoint returns newest-first; page backward by the oldest id seen so far.
        const last = items[items.length - 1];
        if (typeof last?.id !== "string") throw new Error(`Trello card comments for ${formatTrelloCardRef(ref)} claimed a full page without a usable id to page from`);
        before = last.id;
      }
      // Reverse to oldest-first, matching every other provider's documented comment ordering.
      return out.reverse();
    },
  };
}

/** `null` for a malformed comment action — never a fabricated `"undefined"` id or a silently-substituted empty body. */
function mapComment(a: Record<string, unknown>): TrelloComment | null {
  if (typeof a.id !== "string" || !a.id) return null;
  const data = a.data && typeof a.data === "object" ? a.data as Record<string, unknown> : {};
  if (typeof data.text !== "string") return null;
  return {
    id: a.id,
    authorId: typeof a.idMemberCreator === "string" ? a.idMemberCreator : null,
    body: data.text,
    created: str(a.date) ?? "",
  };
}
