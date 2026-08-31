import { describe, expect, test } from "bun:test";
import { hostname } from "node:os";
import { deriveGroundTruth, groundTruthText, parseCgroup } from "../../src/agents/ground-truth.js";

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

describe("groundTruthText", () => {
  test("carries host, port, journalctl command, and the authoritative framing for a systemd unit", () => {
    const text = groundTruthText({
      hostname: "servyboi",
      port: 7719,
      pid: 4242,
      systemd: { kind: "user", unit: "butchr.service", journalctl: "journalctl --user -u butchr.service" },
    });
    expect(text).toContain("servyboi");
    expect(text).toContain("7719");
    expect(text).toContain("journalctl --user -u butchr.service");
    expect(text).toContain("authoritative");
    expect(text).toContain("THEY ARE WRONG");
    expect(text).toContain("No entries");
    expect(text).toContain("4242");
  });

  test("honest 'no journal to read' text when not under systemd, never a guessed unit", () => {
    const text = groundTruthText({ hostname: "servyboi", port: 7719, pid: 4242, systemd: { kind: "none" } });
    expect(text).toContain("not running under a systemd unit — no journal to read");
    expect(text).toContain("systemd unit: (none");
  });

  test("honest 'unknown' port text when mcpUrl didn't parse, never a fake number", () => {
    const text = groundTruthText({ hostname: "servyboi", port: undefined, pid: 4242, systemd: { kind: "none" } });
    expect(text).toContain("port: unknown");
  });
});
