/**
 * local/ui — the theme switch: "system" (follow the OS), "default" (light)
 * or "dark", persisted under `localStorage.theme`. Unlike `apply-system-theme.ts` (kept
 * as-is for upstream), the resolved value is ALWAYS written to
 * `<html data-theme>` — `"default"` for light rather than removing the
 * attribute — so any LaunchPad component CSS keyed on
 * `[data-theme='default']` matches too.
 */
export type ThemePreference = "system" | "default" | "dark";
export type ResolvedTheme = "default" | "dark";

export const THEME_STORAGE_KEY = "theme";
export const THEME_PREFERENCES: readonly ThemePreference[] = ["system", "default", "dark"];

export function resolveTheme(preference: ThemePreference, systemPrefersDark: boolean): ResolvedTheme {
  if (preference === "system") return systemPrefersDark ? "dark" : "default";
  return preference;
}

function isThemePreference(value: unknown): value is ThemePreference {
  return typeof value === "string" && (THEME_PREFERENCES as readonly string[]).includes(value);
}

/** Never throws: private windows and blocked storage read as "system". */
export function readThemePreference(storage: Pick<Storage, "getItem"> | undefined): ThemePreference {
  try {
    const raw = storage?.getItem(THEME_STORAGE_KEY);
    return isThemePreference(raw) ? raw : "system";
  } catch {
    return "system";
  }
}

export interface ThemeMediaQueryLike {
  matches: boolean;
  addEventListener(type: "change", listener: () => void): void;
  removeEventListener(type: "change", listener: () => void): void;
}

export interface ThemeController {
  preference(): ThemePreference;
  resolved(): ResolvedTheme;
  setPreference(preference: ThemePreference): void;
  subscribe(listener: () => void): () => void;
  dispose(): void;
}

export interface ThemeControllerDeps {
  root: { dataset: DOMStringMap };
  storage?: Pick<Storage, "getItem" | "setItem"> | undefined;
  media: ThemeMediaQueryLike;
}

/** Applies the stored preference immediately, then keeps `<html data-theme>` in step with both the switch and the OS setting. */
export function createThemeController({ root, storage, media }: ThemeControllerDeps): ThemeController {
  let preference = readThemePreference(storage);
  const listeners = new Set<() => void>();

  const apply = () => {
    root.dataset["theme"] = resolveTheme(preference, media.matches);
    for (const listener of listeners) listener();
  };
  const onSystemChange = () => {
    if (preference === "system") apply();
  };

  media.addEventListener("change", onSystemChange);
  apply();

  return {
    preference: () => preference,
    resolved: () => resolveTheme(preference, media.matches),
    setPreference(next) {
      preference = next;
      try {
        storage?.setItem(THEME_STORAGE_KEY, next);
      } catch {
        // Storage can be unavailable; the switch still works for this page load.
      }
      apply();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      media.removeEventListener("change", onSystemChange);
      listeners.clear();
    },
  };
}
