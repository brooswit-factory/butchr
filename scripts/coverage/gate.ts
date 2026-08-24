import { readFileSync } from "node:fs";
import { pct, totalsOf } from "./lcov.js";
const MIN = Number(process.env.COVERAGE_MIN ?? 90);
const t = totalsOf(readFileSync("coverage/lcov.info", "utf8"));
const l = pct(t.lines), f = pct(t.functions);
console.log(`coverage (whole project, src/generated excluded): lines ${l.toFixed(2)}% (${t.lines.hit}/${t.lines.found})  functions ${f.toFixed(2)}% (${t.functions.hit}/${t.functions.found})  minimum ${MIN}%`);
if (l < MIN || f < MIN) { console.log(`FAILED — under ${MIN}%`); process.exit(1); }
console.log("OK");
