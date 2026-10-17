import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadConfig, describeConfig, ignoredExtensionOriginsWarning, isAtlassianConfigured, validateAtlassianSiteShape, loadAtlassianConfig } from "../../src/config/config.js";
import { PROVIDER_ENABLED_ENV_VAR } from "../../src/rules/provider-enablement.js";
import { workspaceRoot } from "../../src/agents/workspace.js";
import { checkExtensionOrigin } from "../../src/web/origin-guard.js";

const noRead = () => { throw new Error("should not read"); };
const base = { ATLASSIAN_SITE: "https://x.atlassian.net/", ATLASSIAN_EMAIL: "a@b.c", ATLASSIAN_TOKEN: "tok" };

describe("loadConfig", () => {
  test("accepts AGY as default and in every role's ordered provider list", () => {
    const c = loadConfig({ ...base, BUTCHR_AGENT_PROVIDER: " agy ", BUTCHR_AGENT_PROVIDERS: "claude, agy, codex",
      BUTCHR_AGENT_PROVIDERS_PROJECT: "agy,claude", BUTCHR_AGENT_PROVIDERS_EPIC: "agy,codex",
      BUTCHR_AGENT_PROVIDERS_STORY: "codex,agy", BUTCHR_AGENT_PROVIDERS_TASK: "agy",
    }, noRead);
    expect(c.agent).toEqual({ provider: "agy", providers: ["claude", "agy", "codex"], roleProviders: {
      project: ["agy", "claude"], epic: ["agy", "codex"], story: ["codex", "agy"], task: ["agy"],
    }, restoredResume: new Set(["buddy", "genius"]) });
    expect(describeConfig(c)).toContain("provider=agy");
    for (const order of ["agy,agy", "agy,unknown", "agy,", ""]) {
      expect(() => loadConfig({ ...base, BUTCHR_AGENT_PROVIDERS: order }, noRead)).toThrow("ordered list");
      expect(() => loadConfig({ ...base, BUTCHR_AGENT_PROVIDERS_TASK: order }, noRead)).toThrow("ordered list");
    }
    expect(() => loadConfig({ ...base, BUTCHR_AGENT_PROVIDER: "unknown" }, noRead)).toThrow("BUTCHR_AGENT_PROVIDER");
  });
  test("parses a full env; trims trailing slash; default port 7717", () => {
    const c = loadConfig(base, noRead);
    expect(c.atlassian).toEqual({ site: "https://x.atlassian.net", email: "a@b.c", token: "tok" });
    expect(c.port).toBe(7717);
    expect(c.herdrSocket).toBeUndefined();
  });
  test("reads the token from a file when ATLASSIAN_TOKEN_FILE is set", () => {
    const c = loadConfig({ ...base, ATLASSIAN_TOKEN: undefined, ATLASSIAN_TOKEN_FILE: "/t" }, (p) => { expect(p).toBe("/t"); return "filetok\n"; });
    expect(c.atlassian?.token).toBe("filetok");
  });
  test("honours BUTCHR_PORT and HERDR_SOCKET", () => {
    const c = loadConfig({ ...base, BUTCHR_PORT: "9000", HERDR_SOCKET: "/s.sock" }, noRead);
    expect(c.port).toBe(9000); expect(c.herdrSocket).toBe("/s.sock");
  });
  // FACTORY-66: a partial/invalid Atlassian credential (missing field, bad
  // site shape, empty token) used to throw out of `loadConfig` — fatal to
  // the whole daemon (PR463/FACTORY-65's own boot-refusal path). It is now
  // isolated: `atlassian` is `undefined` and `atlassianDisabledReason`
  // names exactly what's wrong, same "optional, never a startup crash for
  // unrelated config" contract `github`/`rocketchat` already had. Only a
  // bad, UNRELATED knob (BUTCHR_PORT) still throws.
  test("FACTORY-66: a partial/invalid Atlassian credential is isolated, not thrown — loadConfig never crashes over it", () => {
    for (const env of [
      { ...base, ATLASSIAN_SITE: undefined },
      { ...base, ATLASSIAN_EMAIL: "" },
      { ...base, ATLASSIAN_TOKEN: undefined },
    ]) {
      const c = loadConfig(env, noRead);
      expect(c.atlassian).toBeUndefined();
      expect(c.atlassianDisabledReason).toContain("misconfigured");
    }
    const cEmptyTokenFile = loadConfig({ ...base, ATLASSIAN_TOKEN_FILE: "/t" }, () => "  \n");
    expect(cEmptyTokenFile.atlassian).toBeUndefined();
    expect(cEmptyTokenFile.atlassianDisabledReason).toContain("empty");
    expect(() => loadConfig({ ...base, BUTCHR_PORT: "notaport" }, noRead)).toThrow(/BUTCHR_PORT/);
  });
  test("FACTORY-665/FACTORY-66: an ATLASSIAN_SITE that isn't exactly https://<name>.atlassian.net disables Atlassian (isolated), never throws", () => {
    for (const bad of ["https://evil.example.com", "http://x.atlassian.net", "https://x.atlassian.net/extra", "https://x.atlassian.net:8443", "https://x.atlassian.net.evil.com", "https://.atlassian.net", "not-a-url"]) {
      const c = loadConfig({ ...base, ATLASSIAN_SITE: bad }, noRead);
      expect(c.atlassian).toBeUndefined();
      expect(c.atlassianDisabledReason).toContain("ATLASSIAN_SITE must look like");
    }
    expect(() => loadConfig({ ...base, ATLASSIAN_SITE: "HTTPS://X.ATLASSIAN.NET" }, noRead)).not.toThrow();
    expect(loadConfig({ ...base, ATLASSIAN_SITE: "HTTPS://X.ATLASSIAN.NET" }, noRead).atlassian).toBeDefined();
  });
  test("FACTORY-66: BUTCHR_ATLASSIAN_ENABLED=false disables Atlassian regardless of otherwise-complete credentials", () => {
    for (const falsy of ["false", "0", "no", "off", "FALSE", " False "]) {
      const c = loadConfig({ ...base, BUTCHR_ATLASSIAN_ENABLED: falsy }, noRead);
      expect(c.atlassian).toBeUndefined();
      expect(c.atlassianDisabledReason).toContain("disabled");
    }
    // Anything else (unset, "true", garbage) leaves today's presence-based behavior alone.
    expect(loadConfig({ ...base, BUTCHR_ATLASSIAN_ENABLED: "true" }, noRead).atlassian).toBeDefined();
  });
  test("FACTORY-66: Atlassian is cleanly absent (no explicit-disable reason) when nothing at all is set", () => {
    const c = loadConfig({ ATLASSIAN_SITE: undefined, ATLASSIAN_EMAIL: undefined, ATLASSIAN_TOKEN: undefined, ATLASSIAN_TOKEN_FILE: undefined }, noRead);
    expect(c.atlassian).toBeUndefined();
    expect(c.atlassianDisabledReason).toContain("not configured");
  });
  test("FACTORY-66: loadAtlassianConfig directly — the three non-throwing outcomes, and the one unaffected success path", () => {
    expect(loadAtlassianConfig(base, noRead)).toEqual({ config: { site: "https://x.atlassian.net", email: "a@b.c", token: "tok" } });
    expect(loadAtlassianConfig({}, noRead)).toMatchObject({ config: undefined, disabledReason: expect.stringContaining("not configured") });
    expect(loadAtlassianConfig({ ...base, BUTCHR_ATLASSIAN_ENABLED: "false" }, noRead)).toMatchObject({ config: undefined, disabledReason: expect.stringContaining("disabled") });
    expect(loadAtlassianConfig({ ...base, ATLASSIAN_EMAIL: undefined }, noRead)).toMatchObject({ config: undefined, disabledReason: expect.stringContaining("misconfigured") });
  });
  test("FACTORY-66 review round 2: providerEnabled defaults every registered provider to true, independently of BUTCHR_ATLASSIAN_ENABLED and of each other", () => {
    const c = loadConfig(base, noRead);
    expect(c.providerEnabled).toEqual({
      "jira-work": true, "jira-idea": true, "jira-project": true, "confluence-page": true,
      "github-issue": true, "github-pr": true, "zendesk-ticket": true, filesystem: true,
      "jira-component": true, "trello-card": true,
    });
  });
  test("FACTORY-66 review round 2: a provider can be individually disabled while its credentials, siblings and BUTCHR_ATLASSIAN_ENABLED all stay untouched — the gap a single combined flag left", () => {
    // Disable exactly ONE of the four Atlassian-backed providers (confluence-page); the other three, the credential itself, and every non-Atlassian provider are unaffected.
    const c = loadConfig({ ...base, [PROVIDER_ENABLED_ENV_VAR["confluence-page"]]: "false" }, noRead);
    expect(c.atlassian).toBeDefined(); // the credential itself is untouched
    expect(c.providerEnabled["confluence-page"]).toBe(false);
    expect(c.providerEnabled["jira-work"]).toBe(true);
    expect(c.providerEnabled["jira-idea"]).toBe(true);
    expect(c.providerEnabled["jira-project"]).toBe(true);
    expect(c.providerEnabled["github-issue"]).toBe(true);
    expect(c.providerEnabled["github-pr"]).toBe(true);
    expect(c.providerEnabled["zendesk-ticket"]).toBe(true);
    expect(c.providerEnabled.filesystem).toBe(true);
  });
  test("FACTORY-66 review round 2: each of the eight providers' switches is settable independently of every other", () => {
    for (const [provider, envVar] of Object.entries(PROVIDER_ENABLED_ENV_VAR)) {
      const c = loadConfig({ ...base, [envVar]: "false" }, noRead);
      for (const [otherProvider, enabled] of Object.entries(c.providerEnabled)) {
        expect(enabled).toBe(otherProvider === provider ? false : true);
      }
    }
  });
  test("FACTORY-66 review round 2: describeConfig names exactly the switched-off providers, and nothing when every switch is at its default", () => {
    expect(describeConfig(loadConfig(base, noRead))).not.toContain("providerSwitchOff");
    const d = describeConfig(loadConfig({ ...base, [PROVIDER_ENABLED_ENV_VAR["github-pr"]]: "false", [PROVIDER_ENABLED_ENV_VAR.filesystem]: "false" }, noRead));
    expect(d).toContain("providerSwitchOff=github-pr,filesystem");
  });
  // FACTORY-66 review round 3 (brooswit, PR #797, @ 334430f6): "disabled
  // must mean no own initialization, no credential requirement" — before
  // this, `loadConfig` read/validated ATLASSIAN_TOKEN_FILE unconditionally,
  // even when every Atlassian-backed provider's own switch was off, so a
  // host with zero use for Atlassian still had its credential read (and a
  // real client constructed downstream in daemon/index.ts) for nothing.
  test("FACTORY-66 review round 3: all four Atlassian-backed provider switches off skips the credential read entirely, even with a valid ATLASSIAN_TOKEN_FILE set", () => {
    const allAtlassianOff = { [PROVIDER_ENABLED_ENV_VAR["jira-work"]]: "false", [PROVIDER_ENABLED_ENV_VAR["jira-idea"]]: "false", [PROVIDER_ENABLED_ENV_VAR["jira-project"]]: "false", [PROVIDER_ENABLED_ENV_VAR["confluence-page"]]: "false" };
    const c = loadConfig({ ...base, ATLASSIAN_TOKEN: undefined, ATLASSIAN_TOKEN_FILE: "/t", ...allAtlassianOff }, noRead);
    expect(c.atlassian).toBeUndefined();
    expect(c.atlassianDisabledReason).toContain("every Atlassian-backed provider switch");
    expect(c.atlassianDisabledReason).toContain("is off");
  });
  test("FACTORY-66 review round 3: ONE enabled Atlassian-backed sibling still reads/validates the shared credential normally, with the other three switched off", () => {
    const threeOff = { [PROVIDER_ENABLED_ENV_VAR["jira-idea"]]: "false", [PROVIDER_ENABLED_ENV_VAR["jira-project"]]: "false", [PROVIDER_ENABLED_ENV_VAR["confluence-page"]]: "false" };
    const c = loadConfig({ ...base, ATLASSIAN_TOKEN: undefined, ATLASSIAN_TOKEN_FILE: "/t", ...threeOff }, (p) => { expect(p).toBe("/t"); return "filetok\n"; });
    expect(c.atlassian).toEqual({ site: "https://x.atlassian.net", email: "a@b.c", token: "filetok" });
    expect(c.providerEnabled["jira-work"]).toBe(true);
    expect(c.providerEnabled["jira-idea"]).toBe(false);
  });
  test("describeConfig never leaks the token value", () => {
    const d = describeConfig(loadConfig({ ...base, ATLASSIAN_TOKEN: "s3cr3t-VALUE" }, noRead));
    expect(d).not.toContain("s3cr3t-VALUE"); expect(d).toContain("***"); expect(d).toContain("12 chars");
  });

  test("github is absent when GITHUB_TOKEN_FILE or BUTCHR_GITHUB_ORGS is missing", () => {
    expect(loadConfig(base, noRead).github).toBeUndefined();
    expect(loadConfig({ ...base, BUTCHR_GITHUB_ORGS: "acme" }, noRead).github).toBeUndefined();
    expect(loadConfig({ ...base, GITHUB_TOKEN_FILE: "/gh" }, (p) => { expect(p).toBe("/gh"); return "ghtok\n"; }).github).toBeUndefined();
  });
  test("github is populated when both are set; orgs are comma-split and trimmed", () => {
    const c = loadConfig({ ...base, GITHUB_TOKEN_FILE: "/gh", BUTCHR_GITHUB_ORGS: "acme, other-org" }, () => "ghtok\n");
    expect(c.github).toEqual({ token: "ghtok", orgs: ["acme", "other-org"] });
  });
  test("describeConfig reports github as disabled or its orgs, never the token value", () => {
    expect(describeConfig(loadConfig(base, noRead))).toContain("github=disabled");
    const d = describeConfig(loadConfig({ ...base, GITHUB_TOKEN_FILE: "/gh", BUTCHR_GITHUB_ORGS: "acme" }, () => "s3cr3t-gh-tok"));
    expect(d).not.toContain("s3cr3t-gh-tok");
    expect(d).toContain("orgs=acme");
  });
  // FACTORY-66: an unreadable GITHUB_TOKEN_FILE used to throw straight out of
  // `loadConfig` — fatal to the ENTIRE daemon over one optional provider's
  // bad file, even though `github` is documented as optional. It is now
  // isolated: `github` stays `undefined` (same as merely unset) and
  // `githubTokenReadError` names what went wrong, for the daemon to log.
  test("FACTORY-66: an unreadable GITHUB_TOKEN_FILE isolates to github staying undefined, never throws", () => {
    const boom = () => { throw new Error("ENOENT: no such file"); };
    expect(() => loadConfig({ ...base, GITHUB_TOKEN_FILE: "/gh", BUTCHR_GITHUB_ORGS: "acme" }, boom)).not.toThrow();
    const c = loadConfig({ ...base, GITHUB_TOKEN_FILE: "/gh", BUTCHR_GITHUB_ORGS: "acme" }, boom);
    expect(c.github).toBeUndefined();
    expect(c.githubTokenReadError).toContain("ENOENT");
    expect(c.atlassian).toBeDefined(); // unrelated provider unaffected
    const d = describeConfig(c);
    expect(d).toContain("github=disabled");
    expect(d).toContain("ENOENT");
  });

  // FACTORY-66 review round 3: github-issue and github-pr share ONE
  // GITHUB_TOKEN_FILE — before this, it was read unconditionally whenever
  // the file/orgs were set, even with BOTH providers' own switches off.
  test("FACTORY-66 review round 3: GITHUB_TOKEN_FILE is never read when BOTH github-issue and github-pr switches are off", () => {
    const bothOff = { [PROVIDER_ENABLED_ENV_VAR["github-issue"]]: "false", [PROVIDER_ENABLED_ENV_VAR["github-pr"]]: "false" };
    const c = loadConfig({ ...base, GITHUB_TOKEN_FILE: "/gh", BUTCHR_GITHUB_ORGS: "acme", ...bothOff }, noRead);
    expect(c.github).toBeUndefined();
    expect(c.githubTokenReadError).toBeUndefined(); // never attempted, not merely isolated
  });
  test("FACTORY-66 review round 3: ONE enabled github sibling still reads the shared token normally, with the other switched off", () => {
    const prOff = { [PROVIDER_ENABLED_ENV_VAR["github-pr"]]: "false" };
    const c = loadConfig({ ...base, GITHUB_TOKEN_FILE: "/gh", BUTCHR_GITHUB_ORGS: "acme", ...prOff }, () => "ghtok\n");
    expect(c.github).toEqual({ token: "ghtok", orgs: ["acme"] });
    expect(c.providerEnabled["github-issue"]).toBe(true);
    expect(c.providerEnabled["github-pr"]).toBe(false);
  });

  test("stalledMinutes defaults to 10, honours BUTCHR_STALLED_MINUTES, and rejects a non-positive value", () => {
    expect(loadConfig(base, noRead).stalledMinutes).toBe(10);
    expect(loadConfig({ ...base, BUTCHR_STALLED_MINUTES: "20" }, noRead).stalledMinutes).toBe(20);
    expect(() => loadConfig({ ...base, BUTCHR_STALLED_MINUTES: "0" }, noRead)).toThrow(/BUTCHR_STALLED_MINUTES/);
    expect(() => loadConfig({ ...base, BUTCHR_STALLED_MINUTES: "nope" }, noRead)).toThrow(/BUTCHR_STALLED_MINUTES/);
  });

  test("FACTORY-949: blockedWakeDebounceMinutes defaults to 10, honours BUTCHR_BLOCKED_WAKE_DEBOUNCE_MINUTES, and rejects a non-positive value", () => {
    expect(loadConfig(base, noRead).blockedWakeDebounceMinutes).toBe(10);
    expect(loadConfig({ ...base, BUTCHR_BLOCKED_WAKE_DEBOUNCE_MINUTES: "20" }, noRead).blockedWakeDebounceMinutes).toBe(20);
    expect(() => loadConfig({ ...base, BUTCHR_BLOCKED_WAKE_DEBOUNCE_MINUTES: "0" }, noRead)).toThrow(/BUTCHR_BLOCKED_WAKE_DEBOUNCE_MINUTES/);
    expect(() => loadConfig({ ...base, BUTCHR_BLOCKED_WAKE_DEBOUNCE_MINUTES: "nope" }, noRead)).toThrow(/BUTCHR_BLOCKED_WAKE_DEBOUNCE_MINUTES/);
  });

  test("FACTORY-972: stalledWakeDebounceMinutes defaults to 30, honours BUTCHR_STALLED_WAKE_DEBOUNCE_MINUTES, and rejects a non-positive value", () => {
    expect(loadConfig(base, noRead).stalledWakeDebounceMinutes).toBe(30);
    expect(loadConfig({ ...base, BUTCHR_STALLED_WAKE_DEBOUNCE_MINUTES: "45" }, noRead).stalledWakeDebounceMinutes).toBe(45);
    expect(() => loadConfig({ ...base, BUTCHR_STALLED_WAKE_DEBOUNCE_MINUTES: "0" }, noRead)).toThrow(/BUTCHR_STALLED_WAKE_DEBOUNCE_MINUTES/);
    expect(() => loadConfig({ ...base, BUTCHR_STALLED_WAKE_DEBOUNCE_MINUTES: "nope" }, noRead)).toThrow(/BUTCHR_STALLED_WAKE_DEBOUNCE_MINUTES/);
  });

  test("FACTORY-972: stalledWakeMaxPerHour defaults to 6, honours BUTCHR_STALLED_WAKE_MAX_PER_HOUR, and rejects a non-positive or fractional value", () => {
    expect(loadConfig(base, noRead).stalledWakeMaxPerHour).toBe(6);
    expect(loadConfig({ ...base, BUTCHR_STALLED_WAKE_MAX_PER_HOUR: "3" }, noRead).stalledWakeMaxPerHour).toBe(3);
    expect(() => loadConfig({ ...base, BUTCHR_STALLED_WAKE_MAX_PER_HOUR: "0" }, noRead)).toThrow(/BUTCHR_STALLED_WAKE_MAX_PER_HOUR/);
    expect(() => loadConfig({ ...base, BUTCHR_STALLED_WAKE_MAX_PER_HOUR: "1.5" }, noRead)).toThrow(/BUTCHR_STALLED_WAKE_MAX_PER_HOUR/);
    expect(() => loadConfig({ ...base, BUTCHR_STALLED_WAKE_MAX_PER_HOUR: "nope" }, noRead)).toThrow(/BUTCHR_STALLED_WAKE_MAX_PER_HOUR/);
  });

  test("FACTORY-740: silentStopMode defaults to dry-run, honours off, and rejects an unknown value", () => {
    expect(loadConfig(base, noRead).silentStopMode).toBe("dry-run");
    expect(loadConfig({ ...base, BUTCHR_SILENT_STOP_MODE: "off" }, noRead).silentStopMode).toBe("off");
    expect(loadConfig({ ...base, BUTCHR_SILENT_STOP_MODE: "dry-run" }, noRead).silentStopMode).toBe("dry-run");
    expect(() => loadConfig({ ...base, BUTCHR_SILENT_STOP_MODE: "enforce" }, noRead)).toThrow(/BUTCHR_SILENT_STOP_MODE/);
  });

  test("FACTORY-740: silentStopSuppressMinutes defaults to 5, honours BUTCHR_SILENT_STOP_SUPPRESS_MINUTES, and rejects a non-positive value", () => {
    expect(loadConfig(base, noRead).silentStopSuppressMinutes).toBe(5);
    expect(loadConfig({ ...base, BUTCHR_SILENT_STOP_SUPPRESS_MINUTES: "15" }, noRead).silentStopSuppressMinutes).toBe(15);
    expect(() => loadConfig({ ...base, BUTCHR_SILENT_STOP_SUPPRESS_MINUTES: "0" }, noRead)).toThrow(/BUTCHR_SILENT_STOP_SUPPRESS_MINUTES/);
    expect(() => loadConfig({ ...base, BUTCHR_SILENT_STOP_SUPPRESS_MINUTES: "nope" }, noRead)).toThrow(/BUTCHR_SILENT_STOP_SUPPRESS_MINUTES/);
  });

  test("FACTORY-845: idlePokeMode defaults to dry-run (same precedent as silentStopMode), honours off/live, and rejects an unknown value", () => {
    expect(loadConfig(base, noRead).idlePokeMode).toBe("dry-run");
    expect(loadConfig({ ...base, BUTCHR_IDLE_POKE_MODE: "off" }, noRead).idlePokeMode).toBe("off");
    expect(loadConfig({ ...base, BUTCHR_IDLE_POKE_MODE: "dry-run" }, noRead).idlePokeMode).toBe("dry-run");
    expect(loadConfig({ ...base, BUTCHR_IDLE_POKE_MODE: "live" }, noRead).idlePokeMode).toBe("live");
    expect(() => loadConfig({ ...base, BUTCHR_IDLE_POKE_MODE: "enforce" }, noRead)).toThrow(/BUTCHR_IDLE_POKE_MODE/);
  });

  test("FACTORY-1016: stallRemediationMode defaults to off (never wires the automatic wake comment), honours live, and rejects an unknown value", () => {
    expect(loadConfig(base, noRead).stallRemediationMode).toBe("off");
    expect(loadConfig({ ...base, BUTCHR_STALL_REMEDIATION_MODE: "off" }, noRead).stallRemediationMode).toBe("off");
    expect(loadConfig({ ...base, BUTCHR_STALL_REMEDIATION_MODE: "live" }, noRead).stallRemediationMode).toBe("live");
    expect(() => loadConfig({ ...base, BUTCHR_STALL_REMEDIATION_MODE: "dry-run" }, noRead)).toThrow(/BUTCHR_STALL_REMEDIATION_MODE/);
    expect(() => loadConfig({ ...base, BUTCHR_STALL_REMEDIATION_MODE: "enforce" }, noRead)).toThrow(/BUTCHR_STALL_REMEDIATION_MODE/);
  });

  test("FACTORY-845: idlePokeSuppressMinutes defaults to 5, honours BUTCHR_IDLE_POKE_SUPPRESS_MINUTES, and rejects a non-positive value", () => {
    expect(loadConfig(base, noRead).idlePokeSuppressMinutes).toBe(5);
    expect(loadConfig({ ...base, BUTCHR_IDLE_POKE_SUPPRESS_MINUTES: "15" }, noRead).idlePokeSuppressMinutes).toBe(15);
    expect(() => loadConfig({ ...base, BUTCHR_IDLE_POKE_SUPPRESS_MINUTES: "0" }, noRead)).toThrow(/BUTCHR_IDLE_POKE_SUPPRESS_MINUTES/);
    expect(() => loadConfig({ ...base, BUTCHR_IDLE_POKE_SUPPRESS_MINUTES: "nope" }, noRead)).toThrow(/BUTCHR_IDLE_POKE_SUPPRESS_MINUTES/);
  });

  test("FACTORY-845: idlePokeMaxPerPoll defaults to 3, honours BUTCHR_IDLE_POKE_MAX_PER_POLL, and rejects a non-positive or fractional value", () => {
    expect(loadConfig(base, noRead).idlePokeMaxPerPoll).toBe(3);
    expect(loadConfig({ ...base, BUTCHR_IDLE_POKE_MAX_PER_POLL: "10" }, noRead).idlePokeMaxPerPoll).toBe(10);
    expect(() => loadConfig({ ...base, BUTCHR_IDLE_POKE_MAX_PER_POLL: "0" }, noRead)).toThrow(/BUTCHR_IDLE_POKE_MAX_PER_POLL/);
    expect(() => loadConfig({ ...base, BUTCHR_IDLE_POKE_MAX_PER_POLL: "1.5" }, noRead)).toThrow(/BUTCHR_IDLE_POKE_MAX_PER_POLL/);
  });

  test("abandonedMinutes defaults to 30, honours BUTCHR_ABANDONED_MINUTES, and rejects a non-positive value", () => {
    expect(loadConfig(base, noRead).abandonedMinutes).toBe(30);
    expect(loadConfig({ ...base, BUTCHR_ABANDONED_MINUTES: "45" }, noRead).abandonedMinutes).toBe(45);
    expect(() => loadConfig({ ...base, BUTCHR_ABANDONED_MINUTES: "0" }, noRead)).toThrow(/BUTCHR_ABANDONED_MINUTES/);
    expect(() => loadConfig({ ...base, BUTCHR_ABANDONED_MINUTES: "nope" }, noRead)).toThrow(/BUTCHR_ABANDONED_MINUTES/);
  });

  test("crashLoopCount defaults to 5, honours BUTCHR_CRASHLOOP_COUNT, and rejects a non-positive value", () => {
    expect(loadConfig(base, noRead).crashLoopCount).toBe(5);
    expect(loadConfig({ ...base, BUTCHR_CRASHLOOP_COUNT: "3" }, noRead).crashLoopCount).toBe(3);
    expect(() => loadConfig({ ...base, BUTCHR_CRASHLOOP_COUNT: "0" }, noRead)).toThrow(/BUTCHR_CRASHLOOP_COUNT/);
    expect(() => loadConfig({ ...base, BUTCHR_CRASHLOOP_COUNT: "nope" }, noRead)).toThrow(/BUTCHR_CRASHLOOP_COUNT/);
  });

  test("crashLoopWindowMinutes defaults to 60, honours BUTCHR_CRASHLOOP_WINDOW_MINUTES, and rejects a non-positive value", () => {
    expect(loadConfig(base, noRead).crashLoopWindowMinutes).toBe(60);
    expect(loadConfig({ ...base, BUTCHR_CRASHLOOP_WINDOW_MINUTES: "30" }, noRead).crashLoopWindowMinutes).toBe(30);
    expect(() => loadConfig({ ...base, BUTCHR_CRASHLOOP_WINDOW_MINUTES: "0" }, noRead)).toThrow(/BUTCHR_CRASHLOOP_WINDOW_MINUTES/);
    expect(() => loadConfig({ ...base, BUTCHR_CRASHLOOP_WINDOW_MINUTES: "nope" }, noRead)).toThrow(/BUTCHR_CRASHLOOP_WINDOW_MINUTES/);
  });

  test("describeConfig includes crashLoopCount/crashLoopWindowMinutes", () => {
    expect(describeConfig(loadConfig(base, noRead))).toContain("crashLoopCount=5 crashLoopWindowMinutes=60");
  });

  test("unresponsiveMinutes defaults to 5, honours BUTCHR_UNRESPONSIVE_MINUTES, and rejects a non-positive value", () => {
    expect(loadConfig(base, noRead).unresponsiveMinutes).toBe(5);
    expect(loadConfig({ ...base, BUTCHR_UNRESPONSIVE_MINUTES: "15" }, noRead).unresponsiveMinutes).toBe(15);
    expect(() => loadConfig({ ...base, BUTCHR_UNRESPONSIVE_MINUTES: "0" }, noRead)).toThrow(/BUTCHR_UNRESPONSIVE_MINUTES/);
    expect(() => loadConfig({ ...base, BUTCHR_UNRESPONSIVE_MINUTES: "nope" }, noRead)).toThrow(/BUTCHR_UNRESPONSIVE_MINUTES/);
  });

  test("pollStaleMs defaults to 60000, honours BUTCHR_POLL_STALE_MS, and rejects a non-positive value", () => {
    expect(loadConfig(base, noRead).pollStaleMs).toBe(60_000);
    expect(loadConfig({ ...base, BUTCHR_POLL_STALE_MS: "30000" }, noRead).pollStaleMs).toBe(30_000);
    expect(() => loadConfig({ ...base, BUTCHR_POLL_STALE_MS: "0" }, noRead)).toThrow(/BUTCHR_POLL_STALE_MS/);
    expect(() => loadConfig({ ...base, BUTCHR_POLL_STALE_MS: "nope" }, noRead)).toThrow(/BUTCHR_POLL_STALE_MS/);
  });
  test("describeConfig includes pollStaleMs", () => {
    expect(describeConfig(loadConfig(base, noRead))).toContain("pollStaleMs=60000");
  });

  test("FACTORY-751/FACTORY-775: herdrCallTimeoutMs defaults to 10000, honours BUTCHR_HERDR_TIMEOUT_MS, and rejects 0/negative/NaN/non-numeric", () => {
    expect(loadConfig(base, noRead).herdrCallTimeoutMs).toBe(10_000);
    expect(loadConfig({ ...base, BUTCHR_HERDR_TIMEOUT_MS: "5000" }, noRead).herdrCallTimeoutMs).toBe(5_000);
    for (const bad of ["0", "-1", "NaN", "nope"]) {
      expect(() => loadConfig({ ...base, BUTCHR_HERDR_TIMEOUT_MS: bad }, noRead)).toThrow(/BUTCHR_HERDR_TIMEOUT_MS/);
    }
  });
  test("FACTORY-751/FACTORY-775: herdrCallTimeoutMs throws above its ceiling (300000) instead of silently clamping", () => {
    expect(loadConfig({ ...base, BUTCHR_HERDR_TIMEOUT_MS: "300000" }, noRead).herdrCallTimeoutMs).toBe(300_000);
    expect(() => loadConfig({ ...base, BUTCHR_HERDR_TIMEOUT_MS: "300001" }, noRead)).toThrow(/BUTCHR_HERDR_TIMEOUT_MS/);
    // The specific overflow value the finding named (2147483648ms, which bun's
    // setTimeout silently wraps to ~1ms instead of waiting) must throw too,
    // not merely "some" large value above the ceiling.
    expect(() => loadConfig({ ...base, BUTCHR_HERDR_TIMEOUT_MS: "2147483648" }, noRead)).toThrow(/BUTCHR_HERDR_TIMEOUT_MS/);
  });
  // FACTORY-772: BOUNDED on both ends (as BUTCHR_HERDR_TIMEOUT_MS now is, too).
  test("loopWatchdogThresholdMs defaults to 120000, honours BUTCHR_LOOP_WATCHDOG_THRESHOLD_MS, and rejects NaN/below-min/above-max", () => {
    expect(loadConfig(base, noRead).loopWatchdogThresholdMs).toBe(120_000);
    expect(loadConfig({ ...base, BUTCHR_LOOP_WATCHDOG_THRESHOLD_MS: "60000" }, noRead).loopWatchdogThresholdMs).toBe(60_000);
    expect(() => loadConfig({ ...base, BUTCHR_LOOP_WATCHDOG_THRESHOLD_MS: "nope" }, noRead)).toThrow(/BUTCHR_LOOP_WATCHDOG_THRESHOLD_MS/);
    expect(() => loadConfig({ ...base, BUTCHR_LOOP_WATCHDOG_THRESHOLD_MS: "29999" }, noRead)).toThrow(/BUTCHR_LOOP_WATCHDOG_THRESHOLD_MS/);
    expect(() => loadConfig({ ...base, BUTCHR_LOOP_WATCHDOG_THRESHOLD_MS: "1800001" }, noRead)).toThrow(/BUTCHR_LOOP_WATCHDOG_THRESHOLD_MS/);
    expect(loadConfig({ ...base, BUTCHR_LOOP_WATCHDOG_THRESHOLD_MS: "30000" }, noRead).loopWatchdogThresholdMs).toBe(30_000);
    expect(loadConfig({ ...base, BUTCHR_LOOP_WATCHDOG_THRESHOLD_MS: "1800000" }, noRead).loopWatchdogThresholdMs).toBe(1_800_000);
  });
  test("describeConfig includes loopWatchdogThresholdMs", () => {
    expect(describeConfig(loadConfig(base, noRead))).toContain("loopWatchdogThresholdMs=120000");
  });

  test("assignees are parsed when both BUTCHR_ASSIGNEE_STORY/TASK are set", () => {
    const c = loadConfig({ ...base, BUTCHR_ASSIGNEE_STORY: "712020:story", BUTCHR_ASSIGNEE_TASK: "712020:task" }, noRead);
    expect(c.assignees).toEqual({ story: "712020:story", task: "712020:task" });
  });
  test("loadConfig does not throw when BUTCHR_ASSIGNEE_STORY/TASK are absent; roles are undefined", () => {
    const c = loadConfig(base, noRead);
    expect(c.assignees.story).toBeUndefined();
    expect(c.assignees.task).toBeUndefined();
  });
  test("describeConfig includes the resolved accountIds and names the consequence when a role is unset, never a token", () => {
    const both = describeConfig(loadConfig({ ...base, BUTCHR_ASSIGNEE_STORY: "000000:00000000-0000-0000-0000-000000000000", BUTCHR_ASSIGNEE_TASK: "000000:11111111-1111-1111-1111-111111111111" }, noRead));
    expect(both).toContain("assignees=story:000000:0000");
    expect(both).toContain("task:000000:1111");
    const none = describeConfig(loadConfig(base, noRead));
    expect(none).toContain("story:unset — Story creation will be refused");
    expect(none).toContain("task:unset — Task creation will be refused");
  });

  // BUTCHR-71 Contract 5: the epic role, same shape as story/task, never a
  // silent fallback to either.
  test("BUTCHR_ASSIGNEE_EPIC is parsed independently of story/task", () => {
    const c = loadConfig({ ...base, BUTCHR_ASSIGNEE_EPIC: "712020:epic" }, noRead);
    expect(c.assignees).toEqual({ epic: "712020:epic" });
  });
  test("loadConfig does not throw when BUTCHR_ASSIGNEE_EPIC is absent; the role is undefined, NOT defaulted from story/task", () => {
    const c = loadConfig({ ...base, BUTCHR_ASSIGNEE_STORY: "712020:story", BUTCHR_ASSIGNEE_TASK: "712020:task" }, noRead);
    expect(c.assignees.epic).toBeUndefined();
  });
  test("describeConfig includes the resolved epic accountId, and names the consequence when unset, never a token", () => {
    const set = describeConfig(loadConfig({ ...base, BUTCHR_ASSIGNEE_EPIC: "000000:00000000-0000-0000-0000-000000000000" }, noRead));
    expect(set).toContain("epic:000000:0000");
    const unset = describeConfig(loadConfig(base, noRead));
    expect(unset).toContain("epic:unset — Epic creation will be refused");
  });

  // BUTCHR-110/S2: role-map collision reporting at boot. Pairwise across the
  // SET roles only; unset stays a DIFFERENT condition (never conflated —
  // see the "unset" tests above, unaffected by any of this); and a HONESTY
  // CLAUSE is always present, collision or none, because a clean report is
  // the one case most likely to be misread as "every hop checked".
  describe("describeConfig: role-map collisions (BUTCHR-110/S2)", () => {
    test("story/task collision: names both env vars, both tiers, the hop, GitHub, and the shared accountId", () => {
      const d = describeConfig(loadConfig({ ...base, BUTCHR_ASSIGNEE_STORY: "712020:same-account", BUTCHR_ASSIGNEE_TASK: "712020:same-account" }, noRead));
      expect(d).toContain("BUTCHR_ASSIGNEE_STORY");
      expect(d).toContain("BUTCHR_ASSIGNEE_TASK");
      expect(d).toContain("story");
      expect(d).toContain("task");
      expect(d).toContain("SAME accountId");
      expect(d).toContain("712020:same…");
      expect(d).toContain("the story that owns a task");
      expect(d).toContain("GitHub refuses");
    });

    test("epic/task collision — the exact incident this ticket exists to surface — is caught the same way, uniformly", () => {
      const d = describeConfig(loadConfig({ ...base, BUTCHR_ASSIGNEE_TASK: "712020:collide", BUTCHR_ASSIGNEE_EPIC: "712020:collide" }, noRead));
      expect(d).toContain("BUTCHR_ASSIGNEE_TASK");
      expect(d).toContain("BUTCHR_ASSIGNEE_EPIC");
      expect(d).toContain("the epic that owns a task");
    });

    test("all three roles set to the SAME account reports every pair, not just one", () => {
      const d = describeConfig(loadConfig({ ...base, BUTCHR_ASSIGNEE_STORY: "712020:x", BUTCHR_ASSIGNEE_TASK: "712020:x", BUTCHR_ASSIGNEE_EPIC: "712020:x" }, noRead));
      expect(d).toContain("the epic that owns a story");
      expect(d).toContain("the epic that owns a task");
      expect(d).toContain("the story that owns a task");
    });

    test("no collision when all set roles genuinely differ", () => {
      const d = describeConfig(loadConfig({ ...base, BUTCHR_ASSIGNEE_STORY: "712020:aaa", BUTCHR_ASSIGNEE_TASK: "712020:bbb", BUTCHR_ASSIGNEE_EPIC: "712020:ccc" }, noRead));
      expect(d).not.toContain("SAME accountId");
      expect(d).toContain("none among this daemon's currently-SET roles");
    });

    test("an UNSET role is never reported as a collision, and the existing unset wording is unchanged — unset and collided are different conditions", () => {
      const d = describeConfig(loadConfig({ ...base, BUTCHR_ASSIGNEE_STORY: "712020:aaa" }, noRead)); // task/epic unset
      expect(d).not.toContain("SAME accountId");
      expect(d).toContain("task:unset — Task creation will be refused");
      expect(d).toContain("epic:unset — Epic creation will be refused");
    });

    // THE HONESTY CLAUSE (measured by BUTCHR-100, 2026-09-02): a local
    // pairwise comparison cannot see a tier staffed by a DIFFERENT daemon —
    // on that measured daemon, story/task differed locally while a live
    // Epic staffed elsewhere carried the SAME accountId as the local task
    // role, and a naive check reported a clean boot. The clause must
    // therefore appear REGARDLESS of whether a collision was found —
    // it qualifies the CLEAN report, which is the dangerous one.
    test("the honesty clause is present on a CLEAN report (no collision found) — this is the graded case", () => {
      const d = describeConfig(loadConfig({ ...base, BUTCHR_ASSIGNEE_STORY: "712020:aaa", BUTCHR_ASSIGNEE_TASK: "712020:bbb" }, noRead));
      expect(d).not.toContain("SAME accountId");
      expect(d).toContain("LOCALLY CONFIGURED");
      expect(d).toContain("DIFFERENT daemon");
      expect(d).toContain("NOT evidence");
    });

    test("the honesty clause is present on a COLLIDING report too — not only alongside a clean one", () => {
      const d = describeConfig(loadConfig({ ...base, BUTCHR_ASSIGNEE_STORY: "712020:same", BUTCHR_ASSIGNEE_TASK: "712020:same" }, noRead));
      expect(d).toContain("SAME accountId");
      expect(d).toContain("LOCALLY CONFIGURED");
      expect(d).toContain("project↔epic hop");
    });

    test("the honesty clause names the project↔epic gap, and points at S1 (new_worker/adopt_worker) as the check that actually catches it", () => {
      const d = describeConfig(loadConfig(base, noRead));
      expect(d).toContain("project↔epic hop");
      expect(d).toContain("new_worker/adopt_worker");
    });

    test("the whole collision report is scoped to THIS daemon, not the fleet", () => {
      const d = describeConfig(loadConfig(base, noRead));
      expect(d).toContain("roleCollisions(this daemon only)=");
    });
  });

  test("captureDir defaults to .captures under the workspace root; BUTCHR_CAPTURE_DIR overrides it", () => {
    const c = loadConfig(base, noRead);
    expect(c.captureDir).toBe(join(workspaceRoot(), ".captures"));
    expect(loadConfig({ ...base, BUTCHR_CAPTURE_DIR: "/tmp/captures" }, noRead).captureDir).toBe("/tmp/captures");
  });
  test("describeConfig includes captureDir", () => {
    expect(describeConfig(loadConfig({ ...base, BUTCHR_CAPTURE_DIR: "/tmp/captures" }, noRead))).toContain("captureDir=/tmp/captures");
  });

  // FACTORY-100/FACTORY-103: OFF by default, same all-or-nothing optional-object shape as `github` — absent BUTCHR_LIZARD_APPROVAL_SOUND means the field is undefined, not merely empty. The enable flag and the override path are TWO SEPARATE env vars: the common case (drovr's bundled default) needs only the flag.
  test("lizardApprovalSound is absent unless BUTCHR_LIZARD_APPROVAL_SOUND is set to a non-empty value", () => {
    expect(loadConfig(base, noRead).lizardApprovalSound).toBeUndefined();
    expect(loadConfig({ ...base, BUTCHR_LIZARD_APPROVAL_SOUND: "   " }, noRead).lizardApprovalSound).toBeUndefined();
    // A path alone, with the flag unset, must NOT enable the feature.
    expect(loadConfig({ ...base, BUTCHR_LIZARD_APPROVAL_SOUND_PATH: "/x/lizard.mp3" }, noRead).lizardApprovalSound).toBeUndefined();
  });
  test("BUTCHR_LIZARD_APPROVAL_SOUND alone enables it with no override (drovr's bundled default)", () => {
    expect(loadConfig({ ...base, BUTCHR_LIZARD_APPROVAL_SOUND: "1" }, noRead).lizardApprovalSound).toEqual({});
  });
  test("BUTCHR_LIZARD_APPROVAL_SOUND_PATH (trimmed), alongside the flag, sets overridePath", () => {
    expect(loadConfig({ ...base, BUTCHR_LIZARD_APPROVAL_SOUND: "1", BUTCHR_LIZARD_APPROVAL_SOUND_PATH: "  ~/.local/share/butchr/sounds/lizard-button.mp3  " }, noRead).lizardApprovalSound).toEqual({ overridePath: "~/.local/share/butchr/sounds/lizard-button.mp3" });
  });
  test("describeConfig reports lizardApprovalSound as disabled, enabled with the default, or enabled with its override path", () => {
    expect(describeConfig(loadConfig(base, noRead))).toContain("lizardApprovalSound=disabled");
    expect(describeConfig(loadConfig({ ...base, BUTCHR_LIZARD_APPROVAL_SOUND: "1" }, noRead))).toContain("lizardApprovalSound=enabled overridePath=(default: drovr's bundled asset)");
    expect(describeConfig(loadConfig({ ...base, BUTCHR_LIZARD_APPROVAL_SOUND: "1", BUTCHR_LIZARD_APPROVAL_SOUND_PATH: "/x/lizard.mp3" }, noRead))).toContain("lizardApprovalSound=enabled overridePath=/x/lizard.mp3");
  });

  // FACTORY-581 SAFETY GUARD 4: OFF (undefined) by default — unset or
  // blank/whitespace-only means permission-answering stays fleet-wide, the
  // exact behaviour before this field existed; no new flag, only a narrowing
  // value for the EXISTING eligiblePanes gate (src/daemon/index.ts).
  test("permissionAnswerCanaryPaneLabel is absent unless BUTCHR_PERMISSION_ANSWER_CANARY_PANE is set to a non-empty value", () => {
    expect(loadConfig(base, noRead).permissionAnswerCanaryPaneLabel).toBeUndefined();
    expect(loadConfig({ ...base, BUTCHR_PERMISSION_ANSWER_CANARY_PANE: "   " }, noRead).permissionAnswerCanaryPaneLabel).toBeUndefined();
  });
  test("BUTCHR_PERMISSION_ANSWER_CANARY_PANE (trimmed) sets the canary label", () => {
    expect(loadConfig({ ...base, BUTCHR_PERMISSION_ANSWER_CANARY_PANE: "  admin-brooswit-nexus  " }, noRead).permissionAnswerCanaryPaneLabel).toBe("admin-brooswit-nexus");
  });
  test("describeConfig reports the canary label, or that it's unset (fleet-wide)", () => {
    expect(describeConfig(loadConfig(base, noRead))).toContain("permissionAnswerCanaryPaneLabel=(unset — permission-answering is fleet-wide)");
    expect(describeConfig(loadConfig({ ...base, BUTCHR_PERMISSION_ANSWER_CANARY_PANE: "admin-brooswit-nexus" }, noRead))).toContain("permissionAnswerCanaryPaneLabel=admin-brooswit-nexus");
  });

  // BUTCHR-91/BUTCHR-68: the project tier's opt-in staffing scope, default
  // OFF. Paired control, same shape as the github-orgs tests above: an
  // implementation that always returns [] (reject-everything) would pass
  // the first assertion alone but fail the second; one that ignores the env
  // entirely and returns something non-empty by default would fail the
  // first. Only a real comma-split-and-trim parser passes both.
  test("projectAllowlist defaults to empty when BUTCHR_PROJECT_ALLOWLIST is unset", () => {
    expect(loadConfig(base, noRead).projectAllowlist).toEqual([]);
  });
  test("projectAllowlist is comma-split and trimmed when BUTCHR_PROJECT_ALLOWLIST is set", () => {
    const c = loadConfig({ ...base, BUTCHR_PROJECT_ALLOWLIST: "ACME, BETA ,GAMMA" }, noRead);
    expect(c.projectAllowlist).toEqual(["ACME", "BETA", "GAMMA"]);
  });
  test("describeConfig states the allowlist plainly — empty as an explicit 'staffs nothing', non-empty as the actual keys", () => {
    expect(describeConfig(loadConfig(base, noRead))).toContain("projectAllowlist=EMPTY — project tier staffs nothing");
    expect(describeConfig(loadConfig({ ...base, BUTCHR_PROJECT_ALLOWLIST: "ACME" }, noRead))).toContain("projectAllowlist=ACME");
  });

  test("maxAgents (BUTCHR-284) defaults to 8, honours BUTCHR_MAX_AGENTS, and rejects a non-positive or non-integer value", () => {
    expect(loadConfig(base, noRead).maxAgents).toBe(8);
    expect(loadConfig({ ...base, BUTCHR_MAX_AGENTS: "20" }, noRead).maxAgents).toBe(20);
    expect(() => loadConfig({ ...base, BUTCHR_MAX_AGENTS: "0" }, noRead)).toThrow(/BUTCHR_MAX_AGENTS/);
    expect(() => loadConfig({ ...base, BUTCHR_MAX_AGENTS: "-1" }, noRead)).toThrow(/BUTCHR_MAX_AGENTS/);
    expect(() => loadConfig({ ...base, BUTCHR_MAX_AGENTS: "nope" }, noRead)).toThrow(/BUTCHR_MAX_AGENTS/);
    // a count, unlike the *_MINUTES knobs above — a fractional value is rejected, not merely a non-positive one.
    expect(() => loadConfig({ ...base, BUTCHR_MAX_AGENTS: "3.5" }, noRead)).toThrow(/BUTCHR_MAX_AGENTS/);
  });
  test("describeConfig includes maxAgents", () => {
    expect(describeConfig(loadConfig(base, noRead))).toContain("maxAgents=8");
  });

  // Rocket.Chat support is gone. Every variable it used to read is now
  // ignored — including values that used to stop startup — so an older
  // `.env` still starts the daemon unchanged.
  test("the removed Rocket.Chat and ops-alert-room env vars are ignored, even with values that used to be refused", () => {
    const legacy = {
      ROCKETCHAT_URL: "https://chat.x", ROCKETCHAT_ADMIN_USER_ID: "a1", ROCKETCHAT_ADMIN_TOKEN_FILE: "/etc/rc-token",
      ROCKETCHAT_USER_CAP_THRESHOLD: "not-a-number-at-all", ROCKETCHAT_TEMPORARY_CAP_THRESHOLD: "-1",
      ROCKETCHAT_TOKEN_DIR: "/x", ROCKETCHAT_NEXUS_MANIFEST_FILE: "/y", ROCKETCHAT_MANAGED_PREFIX: "acme_",
      BUTCHR_TEAM_ADMIN_ROCKETCHAT_URL: "https://chat.x", BUTCHR_TEAM_ADMIN_ROCKETCHAT_USER_ID: "a1", BUTCHR_TEAM_ADMIN_ROCKETCHAT_TOKEN_FILE: "/etc/ta-token",
      BUTCHR_TEAM_ADMIN_ROOM: "ops-alerts", BUTCHR_OPS_ALERT_ROOM: "team-engineering", BUTCHR_OPS_ALERT_MENTION: "@manager-factory",
    };
    const withLegacy = loadConfig({ ...base, ...legacy } as typeof base, noRead);
    expect(withLegacy).toEqual(loadConfig(base, noRead));
    expect(Object.keys(withLegacy)).not.toContain("rocketchat");
    expect(Object.keys(withLegacy)).not.toContain("managedEscalationRocketChat");
  });

  describe("opsAlert (FACTORY-630)", () => {
    test("defaults to the director's one-hour dedup window, with no env set at all", () => {
      expect(loadConfig(base, noRead).opsAlert).toEqual({ dedupMinutes: 60 });
    });

    test("the window is overridable", () => {
      expect(loadConfig({ ...base, BUTCHR_OPS_ALERT_DEDUP_MINUTES: "15" }, noRead).opsAlert).toEqual({ dedupMinutes: 15 });
    });

    test("rejects a non-positive or non-numeric dedup window rather than silently disabling dedup", () => {
      expect(() => loadConfig({ ...base, BUTCHR_OPS_ALERT_DEDUP_MINUTES: "0" }, noRead)).toThrow();
      expect(() => loadConfig({ ...base, BUTCHR_OPS_ALERT_DEDUP_MINUTES: "-5" }, noRead)).toThrow();
      expect(() => loadConfig({ ...base, BUTCHR_OPS_ALERT_DEDUP_MINUTES: "soon" }, noRead)).toThrow();
    });

    test("describeConfig names the window and nothing about Rocket.Chat", () => {
      const d = describeConfig(loadConfig(base, noRead));
      expect(d).toContain("opsAlertDedupMinutes=60");
      for (const gone of ["rocketchat=", "managedEscalationRocketChat=", "team-admin", "@director", "posting credential"]) expect(d).not.toContain(gone);
    });
  });
});

describe("extensionAuth (FACTORY-339; FACTORY-464/FACTORY-465 dropped the bearer token; FACTORY-497/FACTORY-475 hardcodes Cleavr's fixed id as the ONLY allowed origin)", () => {
  const CLEAVR_ORIGIN = "chrome-extension://geffpgminecanhmpafbliajpeleoocan";

  // FACTORY-497: removed the tests for the three-way unset/explicit-empty/
  // additive env semantics (`BUTCHR_EXTENSION_ORIGINS` had a real effect on
  // the allowlist) — there is no longer any env-driven allowlist behavior
  // to assert: `loadConfig` never reads that variable into `extensionAuth`
  // at all any more, so those cases no longer exist to test. No security
  // assertion is weakened: the replacement tests below still assert the
  // fixed id is allowed, every other id is rejected, and absent Origin is
  // refused — plus a new assertion (below) that the variable's value now
  // has NO effect on the allowlist, which is a strictly stronger claim than
  // "additive" ever was.

  test("extensionAuth is always exactly Cleavr's fixed id, regardless of environment", () => {
    const c = loadConfig(base, noRead);
    expect(c.extensionAuth).toEqual({ allowedOrigins: [CLEAVR_ORIGIN] });
  });
  test("setting BUTCHR_EXTENSION_ORIGINS has no effect on the allowlist, however it's set", () => {
    for (const value of ["chrome-extension://abcdefghijklmnopabcdefghijklmnop", "", "not-a-uri-at-all", ","]) {
      const c = loadConfig({ ...base, BUTCHR_EXTENSION_ORIGINS: value }, noRead);
      expect(c.extensionAuth).toEqual({ allowedOrigins: [CLEAVR_ORIGIN] });
    }
  });
  test("setting BUTCHR_EXTENSION_ORIGINS triggers the ignored-variable warning; unset does not", () => {
    expect(ignoredExtensionOriginsWarning({ ...base, BUTCHR_EXTENSION_ORIGINS: "chrome-extension://abcdefghijklmnopabcdefghijklmnop" })).toContain("BUTCHR_EXTENSION_ORIGINS");
    expect(ignoredExtensionOriginsWarning({ ...base, BUTCHR_EXTENSION_ORIGINS: "" })).toContain("BUTCHR_EXTENSION_ORIGINS");
    expect(ignoredExtensionOriginsWarning(base)).toBeUndefined();
  });
  test("describeConfig reports the single fixed-id allowlist", () => {
    expect(describeConfig(loadConfig(base, noRead))).toContain(`extensionAuth=origins=${CLEAVR_ORIGIN}`);
  });
});

describe("guard behavior with the real config (FACTORY-497/FACTORY-475)", () => {
  const CLEAVR_ORIGIN = "chrome-extension://geffpgminecanhmpafbliajpeleoocan";

  test("default config allows the fixed Cleavr id and rejects any other origin", () => {
    const c = loadConfig(base, noRead);
    expect(checkExtensionOrigin({ origin: CLEAVR_ORIGIN }, c.extensionAuth).ok).toBe(true);
    expect(checkExtensionOrigin({ origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop" }, c.extensionAuth).ok).toBe(false);
  });
  test("absent Origin is still refused (403) even with the default allowlist populated", () => {
    const c = loadConfig(base, noRead);
    const r = checkExtensionOrigin({ origin: null }, c.extensionAuth);
    expect(r).toEqual({ ok: false, status: 403, body: { error: "origin required" }, corsHeaders: {}, reason: "origin required" });
  });
});

describe("FACTORY-665 (PR-2): isAtlassianConfigured / validateAtlassianSiteShape", () => {
  test("isAtlassianConfigured is true only when site+email+(token or token file) are all present and non-blank", () => {
    expect(isAtlassianConfigured(base)).toBe(true);
    expect(isAtlassianConfigured({ ...base, ATLASSIAN_SITE: undefined })).toBe(false);
    expect(isAtlassianConfigured({ ...base, ATLASSIAN_SITE: "  " })).toBe(false);
    expect(isAtlassianConfigured({ ...base, ATLASSIAN_EMAIL: undefined })).toBe(false);
    expect(isAtlassianConfigured({ ...base, ATLASSIAN_TOKEN: undefined })).toBe(false);
    expect(isAtlassianConfigured({ ...base, ATLASSIAN_TOKEN: undefined, ATLASSIAN_TOKEN_FILE: "/t" })).toBe(true);
  });
  test("isAtlassianConfigured never validates the site's shape — only presence (loadConfig/validateAtlassianSiteShape own that)", () => {
    expect(isAtlassianConfigured({ ...base, ATLASSIAN_SITE: "not a url at all" })).toBe(true);
  });
  test("validateAtlassianSiteShape accepts exactly https://<name>.atlassian.net, case-insensitively, and rejects everything else", () => {
    expect(() => validateAtlassianSiteShape("https://x.atlassian.net")).not.toThrow();
    expect(() => validateAtlassianSiteShape("https://my-team.atlassian.net")).not.toThrow();
    expect(() => validateAtlassianSiteShape("HTTPS://X.ATLASSIAN.NET")).not.toThrow();
    for (const bad of ["https://evil.example.com", "http://x.atlassian.net", "https://x.atlassian.net/", "https://x.atlassian.net/path", "https://x.atlassian.net:443", "https://x.atlassian.net.evil.com", "https://.atlassian.net", "https://-x.atlassian.net", "ftp://x.atlassian.net", ""]) {
      expect(() => validateAtlassianSiteShape(bad)).toThrow(/ATLASSIAN_SITE must look like/);
    }
  });
});
