import { randomUUID } from 'node:crypto'
import { getApp } from '../io-holder.js'
import type { PromotionBlocker } from './promote-types.js'

/**
 * One promotion per environment (phase 2): the lock nvr:hub:promote:<envId> (SET NX PX 5 min,
 * renewed every 60 s by its runner, compare-and-delete on release) and the cancel flag
 * nvr:hub:promote-cancel:<deployId>. A `running` deploy row belongs to whoever holds its
 * environment's lock: a row whose lock key is gone is stale (its process died). Hub mode is
 * refused in cloud mode, so the keys carry no tenant (as the phase-1 nvr:hub:* keys).
 */

/** A refusal with its HTTP status; a 409 from the planner carries every blocker. */
export class PromotionError extends Error {
  code: string
  status: number
  blockers?: PromotionBlocker[]
  constructor(code: string, message: string, status = 400, blockers?: PromotionBlocker[]) {
    super(message)
    this.name = 'PromotionError'
    this.code = code
    this.status = status
    if (blockers) this.blockers = blockers
  }
}

/** Short, so a crashed process blocks its environment for minutes; a live runner renews it. */
export const LOCK_TTL_MS = 5 * 60_000
/** A cancel must outlive the longest step (a 60 min deploy) to land at its boundary. */
export const CANCEL_TTL_MS = 2 * 60 * 60_000
export const LOCK_RENEW_MS = 60_000

export function hubPromoteLockKey(envId: number | string): string {
  return `nvr:hub:promote:${envId}`
}

export function hubPromoteCancelKey(deployId: number | string): string {
  return `nvr:hub:promote-cancel:${deployId}`
}

/** The slice of ioredis the lock needs. */
export interface PromoteRedis {
  set(key: string, value: string, ...args: Array<string | number>): Promise<unknown>
  get(key: string): Promise<string | null>
  del(...keys: string[]): Promise<unknown>
  exists(key: string): Promise<number>
  eval(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown>
}

export interface PromoteLock {
  /** A token when this caller now holds the environment's lock; null when someone else does. */
  take(envId: number): Promise<string | null>
  /** Extends the lock while `token` still holds it; false when it no longer does. */
  renew(envId: number, token: string): Promise<boolean>
  /** Deletes the lock only while `token` still holds it. */
  release(envId: number, token: string): Promise<void>
  /** Someone holds the environment's lock; 'unknown' when it cannot be read (never stolen then). */
  held(envId: number): Promise<boolean | 'unknown'>
  requestCancel(deployId: number): Promise<void>
  cancelRequested(deployId: number): Promise<boolean>
  clearCancel(deployId: number): Promise<void>
}

// Redis EVAL of two fixed Lua scripts (compare-and-pexpire, compare-and-delete), never input.
const RENEW_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end"
const RELEASE_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end"

/**
 * The lock on Redis. A Redis that fails while taking it refuses the start (503 LOCK_UNAVAILABLE):
 * a promotion never runs without knowing it is the only one.
 */
export function redisPromoteLock(redis: PromoteRedis): PromoteLock {
  return {
    async take(envId) {
      const token = randomUUID()
      let ok: unknown
      try {
        ok = await redis.set(hubPromoteLockKey(envId), token, 'PX', LOCK_TTL_MS, 'NX')
      } catch {
        throw new PromotionError(
          'LOCK_UNAVAILABLE',
          'The Hub cannot reach Redis to make sure only one promotion runs — try again shortly',
          503
        )
      }
      return ok === 'OK' ? token : null
    },
    async renew(envId, token) {
      try {
        return (
          Number(
            await redis.eval(RENEW_SCRIPT, 1, hubPromoteLockKey(envId), token, LOCK_TTL_MS)
          ) === 1
        )
      } catch {
        return true // a Redis blink is not a lost lock; the next renewal tries again
      }
    },
    async release(envId, token) {
      await Promise.resolve(redis.eval(RELEASE_SCRIPT, 1, hubPromoteLockKey(envId), token)).catch(
        () => undefined
      )
    },
    async held(envId) {
      try {
        return (await redis.exists(hubPromoteLockKey(envId))) > 0
      } catch {
        return 'unknown'
      }
    },
    async requestCancel(deployId) {
      await Promise.resolve(
        redis.set(hubPromoteCancelKey(deployId), '1', 'PX', CANCEL_TTL_MS)
      ).catch(() => undefined)
    },
    async cancelRequested(deployId) {
      try {
        return (await redis.get(hubPromoteCancelKey(deployId))) != null
      } catch {
        return false
      }
    },
    async clearCancel(deployId) {
      await Promise.resolve(redis.del(hubPromoteCancelKey(deployId))).catch(() => undefined)
    }
  }
}

/** No Redis (a single-process dev Hub): the same lock in this process only. */
const memLocks = new Map<string, { token: string; until: number }>()
const memCancels = new Set<number>()
export const memoryPromoteLock: PromoteLock = {
  async take(envId) {
    const key = hubPromoteLockKey(envId)
    const held = memLocks.get(key)
    if (held && held.until > Date.now()) return null
    const token = randomUUID()
    memLocks.set(key, { token, until: Date.now() + LOCK_TTL_MS })
    return token
  },
  async renew(envId, token) {
    const held = memLocks.get(hubPromoteLockKey(envId))
    if (held?.token !== token) return false
    held.until = Date.now() + LOCK_TTL_MS
    return true
  },
  async release(envId, token) {
    const key = hubPromoteLockKey(envId)
    if (memLocks.get(key)?.token === token) memLocks.delete(key)
  },
  async held(envId) {
    const held = memLocks.get(hubPromoteLockKey(envId))
    return !!held && held.until > Date.now()
  },
  async requestCancel(deployId) {
    memCancels.add(deployId)
  },
  async cancelRequested(deployId) {
    return memCancels.has(deployId)
  },
  async clearCancel(deployId) {
    memCancels.delete(deployId)
  }
}

export function appPromoteRedis(): PromoteRedis | null {
  return (getApp()?.redis as PromoteRedis | undefined) ?? null
}

export function defaultPromoteLock(): PromoteLock {
  const redis = appPromoteRedis()
  return redis ? redisPromoteLock(redis) : memoryPromoteLock
}
