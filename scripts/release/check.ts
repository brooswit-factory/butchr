import { evaluate } from "./gate.js";
import { gatherFacts } from "./facts.js";
import { readFileSync } from "node:fs";

const base = process.env.RELEASE_BASE ?? "origin/main";
const name = JSON.parse(readFileSync("package.json", "utf8")).name as string;
const facts = gatherFacts(base, name);
const r = evaluate(facts);

console.log(`\nrelease gate — base ${base}, ${facts.changedFiles.length} file(s) changed, release ${r.required ? "REQUIRED" : "not required"}`);
for (const v of r.verdicts) console.log(`  ${v.ok ? "✓" : "✗"} ${v.reason}`);
if (!r.ok) {
  console.log(`\nFAILED. Rules: one component +1 with lower ones reset; > published; schema change ⇒ ≥ minor; MAJOR ⇒ ### BREAKING; a new, dated, non-empty CHANGELOG.md entry at the top.`);
  process.exit(1);
}
console.log(`\nOK${r.bump ? ` — ${r.bump} bump to ${facts.version}` : ""}.`);
