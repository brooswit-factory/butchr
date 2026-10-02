/** Same-origin JSON GET, used by both endpoint hooks — a non-2xx response is a failure (never silently parsed as if it were the real body). */
export async function fetchJson<T>(url: string, signal: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return (await res.json()) as T;
}
