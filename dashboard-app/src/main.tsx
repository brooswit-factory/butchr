import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
// local/ui — the full LaunchPad stack, in this order: fonts (Inter,
// served from the tokens package's own woff2 files), structural tokens,
// color themes, then the components' bundled stylesheet, so the app's own
// CSS (imported later through `App.tsx`) wins ties. FACTORY-614's original
// two token imports are kept, just no longer the only ones.
import "@launchpad-ui/tokens/fonts.css";
import "@launchpad-ui/tokens/index.css";
import "@launchpad-ui/tokens/themes.css";
import "@launchpad-ui/components/style.css";
import spriteUrl from "@launchpad-ui/icons/sprite.svg?url";
import butchrMark from "./assets/butchr-mark.png";
import { App } from "./App.js";
import { loadIconSprite } from "./theme/icon-sprite.js";
import { createThemeController } from "./theme/theme-controller.js";
import { ThemeControllerContext } from "./theme/theme-context.js";

function safeLocalStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

const themeController = createThemeController({
  root: document.documentElement,
  storage: safeLocalStorage(),
  media: window.matchMedia("(prefers-color-scheme: dark)"),
});
void loadIconSprite(spriteUrl, document);

// butchr's own icon as the tab favicon (bundled, so it resolves under the app's base path in dev and production alike).
const favicon = document.createElement("link");
favicon.rel = "icon";
favicon.type = "image/png";
favicon.href = butchrMark;
document.head.appendChild(favicon);

const root = document.getElementById("root");
if (!root) throw new Error("dashboard-app: #root element missing from index.html");

createRoot(root).render(
  <StrictMode>
    <BrowserRouter basename="/dashboard-app">
      <ThemeControllerContext.Provider value={themeController}>
        <App />
      </ThemeControllerContext.Provider>
    </BrowserRouter>
  </StrictMode>,
);
