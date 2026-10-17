/**
 * local/ui — `installCspSafeStyleMount`: under butchr's `style-src 'self'`
 * CSP, CodeMirror's styles must reach the page through an adopted
 * stylesheet, never a `<style>` tag.
 */
import { describe, expect, test } from "bun:test";
import { StyleModule } from "style-mod";
import { withDom } from "../setup/happy-dom.js";
import { installCspSafeStyleMount } from "../../dashboard-app/src/theme/csp-styles.js";

withDom();

describe("installCspSafeStyleMount", () => {
  test("document-level style-mod mounts go to an adopted stylesheet, not a <style> tag", () => {
    expect(installCspSafeStyleMount(document)).toBe(true);
    const styleTags = document.querySelectorAll("style").length;
    StyleModule.mount(document, new StyleModule({ ".csp-probe": { color: "red" } }));
    StyleModule.mount(document, new StyleModule({ ".csp-probe-2": { color: "blue" } }));
    expect(document.querySelectorAll("style").length).toBe(styleTags);
    const rules = document.adoptedStyleSheets.flatMap((sheet) => [...sheet.cssRules].map((rule) => rule.cssText));
    expect(rules.some((rule) => rule.includes(".csp-probe"))).toBe(true);
    expect(rules.some((rule) => rule.includes(".csp-probe-2"))).toBe(true);
    // One shared sheet, however many modules mount.
    expect(document.adoptedStyleSheets.length).toBe(1);
  });

  test("is idempotent, and leaves documents without constructed stylesheets alone", () => {
    expect(installCspSafeStyleMount(document)).toBe(true);
    expect(installCspSafeStyleMount({ defaultView: {}, adoptedStyleSheets: undefined } as unknown as Document)).toBe(false);
    expect(installCspSafeStyleMount({ defaultView: null } as unknown as Document)).toBe(false);
  });
});
