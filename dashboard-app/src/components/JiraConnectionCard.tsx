/**
 * FACTORY-664 — the "Jira connection" card: site, email, token-file status
 * (warning when the file's mode is wider than 0600), and a Test connection
 * button that shows the server's own fixed result strings verbatim —
 * never the raw upstream body/token, which the server never even sends
 * down. Every field is plain JSX text content (no `dangerouslySetInnerHTML`
 * anywhere in this file).
 */
import { useState } from "react";
import { Button, Text } from "@launchpad-ui/components";
import type { SettingsApi, JiraTestResult } from "../api/settings.js";
import { RateLimitError } from "../api/settings.js";
import type { TokenFileView } from "../view-model/settings-view.js";
import "./SettingsView.css";

export interface JiraConnectionCardProps {
  api: SettingsApi;
  site: string | null;
  email: string | null;
  tokenFile: TokenFileView;
}

type TestState = { kind: "idle" } | { kind: "pending" } | { kind: "done"; result: JiraTestResult } | { kind: "error"; message: string };

export function JiraConnectionCard({ api, site, email, tokenFile }: JiraConnectionCardProps) {
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
    </section>
  );
}
