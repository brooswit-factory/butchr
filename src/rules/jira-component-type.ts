/**
 * FACTORY-990 (implementing story FACTORY-986, epic FACTORY-984): the
 * `jira-component` provider's ONLY rule-side identity plumbing —
 * `ownsJiraComponentAgent` (the owns-predicate every other provider keeps
 * in its own `*-type.ts`, e.g. `ownsJiraProjectAgent`, jira-project-type.ts)
 * and `jiraComponentShortDisplayId` (the herdr-label short id every
 * provider keeps, per `display-label.ts`'s own "one method per provider,
 * not a central switch" rule).
 *
 * DELIBERATELY NOTHING ELSE: no `ResourceType<T>` implementation, no
 * discovery/search, no selector/validation, no spawn config, no
 * `runResourceLoop` wiring in `src/daemon/index.ts`. Those are a LATER
 * story's job (selector/validation, members-via-JQL: FACTORY-986's own
 * explicit out-of-scope list). This file exists purely so a `jira-component`
 * agent key is a first-class citizen of the SAME generic plumbing every
 * other provider already is (`decodeAnyAgentKey`, the herdr display label,
 * the `test/unit/rules.test.ts` cross-provider loops) — nothing here can
 * cause an agent to spawn: no file in `src/daemon/` ever filters a rule by
 * `resourceProvider === "jira-component"` (see
 * `test/unit/jira-component-type.test.ts`'s own "no agent spawns" test,
 * which greps the daemon source to prove exactly that, the same way this
 * story's DoD requires).
 */
import { decodeAnyAgentKey } from "./agent-key.js";

/** True for exactly the agent-key ids this provider owns — same convention as every other provider's own owns*Agent predicate (e.g. `ownsJiraProjectAgent`, jira-project-type.ts). */
export const ownsJiraComponentAgent = (id: string): boolean => decodeAnyAgentKey(id)?.resourceProvider === "jira-component";

/**
 * The herdr-workspace-label short id for a `jira-component` resourceId — the
 * provider's own native id IS already the short form (same as
 * `jiraProjectShortDisplayId`'s identity function): `<PROJECT>:<id>` is
 * short enough to display as-is, with no further abbreviation.
 */
export const jiraComponentShortDisplayId = (resourceId: string): string => resourceId;
