/**
 * local/ui — a read-only, highlighted query for a rule card's summary.
 * Uses the same tokens as the editor (`view-model/jql.ts`), so a query is
 * coloured the same in both. Long JQL is shown formatted (one clause per
 * line); what's stored is never changed by displaying it.
 */
import { formatJql, tokenizeJql } from "../../view-model/jql.js";

export function JqlCode({ query, pretty = true }: { query: string; pretty?: boolean }) {
  const formatted = pretty ? formatJql(query) : null;
  const text = formatted?.ok ? formatted.text : query;
  const tokens = tokenizeJql(text);
  const content = tokens.map((t) =>
    t.type === "space" ? (
      t.text
    ) : (
      <span key={t.from} className={`rt-jql rt-jql--${t.type}`}>
        {t.text}
      </span>
    ),
  );
  return text.includes("\n") ? (
    <pre className="rt-query rt-query--block" data-testid="rule-query-code">
      {content}
    </pre>
  ) : (
    <code className="rt-query" data-testid="rule-query-code">
      {content}
    </code>
  );
}
