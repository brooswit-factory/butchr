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
 * Confluence's storage layer is later measured encoding a WIDER (or
 * narrower) set than this (see estimateStoredLength's own doc comment).
 *
 * EXCLUDES 4 CODEPOINTS THE SPEC DEFINES BUT THIS SURFACE MUST NOT ENCODE
 * (BUTCHR-250 PR #299 review, THIRD round): `quot` (34, `"`), `amp` (38,
 * `&`), `lt` (60, `<`), `gt` (62, `>`). Confluence's storage format is
 * ITSELF XHTML — these four characters are that format's own markup syntax
 * (the angle brackets of `<p>`, the quotes around an attribute value, the
 * leading `&` of an entity reference already present) and are NOT re-encoded
 * on round-trip; encoding them would corrupt the markup. MEASURED, not
 * assumed: a real 54,824-character stored body containing 160 literal `&`,
 * 953 literal `<`, 953 literal `>` and 30 literal `"` read back
 * byte-identical (zero diff opcodes) after its last write. The other 248
 * entries were checked for the same kind of storage-syntax significance and
 * found clean: HTML4's named-entity set defines no entity for `'`
 * (apostrophe/U+0027 — commonly assumed as a fifth XML-predefined escape,
 * `&apos;` is an XHTML/XML addition, not part of the classic HTML4 §24 set,
 * confirmed absent from this table both before and after this exclusion)
 * and no entity for any of `=`, `/`, `;` (attribute-equals, self-closing
 * slash, entity-reference terminator) — none of those four are HTML4 named
 * entities at all, so none could have been in this table regardless.
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

  // Storage-syntax exclusion (see this file's own header comment for the
  // measurement and the full reasoning): these 4 codepoints are Confluence
  // storage-format markup itself, not content this surface re-encodes.
  const STORAGE_SYNTAX_CODEPOINTS = new Set([34, 38, 60, 62]); // " & < >
  const before = entries.length;
  const filtered = entries.filter(([code]) => !STORAGE_SYNTAX_CODEPOINTS.has(code));
  const excluded = before - filtered.length;
  if (excluded !== STORAGE_SYNTAX_CODEPOINTS.size) {
    // Every excluded codepoint must actually have been present to exclude —
    // if the spec ever stops defining one of these (it will not; they are
    // among the oldest and most stable of the 252), silently "excluding"
    // zero of them is not the same as confirming the table is now clean.
    throw new Error(`expected to exclude exactly ${STORAGE_SYNTAX_CODEPOINTS.size} storage-syntax codepoints, actually excluded ${excluded}`);
  }
  const entriesFinal = filtered;
  entriesFinal.sort((a, b) => a[0] - b[0]);

  const body = entriesFinal.map(([code, name]) => `  [${code}, "${name}"],`).join("\n");
  const out = `// GENERATED — do not hand-edit. Regenerate with \`bun run scripts/vendor/html4-entities.ts\`.
// Source: ${SOURCE_URL} (HTML 4.01 §24.2/24.3/24.4 — a closed, frozen spec).
// ${entriesFinal.length} entries (of the spec's ${entries.length}; see this
// generator's own header comment for the ${STORAGE_SYNTAX_CODEPOINTS.size}
// storage-syntax codepoints deliberately excluded and why):
// Unicode codepoint -> the HTML4 named entity for it.
// Consumed by estimateStoredLength (src/tools/docs.ts) — see that function's
// own doc comment for what this table is for and what it does not cover.

export const HTML4_NAMED_ENTITIES: ReadonlyArray<readonly [number, string]> = [
${body}
];
`;
  writeFileSync(OUT_PATH, out);
  console.log(`wrote ${entriesFinal.length} entities to ${OUT_PATH} (excluded ${excluded} storage-syntax codepoints of ${entries.length} parsed)`);
}

main();
