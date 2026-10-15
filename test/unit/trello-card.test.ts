import { describe, expect, test } from "bun:test";
import {
  createTrelloCardClient,
  loadTrelloAuth,
  mapTrelloCard,
  scopedCardQuery,
  trelloCardQueryProblems,
  type TrelloCredentialFileIo,
} from "../../src/resources/trello-card.js";
import { formatTrelloCardRef } from "../../src/resources/trello-card-ref.js";

// Never a real credential: every key/token below is a placeholder, and every request goes to a fake fetch.
const FAKE_KEY = "fake-api-key-for-tests";
const FAKE_TOKEN = "fake-oauth-token-for-tests";
const BOARD = "5f".padEnd(24, "0");
const CARD1 = "aa".padEnd(24, "1");
const CARD2 = "bb".padEnd(24, "2");
const CARD3 = "cc".padEnd(24, "3");

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

type Call = { method: string; url: string; body?: string };

const apiCard = (id: string, over: Record<string, unknown> = {}) => ({
  id, idBoard: BOARD, name: "Spawn the end portal", desc: "Need obsidian.", closed: false, idList: "c".padEnd(24, "3"),
  labels: [{ name: "build" }], due: null, dateLastActivity: "2026-10-15T10:00:00Z", shortUrl: `https://trello.com/c/${id}`, ...over,
});

describe("trello-card credential loading", () => {
  const env = { TRELLO_BOARD_ID: BOARD, TRELLO_API_KEY_FILE: "/etc/butchr/trello-key", TRELLO_TOKEN_FILE: "/etc/butchr/trello-token" };
  const io = (over: Partial<{ isFile: boolean; mode: number; uid: number; keyText: string; tokenText: string; statError: string }> = {}): TrelloCredentialFileIo => ({
    stat: (p) => {
      if (over.statError) throw Object.assign(new Error("nope"), { code: over.statError });
      return { isFile: () => over.isFile ?? true, mode: over.mode ?? 0o100600, uid: over.uid ?? 1000 };
    },
    readFile: (p) => (p.includes("key") ? (over.keyText ?? `${FAKE_KEY}\n`) : (over.tokenText ?? `${FAKE_TOKEN}\n`)),
    uid: 1000,
  });

  test("fails closed without a board id, key file, or token file, or with a malformed board id", () => {
    expect(loadTrelloAuth({}, io())).toEqual({ ok: false, reason: "set TRELLO_BOARD_ID" });
    expect(loadTrelloAuth({ TRELLO_BOARD_ID: "not-a-trello-id" }, io())).toMatchObject({ ok: false, reason: expect.stringContaining("24-character") });
    expect(loadTrelloAuth({ TRELLO_BOARD_ID: BOARD }, io())).toEqual({ ok: false, reason: "set TRELLO_API_KEY_FILE" });
    expect(loadTrelloAuth({ TRELLO_BOARD_ID: BOARD, TRELLO_API_KEY_FILE: "/k" }, io())).toEqual({ ok: false, reason: "set TRELLO_TOKEN_FILE" });
  });

  test("each credential file must be an owner-only regular file, holding one value", () => {
    expect(loadTrelloAuth(env, io())).toEqual({ ok: true, boardId: BOARD, apiKey: FAKE_KEY, token: FAKE_TOKEN });
    expect(loadTrelloAuth(env, io({ uid: 0, mode: 0o100400 }))).toMatchObject({ ok: true });
    const refusals: Array<[Parameters<typeof io>[0], string]> = [
      [{ mode: 0o100640 }, "group or others"],
      [{ uid: 1001 }, "owned by the daemon's user or root"],
      [{ isFile: false }, "not a regular file"],
      [{ statError: "ENOENT" }, "cannot be read: ENOENT"],
      [{ keyText: " \n" }, "is empty"],
      [{ tokenText: `${FAKE_TOKEN} second-line` }, "must hold one value"],
    ];
    for (const [over, why] of refusals) {
      const got = loadTrelloAuth(env, io(over));
      expect(got).toMatchObject({ ok: false, reason: expect.stringContaining(why) });
      expect(JSON.stringify(got)).not.toContain(FAKE_TOKEN);
      expect(JSON.stringify(got)).not.toContain(FAKE_KEY);
    }
  });
});

describe("trello-card query scoping", () => {
  test("parentheses and boolean operators are refused; everything else lowercases for a client-side substring match", () => {
    expect(trelloCardQueryProblems("obsidian")).toEqual([]);
    expect(trelloCardQueryProblems("(obsidian)")).toHaveLength(1);
    expect(trelloCardQueryProblems("obsidian AND nether")).toHaveLength(1);
    expect(scopedCardQuery(" Obsidian ")).toBe("obsidian");
    expect(() => scopedCardQuery("(x)")).toThrow("rejected");
  });
});

describe("trello card mapping", () => {
  test("maps cards under the configured board and drops malformed ones", () => {
    expect(mapTrelloCard(apiCard(CARD1))).toEqual({
      ref: formatTrelloCardRef({ boardId: BOARD, cardId: CARD1 }), id: CARD1, boardId: BOARD,
      name: "Spawn the end portal", desc: "Need obsidian.", closed: false, listId: "c".padEnd(24, "3"),
      labels: ["build"], due: null, updated: "2026-10-15T10:00:00Z", url: `https://trello.com/c/${CARD1}`,
    });
    for (const id of ["not-hex", "short", undefined]) expect(mapTrelloCard(apiCard(CARD1, { id }))).toBeNull();
    expect(mapTrelloCard(apiCard(CARD1, { idBoard: "not-a-board" }))).toBeNull();
  });
});

describe("trello card client", () => {
  test("searchAll lists the configured board's open cards and filters client-side, never off-board", async () => {
    const calls: Call[] = [];
    const client = createTrelloCardClient({ boardId: BOARD, apiKey: FAKE_KEY, token: FAKE_TOKEN, fetchImpl: async (url, init) => {
      calls.push({ method: init?.method ?? "GET", url });
      return json([apiCard(CARD1, { name: "Spawn the end portal" }), apiCard(CARD2, { name: "Mine diamonds", desc: "" })]);
    } });
    const all = await client.searchAll("");
    expect(all.map((c) => c.id)).toEqual([CARD1, CARD2]);
    const matched = await client.searchAll("end portal");
    expect(matched.map((c) => c.id)).toEqual([CARD1]);
    expect(calls).toHaveLength(2);
    for (const c of calls) {
      const u = new URL(c.url);
      expect(u.origin + u.pathname).toBe(`https://api.trello.com/1/boards/${BOARD}/cards/open`);
      expect(u.searchParams.get("key")).toBe(FAKE_KEY);
      expect(u.searchParams.get("token")).toBe(FAKE_TOKEN);
    }
  });

  test("searchAll rejects an unexpected body, and the client refuses a mismatched board id up front", async () => {
    await expect(createTrelloCardClient({ boardId: BOARD, apiKey: FAKE_KEY, token: FAKE_TOKEN, fetchImpl: async () => json({ not: "an array" }) }).searchAll("")).rejects.toThrow("unexpected body");
    expect(() => createTrelloCardClient({ boardId: "not-a-board", apiKey: FAKE_KEY, token: FAKE_TOKEN, fetchImpl: async () => json([]) })).toThrow("TRELLO_BOARD_ID");
  });

  test("get re-reads by id, refuses a card Trello answers under another id, and surfaces HTTP errors", async () => {
    const client = createTrelloCardClient({ boardId: BOARD, apiKey: FAKE_KEY, token: FAKE_TOKEN, fetchImpl: async (url) => {
      const path = new URL(url).pathname;
      if (path.endsWith(`/cards/${CARD3}`)) return json({}, 404);
      if (path.endsWith(`/cards/${CARD2}`)) return json(apiCard(CARD1)); // Trello answers the wrong card
      return json(apiCard(CARD1));
    } });
    expect((await client.get({ boardId: BOARD, cardId: CARD1 })).ref).toBe(formatTrelloCardRef({ boardId: BOARD, cardId: CARD1 }));
    await expect(client.get({ boardId: "f".padEnd(24, "9"), cardId: CARD1 })).rejects.toThrow("outside TRELLO_BOARD_ID");
    await expect(client.get({ boardId: BOARD, cardId: CARD2 })).rejects.toThrow("refusing");
    await expect(client.get({ boardId: BOARD, cardId: CARD3 })).rejects.toThrow("HTTP 404");
  });

  test("comments reverse Trello's newest-first order to oldest-first, and the client refuses an off-board card", async () => {
    const urls: string[] = [];
    const client = createTrelloCardClient({ boardId: BOARD, apiKey: FAKE_KEY, token: FAKE_TOKEN, fetchImpl: async (url) => {
      urls.push(url);
      // Trello's actions endpoint is newest-first by default: id "2" before id "1".
      return json([{ id: "2", idMemberCreator: "m1", data: { text: "second" }, date: "b" }, { id: "1", idMemberCreator: "m1", data: { text: "first" }, date: "a" }]);
    } });
    const comments = await client.comments({ boardId: BOARD, cardId: CARD1 });
    expect(comments).toEqual([
      { id: "1", authorId: "m1", body: "first", created: "a" },
      { id: "2", authorId: "m1", body: "second", created: "b" },
    ]);
    const u = new URL(urls[0]!);
    expect(u.origin + u.pathname).toBe(`https://api.trello.com/1/cards/${CARD1}/actions`);
    expect(u.searchParams.get("filter")).toBe("commentCard");
    await expect(client.comments({ boardId: "f".padEnd(24, "9"), cardId: CARD1 })).rejects.toThrow("outside TRELLO_BOARD_ID");
  });

  test("comments pages backward with `before` when a page is full, and caps rather than looping forever", async () => {
    const before: Array<string | null> = [];
    const full = () => Array.from({ length: 1000 }, (_, i) => ({ id: String(1000 - i), idMemberCreator: "m1", data: { text: "x" }, date: String(1000 - i) }));
    let page = 0;
    const client = createTrelloCardClient({ boardId: BOARD, apiKey: FAKE_KEY, token: FAKE_TOKEN, fetchImpl: async (url) => {
      before.push(new URL(url).searchParams.get("before"));
      page++;
      return json(full());
    } });
    await expect(client.comments({ boardId: BOARD, cardId: CARD1 })).rejects.toThrow("exceed");
    expect(page).toBe(5); // COMMENT_PAGE_LIMIT
    expect(before[0]).toBeNull();
    expect(before[1]).toBe("1"); // the oldest id seen on the prior (newest-first) page
  });

  test("addComment re-reads the card first and returns the posted comment's id", async () => {
    const calls: Call[] = [];
    const client = createTrelloCardClient({ boardId: BOARD, apiKey: FAKE_KEY, token: FAKE_TOKEN, fetchImpl: async (url, init) => {
      calls.push({ method: init?.method ?? "GET", url });
      if (init?.method === "POST") return json({ id: "900", date: "2026-10-15T11:00:00Z" });
      return json(apiCard(CARD1));
    } });
    expect(await client.addComment({ boardId: BOARD, cardId: CARD1 }, "looked into it")).toEqual({ id: "900", created: "2026-10-15T11:00:00Z" });
    expect(calls.map((c) => c.method)).toEqual(["GET", "POST"]);
    expect(new URL(calls[1]!.url).searchParams.get("text")).toBe("looked into it");

    const noId = createTrelloCardClient({ boardId: BOARD, apiKey: FAKE_KEY, token: FAKE_TOKEN, fetchImpl: async (_u, init) => (init?.method === "POST" ? json({}) : json(apiCard(CARD1))) });
    await expect(noId.addComment({ boardId: BOARD, cardId: CARD1 }, "x")).rejects.toThrow("do not retry");
  });

  test("never sends a redirect, and never logs the query string (key/token)", async () => {
    const logs: string[] = [];
    const client = createTrelloCardClient({ boardId: BOARD, apiKey: FAKE_KEY, token: FAKE_TOKEN, log: (l) => logs.push(l), fetchImpl: async (_url, init) => {
      expect(init?.redirect).toBe("error");
      return json(apiCard(CARD1));
    } });
    await client.get({ boardId: BOARD, cardId: CARD1 });
    expect(logs.join("\n")).not.toContain(FAKE_KEY);
    expect(logs.join("\n")).not.toContain(FAKE_TOKEN);
  });
});
