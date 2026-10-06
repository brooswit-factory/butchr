import { describe, expect, test } from "bun:test";
import { parseSystemctlShow } from "../../src/web/settings-unit-hint.js";

describe("parseSystemctlShow", () => {
  test("parses DropInPaths and EnvironmentFiles, space-separated", () => {
    const out = "DropInPaths=/etc/systemd/user/butchr.service.d/10-override.conf\nEnvironmentFiles=/home/user/.config/butchr/butchr.env (ignore_errors=no)\n";
    const hint = parseSystemctlShow(out);
    expect(hint.dropInPaths).toEqual(["/etc/systemd/user/butchr.service.d/10-override.conf"]);
    expect(hint.environmentFiles[0]).toContain("butchr.env");
  });

  test("empty values: empty arrays, never undefined/null entries", () => {
    const hint = parseSystemctlShow("DropInPaths=\nEnvironmentFiles=\n");
    expect(hint.dropInPaths).toEqual([]);
    expect(hint.environmentFiles).toEqual([]);
  });

  test("multiple drop-in paths on one line", () => {
    const hint = parseSystemctlShow("DropInPaths=/a/10.conf /b/20.conf\n");
    expect(hint.dropInPaths).toEqual(["/a/10.conf", "/b/20.conf"]);
  });

  test("unrecognized keys are ignored", () => {
    const hint = parseSystemctlShow("SomeOtherKey=whatever\nDropInPaths=/a.conf\n");
    expect(hint.dropInPaths).toEqual(["/a.conf"]);
    expect(hint.environmentFiles).toEqual([]);
  });
});
