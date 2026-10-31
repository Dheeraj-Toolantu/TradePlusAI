/**
 * Client-side GET de-duplication for panels on the same page that poll the same endpoint (the
 * algo page and its options-strategy panel both read the full option chain every minute).
 * Identical requests in flight share one fetch, and a body younger than `maxAgeMs` is reused.
 * A failed request is never cached.
 */
type Entry = { at: number; body?: unknown; pending?: Promise<unknown> };
const entries = new Map<string, Entry>();
const MAX_ENTRIES = 50;

export function fetchJsonShared<T = unknown>(url: string, maxAgeMs: number, fetcher: typeof fetch = fetch, now = Date.now): Promise<T> {
  const entry = entries.get(url);
  if (entry?.pending) return entry.pending as Promise<T>;
  if (entry && "body" in entry && now() - entry.at < maxAgeMs) return Promise.resolve(entry.body as T);
  const pending = fetcher(url, { cache: "no-store" })
    .then(async (response) => {
      const body = await response.json();
      if (response.ok) entries.set(url, { at: now(), body });
      else entries.delete(url);
      return body as T;
    })
    .catch((error: unknown) => { entries.delete(url); throw error; });
  entries.set(url, { at: now(), pending });
  if (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value!);
  return pending;
}

/** Test hook. */
export const clearSharedFetch = () => entries.clear();
