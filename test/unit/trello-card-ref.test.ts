import { describe, expect, test } from "bun:test";
import { formatTrelloCardRef, isTrelloCardRef, isTrelloId, parseTrelloCardRef } from "../../src/resources/trello-card-ref.js";

const BOARD = "5f".padEnd(24, "0");
const CARD = "6a".padEnd(24, "1");

describe("trello card identity", () => {
  test("<boardId>#<cardId> is canonical and round-trips", () => {
    expect(formatTrelloCardRef({ boardId: BOARD, cardId: CARD })).toBe(`${BOARD}#${CARD}`);
    expect(parseTrelloCardRef(`${BOARD}#${CARD}`)).toEqual({ boardId: BOARD, cardId: CARD });
    expect(isTrelloCardRef(`${BOARD}#${CARD}`)).toBe(true);
  });

  test("ids must be exactly 24 lowercase-hex characters", () => {
    expect(isTrelloId(BOARD)).toBe(true);
    for (const bad of [BOARD.toUpperCase(), BOARD.slice(0, 23), `${BOARD}0`, `${BOARD.slice(0, 23)}g`, ""]) {
      expect(isTrelloId(bad)).toBe(false);
    }
  });

  test("parse rejects anything not in canonical form", () => {
    for (const bad of [`${BOARD}#${CARD}#x`, `#${CARD}`, `${BOARD}#`, CARD, `${BOARD.toUpperCase()}#${CARD}`, `${BOARD}#${CARD.toUpperCase()}`]) {
      expect(parseTrelloCardRef(bad)).toBeNull();
      expect(isTrelloCardRef(bad)).toBe(false);
    }
  });

  test("format refuses an invalid ref rather than producing a non-canonical string", () => {
    expect(() => formatTrelloCardRef({ boardId: "short", cardId: CARD })).toThrow("invalid Trello card reference");
  });
});
