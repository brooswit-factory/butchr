export const SECTIONS = ["BREAKING", "Added", "Changed", "Fixed", "Removed"] as const;
export type Section = (typeof SECTIONS)[number];

export interface Entry { version: string; date: string; sections: Partial<Record<Section, string[]>>; raw: string }

/** Every `## [x.y.z] - YYYY-MM-DD` entry, newest first, with its bullet lines by section. */
export function parseChangelog(md: string): Entry[] {
  const entries: Entry[] = [];
  const re = /^## \[(\d+\.\d+\.\d+)\] - (\d{4}-\d{2}-\d{2})\s*$/gm;
  const heads = [...md.matchAll(re)];
  heads.forEach((h, i) => {
    const start = h.index! + h[0].length;
    const end = heads[i + 1]?.index ?? md.length;
    const raw = md.slice(start, end).trim();
    const sections: Entry["sections"] = {};
    let cur: Section | null = null;
    for (const line of raw.split("\n")) {
      const sec = /^### (\w+)\s*$/.exec(line);
      if (sec) { cur = (SECTIONS as readonly string[]).includes(sec[1]!) ? (sec[1] as Section) : null; continue; }
      const bullet = /^\s*[-*] (.+)$/.exec(line);
      if (bullet && cur) (sections[cur] ??= []).push(bullet[1]!);
    }
    entries.push({ version: h[1]!, date: h[2]!, sections, raw });
  });
  return entries;
}

export const hasContent = (e: Entry) => Object.values(e.sections).some((b) => b && b.length > 0);
