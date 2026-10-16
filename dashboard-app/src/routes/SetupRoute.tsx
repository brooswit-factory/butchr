/**
 * FACTORY-665 (PR-2) — the Setup page: shown (by `App.tsx`'s own gate, see
 * `useSetupGate`) only while `GET /api/setup/status` reports
 * `configured: false`. Site/email/token/setup-code fields, a submit
 * action that calls `POST /api/setup/jira` (which tests the candidate
 * token against Jira and writes it only on success — see
 * `../api/setup.ts`), and the server's own fixed result strings verbatim.
 *
 * Password field discipline (the ticket's own words): `type="password"`,
 * `autoComplete="off"`, cleared from component state on submit (success
 * OR failure — never left sitting in memory longer than it has to be),
 * and never written to `localStorage`/`sessionStorage` anywhere in this
 * component (there is no persistence call here at all).
 */
import { useEffect, useState } from "react";
import { Button, Text } from "@launchpad-ui/components";
import type { SetupApi } from "../api/setup.js";
import { RateLimitError } from "../api/setup.js";
import "./SetupRoute.css";

export interface SetupRouteProps {
  api: SetupApi;
  /** Called once setup succeeds, so `App.tsx`'s gate can re-check `/api/setup/status` (still `false` until a restart — see the success message itself for why). */
  onSetupSucceeded?: () => void;
}

type SetupState =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "done"; accountId: string; displayName: string; identityPersisted: boolean; identityError?: string; restarting: boolean }
  | { kind: "error"; message: string };

export function SetupRoute({ api, onSetupSucceeded }: SetupRouteProps) {
  const [site, setSite] = useState("");
  const [email, setEmail] = useState("");
  const [token, setToken] = useState("");
  const [setupCode, setSetupCode] = useState("");
  const [state, setState] = useState<SetupState>({ kind: "idle" });

  async function submit() {
    setState({ kind: "pending" });
    try {
      const result = await api.submitSetup({ site, email, token, setupCode });
      setState({ kind: "done", accountId: result.accountId, displayName: result.displayName, identityPersisted: result.identityPersisted, restarting: result.restarting === true, ...(result.identityError !== undefined ? { identityError: result.identityError } : {}) });
      onSetupSucceeded?.();
    } catch (e) {
      const message = e instanceof RateLimitError
        ? (e.retryAfterSeconds !== undefined ? `${e.message} (retry in ${e.retryAfterSeconds}s)` : e.message)
        : e instanceof Error ? e.message : String(e);
      setState({ kind: "error", message });
    } finally {
      // Cleared on submit, success or failure — never left in memory
      // (and never persisted anywhere) longer than the one request needs.
      setToken("");
      setSetupCode("");
    }
  }

  const pending = state.kind === "pending";

  // After a setup that restarts the daemon, poll until the normal-mode daemon answers `configured: true`, then load the dashboard.
  const restarting = state.kind === "done" && state.restarting;
  useEffect(() => {
    if (!restarting) return;
    const timer = setInterval(() => {
      api.getStatus().then((s) => { if (s.configured) window.location.assign("/"); }).catch(() => { /* daemon is down mid-restart: keep polling */ });
    }, 2000);
    return () => clearInterval(timer);
  }, [restarting, api]);

  return (
    <section aria-labelledby="setup-heading" data-testid="setup-page" className="setup-page">
      <Text elementType="h2" id="setup-heading" bold>
        Set up butchr
      </Text>
      <Text elementType="p" size="small">
        This daemon has no Atlassian (Jira) identity configured yet. Enter your Jira site, email, API
        token, and the one-time setup code printed in this daemon&apos;s own log, then restart butchr to
        finish.
      </Text>

      <div className="setup-page__field">
        <label htmlFor="setup-site">Jira site</label>
        <input id="setup-site" type="text" autoComplete="off" placeholder="https://your-team.atlassian.net" value={site} onChange={(e) => setSite(e.target.value)} disabled={pending} data-testid="setup-site-input" />
      </div>
      <div className="setup-page__field">
        <label htmlFor="setup-email">Email</label>
        <input id="setup-email" type="text" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} disabled={pending} data-testid="setup-email-input" />
      </div>
      <div className="setup-page__field">
        <label htmlFor="setup-token">API token</label>
        <input id="setup-token" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} disabled={pending} data-testid="setup-token-input" />
      </div>
      <div className="setup-page__field">
        <label htmlFor="setup-code">Setup code</label>
        <input id="setup-code" type="text" autoComplete="off" value={setupCode} onChange={(e) => setSetupCode(e.target.value)} disabled={pending} data-testid="setup-code-input" />
      </div>

      <Button onPress={() => void submit()} isDisabled={pending} data-testid="setup-submit-button">
        {pending ? "Testing & saving…" : "Configure"}
      </Button>

      {state.kind === "done" && (
        <div data-testid="setup-result" className="setup-page__result setup-page__result--ok">
          <Text elementType="p" size="small">
            Configured as {state.displayName} ({state.accountId}). {state.restarting ? "butchr is restarting into normal mode — this page reloads when it is back. If it does not, start butchr again (a process started by hand is not restarted)." : "Restart needed to leave setup mode."}
          </Text>
          {!state.identityPersisted && (
            <Text elementType="p" size="small" className="setup-page__warning">
              Warning: the site/email could not be saved durably ({state.identityError}) — a restart right
              now would revert to setup mode. Fix the underlying issue, then try again before restarting.
            </Text>
          )}
        </div>
      )}
      {state.kind === "error" && (
        <Text elementType="p" size="small" data-testid="setup-result" className="setup-page__warning">
          {state.message}
        </Text>
      )}
    </section>
  );
}
