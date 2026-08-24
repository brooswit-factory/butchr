import { readFileSync, writeFileSync } from "node:fs";
import { parseChangelog } from "./changelog.js";
const version = process.argv[2]!;
const e = parseChangelog(readFileSync("CHANGELOG.md", "utf8")).find((x) => x.version === version);
if (!e) { console.error(`no CHANGELOG entry for ${version}`); process.exit(1); }
writeFileSync("release-notes.md", `## ${version} — ${e.date}\n\n${e.raw}\n`);
console.log(`release-notes.md written for ${version}`);
