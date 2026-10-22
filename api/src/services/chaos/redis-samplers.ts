import { metadataL2Stats } from '../../db/metadata-l2.js'
import { redisErrorsLastMinute } from './redis-hook.js'
import { registerSampler } from './steady-state.js'

/**
 * Steady-state figures for the Redis drills (#2832, on #2828's sampler registry):
 *   redis.errors_per_min    Redis errors this process saw in the last minute (client errors and
 *                           injected READONLY replies)
 *   cache.metadata_hit_pct  the shared metadata cache's hit rate since the previous sample
 *                           (null while it is off or nothing was looked up) — a key-loss or
 *                           eviction drill shows it dip and recover as the cache rebuilds
 */

let last: { hits: number; misses: number } | null = null

/** Hit rate (%) between two counter readings (pure); null when nothing was looked up. */
export function hitPctBetween(
  prev: { hits: number; misses: number } | null,
  now: { hits: number; misses: number }
): number | null {
  const hits = now.hits - (prev?.hits ?? 0)
  const lookups = hits + now.misses - (prev?.misses ?? 0)
  if (lookups <= 0) return null
  return Math.round((hits / lookups) * 1000) / 10
}

export function registerRedisSamplers(): void {
  registerSampler('redis.errors_per_min', 'Redis errors', 'per min', () => redisErrorsLastMinute())
  registerSampler('cache.metadata_hit_pct', 'Metadata cache hit rate', '%', () => {
    const s = metadataL2Stats()
    if (!s.enabled) return null
    const now = { hits: Number(s.hits) || 0, misses: Number(s.misses) || 0 }
    const pct = hitPctBetween(last, now)
    last = now
    return pct
  })
}
