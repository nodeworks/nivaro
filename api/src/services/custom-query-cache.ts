/**
 * The one definition of a custom query's Redis cache entry (#2445).
 *
 * Every reader and writer — POST /custom-queries/:slug/execute, widget renders,
 * Ask AI's query tool and the cache warmer — builds the key here, AFTER scope
 * injection, so a scoped result can never land under an unscoped key. Widget
 * renders pass only their bound params, so their keys differ from the route's
 * for the same question (see routes/widgets-internal.ts).
 *
 * Leaf module: imports nothing of the app.
 */

export function customQueryCacheKey(slug: string, params: Record<string, unknown>): string {
  return `cq:${slug}:${JSON.stringify(params)}`
}

/** The cached value: `{cached_at, rows}`, stamped so a viewer can be told its age. */
export function customQueryCacheValue(
  rows: unknown[],
  cachedAt: Date | string = new Date()
): string {
  return JSON.stringify({
    cached_at: typeof cachedAt === 'string' ? cachedAt : cachedAt.toISOString(),
    rows
  })
}

/** `cached_at` of a stored entry, in ms; null for a bare-array (legacy) or unreadable entry. */
export function customQueryCachedAt(raw: string | null): number | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as { cached_at?: unknown } | unknown[]
    if (Array.isArray(parsed) || typeof parsed?.cached_at !== 'string') return null
    const t = Date.parse(parsed.cached_at)
    return Number.isNaN(t) ? null : t
  } catch {
    return null
  }
}
