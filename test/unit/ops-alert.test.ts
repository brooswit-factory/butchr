/**
 * FACTORY-630: the ops-alert route — the push destination `credential-dead`
 * never had.
 *
 * STUB POSTER AND STUB CLOCK ONLY, per the ticket's own test requirement:
 * nothing here opens a socket, reads a token file, or consults a real clock,
 * and no hostile string is ever handed to a shell — the adversarial inputs
 * below are asserted as TEXT, which is the only place they could ever do
 * harm (a Rocket.Chat room's renderer, and a human reading a labelled
 * block).
 */
import { describe, expect, test } from "bun:test";
import { createOpsAlertRouter, opsAlertMessage, opsRecoveryMessage, OPS_ALERT_MARKER, type OpsAlert } from "../../src/agents/ops-alert.js";
import { WHOLE_MESSAGE_BUDGET } from "../../src/agents/rocketchat-text.js";

const HOUR = 60 * 60_000;

/**
 * Drain the microtask queue. `raise` is deliberately synchronous and
 * dispatches its post fire-and-forget, so a test has to let the promise
 * chain settle before asserting on what was posted or logged. Pure
 * microtasks only — no timer, no real clock anywhere in this file.
 */
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

function harness(opts: { post?: (room: string, text: string) => Promise<void>; dedupWindowMs?: number; mention?: string } = {}) {
  const lines: string[] = [];
  const posts: { room: string; text: string }[] = [];
  let t = 1_700_000_000_000;
  const post = opts.post ?? (async (room: string, text: string) => { posts.push({ room, text }); });
  const router = createOpsAlertRouter({
    post,
    room: "team-admin",
    mention: opts.mention ?? "@director",
    host: "servyboi",
    now: () => t,
    log: (line) => lines.push(line),
    ...(opts.dedupWindowMs !== undefined ? { dedupWindowMs: opts.dedupWindowMs } : {}),
  });
  return { router, lines, posts, advance: (ms: number) => { t += ms; } };
}

/** The router with NO poster configured at all — the ordinary state of a daemon that has not been granted a posting credential. */
function unconfiguredHarness() {
  const lines: string[] = [];
  let t = 0;
  const router = createOpsAlertRouter({ room: "team-admin", mention: "@director", host: "servyboi", now: () => t, log: (line) => lines.push(line) });
  return { router, lines, advance: (ms: number) => { t += ms; } };
}

const ALERT: OpsAlert = {
  key: "credential-dead:servyboi",
  condition: "credential-dead",
  subject: "daemon servyboi (panes: w1T:p1)",
  reason: "Login expired · Please run /login",
  remedy: "A human must run an interactive browser /login.",
};

describe("createOpsAlertRouter (FACTORY-630) — posting and dedup", () => {
  test("the FIRST raise posts, to the configured room, with the condition, the subject and the reason all in the text", async () => {
    const { router, posts } = harness();

    router.raise(ALERT);
    await flush();

    expect(posts.length).toBe(1);
    expect(posts[0]!.room).toBe("team-admin");
    expect(posts[0]!.text).toInclude("credential-dead");
    expect(posts[0]!.text).toInclude("servyboi");
    expect(posts[0]!.text).toInclude("w1T:p1");
    expect(posts[0]!.text).toInclude("Login expired");
  });

  test("a SECOND raise of the same key inside the hour does NOT post again (the director's one-per-condition-per-hour), and says so in the journal rather than silently", async () => {
    const { router, posts, lines, advance } = harness();

    router.raise(ALERT);
    await flush();
    expect(posts.length).toBe(1);

    // The credential-death caller raises on EVERY poll while the condition
    // holds — 5-second polls over 59 minutes is the real shape here.
    advance(59 * 60_000);
    router.raise(ALERT);
    await flush();

    expect(posts.length).toBe(1);
    // Not silent: the pull channel keeps full fidelity, so a human can always
    // reconstruct what the room did not say.
    expect(lines.some((l) => l.startsWith(OPS_ALERT_MARKER) && l.includes("suppressed as a duplicate"))).toBe(true);
  });

  test("once the hour has elapsed, a raise for the same still-open condition posts AGAIN", async () => {
    const { router, posts, advance } = harness();

    router.raise(ALERT);
    await flush();
    advance(HOUR + 1);
    router.raise(ALERT);
    await flush();

    expect(posts.length).toBe(2);
  });

  test("two DIFFERENT keys are deduplicated independently — one condition's post never suppresses another's", async () => {
    const { router, posts } = harness();

    router.raise(ALERT);
    router.raise({ ...ALERT, key: "crash-loop:servyboi", condition: "crash-loop", reason: "FACTORY-9 respawned 7 times in 6m" });
    await flush();

    expect(posts.length).toBe(2);
    expect(posts[1]!.text).toInclude("crash-loop");
  });

  test("the dedup window is configurable, not a hardcoded hour — a 10-minute window posts again after 10 minutes", async () => {
    const { router, posts, advance } = harness({ dedupWindowMs: 10 * 60_000 });

    router.raise(ALERT);
    await flush();
    advance(10 * 60_000 + 1);
    router.raise(ALERT);
    await flush();

    expect(posts.length).toBe(2);
  });

  test("a per-alert dedup window actually DEDUPLICATES: two raises inside it post once, a third after it posts again (PR #631 manager review)", async () => {
    // The regression this pins: the cap instance used to be CONSTRUCTED PER
    // CALL for any alert overriding its window, so `allow()` always saw
    // empty state and such an alert posted on EVERY raise — dedup silently
    // off for exactly the callers that asked for a different window. The
    // earlier version of this test only advanced PAST the window and
    // asserted two posts, which passes whether or not dedup works; the
    // inside-the-window assertion below is what makes it a real test.
    const { router, posts, advance } = harness({ dedupWindowMs: HOUR });
    const short = { ...ALERT, dedupWindowMs: 5 * 60_000 };

    router.raise(short);
    await flush();
    advance(4 * 60_000);
    router.raise(short);
    await flush();

    expect(posts.length).toBe(1);

    advance(60_000 + 1); // now past the 5-minute window
    router.raise(short);
    await flush();

    expect(posts.length).toBe(2);
  });

  test("a different key with a different window is independent — sharing one cap instance per window length must not couple distinct keys", async () => {
    const { router, posts, advance } = harness({ dedupWindowMs: HOUR });

    router.raise({ ...ALERT, dedupWindowMs: 5 * 60_000 });
    router.raise({ ...ALERT, key: "crash-loop:servyboi", condition: "crash-loop", dedupWindowMs: 10 * 60_000 });
    await flush();
    expect(posts.length).toBe(2);

    // Each key is still deduplicated on its OWN window: at 6 minutes the
    // 5-minute key may post again and the 10-minute key may not.
    advance(6 * 60_000);
    router.raise({ ...ALERT, dedupWindowMs: 5 * 60_000 });
    router.raise({ ...ALERT, key: "crash-loop:servyboi", condition: "crash-loop", dedupWindowMs: 10 * 60_000 });
    await flush();

    expect(posts.length).toBe(3);
    expect(posts[2]!.text).toInclude("credential-dead");
  });

  test("two raises of the same key on the ROUTER's default window also post once inside it — the kept-instance fix must not regress the un-overridden path", async () => {
    const { router, posts, advance } = harness({ dedupWindowMs: 10 * 60_000 });

    router.raise(ALERT);
    await flush();
    advance(9 * 60_000);
    router.raise(ALERT);
    await flush();

    expect(posts.length).toBe(1);
  });

  test("a recovery window is overridable on the same terms, and deduplicates", async () => {
    const { router, posts, advance } = harness({ dedupWindowMs: HOUR });
    const rec = { key: ALERT.key, condition: "credential-dead", subject: "daemon servyboi", note: "recovered", dedupWindowMs: 5 * 60_000 };

    router.raise(ALERT);
    await flush();
    router.recover(rec);
    await flush();
    expect(posts.length).toBe(2);

    // A second recovery inside its own window, after a fresh alert re-armed
    // the `posted` gate, is still suppressed as a duplicate.
    router.raise(ALERT);
    await flush();
    advance(60_000);
    router.recover(rec);
    await flush();

    expect(posts.length).toBe(2);
  });

  test("the suppression journal line names the window that actually applied, not the router's default", async () => {
    const { router, lines } = harness({ dedupWindowMs: HOUR });
    const short = { ...ALERT, dedupWindowMs: 5 * 60_000 };

    router.raise(short);
    await flush();
    router.raise(short);
    await flush();

    expect(lines.some((l) => l.includes("inside the 5m dedup window"))).toBe(true);
    expect(lines.some((l) => l.includes("inside the 60m dedup window"))).toBe(false);
  });
});

describe("createOpsAlertRouter (FACTORY-630) — recovery", () => {
  test("a recovery after a posted alert gets ONE short recovered post naming the condition", async () => {
    const { router, posts } = harness();

    router.raise(ALERT);
    await flush();
    router.recover({ key: ALERT.key, condition: "credential-dead", subject: "daemon servyboi", note: "credential recovered after 900s" });
    await flush();

    expect(posts.length).toBe(2);
    expect(posts[1]!.text).toInclude("cleared");
    expect(posts[1]!.text).toInclude("credential-dead");
    expect(posts[1]!.text).toInclude("recovered after 900s");
    // "short": the recovery post is materially smaller than the alert it clears.
    expect(posts[1]!.text.length).toBeLessThan(posts[0]!.text.length);
  });

  test("a recovery whose alert was NEVER successfully posted posts NOTHING — a lone 'recovered' for a condition the room never heard about reads as one somebody else already handled", async () => {
    const { router, posts, lines } = harness();

    router.recover({ key: ALERT.key, condition: "credential-dead", subject: "daemon servyboi", note: "recovered" });
    await flush();

    expect(posts.length).toBe(0);
    expect(lines.some((l) => l.includes("nothing to clear there"))).toBe(true);
  });

  test("the recovery post is NOT suppressed by the alert's own dedup window — they are separate events, capped separately", async () => {
    const { router, posts } = harness();

    // Alert and recovery in the same instant: if they shared one cap key, the
    // recovery would be swallowed as a duplicate of the alert.
    router.raise(ALERT);
    await flush();
    router.recover({ key: ALERT.key, condition: "credential-dead", subject: "daemon servyboi", note: "recovered" });
    await flush();

    expect(posts.length).toBe(2);
  });

  test("a FLAPPING condition cannot spam the room: expire/recover/expire inside one window yields the first alert and the first recovery only", async () => {
    const { router, posts, advance } = harness();

    router.raise(ALERT);
    await flush();
    advance(60_000);
    router.recover({ key: ALERT.key, condition: "credential-dead", subject: "daemon servyboi", note: "recovered" });
    await flush();
    advance(60_000);
    router.raise(ALERT); // dead again, 2 minutes later
    await flush();
    advance(60_000);
    router.recover({ key: ALERT.key, condition: "credential-dead", subject: "daemon servyboi", note: "recovered again" });
    await flush();

    expect(posts.length).toBe(2);
    expect(posts.map((p) => p.text.includes("cleared"))).toEqual([false, true]);
  });
});

describe("createOpsAlertRouter (FACTORY-630) — failure modes never reach the caller", () => {
  test("an UNCONFIGURED poster logs ONCE per key and never throws — the journal line and /health remain the alert's channels, exactly as before this ticket", () => {
    const { router, lines } = unconfiguredHarness();

    expect(() => { router.raise(ALERT); router.raise(ALERT); router.raise(ALERT); }).not.toThrow();

    const warnings = lines.filter((l) => l.includes("posting is not configured"));
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toStartWith(OPS_ALERT_MARKER);
  });

  test("a REJECTED post is logged as a WARNING, never thrown into the caller, and does NOT consume the dedup window — the next raise retries", async () => {
    let attempts = 0;
    const { router, lines } = harness({
      post: async () => { attempts++; throw new Error("HTTP 503"); },
    });

    expect(() => router.raise(ALERT)).not.toThrow();
    await flush();
    await flush();
    expect(attempts).toBe(1);
    expect(lines.some((l) => l.startsWith(`WARNING: ${OPS_ALERT_MARKER}`) && l.includes("HTTP 503"))).toBe(true);

    // Same instant, well inside the window: a failure must not have latched it.
    router.raise(ALERT);
    await flush();
    expect(attempts).toBe(2);
  });

  test("a raise while a post for the same key is still IN FLIGHT does not dispatch a second one", async () => {
    let attempts = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { router } = harness({ post: async () => { attempts++; await gate; } });

    router.raise(ALERT);
    await flush();
    router.raise(ALERT);
    await flush();

    expect(attempts).toBe(1);
    release();
  });

  test("a post that throws SYNCHRONOUSLY (not a rejected promise) still cannot reach the caller", () => {
    const { router } = harness({ post: (() => { throw new Error("sync boom"); }) as unknown as (room: string, text: string) => Promise<void> });

    // `raise` is documented as never throwing. A synchronous throw from the
    // injected poster is the one shape a bare `void post(...).catch()` would
    // NOT catch, so it is asserted separately from the rejection case above.
    expect(() => router.raise(ALERT)).not.toThrow();
  });
});

describe("opsAlertMessage (FACTORY-630) — FACTORY-611's hardened-post properties are kept, not re-derived", () => {
  test("a SECRET in the reason is redacted before it reaches the room", () => {
    const text = opsAlertMessage({ ...ALERT, reason: "refresh failed: Authorization: Bearer sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }, "servyboi", "@director");

    expect(text).not.toInclude("sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
  });

  test("an `@all` in the reason cannot ping a room from butchr's bot account — every `@` is neutralised except the intended header mention", () => {
    const text = opsAlertMessage({ ...ALERT, reason: "pane said @all @here come look" }, "servyboi", "@director");

    // The header's own mention is intact and is the FIRST thing in the post.
    expect(text).toStartWith("@director ");
    // Every other `@` carries a zero-width space, so nothing in the quoted
    // text can resolve as a mention.
    expect(text).not.toInclude("@all");
    expect(text).not.toInclude("@here");
    expect(text).toInclude("@​all");
  });

  test("a 3-backtick run in the reason cannot close the fence the post itself uses", () => {
    const text = opsAlertMessage({ ...ALERT, reason: "``` not a fence ```" }, "servyboi", "@director");

    // Exactly two fences in the whole message: the block's own open and close.
    expect(text.split(/^```$/m).length - 1).toBe(2);
  });

  test("a URL in the reason is defanged rather than autolinked", () => {
    const text = opsAlertMessage({ ...ALERT, reason: "see https://evil.example/login" }, "servyboi", "@director");

    expect(text).not.toInclude("https://evil.example");
    expect(text).toInclude("https:​//evil.example");
  });

  test("a newline in the reason cannot forge one of the post's own labelled lines", () => {
    const text = opsAlertMessage({ ...ALERT, reason: "benign\nhost: not-really-this-host\ncondition: all-clear" }, "servyboi", "@director");

    // Flattened to one line with a visible marker, so neither forged label
    // ever starts a line a human would read as the message's own field.
    expect(text).not.toMatch(/^host: not-really-this-host$/m);
    expect(text).not.toMatch(/^condition: all-clear$/m);
    expect(text).toInclude(" ⏎ ");
    // And the REAL host line is still there, exactly once.
    expect(text.match(/^host: servyboi$/gm)?.length).toBe(1);
  });

  test("a control character and a bidi override in the reason are stripped", () => {
    const text = opsAlertMessage({ ...ALERT, reason: "a\u0007b\u202Ec" }, "servyboi", "@director");

    expect(text).not.toInclude("\u0007");
    expect(text).not.toInclude("\u202E");
    expect(text).toInclude("reason: abc");
  });

  test("a pathologically long reason is truncated with a stated marker", () => {
    // Deliberately ordinary prose repeated, not a long run of one character:
    // `redact()` recognises a long high-entropy token and replaces the whole
    // thing with `[redacted]`, which would make this test pass for the wrong
    // reason (nothing truncated — everything redacted).
    const text = opsAlertMessage({ ...ALERT, reason: "pane output line, nothing secret here. ".repeat(500) }, "servyboi", "@director");

    expect(text).toInclude("[truncated");
  });

  test("the WORST CASE — every field at its cap — provably fits Rocket.Chat's message budget, which is what lets this module have no whole-message shrink pass", () => {
    // This is the assertion that makes `SUBJECT_CAP`/`REMEDY_CAP` plus the
    // per-field reason ceiling a PROOF rather than a hope. It fails if a
    // field is added to the post, or a cap raised, past the point where a
    // worst-case message would be refused by Rocket.Chat for exceeding
    // `Message_MaxAllowedSize` (5000; butchr budgets 4500).
    const text = opsAlertMessage(
      {
        key: "k",
        condition: "c".repeat(5_000),
        subject: "s".repeat(5_000),
        reason: "reason text that is not secret-shaped. ".repeat(5_000),
        remedy: "r".repeat(5_000),
      },
      "h".repeat(5_000),
      "@director",
    );

    expect(text.length).toBeLessThanOrEqual(WHOLE_MESSAGE_BUDGET);
  });

  test("a worst-case RECOVERY post fits the same budget", () => {
    const text = opsRecoveryMessage({ key: "k", condition: "c".repeat(5_000), subject: "s".repeat(5_000), note: "note text, nothing secret. ".repeat(5_000) }, "h".repeat(5_000), "@director");

    expect(text.length).toBeLessThanOrEqual(WHOLE_MESSAGE_BUDGET);
  });


  test("the post is useful ON ITS OWN — it names the host, the condition, the subject, the reason and the remedy, because the room it goes to is one the posting account cannot read", () => {
    const text = opsAlertMessage(ALERT, "servyboi", "@director");

    expect(text).toInclude("host: servyboi");
    expect(text).toInclude("condition: credential-dead");
    expect(text).toInclude("subject: daemon servyboi");
    expect(text).toInclude("reason: Login expired");
    expect(text).toInclude("remedy: A human must run");
  });

  test("an empty mention posts with no mention at all (the `none` config case) and still leads with the condition", () => {
    const text = opsAlertMessage(ALERT, "servyboi", "");

    expect(text).not.toInclude("@director");
    expect(text).toStartWith("**ops alert: credential-dead**");
  });

  test("a `remedy`-less alert says so explicitly rather than emitting an empty field", () => {
    const { remedy: _remedy, ...withoutRemedy } = ALERT;
    const text = opsAlertMessage(withoutRemedy, "servyboi", "@director");

    expect(text).toInclude("remedy: (none stated)");
  });
});
