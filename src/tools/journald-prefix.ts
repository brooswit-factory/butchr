/**
 * BUTCHR-343 (round 3 of closing PR #347's blocker 2/3 review): the ONE
 * transport prefix `parseOutcomeLine` (`src/tools/outcome.ts`) and
 * `parseAliasAuditLine` (`src/tools/alias-audit.ts`) tolerate before a
 * genuine `[tools2]`/`[tools]` tag — shared here, rather than duplicated in
 * both files, because round 2 already showed this is not a trivial pattern
 * to get right twice.
 *
 * WHY THIS EXISTS AT ALL: both readers anchor their tag to the LINE'S OWN
 * first token (see each function's own doc comment for why that anchor is
 * required at all — round 1 of this fix, which merely checked "no other
 * NAMED tag precedes the match," was demonstrated insufficient by a real
 * `src/agents/escalation-loop.ts` line carrying no such tag at all). The one
 * thing legitimately allowed to precede that first token is `journalctl`'s
 * own transport prefix, which this repo's own daemon writes into every real
 * consumer's hands — `scripts/audit-alias-calls.ts` feeds both readers raw
 * `journalctl`-produced lines, and BUTCHR-316's own doc sends human/agent
 * readers to run `journalctl` themselves per their `ENVIRONMENT.md`.
 *
 * ROUND 2's MISTAKE, AND WHY IT MATTERED: it modelled ONLY `journalctl`'s
 * DEFAULT format (`-o short`, e.g. `Sep 10 12:00:01 servyboi bun[123456]: `)
 * — reasoned as "the only format this repo's own code ever invokes it in",
 * true for `scripts/audit-alias-calls.ts`'s own PROGRAMMATIC calls, but not
 * for the HUMAN/AGENT reader BUTCHR-316's own doc explicitly sends to run
 * `journalctl` by hand with whatever flags they like. A genuine `[tools2]`
 * line read with `-o short-iso`/`-o short-precise`/`-o short-full`/… under
 * round 2 silently returned `null` — indistinguishable from "not a record",
 * which is precisely the confusion this whole story exists to keep
 * separate (a missing/malformed read must never read as "checked, found
 * nothing"). MEASURED against this daemon's own real `journalctl --user`
 * output (every literal example below is a genuine captured sample, not
 * invented) before writing the patterns that follow.
 *
 * COVERAGE: every `journalctl --output=` mode that emits ONE LINE PER
 * ENTRY, confirmed against `journalctl --help`'s own enumeration and a real
 * captured sample of each at this module's own time of writing (re-run
 * `journalctl --user -n 2 -o <mode> -q` yourself before trusting a sample
 * below is still accurate):
 *   - `short`         `Sep 11 03:25:21 servyboi bun[641076]: `
 *   - `short-precise`  `Sep 11 03:25:21.756106 servyboi bun[641076]: `
 *   - `short-iso`      `2026-09-11T03:25:21-07:00 servyboi bun[641076]: `
 *   - `short-iso-precise` `2026-09-11T03:25:21.756106-07:00 servyboi bun[641076]: `
 *   - `short-full`     `Fri 2026-09-11 03:25:21 PDT servyboi bun[641076]: `
 *   - `short-unix`     `1789122321.756106 servyboi bun[641076]: `
 *   - `short-monotonic` `[58397.767905] servyboi bun[641076]: `
 *   - `with-unit`      `Fri 2026-09-11 03:25:48 PDT servyboi user@1001.service/butchr.service[641076]: `
 *     (same timestamp shape as `short-full`; its only difference — a
 *     `unit/user-unit[pid]` identifier instead of a bare `ident[pid]` — needs
 *     no extra pattern, since the identifier alternative below already
 *     accepts any non-whitespace token, slashes and dots included)
 *   - `--utc` (combinable with any of the above) changes clock VALUES, never
 *     the FIELD SHAPE, so it needs no pattern of its own — confirmed against
 *     a real `-o short --utc` and `-o short-full --utc` capture, the latter
 *     showing `UTC` land in exactly the same slot `short-full`'s zone-name
 *     field already covers.
 *   - `cat` (no prefix at all) needs no pattern — the whole prefix below is
 *     OPTIONAL, so a line with nothing prepended still anchors.
 *
 * DELIBERATELY OUT OF SCOPE: `verbose`, `export`, `json`, `json-pretty`,
 * `json-sse`, `json-seq` — confirmed by a real `-o verbose` capture to be
 * MULTI-LINE / structured per entry, not one line each. No prefix regex can
 * bring those into a line-oriented reader's model; a caller who reaches for
 * one of those modes gets output that looks nothing like `[tools2] …` on
 * any single line, so unlike the silent-null failure round 2 had, that
 * mismatch is not silent — it is visibly a wholly different shape. Reading
 * either family requires different tooling than these two functions, not a
 * wider prefix pattern.
 */
const TIMESTAMP_ALTERNATIVES = [
  // short (and short --utc): "Sep 11 03:25:21"
  String.raw`[A-Za-z]{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}`,
  // short-precise: "Sep 11 03:25:21.756106"
  String.raw`[A-Za-z]{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\.\d+`,
  // short-iso / short-iso-precise: "2026-09-11T03:25:21-07:00" / "…T03:25:21.756106-07:00" / a trailing "Z"
  String.raw`\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[+-]\d{2}:\d{2}|Z)`,
  // short-full (and --utc, and with-unit's own timestamp): "Fri 2026-09-11 03:25:21 PDT" / "… UTC"
  String.raw`[A-Za-z]{3}\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\s+[A-Za-z]+`,
  // short-monotonic: "[58397.767905]"
  String.raw`\[\d+(?:\.\d+)?\]`,
  // short-unix: "1789122321.756106" — kept LAST: bare digits is the loosest
  // shape here, so every more specific alternative above gets first refusal.
  String.raw`\d+(?:\.\d+)?`,
].join("|");

/**
 * OPTIONAL — matches a genuine `journalctl`-emitted transport prefix in any
 * single-line output mode (see this module's own doc comment for the full
 * list and why the multi-line modes are excluded), or nothing at all (a raw
 * line with no prefix, e.g. this repo's own tests passing `buildLine`'s
 * return value directly, or a caller piping `-o cat`). Interpolate this into
 * a larger pattern anchored with `^`; it is not itself anchored.
 */
export const JOURNALD_PREFIX_SRC = String.raw`(?:(?:${TIMESTAMP_ALTERNATIVES})\s+\S+\s+\S+?(?:\[\d+\])?:\s*)?`;
