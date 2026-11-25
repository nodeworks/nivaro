import { randomUUID } from 'node:crypto'

/**
 * Single-flight and short caches for Hub insight (Hub only — Hub mode is refused on every
 * multi-tenant deployment, so the keys carry no tenant, like the other nvr:hub:* keys):
 *
 *  - nvr:hub:insight-collect   held by one usage + dependency collect at a time (the daily cron
 *                              or Collect now); 30 min, longer than the 20 min budget
 *  - nvr:hub:insight-check     the last Collect now: {status, started_at, finished_at, summary}
 *  - nvr:hub:insight-health:   the health answer per viewer (`admin` or the owner's id), 60 s
 *
 * SET NX PX with a token, released by compare-and-delete. Without Redis (a single process) the
 * work simply runs.
 */

export interface InsightRedis {
  set(key: string, value: string, ...args: Array<string | number>): Promise<unknown>
  get(key: string): Promise<string | null>
  eval(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown>
  del?(...keys: string[]): Promise<unknown>
}

export const COLLECT_LOCK_KEY = 'nvr:hub:insight-collect'
export const COLLECT_STATE_KEY = 'nvr:hub:insight-check'
export const HEALTH_CACHE_PREFIX = 'nvr:hub:insight-health:'
export const COLLECT_LOCK_TTL_MS = 30 * 60_000
export const HEALTH_CACHE_TTL_S = 60

// A fixed Lua script run by Redis (EVAL), never built from input: delete only our own token.
const RELEASE =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end return 0"

export type Locked<T> = { ran: true; value: T } | { ran: false }

export async function withInsightLock<T>(
  redis: InsightRedis | null | undefined,
  key: string,
  ttlMs: number,
  work: () => Promise<T>
): Promise<Locked<T>> {
  if (!redis) return { ran: true, value: await work() }
  const token = randomUUID()
  let got: unknown
  try {
    got = await redis.set(key, token, 'PX', ttlMs, 'NX')
  } catch {
    return { ran: true, value: await work() }
  }
  if (got !== 'OK') return { ran: false }
  try {
    return { ran: true, value: await work() }
  } finally {
    await Promise.resolve(redis.eval(RELEASE, 1, key, token)).catch(() => {})
  }
}

/** Whether the collect lock is held right now (Collect now answers 409 then). */
export async function collectRunning(redis: InsightRedis | null | undefined): Promise<boolean> {
  if (!redis) return false
  try {
    return (await redis.get(COLLECT_LOCK_KEY)) != null
  } catch {
    return false
  }
}

export interface CollectState {
  status: 'running' | 'done' | 'failed'
  started_at: string
  finished_at?: string
  summary?: Record<string, unknown>
}

export async function readCollectState(
  redis: InsightRedis | null | undefined
): Promise<CollectState | null> {
  if (!redis) return null
  try {
    const raw = await redis.get(COLLECT_STATE_KEY)
    return raw ? (JSON.parse(raw) as CollectState) : null
  } catch {
    return null
  }
}

export async function writeCollectState(
  redis: InsightRedis | null | undefined,
  s: CollectState
): Promise<void> {
  if (!redis) return
  await Promise.resolve(redis.set(COLLECT_STATE_KEY, JSON.stringify(s), 'EX', 6 * 3600)).catch(
    () => {}
  )
}

export const healthCacheKey = (who: { userId: string; isAdmin: boolean }) =>
  `${HEALTH_CACHE_PREFIX}${who.isAdmin ? 'admin' : who.userId.toLowerCase()}`
