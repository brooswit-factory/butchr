/**
 * local/ui — the theme pieces: the System/Light/Dark
 * controller, the icon-sprite loader, and the sidebar's theme switch.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { withDom } from "../setup/happy-dom.js";
import { createThemeController, readThemePreference, resolveTheme, THEME_STORAGE_KEY, type ThemeMediaQueryLike } from "../../dashboard-app/src/theme/theme-controller.js";
import { ThemeControllerContext } from "../../dashboard-app/src/theme/theme-context.js";
import { ICON_SPRITE_ID, injectIconSprite, loadIconSprite } from "../../dashboard-app/src/theme/icon-sprite.js";
import { ThemeSwitch } from "../../dashboard-app/src/components/ThemeSwitch.js";

withDom();
afterEach(() => {
  cleanup();
  document.getElementById(ICON_SPRITE_ID)?.remove();
});

function fakeMedia(matches: boolean): ThemeMediaQueryLike & { set(v: boolean): void; listeners: number } {
  const listeners = new Set<() => void>();
  return {
    matches,
    addEventListener: (_t, l) => listeners.add(l),
    removeEventListener: (_t, l) => listeners.delete(l),
    set(v) {
      this.matches = v;
      for (const l of listeners) l();
    },
    get listeners() {
      return listeners.size;
    },
  };
}

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), data };
}

describe("theme controller", () => {
  test("resolveTheme and readThemePreference", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("default");
    expect(resolveTheme("dark", false)).toBe("dark");
    expect(readThemePreference(memoryStorage({ [THEME_STORAGE_KEY]: "dark" }))).toBe("dark");
    expect(readThemePreference(memoryStorage({ [THEME_STORAGE_KEY]: "purple" }))).toBe("system");
    expect(readThemePreference(undefined)).toBe("system");
    expect(
      readThemePreference({
        getItem: () => {
          throw new Error("blocked");
        },
      }),
    ).toBe("system");
  });

  test("always writes data-theme, follows the OS on system, persists explicit choices", () => {
    const root = { dataset: {} as DOMStringMap };
    const media = fakeMedia(false);
    const storage = memoryStorage();
    const controller = createThemeController({ root, storage, media });
    expect(root.dataset["theme"]).toBe("default");
    media.set(true);
    expect(root.dataset["theme"]).toBe("dark");
    let notified = 0;
    const unsubscribe = controller.subscribe(() => notified++);
    controller.setPreference("default");
    expect([root.dataset["theme"], controller.preference(), controller.resolved(), storage.data.get(THEME_STORAGE_KEY), notified]).toEqual(["default", "default", "default", "default", 1]);
    media.set(false);
    media.set(true);
    expect(root.dataset["theme"]).toBe("default");
    unsubscribe();
    controller.dispose();
    expect(media.listeners).toBe(0);
  });

  test("a storage that throws on write doesn't break the switch", () => {
    const root = { dataset: {} as DOMStringMap };
    const controller = createThemeController({
      root,
      storage: {
        getItem: () => null,
        setItem: () => {
          throw new Error("quota");
        },
      },
      media: fakeMedia(false),
    });
    controller.setPreference("dark");
    expect(root.dataset["theme"]).toBe("dark");
  });
});

describe("icon sprite", () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><symbol id="lp-icon-add"><path d="M0 0"/></symbol></svg>';

  test("injects the sprite once, hidden", () => {
    expect(injectIconSprite(svg, document)).toBe(true);
    const sprite = document.getElementById(ICON_SPRITE_ID)!;
    expect(sprite.style.display).toBe("none");
    expect(sprite.querySelector("#lp-icon-add")).toBeTruthy();
    expect(injectIconSprite(svg, document)).toBe(false);
  });

  test("ignores non-SVG text and failed fetches", async () => {
    expect(injectIconSprite("<html></html>", document)).toBe(false);
    expect(await loadIconSprite("/sprite.svg", document, (async () => new Response("nope", { status: 404 })) as unknown as typeof fetch)).toBe(false);
    expect(
      await loadIconSprite("/sprite.svg", document, (async () => {
        throw new Error("offline");
      }) as unknown as typeof fetch),
    ).toBe(false);
    expect(await loadIconSprite("/sprite.svg", document, (async () => new Response(svg)) as unknown as typeof fetch)).toBe(true);
  });
});

describe("ThemeSwitch", () => {
  test("renders nothing without a controller", () => {
    const { container } = render(<ThemeSwitch />);
    expect(container.innerHTML).toBe("");
  });

  test("switches the theme", async () => {
    const root = { dataset: {} as DOMStringMap };
    const controller = createThemeController({ root, storage: memoryStorage(), media: fakeMedia(false) });
    const { getByRole } = render(
      <ThemeControllerContext.Provider value={controller}>
        <ThemeSwitch />
      </ThemeControllerContext.Provider>,
    );
    fireEvent.click(getByRole("radio", { name: "Dark theme" }));
    await waitFor(() => expect(root.dataset["theme"]).toBe("dark"));
    expect(getByRole("radio", { name: "Dark theme" }).getAttribute("aria-checked")).toBe("true");
  });
});
