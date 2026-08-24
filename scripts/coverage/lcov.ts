/** Aggregate lines + functions from an lcov report. Pure. */
export interface Totals { lines: { hit: number; found: number }; functions: { hit: number; found: number } }
export function totalsOf(lcov: string): Totals {
  const t: Totals = { lines: { hit: 0, found: 0 }, functions: { hit: 0, found: 0 } };
  for (const line of lcov.split("\n")) {
    const [k, v] = line.split(":") as [string, string];
    if (k === "LF") t.lines.found += +v; else if (k === "LH") t.lines.hit += +v;
    else if (k === "FNF") t.functions.found += +v; else if (k === "FNH") t.functions.hit += +v;
  }
  return t;
}
export const pct = (x: { hit: number; found: number }) => (x.found ? (100 * x.hit) / x.found : 100);
