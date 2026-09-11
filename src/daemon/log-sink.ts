import { format } from "node:util";

/**
 * BUTCHR-346 (implementing BUTCHR-316's own (C)): the daemon's LOG SINK — the
 * one seam every application log line passes through immediately before it
 * reaches this process's real `stderr` writer, regardless of which
 * subsystem's own `log`/`deps.log` callback produced it.
 *
 * WHY A SINK, NOT ANOTHER EMITTER-SIDE FIX: `src/tools/outcome.ts`'s
 * `parseOutcomeLine` and `src/tools/alias-audit.ts`'s `parseAliasAuditLine`
 * both anchor their tag to the START of a *journal* line — which is the
 * start of an *application* log line only when that log line carries no raw
 * newline. `journalctl` gives each PHYSICAL line of a multi-line write its
 * own full transport prefix (measured, see the ticket), so a raw newline in
 * text the daemon does not control (captured agent pane text, a session-limit
 * watcher's raw refusal text, an escalated prompt's question/answer text, …)
 * lands a second "line" that reads exactly like a fresh journal entry — and
 * if that text happens to contain something tag-shaped, it forges a record
 * neither reader can ever tell apart from a genuine one, because the
 * distinguishing information is genuinely not on the line (see each parser's
 * own doc comment). No reader-side pattern can close this; it has to close
 * at the point a raw newline could still reach the actual writer.
 *
 * WHY THE GLOBAL `console.error` PATCH, NOT A SHARED HELPER FUNCTION CALLED BY
 * EVERY EMITTER: this codebase has no single existing call site all daemon
 * logging already funnels through — `console.error` is the default for half
 * a dozen `log:` parameters (`src/tools/defs.ts`, `src/daemon/app.ts`,
 * `src/resources/project.ts`, `src/tools/docs.ts`, `src/tools/relationship.ts`,
 * `src/tools/speak.ts`) AND is called directly, inline, at dozens of sites in
 * `src/daemon/index.ts` (re-derive the current count yourself — it changes
 * often). Wrapping each of those individually is exactly the "closed the
 * case in front of it, not the class" pattern this story has already spent
 * three review rounds on (see BUTCHR-343's own history) — a future emitter
 * that reaches for `console.error` directly, the obvious and idiomatic thing
 * to do in this codebase, would reopen the vector immediately. Every one of
 * those sites — present and future — converges on exactly one primitive:
 * `console.error` itself. Patching THAT, once, at daemon boot, is the
 * narrowest change that is still actually guaranteed to cover every emitter,
 * including one nobody has written yet.
 *
 * THE MARKER CONVENTION IS NOT NEW: `src/tools/outcome.ts`'s `boundMessage`
 * already replaces a raw newline in a `[tools2]` `msg=` value with a visible
 * ` ⏎ ` marker — belt and braces, since stripping alone can weld two words
 * together with no space between them, and a visible marker keeps the
 * message readable AND keeps it on one physical line. `flattenNewlines`
 * below reuses that exact convention rather than inventing a second one, so
 * a reader sees the same marker regardless of which layer flattened it.
 * `boundMessage`'s own flatten is NOT redundant with this one: it runs
 * first, on a `[tools2]` line's own `msg=` field specifically, before the
 * line is ever built — this sink's flatten is the backstop that also
 * covers every OTHER emitter's free text, `[tools2]`'s own already-flattened
 * output included (flattening twice is a no-op: there is nothing left to
 * flatten).
 */
export function flattenNewlines(raw: string): string {
  return raw.replace(/\r\n|\r|\n/g, " ⏎ ");
}

/**
 * Wraps `target.error` (default: the real global `console`).
 *
 * When every argument is a string, each one is run through `flattenNewlines`
 * independently and passed straight through to the original writer — this
 * is byte-for-byte the pre-BUTCHR-349 behaviour, unchanged, so any existing
 * multi-arg log line (e.g. a `%s`-style call whose specifier is consumed by
 * the original writer's own formatting) renders exactly as it did before.
 *
 * When ANY argument is not a string — an `Error`, an object logged for its
 * own `util.inspect` rendering — this now renders the WHOLE argument list to
 * text with `util.format(...args)` (the same primitive the original,
 * unwrapped `console.error` already uses internally to combine/format its
 * arguments) and flattens the single resulting string, rather than letting
 * a non-string argument reach the original writer unformatted. That closes
 * a real gap the previous version's own doc comment claimed away: an
 * `Error`'s message (or its default-rendered stack) carries raw newlines
 * with it, and only a string was ever flattened — `console.error(err)` on a
 * multi-line `Error` produced a second physical journal line that could
 * forge a record (BUTCHR-349). `util.format` is used here specifically
 * because it is what makes this equivalent to the original writer's own
 * combining behaviour for the mixed-argument case (verified: an escaped
 * `%%` only collapses when a later argument is present to substitute,
 * exactly like today's plain `console.error`; a lone `%`-bearing string
 * with no other arguments is never scanned for specifiers at all — a
 * literal percentage in a one-argument log message is unaffected).
 *
 * MUST be installed before anything else logs — every `log:`/`deps.log`
 * parameter across `src/` that defaults to `console.error` resolves that
 * default at CALL time (a plain property lookup of the `console` global from
 * inside a closure, never a value captured at import time — confirmed by
 * reading every default site named above), so as long as this runs before
 * the daemon's own event loop starts doing anything, every default and every
 * inline `(line) => console.error(...)` closure picks up the wrapped
 * version automatically, with zero changes to any of those call sites.
 * `src/daemon/index.ts` calls this as its very first executable statement,
 * before even its own config-load error path, for exactly that reason.
 *
 * STATED LIMIT — NOT FIXED HERE (BUTCHR-349): this wraps `console.error`
 * only. The runtime's own printer for an UNCAUGHT EXCEPTION or an UNHANDLED
 * REJECTION writes the crash's stack/message straight to `stderr` itself,
 * bypassing this wrap entirely — a crash whose message carries
 * uncontrolled, attacker-influenced text can still forge a physical line
 * the same way a pre-fix `console.error(err)` could. A reader parsing
 * journal lines near a process crash/restart should treat that window as
 * UNTRUSTED for outcome/alias-audit purposes — do not take a record found
 * there at face value; corroborate it against another source (e.g. the
 * issue's own Jira history) before acting on it. Deliberately not addressed
 * by this change: adding crash handlers is a different change with its own
 * risk, tracked separately rather than folded in here.
 *
 * Returns a restore function — production never calls it (the wrap lives
 * for the process's whole lifetime); it exists so a test can install onto a
 * throwaway stand-in, assert, and clean up without leaking a patched
 * function past its own test.
 */
export function installLogSink(target: Pick<Console, "error"> = console): () => void {
  const original = target.error;
  const wrapped = target as { error: Console["error"] };
  wrapped.error = ((...args: unknown[]) => {
    if (args.every((a) => typeof a === "string")) {
      original.apply(target, args.map((a) => flattenNewlines(a as string)));
    } else {
      original.apply(target, [flattenNewlines(format(...args))]);
    }
  }) as Console["error"];
  return () => {
    wrapped.error = original;
  };
}
