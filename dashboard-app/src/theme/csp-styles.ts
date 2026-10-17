/**
 * local/ui — butchr serves the dashboard with `style-src 'self'`, which blocks
 * the `<style>` tag style-mod (CodeMirror's style injector) puts in a
 * document's head, so the query editor rendered without its base theme.
 * style-mod already uses a constructed, adopted stylesheet for shadow roots,
 * and a constructed sheet isn't inline style, so the CSP allows it. This
 * sends document-level mounts down that same path: style-mod is handed a
 * stand-in root with no `head` that reads and writes the document's
 * `adoptedStyleSheets`. Call it before the first `EditorView` is created.
 */
import { StyleModule } from "style-mod";

const standIns = new WeakMap<Document, Document>();
let patched = false;

/** Returns whether `doc`'s mounts now use an adopted stylesheet (false where constructed stylesheets aren't supported, which keeps style-mod's own behaviour). */
export function installCspSafeStyleMount(doc: Document = document): boolean {
  if (standIns.has(doc)) return true;
  const win = doc.defaultView;
  if (!win || typeof win.CSSStyleSheet !== "function" || !Array.isArray(doc.adoptedStyleSheets)) return false;
  standIns.set(doc, {
    ownerDocument: doc,
    get adoptedStyleSheets(): CSSStyleSheet[] {
      return doc.adoptedStyleSheets;
    },
    set adoptedStyleSheets(sheets: CSSStyleSheet[]) {
      doc.adoptedStyleSheets = sheets;
    },
  } as unknown as Document);
  if (!patched) {
    const mount = StyleModule.mount.bind(StyleModule);
    StyleModule.mount = (root, modules, options) => mount(standIns.get(root as Document) ?? root, modules, options);
    patched = true;
  }
  return true;
}
