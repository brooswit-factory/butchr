import { AtlassianHttpError } from "../atlassian/client.js";
import type { LabelWriter } from "./sync.js";

export interface NotifyGateJira {
  canSuppressNotifications(projectKey: string): Promise<boolean>;
  updateLabels(key: string, ops: { add?: readonly string[]; remove?: readonly string[] }, opts?: { notify?: boolean }): Promise<void>;
}

export interface NotifyGateDeps {
  jira: NotifyGateJira;
  /** The account label writes are performed as, named in the remedy line. */
  account: string;
  log: (line: string) => void;
}

const projectOf = (key: string): string => key.slice(0, key.indexOf("-"));

const remedy = (account: string, project: string): string =>
  `grant ${account} the Administrator project role on ${project}, or accept notifying label writes`;

/**
 * Wraps a label writer so a write never silently 403s. Jira Cloud only
 * honours `notifyUsers=false` for an account holding Administer
 * Jira/Projects on the ticket's project — anyone else gets 403 on the WHOLE
 * request. This preflights that permission once per project (the daemon has
 * no configured project, so the key comes from the issue key's prefix, first
 * sight per run) and caches the verdict; writes go quiet only when permitted.
 *
 * If a quiet write still 403s at runtime (permission revoked mid-run, or the
 * preflight was wrong), the project is flipped to notifying writes for the
 * rest of the run and the write is retried on the spot, so labels still
 * land. Every log line here is a one-time verdict or one-time flip per
 * project — never a per-poll repeat.
 */
export function createNotifyGate(deps: NotifyGateDeps): LabelWriter {
  const quiet = new Map<string, boolean>();
  const preflight = new Map<string, Promise<boolean>>();
  const loggedFlips = new Set<string>();

  const verdictFor = async (project: string): Promise<boolean> => {
    const cached = quiet.get(project);
    if (cached !== undefined) return cached;
    let inFlight = preflight.get(project);
    if (!inFlight) {
      inFlight = deps.jira.canSuppressNotifications(project);
      preflight.set(project, inFlight);
    }
    const ok = await inFlight;
    if (!quiet.has(project)) {
      quiet.set(project, ok);
      deps.log(
        ok
          ? `[labels] ${project}: quiet label writes enabled (ADMINISTER_PROJECTS)`
          : `[labels] ${project}: account ${deps.account} lacks ADMINISTER_PROJECTS — label writes will NOTIFY watchers. Remedy: ${remedy(deps.account, project)}.`,
      );
    }
    return quiet.get(project)!;
  };

  return {
    async updateLabels(key, ops) {
      const project = projectOf(key);
      const wantQuiet = await verdictFor(project);
      try {
        await deps.jira.updateLabels(key, ops, { notify: !wantQuiet });
      } catch (e) {
        if (!wantQuiet || !(e instanceof AtlassianHttpError) || e.status !== 403) throw e;
        quiet.set(project, false);
        if (!loggedFlips.has(project)) {
          loggedFlips.add(project);
          deps.log(`[labels] ${key} quiet write 403'd — flipping ${project} to notifying label writes for the rest of this run. Remedy: ${remedy(deps.account, project)}.`);
        }
        await deps.jira.updateLabels(key, ops, { notify: true });
      }
    },
  };
}
