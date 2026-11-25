import { randomUUID } from 'node:crypto'
import { appPromoteRedis, type PromoteRedis } from '../promote-lock.js'
import { DataError } from './types.js'

/**
 * One data run per environment at a time: nvr:hub:data:<envId> (SET NX PX 5 min, renewed every
 * 60 s by its runner, compare-and-delete on release) — the promote lock's pattern. A refresh
 * also takes the environment's promote lock (holder `data`), so it never runs beside a
 * promotion, a move or a stack action; backups and drills take only this one (a backup beside a
 * promotion is fine). Hub mode is refused in cloud mode, so the key carries no tenant.
 */
export const DATA_LOCK_TTL_MS = 5 * 60_000
export const DATA_LOCK_RENEW_MS = 60_000

export function hubDataLockKey(envId: number | string): string {
  return `nvr:hub:data:${envId}`
}

export interface DataLock {
  take(envId: number): Promise<string | null>
  renew(envId: number, token: string): Promise<boolean>
  release(envId: number, token: string): Promise<void>
}

const RENEW_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end"
const RELEASE_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end"

export function redisDataLock(redis: PromoteRedis): DataLock {
  return {
    async take(envId) {
      const token = randomUUID()
      let ok: unknown
      try {
        ok = await redis.set(hubDataLockKey(envId), token, 'PX', DATA_LOCK_TTL_MS, 'NX')
      } catch {
        throw new DataError(
          'LOCK_UNAVAILABLE',
          'The Hub cannot reach Redis to make sure only one data run works on this environment — try again shortly.',
          503
        )
      }
      return ok === 'OK' ? token : null
    },
    async renew(envId, token) {
      try {
        return (
          Number(
            await redis.eval(RENEW_SCRIPT, 1, hubDataLockKey(envId), token, DATA_LOCK_TTL_MS)
          ) === 1
        )
      } catch {
        return true
      }
    },
    async release(envId, token) {
      await Promise.resolve(redis.eval(RELEASE_SCRIPT, 1, hubDataLockKey(envId), token)).catch(
        () => undefined
      )
    }
  }
}

/** No Redis (a single-process dev Hub, tests): the same lock in this process only. */
const memLocks = new Map<string, { token: string; until: number }>()
export const memoryDataLock: DataLock = {
  async take(envId) {
    const key = hubDataLockKey(envId)
    const held = memLocks.get(key)
    if (held && held.until > Date.now()) return null
    const token = randomUUID()
    memLocks.set(key, { token, until: Date.now() + DATA_LOCK_TTL_MS })
    return token
  },
  async renew(envId, token) {
    const held = memLocks.get(hubDataLockKey(envId))
    if (held?.token !== token) return false
    held.until = Date.now() + DATA_LOCK_TTL_MS
    return true
  },
  async release(envId, token) {
    const key = hubDataLockKey(envId)
    if (memLocks.get(key)?.token === token) memLocks.delete(key)
  }
}

export function defaultDataLock(): DataLock {
  const redis = appPromoteRedis()
  return redis ? redisDataLock(redis) : memoryDataLock
}

/** Test seam: forget every in-process lock. */
export function _resetDataLocksForTests(): void {
  memLocks.clear()
}
