import { randomUUID } from 'node:crypto'
import { appPromoteRedis, type PromoteRedis } from '../promote-lock.js'
import { HubDbError } from './servers.js'

/**
 * One writer per Hub database row: nvr:hub:db:<id> (SET NX PX 5 min, renewed every 60 s by its
 * holder, compare-and-delete on release) — the same pattern as the promote lock. Provisioning and
 * delete take it, so a delete never runs while the row is being provisioned (and the reverse).
 * Hub mode is refused in cloud mode, so the key carries no tenant.
 */
export const DB_LOCK_TTL_MS = 5 * 60_000
export const DB_LOCK_RENEW_MS = 60_000

export function hubDbLockKey(id: number | string): string {
  return `nvr:hub:db:${id}`
}

export interface DbLock {
  /** A token when this caller now holds the row's lock; null when someone else does. */
  take(id: number): Promise<string | null>
  renew(id: number, token: string): Promise<boolean>
  release(id: number, token: string): Promise<void>
}

// Fixed Lua scripts (compare-and-pexpire, compare-and-delete), never input.
const RENEW_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end"
const RELEASE_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end"

/** A Redis that fails while taking the lock refuses the work (503): never run unsure. */
export function redisDbLock(redis: PromoteRedis): DbLock {
  return {
    async take(id) {
      const token = randomUUID()
      let ok: unknown
      try {
        ok = await redis.set(hubDbLockKey(id), token, 'PX', DB_LOCK_TTL_MS, 'NX')
      } catch {
        throw new HubDbError(
          'LOCK_UNAVAILABLE',
          'The Hub cannot reach Redis to make sure only one change runs on this database — try again shortly',
          503
        )
      }
      return ok === 'OK' ? token : null
    },
    async renew(id, token) {
      try {
        return (
          Number(await redis.eval(RENEW_SCRIPT, 1, hubDbLockKey(id), token, DB_LOCK_TTL_MS)) === 1
        )
      } catch {
        return true // a Redis blink is not a lost lock; the next renewal tries again
      }
    },
    async release(id, token) {
      await Promise.resolve(redis.eval(RELEASE_SCRIPT, 1, hubDbLockKey(id), token)).catch(
        () => undefined
      )
    }
  }
}

/** No Redis (a single-process dev Hub, tests): the same lock in this process only. */
const memLocks = new Map<string, { token: string; until: number }>()
export const memoryDbLock: DbLock = {
  async take(id) {
    const key = hubDbLockKey(id)
    const held = memLocks.get(key)
    if (held && held.until > Date.now()) return null
    const token = randomUUID()
    memLocks.set(key, { token, until: Date.now() + DB_LOCK_TTL_MS })
    return token
  },
  async renew(id, token) {
    const held = memLocks.get(hubDbLockKey(id))
    if (held?.token !== token) return false
    held.until = Date.now() + DB_LOCK_TTL_MS
    return true
  },
  async release(id, token) {
    const key = hubDbLockKey(id)
    if (memLocks.get(key)?.token === token) memLocks.delete(key)
  }
}

export function defaultDbLock(): DbLock {
  const redis = appPromoteRedis()
  return redis ? redisDbLock(redis) : memoryDbLock
}

/** Runs `fn` holding the row's lock (renewed while it runs); BUSY → PROVISION_RUNNING. */
export async function withDbLock<T>(id: number, fn: () => Promise<T>): Promise<T> {
  const lock = defaultDbLock()
  const token = await lock.take(id)
  if (!token)
    throw new HubDbError(
      'PROVISION_RUNNING',
      'This database is being created or dropped right now — try again when that finishes.'
    )
  const timer = setInterval(() => {
    void lock.renew(id, token).catch(() => undefined)
  }, DB_LOCK_RENEW_MS)
  timer.unref?.()
  try {
    return await fn()
  } finally {
    clearInterval(timer)
    await lock.release(id, token)
  }
}
