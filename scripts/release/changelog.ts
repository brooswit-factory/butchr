export const SECTIONS = ["BREAKING", "Added", "Changed", "Fixed", "Removed"] as const;
export type Section = (typeof SECTIONS)[number];

export interface Entry { version: string; date: string; sections: Partial<Record<Section, string[]>>; raw: string }

/** `### <Section>` blocks with `- bullet` lines beneath them, from a fragment or an entry body. */
export function parseSections(raw: string): Partial<Record<Section, string[]>> {
  const sections: Partial<Record<Section, string[]>> = {};
  let cur: Section | null = null;
  for (const line of raw.split("\n")) {
    const sec = /^### (\w+)\s*$/.exec(line);
    if (sec) { cur = (SECTIONS as readonly string[]).includes(sec[1]!) ? (sec[1] as Section) : null; continue; }
    if (!cur) continue;
    const bullet = /^\s*[-*] (.+)$/.exec(line);
    if (bullet) { (sections[cur] ??= []).push(bullet[1]!); continue; }
    // A wrapped bullet: an indented non-bullet line continues the bullet above it.
    const cont = /^\s+(\S.*)$/.exec(line);
    const list = sections[cur];
    if (cont && list?.length) list[list.length - 1] += ` ${cont[1]!.trimEnd()}`;
  }
  return sections;
}

/** Every `## [x.y.z] - YYYY-MM-DD` entry, newest first, with its bullet lines by section. */
export function parseChangelog(md: string): Entry[] {
  const entries: Entry[] = [];
  const re = /^## \[(\d+\.\d+\.\d+)\] - (\d{4}-\d{2}-\d{2})\s*$/gm;
  const heads = [...md.matchAll(re)];
  heads.forEach((h, i) => {
    const start = h.index! + h[0].length;
    const end = heads[i + 1]?.index ?? md.length;
    const raw = md.slice(start, end).trim();
    entries.push({ version: h[1]!, date: h[2]!, sections: parseSections(raw), raw });
  });
  return entries;
}

export const hasContent = (e: { sections: Partial<Record<Section, string[]>> }) => Object.values(e.sections).some((b) => b && b.length > 0);

/** `### Section` / `- bullet` lines collating several sources (fragments), by section, in SECTIONS order — no heading. Shared by `collateEntry` (prefixes a `## [x.y.z] - date` heading, for `CHANGELOG.md`) and `collateNotes` (no heading, for a GitHub Release body). */
function collateSectionLines(sources: { sections: Partial<Record<Section, string[]>> }[]): string[] {
  const lines: string[] = [];
  for (const sec of SECTIONS) {
    const bullets = sources.flatMap((s) => s.sections[sec] ?? []);
    if (bullets.length) {
      lines.push(`### ${sec}`);
      for (const b of bullets) lines.push(`- ${b}`);
    }
  }
  return lines;
}

/** Build a `## [x.y.z] - YYYY-MM-DD` block collating bullets from several sources (fragments), by section, in SECTIONS order. */
export function collateEntry(version: string, date: string, sources: { sections: Partial<Record<Section, string[]>> }[]): string {
  return [`## [${version}] - ${date}`, ...collateSectionLines(sources)].join("\n") + "\n";
}

/** Same bullet collation as `collateEntry`, but with no version/date heading — for a GitHub Release body, which already carries the version in its own title. */
export function collateNotes(sources: { sections: Partial<Record<Section, string[]>> }[]): string {
  return collateSectionLines(sources).join("\n") + "\n";
}

/** Insert a collated entry block just above the first existing `## [x.y.z]` heading (or at the end, if there is none yet). */
export function prependEntry(changelog: string, entryBlock: string): string {
  const idx = changelog.search(/^## \[\d+\.\d+\.\d+\] - \d{4}-\d{2}-\d{2}\s*$/m);
  if (idx === -1) return changelog.trimEnd() + "\n\n" + entryBlock;
  return changelog.slice(0, idx) + entryBlock + "\n" + changelog.slice(idx);
}
