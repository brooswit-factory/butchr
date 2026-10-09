/**
 * FACTORY-962 (epic FACTORY-659, slice D1 follow-up) — the links write
 * calls: `POST /api/links/add`, `/remove`, and `POST /api/links/undo/:backupId`.
 * Listing itself needs no client of its own — `useLinks()` (`../hooks/
 * use-links.js`) already polls `GET /api/links`.
 *
 * Same CSRF discipline as `./session-definitions.ts`/`./rules.ts`:
 * `GET /api/session` mints this process's one token, echoed back on the
 * `x-butchr-csrf` header for every write — never a second, hand-rolled
 * fetch of that route.
 */
export type LinksWriteResult =
  | { ok: true; added: true; backupId: string | null; etag: string }
  | { ok: true; added: false; reason: "already-present" }
  | { ok: true; removed: true; backupId: string | null; etag: string }
  | { ok: true; removed: false; reason: "not-present" }
  | { ok: true; undone: true; backupId: string | null; etag: string };

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

export interface LinksApi {
  add: (resource: string, target: string, signal?: AbortSignal) => Promise<LinksWriteResult>;
  remove: (resource: string, target: string, signal?: AbortSignal) => Promise<LinksWriteResult>;
  undo: (backupId: string, signal?: AbortSignal) => Promise<LinksWriteResult>;
}

export const linksApi: LinksApi = {
  add: (resource, target, signal) => post("/api/links/add", { resource, target }, signal),
  remove: (resource, target, signal) => post("/api/links/remove", { resource, target }, signal),
  undo: (backupId, signal) => post(`/api/links/undo/${encodeURIComponent(backupId)}`, {}, signal),
};
