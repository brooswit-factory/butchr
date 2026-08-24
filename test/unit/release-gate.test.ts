import { describe, expect, test } from "bun:test";
import { evaluate, type Facts } from "../../scripts/release/gate.js";

const log = (v: string, body = "### Fixed\n- x") => `# Changelog\n## [${v}] - 2026-08-24\n${body}\n## [0.1.0] - 2026-08-23\n### Added\n- first\n`;
const base: Facts = { version: "0.1.1", baseVersion: "0.1.0", registryLatest: "0.1.0", changedFiles: ["src/a.ts"], changelog: log("0.1.1"), baseChangelog: log("0.1.0").replace(/## \[0\.1\.1\][\s\S]*?(?=## \[0\.1\.0\])/, ""), schemaChanged: false, today: "2026-08-24" };
const failing = (f: Partial<Facts>) => evaluate({ ...base, ...f }).verdicts.filter((v) => !v.ok).map((v) => v.reason);

describe("release gate", () => {
  test("happy path: patch with a new changelog entry passes", () => { const r = evaluate(base); expect(r.ok, JSON.stringify(r.verdicts)).toBe(true); expect(r.bump).toBe("patch"); });
  test("docs-only PR is exempt and must NOT bump", () => {
    expect(evaluate({ ...base, changedFiles: ["README.md"], version: "0.1.0" }).ok).toBe(true);
    expect(failing({ changedFiles: ["README.md"] })[0]).toMatch(/bump only with a real change/);
  });
  test("gated change with no bump fails", () => { expect(failing({ version: "0.1.0" })[0]).toMatch(/bump it/); });
  test("not greater than registry fails", () => { expect(failing({ registryLatest: "0.1.1" })[0]).toMatch(/not greater than published/); });
  test("skipping a step fails", () => { expect(failing({ version: "0.3.0", changelog: log("0.3.0") })[0]).toMatch(/single-step/); });
  test("schema drift on a patch fails; on a minor passes", () => {
    expect(failing({ schemaChanged: true })[0]).toMatch(/at least a MINOR/);
    expect(evaluate({ ...base, schemaChanged: true, version: "0.2.0", changelog: log("0.2.0") }).ok).toBe(true);
  });
  test("missing / stale / empty / future-dated changelog entries fail", () => {
    expect(failing({ changelog: log("0.1.0") })[0]).toMatch(/no "## \[0\.1\.1\]/);
    expect(failing({ baseChangelog: log("0.1.1") })[0]).toMatch(/already existed on main/);
    expect(failing({ changelog: log("0.1.1", "### Fixed\n") })[0]).toMatch(/no bullets/);
    expect(failing({ changelog: log("0.1.1").replace("2026-08-24\n### Fixed", "2027-01-01\n### Fixed") })[0]).toMatch(/in the future/);
  });
  test("major needs BREAKING; non-major must not have it", () => {
    expect(failing({ baseVersion: "0.9.0", version: "1.0.0", changelog: log("1.0.0") })[0]).toMatch(/requires a non-empty ### BREAKING/);
    expect(evaluate({ ...base, baseVersion: "0.9.0", version: "1.0.0", changelog: log("1.0.0", "### BREAKING\n- all new") }).ok).toBe(true);
    expect(failing({ changelog: log("0.1.1", "### BREAKING\n- oops") })[0]).toMatch(/it is a MAJOR/);
  });
});
