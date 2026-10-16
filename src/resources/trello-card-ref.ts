/**
 * The `trello-card` provider's resource identity, dependency-free so the
 * agent key codec (src/rules/agent-key.ts) can import it without loading the
 * Trello client — the same split `zendesk-ticket-ref.ts` makes for its own
 * provider.
 *
 * A card is `<boardId>#<cardId>`. Trello card and board ids are both Mongo
 * ObjectIds (24 lowercase-hex characters) and are globally unique by
 * themselves — unlike a Zendesk ticket id, a Trello card id alone would
 * already resolve uniquely. The board is still carried in the identity and
 * enforced at the client boundary (see trello-card.ts's `get`/`comments`)
 * for the same reason zendesk-ticket enforces its subdomain: this provider
 * is configured for exactly one board (`TRELLO_BOARD_ID`), and a card that
 * is technically readable with the configured credentials but lives on a
 * DIFFERENT board must be refused rather than silently served — a changed
 * `TRELLO_BOARD_ID` stops old agents rather than pointing them at whatever
 * card elsewhere happens to share no id at all (ids don't collide, but nothing
 * about this provider should ever reach past its one configured board).
 */

/** A Trello object id: lowercase hex, exactly 24 characters (a Mongo ObjectId). */
const ID_RE = /^[0-9a-f]{24}$/;

export interface TrelloCardRef { boardId: string; cardId: string }

export const isTrelloId = (id: string): boolean => ID_RE.test(id);

/** True only for the canonical form `formatTrelloCardRef` produces. */
export function isTrelloCardRef(id: string): boolean {
  return parseTrelloCardRef(id) !== null;
}

export function formatTrelloCardRef(ref: TrelloCardRef): string {
  const id = `${ref.boardId}#${ref.cardId}`;
  if (!isTrelloCardRef(id)) throw new Error(`invalid Trello card reference: ${JSON.stringify(id)}`);
  return id;
}

/** Inverse of `formatTrelloCardRef`; `null` for anything not in canonical form. */
export function parseTrelloCardRef(id: string): TrelloCardRef | null {
  const m = /^([^#]+)#([^#]+)$/.exec(id);
  if (!m || !isTrelloId(m[1]!) || !isTrelloId(m[2]!)) return null;
  return { boardId: m[1]!, cardId: m[2]! };
}
