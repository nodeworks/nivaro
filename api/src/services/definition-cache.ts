/**
 * Small in-process cache for DEFINITION rows — a widget, a custom query — that
 * every render re-read by id before it could do anything (#494). A record page
 * mounts eight widget slots; each render cost one nivaro_widgets read and, for
 * a query widget, one nivaro_custom_queries read on top, at ~37ms a trip.
 *
 * The cache holds the PROMISE, so concurrent misses share one query
 * (the encryption.ts lesson), and a rejected load is dropped at once so the
 * next caller retries. The central write hook in routes/index.ts busts it
 * after any successful non-GET to the routes that edit these rows, so a
 * saved definition is live on the next request rather than after the TTL.
 */

const TTL_MS = 60_000

interface Entry<T> {
  value: Promise<T>
  at: number
}

const store = new Map<string, Entry<unknown>>()

export async function cachedDefinition<T>(
  key: string,
  load: () => Promise<T>,
  ttlMs = TTL_MS
): Promise<T> {
  const hit = store.get(key) as Entry<T> | undefined
  if (hit && Date.now() - hit.at < ttlMs) return hit.value
  const value = load()
  store.set(key, { value, at: Date.now() })
  value.catch(() => {
    if (store.get(key)?.value === value) store.delete(key)
  })
  return value
}

/** Drop every entry, or those under a prefix (`widget:`, `custom-query:`). */
export function bustDefinitionCache(prefix?: string): void {
  if (!prefix) {
    store.clear()
    return
  }
  for (const k of store.keys()) if (k.startsWith(prefix)) store.delete(k)
}

export function definitionCacheSize(): number {
  return store.size
}
