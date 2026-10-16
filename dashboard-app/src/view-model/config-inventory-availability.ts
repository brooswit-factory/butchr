/**
 * FACTORY-614: adapts the real `/config-inventory` response shape
 * (`src/agents/query-agent-inventory.ts`, imported type-only) onto the
 * generic `Availability` the placeholder route renders. Unlike `/dashboard`,
 * this response carries no whole-response COULD-NOT-CHECK envelope of its
 * own — once the fetch itself succeeds the count is always KNOWN; a failed
 * fetch is the polling hook's own concern (`view-model/poll-state.ts`), not
 * this adapter's.
 */
import type { QueryAgentInventory } from "../../../src/agents/query-agent-inventory.js";
import { known, type Availability } from "./availability.js";

export function configInventoryEntryCount(inventory: QueryAgentInventory): Availability<number> {
  return known(inventory.rules.length + inventory.sessionDefinitions.length);
}
