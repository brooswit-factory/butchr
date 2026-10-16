/**
 * FACTORY-614 (task 2 of the LaunchPad switch): a placeholder ONLY — see
 * `DashboardRoute.tsx`'s own header for why. The real Configurations view
 * (Task 4) replaces this.
 */
import { Heading, Text } from "@launchpad-ui/components";
import { useConfigInventory } from "../hooks/use-config-inventory.js";
import { configInventoryEntryCount } from "../view-model/config-inventory-availability.js";
import { availabilityText } from "../view-model/availability.js";
import { PollStatusView } from "../components/PollStatusView.js";

export function ConfigurationsRoute() {
  const state = useConfigInventory();
  return (
    <section aria-labelledby="configurations-heading">
      <Heading id="configurations-heading" size="small">
        Configurations
      </Heading>
      <Text elementType="p" size="small">
        Placeholder — proves the `/config-inventory` data layer. The real configurations view lands in Task 4.
      </Text>
      <PollStatusView state={state} label="/config-inventory">
        {(data) => (
          <Text elementType="p" data-testid="config-entry-count">
            {availabilityText(configInventoryEntryCount(data), (n) => `${n} entr${n === 1 ? "y" : "ies"}`)}
          </Text>
        )}
      </PollStatusView>
    </section>
  );
}
