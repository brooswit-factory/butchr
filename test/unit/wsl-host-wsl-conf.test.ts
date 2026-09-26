import { describe, expect, test } from "bun:test";
import { ensureWslConf } from "../../scripts/wsl-host/wsl-conf.js";

describe("ensureWslConf", () => {
  test("empty file: adds [boot] systemd=true", () => {
    const { content, changed } = ensureWslConf("", { systemd: true });
    expect(changed).toBe(true);
    expect(content).toContain("[boot]");
    expect(content).toContain("systemd=true");
  });

  test("already correct: no change, byte-identical", () => {
    const original = "[boot]\nsystemd=true\n";
    const { content, changed } = ensureWslConf(original, { systemd: true });
    expect(changed).toBe(false);
    expect(content).toBe(original);
  });

  test("running twice is idempotent (second call reports no change)", () => {
    const first = ensureWslConf("", { systemd: true, defaultUser: "broos" });
    expect(first.changed).toBe(true);
    const second = ensureWslConf(first.content, { systemd: true, defaultUser: "broos" });
    expect(second.changed).toBe(false);
    expect(second.content).toBe(first.content);
  });

  test("existing [boot] section with a different key: appends systemd=true, keeps the other key", () => {
    const original = "[boot]\ncommand=echo hi\n";
    const { content, changed } = ensureWslConf(original, { systemd: true });
    expect(changed).toBe(true);
    expect(content).toContain("command=echo hi");
    expect(content).toContain("systemd=true");
  });

  test("existing systemd=false is rewritten in place, not duplicated", () => {
    const original = "[boot]\nsystemd=false\n";
    const { content, changed } = ensureWslConf(original, { systemd: true });
    expect(changed).toBe(true);
    expect(content.match(/systemd=/g)?.length).toBe(1);
    expect(content).toContain("systemd=true");
  });

  test("adds [user] default=<name> alongside an existing [boot] section", () => {
    const original = "[boot]\nsystemd=true\n";
    const { content, changed } = ensureWslConf(original, { systemd: true, defaultUser: "broos" });
    expect(changed).toBe(true);
    expect(content).toContain("[user]");
    expect(content).toContain("default=broos");
    expect(content).toContain("systemd=true");
  });

  test("defaultUser omitted: an existing [user] section is left untouched", () => {
    const original = "[user]\ndefault=someone-else\n";
    const { content, changed } = ensureWslConf(original, { systemd: true });
    expect(changed).toBe(true); // systemd=true still gets added
    expect(content).toContain("default=someone-else");
  });

  test("unrelated sections and comments are preserved", () => {
    const original = "# a comment\n[network]\ngenerateResolvConf=false\n\n[boot]\nsystemd=true\n";
    const { content, changed } = ensureWslConf(original, { systemd: true });
    expect(changed).toBe(false);
    expect(content).toBe(original);
  });
});
