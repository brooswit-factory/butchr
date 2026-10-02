import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
// FACTORY-614: `@launchpad-ui/tokens`' two CSS files, imported through Vite
// (the same mechanism `App.css` already uses) — `index.css` is the
// structural tokens (spacing, duration, font family), `themes.css` is the
// color tokens, light on bare `:root` with a `[data-theme='dark']`
// override (see `theme/apply-system-theme.ts` for why that override needs
// JS, not just this import, to track `prefers-color-scheme`). Importing
// `@launchpad-ui/components` (via `App.tsx`'s `Heading`) pulls that
// package's OWN bundled stylesheet as a side effect of its own entry
// module — no separate import needed for it here.
import "@launchpad-ui/tokens/index.css";
import "@launchpad-ui/tokens/themes.css";
import { App } from "./App.js";
import { watchSystemTheme } from "./theme/apply-system-theme.js";

watchSystemTheme(window.matchMedia("(prefers-color-scheme: dark)"), (attr) => {
  if (attr) document.documentElement.dataset.theme = attr;
  else delete document.documentElement.dataset.theme;
});

const root = document.getElementById("root");
if (!root) throw new Error("dashboard-app: #root element missing from index.html");

createRoot(root).render(
  <StrictMode>
    <BrowserRouter basename="/dashboard-app">
      <App />
    </BrowserRouter>
  </StrictMode>,
);
