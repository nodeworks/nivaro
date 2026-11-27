import { randomUUID } from 'node:crypto'
import { appPromoteRedis, type PromoteRedis } from '../../promote-lock.js'
import { ResourceChangeError } from './contract.js'

/**
 * Hub provider changes: one writer per managed resource and one runner per change.
 *
 *   nvr:hub-res:<resourceId>        held by the change applying to that resource
 *   nvr:hub-res:change:<changeId>   held by the process running that change (heal reads it: a
 *                                   change whose lock is still held is never marked interrupted)
 *
 * Same shape as the Hub's other locks (promote-lock.ts): SET NX PX, renewed by the runner's
 * heartbeat with a compare-and-pexpire, released with a compare-and-delete — the two fixed Lua
 * scripts, never input. A Redis error while taking refuses (503 LOCK_UNAVAILABLE); a renewal that
 * errors counts as LOST (the runner stops before its next provider call). A Hub is never a shared
 * deployment (HUB=on refuses it), so the keys carry no tenant. Without Redis (a single-process dev
 * Hub) the same locks live in this process.
 */

/** Short, so a crashed process frees its resources within minutes; a live runner renews it. */
export const RESOURCE_LOCK_TTL_MS = 2 * 60_000

export function hubResourceLockKey(resourceId: number | string): string {
  return `nvr:hub-res:${resourceId}`
}

export function hubResourceChangeLockKey(changeId: number | string): string {
  return `nvr:hub-res:change:${changeId}`
}

export interface ResourceLock {
  /** A token when this caller now holds `key`; null when someone else does. */
  take(key: string): Promise<string | null>
  /** Extends the lock while `token` holds it; false when lost (a Redis error included). */
  renew(key: string, token: string): Promise<boolean>
  /** Deletes the lock only while `token` still holds it. */
  release(key: string, token: string): Promise<void>
  /** Someone holds `key`; 'unknown' when it cannot be read (never treated as free). */
  held(key: string): Promise<boolean | 'unknown'>
}

const RENEW_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end"
const RELEASE_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end"

export function redisResourceLock(redis: PromoteRedis, ttlMs = RESOURCE_LOCK_TTL_MS): ResourceLock {
  return {
    async take(key) {
      const token = `hub-res:${randomUUID()}`
      let ok: unknown
      try {
        ok = await redis.set(key, token, 'PX', ttlMs, 'NX')
      } catch {
        throw new ResourceChangeError(
          'LOCK_UNAVAILABLE',
          'The Hub cannot reach Redis to make sure only one change runs on these resources — try again shortly.'
        )
      }
      return ok === 'OK' ? token : null
    },
    async renew(key, token) {
      try {
        return Number(await redis.eval(RENEW_SCRIPT, 1, key, token, ttlMs)) === 1
      } catch {
        return false
      }
    },
    async release(key, token) {
      await Promise.resolve(redis.eval(RELEASE_SCRIPT, 1, key, token)).catch(() => undefined)
    },
    async held(key) {
      try {
        return (await redis.exists(key)) > 0
      } catch {
        return 'unknown'
      }
    }
  }
}

// No Redis (a single-process dev Hub): key → holder token + expiry, in this process only.
const memResourceLocks = new Map<string, { token: string; until: number }>()

export function memoryResourceLock(
  now: () => number = Date.now,
  ttlMs = RESOURCE_LOCK_TTL_MS
): ResourceLock {
  return {
    async take(key) {
      const held = memResourceLocks.get(key)
      if (held && held.until > now()) return null
      const token = `hub-res:${randomUUID()}`
      memResourceLocks.set(key, { token, until: now() + ttlMs })
      return token
    },
    async renew(key, token) {
      const held = memResourceLocks.get(key)
      if (held?.token !== token || held.until <= now()) return false
      held.until = now() + ttlMs
      return true
    },
    async release(key, token) {
      if (memResourceLocks.get(key)?.token === token) memResourceLocks.delete(key)
    },
    async held(key) {
      const held = memResourceLocks.get(key)
      return !!held && held.until > now()
    }
  }
}

/** Tests: forget every in-process lock. */
export function resetMemoryResourceLocksForTest(): void {
  memResourceLocks.clear()
}

export function defaultResourceLock(): ResourceLock {
  const redis = appPromoteRedis()
  return redis ? redisResourceLock(redis) : memoryResourceLock()
}

/** Locks held for one run (the change lock + one per resource). */
export interface ResourceHold {
  keys: string[]
  /** Renews every key now; false (and lost from then on) when any is no longer held. */
  renew(): Promise<boolean>
  lost(): boolean
  release(): Promise<void>
}

/**
 * Takes every key (sorted, so two runs never take them crosswise). Throws RESOURCE_BUSY (nothing
 * kept) when one is held by someone else.
 */
export async function holdResourceLocks(lock: ResourceLock, keys: string[]): Promise<ResourceHold> {
  const unique = [...new Set(keys)].sort()
  const held: Array<{ key: string; token: string }> = []
  try {
    for (const key of unique) {
      const token = await lock.take(key)
      if (!token)
        throw new ResourceChangeError(
          'RESOURCE_BUSY',
          key.startsWith('nvr:hub-res:change:')
            ? 'This change is already running.'
            : 'Another change is running on one of these resources — wait for it to end.',
          { lock: key.replace(/^nvr:hub-res:/, '') }
        )
      held.push({ key, token })
    }
  } catch (err) {
    for (const h of held) await lock.release(h.key, h.token)
    throw err
  }
  let lost = false
  return {
    keys: unique,
    async renew() {
      if (lost) return false
      for (const h of held) {
        if (!(await lock.renew(h.key, h.token).catch(() => false))) {
          lost = true
          return false
        }
      }
      return true
    },
    lost: () => lost,
    async release() {
      for (const h of held) await lock.release(h.key, h.token).catch(() => undefined)
    }
  }
}
