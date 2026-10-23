import { singleFlight } from './single-flight.js'

/**
 * A tiny in-process answer cache for hot, cheap-to-be-stale reads (a second or two), with
 * single-flight in front of it: concurrent misses for one key share ONE load.
 *
 * Built for GET /api/presence/online, which every open browser re-read on each presence
 * event (staging 2026-10-23: ~40 req/s from 44 people, ~250 ms each, pegged the event loop).
 *
 * Rules, the same as single-flight.ts:
 *   - The key must already encode everything that makes two answers differ (tenant, viewer).
 *     Authorisation stays with the caller; only the computed answer is shared.
 *   - A failed load is never remembered: it reaches the callers already waiting on it and
 *     nobody after.
 *   - An entry's age counts from when its load STARTED (the data it read), so an answer is
 *     never older than ttlMs plus one load.
 *   - Bounded: past `max` entries the expired ones go, then the oldest.
 *
 * Module state is per process; callers in cloud mode put the tenant in the key.
 */

export interface ShortCache<T> {
  /** The cached answer for `key`, or one shared run of `load`. */
  get(key: string, load: () => Promise<T>): Promise<T>
  /** Drop one key, or everything. */
  forget(key?: string): void
  size(): number
}

export function createShortCache<T>(
  name: string,
  ttlMs: number,
  opts: { max?: number; now?: () => number } = {}
): ShortCache<T> {
  const max = Math.max(1, opts.max ?? 1000)
  const now = opts.now ?? Date.now
  const values = new Map<string, { value: T; at: number }>()

  const prune = () => {
    if (values.size <= max) return
    const t = now()
    for (const [k, v] of values) if (t - v.at >= ttlMs) values.delete(k)
    while (values.size > max) values.delete(values.keys().next().value as string)
  }

  return {
    get(key, load) {
      const hit = values.get(key)
      if (hit && now() - hit.at < ttlMs) return Promise.resolve(hit.value)
      return singleFlight(`short:${name}:${key}`, async () => {
        const at = now()
        const value = await load()
        values.delete(key)
        values.set(key, { value, at })
        prune()
        return value
      }).promise
    },
    forget(key) {
      if (key == null) values.clear()
      else values.delete(key)
    },
    size: () => values.size
  }
}
