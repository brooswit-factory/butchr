import { parseSections, type Section } from "./changelog.js";
import type { Bump } from "./semver.js";

/** A `changelog.d/<TICKET>.md` fragment: `bump: <level>` on its own line, then `### <Section>` blocks. */
export interface Fragment { path: string; bump: Bump | null; sections: Partial<Record<Section, string[]>> }

const BUMP_RE = /^bump:\s*(major|minor|patch)\s*$/m;

export function parseFragment(path: string, content: string): Fragment {
  const bump = (BUMP_RE.exec(content)?.[1] as Bump | undefined) ?? null;
  return { path, bump, sections: parseSections(content) };
}

export const hasBreaking = (f: Fragment) => !!f.sections.BREAKING?.length;

const RANK: Record<Bump, number> = { patch: 0, minor: 1, major: 2 };

/** The highest declared bump among several fragments, or null if none declare a valid one. */
export function highestBump(fragments: Fragment[]): Bump | null {
  let best: Bump | null = null;
  for (const f of fragments) if (f.bump && (!best || RANK[f.bump] > RANK[best])) best = f.bump;
  return best;
}
