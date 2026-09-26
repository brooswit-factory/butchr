import { describe, expect, test } from "bun:test";
import { renderButchrUnit, renderHerdrUnit, renderHerdrLimitNofileDropin } from "../../scripts/wsl-host/units.js";

describe("renderButchrUnit", () => {
  test("includes WorkingDirectory, ExecStart via the given bun path, and every EnvironmentFile as optional (-prefixed)", () => {
    const unit = renderButchrUnit({
      workingDirectory: "/home/broos/.local/share/butchr/runtime-abc1234",
      bunBin: "/home/broos/.bun/bin/bun",
      environmentFiles: ["/home/broos/.config/butchr/butchr.env", "/home/broos/.config/butchr/managed-sessions.env"],
    });
    expect(unit).toContain("WorkingDirectory=/home/broos/.local/share/butchr/runtime-abc1234");
    expect(unit).toContain("ExecStart=/home/broos/.bun/bin/bun run src/daemon/index.ts");
    expect(unit).toContain("EnvironmentFile=-/home/broos/.config/butchr/butchr.env");
    expect(unit).toContain("EnvironmentFile=-/home/broos/.config/butchr/managed-sessions.env");
    expect(unit).toContain("[Install]");
    expect(unit).toContain("WantedBy=default.target");
  });

  test("is deterministic — same input renders byte-identical output", () => {
    const opts = { workingDirectory: "/x", bunBin: "/y/bun", environmentFiles: ["/z/a.env"] };
    expect(renderButchrUnit(opts)).toBe(renderButchrUnit(opts));
  });
});

describe("renderHerdrUnit", () => {
  test("includes ExecStart with the given herdr path", () => {
    const unit = renderHerdrUnit({ herdrBin: "/home/broos/.local/bin/herdr" });
    expect(unit).toContain("ExecStart=/home/broos/.local/bin/herdr server");
  });
});

describe("renderHerdrLimitNofileDropin", () => {
  test("defaults to a raised LimitNOFILE", () => {
    const dropin = renderHerdrLimitNofileDropin();
    expect(dropin).toContain("[Service]");
    expect(dropin).toContain("LimitNOFILE=65536");
  });

  test("honours an explicit limit", () => {
    expect(renderHerdrLimitNofileDropin({ limit: 4096 })).toContain("LimitNOFILE=4096");
  });
});
