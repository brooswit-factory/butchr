import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeConnection } from "@brooswit/thatch/testing";
import type { ToolDef } from "@brooswit/thatch";
import type { Herd } from "../../src/agents/herd.js";
import { zendeskTicketNudge } from "../../src/agents/change-nudge.js";
import { buildWorkspace, mcpIdentityHeaders, workspaceDirFor, ZENDESK_TICKET_TOOLS_NOTE, type SpawnSpec } from "../../src/agents/workspace.js";
import { buildApp } from "../../src/daemon/app.js";
import { startZendeskTicketLoop } from "../../src/daemon/zendesk-ticket-loop.js";
import { runResourceLoop } from "../../src/daemon/loop.js";
import { createOwnWriteLedger } from "../../src/jira-watch/own-writes.js";
import { startBridge } from "../../src/mcp/bridge.js";
import { callerIdentity } from "../../src/mcp/identity.js";
import { bridgeWorkspace } from "../../src/mcp/workspace.js";
import type { NotifyReason } from "../../src/resources/types.js";
import { createZendeskTicketClient, loadZendeskAuth, mapZendeskTicket, scopedTicketQuery, zendeskTicketQueryProblems, type ZendeskTicket, type ZendeskTokenFileIo } from "../../src/resources/zendesk-ticket.js";
import { formatZendeskTicketRef, parseZendeskTicketRef } from "../../src/resources/zendesk-ticket-ref.js";
import { decodeAgentKey, encodeAgentKey } from "../../src/rules/agent-key.js";
import { ownsGithubIssueAgent } from "../../src/rules/github-issue-type.js";
import { ownsRuleAgent } from "../../src/rules/resource-type.js";
import { parseRules } from "../../src/rules/rules.js";
import { createZendeskTicketEventRules, ownsZendeskTicketAgent, specForZendeskTicket, ZENDESK_RISK_ACK_ENV, ZENDESK_RISK_ACK_VALUE, zendeskTicketStaffing, type ZendeskTicketMatch } from "../../src/rules/zendesk-ticket-type.js";
import { forJiraCallers, githubIssueTools } from "../../src/tools/github-issue.js";
import { Refusal } from "../../src/tools/outcome.js";
import { zendeskNoteTag, zendeskTicketTools } from "../../src/tools/zendesk-ticket.js";

// Never a real credential: every token below is a placeholder, and every request goes to a fake fetch.
const FAKE_TOKEN = "fake-oauth-token-for-tests";
const ZD = "zendesk-ticket:support:acme%2342";
const JIRA = "jira-work:task:BUTCHR-1";
const zdCaller = { headers: { "x-butchr-agent": ZD } };
const jiraCaller = { headers: { "x-issue": "BUTCHR-1", "x-butchr-agent": JIRA } };

const rules = parseRules({ rules: [
  { id: "task", resourceProvider: "jira-work", query: "type = Task", brief: "do it" },
  { id: "support", resourceProvider: "zendesk-ticket", query: "status<solved tags:escalate", brief: "triage it" },
] });

const zt = (ref: string, over: Partial<ZendeskTicket> = {}): ZendeskTicket => {
  const r = parseZendeskTicketRef(ref)!;
  return { ref, id: r.id, subject: "s", description: "d", status: "open", priority: null, ticketType: "incident", tags: [], updated: "2026-09-16T10:00:00Z", url: "x", ...over };
};
const apiTicket = (id: number, over: Record<string, unknown> = {}) => ({
  id, subject: "Printer on fire", description: "It is on fire.", status: "open", priority: "high", type: "incident",
  tags: ["vip", "escalate"], updated_at: "2026-09-16T10:00:00Z", ...over,
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

type Call = { method: string; url: string; body?: string; headers: Record<string, string>; redirect?: RequestInit["redirect"] };

/** A fake Zendesk API: records every request, answers ticket reads from `tickets`, accepts note PUTs. */
function fakeZendesk(tickets: Record<number, unknown>, putAudit: unknown = { events: [{ type: "Comment", id: 901, public: false }] }) {
  const calls: Call[] = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ method, url, headers: init?.headers as Record<string, string>, ...(init?.redirect ? { redirect: init.redirect } : {}), ...(typeof init?.body === "string" ? { body: init.body } : {}) });
    const path = new URL(url).pathname;
    const id = Number(/\/tickets\/(\d+)/.exec(path)?.[1]);
    if (method === "PUT") return json({ ticket: { ...(tickets[id] as object), updated_at: "2026-09-16T11:00:00Z" }, audit: putAudit });
    if (path.endsWith("/comments.json")) return json({ comments: [{ id: 5, author_id: 7, public: true, body: "any update?", created_at: "2026-09-16T09:00:00Z" }, { id: 6, author_id: 8, public: false, body: "internal", created_at: "2026-09-16T09:30:00Z" }], meta: { has_more: false } });
    return id in tickets ? json({ ticket: tickets[id] }) : json({ error: "RecordNotFound" }, 404);
  };
  return { calls, client: createZendeskTicketClient({ fetchImpl, subdomain: "acme", token: FAKE_TOKEN }) };
}

const call = (tools: Record<string, ToolDef<any>>, name: string, args: unknown, c: { headers: Record<string, string> }) =>
  Promise.resolve().then(() => tools[name]!.handler(args as never, c as never));

function fakeHerd(initial: string[] = []) {
  const running = new Set(initial);
  const spawned: string[] = [], stopped: string[] = [];
  const herd: Herd = {
    async runningIssues() { return [...running]; },
    async staleIssues() { return []; },
    async spawn(sp) { spawned.push(sp.key); running.add(sp.key); },
    async stop(i) { stopped.push(i); running.delete(i); },
    async paneFor(i) { return running.has(i) ? `pane-${i}` : null; },
    async nudge() { return { delivered: true }; },
  };
  return { herd, spawned, stopped, running };
}
const tick = () => new Promise((r) => setTimeout(r, 40));

describe("zendesk ticket identity", () => {
  test("<subdomain>#<id> is canonical and round-trips; agent keys escape it and are owned only by the zendesk loop", () => {
    expect(formatZendeskTicketRef({ subdomain: "acme", id: 42 })).toBe("acme#42");
    expect(parseZendeskTicketRef("acme#42")).toEqual({ subdomain: "acme", id: 42 });
    for (const bad of ["ACME#42", "acme#042", "acme#0", "acme#-1", "acme.zendesk.com#1", "acme#1#2", "#1", "acme#", "-acme#1", "acme#99999999999999999"]) {
      expect(parseZendeskTicketRef(bad)).toBeNull();
    }
    expect(encodeAgentKey({ resourceProvider: "zendesk-ticket", ruleId: "support", resourceId: "acme#42" })).toBe(ZD);
    expect(decodeAgentKey(ZD)).toEqual({ resourceProvider: "zendesk-ticket", ruleId: "support", resourceId: "acme#42" });
    expect(decodeAgentKey("zendesk-ticket:support:42")).toBeNull();
    expect(workspaceDirFor(ZD, "/root")).toBe("/root/zendesk-ticket/support/acme%2342");
    expect([ownsZendeskTicketAgent(ZD), ownsRuleAgent(ZD), ownsGithubIssueAgent(ZD)]).toEqual([true, false, false]);
    expect(ownsZendeskTicketAgent(JIRA)).toBe(false);
  });
});

describe("zendesk-ticket rules", () => {
  test("type:, boolean operators and parentheses are refused; every search adds type:ticket", () => {
    expect(zendeskTicketQueryProblems('status<solved tags:escalate subject:"printer (upstairs)"')).toEqual([]);
    expect(zendeskTicketQueryProblems("type:user")).toHaveLength(1);
    expect(zendeskTicketQueryProblems("-type:ticket")).toHaveLength(1);
    expect(zendeskTicketQueryProblems("status:open OR status:new")).toHaveLength(1);
    expect(zendeskTicketQueryProblems("(status:open)")).toHaveLength(1);
    expect(scopedTicketQuery(" status:open ")).toBe("status:open type:ticket");
    expect(() => scopedTicketQuery("type:organization")).toThrow("rejected");
  });

  test("rules validate zendesk queries and refuse relationships to, from and on zendesk rules", () => {
    expect(() => parseRules({ rules: [{ id: "z", resourceProvider: "zendesk-ticket", query: "type:user", brief: "b" }] })).toThrow("type:ticket is added");
    expect(() => parseRules({ rules: [
      { id: "z", resourceProvider: "zendesk-ticket", query: "status:open", brief: "b", relationships: { inwardConnectionRules: ["z2"] } },
      { id: "z2", resourceProvider: "zendesk-ticket", query: "status:new", brief: "b" },
    ] })).toThrow("relationships are not supported for zendesk-ticket rules");
    expect(() => parseRules({ rules: [
      { id: "w", resourceProvider: "jira-work", query: "q", brief: "b", relationships: { inwardConnectionRules: ["z"] } },
      { id: "z", resourceProvider: "zendesk-ticket", query: "status:open", brief: "b" },
    ] })).toThrow("another resource provider");
    expect(() => parseRules({ rules: [
      { id: "i", resourceProvider: "jira-idea", query: "q", brief: "b", relationships: { inwardConnectionRules: ["z"] } },
      { id: "z", resourceProvider: "zendesk-ticket", query: "status:open", brief: "b" },
    ] })).toThrow("may only hear github-issue rules");
  });
});

describe("zendesk OAuth token loading", () => {
  const env = { ZENDESK_SUBDOMAIN: "acme", ZENDESK_OAUTH_TOKEN_FILE: "/etc/butchr/zendesk-token" };
  const io = (over: Partial<{ isFile: boolean; mode: number; uid: number; text: string; statError: string }> = {}): ZendeskTokenFileIo => ({
    stat: () => {
      if (over.statError) throw Object.assign(new Error("nope"), { code: over.statError });
      return { isFile: () => over.isFile ?? true, mode: over.mode ?? 0o100600, uid: over.uid ?? 1000 };
    },
    readFile: () => over.text ?? `${FAKE_TOKEN}\n`,
    uid: 1000,
  });

  test("fails closed without both settings, with email/API-token auth configured, or with a malformed subdomain", () => {
    expect(loadZendeskAuth({}, io())).toEqual({ ok: false, reason: "set ZENDESK_SUBDOMAIN and ZENDESK_OAUTH_TOKEN_FILE" });
    expect(loadZendeskAuth({ ZENDESK_SUBDOMAIN: "acme" }, io())).toMatchObject({ ok: false });
    expect(loadZendeskAuth({ ZENDESK_OAUTH_TOKEN_FILE: "/t" }, io())).toMatchObject({ ok: false });
    expect(loadZendeskAuth({ ...env, ZENDESK_API_TOKEN: "x" }, io())).toMatchObject({ ok: false, reason: expect.stringContaining("email/API-token auth is not supported") });
    expect(loadZendeskAuth({ ...env, ZENDESK_EMAIL: "a@b.c" }, io())).toMatchObject({ ok: false, reason: expect.stringContaining("ZENDESK_EMAIL") });
    for (const sub of ["acme.zendesk.com", "https://acme.zendesk.com", "ACME", "-acme"]) {
      expect(loadZendeskAuth({ ...env, ZENDESK_SUBDOMAIN: sub }, io())).toMatchObject({ ok: false, reason: expect.stringContaining("subdomain alone") });
    }
  });

  test("the token file must be an owner-only regular file owned by the daemon user or root, holding one token", () => {
    expect(loadZendeskAuth(env, io())).toEqual({ ok: true, subdomain: "acme", token: FAKE_TOKEN });
    expect(loadZendeskAuth(env, io({ uid: 0, mode: 0o100400 }))).toMatchObject({ ok: true });
    const refusals: Array<[Parameters<typeof io>[0], string]> = [
      [{ mode: 0o100640 }, "group or others"],
      [{ mode: 0o100604 }, "group or others"],
      [{ uid: 1001 }, "owned by the daemon's user or root"],
      [{ isFile: false }, "not a regular file"],
      [{ statError: "ENOENT" }, "cannot be read: ENOENT"],
      [{ text: " \n" }, "is empty"],
      [{ text: `${FAKE_TOKEN} second-line` }, "one token"],
    ];
    for (const [over, why] of refusals) {
      const got = loadZendeskAuth(env, io(over));
      expect(got).toMatchObject({ ok: false, reason: expect.stringContaining(why) });
      expect(JSON.stringify(got)).not.toContain(FAKE_TOKEN);
    }
  });

  test("reads a real owner-only file, and refuses it once group-readable", () => {
    const dir = mkdtempSync(join(tmpdir(), "butchr-zd-token-"));
    try {
      const path = join(dir, "token");
      writeFileSync(path, `${FAKE_TOKEN}\n`);
      chmodSync(path, 0o600);
      expect(loadZendeskAuth({ ZENDESK_SUBDOMAIN: "acme", ZENDESK_OAUTH_TOKEN_FILE: path })).toEqual({ ok: true, subdomain: "acme", token: FAKE_TOKEN });
      chmodSync(path, 0o640);
      expect(loadZendeskAuth({ ZENDESK_SUBDOMAIN: "acme", ZENDESK_OAUTH_TOKEN_FILE: path })).toMatchObject({ ok: false });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  const ack = { [ZENDESK_RISK_ACK_ENV]: ZENDESK_RISK_ACK_VALUE };

  test("staffing stays dormant, reading no token file, until the shell-credential risk is acknowledged exactly", () => {
    let stats = 0;
    const counting: ZendeskTokenFileIo = { ...io(), stat: (p) => { stats++; return io().stat(p); } };
    for (const over of [{}, { [ZENDESK_RISK_ACK_ENV]: "" }, { [ZENDESK_RISK_ACK_ENV]: "1" }, { [ZENDESK_RISK_ACK_ENV]: "true" }]) {
      const r = zendeskTicketStaffing(rules, { ...env, ...over }, counting);
      expect(r.run).toBe(false);
      const reason = r.run ? "" : r.reason ?? "";
      expect(reason).toContain(`Zendesk is off until ${ZENDESK_RISK_ACK_ENV}=${ZENDESK_RISK_ACK_VALUE}`);
      expect(reason).toContain("the internal-note-only tool is not a boundary");
    }
    expect(stats).toBe(0);
    expect(zendeskTicketStaffing(rules, { ...env, [ZENDESK_RISK_ACK_ENV]: ` ${ZENDESK_RISK_ACK_VALUE} ` }, counting)).toMatchObject({ run: true });
  });

  test("staffing: no rules needs no config and reads no file; otherwise every enabled query and the auth must pass", () => {
    let stats = 0;
    const counting: ZendeskTokenFileIo = { ...io(), stat: (p) => { stats++; return io().stat(p); } };
    const onlyJira = parseRules({ rules: [{ id: "task", resourceProvider: "jira-work", query: "q", brief: "b" }] });
    expect(zendeskTicketStaffing(onlyJira, {}, counting)).toEqual({ run: false, rules: [], reason: null });
    expect(stats).toBe(0);
    expect(zendeskTicketStaffing(rules, ack, counting)).toMatchObject({ run: false, reason: "zendesk-ticket rules not staffed (support): set ZENDESK_SUBDOMAIN and ZENDESK_OAUTH_TOKEN_FILE" });
    expect(zendeskTicketStaffing(rules, { ...env, ...ack }, io({ mode: 0o100644 }))).toMatchObject({ run: false, reason: expect.stringContaining("group or others") });
    const ok = zendeskTicketStaffing(rules, { ...env, ...ack }, io());
    expect(ok).toMatchObject({ run: true, subdomain: "acme", token: FAKE_TOKEN });
    expect(ok.rules.map((r) => r.id)).toEqual(["support"]);
  });
});

describe("zendesk ticket client", () => {
  test("maps tickets under the configured subdomain and drops malformed ones", () => {
    expect(mapZendeskTicket("acme", apiTicket(42))).toEqual({
      ref: "acme#42", id: 42, subject: "Printer on fire", description: "It is on fire.", status: "open", priority: "high",
      ticketType: "incident", tags: ["escalate", "vip"], updated: "2026-09-16T10:00:00Z", url: "https://acme.zendesk.com/agent/tickets/42",
    });
    for (const id of [0, -1, 1.5, "42", undefined]) expect(mapZendeskTicket("acme", apiTicket(1, { id }))).toBeNull();
  });

  test("searchAll reads every page oldest first with the bearer token, no redirects, and tickets only", async () => {
    const calls: Call[] = [];
    const page = (n: number, count: number) => Array.from({ length: n }, (_, i) => ({ result_type: "ticket", ...apiTicket(i + 1 + (count - n)) }));
    const client = createZendeskTicketClient({ subdomain: "acme", token: FAKE_TOKEN, fetchImpl: async (url, init) => {
      calls.push({ method: init?.method ?? "GET", url, headers: init?.headers as Record<string, string>, ...(init?.redirect ? { redirect: init.redirect } : {}) });
      const p = Number(new URL(url).searchParams.get("page"));
      return json(p === 1 ? { count: 102, results: [...page(100, 100)] } : { count: 102, results: [...page(2, 102), { result_type: "user", id: 9000 }] });
    } });
    const tickets = await client.searchAll("status:open");
    expect(tickets.map((t) => t.ref)).toHaveLength(102);
    expect(calls).toHaveLength(2);
    for (const c of calls) {
      const u = new URL(c.url);
      expect(u.origin + u.pathname).toBe("https://acme.zendesk.com/api/v2/search.json");
      expect(Object.fromEntries(u.searchParams)).toMatchObject({ query: "status:open type:ticket", sort_by: "created_at", sort_order: "asc", per_page: "100" });
      expect(c.headers.authorization).toBe(`Bearer ${FAKE_TOKEN}`);
      expect(c.redirect).toBe("error");
    }
  });

  test("searchAll rejects rather than returning a partial list, and never sends a rejected query", async () => {
    let fetched = 0;
    const answer = (body: unknown, status = 200) => createZendeskTicketClient({ subdomain: "acme", token: FAKE_TOKEN, fetchImpl: async () => { fetched++; return json(body, status); } });
    await expect(answer({ count: 1001, results: [] }).searchAll("status:open")).rejects.toThrow("over the 1000");
    await expect(answer({ results: [] }).searchAll("status:open")).rejects.toThrow("unexpected body");
    await expect(answer({}, 401).searchAll("status:open")).rejects.toThrow("HTTP 401");
    fetched = 0;
    await expect(answer({ count: 0, results: [] }).searchAll("type:user")).rejects.toThrow("rejected");
    expect(fetched).toBe(0);
    expect(() => createZendeskTicketClient({ subdomain: "acme.evil.com", token: FAKE_TOKEN, fetchImpl: async () => json({}) })).toThrow("ZENDESK_SUBDOMAIN");
  });

  test("comments follow the cursor, keep public and internal apart, and fail loudly", async () => {
    const urls: string[] = [];
    const client = createZendeskTicketClient({ subdomain: "acme", token: FAKE_TOKEN, fetchImpl: async (url) => {
      urls.push(url);
      return new URL(url).searchParams.get("page[after]")
        ? json({ comments: [{ id: 2, author_id: 1, public: false, body: "note", created_at: "b" }], meta: { has_more: false } })
        : json({ comments: [{ id: 1, author_id: 1, body: "hi", created_at: "a" }], meta: { has_more: true, after_cursor: "cur1" } });
    } });
    expect(await client.comments({ subdomain: "acme", id: 42 })).toEqual([
      { id: "1", authorId: 1, public: true, body: "hi", created: "a" },
      { id: "2", authorId: 1, public: false, body: "note", created: "b" },
    ]);
    expect(urls.map((u) => new URL(u).searchParams.get("page[after]"))).toEqual([null, "cur1"]);
    await expect(client.comments({ subdomain: "other", id: 42 })).rejects.toThrow("outside ZENDESK_SUBDOMAIN");
    expect(urls).toHaveLength(2);
    const noCursor = createZendeskTicketClient({ subdomain: "acme", token: FAKE_TOKEN, fetchImpl: async () => json({ comments: [], meta: { has_more: true } }) });
    await expect(noCursor.comments({ subdomain: "acme", id: 1 })).rejects.toThrow("without a cursor");
  });

  test("an internal note is always public:false, only on a re-read open ticket in the subdomain, and a public audit is an error", async () => {
    const { client, calls } = fakeZendesk({ 42: apiTicket(42), 43: apiTicket(43, { status: "closed" }), 44: apiTicket(45) });
    expect(await client.addInternalNote({ subdomain: "acme", id: 42 }, "looked into it")).toEqual({ id: "901", confirmedPrivate: true, updated: "2026-09-16T11:00:00Z" });
    const puts = calls.filter((c) => c.method === "PUT");
    expect(puts.map((c) => [c.url, JSON.parse(c.body!)])).toEqual([["https://acme.zendesk.com/api/v2/tickets/42.json", { ticket: { comment: { body: "looked into it", public: false } } }]]);
    expect(puts[0]!.redirect).toBe("error");

    await expect(client.addInternalNote({ subdomain: "acme", id: 43 }, "x")).rejects.toThrow("closed");
    await expect(client.addInternalNote({ subdomain: "acme", id: 44 }, "x")).rejects.toThrow("refusing");
    await expect(client.addInternalNote({ subdomain: "acme", id: 99 }, "x")).rejects.toThrow("HTTP 404");
    await expect(client.addInternalNote({ subdomain: "evil", id: 42 }, "x")).rejects.toThrow("outside ZENDESK_SUBDOMAIN");
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(1);

    const logs: string[] = [];
    const loud = createZendeskTicketClient({ subdomain: "acme", token: FAKE_TOKEN, log: (l) => logs.push(l), fetchImpl: async (_u, init) =>
      init?.method === "PUT" ? json({ ticket: apiTicket(42), audit: { events: [{ type: "Comment", id: 1, public: true }] } }) : json({ ticket: apiTicket(42) }) });
    await expect(loud.addInternalNote({ subdomain: "acme", id: 42 }, "x")).rejects.toThrow("as public");
    expect(logs).toEqual([expect.stringContaining("PUBLIC")]);

    const silentAudit = fakeZendesk({ 42: apiTicket(42) }, {});
    expect(await silentAudit.client.addInternalNote({ subdomain: "acme", id: 42 }, "x")).toEqual({ id: null, confirmedPrivate: false, updated: "2026-09-16T11:00:00Z" });
  });
});

describe("zendesk ticket tools", () => {
  const tickets = { 42: apiTicket(42) };

  test("no tool can reply publicly: exactly a read and an internal note, and the note takes only text", () => {
    const tools = zendeskTicketTools({ client: fakeZendesk(tickets).client, log: () => {} });
    expect(Object.keys(tools).sort()).toEqual(["zendesk_add_internal_note", "zendesk_get_ticket"]);
    expect(Object.keys(tools.zendesk_add_internal_note!.input)).toEqual(["text"]);
    expect(Object.keys(tools.zendesk_get_ticket!.input)).toEqual([]);
  });

  test("zendesk_get_ticket reads the caller's own ticket and its comments, marked public or internal", async () => {
    const { client, calls } = fakeZendesk(tickets);
    const tools = zendeskTicketTools({ client, log: () => {} });
    expect(await call(tools, "zendesk_get_ticket", {}, zdCaller)).toMatchObject({
      ticket: "acme#42", url: "https://acme.zendesk.com/agent/tickets/42", subject: "Printer on fire", status: "open", type: "incident",
      comments: [{ id: "5", public: true, body: "any update?" }, { id: "6", public: false, body: "internal" }],
    });
    expect(calls.every((c) => c.method === "GET" && c.url.startsWith("https://acme.zendesk.com/api/v2/tickets/42"))).toBe(true);
  });

  test("zendesk_add_internal_note tags a private note on the caller's own ticket and records the write for echo suppression", async () => {
    const { client, calls } = fakeZendesk(tickets);
    const writes: string[][] = [];
    const tools = zendeskTicketTools({ client, onWrite: (r, u, w) => writes.push([r, u, w]), log: () => {} });
    expect(await call(tools, "zendesk_add_internal_note", { text: "Reproduced.", public: true }, zdCaller)).toEqual({ ok: true, ticket: "acme#42", note: "901", internal: true });
    expect(calls.filter((c) => c.method === "PUT").map((c) => JSON.parse(c.body!))).toEqual([{ ticket: { comment: { body: `${zendeskNoteTag("support")} Reproduced.`, public: false } } }]);
    expect(writes).toEqual([["acme#42", "2026-09-16T11:00:00Z", ZD]]);
  });

  test("an unconfirmed audit or missing updated is logged, never a tool error", async () => {
    const { client } = fakeZendesk(tickets, {});
    const logs: string[] = [];
    const tools = zendeskTicketTools({ client: { ...client, addInternalNote: async () => ({ id: null, confirmedPrivate: false, updated: null }) }, onWrite: () => { throw new Error("unreached"); }, log: (l) => logs.push(l) });
    expect(await call(tools, "zendesk_add_internal_note", { text: `${zendeskNoteTag("support")} already tagged` }, zdCaller)).toMatchObject({ ok: true });
    expect(logs.some((l) => l.includes("did not confirm the note"))).toBe(true);
    expect(logs.some((l) => l.includes("own-write read-back missing"))).toBe(true);
  });

  test("no cross-provider calls: other callers are refused Zendesk tools, and Zendesk agents reach no Jira or GitHub tool", async () => {
    const { client, calls } = fakeZendesk(tickets);
    const tools = zendeskTicketTools({ client, log: () => {} });
    for (const c of [jiraCaller, { headers: { "x-issue": "BUTCHR-1" } }, { headers: { "x-butchr-agent": "github-issue:bugs:acme%2Fw%2312" } }, { headers: {} }]) {
      await expect(call(tools, "zendesk_add_internal_note", { text: "x" }, c)).rejects.toBeInstanceOf(Refusal);
      await expect(call(tools, "zendesk_get_ticket", {}, c)).rejects.toBeInstanceOf(Refusal);
    }
    // Another subdomain's agent key decodes, but the client refuses before any request.
    await expect(call(tools, "zendesk_add_internal_note", { text: "x" }, { headers: { "x-butchr-agent": "zendesk-ticket:support:evil%2342" } })).rejects.toThrow("outside ZENDESK_SUBDOMAIN");
    expect(calls).toEqual([]);

    const jiraCalls: unknown[] = [];
    const jira = forJiraCallers({ jira_add_comment: { description: "d", input: {}, handler: (a) => { jiraCalls.push(a); return "ok"; } } }, () => {});
    await expect(call(jira, "jira_add_comment", { key: "BUTCHR-1", text: "x" }, zdCaller)).rejects.toThrow("use zendesk_get_ticket and zendesk_add_internal_note");
    expect(jiraCalls).toEqual([]);
    const gh = githubIssueTools({ client: { get: async () => { throw new Error("unreached"); }, comments: async () => [], addComment: async () => { throw new Error("unreached"); } }, log: () => {} });
    await expect(call(gh, "github_add_comment", { text: "x" }, zdCaller)).rejects.toBeInstanceOf(Refusal);
  });
});

describe("zendesk MCP identity and workspaces", () => {
  const spec: SpawnSpec = { key: ZD, resource: "acme#42", issuetype: "incident", summary: "Printer on fire", parent: null, brief: "triage it" };
  let root: string;
  const prev = process.env.BUTCHR_WORKSPACES;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "butchr-zd-agents-")); process.env.BUTCHR_WORKSPACES = root; });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); if (prev === undefined) delete process.env.BUTCHR_WORKSPACES; else process.env.BUTCHR_WORKSPACES = prev; });

  test("a Zendesk agent is its key alone; mixed or malformed identities are nobody", () => {
    expect(callerIdentity(zdCaller.headers)).toEqual({ provider: "zendesk-ticket", agent: ZD, ruleId: "support", resource: "acme#42", ref: { subdomain: "acme", id: 42 } });
    expect(callerIdentity({ "x-issue": "BUTCHR-1", "x-butchr-agent": ZD })).toBeNull();
    expect(callerIdentity({ "x-butchr-agent": "zendesk-ticket:support:ACME%2342" })).toBeNull();
    expect(mcpIdentityHeaders(spec)).toEqual({ "x-butchr-agent": ZD });
  });

  test("a claude workspace names its tools and says replies are impossible; the AGY bridge carries the key alone", async () => {
    const dir = buildWorkspace(spec, "http://localhost:7717/mcp", "claude");
    expect(JSON.parse(readFileSync(join(dir, "mcp.json"), "utf8")).mcpServers.butchr.headers).toEqual({ "x-butchr-agent": ZD });
    expect(readFileSync(join(dir, "brief.md"), "utf8")).toBe(`# support agent — acme#42: Printer on fire\n\n${ZENDESK_TICKET_TOOLS_NOTE}\n\ntriage it\n`);
    for (const tool of ["zendesk_get_ticket", "zendesk_add_internal_note"]) expect(ZENDESK_TICKET_TOOLS_NOTE).toContain(`\`${tool}\``);
    expect(ZENDESK_TICKET_TOOLS_NOTE).toContain("cannot reply to the customer");

    const agy = buildWorkspace(spec, "http://localhost:7717/mcp", "agy");
    expect(bridgeWorkspace(root, agy)).toEqual({ url: new URL("http://localhost:7717/mcp"), agent: ZD });
    writeFileSync(join(agy, ".butchr-agy.json"), JSON.stringify({ issue: "acme#42", agent: ZD, resource: "acme#42", mcpUrl: "http://localhost:7717/mcp" }));
    expect(() => bridgeWorkspace(root, agy)).toThrow();
    await expect(startBridge(new URL("http://127.0.0.1:1/mcp"), undefined, { agent: JIRA })).rejects.toThrow("zendesk-ticket agent");
  });
});

describe("the MCP auth gate", () => {
  const view = {
    state: async () => [], open: async () => ({ ok: true }), openPane: async () => ({ ok: true }),
    health: () => ({ ok: true, components: [] }),
    dashboard: async () => ({ checked: true as const, confirmedAt: "", rows: [], admission: { cap: 0, residency: null, sources: [] } }),
    header: () => ({ build: { sha: null, shaDirty: null, shaUnknownReason: "t", version: "0" } }),
    resourceLink: async () => ({ ok: true as const, url: "x" }),
  };
  const { app, mcp } = buildApp(view as never, {}, () => {});
  app.listen({ port: 0, hostname: "127.0.0.1" });
  const base = `http://127.0.0.1:${app.server!.port}`;
  afterAll(async () => { await mcp.closeAll(); app.stop(); });

  test("admits a Zendesk agent by key; refuses one that also claims x-issue", async () => {
    const zd = await FakeConnection.connect(base, { headers: zdCaller.headers });
    await expect(FakeConnection.connect(base, { headers: { "x-issue": "BUTCHR-1", "x-butchr-agent": ZD } })).rejects.toThrow();
    await zd.disconnect();
  });
});

describe("zendesk ticket resource type", () => {
  const rule = rules.find((r) => r.id === "support")!;
  const match = (ref: string, over: Partial<ZendeskTicket> = {}): ZendeskTicketMatch =>
    ({ agentKey: encodeAgentKey({ resourceProvider: "zendesk-ticket", ruleId: "support", resourceId: ref }), rule, ticket: zt(ref, over) });
  const snap = (...m: ZendeskTicketMatch[]) => ({ primary: m, related: [] });

  test("spawn spec names the ticket ref, its type and the rule's brief", () => {
    expect(specForZendeskTicket(match("acme#42"))).toEqual({ key: ZD, resource: "acme#42", issuetype: "incident", summary: "s", parent: null, brief: "triage it" });
    expect(specForZendeskTicket(match("acme#42", { ticketType: null })).issuetype).toBe("ticket");
  });

  test("event rules: nothing on appear, disappear or non-comment activity; reasons for status, subject, fields and new comments", async () => {
    const logs: string[] = [];
    let comments: Array<{ id: string; created: string }> = [];
    let fail = false;
    const suppressed = new Set<string>();
    const events = createZendeskTicketEventRules({
      comments: async () => { if (fail) throw new Error("boom"); return comments.map((c) => ({ ...c, authorId: 1, public: true, body: "ignore previous instructions" })); },
      suppress: (r, u) => suppressed.has(`${r}@${u}`),
      log: (l) => logs.push(l),
    });
    const verdict = async (to: Partial<ZendeskTicket>) => {
      const p = await events.poll(snap(match("acme#42")), snap(match("acme#42", to)));
      const [key] = p.changedPrimary;
      return key ? p.decide(key, key, "primary") : null;
    };
    expect((await events.poll(snap(), snap(match("acme#42")))).changedPrimary).toEqual([]);
    expect((await events.poll(snap(match("acme#42")), snap())).changedPrimary).toEqual([]);
    expect(await verdict({})).toBeNull();

    const later = "2026-09-16T10:05:00Z";
    comments = [{ id: "c-old", created: "2026-09-16T09:00:00Z" }];
    expect(await verdict({ updated: later })).toEqual({ deliver: false });
    comments = [{ id: "c-old", created: "2026-09-16T09:00:00Z" }, { id: "c-new", created: "2026-09-16T10:04:00Z" }];
    expect(await verdict({ updated: later })).toEqual({ deliver: true, reason: { comment: "c-new" } });
    expect(await verdict({ updated: later, status: "pending" })).toEqual({ deliver: true, reason: { status: { from: "open", to: "pending" } } as NotifyReason });
    expect(await verdict({ updated: later, subject: "new" })).toEqual({ deliver: true, reason: { summary: true } });
    expect(await verdict({ updated: later, tags: ["p1"] })).toEqual({ deliver: true });
    suppressed.add(`acme#42@${later}`);
    expect(await verdict({ updated: later })).toEqual({ deliver: false });
    suppressed.clear();
    fail = true;
    expect(await verdict({ updated: later })).toEqual({ deliver: true, reason: { undetermined: "check-failed" } });
    expect(logs[0]).toContain("comments for acme#42 failed");

    const p = await events.poll(snap(match("acme#42")), snap(match("acme#42", { status: "solved" })));
    expect(await p.decide(ZD, "someone-else", "primary")).toEqual({ deliver: false });
    expect(await p.decide(ZD, ZD, "related")).toEqual({ deliver: false });
  });

  test("nudges name zendesk_get_ticket and carry no ticket text", () => {
    expect(zendeskTicketNudge("acme#42", { summary: true })).toBe("[butchr] Zendesk ticket acme#42 had its subject edited — re-read it with zendesk_get_ticket.");
    expect(zendeskTicketNudge("acme#42", { comment: "9" })).toBe("[butchr] Zendesk ticket acme#42 got a new comment — re-read it with zendesk_get_ticket.");
  });
});

describe("the zendesk-ticket loop", () => {
  const env = { ZENDESK_SUBDOMAIN: "acme", ZENDESK_OAUTH_TOKEN_FILE: "/t" };
  const okIo: ZendeskTokenFileIo = { stat: () => ({ isFile: () => true, mode: 0o100600, uid: 1 }), readFile: () => FAKE_TOKEN, uid: 1 };

  test("a closed gate searches nothing, spawns nothing, and stops leftover zendesk-ticket agents only", async () => {
    const { herd, spawned, stopped, running } = fakeHerd([ZD, JIRA, "BUTCHR-9"]);
    let searched = 0;
    const logs: string[] = [];
    const stop = startZendeskTicketLoop({
      staffing: zendeskTicketStaffing(rules, {}),
      client: { searchAll: async () => { searched++; return [zt("acme#42")]; }, comments: async () => [] },
      herd, deliver: async () => {}, log: (l) => logs.push(l), intervalMs: 5,
    });
    await tick();
    stop();
    expect([searched, spawned, stopped]).toEqual([0, [], [ZD]]);
    expect(new Set(running)).toEqual(new Set([JIRA, "BUTCHR-9"]));
    expect(logs.filter((l) => l.startsWith("WARNING"))).toEqual([expect.stringContaining(`zendesk-ticket rules not staffed (support): Zendesk is off until ${ZENDESK_RISK_ACK_ENV}=`)]);
  });

  test("staffs, notifies and stops only its own agents; its own note is not echoed back; health hooks see polls", async () => {
    const { herd, spawned, stopped, running } = fakeHerd(["BUTCHR-9", JIRA]);
    let tickets = [zt("acme#42")];
    let fail = false;
    const delivered: Array<[string, string, string]> = [];
    const ledger = createOwnWriteLedger();
    const errors: string[] = [];
    let successes = 0;
    const stop = startZendeskTicketLoop({
      staffing: zendeskTicketStaffing(rules, { ...env, [ZENDESK_RISK_ACK_ENV]: ZENDESK_RISK_ACK_VALUE }, okIo),
      client: {
        searchAll: async () => { if (fail) throw new Error("Zendesk ticket search failed: HTTP 429"); return tickets; },
        comments: async () => [{ id: "c9", authorId: 1, public: true, body: "hi", created: "2026-09-16T10:30:00Z" }],
      },
      herd,
      deliver: async (agent, resource, msg) => { delivered.push([agent, resource, msg]); },
      suppress: (resource, updated, watcher) => ledger.shouldSuppress(resource, updated, watcher, Date.now()),
      log: () => {}, intervalMs: 10,
      onError: (e) => errors.push((e as Error).message), onPollSuccess: () => { successes++; },
    });
    await tick();
    expect(spawned).toEqual([ZD]);

    ledger.record("acme#42", "2026-09-16T10:31:00Z", ZD, Date.now());
    tickets = [zt("acme#42", { updated: "2026-09-16T10:31:00Z" })];
    await tick();
    expect(delivered).toEqual([]);

    tickets = [zt("acme#42", { updated: "2026-09-16T10:40:00Z", status: "pending" })];
    await tick();
    expect(delivered).toEqual([[ZD, "acme#42", '[butchr] Zendesk ticket acme#42 changed status from "open" to "pending" — re-read it with zendesk_get_ticket.']]);

    fail = true;
    await tick();
    expect(errors).toContain("Zendesk ticket search failed: HTTP 429");
    expect(stopped).toEqual([]);
    fail = false;
    tickets = [];
    await tick();
    stop();
    expect(stopped).toEqual([ZD]);
    expect(new Set(running)).toEqual(new Set(["BUTCHR-9", JIRA]));
    expect(successes).toBeGreaterThan(0);
  });

  test("a generic loop run with the jira rule type never staffs a zendesk rule", async () => {
    const { herd, spawned } = fakeHerd();
    const { createRuleResourceType } = await import("../../src/rules/resource-type.js");
    const stop = runResourceLoop(createRuleResourceType({ rules, search: async (jql) => { expect(jql).toBe("type = Task"); return []; } }), { herd, ownsId: ownsRuleAgent, intervalMs: 5, notify: () => {} });
    await tick();
    stop();
    expect(spawned).toEqual([]);
  });
});
