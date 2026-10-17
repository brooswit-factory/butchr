/**
 * local/ui — `trello-card` rules: the query's `list:`/`label:` qualifiers,
 * the staffing gate, change detection, the agents' tools and identity. Every
 * request goes to a fake; nothing here reaches Trello.
 */
import { describe, expect, test } from "bun:test";
import { trelloCardNudge } from "../../src/agents/change-nudge.js";
import { mcpIdentityHeaders, TRELLO_CARD_TOOLS_NOTE } from "../../src/agents/workspace.js";
import { callerIdentity } from "../../src/mcp/identity.js";
import { createTrelloCardClient, type TrelloCard, type TrelloCredentialFileIo } from "../../src/resources/trello-card.js";
import { decodeAgentKey, encodeAgentKey } from "../../src/rules/agent-key.js";
import { shortDisplayId } from "../../src/rules/display-label.js";
import { parseRules } from "../../src/rules/rules.js";
import {
  createTrelloCardEventRules,
  parseTrelloRuleQuery,
  searchTrelloCardRules,
  TRELLO_RISK_ACK_ENV,
  TRELLO_RISK_ACK_VALUE,
  trelloCardStaffing,
  trelloRuleQueryProblems,
  specForTrelloCard,
  specForTrelloCardQuery,
  type TrelloCardMatch,
} from "../../src/rules/trello-card-type.js";
import { agentLaunchConfig } from "../../src/agents/argv.js";
import { Refusal } from "../../src/tools/outcome.js";
import { trelloCardTools } from "../../src/tools/trello-card.js";
import type { ExecutionUnit } from "../../src/rules/execution.js";
import type { Herd } from "../../src/agents/herd.js";
import { startTrelloCardLoop } from "../../src/daemon/trello-card-loop.js";

// Never a real credential: placeholders only, and every request goes to a fake fetch.
const BOARD = "0123456789abcdef01234567";
const CARD = "89abcdef0123456789abcdef";
const OTHER = "fedcba9876543210fedcba98";
const READY = "aaaaaaaaaaaaaaaaaaaaaaaa";
const DOING = "bbbbbbbbbbbbbbbbbbbbbbbb";
const REF = `${BOARD}#${CARD}`;

const rules = parseRules({ rules: [
  { id: "ready", resourceProvider: "trello-card", query: 'list:"Ready for agent" label:bug', brief: "fix it" },
  { id: "docs", resourceProvider: "trello-card", query: "docs", brief: "write it" },
] });

const card = (over: Partial<TrelloCard> = {}): TrelloCard => ({
  ref: REF, id: CARD, boardId: BOARD, name: "Fix login", desc: "", closed: false, listId: READY,
  labels: ["Bug"], due: null, updated: "2026-10-16T10:00:00.000Z", url: "https://trello.com/c/abc", ...over,
});

describe("trello-card rule queries", () => {
  test("list: and label: qualifiers, quoted or not, around free text matched as one phrase", () => {
    expect(parseTrelloRuleQuery('list:"Ready for agent" label:bug Login  "page"')).toEqual({ ok: true, query: { lists: ["ready for agent"], labels: ["bug"], text: "login page" } });
    expect(parseTrelloRuleQuery("")).toEqual({ ok: true, query: { lists: [], labels: [], text: "" } });
    expect(trelloRuleQueryProblems('list:"Doing (this week)"')).toEqual([]);
  });

  test("an unclosed quote, an empty name, or the client's own refusals are problems, and stop the rules file loading", () => {
    expect(trelloRuleQueryProblems('list:"Ready')).toEqual(["list: has an unclosed quote"]);
    expect(trelloRuleQueryProblems("label: x")).toEqual(['label: needs a name, e.g. label:"Ready"']);
    expect(trelloRuleQueryProblems("a OR b")).toEqual(["boolean operators are not supported"]);
    expect(() => parseRules({ rules: [{ id: "bad", resourceProvider: "trello-card", query: "(x)", brief: "b" }] })).toThrow("parentheses are not supported");
  });

  test("a rule matches only cards in one of its lists with all of its labels; a list the board lacks is warned about once", async () => {
    const searched: string[] = [];
    const logs: string[] = [];
    const deps = {
      rules: [...rules, ...parseRules({ rules: [{ id: "gone", resourceProvider: "trello-card", query: "list:Archive", brief: "b" }] })],
      search: async (text: string) => {
        searched.push(text);
        return [card(), card({ ref: `${BOARD}#${OTHER}`, id: OTHER, listId: DOING, name: "docs", labels: [] })];
      },
      lists: async () => [{ id: READY, name: "Ready for agent", closed: false }, { id: DOING, name: "Doing", closed: false }],
      log: (l: string) => logs.push(l),
    };
    const warned = new Set<string>();
    const matches = await searchTrelloCardRules(deps, warned);
    // "ready" keeps only the card in its list with its label (case-insensitively); "docs" has no
    // qualifiers, so it keeps both of what the (fake) text search returned; "gone" keeps nothing.
    expect(matches.map((m) => m.agentKey)).toEqual([`trello-card:ready:${BOARD}%23${CARD}`, `trello-card:docs:${BOARD}%23${CARD}`, `trello-card:docs:${BOARD}%23${OTHER}`]);
    expect(searched).toEqual(["", "docs", ""]);
    await searchTrelloCardRules(deps, warned);
    expect(logs).toEqual(["WARNING: [trello-card] rule gone names a list the board doesn't have, so that part matches nothing"]);
  });
});

describe("trello-card staffing", () => {
  const io: TrelloCredentialFileIo = { stat: () => ({ isFile: () => true, mode: 0o100600, uid: 501 }), readFile: (p) => (p.endsWith("key") ? "fake-key" : "fake-token"), uid: 501 };
  const env = { TRELLO_BOARD_ID: BOARD, TRELLO_API_KEY_FILE: "/s/trello-api-key", TRELLO_TOKEN_FILE: "/s/trello-token" };

  test("off, without reading the credential files, until the .env acknowledgement is exactly right", () => {
    let reads = 0;
    const counting: TrelloCredentialFileIo = { ...io, readFile: (p) => { reads++; return io.readFile(p); } };
    const off = trelloCardStaffing(rules, { ...env, [TRELLO_RISK_ACK_ENV]: "yes" }, counting);
    expect(off.run).toBe(false);
    expect(!off.run && off.reason).toContain(`${TRELLO_RISK_ACK_ENV}=${TRELLO_RISK_ACK_VALUE}`);
    expect(reads).toBe(0);
    expect(trelloCardStaffing([], env, counting)).toEqual({ run: false, rules: [], reason: null });
  });

  test("on with the acknowledgement, a board and owner-only key and token files", () => {
    const on = trelloCardStaffing(rules, { ...env, [TRELLO_RISK_ACK_ENV]: TRELLO_RISK_ACK_VALUE }, io);
    expect(on).toEqual({ run: true, rules: rules.filter((r) => r.resourceProvider === "trello-card"), boardId: BOARD, apiKey: "fake-key", token: "fake-token" });
    const open = trelloCardStaffing(rules, { ...env, [TRELLO_RISK_ACK_ENV]: TRELLO_RISK_ACK_VALUE }, { ...io, stat: () => ({ isFile: () => true, mode: 0o100644, uid: 501 }) });
    expect(!open.run && open.reason).toContain("chmod 600");
  });
});

describe("trello-card change notices", () => {
  const unit = (c: TrelloCard): ExecutionUnit<TrelloCardMatch> => ({ kind: "resource", match: { agentKey: `trello-card:ready:${BOARD}%23${CARD}`, rule: rules[0]!, card: c } });
  const snap = (c: TrelloCard) => ({ primary: [unit(c)], related: [] });
  const key = `trello-card:ready:${BOARD}%23${CARD}`;
  const decide = async (from: TrelloCard, to: TrelloCard, comments: { id: string; created: string }[] = []) => {
    const rulesForEvents = createTrelloCardEventRules({ comments: async () => comments.map((c) => ({ ...c, authorId: null, body: "b" })) });
    const poll = await rulesForEvents.poll(snap(from), snap(to));
    return poll.decide(key, key, "primary");
  };

  test("a list move, a rename, a new comment; other activity notifies nobody", async () => {
    expect(await decide(card(), card({ listId: DOING, updated: "2026-10-16T11:00:00.000Z" }))).toEqual({ deliver: true, reason: { status: { from: READY, to: DOING } } });
    expect(await decide(card(), card({ name: "Fix logout" }))).toEqual({ deliver: true, reason: { summary: true } });
    expect(await decide(card(), card({ updated: "2026-10-16T11:00:00.000Z" }), [{ id: "c1", created: "2026-10-16T10:59:00.000Z" }])).toEqual({ deliver: true, reason: { comment: "c1" } });
    expect(await decide(card(), card({ updated: "2026-10-16T11:00:00.000Z" }), [{ id: "c0", created: "2026-10-16T09:00:00.000Z" }])).toEqual({ deliver: false });
  });

  test("the query agent watching a card isn't nudged about its own comment: suppression checks the watcher, not the card's key", async () => {
    const QUERY = "trello-card:ready:%40query";
    const relSnap = (c: TrelloCard) => ({ primary: [], related: [{ issue: unit(c), watchers: [QUERY] }] });
    const writers: string[] = [];
    const rulesForEvents = createTrelloCardEventRules({
      comments: async () => [{ id: "c9", created: "2026-10-16T10:59:00.000Z", authorId: null, body: "[butchr ready] done" }],
      suppress: (_ref, _updated, writer) => { writers.push(writer); return writer === QUERY; },
    });
    const poll = await rulesForEvents.poll(relSnap(card()), relSnap(card({ updated: "2026-10-16T11:00:00.000Z" })));
    expect(await poll.decide(key, QUERY, "related")).toEqual({ deliver: false });
    expect(writers).toEqual([QUERY]);
  });

  test("the nudge names the tool and never a list name", () => {
    expect(trelloCardNudge(REF, { status: { from: READY, to: DOING } })).toBe(`[butchr] Trello card ${REF} moved to another list — re-read it with trello_get_card.`);
    expect(trelloCardNudge(REF, { summary: true })).toBe(`[butchr] Trello card ${REF} had its name edited — re-read it with trello_get_card.`);
  });
});

describe("trello-card agents", () => {
  const agent = encodeAgentKey({ resourceProvider: "trello-card", ruleId: "ready", resourceId: REF });
  const caller = { headers: { "x-butchr-agent": agent } };

  test("identify by agent key alone, get a short label, and are told about their tools", () => {
    expect(decodeAgentKey(agent)).toEqual({ resourceProvider: "trello-card", ruleId: "ready", resourceId: REF });
    expect(callerIdentity(caller.headers)).toEqual({ provider: "trello-card", agent, ruleId: "ready", resource: REF, ref: { boardId: BOARD, cardId: CARD } });
    expect(callerIdentity({ ...caller.headers, "x-issue": "BUTCHR-1" })).toBeNull();
    expect(mcpIdentityHeaders({ key: agent, resource: REF, issuetype: "card", summary: "s", parent: null, brief: "b" })).toEqual({ "x-butchr-agent": agent });
    expect(shortDisplayId("trello-card", "ready", REF)).toBe(`card-${CARD.slice(-8)}`);
    expect(TRELLO_CARD_TOOLS_NOTE).toContain("trello_add_comment");
  });

  function tools(over: Partial<TrelloCard> = {}) {
    const posted: string[] = [];
    const writes: unknown[][] = [];
    const t = trelloCardTools({
      client: {
        get: async () => card(over),
        comments: async () => [{ id: "c1", authorId: null, body: "hi", created: "2026-10-16T10:00:00.000Z" }],
        lists: async () => [{ id: READY, name: "Ready for agent", closed: false }],
        addComment: async (_ref, text) => { posted.push(text); return { id: "c2", created: null }; },
      },
      onWrite: (...a) => writes.push(a),
      log: () => {},
    });
    return { t, posted, writes };
  }

  test("trello_get_card reads the caller's own card with its list's name and comments", async () => {
    const { t } = tools();
    const got = await t.trello_get_card!.handler({}, caller as never) as Record<string, unknown>;
    expect([got.card, got.list, got.name, (got.comments as unknown[]).length]).toEqual([REF, "Ready for agent", "Fix login", 1]);
  });

  test("trello_add_comment tags the comment, records the agent's own write, and refuses an archived card", async () => {
    const { t, posted, writes } = tools();
    expect(await t.trello_add_comment!.handler({ text: "Done." }, caller as never)).toEqual({ ok: true, card: REF, comment: "c2" });
    expect(posted).toEqual(["[butchr ready] Done."]);
    expect(writes).toEqual([[REF, "2026-10-16T10:00:00.000Z", agent]]);
    const archived = tools({ closed: true });
    await expect(archived.t.trello_add_comment!.handler({ text: "x" }, caller as never)).rejects.toBeInstanceOf(Refusal);
    expect(archived.posted).toEqual([]);
  });
});

describe("trello-card spawn specs keep the rule's permission settings", () => {
  const [strict] = parseRules({ rules: [{ id: "strict", resourceProvider: "trello-card", query: "docs", brief: "b", permissionMode: "plan", lizardMode: true }] });
  const cardKey = encodeAgentKey({ resourceProvider: "trello-card", ruleId: "strict", resourceId: REF });
  const specs = {
    card: specForTrelloCard({ agentKey: cardKey, rule: strict!, card: card() }),
    query: specForTrelloCardQuery(strict!, "trello-card:strict:%40query"),
  };

  for (const [kind, spec] of Object.entries(specs)) {
    test(`${kind} agent: permissionMode and lizardMode reach the spec and the launch, never the more permissive default`, () => {
      expect(spec).toMatchObject({ permissionMode: "plan", lizardMode: true });
      expect(agentLaunchConfig(spec, "/w", "pane", "worker", { provider: "claude" })).toMatchObject({ permissionMode: "plan" });
      expect(agentLaunchConfig(spec, "/w", "pane", "worker", { provider: "codex" })).toMatchObject({ bypassApprovalsAndSandbox: false });
    });
  }

  test("a rule that sets neither leaves both out, so butchr's launch defaults apply", () => {
    const [plain] = parseRules({ rules: [{ id: "plain", resourceProvider: "trello-card", query: "docs", brief: "b" }] });
    const spec = specForTrelloCardQuery(plain!, "trello-card:plain:%40query");
    expect(spec.permissionMode).toBeUndefined();
    expect(spec.lizardMode).toBeUndefined();
  });
});

describe("trello-card client: lists", () => {
  test("reads every list on the board, archived ones too, and skips malformed entries", async () => {
    const urls: string[] = [];
    const client = createTrelloCardClient({ boardId: BOARD, apiKey: "fake-key", token: "fake-token", fetchImpl: async (url) => {
      urls.push(String(url).split("?")[0]!);
      return new Response(JSON.stringify([{ id: READY, name: "Ready", closed: false }, { id: DOING, name: "Old", closed: true }, { id: "nope", name: "x" }]));
    } });
    expect(await client.lists()).toEqual([{ id: READY, name: "Ready", closed: false }, { id: DOING, name: "Old", closed: true }]);
    expect(urls).toEqual([`https://api.trello.com/1/boards/${BOARD}/lists`]);
  });
});

describe("trello-card loop", () => {
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
      async resumeInPlace() { return "unresumable" as const; },
    };
    return { herd, spawned, stopped };
  }
  const tick = () => new Promise((r) => setTimeout(r, 40));
  const AGENT = `trello-card:ready:${BOARD}%23${CARD}`;
  const io: TrelloCredentialFileIo = { stat: () => ({ isFile: () => true, mode: 0o100600, uid: 501 }), readFile: () => "fake", uid: 501 };
  const env = { TRELLO_BOARD_ID: BOARD, TRELLO_API_KEY_FILE: "/k", TRELLO_TOKEN_FILE: "/t", [TRELLO_RISK_ACK_ENV]: TRELLO_RISK_ACK_VALUE };
  const lists = async () => [{ id: READY, name: "Ready for agent", closed: false }, { id: DOING, name: "Doing", closed: false }];

  test("staffs a matching card, nudges its agent when it moves list, stops it when it leaves the query, and reports polls", async () => {
    const { herd, spawned, stopped } = fakeHerd(["BUTCHR-1"]);
    let cards = [card()];
    const delivered: string[] = [];
    let successes = 0;
    const ready = rules.filter((r) => r.id === "ready");
    const stop = startTrelloCardLoop({
      staffing: trelloCardStaffing(ready, env, io),
      client: { searchAll: async () => cards, lists, comments: async () => [] },
      herd, deliver: async (_agent, _resource, msg) => { delivered.push(msg); }, log: () => {}, intervalMs: 10,
      onPollSuccess: () => { successes++; },
    });
    await tick();
    expect(spawned).toEqual([AGENT]);
    cards = [card({ listId: DOING, updated: "2026-10-16T11:00:00.000Z" })];
    await tick();
    stop();
    // In "Doing" the card no longer matches list:"Ready for agent", so its agent stops.
    expect(stopped).toEqual([AGENT]);
    expect(successes).toBeGreaterThan(1);
    expect(delivered).toEqual([]);
  });

  test("without the acknowledgement nothing is searched, and a leftover agent is stopped", async () => {
    const { herd, stopped } = fakeHerd([AGENT, "BUTCHR-1"]);
    let searched = 0;
    const logs: string[] = [];
    const stop = startTrelloCardLoop({
      staffing: trelloCardStaffing(rules, {}, io),
      client: { searchAll: async () => { searched++; return []; }, lists, comments: async () => [] },
      herd, deliver: async () => {}, log: (l) => logs.push(l), intervalMs: 5,
    });
    await tick();
    stop();
    expect([searched, stopped]).toEqual([0, [AGENT]]);
    expect(logs[0]).toContain(`Trello is off until ${TRELLO_RISK_ACK_ENV}=`);
  });
});
