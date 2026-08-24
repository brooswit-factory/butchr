import { execSync } from "node:child_process";
const out = execSync("git status --porcelain -- test/load", { encoding: "utf8" }).trim();
if (out) {
  console.error("test/load is out of date — run `bun run generate` and commit:\n" + out);
  process.exit(1);
}
console.log("test/load matches its sources");
