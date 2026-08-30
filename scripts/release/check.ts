import { evaluate } from "./gate.js";
import { gatherFacts } from "./facts.js";

const base = process.env.RELEASE_BASE ?? "origin/main";
const facts = gatherFacts(base);
const r = evaluate(facts);

console.log(`\nrelease gate — base ${base}, ${facts.changedFiles.length} file(s) changed, release ${r.required ? "REQUIRED" : "not required"}`);
for (const v of r.verdicts) console.log(`  ${v.ok ? "✓" : "✗"} ${v.reason}`);
if (!r.ok) {
  console.log(`\nFAILED. Rules: package.json's version stays unchanged on a branch; no new CHANGELOG.md heading; at least one changelog.d/*.md fragment; BREAKING ⇔ "bump: major"; schema change ⇒ fragments declare ≥ minor. The version is assigned at MERGE time by the release workflow.`);
  process.exit(1);
}
console.log(`\nOK${r.bump ? ` — highest declared bump: ${r.bump}` : ""}.`);
