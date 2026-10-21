import { getTenantId } from '../db/tenant-context.js'

/**
 * Fixed-window counters for per-user rate limits: Redis first (cluster-wide), this
 * process alone when Redis is down or missing — the same shape as the form preview
 * comment limiter. Keys are tenant-qualified.
 */

type RedisLike = {
  eval(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown>
}

/**
 * INCRBY and the window's expiry in ONE atomic step. Any key without a TTL gets one (TTL < 0),
 * so a counter can never outlive its window — not when the process dies between two calls,
 * and not for a key an older version left without one. Works on every Redis version (EXPIRE
 * NX needs 7.0).
 */
const INCR_WITH_TTL = `local v = redis.call('INCRBY', KEYS[1], ARGV[1])
if redis.call('TTL', KEYS[1]) < 0 then redis.call('EXPIRE', KEYS[1], ARGV[2]) end
return v`

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
    after = Number(await redis.eval(INCR_WITH_TTL, 1, k, n, windowS))
    if (!Number.isFinite(after)) throw new Error('bad counter')
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
