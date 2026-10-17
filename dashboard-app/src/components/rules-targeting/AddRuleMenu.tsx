/**
 * local/ui — "Add rule": a button that opens a menu of resource providers;
 * the page appends a new rule card, already open for editing. butchr's
 * rules all apply independently (there is no evaluation order to insert
 * into), so a new rule simply joins the end of the list.
 */
import { Button, Header, Menu, MenuItem, MenuSection, MenuTrigger, Popover, Text } from "@launchpad-ui/components";
import { Icon } from "@launchpad-ui/icons";
import type { ResourceProvider } from "../../../../src/rules/agent-key.js";
import { ADDABLE_PROVIDERS, providerInfo } from "../../view-model/rule-providers.js";

export interface AddRuleMenuProps {
  disabled: boolean;
  onAdd: (provider: ResourceProvider) => void;
  label?: string;
}

export function AddRuleMenu({ disabled, onAdd, label = "Add rule" }: AddRuleMenuProps) {
  return (
    <MenuTrigger>
      <Button variant="primary" size="small" isDisabled={disabled} data-testid="add-rule">
        <Icon name="add" size="small" />
        {label}
      </Button>
      <Popover placement="bottom end">
        <Menu aria-label="Add a rule for" onAction={(key) => onAdd(String(key) as ResourceProvider)}>
          <MenuSection>
            <Header>Build a rule for</Header>
            {ADDABLE_PROVIDERS.map((provider) => {
              const info = providerInfo(provider);
              return (
                <MenuItem key={provider} id={provider} textValue={info.label}>
                  <Text slot="label">
                    <Icon name={info.icon} size="small" /> {info.label}
                  </Text>
                  <Text slot="description">{info.description}</Text>
                </MenuItem>
              );
            })}
          </MenuSection>
        </Menu>
      </Popover>
    </MenuTrigger>
  );
}
