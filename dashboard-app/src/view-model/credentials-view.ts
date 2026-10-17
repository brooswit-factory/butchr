/**
 * local/ui — plain-text presentation for the Settings page's credential
 * cards. No React; every string a card shows about a token or a test lives
 * here so it can be unit tested.
 */
import type { CredentialsSummary, GithubTestResult, JiraTestResult, LayeredValue, ProviderTestResult, TokenStatus } from "../api/settings.js";

export function modeText(mode: number): string {
  return mode.toString(8).padStart(3, "0");
}

/** Where this token is, or where setting one will put it. */
export function tokenLocationText(token: TokenStatus): string {
  switch (token.source) {
    case "env-literal":
      return "Set directly in butchr's environment.";
    case "env-file":
      return `Stored in ${token.path} (named by ${token.fileEnvKey}).`;
    case "secrets-file":
      return `Stored in ${token.path}.`;
    case "unset":
      return `Not set. Saving one writes ${token.path}.`;
  }
}

/** Something wrong with the token file, or `null`. */
export function tokenWarning(token: TokenStatus): string | null {
  if (token.source === "unset" || token.source === "env-literal") return null;
  if (!token.exists) return "That file doesn't exist. Saving a token creates it.";
  if (!token.readable) return "butchr can't read that file.";
  if (token.tooOpen && token.mode !== null) return `Its mode is ${modeText(token.mode)}, wider than 0600. Saving a new token replaces it with an owner-only file.`;
  return null;
}

export function tokenIsSet(token: TokenStatus): boolean {
  return token.source === "env-literal" || token.exists;
}

export function jiraTestText(result: JiraTestResult): string {
  return result.ok ? "Connected." : (result.error ?? `Failed (${result.httpStatusClass}).`);
}

export function githubTestText(result: GithubTestResult): string {
  if (!result.login) return result.error ?? `Failed (${result.httpStatusClass}).`;
  const signedIn = `Signed in as ${result.login}.`;
  if (result.orgs.length === 0) return `${signedIn} No organizations are set, so the GitHub integration stays off.`;
  const seen = result.orgs.filter((o) => o.ok).map((o) => o.org);
  const unseen = result.orgs.filter((o) => !o.ok).map((o) => o.org);
  return [signedIn, seen.length ? `Can see ${seen.join(", ")}.` : "", unseen.length ? `Can't see ${unseen.join(", ")}.` : ""].filter(Boolean).join(" ");
}

/** The Zendesk and Trello cards' test results. */
export function providerTestText(result: ProviderTestResult): string {
  if (!result.ok || !result.account) return result.error ?? "Failed.";
  return result.board ? `Signed in as ${result.account}. Can see the board "${result.board}".` : `Signed in as ${result.account}.`;
}

/** The saved org list differs from what the running butchr started with. (A butchr too old to say what it runs counts as up to date.) */
export function orgsPending(github: CredentialsSummary["github"]): boolean {
  return Array.isArray(github.runningOrgs) && github.orgs.join(",") !== github.runningOrgs.join(",");
}

/** A saved card setting differs from what the running butchr started with. */
export function layeredPending(value: LayeredValue): boolean {
  return value.running !== undefined && value.value !== value.running;
}

/** Saved settings the running butchr isn't using yet, named the way the cards name a change, for the restart banner. */
export function pendingRestartChanges(c: CredentialsSummary): string[] {
  return [
    orgsPending(c.github) ? "the GitHub organizations" : null,
    layeredPending(c.zendesk.subdomain) ? "the Zendesk subdomain" : null,
    layeredPending(c.trello.boardId) ? "the Trello board" : null,
  ].filter((p): p is string => p !== null);
}

/** What a card says under a saved setting that waits for a restart. */
export function stillUsingText(running: string | null): string {
  return running ? `butchr is still using ${running} until it restarts.` : "butchr starts using this when it restarts.";
}

/** The GitHub card's org list, checked the way butchr's settings check (`src/settings/settings-file.ts`, `githubOrgs`) does. */
const GITHUB_ORG_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
export const GITHUB_ORGS_MAX = 20;

/** What the org list saves: each row trimmed, blank rows dropped. */
export function orgsToSave(rows: readonly string[]): string[] {
  return rows.map((r) => r.trim()).filter(Boolean);
}

/** One entry per row: what's wrong with it, or `null`. A blank row is fine (it's dropped on save); a repeat is flagged on the later row. */
export function orgRowProblems(rows: readonly string[]): (string | null)[] {
  const seen = new Set<string>();
  return rows.map((raw) => {
    const name = raw.trim();
    if (name === "") return null;
    if (!GITHUB_ORG_RE.test(name)) return "Use letters, digits and hyphens, up to 39 characters, starting with a letter or digit.";
    if (seen.has(name.toLowerCase())) return "Already in the list.";
    seen.add(name.toLowerCase());
    return null;
  });
}
