/**
 * FACTORY-614: `@launchpad-ui/tokens`' `themes.css` ships exactly one
 * explicit switch — a `[data-theme='dark']` selector overriding the plain
 * `:root` (light) values — with NO `prefers-color-scheme` media query of
 * its own (confirmed by reading `dist/themes.css` in the published
 * package: light tokens sit on bare `:root`, dark tokens sit behind the
 * attribute selector alone). Respecting the OS preference is therefore
 * this app's own job, not something importing the CSS buys for free. This
 * module is the pure half of that: given a "does the system prefer dark"
 * reading, decide the `data-theme` attribute value — `main.tsx` is the
 * thin, untested-by-necessity half that reads `window.matchMedia` and
 * writes `document.documentElement.dataset.theme`.
 *
 * Deliberately no toggle: the ticket's own instruction is "respect
 * prefers-color-scheme, no toggle yet" — `watchSystemTheme` only ever
 * reacts to the OS signal, never to a user control that doesn't exist.
 */
export function systemThemeAttr(prefersDark: boolean): "dark" | undefined {
  return prefersDark ? "dark" : undefined;
}

/** The narrow slice of `MediaQueryList` this module needs — a real one satisfies it; a test passes a fake. */
export interface ThemeMediaQuery {
  matches: boolean;
  addEventListener(type: "change", listener: (event: { matches: boolean }) => void): void;
  removeEventListener(type: "change", listener: (event: { matches: boolean }) => void): void;
}

/**
 * Applies the current reading immediately, then keeps applying it as the
 * OS preference changes for as long as the returned unsubscribe function
 * is not called (`main.tsx` never calls it — this app has no unmount of
 * its own root — but the symmetry is kept so a future caller, or a test,
 * can clean up).
 */
export function watchSystemTheme(media: ThemeMediaQuery, apply: (attr: "dark" | undefined) => void): () => void {
  apply(systemThemeAttr(media.matches));
  const onChange = (event: { matches: boolean }) => apply(systemThemeAttr(event.matches));
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}
