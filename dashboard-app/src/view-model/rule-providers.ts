/**
 * local/ui — display metadata for each resource provider on the
 * Rules page: the label and icon in the "Add rule" menu,
 * and the query language a rule's query is written in.
 * The provider list itself still comes from `RESOURCE_PROVIDERS`
 * (`api/rules.ts`), so a provider added upstream shows up with a generic
 * label instead of disappearing.
 */
import type { IconProps } from "@launchpad-ui/icons";
import type { ResourceProvider } from "../../../src/rules/agent-key.js";
import { RESOURCE_PROVIDERS } from "../api/rules.js";

export interface ProviderInfo {
  label: string;
  description: string;
  icon: NonNullable<IconProps["name"]>;
  /** What the query box is written in, e.g. "JQL". */
  queryLanguage: string;
  queryPlaceholder: string;
}

const KNOWN: Partial<Record<ResourceProvider, ProviderInfo>> = {
  "jira-work": {
    label: "Jira tickets",
    description: "Staff agents on the Jira issues a JQL query matches",
    icon: "checklist",
    queryLanguage: "JQL",
    queryPlaceholder: 'project = XYZ AND status = "To Do"',
  },
  "jira-idea": {
    label: "Jira Product Discovery ideas",
    description: "Staff agents on ideas a JQL query matches",
    icon: "lightbulb",
    queryLanguage: "JQL",
    queryPlaceholder: "project = IDEAS",
  },
  "jira-project": {
    label: "Jira project manager",
    description: "Run a manager agent for each matching project (never counts toward capacity)",
    icon: "folders",
    queryLanguage: "JSON",
    queryPlaceholder: '{"keys": ["XYZ"]}',
  },
  "github-issue": {
    label: "GitHub issues",
    description: "Staff agents on GitHub issues a search matches",
    icon: "bug",
    queryLanguage: "GitHub search",
    queryPlaceholder: "is:open label:butchr",
  },
  "github-pr": {
    label: "GitHub pull requests",
    description: "Staff agents on pull requests a search matches",
    icon: "arrow-merge",
    queryLanguage: "GitHub search",
    queryPlaceholder: "is:open review-requested:@me",
  },
  "zendesk-ticket": {
    label: "Zendesk tickets",
    description: "Staff agents on Zendesk tickets a search matches",
    icon: "chat-bubble",
    queryLanguage: "Zendesk search",
    queryPlaceholder: "status<solved tags:vip",
  },
  "confluence-page": {
    label: "Confluence pages",
    description: "Staff agents on the pages under a Confluence page",
    icon: "book",
    queryLanguage: "JSON",
    queryPlaceholder: '{"ancestor": "123456"}',
  },
  "jira-component": {
    label: "Jira components",
    description: "One agent per Jira component. butchr can't run these yet",
    icon: "data",
    queryLanguage: "Query",
    queryPlaceholder: "",
  },
  "trello-card": {
    label: "Trello cards",
    description: "Staff agents on the cards a search of your Trello board matches",
    icon: "layout-structured",
    queryLanguage: "Trello search",
    queryPlaceholder: 'list:"Ready for agent" label:bug',
  },
  filesystem: {
    label: "Files on disk",
    description: "Staff agents on local files a query matches",
    icon: "file",
    queryLanguage: "JSON",
    queryPlaceholder: '{"root": "/path/to/dir", "kind": "file"}',
  },
};

export function providerInfo(provider: ResourceProvider): ProviderInfo {
  return (
    KNOWN[provider] ?? {
      label: provider,
      description: `Staff agents on ${provider} resources`,
      icon: "data",
      queryLanguage: "Query",
      queryPlaceholder: "",
    }
  );
}

export const ADDABLE_PROVIDERS: readonly ResourceProvider[] = RESOURCE_PROVIDERS;

/** Matches `src/web/rules-preview.ts`'s `JIRA_BACKED_PROVIDERS`: only these can preview a saved rule's tickets. */
export function canPreview(provider: ResourceProvider): boolean {
  return provider === "jira-work" || provider === "jira-idea";
}

/** Only the jira-work and jira-project loops run linked-change eventing (`runTick`, `src/rules/resource-type.ts` and `src/rules/jira-project-type.ts`); other providers accept the fields but ignore them. */
export function supportsLinkedEvents(provider: ResourceProvider): boolean {
  return provider === "jira-work" || provider === "jira-project";
}
