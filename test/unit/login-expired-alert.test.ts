import { describe, expect, test } from "bun:test";
import { CREDENTIAL_DEATH_MARKER, CREDENTIAL_DEATH_CONDITION, createCredentialDeathTracker } from "../../src/agents/login-expired-alert.js";

function fakeDeps(host = "test-host") {
  const lines: string[] = [];
  let t = 0;
  return { deps: { log: (line: string) => lines.push(line), now: () => t, host }, lines, advance: (ms: number) => { t += ms; } };
}

describe("createCredentialDeathTracker (FACTORY-363/FACTORY-397)", () => {
  test("fires IMMEDIATELY on the very first onLoginExpired — no debounce (criterion 2)", () => {
    const { deps, lines } = fakeDeps();
    const tracker = createCredentialDeathTracker(deps);

    tracker.onLoginExpired({ paneId: "p1", detail: "Login expired · Please run /login" });

    expect(lines.length).toBe(1);
    expect(lines[0]).toStartWith(CREDENTIAL_DEATH_MARKER);
    expect(tracker.current()).toBeDefined();
  });

  test("a KEYED pane (no managed-session identity at all) still produces the alert — this tracker never consults managedSessionOf, unlike escalator.onDrovrUnknownDialog which no-ops on a keyed pane", () => {
    // This test proves the trap from criterion 1: createManagedSessionEscalationWatcher's
    // sink (escalator.onDrovrUnknownDialog, src/agents/escalation-loop.ts) returns early
    // whenever `managedSessionOf(paneId)` resolves to null — deliberately correct for
    // answerable dialogs, but FACTORY-314/w1T and FACTORY-324/w1V (the two real incidents)
    // were both KEYED panes, which resolve to null there and would be silently dropped.
    // createCredentialDeathTracker has no managedSessionOf concept at all — every paneId
    // drovr's createLoginExpiredWatcher reports reaches the alert, keyed or not.
    const { deps, lines } = fakeDeps();
    const tracker = createCredentialDeathTracker(deps);

    // "w1T" stands in for a keyed pane id (drovr's LoginExpiredEscalation carries no
    // managed-session identity at all — this tracker's input type doesn't have the field
    // escalator.onDrovrUnknownDialog's routing depends on, which is the point).
    tracker.onLoginExpired({ paneId: "w1T", detail: "Login expired · Please run /login" });

    expect(lines.length).toBe(1);
    expect(tracker.current()?.paneIds).toEqual(["w1T"]);
  });

  test("the alert quotes drovr's own detail verbatim, never a hardcoded message (criterion 9)", () => {
    const { deps, lines } = fakeDeps();
    const tracker = createCredentialDeathTracker(deps);

    tracker.onLoginExpired({ paneId: "p1", detail: "OAuth token revoked · Please run /login" });

    expect(lines[0]).toInclude("OAuth token revoked · Please run /login");
    expect(tracker.current()?.detail).toBe("OAuth token revoked · Please run /login");
  });

  test("names the host and states the remedy is a human interactive login, never an agent-mediated one (criterion 4/5)", () => {
    const { deps, lines } = fakeDeps("servyboi");
    const tracker = createCredentialDeathTracker(deps);

    tracker.onLoginExpired({ paneId: "p1", detail: "Login expired · Please run /login" });

    expect(lines[0]).toInclude("servyboi");
    expect(lines[0]).toInclude("HOST-WIDE");
    expect(lines[0]!.toLowerCase()).toInclude("human");
    expect(lines[0]!.toLowerCase()).toInclude("/login");
  });

  test("13 simultaneous panes collapse into ONE alert, not 13 (criterion 5)", () => {
    const { deps, lines } = fakeDeps();
    const tracker = createCredentialDeathTracker(deps);

    for (let i = 0; i < 13; i++) tracker.onLoginExpired({ paneId: `p${i}`, detail: "Login expired · Please run /login" });

    expect(lines.length).toBe(1); // one alert, not 13
    expect(tracker.current()?.paneIds.length).toBe(13);
  });

  test("never carries an ANSWER-prefixed line or anything fingerprint-shaped (criterion 6/no-answer)", () => {
    const { deps, lines } = fakeDeps();
    const tracker = createCredentialDeathTracker(deps);
    tracker.onLoginExpired({ paneId: "p1", detail: "Login expired · Please run /login" });
    tracker.onLoginExpiredResolved({ paneId: "p1", reason: "recovered" });

    for (const line of lines) {
      expect(line).not.toMatch(/^ANSWER /m);
      expect(line).not.toInclude("ANSWER ");
    }
  });

  describe("clearing — only reason: recovered clears the host-wide alert (criterion 7)", () => {
    test("a pane-gone resolve does NOT clear the alert", () => {
      const { deps, lines } = fakeDeps();
      const tracker = createCredentialDeathTracker(deps);
      tracker.onLoginExpired({ paneId: "p1", detail: "Login expired · Please run /login" });

      tracker.onLoginExpiredResolved({ paneId: "p1", reason: "pane-gone" });

      expect(tracker.current()).toBeDefined(); // still open — a vanished pane says nothing about the credential
      expect(lines.length).toBe(1); // no "cleared" line was logged
    });

    test("a superseded resolve does NOT clear the alert, and the pane stays tracked", () => {
      const { deps, lines } = fakeDeps();
      const tracker = createCredentialDeathTracker(deps);
      tracker.onLoginExpired({ paneId: "p1", detail: "Login expired · Please run /login" });

      tracker.onLoginExpiredResolved({ paneId: "p1", reason: "superseded" });

      expect(tracker.current()).toBeDefined();
      expect(tracker.current()?.paneIds).toEqual(["p1"]); // still counted — the ordinary shape of a dead credential being retried
      expect(lines.length).toBe(1);

      // The retry's replacement episode follows immediately, per drovr's own contract.
      tracker.onLoginExpired({ paneId: "p1", detail: "Login expired · Please run /login" });
      expect(lines.length).toBe(1); // still just the original open line — no new alert for the same still-open episode
    });

    test("a recovered resolve DOES clear the alert, and logs the reason", () => {
      const { deps, lines, advance } = fakeDeps("servyboi");
      const tracker = createCredentialDeathTracker(deps);
      tracker.onLoginExpired({ paneId: "p1", detail: "Login expired · Please run /login" });
      advance(90_000);

      tracker.onLoginExpiredResolved({ paneId: "p1", reason: "recovered" });

      expect(tracker.current()).toBeUndefined();
      expect(lines.length).toBe(2);
      expect(lines[1]).toStartWith(CREDENTIAL_DEATH_MARKER);
      expect(lines[1]).toInclude("cleared");
      expect(lines[1]).toInclude("reason: recovered");
      expect(lines[1]).toInclude("90s");
    });

    test("closes only once EVERY pane in the episode has recovered — one recovered pane while another is still live keeps the alert open", () => {
      const { deps, lines } = fakeDeps();
      const tracker = createCredentialDeathTracker(deps);
      tracker.onLoginExpired({ paneId: "p1", detail: "Login expired · Please run /login" });
      tracker.onLoginExpired({ paneId: "p2", detail: "Login expired · Please run /login" });

      tracker.onLoginExpiredResolved({ paneId: "p1", reason: "recovered" });
      expect(tracker.current()).toBeDefined(); // p2 still live
      expect(tracker.current()?.paneIds).toEqual(["p2"]);
      expect(lines.length).toBe(1); // not cleared yet

      tracker.onLoginExpiredResolved({ paneId: "p2", reason: "recovered" });
      expect(tracker.current()).toBeUndefined();
      expect(lines.length).toBe(2);
    });

    test("pane churn does not falsely clear the alert even when it empties the tracked set: last pane going pane-gone stays open", () => {
      const { deps, lines } = fakeDeps();
      const tracker = createCredentialDeathTracker(deps);
      tracker.onLoginExpired({ paneId: "p1", detail: "Login expired · Please run /login" });

      // The daemon's reconciler tears down and replaces the only pane in the episode.
      tracker.onLoginExpiredResolved({ paneId: "p1", reason: "pane-gone" });

      expect(tracker.current()).toBeDefined(); // MUST stay open — pane-gone is not recovery, even when it's the last pane
      expect(lines.length).toBe(1); // no cleared line

      // A respawned pane under a NEW id picks the same still-open episode back up.
      tracker.onLoginExpired({ paneId: "p1-respawned", detail: "Login expired · Please run /login" });
      expect(lines.length).toBe(1); // still no second open line — the host-wide episode never actually closed
      expect(tracker.current()?.paneIds).toEqual(["p1-respawned"]);
    });

    test("FACTORY-357 defect 1: a genuine recovery must still close the alert even when the LAST departure is pane-gone, not recovered", () => {
      // Would fail before the fix: the "recovered" resolve for p1 doesn't close (p2 is
      // still tracked), and the "pane-gone" resolve for p2 never re-checks the close
      // condition at all — the episode was stuck open forever with paneIds: [].
      const { deps, lines } = fakeDeps();
      const tracker = createCredentialDeathTracker(deps);
      tracker.onLoginExpired({ paneId: "p1", detail: "Login expired · Please run /login" });
      tracker.onLoginExpired({ paneId: "p2", detail: "Login expired · Please run /login" });

      tracker.onLoginExpiredResolved({ paneId: "p1", reason: "recovered" }); // credential demonstrably back
      tracker.onLoginExpiredResolved({ paneId: "p2", reason: "pane-gone" }); // churns away during recovery

      expect(tracker.current()).toBeUndefined(); // must close — the credential recovered
      expect(lines.length).toBe(2);
      expect(lines[1]).toInclude("cleared");
    });

    test("FACTORY-357 defect 2: a stray recovered for a paneId never tracked must NOT close an alert already emptied by pane-gone alone", () => {
      // Would fail before the fix: once panes.size === 0 from the pane-gone departure,
      // delete("never-tracked") is a no-op but size === 0 already held, so the close
      // fired anyway — an unrelated pane's recovery silenced a live credential outage.
      const { deps, lines } = fakeDeps();
      const tracker = createCredentialDeathTracker(deps);
      tracker.onLoginExpired({ paneId: "p1", detail: "Login expired · Please run /login" });
      tracker.onLoginExpiredResolved({ paneId: "p1", reason: "pane-gone" }); // set empty, alert deliberately stays open

      tracker.onLoginExpiredResolved({ paneId: "some-other-pane-id-never-tracked", reason: "recovered" });

      expect(tracker.current()).toBeDefined(); // must NOT close — nothing tracked ever actually recovered
      expect(lines.length).toBe(1); // no "cleared" line
    });

    test("an episode whose every pane departs via pane-gone ONLY (no recovered anywhere) must still refuse to close, even with an empty set — this is not 'empty set means clear'", () => {
      const { deps, lines } = fakeDeps();
      const tracker = createCredentialDeathTracker(deps);
      tracker.onLoginExpired({ paneId: "p1", detail: "Login expired · Please run /login" });
      tracker.onLoginExpired({ paneId: "p2", detail: "Login expired · Please run /login" });

      tracker.onLoginExpiredResolved({ paneId: "p1", reason: "pane-gone" });
      tracker.onLoginExpiredResolved({ paneId: "p2", reason: "pane-gone" });

      expect(tracker.current()).toBeDefined(); // MUST stay open — the credential is presumed still dead
      expect(tracker.current()?.paneIds).toEqual([]);
      expect(lines.length).toBe(1); // no "cleared" line
    });
  });

  test("a resolve for a paneId this tracker never saw is a harmless no-op", () => {
    const { deps, lines } = fakeDeps();
    const tracker = createCredentialDeathTracker(deps);

    tracker.onLoginExpiredResolved({ paneId: "unknown", reason: "recovered" });

    expect(tracker.current()).toBeUndefined();
    expect(lines.length).toBe(0);
  });

  test("host defaults to node:os hostname() when not injected", async () => {
    const { hostname } = await import("node:os");
    const lines: string[] = [];
    const tracker = createCredentialDeathTracker({ log: (l) => lines.push(l), now: () => 0 });
    tracker.onLoginExpired({ paneId: "p1", detail: "Login expired · Please run /login" });
    expect(tracker.current()?.host).toBe(hostname());
  });
});

/**
 * FACTORY-630: the PUSH channel. Everything above this point exercises the
 * tracker with NO `opsAlert` dep, which is the pre-FACTORY-630 behaviour —
 * that those tests still pass unchanged is the proof this route is strictly
 * additive and the journal line / `/health` channels were not touched.
 *
 * Stub router only: these tests assert WHAT the tracker raises and WHEN, not
 * how a post is composed or deduplicated (`test/unit/ops-alert.test.ts` owns
 * that, with its own stub poster and stub clock).
 */
describe("createCredentialDeathTracker → ops-alert route (FACTORY-630)", () => {
  function routerSpy() {
    const raised: { key: string; condition: string; subject: string; reason: string; remedy?: string }[] = [];
    const recovered: { key: string; condition: string; subject: string; note: string }[] = [];
    return {
      raised,
      recovered,
      router: {
        raise: (a: { key: string; condition: string; subject: string; reason: string; remedy?: string }) => { raised.push(a); },
        recover: (r: { key: string; condition: string; subject: string; note: string }) => { recovered.push(r); },
      },
    };
  }

  test("the first onLoginExpired raises an ops alert naming the condition, the host, the pane and drovr's own detail verbatim", () => {
    const { deps } = fakeDeps("servyboi");
    const { router, raised } = routerSpy();
    const tracker = createCredentialDeathTracker({ ...deps, opsAlert: router });

    tracker.onLoginExpired({ paneId: "w1T:p1", detail: "Login expired · Please run /login" });

    expect(raised.length).toBe(1);
    expect(raised[0]!.condition).toBe(CREDENTIAL_DEATH_CONDITION);
    expect(raised[0]!.key).toBe(`${CREDENTIAL_DEATH_CONDITION}:servyboi`);
    expect(raised[0]!.subject).toInclude("servyboi");
    expect(raised[0]!.subject).toInclude("w1T:p1");
    // Never a message this module asserts itself — the installed binary emits
    // at least five distinct credential-death strings.
    expect(raised[0]!.reason).toBe("Login expired · Please run /login");
    expect(raised[0]!.remedy).toInclude("/login");
  });

  test("the alert key is per HOST, so one daemon's dead credential is one deduplicated condition however many panes die with it", () => {
    const { deps } = fakeDeps("servyboi");
    const { router, raised } = routerSpy();
    const tracker = createCredentialDeathTracker({ ...deps, opsAlert: router });

    tracker.onLoginExpired({ paneId: "w1T:p1", detail: "Login expired" });
    tracker.onLoginExpired({ paneId: "w1V:p1", detail: "Login expired" });
    tracker.onLoginExpired({ paneId: "w6Z:p1", detail: "Login expired" });

    expect(new Set(raised.map((r) => r.key)).size).toBe(1);
  });

  test("raises on EVERY onLoginExpired, not only the episode-opening one — this is what gives a failed post a retry, with the router (not this module) owning the dedup window", () => {
    const { deps, lines } = fakeDeps();
    const { router, raised } = routerSpy();
    const tracker = createCredentialDeathTracker({ ...deps, opsAlert: router });

    tracker.onLoginExpired({ paneId: "p1", detail: "Login expired" });
    tracker.onLoginExpired({ paneId: "p1", detail: "Login expired" });
    tracker.onLoginExpired({ paneId: "p1", detail: "Login expired" });

    expect(raised.length).toBe(3);
    // And the JOURNAL line keeps its own once-per-episode semantics, untouched.
    expect(lines.filter((l) => l.startsWith(CREDENTIAL_DEATH_MARKER)).length).toBe(1);
  });

  test("a later `detail` is carried into the raise — the most recent transcript text drovr matched, not the first", () => {
    const { deps } = fakeDeps();
    const { router, raised } = routerSpy();
    const tracker = createCredentialDeathTracker({ ...deps, opsAlert: router });

    tracker.onLoginExpired({ paneId: "p1", detail: "Login expired" });
    tracker.onLoginExpired({ paneId: "p1", detail: "OAuth token revoked · Please run /login" });

    expect(raised[1]!.reason).toBe("OAuth token revoked · Please run /login");
  });

  test("a `recovered` resolution that closes the episode asks for ONE recovery, naming the reason that closed it", () => {
    const { deps, advance } = fakeDeps("servyboi");
    const { router, recovered } = routerSpy();
    const tracker = createCredentialDeathTracker({ ...deps, opsAlert: router });

    tracker.onLoginExpired({ paneId: "p1", detail: "Login expired" });
    advance(900_000);
    tracker.onLoginExpiredResolved({ paneId: "p1", reason: "recovered" });

    expect(recovered.length).toBe(1);
    expect(recovered[0]!.key).toBe(`${CREDENTIAL_DEATH_CONDITION}:servyboi`);
    expect(recovered[0]!.note).toInclude("recovered");
    expect(recovered[0]!.note).toInclude("900s");
  });

  test("`pane-gone` NEVER asks for a recovery — ordinary pane churn is not the credential coming back, and telling the room the outage is over while it is still running is worse than the original silence", () => {
    const { deps } = fakeDeps();
    const { router, recovered } = routerSpy();
    const tracker = createCredentialDeathTracker({ ...deps, opsAlert: router });

    tracker.onLoginExpired({ paneId: "p1", detail: "Login expired" });
    tracker.onLoginExpiredResolved({ paneId: "p1", reason: "pane-gone" });

    expect(recovered.length).toBe(0);
    expect(tracker.current()).toBeDefined();
  });

  test("`superseded` NEVER asks for a recovery — it is the ORDINARY shape of a dead credential being retried", () => {
    const { deps } = fakeDeps();
    const { router, recovered } = routerSpy();
    const tracker = createCredentialDeathTracker({ ...deps, opsAlert: router });

    tracker.onLoginExpired({ paneId: "p1", detail: "Login expired" });
    tracker.onLoginExpiredResolved({ paneId: "p1", reason: "superseded" });

    expect(recovered.length).toBe(0);
    expect(tracker.current()).toBeDefined();
  });

  test("pane churn mid-episode (a pane id genuinely changing under the alert) still ends in exactly one recovery, and only once a real recovery closes it", () => {
    const { deps } = fakeDeps();
    const { router, raised, recovered } = routerSpy();
    const tracker = createCredentialDeathTracker({ ...deps, opsAlert: router });

    // The respawn churn FACTORY-357 measured: w6Z:p1 -> w74:p1, nothing fixed.
    tracker.onLoginExpired({ paneId: "w6Z:p1", detail: "Login expired" });
    tracker.onLoginExpiredResolved({ paneId: "w6Z:p1", reason: "pane-gone" });
    tracker.onLoginExpired({ paneId: "w74:p1", detail: "Login expired" });
    expect(recovered.length).toBe(0);

    tracker.onLoginExpiredResolved({ paneId: "w74:p1", reason: "recovered" });

    expect(recovered.length).toBe(1);
    expect(raised.length).toBe(2);
    expect(tracker.current()).toBeUndefined();
  });

  test("a tracker with NO opsAlert dep raises nothing and still logs and tracks exactly as before — the route is optional and additive", () => {
    const { deps, lines } = fakeDeps();
    const tracker = createCredentialDeathTracker(deps);

    expect(() => {
      tracker.onLoginExpired({ paneId: "p1", detail: "Login expired" });
      tracker.onLoginExpiredResolved({ paneId: "p1", reason: "recovered" });
    }).not.toThrow();

    expect(lines.filter((l) => l.startsWith(CREDENTIAL_DEATH_MARKER)).length).toBe(2);
    expect(tracker.current()).toBeUndefined();
  });
});
