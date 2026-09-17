/**
 * Built-in example rules for the default Jira issue types. Used in memory
 * only when the user has no rules file (see `loadRules`); they are examples
 * to copy and edit, not privileged behaviour — they validate through the same
 * `parseRules` as any user file and carry no fields a user rule cannot.
 *
 * Every rule is scoped to work assigned to the running user and labelled
 * `chop`, so one machine's defaults never pick up another operator's work.
 * Kept as plain JSON-shaped data so it can be written out verbatim later.
 */
const active = `assignee = currentUser() AND labels = chop AND statusCategory = "In Progress"`;

export const DEFAULT_RULES_DOCUMENT = {
  rules: [
    {
      id: "epic", resourceProvider: "jira-work", query: `issuetype = Epic AND ${active}`,
      brief: "Decompose this epic into stories that each deliver a reviewable slice. Review and merge the stories' work when they finish.",
      relationships: { childRule: "story" },
    },
    {
      id: "story", resourceProvider: "jira-work", query: `issuetype = Story AND ${active}`,
      brief: "Decompose this story into tasks. Review each task's pull request against this story's intent before it merges.",
      relationships: { childRule: "task" },
    },
    {
      id: "task", resourceProvider: "jira-work", query: `issuetype = Task AND ${active}`,
      brief: "Do this task and open a pull request. If it is too big, split it into subtasks and review their work.",
      relationships: { childRule: "subtask" },
    },
    {
      id: "subtask", resourceProvider: "jira-work", query: `issuetype in subTaskIssueTypes() AND ${active}`,
      brief: "Do this small, well-scoped subtask and open a pull request for the parent task to review.",
    },
    {
      id: "bug", resourceProvider: "jira-work", query: `issuetype = Bug AND ${active}`,
      brief: "Investigate this bug: reproduce it, form working theories, and create stories to fix it. Close the bug once it is gone.",
      relationships: { childRule: "story" },
    },
  ],
} as const;
