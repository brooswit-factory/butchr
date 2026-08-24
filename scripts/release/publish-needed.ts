import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
let latest = "";
try { latest = execSync(`npm view ${pkg.name} version`, { encoding: "utf8", stdio: ["ignore","pipe","ignore"] }).trim(); } catch {}
const needed = latest !== pkg.version;
console.log(`registry latest=${latest || "(none)"} package.json=${pkg.version} → publish ${needed ? "NEEDED" : "not needed"}`);
if (process.env.GITHUB_OUTPUT) require("node:fs").appendFileSync(process.env.GITHUB_OUTPUT, `needed=${needed}\nversion=${pkg.version}\n`);
