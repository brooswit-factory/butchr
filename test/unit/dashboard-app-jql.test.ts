/**
 * local/ui — the JQL lexer and formatter (`dashboard-app/src/view-model/jql.ts`).
 * The formatter's one hard rule: it may only change whitespace and keyword
 * case, never what the query means.
 */
import { describe, expect, test } from "bun:test";
import { booleanOf, formatJql, isJqlProvider, sameJql, tokenizeJql } from "../../dashboard-app/src/view-model/jql.js";

const types = (q: string) =>
  tokenizeJql(q)
    .filter((t) => t.type !== "space")
    .map((t) => `${t.text}:${t.type}`);

describe("tokenizeJql", () => {
  test("covers every character, in order", () => {
    const q = 'project = A AND (status in ("To Do", Done) OR x ~ "y \\" z") ORDER BY created DESC';
    expect(
      tokenizeJql(q)
        .map((t) => t.text)
        .join(""),
    ).toBe(q);
  });

  test("classifies fields, operators, values, keywords, functions, numbers and strings by context", () => {
    expect(types("assignee = currentUser() AND cf[10010] >= -1d")).toEqual([
      "assignee:field",
      "=:operator",
      "currentUser:function",
      "(:paren",
      "):paren",
      "AND:keyword",
      "cf[10010]:field",
      ">=:operator",
      "-1d:number",
    ]);
    expect(types('status not in ("A", B) order by created desc, rank')).toEqual([
      "status:field",
      "not:keyword",
      "in:keyword",
      "(:paren",
      '"A":string',
      ",:comma",
      "B:value",
      "):paren",
      "order:keyword",
      "by:keyword",
      "created:field",
      "desc:keyword",
      ",:comma",
      "rank:field",
    ]);
    expect(types("NOT (a = 1) && !b = c || d != e")).toEqual([
      "NOT:keyword",
      "(:paren",
      "a:field",
      "=:operator",
      "1:number",
      "):paren",
      "&&:keyword",
      "!:keyword",
      "b:field",
      "=:operator",
      "c:value",
      "||:keyword",
      "d:field",
      "!=:operator",
      "e:value",
    ]);
    expect(types("x = $")).toEqual(["x:field", "=:operator", "$:value"]);
  });

  test("booleanOf reads AND / OR / NOT and their symbolic aliases", () => {
    const [and, , , , , pipe] = tokenizeJql("and a | b").filter((t) => t.type !== "space");
    expect(booleanOf(and!)).toBe("AND");
    expect(booleanOf(tokenizeJql("|")[0]!)).toBe("OR");
    expect(booleanOf(tokenizeJql("x")[0]!)).toBeNull();
    expect(pipe).toBeUndefined();
  });
});

describe("formatJql", () => {
  test("short queries stay on one line, with keywords uppercased and spacing normalised", () => {
    expect(formatJql('project=A and status   in("To Do" ,Done)')).toEqual({ ok: true, text: 'project = A AND status IN ("To Do", Done)', changed: true });
    expect(formatJql("project = A")).toEqual({ ok: true, text: "project = A", changed: false });
    expect(formatJql("   ")).toEqual({ ok: true, text: "   ", changed: false });
  });

  test("long queries get one clause per line, groups indented when they don't fit, ORDER BY last", () => {
    const q = "project = FACTORY and status in (Open, Reopened) and (assignee = currentUser() or reporter = currentUser() or watcher = currentUser()) order by created desc";
    const r = formatJql(q, 50);
    expect(r.ok && r.text).toBe(
      ["project = FACTORY", "AND status IN (Open, Reopened)", "AND (", "  assignee = currentUser()", "  OR reporter = currentUser()", "  OR watcher = currentUser()", ")", "ORDER BY created DESC"].join("\n"),
    );
    expect(formatJql("project = A order by rank").ok && formatJql("project = A order by rank")).toMatchObject({ text: "project = A\nORDER BY rank" });
    const nested = formatJql("NOT (status = Done or resolution is not empty) and summary ~ 'a really quite long summary text to force a break'", 60);
    expect(nested.ok && nested.text).toBe("NOT (status = Done OR resolution IS NOT EMPTY)\nAND summary ~ 'a really quite long summary text to force a break'");
  });

  test("refuses what it can't format safely, leaving the query alone", () => {
    expect(formatJql('summary ~ "open')).toEqual({ ok: false, reason: "A quoted string isn't closed." });
    expect(formatJql("a = (b")).toEqual({ ok: false, reason: "The parentheses don't match." });
    expect(formatJql("a = b)")).toEqual({ ok: false, reason: "The parentheses don't match." });
  });

  test("never changes meaning, and is idempotent, across a corpus of queries", () => {
    const corpus = [
      'assignee = currentUser() AND status = "In Progress" AND labels = "agent-ready" AND issuetype = Task',
      'project in (A, B) and (labels = x or labels = "y z") and updated >= startOfDay(-7d) order by updated desc, key asc',
      'status CHANGED FROM "To Do" TO Done BY currentUser() DURING (startOfWeek(), now())',
      "project = A && status != Done || labels = x",
      "NOT (a = 1 OR (b = 2 AND (c = 3 OR d = 4))) AND e is EMPTY",
      'summary ~ "\\"quoted\\" text" and text ~ \'single\'',
      "and a = b",
    ];
    for (const q of corpus) {
      for (const width of [20, 50, 80, 200]) {
        const r = formatJql(q, width);
        expect(r.ok).toBe(true);
        if (!r.ok) continue;
        expect(sameJql(q, r.text)).toBe(true);
        const again = formatJql(r.text, width);
        expect(again.ok && again.text).toBe(r.text);
      }
    }
  });

  test("sameJql ignores whitespace and keyword case but nothing else", () => {
    expect(sameJql("a = b and c = d", "a=b\nAND c = d")).toBe(true);
    expect(sameJql("a = b", "a = c")).toBe(false);
    expect(sameJql('a = "x y"', 'a = "x  y"')).toBe(false);
    expect(sameJql("a = b", "a = b and c = d")).toBe(false);
  });

  test("isJqlProvider: only Jira work and idea queries are JQL", () => {
    expect(["jira-work", "jira-idea", "jira-project", "github-issue", "filesystem"].map(isJqlProvider)).toEqual([true, true, false, false, false]);
  });
});
