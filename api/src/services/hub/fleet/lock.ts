import { randomUUID } from 'node:crypto'

/**
 * Single-flight for the fleet jobs (Hub only — Hub mode is refused on every multi-tenant
 * deployment, so the keys carry no tenant, like the other nvr:hub:* keys):
 *
 *  - nvr:hub:fleet-probe   held by one probe tick at a time (the minute cron or Check now)
 *  - nvr:hub:fleet-alerts  held by one alert pass at a time (the 15-minute cron or Check now)
 *  - nvr:hub:fleet-check   the last Check now: {status: running|done|failed, started_at, …}
 *
 * SET NX PX with a token, released by compare-and-delete. Without Redis (a single process) the
 * work simply runs.
 */

export interface LockRedis {
  set(key: string, value: string, ...args: Array<string | number>): Promise<unknown>
  get(key: string): Promise<string | null>
  eval(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown>
}

export const PROBE_LOCK_KEY = 'nvr:hub:fleet-probe'
export const ALERTS_LOCK_KEY = 'nvr:hub:fleet-alerts'
export const CHECK_STATE_KEY = 'nvr:hub:fleet-check'

/** Longer than the longest run (45 s budget + 8 s tail); a crashed holder frees it by expiry. */
export const LOCK_TTL_MS = 120_000
export const CHECK_STATE_TTL_S = 15 * 60

// A fixed Lua script run by Redis (EVAL), never built from input: delete only our own token.
const RELEASE =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end return 0"

export type Locked<T> = { ran: true; value: T } | { ran: false }

/** Runs `work` while holding `key`; `{ran: false}` when someone else holds it. */
export async function withLock<T>(
  redis: LockRedis | null | undefined,
  key: string,
  work: () => Promise<T>
): Promise<Locked<T>> {
  if (!redis) return { ran: true, value: await work() }
  const token = randomUUID()
  let got: unknown
  try {
    got = await redis.set(key, token, 'PX', LOCK_TTL_MS, 'NX')
  } catch {
    // Redis down: run (one process is the worst case: a duplicate sample, never a lost one).
    return { ran: true, value: await work() }
  }
  if (got !== 'OK') return { ran: false }
  try {
    return { ran: true, value: await work() }
  } finally {
    await Promise.resolve(redis.eval(RELEASE, 1, key, token)).catch(() => {})
  }
}

export interface CheckState {
  status: 'running' | 'done' | 'failed'
  started_at: string
  finished_at?: string
  by?: string
  result?: unknown
}

export async function readCheckState(
  redis: LockRedis | null | undefined
): Promise<CheckState | null> {
  if (!redis) return null
  try {
    const raw = await redis.get(CHECK_STATE_KEY)
    return raw ? (JSON.parse(raw) as CheckState) : null
  } catch {
    return null
  }
}

export async function writeCheckState(
  redis: LockRedis | null | undefined,
  state: CheckState
): Promise<void> {
  if (!redis) return
  await Promise.resolve(
    redis.set(CHECK_STATE_KEY, JSON.stringify(state), 'EX', CHECK_STATE_TTL_S)
  ).catch(() => {})
}
