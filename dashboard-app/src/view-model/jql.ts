/**
 * local/ui — a small JQL lexer for highlighting, plus a formatter for the
 * rule editor's Format button. Plain TypeScript, no React, no CodeMirror:
 * the editor (`components/rules-targeting/QueryEditor.tsx`) and the
 * read-only summary (`JqlCode.tsx`) both use these tokens, so they always
 * colour a query the same way.
 *
 * Highlighting is best-effort (an unknown construct is just plain text);
 * formatting is not allowed to be. `formatJql` only ever changes
 * whitespace and keyword case (JQL ignores the first outside strings and
 * keywords are case-insensitive), and it proves that before returning: the
 * formatted text must lex to exactly the same token sequence. Anything it
 * can't format safely (an unclosed string, unbalanced parentheses) is
 * returned unchanged with a reason.
 */

export type JqlTokenType = "space" | "string" | "paren" | "comma" | "operator" | "keyword" | "function" | "field" | "value" | "number" | "unknown";

export interface JqlToken {
  type: JqlTokenType;
  text: string;
  from: number;
  to: number;
}

/** JQL's operator keywords. They're reserved words, so unquoted they are always keywords and uppercasing them never changes a query. */
const KEYWORDS = new Set(["AND", "OR", "NOT", "IN", "IS", "EMPTY", "NULL", "ORDER", "BY", "ASC", "DESC", "WAS", "CHANGED", "FROM", "TO", "ON", "DURING", "BEFORE", "AFTER"]);
/** JQL's symbolic aliases for AND / OR / NOT. Kept exactly as written. */
const BOOL_ALIASES: Record<string, "AND" | "OR" | "NOT"> = { "&&": "AND", "&": "AND", "||": "OR", "|": "OR", "!": "NOT" };
const OPERATORS = ["!=", "!~", ">=", "<=", "=", "~", ">", "<"];
const WORD_RE = /[^\s"'(),=!~<>&|]+/y;
const NUMBER_RE = /^-?\d+(?:\.\d+)?[wdhm]?$/i;

/** What a word or symbol means for structure: AND / OR / NOT (including aliases), or nothing. */
export function booleanOf(token: JqlToken): "AND" | "OR" | "NOT" | null {
  if (token.type !== "keyword") return null;
  const upper = token.text.toUpperCase();
  if (upper === "AND" || upper === "OR" || upper === "NOT") return upper;
  return BOOL_ALIASES[token.text] ?? null;
}

type ParenKind = "group" | "list" | "args";

/**
 * Splits `text` into tokens covering every character, in order. Words are
 * classified by context: a word where a clause starts is a field, a word
 * after an operator (or inside a list or function call) is a value.
 */
export function tokenizeJql(text: string): JqlToken[] {
  const tokens: JqlToken[] = [];
  const parens: ParenKind[] = [];
  let expectField = true;
  let inOrderBy = false;
  let prev: JqlToken | null = null; // previous non-space token
  let i = 0;
  const push = (type: JqlTokenType, from: number, to: number) => {
    const token: JqlToken = { type, text: text.slice(from, to), from, to };
    tokens.push(token);
    if (type !== "space") prev = token;
    return token;
  };
  const inValueList = () => parens.length > 0 && parens[parens.length - 1] !== "group";

  while (i < text.length) {
    const ch = text[i]!;
    if (/\s/.test(ch)) {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j]!)) j++;
      push("space", i, j);
      i = j;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== ch) j += text[j] === "\\" ? 2 : 1;
      const end = Math.min(j + 1, text.length);
      const token = push("string", i, end);
      if (j >= text.length) (token as JqlToken & { unterminated?: boolean }).unterminated = true;
      // A quoted string is a field name where a field is expected (`"Story Points" > 3`), otherwise a value.
      expectField = expectField && !inValueList() ? false : expectField;
      i = end;
      continue;
    }
    if (ch === "(") {
      const p = prev as JqlToken | null;
      const kind: ParenKind = p?.type === "function" ? "args" : p && (p.type === "operator" || (p.type === "keyword" && booleanOf(p) === null)) ? "list" : "group";
      parens.push(kind);
      push("paren", i, i + 1);
      if (kind === "group") expectField = true;
      i++;
      continue;
    }
    if (ch === ")") {
      parens.pop();
      push("paren", i, i + 1);
      expectField = false;
      i++;
      continue;
    }
    if (ch === ",") {
      push("comma", i, i + 1);
      if (inOrderBy && parens.length === 0) expectField = true;
      i++;
      continue;
    }
    const two = text.slice(i, i + 2);
    if (two === "&&" || two === "||") {
      push("keyword", i, i + 2);
      expectField = true;
      i += 2;
      continue;
    }
    const op = OPERATORS.find((o) => text.startsWith(o, i));
    if (op) {
      push("operator", i, i + op.length);
      expectField = false;
      i += op.length;
      continue;
    }
    if (ch === "&" || ch === "|" || ch === "!") {
      push("keyword", i, i + 1);
      expectField = true;
      i++;
      continue;
    }
    WORD_RE.lastIndex = i;
    const match = WORD_RE.exec(text);
    if (!match) {
      push("unknown", i, i + 1);
      i++;
      continue;
    }
    const word = match[0];
    const end = i + word.length;
    const upper = word.toUpperCase();
    let after = end;
    while (after < text.length && /\s/.test(text[after]!)) after++;
    if (KEYWORDS.has(upper)) {
      const before = prev as JqlToken | null;
      push("keyword", i, end);
      if (upper === "AND" || upper === "OR" || upper === "NOT") expectField = !(upper === "NOT" && !expectField);
      else if (upper === "BY" && before?.text.toUpperCase() === "ORDER") {
        inOrderBy = true;
        expectField = true;
      } else if (upper !== "ORDER") expectField = false;
    } else if (text[after] === "(") {
      push("function", i, end);
    } else if (expectField && !inValueList()) {
      push("field", i, end);
      expectField = false;
    } else {
      push(NUMBER_RE.test(word) ? "number" : "value", i, end);
    }
    i = end;
  }
  return tokens;
}

/** The significant tokens, with keyword case normalised — what "the same query" means for the formatter's self-check. */
function signature(tokens: readonly JqlToken[]): string[] {
  return tokens.filter((t) => t.type !== "space").map((t) => (t.type === "keyword" && KEYWORDS.has(t.text.toUpperCase()) ? t.text.toUpperCase() : t.text));
}

export function sameJql(a: string, b: string): boolean {
  const sa = signature(tokenizeJql(a));
  const sb = signature(tokenizeJql(b));
  return sa.length === sb.length && sa.every((t, i) => t === sb[i]);
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

type Node =
  | { kind: "clause"; tokens: JqlToken[] }
  | { kind: "bool"; token: JqlToken }
  | { kind: "group"; not: JqlToken | null; children: Node[] }
  | { kind: "order"; tokens: JqlToken[] };

function isOrderStart(tokens: readonly JqlToken[], i: number): boolean {
  return tokens[i]?.type === "keyword" && tokens[i]!.text.toUpperCase() === "ORDER" && tokens[i + 1]?.text.toUpperCase() === "BY";
}

/** Parses one parenthesis level of significant tokens, from `start`, until a closing `)` (consumed) or the end. */
function parseLevel(tokens: readonly JqlToken[], start: number, topLevel: boolean): { nodes: Node[]; next: number } {
  const nodes: Node[] = [];
  let i = start;
  while (i < tokens.length) {
    const t = tokens[i]!;
    if (t.type === "paren" && t.text === ")") return { nodes, next: i + 1 };
    if (topLevel && isOrderStart(tokens, i)) {
      nodes.push({ kind: "order", tokens: tokens.slice(i) });
      return { nodes, next: tokens.length };
    }
    const bool = booleanOf(t);
    const atClauseStart = nodes.length === 0 || nodes[nodes.length - 1]!.kind === "bool";
    if ((bool === "AND" || bool === "OR") && !atClauseStart) {
      nodes.push({ kind: "bool", token: t });
      i++;
      continue;
    }
    if (atClauseStart && bool === "NOT" && tokens[i + 1]?.text === "(") {
      const inner = parseLevel(tokens, i + 2, false);
      nodes.push({ kind: "group", not: t, children: inner.nodes });
      i = inner.next;
      continue;
    }
    if (atClauseStart && t.type === "paren" && t.text === "(") {
      const inner = parseLevel(tokens, i + 1, false);
      nodes.push({ kind: "group", not: null, children: inner.nodes });
      i = inner.next;
      continue;
    }
    // A clause: everything up to the next AND/OR, `)` or ORDER BY at this level.
    const clause: JqlToken[] = [];
    let depth = 0;
    while (i < tokens.length) {
      const c = tokens[i]!;
      if (depth === 0) {
        if (c.type === "paren" && c.text === ")") break;
        if (topLevel && isOrderStart(tokens, i)) break;
        const b = booleanOf(c);
        if ((b === "AND" || b === "OR") && clause.length > 0) break;
      }
      if (c.type === "paren") depth += c.text === "(" ? 1 : -1;
      clause.push(c);
      i++;
    }
    nodes.push({ kind: "clause", tokens: clause });
  }
  return { nodes, next: i };
}

function tokenText(t: JqlToken): string {
  return t.type === "keyword" && KEYWORDS.has(t.text.toUpperCase()) ? t.text.toUpperCase() : t.text;
}

/** One clause on one line: single spaces, except none inside parentheses' edges, before commas, or between a function and its `(`. */
function renderTokens(tokens: readonly JqlToken[]): string {
  let out = "";
  tokens.forEach((t, idx) => {
    const prevTok = tokens[idx - 1];
    const noSpace = idx === 0 || t.type === "comma" || (t.type === "paren" && t.text === ")") || (prevTok?.type === "paren" && prevTok.text === "(") || (t.type === "paren" && t.text === "(" && prevTok?.type === "function");
    out += (noSpace ? "" : " ") + tokenText(t);
  });
  return out;
}

function renderInline(nodes: readonly Node[]): string {
  return nodes
    .map((n) => {
      switch (n.kind) {
        case "clause":
        case "order":
          return renderTokens(n.tokens);
        case "bool":
          return tokenText(n.token);
        case "group":
          return `${n.not ? `${tokenText(n.not)} ` : ""}(${renderInline(n.children)})`;
      }
    })
    .join(" ");
}

function renderBlock(nodes: readonly Node[], indent: number, width: number): string[] {
  const pad = " ".repeat(indent);
  const inline = renderInline(nodes);
  const hasOrder = nodes.some((n) => n.kind === "order");
  if (!hasOrder && indent + inline.length <= width) return [pad + inline];
  const lines: string[] = [];
  let pendingBool = "";
  for (const n of nodes) {
    if (n.kind === "bool") {
      pendingBool = `${tokenText(n.token)} `;
      continue;
    }
    if (n.kind === "group") {
      const head = `${pad}${pendingBool}${n.not ? `${tokenText(n.not)} ` : ""}`;
      const one = `${head}(${renderInline(n.children)})`;
      if (one.length <= width) lines.push(one);
      else lines.push(`${head}(`, ...renderBlock(n.children, indent + 2, width), `${pad})`);
    } else {
      lines.push(`${pad}${pendingBool}${renderTokens(n.tokens)}`);
    }
    pendingBool = "";
  }
  return lines;
}

export type FormatResult = { ok: true; text: string; changed: boolean } | { ok: false; reason: string };

/** Pretty-prints a JQL query: one AND/OR clause per line once it's too long for one, groups indented, keywords uppercased. */
export function formatJql(query: string, width = 80): FormatResult {
  const all = tokenizeJql(query);
  if (all.some((t) => (t as JqlToken & { unterminated?: boolean }).unterminated)) return { ok: false, reason: "A quoted string isn't closed." };
  let depth = 0;
  for (const t of all) {
    if (t.type !== "paren") continue;
    depth += t.text === "(" ? 1 : -1;
    if (depth < 0) break;
  }
  if (depth !== 0) return { ok: false, reason: "The parentheses don't match." };
  const significant = all.filter((t) => t.type !== "space");
  if (significant.length === 0) return { ok: true, text: query, changed: false };
  const text = renderBlock(parseLevel(significant, 0, true).nodes, 0, width).join("\n");
  if (!sameJql(query, text)) return { ok: false, reason: "This query couldn't be formatted safely." };
  return { ok: true, text, changed: text !== query };
}

/** Whether a provider's query is JQL (and so gets highlighting and Format). `jira-project` and `filesystem` queries are JSON objects, not JQL. */
export function isJqlProvider(provider: string): boolean {
  return provider === "jira-work" || provider === "jira-idea";
}
