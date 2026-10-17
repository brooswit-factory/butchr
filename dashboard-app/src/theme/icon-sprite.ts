/**
 * local/ui — LaunchPad's `<Icon name="…">` renders `<use href="#lp-icon-…">`,
 * a same-document reference, so the icon sprite has to live inside the page
 * itself. So: fetch the sprite once, parse it, and
 * append it (hidden) to `<body>`. `main.tsx` passes the Vite-resolved URL
 * (`@launchpad-ui/icons/sprite.svg?url`, which respects the app's `base`).
 */
export const ICON_SPRITE_ID = "lp-icons-sprite";

/** Idempotent: a second call (StrictMode, hot reload) leaves the first sprite in place. */
export function injectIconSprite(svgText: string, doc: Document): boolean {
  if (doc.getElementById(ICON_SPRITE_ID)) return false;
  const parsed = new DOMParser().parseFromString(svgText, "image/svg+xml").documentElement;
  if (parsed.nodeName.toLowerCase() !== "svg") return false;
  const sprite = doc.importNode(parsed, true) as unknown as SVGSVGElement;
  sprite.id = ICON_SPRITE_ID;
  sprite.setAttribute("aria-hidden", "true");
  sprite.style.display = "none";
  doc.body.appendChild(sprite);
  return true;
}

export async function loadIconSprite(spriteUrl: string, doc: Document, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const response = await fetchImpl(spriteUrl);
    if (!response.ok) return false;
    return injectIconSprite(await response.text(), doc);
  } catch {
    // Icons are decorative here; every control also has a text label.
    return false;
  }
}
