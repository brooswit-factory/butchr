/**
 * FACTORY-614: adapts the real `/dashboard` response shape
 * (`src/agents/dashboard.ts`, imported type-only) onto the generic
 * `Availability` the placeholder route (and Task 3's real page) renders —
 * `DashboardResponse.checked` is this poll's own COULD-NOT-CHECK signal
 * (see that type's own doc comment), never conflated with the row count
 * itself.
 */
import type { DashboardResponse } from "../../../src/agents/dashboard.js";
import { couldNotCheck, known, type Availability } from "./availability.js";

export function dashboardRowCount(response: DashboardResponse): Availability<number> {
  if (!response.checked) return couldNotCheck(`agent-list read declined at ${response.declinedAt}`);
  return known(response.rows.length);
}
