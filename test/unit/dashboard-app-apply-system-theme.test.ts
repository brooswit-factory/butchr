import { describe, expect, test } from "bun:test";
import { systemThemeAttr, watchSystemTheme, type ThemeMediaQuery } from "../../dashboard-app/src/theme/apply-system-theme.js";

function fakeMedia(initialMatches: boolean): ThemeMediaQuery & { fire: (matches: boolean) => void } {
  let listener: ((e: { matches: boolean }) => void) | null = null;
  return {
    matches: initialMatches,
    addEventListener: (_type, l) => {
      listener = l;
    },
    removeEventListener: (_type, l) => {
      if (listener === l) listener = null;
    },
    fire: (matches: boolean) => listener?.({ matches }),
  };
}

describe("systemThemeAttr (pure) — FACTORY-614", () => {
  test("dark preference -> 'dark'", () => {
    expect(systemThemeAttr(true)).toBe("dark");
  });
  test("light (or no) preference -> undefined (the tokens' bare :root default, no explicit attribute needed)", () => {
    expect(systemThemeAttr(false)).toBeUndefined();
  });
});

describe("watchSystemTheme — FACTORY-614", () => {
  test("applies the current reading immediately, without waiting for a change event", () => {
    const media = fakeMedia(true);
    const applied: (string | undefined)[] = [];
    watchSystemTheme(media, (attr) => applied.push(attr));
    expect(applied).toEqual(["dark"]);
  });

  test("re-applies on every subsequent OS preference change — no toggle UI, purely reactive to prefers-color-scheme", () => {
    const media = fakeMedia(false);
    const applied: (string | undefined)[] = [];
    watchSystemTheme(media, (attr) => applied.push(attr));
    media.fire(true);
    media.fire(false);
    expect(applied).toEqual([undefined, "dark", undefined]);
  });

  test("the returned unsubscribe stops further updates", () => {
    const media = fakeMedia(false);
    const applied: (string | undefined)[] = [];
    const unsubscribe = watchSystemTheme(media, (attr) => applied.push(attr));
    unsubscribe();
    media.fire(true);
    expect(applied).toEqual([undefined]);
  });
});
