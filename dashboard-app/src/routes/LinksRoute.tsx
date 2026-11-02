/**
 * FACTORY-962 (epic FACTORY-659, slice D1 follow-up) — links: read
 * (`GET /api/links`, `useLinks`) plus add/remove through the write path
 * this ticket ships (`../../../src/resources/links-write.ts`). A resource
 * reference is a plain canonical `<provider>:<id>` string (same form
 * `butchr link` takes on the CLI) — this page is a thin form over the same
 * contract, not a resource picker.
 *
 * Deliberately plain, same discipline `SessionDefinitionsRoute`'s own
 * header documents: the review bar here is the server write path's own
 * guarantees, not UI polish.
 */
import { useState } from "react";
import { Alert, AlertText, Button, Heading, Input, Text, TextField } from "@launchpad-ui/components";
import { useLinks } from "../hooks/use-links.js";
import { PollStatusView } from "../components/PollStatusView.js";
import { linksApi, type LinksApi } from "../api/links.js";

export interface LinksRouteProps {
  api?: LinksApi;
}

export function LinksRoute({ api = linksApi }: LinksRouteProps) {
  const state = useLinks();
  const [resource, setResource] = useState("");
  const [target, setTarget] = useState("");
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [rowBusy, setRowBusy] = useState<Record<string, boolean>>({});

  async function submitAdd() {
    setFormError("");
    setBusy(true);
    try {
      const result = await api.add(resource, target);
      if (result.ok) {
        setResource("");
        setTarget("");
      }
    } catch (e) {
      setFormError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function submitRemove(owner: string, targetKey: string) {
    const key = `${owner}|${targetKey}`;
    setRowBusy((b) => ({ ...b, [key]: true }));
    setRowError((e) => ({ ...e, [key]: "" }));
    try {
      await api.remove(owner, targetKey);
    } catch (e) {
      setRowError((er) => ({ ...er, [key]: (e as Error).message }));
    } finally {
      setRowBusy((b) => ({ ...b, [key]: false }));
    }
  }

  return (
    <section aria-labelledby="links-heading">
      <Heading id="links-heading" size="small">
        Links
      </Heading>
      <Text elementType="p" size="small">
        Butchr-managed links between resources (the same collection `butchr link` edits). A jira-project-owned resource
        is not editable from this page in v1 — use the CLI for those.
      </Text>
      <div>
        <TextField aria-label="resource" value={resource} onChange={setResource}>
          <Input data-testid="links-add-resource" placeholder="jira-work-item:BUTCHR-123" />
        </TextField>
        <TextField aria-label="target" value={target} onChange={setTarget}>
          <Input data-testid="links-add-target" placeholder="github-issue:owner/repo#42" />
        </TextField>
        <Button size="small" onPress={() => void submitAdd()} isDisabled={busy || !resource || !target}>
          Add link
        </Button>
        {formError ? (
          <Alert status="error">
            <AlertText>{formError}</AlertText>
          </Alert>
        ) : null}
      </div>
      <PollStatusView state={state} label="/api/links">
        {(data) => (
          <table className="links-table">
            <thead>
              <tr>
                <th>Resource</th>
                <th>Target</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.links.flatMap((entry) =>
                entry.targets.map((t) => {
                  const key = `${entry.owner}|${t}`;
                  return (
                    <tr key={key} data-testid={`link-row-${key}`}>
                      <td>{entry.owner}</td>
                      <td>{t}</td>
                      <td>
                        <Button size="small" onPress={() => void submitRemove(entry.owner, t)} isDisabled={rowBusy[key] === true}>
                          Remove
                        </Button>
                        {rowError[key] ? (
                          <Alert status="error">
                            <AlertText>{rowError[key]}</AlertText>
                          </Alert>
                        ) : null}
                      </td>
                    </tr>
                  );
                }),
              )}
            </tbody>
          </table>
        )}
      </PollStatusView>
    </section>
  );
}
