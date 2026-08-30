import { compare, parse, type Bump } from "./semver.js";
import { hasContent, parseChangelog, SECTIONS } from "./changelog.js";
import { hasBreaking, highestBump, type Fragment } from "./fragments.js";

export interface Facts {
  /** package.json version on this branch */
  version: string;
  /** package.json version at the merge-base of this branch and the base */
  baseVersion: string;
  /** package.json version at the base's TIP, for informational "branch is behind" hints only */
  baseTipVersion?: string;
  /** files changed vs base */
  changedFiles: string[];
  /** CHANGELOG.md on this branch and on base */
  changelog: string;
  baseChangelog: string;
  /** did schema/herdr-api.schema.json change vs base */
  schemaChanged: boolean;
  /** changelog.d/*.md fragments added by this branch (new files, not present at the merge-base) */
  newFragments: Fragment[];
  today: string; // YYYY-MM-DD, informational only now — no longer used to date a branch's entry
}

export interface Verdict { ok: boolean; reason: string }
export interface GateResult { required: boolean; bump: Bump | null; verdicts: Verdict[]; ok: boolean }

const GATED = [/^src\//, /^schema\//, /^package\.json$/];
export const requiresRelease = (files: string[]) => files.some((f) => GATED.some((r) => r.test(f)));

/** Every changelog entry version in `changelog` that isn't already in `base` — i.e. a heading this branch added. */
const newHeadings = (changelog: string, base: string) => {
  const baseVersions = new Set(parseChangelog(base).map((e) => e.version));
  return parseChangelog(changelog).filter((e) => !baseVersions.has(e.version));
};

export function evaluate(f: Facts): GateResult {
  const required = requiresRelease(f.changedFiles);
  const verdicts: Verdict[] = [];
  const v = (ok: boolean, reason: string) => verdicts.push({ ok, reason });
  const versionChanged = f.version !== f.baseVersion;

  if (!required) {
    const to = parse(f.version);
    const baseTip = f.baseTipVersion ? parse(f.baseTipVersion) : null;
    const behindBase = baseTip && to && compare(baseTip, to) > 0;
    v(!versionChanged, versionChanged
      ? `version changed (${f.baseVersion} → ${f.version}) but no gated file changed — the version is assigned at MERGE time, not on a branch`
      : behindBase
        ? `no gated files changed; no release required (branch is behind base ${f.baseTipVersion} — merge main when convenient)`
        : "no gated files changed; no release required");
    return { required, bump: null, verdicts, ok: verdicts.every((x) => x.ok) };
  }

  // 1/3. package.json's version must NOT change on a branch — it is assigned at merge time.
  v(!versionChanged, versionChanged
    ? `package.json version changed (${f.baseVersion} → ${f.version}) — remove the bump; the version is assigned at MERGE time by the release workflow, from your changelog.d/ fragment's declared bump level`
    : `package.json version unchanged (${f.baseVersion})`);

  // 4. no "## [x.y.z] - YYYY-MM-DD" heading may be added on a branch — the release workflow writes it at merge time.
  const heading = newHeadings(f.changelog, f.baseChangelog)[0];
  v(!heading, heading
    ? `CHANGELOG.md has a new "## [${heading.version}] - ${heading.date}" heading — remove it; the release workflow writes the dated CHANGELOG heading at merge time from changelog.d/ fragments`
    : "no new CHANGELOG.md heading added");

  // 2. at least one new changelog.d/*.md fragment.
  v(f.newFragments.length > 0, f.newFragments.length > 0
    ? `${f.newFragments.length} new changelog.d/ fragment(s): ${f.newFragments.map((x) => x.path).join(", ")}`
    : `gated files changed but no changelog.d/ fragment was added — create changelog.d/<TICKET>.md starting with "bump: major|minor|patch" on its own line, followed by "### Added"/"### Fixed"/etc. bullets (see changelog.d/README.md)`);

  // 5. per-fragment: a valid declared level, at least one bullet, and BREAKING <=> major.
  for (const frag of f.newFragments) {
    v(frag.bump !== null, frag.bump !== null
      ? `${frag.path} declares bump: ${frag.bump}`
      : `${frag.path} has no valid "bump: major|minor|patch" line`);
    v(hasContent(frag), hasContent(frag)
      ? `${frag.path} has at least one bullet`
      : `${frag.path} has no bullets under a known section (${SECTIONS.join("/")}) — add at least one describing the change`);
    if (!frag.bump) continue;
    const breaking = hasBreaking(frag);
    if (breaking && frag.bump !== "major") v(false, `${frag.path} has a ### BREAKING section but declares "bump: ${frag.bump}" — BREAKING content requires "bump: major"`);
    else if (!breaking && frag.bump === "major") v(false, `${frag.path} declares "bump: major" but has no ### BREAKING section — a MAJOR bump requires one, describing what breaks`);
    else v(true, breaking ? `${frag.path}'s BREAKING content matches its major bump` : `${frag.path}'s ${frag.bump} bump has no BREAKING section`);
  }

  // 5. schema drift ⇒ fragments must declare at least minor.
  if (f.schemaChanged) {
    const highest = highestBump(f.newFragments);
    v(highest !== null && highest !== "patch", highest !== null && highest !== "patch"
      ? `schema/herdr-api.schema.json changed and fragments declare at least minor (${highest})`
      : `schema/herdr-api.schema.json changed: that requires at least a MINOR bump — declare "bump: minor" or higher in a changelog.d/ fragment`);
  }

  return { required, bump: highestBump(f.newFragments), verdicts, ok: verdicts.every((x) => x.ok) };
}
