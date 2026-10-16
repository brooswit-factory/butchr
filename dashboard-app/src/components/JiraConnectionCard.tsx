/**
 * FACTORY-664 — the "Jira connection" card: site, email, token-file status
 * (warning when the file's mode is wider than 0600), and a Test connection
 * button that shows the server's own fixed result strings verbatim —
 * never the raw upstream body/token, which the server never even sends
 * down. Every field is plain JSX text content (no `dangerouslySetInnerHTML`
 * anywhere in this file).
 *
 * FACTORY-665 (PR-2): an OPTIONAL `setupApi` prop adds a token-ROTATION
 * control below the existing Test button — `PUT /api/settings/jira/token`,
 * never `/api/setup/jira` (that route is setup-mode only; this card is
 * rendered only once configured). Site/email are NEVER resubmitted here
 * (the ticket's own "shell-only after setup" rule) — only a new token and
 * the one-time setup code the server requires on every secret write.
 * Same password-field discipline as the Setup page: `type="password"`,
 * `autoComplete="off"`, cleared on submit, never in localStorage.
 */
import { useState } from "react";
import { Button, Text } from "@launchpad-ui/components";
import type { SettingsApi, JiraTestResult } from "../api/settings.js";
import { RateLimitError } from "../api/settings.js";
import type { SetupApi } from "../api/setup.js";
import { RateLimitError as SetupRateLimitError, ProvidedByEnvironmentError } from "../api/setup.js";
import type { TokenFileView } from "../view-model/settings-view.js";
import "./SettingsView.css";

export interface JiraConnectionCardProps {
  api: SettingsApi;
  site: string | null;
  email: string | null;
  tokenFile: TokenFileView;
  /** Omitted: no rotation control is rendered at all (today's behavior, unchanged). */
  setupApi?: SetupApi;
}

type TestState = { kind: "idle" } | { kind: "pending" } | { kind: "done"; result: JiraTestResult } | { kind: "error"; message: string };

type RotateState =
  | { kind: "idle" }
  | { kind: "entering" }
  | { kind: "pending" }
  | { kind: "done"; accountId: string; displayName: string }
  | { kind: "error"; message: string };

function JiraTokenRotationControl({ setupApi }: { setupApi: SetupApi }) {
  const [token, setToken] = useState("");
  const [setupCode, setSetupCode] = useState("");
  const [state, setState] = useState<RotateState>({ kind: "idle" });

  async function confirmRotate() {
    setState({ kind: "pending" });
    try {
      const result = await setupApi.rotateToken({ token, setupCode });
      setState({ kind: "done", accountId: result.accountId, displayName: result.displayName });
    } catch (e) {
      const message = e instanceof SetupRateLimitError
        ? (e.retryAfterSeconds !== undefined ? `${e.message} (retry in ${e.retryAfterSeconds}s)` : e.message)
        : e instanceof ProvidedByEnvironmentError ? "the token is provided by the environment — unset ATLASSIAN_TOKEN/ATLASSIAN_TOKEN_FILE to rotate it from here"
        : e instanceof Error ? e.message : String(e);
      setState({ kind: "error", message });
    } finally {
      setToken("");
      setSetupCode("");
    }
  }

  const pending = state.kind === "pending";

  return (
    <div className="settings-jira-card__rotate" data-testid="jira-rotate-control">
      {state.kind === "idle" || state.kind === "done" ? (
        <Button onPress={() => setState({ kind: "entering" })} data-testid="jira-rotate-start-button">
          Rotate token
        </Button>
      ) : null}
      {state.kind === "done" && (
        <Text elementType="div" size="small" data-testid="jira-rotate-result">
          rotated — now {state.displayName} ({state.accountId}). Restart needed.
        </Text>
      )}
      {(state.kind === "entering" || state.kind === "pending") && (
        <div className="settings-jira-card__rotate-form">
          <label htmlFor="rotate-token">New API token</label>
          <input id="rotate-token" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} disabled={pending} data-testid="jira-rotate-token-input" />
          <label htmlFor="rotate-setup-code">Setup code</label>
          <input id="rotate-setup-code" type="text" autoComplete="off" value={setupCode} onChange={(e) => setSetupCode(e.target.value)} disabled={pending} data-testid="jira-rotate-code-input" />
          <div>
            <Button onPress={() => setState({ kind: "idle" })} isDisabled={pending} data-testid="jira-rotate-cancel-button">
              Cancel
            </Button>
            <Button onPress={() => void confirmRotate()} isDisabled={pending} data-testid="jira-rotate-confirm-button">
              {pending ? "Rotating…" : "Confirm rotation"}
            </Button>
          </div>
        </div>
      )}
      {state.kind === "error" && (
        <Text elementType="div" size="small" data-testid="jira-rotate-result" className="settings-jira-card__warning">
          {state.message}
        </Text>
      )}
    </div>
  );
}

export function JiraConnectionCard({ api, site, email, tokenFile, setupApi }: JiraConnectionCardProps) {
  const [state, setState] = useState<TestState>({ kind: "idle" });

  async function runTest() {
    setState({ kind: "pending" });
    try {
      const result = await api.testJiraConnection();
      setState({ kind: "done", result });
    } catch (e) {
      if (e instanceof RateLimitError) {
        setState({ kind: "error", message: e.retryAfterSeconds !== undefined ? `${e.message} (retry in ${e.retryAfterSeconds}s)` : e.message });
      } else {
        setState({ kind: "error", message: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  return (
    <section className="settings-jira-card" aria-labelledby="jira-connection-heading" data-testid="jira-connection-card">
      <Text elementType="h3" id="jira-connection-heading" bold>
        Jira connection
      </Text>
      <Text elementType="div" size="small">
        site: {site ?? "(not configured)"}
      </Text>
      <Text elementType="div" size="small">
        email: {email ?? "(not configured)"}
      </Text>
      <Text elementType="div" size="small" data-testid="jira-token-file-status" className={tokenFile.warning ? "settings-jira-card__warning" : undefined}>
        token file: {tokenFile.path ?? "(not configured)"} — {tokenFile.statusText}
      </Text>
      <Button onPress={() => void runTest()} isDisabled={state.kind === "pending"} data-testid="jira-test-connection-button">
        Test connection
      </Button>
      {state.kind === "pending" && (
        <Text elementType="div" size="small" data-testid="jira-test-result">
          testing…
        </Text>
      )}
      {state.kind === "done" && (
        <Text elementType="div" size="small" data-testid="jira-test-result">
          {state.result.ok ? `connected (${state.result.httpStatusClass})` : `${state.result.httpStatusClass}: ${state.result.error ?? "failed"}`}
        </Text>
      )}
      {state.kind === "error" && (
        <Text elementType="div" size="small" data-testid="jira-test-result">
          {state.message}
        </Text>
      )}
      {setupApi && <JiraTokenRotationControl setupApi={setupApi} />}
    </section>
  );
}
