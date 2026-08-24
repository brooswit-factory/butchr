import { bumpKind, compare, parse, type Bump } from "./semver.js";
import { hasContent, parseChangelog, type Entry } from "./changelog.js";

export interface Facts {
  /** package.json version on this branch */
  version: string;
  /** package.json version on the base (main) */
  baseVersion: string;
  /** npm registry `latest`, or null if unpublished */
  registryLatest: string | null;
  /** files changed vs base */
  changedFiles: string[];
  /** CHANGELOG.md on this branch and on base */
  changelog: string;
  baseChangelog: string;
  /** did schema/herdr-api.schema.json change vs base */
  schemaChanged: boolean;
  today: string; // YYYY-MM-DD
}

export interface Verdict { ok: boolean; reason: string }
export interface GateResult { required: boolean; bump: Bump | null; verdicts: Verdict[]; ok: boolean }

const GATED = [/^src\//, /^schema\//, /^package\.json$/];
export const requiresRelease = (files: string[]) => files.some((f) => GATED.some((r) => r.test(f)));

export function evaluate(f: Facts): GateResult {
  const required = requiresRelease(f.changedFiles);
  const verdicts: Verdict[] = [];
  const v = (ok: boolean, reason: string) => verdicts.push({ ok, reason });

  const to = parse(f.version);
  if (!to) { v(false, `package.json version "${f.version}" is not x.y.z`); return { required, bump: null, verdicts, ok: false }; }

  const bumped = f.version !== f.baseVersion;
  if (!required) {
    v(!bumped, bumped ? `version changed (${f.baseVersion} → ${f.version}) but no gated file changed — bump only with a real change` : "no gated files changed; no release required");
    return { required, bump: null, verdicts, ok: verdicts.every((x) => x.ok) };
  }

  // 1. must bump
  v(bumped, bumped ? `version ${f.baseVersion} → ${f.version}` : `gated files changed but version is still ${f.baseVersion} — bump it`);
  if (!bumped) return { required, bump: null, verdicts, ok: false };

  // 2. strictly greater than registry
  const reg = f.registryLatest ? parse(f.registryLatest) : null;
  if (reg) v(compare(to, reg) > 0, compare(to, reg) > 0 ? `greater than published ${f.registryLatest}` : `${f.version} is not greater than published ${f.registryLatest}`);

  // 3. exactly one component, lower reset
  const from = parse(f.baseVersion);
  const bump = from ? bumpKind(from, to) : null;
  v(bump !== null, bump ? `a ${bump} bump` : `${f.baseVersion} → ${f.version} is not a single-step bump (one component +1, lower ones reset to 0)`);

  // 4. schema drift ⇒ ≥ minor
  if (f.schemaChanged) v(bump !== "patch", bump !== "patch" ? "schema changed and bump is ≥ minor" : "schema/herdr-api.schema.json changed: that is at least a MINOR bump, not a patch");

  // 5. changelog entry for this version, new in this PR, dated, with content
  const entries = parseChangelog(f.changelog);
  const entry = entries.find((e) => e.version === f.version);
  const inBase = parseChangelog(f.baseChangelog).some((e) => e.version === f.version);
  v(!!entry, entry ? `CHANGELOG.md has [${f.version}]` : `CHANGELOG.md has no "## [${f.version}] - YYYY-MM-DD" entry`);
  if (entry) {
    v(!inBase, inBase ? `[${f.version}] already existed on main — the entry must be new in this PR` : "entry is new in this PR");
    v(entries[0]?.version === f.version, entries[0]?.version === f.version ? "entry is at the top" : `[${f.version}] is not the newest entry in CHANGELOG.md`);
    v(hasContent(entry), hasContent(entry) ? "entry has at least one bullet under a known section" : `[${f.version}] has no bullets under ${["BREAKING","Added","Changed","Fixed","Removed"].join("/")}`);
    v(entry.date <= f.today, entry.date <= f.today ? `dated ${entry.date}` : `dated ${entry.date}, which is in the future`);
    const prev = entries[1];
    if (prev) v(entry.date >= prev.date, entry.date >= prev.date ? "date not before the previous entry" : `dated ${entry.date}, before the previous entry ${prev.date}`);
    // 6. major needs BREAKING
    if (bump === "major") v(!!entry.sections.BREAKING?.length, entry.sections.BREAKING?.length ? "major bump has a BREAKING section" : "a MAJOR bump requires a non-empty ### BREAKING section in its changelog entry");
    if (bump !== "major") v(!entry.sections.BREAKING?.length, !entry.sections.BREAKING?.length ? "no BREAKING section on a non-major bump" : `a ${bump} bump has a BREAKING section — if it breaks things, it is a MAJOR`);
  }
  return { required, bump, verdicts, ok: verdicts.every((x) => x.ok) };
}
