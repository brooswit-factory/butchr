/**
 * One-off vendoring script for BUTCHR-250's `estimateStoredLength` (src/tools/docs.ts).
 *
 * Fetches the W3C HTML 4.01 spec's own machine-readable entity declarations
 * (§24.2 ISO 8859-1, §24.3 symbols/math/Greek, §24.4 markup-significant and
 * internationalization characters — https://www.w3.org/TR/html4/sgml/entities.html)
 * and regenerates src/tools/html4-named-entities.generated.ts from them.
 *
 * WHY THIS EXISTS AS A SCRIPT RATHER THAN A HAND-TYPED TABLE (BUTCHR-250's PR
 * #299 review, second round): a hand-transcribed table of ~250 entries is
 * exactly the kind of thing a transcription error hides in silently. This
 * script parses the spec's own `<!ENTITY name CDATA "&#code;">` declarations
 * mechanically instead — the codepoint-to-name mapping is exactly what the
 * spec says, not what someone typed from memory.
 *
 * NOT part of `bun run check`/`bun run generate` (unlike test/load's
 * generator): this one requires network access to a spec that does not
 * change, so it is a manual, occasional re-vendor step, not a routine build
 * step. Run it again only if this table is ever suspected of drifting from
 * the spec (it will not — HTML 4.01 is a closed, frozen document) or if
 * Confluence's storage layer is later measured encoding a WIDER set than
 * this (see estimateStoredLength's own doc comment for that residual).
 *
 * Run: `bun run scripts/vendor/html4-entities.ts`
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE_URL = "https://www.w3.org/TR/html4/sgml/entities.html";
const OUT_PATH = join(import.meta.dir, "..", "..", "src/tools/html4-named-entities.generated.ts");

async function main() {
  const res = await fetch(SOURCE_URL);
  if (!res.ok) throw new Error(`fetch ${SOURCE_URL}: HTTP ${res.status}`);
  const html = await res.text();

  // The declarations live inside <pre> blocks as HTML-escaped SGML text
  // (e.g. "&lt;!ENTITY nbsp CDATA &quot;&amp;#160;&quot; -- ... --&gt;").
  // Un-escape the 5 XML-predefined escapes only (this source file uses no
  // others to encode its own SGML text) — deliberately NOT the 252-entry
  // table this whole script exists to derive; that would be circular.
  const unescaped = html
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&"); // must be last — the others' replacements introduce no new "&amp;"
  const pattern = /<!ENTITY\s+(\S+)\s+CDATA\s+"&#(\d+);"/g;
  const entries: Array<[number, string]> = [];
  const seenNames = new Set<string>();
  const seenCodes = new Set<number>();
  for (const m of unescaped.matchAll(pattern)) {
    const name = m[1]!;
    const code = Number(m[2]);
    if (seenNames.has(name)) throw new Error(`duplicate entity name in source: ${name}`);
    if (seenCodes.has(code)) throw new Error(`duplicate codepoint in source: ${code}`);
    seenNames.add(name);
    seenCodes.add(code);
    entries.push([code, name]);
  }
  if (entries.length < 200 || entries.length > 300) {
    // HTML 4.01 defines exactly 252 of these. A wildly different count means
    // the page structure changed and this parser needs a re-look, not a
    // silent acceptance of whatever it found.
    throw new Error(`parsed ${entries.length} entities from ${SOURCE_URL} — expected ~252; refusing to write a table this far off spec`);
  }
  entries.sort((a, b) => a[0] - b[0]);

  const body = entries.map(([code, name]) => `  [${code}, "${name}"],`).join("\n");
  const out = `// GENERATED — do not hand-edit. Regenerate with \`bun run scripts/vendor/html4-entities.ts\`.
// Source: ${SOURCE_URL} (HTML 4.01 §24.2/24.3/24.4 — a closed, frozen spec).
// ${entries.length} entries: Unicode codepoint -> the HTML4 named entity for it.
// Consumed by estimateStoredLength (src/tools/docs.ts) — see that function's
// own doc comment for what this table is for and what it does not cover.

export const HTML4_NAMED_ENTITIES: ReadonlyArray<readonly [number, string]> = [
${body}
];
`;
  writeFileSync(OUT_PATH, out);
  console.log(`wrote ${entries.length} entities to ${OUT_PATH}`);
}

main();
