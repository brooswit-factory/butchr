export interface Semver { major: number; minor: number; patch: number }
export type Bump = "major" | "minor" | "patch";

export function parse(v: string): Semver | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  return m ? { major: +m[1]!, minor: +m[2]!, patch: +m[3]! } : null;
}
export const fmt = (v: Semver) => `${v.major}.${v.minor}.${v.patch}`;

export function compare(a: Semver, b: Semver): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

/**
 * Which single component was bumped, with lower ones reset — or null if the
 * step is not a legal bump (0.1.0→0.3.0, 0.1.0→0.2.1, 0.1.0→0.1.0, backwards).
 */
export function bumpKind(from: Semver, to: Semver): Bump | null {
  if (to.major === from.major + 1 && to.minor === 0 && to.patch === 0) return "major";
  if (to.major === from.major && to.minor === from.minor + 1 && to.patch === 0) return "minor";
  if (to.major === from.major && to.minor === from.minor && to.patch === from.patch + 1) return "patch";
  return null;
}
