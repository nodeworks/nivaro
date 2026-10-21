import { getTenantId } from '../db/tenant-context.js'

/**
 * Fixed-window counters for per-user rate limits: Redis first (cluster-wide), this
 * process alone when Redis is down or missing — the same shape as the form preview
 * comment limiter. Keys are tenant-qualified.
 */

type RedisLike = {
  incrby(key: string, n: number): Promise<number>
  expire(key: string, seconds: number): Promise<unknown>
}

const memory = new Map<string, { n: number; until: number }>()

/**
 * Take up to `n` units from the window `key` (at most `max` per `windowS` seconds) and
 * answer how many were granted (0..n). A batch that straddles the cap is granted the rest.
 */
export async function takeWindowed(
  redis: RedisLike | null | undefined,
  key: string,
  n: number,
  max: number,
  windowS: number
): Promise<number> {
  if (n <= 0) return 0
  const k = `nvr:rl:${getTenantId() ?? ''}:${key}`
  let after: number
  try {
    if (!redis) throw new Error('no redis')
    after = Number(await redis.incrby(k, n))
    if (after === n) await redis.expire(k, windowS)
  } catch {
    const now = Date.now()
    const hit = memory.get(k)
    if (!hit || hit.until < now) {
      if (memory.size > 5000) memory.clear()
      memory.set(k, { n, until: now + windowS * 1000 })
      after = n
    } else {
      hit.n += n
      after = hit.n
    }
  }
  const before = after - n
  return Math.max(0, Math.min(n, max - before))
}

/** One unit; true when the caller is over the limit. */
export async function overWindowLimit(
  redis: RedisLike | null | undefined,
  key: string,
  max: number,
  windowS: number
): Promise<boolean> {
  return (await takeWindowed(redis, key, 1, max, windowS)) === 0
}

/** Tests only. */
export function resetWindowedMemory(): void {
  memory.clear()
}
