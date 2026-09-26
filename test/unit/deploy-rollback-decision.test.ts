import { describe, expect, test } from "bun:test";
import { decideRollback, type HealthSnapshot } from "../../scripts/deploy/rollback-decision.js";

const EXPECTED = "aa11bb22cc33dd44ee55ff66aa11bb22cc33dd44";
const healthy: HealthSnapshot = { ok: true, build: { sha: EXPECTED } };

describe("decideRollback", () => {
  test("already disarmed is always a no-op, even with unhealthy-looking input", () => {
    const d = decideRollback({ expectedSha: EXPECTED, health: null, disarmed: true });
    expect(d.action).toBe("noop");
  });

  test("healthy: ok=true and sha matches", () => {
    const d = decideRollback({ expectedSha: EXPECTED, health: healthy, disarmed: false });
    expect(d.action).toBe("healthy");
    expect(d.reason).toMatch(EXPECTED);
  });

  test("unreachable health (null) is treated as unhealthy, not skipped", () => {
    const d = decideRollback({ expectedSha: EXPECTED, health: null, disarmed: false });
    expect(d.action).toBe("rollback");
    expect(d.reason).toMatch(/could not be reached/);
  });

  test("ok=false rolls back even if the sha happens to match", () => {
    const d = decideRollback({ expectedSha: EXPECTED, health: { ok: false, build: { sha: EXPECTED } }, disarmed: false });
    expect(d.action).toBe("rollback");
    expect(d.reason).toMatch(/ok=false/);
  });

  test("sha mismatch rolls back even if ok=true", () => {
    const d = decideRollback({ expectedSha: EXPECTED, health: { ok: true, build: { sha: "0000000000000000000000000000000000000000" } }, disarmed: false });
    expect(d.action).toBe("rollback");
    expect(d.reason).toMatch(/does not match/);
  });

  test("missing build/sha on an otherwise-ok response rolls back, naming sha as unknown", () => {
    const d = decideRollback({ expectedSha: EXPECTED, health: { ok: true }, disarmed: false });
    expect(d.action).toBe("rollback");
    expect(d.reason).toMatch(/unknown/);
  });

  // Mutation check (manual, reported in the PR): flipping the `!input.health.ok`
  // branch to `input.health.ok` would make the "ok=false" test above pass a
  // build it should reject — i.e. flip the polarity here and this suite catches it:
  test("polarity check: ok=true + matching sha never rolls back", () => {
    const d = decideRollback({ expectedSha: EXPECTED, health: healthy, disarmed: false });
    expect(d.action).not.toBe("rollback");
  });
});
