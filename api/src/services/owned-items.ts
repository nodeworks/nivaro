import { onOwnersChanged } from '../db/owner-signal.js'
import { currentTenantKey } from './tenant-rooms.js'

/**
 * Record ids whose CURRENT pipeline step a person owns, for one collection —
 * the My Work / queue "mine" answer (owner groups, manual owners, teams,
 * delegation), never a SQL guess at it. Owner groups are filter JSON matched
 * in JS, so the resolver scans every open instance and costs seconds: one
 * answer per person (all collections) is kept a minute, shared by concurrent
 * callers, and dropped whenever owners change (db/owner-signal.ts).
 * Exposed to extensions as `ctx.pipelines.ownedItemIds` (Forecasts' Mine only).
 */
const TTL_MS = 60_000
const cache = new Map<string, { at: number; value: Promise<Map<string, string[]>> }>()

onOwnersChanged(() => cache.clear())

export async function ownedItemIds(userId: string, collection: string): Promise<string[]> {
  const key = `${currentTenantKey()}:${userId}`
  const hit = cache.get(key)
  if (!hit || Date.now() - hit.at > TTL_MS) {
    const value = (async () => {
      const { BACKFILL_CEILING, resolveOwnedByMeSource } = await import('./queues.js')
      const res = await resolveOwnedByMeSource(userId, BACKFILL_CEILING)
      const by = new Map<string, string[]>()
      for (const i of res.items) {
        const list = by.get(i.collection) ?? []
        list.push(String(i.item_id))
        by.set(i.collection, list)
      }
      return by
    })()
    cache.set(key, { at: Date.now(), value })
    // A failed resolve is not remembered: the next caller tries again.
    value.catch(() => {
      if (cache.get(key)?.value === value) cache.delete(key)
    })
  }
  const by = await cache.get(key)!.value
  return by.get(collection) ?? []
}
