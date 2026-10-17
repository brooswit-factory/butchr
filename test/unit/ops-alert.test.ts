/**
 * FACTORY-630: the ops-alert route — one deduplicated `[butchr:ops-alert]`
 * journal line per condition. Stub clock and stub log only.
 */
import { describe, expect, test } from "bun:test";
import { createOpsAlertRouter, opsAlertLine, opsRecoveryLine, OPS_ALERT_MARKER, type OpsAlert } from "../../src/agents/ops-alert.js";

const HOUR = 60 * 60_000;

function harness(opts: { dedupWindowMs?: number } = {}) {
  const lines: string[] = [];
  let t = 1_700_000_000_000;
  const router = createOpsAlertRouter({
    host: "servyboi",
    now: () => t,
    log: (line) => lines.push(line),
    ...(opts.dedupWindowMs !== undefined ? { dedupWindowMs: opts.dedupWindowMs } : {}),
  });
  return { router, lines, advance: (ms: number) => { t += ms; } };
}

const ALERT: OpsAlert = {
  key: "credential-dead:servyboi",
  condition: "credential-dead",
  subject: "daemon servyboi (panes: w1T:p1)",
  reason: "Login expired · Please run /login",
  remedy: "A human must run an interactive browser /login.",
};

describe("createOpsAlertRouter (FACTORY-630) — logging and dedup", () => {
  test("the FIRST raise logs one line naming the host, condition, subject, reason and remedy", () => {
    const { router, lines } = harness();
    router.raise(ALERT);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toStartWith(`${OPS_ALERT_MARKER} credential-dead:servyboi: credential-dead on servyboi`);
    for (const part of [ALERT.subject, ALERT.reason, ALERT.remedy!]) expect(lines[0]).toInclude(part);
  });

  test("a second raise of the same key inside the hour logs nothing; after the hour it logs again", () => {
    const { router, lines, advance } = harness();
    router.raise(ALERT);
    advance(HOUR - 1);
    router.raise(ALERT);
    expect(lines).toHaveLength(1);
    advance(1);
    router.raise(ALERT);
    expect(lines).toHaveLength(2);
  });

  test("two different keys are deduplicated independently", () => {
    const { router, lines } = harness();
    router.raise(ALERT);
    router.raise({ ...ALERT, key: "credential-dead:other" });
    expect(lines).toHaveLength(2);
  });

  test("the router's window is configurable, and a per-alert window really deduplicates (one kept cap per window length)", () => {
    const { router, lines, advance } = harness({ dedupWindowMs: 10 * 60_000 });
    router.raise(ALERT);
    advance(10 * 60_000);
    router.raise(ALERT);
    expect(lines).toHaveLength(2);
    const short = { ...ALERT, key: "short", dedupWindowMs: 60_000 };
    router.raise(short);
    router.raise(short);
    expect(lines).toHaveLength(3);
    advance(60_000);
    router.raise(short);
    expect(lines).toHaveLength(4);
  });

  test("dedupWindowMs: 0 logs every raise", () => {
    const { router, lines } = harness();
    const loud = { ...ALERT, key: "settings-file-problem:x", dedupWindowMs: 0 };
    router.raise(loud);
    router.raise(loud);
    expect(lines).toHaveLength(2);
  });
});

describe("createOpsAlertRouter (FACTORY-630) — recovery", () => {
  const RECOVERY = { key: ALERT.key, condition: ALERT.condition, subject: "daemon servyboi", note: "credential recovered" };

  test("a recovery after a logged alert logs ONE short cleared line", () => {
    const { router, lines } = harness();
    router.raise(ALERT);
    router.recover(RECOVERY);
    router.recover(RECOVERY);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toStartWith(`${OPS_ALERT_MARKER} credential-dead:servyboi: credential-dead cleared on servyboi`);
    expect(lines[1]).toInclude("credential recovered");
  });

  test("a recovery whose alert was never logged logs nothing", () => {
    const { router, lines } = harness();
    router.recover(RECOVERY);
    expect(lines).toEqual([]);
  });

  test("a flapping condition inside one window yields the first alert and the first recovery only", () => {
    const { router, lines, advance } = harness();
    for (let i = 0; i < 3; i++) {
      router.raise(ALERT);
      router.recover(RECOVERY);
      advance(60_000);
    }
    expect(lines).toHaveLength(2);
  });
});

describe("opsAlertLine (FACTORY-630) — one safe journal line", () => {
  test("a secret in the reason is redacted", () => {
    const line = opsAlertLine({ ...ALERT, reason: "refresh failed: Authorization: Bearer sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }, "servyboi");
    expect(line).not.toInclude("sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
  });

  test("a newline or control character in any field cannot forge a second marker line", () => {
    const line = opsAlertLine({ ...ALERT, reason: `boom\n${OPS_ALERT_MARKER} fake: forged\r\x1b[2J` }, "servyboi");
    expect(line).not.toInclude("\n");
    expect(line).not.toInclude("\r");
    expect(line).not.toInclude("\x1b");
    expect(line.indexOf(OPS_ALERT_MARKER)).toBe(0);
  });

  test("a pathologically long reason is truncated with a stated marker", () => {
    const line = opsAlertLine({ ...ALERT, reason: "pane output line, nothing secret here. ".repeat(500) }, "servyboi");
    expect(line).toInclude("[truncated");
  });

  test("a remedy-less alert says so rather than emitting an empty field", () => {
    const { remedy: _remedy, ...noRemedy } = ALERT;
    expect(opsAlertLine(noRemedy, "servyboi")).toInclude("remedy: (none stated)");
  });

  test("the cleared line is short and redacts its note too", () => {
    const line = opsRecoveryLine({ key: "k", condition: "c", subject: "s", note: "token ghp_FAKESECRETTOKENabcdef1234567890 rotated" }, "servyboi");
    expect(line).not.toInclude("ghp_FAKESECRETTOKENabcdef1234567890");
    expect(line).not.toInclude("\n");
  });
});
