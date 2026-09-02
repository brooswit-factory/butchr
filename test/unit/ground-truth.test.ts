import { describe, expect, test } from "bun:test";
import { hostname } from "node:os";
import type { BuildIdentity } from "../../src/agents/build-identity.js";
import type { CurrencyVerdict } from "../../src/agents/build-currency.js";
import { currentSystemdInfo, deriveGroundTruth, groundTruthText, parseCgroup } from "../../src/agents/ground-truth.js";

// groundTruthText's build/currency params are exercised in depth by
// test/unit/build-currency.test.ts (both the pure resolver and the
// renderer); these fixtures exist only so the host/port/pid-focused tests
// below don't have to restate an irrelevant build+currency literal each time.
const FIXTURE_BUILD: BuildIdentity = {
  sha: "a".repeat(40),
  shaProvenance: "git-at-start",
  shaDirty: false,
  shaUnknownReason: null,
  version: "1.2.3",
  startedAt: "2026-09-02T00:00:00.000Z",
  pid: 4242,
  systemd: { kind: "none" },
};
const FIXTURE_CURRENCY: CurrencyVerdict = { status: "unknown", reason: "not under test in this file — see build-currency.test.ts" };

describe("parseCgroup", () => {
  test("user unit: last *.service is the unit, journalctl uses --user", () => {
    const info = parseCgroup("0::/user.slice/user-1003.slice/user@1003.service/app.slice/butchr.service");
    expect(info).toEqual({ kind: "user", unit: "butchr.service", journalctl: "journalctl --user -u butchr.service" });
  });

  test("system unit: no user@<uid>.service component, journalctl has no --user", () => {
    const info = parseCgroup("0::/system.slice/butchr.service");
    expect(info).toEqual({ kind: "system", unit: "butchr.service", journalctl: "journalctl -u butchr.service" });
  });

  test("no *.service component at all: honest 'none', not a default", () => {
    const info = parseCgroup("0::/");
    expect(info).toEqual({ kind: "none" });
  });
});

describe("deriveGroundTruth", () => {
  test("hostname is derived from the OS, not a literal", () => {
    const gt = deriveGroundTruth("http://localhost:7719/mcp");
    expect(gt.hostname).toBe(hostname());
  });

  test("port comes from the passed mcpUrl, not the config default of 7717", () => {
    const gt = deriveGroundTruth("http://localhost:7719/mcp");
    expect(gt.port).toBe(7719);
    expect(gt.port).not.toBe(7717);
  });

  test("pid is the current process pid", () => {
    const gt = deriveGroundTruth("http://localhost:7719/mcp");
    expect(gt.pid).toBe(process.pid);
  });

  test("port falls back to the protocol default when the URL omits one", () => {
    expect(deriveGroundTruth("http://localhost/mcp").port).toBe(80);
    expect(deriveGroundTruth("https://localhost/mcp").port).toBe(443);
  });

  test("port is honestly undefined (never a fake number) when mcpUrl isn't a parseable URL", () => {
    expect(deriveGroundTruth("not-a-url").port).toBeUndefined();
  });
});

describe("currentSystemdInfo", () => {
  test("matches deriveGroundTruth's own systemd field — same underlying read, exposed directly for a caller with no mcpUrl (BUTCHR-54's build-identity)", () => {
    expect(currentSystemdInfo()).toEqual(deriveGroundTruth("http://localhost:7719/mcp").systemd);
  });
});

describe("groundTruthText", () => {
  test("carries host, port, journalctl command, and the authoritative framing for a systemd unit", () => {
    const text = groundTruthText({
      hostname: "servyboi",
      port: 7719,
      pid: 4242,
      systemd: { kind: "user", unit: "butchr.service", journalctl: "journalctl --user -u butchr.service" },
      measuredAt: "2026-09-02T05:19:06.000Z",
    }, FIXTURE_BUILD, FIXTURE_CURRENCY);
    expect(text).toContain("servyboi");
    expect(text).toContain("7719");
    expect(text).toContain("journalctl --user -u butchr.service");
    expect(text).toContain("authoritative");
    expect(text).toContain("THEY ARE WRONG");
    expect(text).toContain("No entries");
    expect(text).toContain("4242");
  });

  test("honest 'no journal to read' text when not under systemd, never a guessed unit", () => {
    const text = groundTruthText({ hostname: "servyboi", port: 7719, pid: 4242, systemd: { kind: "none" }, measuredAt: "2026-09-02T05:19:06.000Z" }, FIXTURE_BUILD, FIXTURE_CURRENCY);
    expect(text).toContain("not running under a systemd unit — no journal to read");
    expect(text).toContain("systemd unit: (none");
  });

  test("honest 'unknown' port text when mcpUrl didn't parse, never a fake number", () => {
    const text = groundTruthText({ hostname: "servyboi", port: undefined, pid: 4242, systemd: { kind: "none" }, measuredAt: "2026-09-02T05:19:06.000Z" }, FIXTURE_BUILD, FIXTURE_CURRENCY);
    expect(text).toContain("port: unknown");
  });

  // BUTCHR-169: this record is registered `GROUND_TRUTH` in
  // src/workspace/registry.ts as deliberately, permanently un-withdrawn —
  // this pins the one honesty concession that entry's reason relies on: a
  // timestamp a reader COULD compare against, even though nothing here
  // compares it automatically. Losing this line silently would make that
  // registry entry's reason false without any test noticing.
  test("carries a measured-at timestamp so staleness is at least detectable by a reader, never automatically", () => {
    const text = groundTruthText({ hostname: "servyboi", port: 7719, pid: 4242, systemd: { kind: "none" }, measuredAt: "2026-09-02T05:19:06.000Z" }, FIXTURE_BUILD, FIXTURE_CURRENCY);
    expect(text).toContain("measured at: 2026-09-02T05:19:06.000Z");
  });

  // BUTCHR-182 (implements BUTCHR-176): the build/currency section this
  // ticket adds. Depth of currency-verdict-rendering coverage lives in
  // test/unit/build-currency.test.ts; these pin only that groundTruthText
  // actually SPLICES that rendering into the block a reader sees (never-says
  // is a failure at THIS layer, not only inside the renderer), and speaks in
  // the first person about one daemon (Requirement 3).
  test("carries the build/currency section, always — even for an unknown verdict (never silently omitted)", () => {
    const text = groundTruthText(
      { hostname: "servyboi", port: 7719, pid: 4242, systemd: { kind: "none" }, measuredAt: "2026-09-02T05:19:06.000Z" },
      FIXTURE_BUILD,
      { status: "unknown", reason: "git not on PATH" },
    );
    expect(text).toContain("Build identity & currency");
    expect(text).toContain("currency: UNKNOWN");
    expect(text).toContain("git not on PATH");
    expect(text).not.toContain("currency: CURRENT");
  });

  test("speaks in the first person about THIS daemon, never 'the fleet' or 'the deploy' (Requirement 3)", () => {
    const text = groundTruthText(
      { hostname: "servyboi", port: 7719, pid: 4242, systemd: { kind: "none" }, measuredAt: "2026-09-02T05:19:06.000Z" },
      FIXTURE_BUILD,
      FIXTURE_CURRENCY,
    );
    expect(text).toContain("this daemon");
    expect(text.toLowerCase()).not.toContain("the fleet");
    expect(text.toLowerCase()).not.toContain("the deploy");
  });
});
