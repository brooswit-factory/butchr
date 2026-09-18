/**
 * The `zendesk-ticket` provider's resource identity, dependency-free so the
 * agent key codec (src/rules/agent-key.ts) can import it without loading the
 * Zendesk client.
 *
 * A ticket is `<subdomain>#<id>`: a ticket id is only unique within one
 * Zendesk account, so the account is part of the identity. An agent keyed
 * under one subdomain is never matched, read or written under another — a
 * changed `ZENDESK_SUBDOMAIN` stops old agents rather than pointing them at
 * whatever ticket shares their number.
 */

/** A Zendesk subdomain as it appears in `<subdomain>.zendesk.com`: lowercase alphanumerics and inner hyphens. */
const SUBDOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const ID_RE = /^[1-9][0-9]{0,15}$/;

export interface ZendeskTicketRef { subdomain: string; id: number }

export const isZendeskSubdomain = (subdomain: string): boolean => SUBDOMAIN_RE.test(subdomain);

/** True only for the canonical form `formatZendeskTicketRef` produces. */
export function isZendeskTicketRef(id: string): boolean {
  return parseZendeskTicketRef(id) !== null;
}

export function formatZendeskTicketRef(ref: ZendeskTicketRef): string {
  const id = `${ref.subdomain}#${ref.id}`;
  if (!isZendeskTicketRef(id)) throw new Error(`invalid Zendesk ticket reference: ${JSON.stringify(id)}`);
  return id;
}

/** Inverse of `formatZendeskTicketRef`; `null` for anything not in canonical form. */
export function parseZendeskTicketRef(id: string): ZendeskTicketRef | null {
  const m = /^([^#]+)#([^#]+)$/.exec(id);
  if (!m || !isZendeskSubdomain(m[1]!) || !ID_RE.test(m[2]!)) return null;
  const n = Number(m[2]);
  return Number.isSafeInteger(n) ? { subdomain: m[1]!, id: n } : null;
}
