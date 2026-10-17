import { createContext, useContext, useSyncExternalStore } from "react";
import type { ThemeController, ThemePreference } from "./theme-controller.js";

/** `null` outside `main.tsx` (component tests render `App` bare), in which case the theme switch simply isn't shown. */
export const ThemeControllerContext = createContext<ThemeController | null>(null);

export function useThemePreference(): { controller: ThemeController | null; preference: ThemePreference | null } {
  const controller = useContext(ThemeControllerContext);
  const preference = useSyncExternalStore(
    (onChange) => (controller ? controller.subscribe(onChange) : () => undefined),
    () => (controller ? controller.preference() : null),
  );
  return { controller, preference };
}
