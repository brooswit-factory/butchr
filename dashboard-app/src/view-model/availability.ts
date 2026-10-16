/**
 * FACTORY-614 (task 2 of the LaunchPad switch, epic FACTORY-427): the three
 * absences carried forward from the server-rendered dashboard
 * (`src/web/dashboard-page.ts`'s own header comment) as a shared, reusable
 * shape for every future React view over this daemon's JSON endpoints —
 * Tasks 3 and 4 adapt a backend field into one of these rather than each
 * inventing their own ad hoc "is it there" check:
 *
 *   - KNOWN: the value is there.
 *   - COULD NOT CHECK: a read failed, was untrusted, or has never happened —
 *     this is a DIFFERENT claim from "not applicable" and must never render
 *     the same way.
 *   - NOT APPLICABLE: there is nothing here to know — nothing failed.
 *
 * Plain TypeScript, no React, no DOM — the same discipline
 * `dashboard-page.ts` itself follows for its own HTML rendering, now a
 * generic shape any component can switch over.
 */
export type Availability<T> =
  | { kind: "known"; value: T }
  | { kind: "could-not-check"; reason?: string }
  | { kind: "not-applicable"; reason?: string };

export function known<T>(value: T): Availability<T> {
  return { kind: "known", value };
}

export function couldNotCheck<T = never>(reason?: string): Availability<T> {
  return reason === undefined ? { kind: "could-not-check" } : { kind: "could-not-check", reason };
}

export function notApplicable<T = never>(reason?: string): Availability<T> {
  return reason === undefined ? { kind: "not-applicable" } : { kind: "not-applicable", reason };
}

export const isKnown = <T>(a: Availability<T>): a is { kind: "known"; value: T } => a.kind === "known";
export const isCouldNotCheck = <T>(a: Availability<T>): a is { kind: "could-not-check"; reason?: string } => a.kind === "could-not-check";
export const isNotApplicable = <T>(a: Availability<T>): a is { kind: "not-applicable"; reason?: string } => a.kind === "not-applicable";

/**
 * The literal wording the dashboard page already settled on
 * (`dashboard-page.ts`'s `renderTier`/`renderNotApplicable`) — reused here
 * so a future component never has to invent its own phrasing for the same
 * two absences. KNOWN has no fixed text: the caller already has the real
 * value and renders it directly.
 */
export function availabilityText<T>(a: Availability<T>, formatKnown: (value: T) => string): string {
  if (a.kind === "known") return formatKnown(a.value);
  if (a.kind === "could-not-check") return "could not check";
  return "n/a";
}

function assertNever(x: never): never {
  throw new Error(`unreachable availability kind: ${JSON.stringify(x)}`);
}

/** Exhaustive switch helper — a future fourth kind becomes a compile error here, never a silently-dropped branch. */
export function matchAvailability<T, R>(a: Availability<T>, handlers: { known: (value: T) => R; couldNotCheck: (reason?: string) => R; notApplicable: (reason?: string) => R }): R {
  if (a.kind === "known") return handlers.known(a.value);
  if (a.kind === "could-not-check") return handlers.couldNotCheck(a.reason);
  if (a.kind === "not-applicable") return handlers.notApplicable(a.reason);
  return assertNever(a);
}
