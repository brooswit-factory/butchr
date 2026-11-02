/**
 * FACTORY-667 (epic FACTORY-659, slice D1) — session definitions: read
 * (secrets already redacted by `GET /config-inventory`, `useConfigInventory`)
 * plus the allowlisted edits this ticket ships: `modelPower`/`effort`
 * (plain write), `permissionMode`/`lizardMode` (server-confirm-gated — the
 * preview returned on an unconfirmed risky patch is shown verbatim before
 * a second, explicit "Confirm" click resends with `confirm: true`), and
 * freeze/unfreeze. A SEPARATE route from `ConfigurationsRoute` (still a
 * placeholder for a later ticket) rather than extending it, so this slice
 * never collides with that one's own build-out.
 *
 * Deliberately plain (no dialog components, no fixtures-based API
 * override): the review bar this ticket is held to is about the SERVER
 * write path's own guarantees (`../../../src/resources/session-
 * definitions-write.ts` and its tests), not UI polish — this page exists
 * so an operator has SOME way to reach those routes without hand-editing
 * JSON, and is a reasonable target for a follow-up visual pass.
 */
import { useState } from "react";
import { Alert, AlertText, Button, Heading, Text } from "@launchpad-ui/components";
import { useConfigInventory } from "../hooks/use-config-inventory.js";
import { PollStatusView } from "../components/PollStatusView.js";
import { sessionDefinitionsApi, type SessionDefinitionWriteResult, type SessionDefinitionsApi } from "../api/session-definitions.js";
import type { SessionDefinitionInventoryEntry } from "../../../src/agents/query-agent-inventory.js";

export interface SessionDefinitionsRouteProps {
  api?: SessionDefinitionsApi;
}

interface RowDraft {
  modelPower: string;
  effort: string;
  permissionMode: string;
  lizardMode: boolean;
}

function draftFrom(entry: SessionDefinitionInventoryEntry): RowDraft {
  return {
    modelPower: entry.modelPower !== undefined ? String(entry.modelPower) : "",
    effort: entry.effort !== undefined ? String(entry.effort) : "",
    permissionMode: entry.permissionMode ?? "",
    lizardMode: entry.lizardMode ?? false,
  };
}

export function SessionDefinitionsRoute({ api = sessionDefinitionsApi }: SessionDefinitionsRouteProps) {
  const state = useConfigInventory();
  const [drafts, setDrafts] = useState<Record<string, RowDraft>>({});
  const [pendingConfirm, setPendingConfirm] = useState<{ name: string; result: Extract<SessionDefinitionWriteResult, { requiresConfirm: true }> } | null>(null);
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});

  function draftFor(entry: SessionDefinitionInventoryEntry): RowDraft {
    return drafts[entry.name] ?? draftFrom(entry);
  }

  function setDraft(name: string, next: Partial<RowDraft>) {
    setDrafts((prev) => ({ ...prev, [name]: { ...(prev[name] ?? draftsFallback(name, state)), ...next } }));
  }

  function draftsFallback(name: string, s: typeof state): RowDraft {
    const entry = (s.kind === "loaded" || s.kind === "stale") ? s.data.sessionDefinitions.find((e) => e.name === name) : undefined;
    return entry ? draftFrom(entry) : { modelPower: "", effort: "", permissionMode: "", lizardMode: false };
  }

  async function submitFields(entry: SessionDefinitionInventoryEntry, confirm: boolean) {
    if (entry.etag === undefined) return;
    const d = draftFor(entry);
    const patch: Record<string, unknown> = {};
    if (d.modelPower !== (entry.modelPower !== undefined ? String(entry.modelPower) : "")) patch.modelPower = Number(d.modelPower);
    if (d.effort !== (entry.effort !== undefined ? String(entry.effort) : "")) patch.effort = Number(d.effort);
    if (d.permissionMode !== (entry.permissionMode ?? "")) patch.permissionMode = d.permissionMode;
    if (d.lizardMode !== (entry.lizardMode ?? false)) patch.lizardMode = d.lizardMode;
    if (Object.keys(patch).length === 0) return;
    setBusy((b) => ({ ...b, [entry.name]: true }));
    setRowError((e) => ({ ...e, [entry.name]: "" }));
    try {
      const result = await api.patchFields(entry.name, patch, entry.etag, confirm);
      if (result.ok && result.requiresConfirm) {
        setPendingConfirm({ name: entry.name, result });
      } else {
        setPendingConfirm(null);
        setDrafts((prev) => { const next = { ...prev }; delete next[entry.name]; return next; });
      }
    } catch (e) {
      setRowError((er) => ({ ...er, [entry.name]: (e as Error).message }));
    } finally {
      setBusy((b) => ({ ...b, [entry.name]: false }));
    }
  }

  async function toggleFrozen(entry: SessionDefinitionInventoryEntry) {
    if (entry.etag === undefined) return;
    setBusy((b) => ({ ...b, [entry.name]: true }));
    setRowError((e) => ({ ...e, [entry.name]: "" }));
    try {
      await api.setFrozen(entry.name, !entry.manifestFrozen, entry.etag);
    } catch (e) {
      setRowError((er) => ({ ...er, [entry.name]: (e as Error).message }));
    } finally {
      setBusy((b) => ({ ...b, [entry.name]: false }));
    }
  }

  return (
    <section aria-labelledby="session-definitions-heading">
      <Heading id="session-definitions-heading" size="small">
        Session definitions
      </Heading>
      <Text elementType="p" size="small">
        Managed-session definitions (~/.config/butchr/session-definitions). Secrets are never shown here and never editable.
      </Text>
      <PollStatusView state={state} label="/config-inventory">
        {(data) => (
          <table className="session-definitions-table">
            <thead>
              <tr>
                <th>Name</th><th>Vendor</th><th>Model power</th><th>Effort</th><th>Permission mode</th><th>Lizard mode</th><th>Frozen</th><th />
              </tr>
            </thead>
            <tbody>
              {data.sessionDefinitions.filter((e) => e.valid).map((entry) => {
                const d = draftFor(entry);
                return (
                  <tr key={entry.name} data-testid={`session-def-row-${entry.name}`}>
                    <td>{entry.name}</td>
                    <td>{entry.vendor}</td>
                    <td>
                      {entry.tier !== undefined
                        ? <span>tier-based ({entry.tier})</span>
                        : <input aria-label={`${entry.name} model power`} value={d.modelPower} onChange={(ev) => setDraft(entry.name, { modelPower: ev.target.value })} />}
                    </td>
                    <td>
                      {entry.tier !== undefined
                        ? null
                        : <input aria-label={`${entry.name} effort`} value={d.effort} onChange={(ev) => setDraft(entry.name, { effort: ev.target.value })} />}
                    </td>
                    <td>
                      <input aria-label={`${entry.name} permission mode`} value={d.permissionMode} onChange={(ev) => setDraft(entry.name, { permissionMode: ev.target.value })} />
                    </td>
                    <td>
                      <input type="checkbox" aria-label={`${entry.name} lizard mode`} checked={d.lizardMode} onChange={(ev) => setDraft(entry.name, { lizardMode: ev.target.checked })} />
                    </td>
                    <td>{entry.manifestFrozen ? "frozen" : "active"}</td>
                    <td>
                      <Button size="small" onPress={() => void submitFields(entry, false)} isDisabled={busy[entry.name] === true || entry.tier !== undefined}>
                        Save
                      </Button>
                      <Button size="small" onPress={() => void toggleFrozen(entry)} isDisabled={busy[entry.name] === true}>
                        {entry.manifestFrozen ? "Unfreeze" : "Freeze"}
                      </Button>
                      {rowError[entry.name] ? (
                        <Alert status="error">
                          <AlertText>{rowError[entry.name]}</AlertText>
                        </Alert>
                      ) : null}
                      {pendingConfirm?.name === entry.name ? (
                        <div data-testid={`session-def-confirm-${entry.name}`}>
                          {pendingConfirm.result.preview.map((p) => (
                            <Text elementType="p" size="small" key={p.field}>
                              {p.field}: {JSON.stringify(p.oldValue)} -&gt; {JSON.stringify(p.newValue)} — {p.consequence}
                            </Text>
                          ))}
                          <Button size="small" onPress={() => void submitFields(entry, true)}>
                            Confirm
                          </Button>
                          <Button size="small" onPress={() => setPendingConfirm(null)}>
                            Cancel
                          </Button>
                        </div>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </PollStatusView>
    </section>
  );
}
