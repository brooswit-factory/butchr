/** Explicit accounting for the advertised provider and subscription surface.
 * Tests derive the real registries and compare both directions to shipped briefs.
 * Teaching a verb does not claim adoption or validate every argument example. */
export type BriefCoverageEntry =
  | { readonly taught: true }
  | { readonly taught: false; readonly reason: string };

export const BRIEF_COVERAGE: Readonly<Record<string, BriefCoverageEntry>> = {
  jira_get_issue: { taught: true },
  jira_get_comments: { taught: true },
  jira_search: { taught: true },
  jira_add_comment: { taught: true },
  jira_transition: { taught: true },
  jira_set_priority: { taught: true },
  jira_assign: { taught: true },
  jira_update_issue: { taught: true },
  jira_link_issues: { taught: true },
  jira_create_issue: { taught: true },
  jira_add_labels: { taught: true },
  jira_remove_labels: { taught: true },
  confluence_create_page: { taught: true },
  confluence_update_page: { taught: true },
  confluence_search_pages: { taught: true },
  confluence_get_page: { taught: true },
  confluence_list_spaces: { taught: true },
  confluence_get_comments: { taught: true },
  confluence_add_comment: { taught: true },
  confluence_read_document: { taught: true },
  jira_get_project_property: { taught: true },
  jira_get_remote_link: { taught: true },
};
