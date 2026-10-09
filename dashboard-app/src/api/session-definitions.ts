/**
 * FACTORY-667 (epic FACTORY-659, slice D1) — the session-definitions write
 * calls: `POST /api/session-definitions/:name/fields`, `/frozen`, and
 * `POST /api/session-definitions/undo/:backupId`. Listing itself needs no
 * client of its own — `useConfigInventory()` (`../hooks/use-config-
 * inventory.js`) already polls `GET /config-inventory`, which now carries
 * each valid session definition's own `etag` (FACTORY-667) alongside its
 * fields; every write below takes that `etag` as `ifMatch`.
 *
 * Same CSRF discipline as `./rules.ts`: `GET /api/session` mints this
 * process's one token, echoed back on the `x-butchr-csrf` header for
 * every write — never a second, hand-rolled fetch of that route.
 */
export interface SessionDefinitionFieldPatch {
  modelPower?: number;
  effort?: number;
  permissionMode?: string;
  lizardMode?: boolean;
}

export type SessionDefinitionWriteResult =
  | { ok: true; requiresConfirm: false; backupId: string | null; etag: string }
  | { ok: true; requiresConfirm: true; confirmReason: string; preview: Array<{ field: string; oldValue: unknown; newValue: unknown; consequence: string }> };

const CSRF_HEADER = "x-butchr-csrf";

async function fetchCsrfToken(signal?: AbortSignal): Promise<string> {
  const res = await fetch("/api/session", signal ? { signal } : {});
  if (!res.ok) throw new Error(`/api/session: HTTP ${res.status}`);
  const body = (await res.json()) as { csrfToken: string };
  return body.csrfToken;
}

async function post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json", [CSRF_HEADER]: await fetchCsrfToken(signal) };
  const res = await fetch(path, { method: "POST", headers, body: JSON.stringify(body), ...(signal ? { signal } : {}) });
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    parsed = undefined;
  }
  if (!res.ok) {
    const message = parsed && typeof parsed === "object" && typeof (parsed as Record<string, unknown>).error === "string" ? (parsed as Record<string, unknown>).error : `${path}: HTTP ${res.status}`;
    throw new Error(message as string);
  }
  return parsed as T;
}

export interface SessionDefinitionsApi {
  patchFields: (name: string, patch: SessionDefinitionFieldPatch, ifMatch: string, confirm: boolean, signal?: AbortSignal) => Promise<SessionDefinitionWriteResult>;
  setFrozen: (name: string, frozen: boolean, ifMatch: string, signal?: AbortSignal) => Promise<SessionDefinitionWriteResult>;
  undo: (backupId: string, signal?: AbortSignal) => Promise<SessionDefinitionWriteResult>;
}

export const sessionDefinitionsApi: SessionDefinitionsApi = {
  patchFields: (name, patch, ifMatch, confirm, signal) =>
    post(`/api/session-definitions/${encodeURIComponent(name)}/fields`, { patch, ifMatch, confirm }, signal),
  setFrozen: (name, frozen, ifMatch, signal) =>
    post(`/api/session-definitions/${encodeURIComponent(name)}/frozen`, { frozen, ifMatch }, signal),
  undo: (backupId, signal) => post(`/api/session-definitions/undo/${encodeURIComponent(backupId)}`, {}, signal),
};
