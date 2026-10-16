/**
 * FACTORY-722 introduced `withHerdrSubscribeDeadline`/`subscribeAgentStatus`
 * (src/daemon/index.ts), racing a herdr `subscribe()` against a deadline
 * timer. On timeout it correctly rejects AND, if the subscribe later
 * resolves anyway, closes that LATE-ARRIVING subscription — a herdr that
 * acks slowly leaks nothing, and nothing here changes that half.
 *
 * The leak (FACTORY-751/FACTORY-775): a herdr that ACCEPTS the connection
 * and NEVER ACKS leaves the underlying `subscribe()` promise unsettled
 * forever. Neither branch of its `.then` ever runs, so `sub.close()` is
 * never reached and the connection stays open with nobody holding a
 * reference to it. `permission-answer-watch.ts`'s retry loop
 * (`scheduleReconnect`, kept out of scope for this fix) then opens ANOTHER
 * raw subscribe every `(deadline + resubscribeDelayMs)`, each one just as
 * capable of never acking — unbounded leaked sockets over time.
 *
 * `@brooswit/herdr-sdk`'s `subscribe()` exposes no abort mechanism at all
 * (confirmed against its own source: `Subscription.open`/`Connection.open`
 * take no `AbortController`/`signal`, and nothing downstream of the raw
 * `net.Socket` is ever told to cancel) — a timed-out attempt genuinely
 * cannot cancel the raw connection it raced. The fix here is the fallback
 * the finding itself named: never start a SECOND raw subscribe while a
 * first has neither settled nor been closed. `createOutstandingGuard`
 * bounds the number of concurrently outstanding raw attempts to AT MOST
 * ONE — not zero. A herdr that never acks at all still holds that one
 * connection open forever; nothing here, and nothing the SDK exposes, can
 * reclaim it. What this guard prevents is every RETRY after the first from
 * opening yet another one behind it.
 */

export interface Closeable {
  close(): void;
}

/**
 * One guard instance tracks ONE outstanding raw attempt across however many
 * times the returned function is called — create it once per logical
 * subscription (module scope in `daemon/index.ts`), not once per call: a
 * fresh instance per call would reset `outstanding` every time and defeat
 * the whole point.
 */
export function createOutstandingGuard<Sub extends Closeable>(
  timeoutMs: number,
  makeTimeoutError: (timeoutMs: number) => Error,
): (openRaw: () => Promise<Sub>) => Promise<Sub> {
  let outstanding: Promise<Sub> | undefined;

  return function guardedSubscribe(openRaw: () => Promise<Sub>): Promise<Sub> {
    const alreadyOutstanding = outstanding;

    if (!alreadyOutstanding) {
      const raw = openRaw();
      outstanding = raw;
      // Frees the slot once the raw attempt settles, however it settles,
      // so the NEXT call (whether it's the first to notice, or a later
      // one still waiting out its own deadline) may open a fresh raw
      // attempt. `.catch` on the `.finally`-derived promise only — never
      // swallows the original `raw` rejection, which the owner's own
      // `.then` below still observes.
      void raw
        .finally(() => {
          if (outstanding === raw) outstanding = undefined;
        })
        .catch(() => {});
      return raceDeadline(raw, timeoutMs, makeTimeoutError);
    }

    // A raw attempt is already outstanding, opened by an earlier call to
    // this same guard. Do NOT race it a second time here: if this call
    // attached its own `.then` to that SAME promise, a stale attempt's
    // timeout firing before the raw promise settles would call
    // `sub.close()` the instant it resolves — including on a still-live
    // attempt that hasn't hit ITS OWN deadline yet and was about to hand
    // the subscription back to its caller. Racing the shared promise from
    // more than one place at once is exactly the bug that would reintroduce.
    // Instead, just wait out this call's own deadline window and reject —
    // the original attempt's own `raceDeadline` call decides, exactly as
    // before FACTORY-751/FACTORY-775, whether a late ack gets closed or used.
    return new Promise((_resolve, reject) => {
      const t = setTimeout(() => reject(makeTimeoutError(timeoutMs)), timeoutMs);
      t.unref?.();
    });
  };
}

function raceDeadline<Sub extends Closeable>(raw: Promise<Sub>, timeoutMs: number, makeTimeoutError: (timeoutMs: number) => Error): Promise<Sub> {
  return new Promise((resolve, reject) => {
    let timedOut = false;
    const t = setTimeout(() => {
      timedOut = true;
      reject(makeTimeoutError(timeoutMs));
    }, timeoutMs);
    t.unref?.();
    raw.then(
      (sub) => {
        clearTimeout(t);
        // A late ack after this call already rejected on the deadline above
        // must not leak an open connection nobody holds a reference to —
        // close it immediately rather than returning it to a caller that
        // has already moved on (scheduleReconnect, permission-answer-watch.ts).
        if (timedOut) { sub.close(); return; }
        resolve(sub);
      },
      (e) => { clearTimeout(t); if (!timedOut) reject(e); },
    );
  });
}
